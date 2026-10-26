// Runs in the page itself (MAIN world) from document_start, so it sees call
// audio as WhatsApp creates it: your mic from getUserMedia, the other person
// from RTCPeerConnection / <audio>.srcObject, and anything played through
// Web Audio. Two features build on that, both idle until the sidebar asks:
// - Recording: mixes both voices (no screen, no share prompt) and downloads an
//   .mp3 (vendor/lame.min.js, loaded into this world by the manifest).
// - AI call agent: while armed, WhatsApp's mic is swapped for a virtual one
//   that carries the agent's voice (your real mic stays muted until you take
//   over), and the other person's voice is streamed out as 24 kHz PCM.
// The sidebar (content.js) talks to it with CustomEvents whose detail is a
// JSON string; it relays the agent audio to Grok via the background script.
(() => {
  if (window.__waCallTap) return;
  window.__waCallTap = true;

  const CMD_EVENT = "wa-ext:call-rec-cmd";
  const STATE_EVENT = "wa-ext:call-rec-state";
  const AGENT_CMD_EVENT = "wa-ext:agent-cmd";
  const AGENT_EVENT = "wa-ext:agent-evt";
  // 24 kHz mono: clear voices, ~360 KB per minute as MP3
  const OUTPUT_SAMPLE_RATE = 24000;
  const MP3_KBPS = 48;
  // Grok realtime audio: 16-bit PCM, 24 kHz, sent in 100 ms chunks
  const AGENT_SAMPLE_RATE = 24000;
  const AGENT_CHUNK_SAMPLES = 2400;
  // Save on its own once every call track has been gone this long
  const CALL_END_GRACE_MS = 3000;
  // Agent gives up if nobody picks up within this time
  const AGENT_NO_ANSWER_MS = 90000;

  const micTracks = new Set();
  const remoteTracks = new Set();
  const playingNodes = new Set(); // WeakRef<AudioNode> wired to the speakers
  // Each bus mixes the call's live sources into one AudioContext: the recorder
  // listens to you + them, the agent's ears to them only.
  const buses = new Set();
  let rec = null;
  let agent = null;
  let lastStateJson = "";

  const origConnect = window.AudioNode?.prototype.connect;
  const origDisconnect = window.AudioNode?.prototype.disconnect;
  const origCreateStreamSource = window.AudioContext?.prototype.createMediaStreamSource;

  const isLive = (track) => !!track && track.readyState === "live";

  // Our own Web Audio inputs skip the mic swap below
  function sourceFrom(ctx, stream) {
    return origCreateStreamSource.call(ctx, stream);
  }

  // Tracks we create (virtual mic and its clones) are never treated as a mic
  const ownTracks = new WeakSet();

  // A real microphone has a groupId; call tracks and Web Audio outputs only
  // have a deviceId ("WebAudio-…" for the latter)
  function isLocalMic(track) {
    if (track?.kind !== "audio" || ownTracks.has(track)) return false;
    try {
      const s = track.getSettings?.() || {};
      return !!s.groupId && !String(s.deviceId || "").startsWith("WebAudio-");
    } catch (_) {
      return false;
    }
  }

  // WhatsApp may take the mic in another frame and only hand it to Web Audio
  // or WebRTC here, so each of those entry points swaps in the agent's voice
  // while armed. Elsewhere it just notes the mic for recording.
  const loggedMicPaths = new Set();
  function swapMicStream(stream, via) {
    const tracks = stream?.getAudioTracks?.() || [];
    if (!tracks.length || !tracks.every(isLocalMic)) return stream;
    if (!loggedMicPaths.has(via)) {
      loggedMicPaths.add(via);
      console.log(`[WA] call tap: mic reached ${via} (agent armed: ${!!agent})`);
    }
    if (!agent) {
      tracks.forEach((t) => addTrack(micTracks, "you", t));
      return stream;
    }
    const out = agentMicStream(stream, { ownsReal: false });
    out.getAudioTracks().forEach((t) => addTrack(micTracks, "you", t));
    return out;
  }

  function swapMicTrack(track, via) {
    if (!agent || !isLocalMic(track)) return track;
    return swapMicStream(new MediaStream([track]), via).getAudioTracks()[0] || track;
  }

  function addTrack(set, kind, track) {
    if (!track || track.kind !== "audio" || !isLive(track)) return;
    if (kind === "them" && micTracks.has(track)) return;
    set.forEach((t) => {
      if (!isLive(t)) set.delete(t);
    });
    set.add(track);
    buses.forEach((bus) => busConnectTrack(bus, track, kind));
  }

  // ---- Hooks (passive until a recording or agent call starts) ----

  const mediaDevicesProto = window.MediaDevices?.prototype;
  if (mediaDevicesProto?.getUserMedia) {
    const origGetUserMedia = mediaDevicesProto.getUserMedia;
    mediaDevicesProto.getUserMedia = function (...args) {
      return origGetUserMedia.apply(this, args).then((stream) => {
        let out = stream;
        try {
          if (stream.getAudioTracks().length && !loggedMicPaths.has("getUserMedia")) {
            loggedMicPaths.add("getUserMedia");
            console.log(`[WA] call tap: mic reached getUserMedia (agent armed: ${!!agent})`);
          }
          if (agent && stream.getAudioTracks().length) out = agentMicStream(stream);
          out.getAudioTracks().forEach((t) => addTrack(micTracks, "you", t));
        } catch (err) {
          console.warn("[WA] call tap: mic hook failed →", err);
        }
        return out;
      });
    };
  }

  if (origCreateStreamSource) {
    window.AudioContext.prototype.createMediaStreamSource = function (stream) {
      let s = stream;
      try {
        s = swapMicStream(stream, "Web Audio");
      } catch (err) {
        console.warn("[WA] call tap: mic swap failed →", err);
      }
      return origCreateStreamSource.call(this, s);
    };
  }

  if (window.MediaStreamAudioSourceNode) {
    window.MediaStreamAudioSourceNode = new Proxy(window.MediaStreamAudioSourceNode, {
      construct(target, args, newTarget) {
        try {
          if (args[1]?.mediaStream) {
            args = [args[0], { ...args[1], mediaStream: swapMicStream(args[1].mediaStream, "Web Audio") }];
          }
        } catch (_) {}
        return Reflect.construct(target, args, newTarget);
      },
    });
  }

  const pcProto = window.RTCPeerConnection?.prototype;
  if (pcProto?.addTrack) {
    const origAddTrack = pcProto.addTrack;
    pcProto.addTrack = function (track, ...streams) {
      let t = track;
      try {
        if (isLocalMic(track)) {
          if (!loggedMicPaths.has("WebRTC")) {
            loggedMicPaths.add("WebRTC");
            console.log(`[WA] call tap: mic reached WebRTC (agent armed: ${!!agent})`);
          }
          t = swapMicTrack(track, "WebRTC");
          addTrack(micTracks, "you", t);
        }
      } catch (_) {}
      return origAddTrack.call(this, t, ...streams);
    };
  }
  const senderProto = window.RTCRtpSender?.prototype;
  if (senderProto?.replaceTrack) {
    const origReplaceTrack = senderProto.replaceTrack;
    senderProto.replaceTrack = function (track) {
      let t = track;
      try {
        if (track && isLocalMic(track)) {
          t = swapMicTrack(track, "WebRTC");
          addTrack(micTracks, "you", t);
        }
      } catch (_) {}
      return origReplaceTrack.call(this, t);
    };
  }

  if (window.RTCPeerConnection) {
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget);
        try {
          pc.addEventListener("track", (e) =>
            addTrack(remoteTracks, "them", e.track),
          );
        } catch (_) {}
        return pc;
      },
    });
  }

  const srcObjectDesc = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "srcObject",
  );
  if (srcObjectDesc?.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      ...srcObjectDesc,
      set(value) {
        try {
          if (value instanceof MediaStream) {
            value.getAudioTracks().forEach((t) => addTrack(remoteTracks, "them", t));
            value.addEventListener("addtrack", (e) =>
              addTrack(remoteTracks, "them", e.track),
            );
          }
        } catch (_) {}
        return srcObjectDesc.set.call(this, value);
      },
    });
  }

  // Covers calls whose audio is decoded in the page and played via Web Audio.
  // Our own nodes use origConnect, so they never land here.
  if (origConnect) {
    window.AudioNode.prototype.connect = function (target, ...rest) {
      const out = origConnect.call(this, target, ...rest);
      try {
        if (
          target instanceof AudioDestinationNode &&
          target.context instanceof AudioContext
        ) {
          if (playingNodes.size > 200) {
            playingNodes.forEach((ref) => {
              if (!ref.deref()) playingNodes.delete(ref);
            });
          }
          playingNodes.add(new WeakRef(this));
          buses.forEach((bus) => busTeeNode(bus, this));
        }
      } catch (_) {}
      return out;
    };
  }

  // ---- Buses ----

  function createBus(ctx, kinds) {
    const bus = {
      ctx,
      gains: {},
      sources: new Map(), // track -> { node, kind }
      webBuses: new Map(), // page AudioContext -> MediaStreamDestination
      tees: new Map(), // page AudioNode -> its MediaStreamDestination
    };
    kinds.forEach((k) => (bus.gains[k] = ctx.createGain()));
    buses.add(bus);
    micTracks.forEach((t) => busConnectTrack(bus, t, "you"));
    remoteTracks.forEach((t) => busConnectTrack(bus, t, "them"));
    playingNodes.forEach((ref) => {
      const node = ref.deref();
      if (node) busTeeNode(bus, node);
      else playingNodes.delete(ref);
    });
    return bus;
  }

  function closeBus(bus) {
    buses.delete(bus);
    bus.tees.forEach((dest, node) => {
      try {
        origDisconnect.call(node, dest);
      } catch (_) {}
    });
  }

  function busConnectTrack(bus, track, kind) {
    if (!bus.gains[kind] || bus.sources.has(track) || !isLive(track)) return;
    try {
      const node = sourceFrom(bus.ctx, new MediaStream([track]));
      origConnect.call(node, bus.gains[kind]);
      bus.sources.set(track, { node, kind });
    } catch (err) {
      console.warn("[WA] call tap: could not add track →", err);
    }
  }

  function busTeeNode(bus, node) {
    if (!bus.gains.web || bus.tees.has(node)) return;
    try {
      let dest = bus.webBuses.get(node.context);
      if (!dest) {
        dest = node.context.createMediaStreamDestination();
        bus.webBuses.set(node.context, dest);
        const src = sourceFrom(bus.ctx, dest.stream);
        origConnect.call(src, bus.gains.web);
      }
      origConnect.call(node, dest);
      bus.tees.set(node, dest);
    } catch (err) {
      console.warn("[WA] call tap: could not tap Web Audio →", err);
    }
  }

  function busCountLive(bus, kind) {
    let n = 0;
    bus.sources.forEach((s, track) => {
      if (s.kind === kind && isLive(track)) n += 1;
    });
    return n;
  }

  // Drops ended tracks; returns live counts
  function busTick(bus) {
    bus.sources.forEach((s, track) => {
      if (isLive(track)) return;
      try {
        s.node.disconnect();
      } catch (_) {}
      bus.sources.delete(track);
    });
    const you = busCountLive(bus, "you");
    const them = busCountLive(bus, "them");
    // The same voice can arrive twice (track + Web Audio) — prefer the track
    if (bus.gains.web) bus.gains.web.gain.value = them ? 0 : 1;
    return { you, them };
  }

  // ---- Recording ----

  function getState(extra = {}) {
    return {
      recording: !!rec,
      startedAt: rec?.startedAt || 0,
      you: rec ? busCountLive(rec.bus, "you") > 0 : false,
      them: rec ? busCountLive(rec.bus, "them") > 0 : false,
      // Page audio is tapped too (may be their voice, may be just sounds)
      webAudio: rec ? rec.bus.tees.size > 0 : false,
      ...extra,
    };
  }

  function emitState(extra) {
    const json = JSON.stringify(getState(extra));
    lastStateJson = json;
    document.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: json }));
  }

  function tick() {
    if (!rec) return;
    const { you, them } = busTick(rec.bus);
    if (you || them) {
      rec.hadCall = true;
      rec.quietSince = 0;
    } else if (rec.hadCall) {
      rec.quietSince = rec.quietSince || Date.now();
      if (Date.now() - rec.quietSince >= CALL_END_GRACE_MS) {
        stopRecording("call-ended");
        return;
      }
    }
    if (JSON.stringify(getState()) !== lastStateJson) emitState();
  }

  function startRecording(chatName) {
    if (rec) {
      emitState();
      return;
    }
    if (!window.MediaRecorder || !origConnect) {
      emitState({ error: "This browser can't record audio here." });
      return;
    }
    const ctx = new AudioContext();
    const out = ctx.createMediaStreamDestination();
    out.channelCount = 1;
    const mimeType =
      ["audio/webm;codecs=opus", "audio/webm"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) || "";
    const recorder = new MediaRecorder(out.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 64000,
    });
    const chunks = [];
    const r = {
      ctx,
      bus: null,
      recorder,
      chatName,
      startedAt: Date.now(),
      stoppedAt: 0,
      reason: "",
      hadCall: false,
      quietSince: 0,
      timer: null,
    };
    recorder.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      saveRecording(r, chunks, recorder.mimeType || mimeType).catch((err) => {
        console.warn("[WA] call tap: save failed →", err);
        emitState({ error: `Saving failed: ${err.message || "unknown error"}` });
      });
    };
    rec = r;
    r.bus = createBus(ctx, ["you", "them", "web"]);
    Object.values(r.bus.gains).forEach((g) => origConnect.call(g, out));

    recorder.start(1000);
    ctx.resume().catch(() => {});
    r.timer = setInterval(tick, 1000);
    emitState();
  }

  function stopRecording(reason) {
    const r = rec;
    if (!r) return;
    rec = null;
    clearInterval(r.timer);
    r.reason = reason;
    r.stoppedAt = Date.now();
    closeBus(r.bus);
    if (r.recorder.state !== "inactive") r.recorder.stop();
    emitState({ saving: true });
  }

  async function saveRecording(r, chunks, mimeType) {
    r.ctx.close().catch(() => {});
    const raw = new Blob(chunks, { type: mimeType || "audio/webm" });
    if (!raw.size) {
      emitState({ error: "Nothing was recorded." });
      return;
    }
    // MP3 first; WAV, then the raw recording, so a recording is never lost
    let blob = raw;
    let ext = "webm";
    try {
      const pcm = await decodeToMonoPcm(raw);
      try {
        blob = await encodeMp3(pcm);
        ext = "mp3";
      } catch (err) {
        console.warn("[WA] call tap: MP3 encode failed, saving WAV →", err);
        blob = encodeWav(pcm);
        ext = "wav";
      }
    } catch (err) {
      console.warn("[WA] call tap: decode failed, saving original →", err);
    }
    const filename = buildFilename(r.chatName, r.startedAt, ext);
    download(blob, filename);
    emitState({
      saved: {
        filename,
        ms: r.stoppedAt - r.startedAt,
        callEnded: r.reason === "call-ended",
      },
    });
  }

  // Recorded webm/opus → 16-bit mono samples at OUTPUT_SAMPLE_RATE
  async function decodeToMonoPcm(blob) {
    const decoder = new OfflineAudioContext(1, 1, OUTPUT_SAMPLE_RATE);
    const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
    const n = audio.length;
    const channels = audio.numberOfChannels;
    const samples = new Int16Array(n);
    const data = [];
    for (let c = 0; c < channels; c++) data.push(audio.getChannelData(c));
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += data[c][i];
      s = Math.max(-1, Math.min(1, s / channels));
      samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return { samples, rate: audio.sampleRate };
  }

  // Encodes in slices and yields between them so WhatsApp stays responsive
  async function encodeMp3({ samples, rate }) {
    const lame = window.lamejs;
    if (!lame?.Mp3Encoder) throw new Error("MP3 encoder not loaded");
    const encoder = new lame.Mp3Encoder(1, rate, MP3_KBPS);
    const SLICE = 1152 * 20;
    const parts = [];
    let sliceStart = performance.now();
    for (let i = 0; i < samples.length; i += SLICE) {
      const out = encoder.encodeBuffer(samples.subarray(i, i + SLICE));
      if (out.length) parts.push(out);
      if (performance.now() - sliceStart > 30) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(tail);
    return new Blob(parts, { type: "audio/mpeg" });
  }

  // Fallback: plain 16-bit PCM WAV
  function encodeWav({ samples, rate }) {
    const n = samples.length;
    const view = new DataView(new ArrayBuffer(44 + n * 2));
    const writeAscii = (offset, text) => {
      for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    };
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeAscii(36, "data");
    view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, samples[i], true);
    return new Blob([view.buffer], { type: "audio/wav" });
  }

  function buildFilename(chatName, startedAt, ext) {
    const d = new Date(startedAt);
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const name =
      String(chatName || "")
        .replace(/[\\/:*?"<>|]+/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 60) || "whatsapp";
    return `call-${name}-${stamp}.${ext}`;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---- AI call agent ----

  function emitAgent(msg) {
    document.dispatchEvent(
      new CustomEvent(AGENT_EVENT, { detail: JSON.stringify(msg) }),
    );
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function fromBase64(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  }

  // Worklet: their voice (mono, 24 kHz) → 16-bit PCM chunks. Loaded from a
  // blob: URL, which WhatsApp's script-src allows.
  const PCM_WORKLET = `
    class WaPcmTap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Int16Array(${AGENT_CHUNK_SAMPLES}); this.n = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) {
          for (let i = 0; i < ch.length; i++) {
            const s = Math.max(-1, Math.min(1, ch[i]));
            this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
            if (this.n === this.buf.length) {
              this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
              this.buf = new Int16Array(${AGENT_CHUNK_SAMPLES});
              this.n = 0;
            }
          }
        }
        return true;
      }
    }
    registerProcessor("wa-pcm-tap", WaPcmTap);
  `;

  async function armAgent() {
    if (agent) {
      emitAgentState(true);
      return;
    }
    if (!origConnect || !window.AudioWorkletNode) {
      emitAgent({ type: "error", error: "This browser can't run the call agent." });
      return;
    }
    // Mouth: the virtual mic WhatsApp will get. Real mic is mixed in muted.
    const micCtx = new AudioContext({ sampleRate: AGENT_SAMPLE_RATE });
    const micDest = micCtx.createMediaStreamDestination();
    micDest.channelCount = 1;
    micDest.stream.getAudioTracks().forEach((t) => ownTracks.add(t));
    const voiceGain = micCtx.createGain();
    const realGain = micCtx.createGain();
    realGain.gain.value = 0;
    origConnect.call(voiceGain, micDest);
    origConnect.call(realGain, micDest);
    // Lets you hear the agent too
    origConnect.call(voiceGain, micCtx.destination);

    // Ears: only the other person, so the agent never hears itself
    const earCtx = new AudioContext({ sampleRate: AGENT_SAMPLE_RATE });
    const a = {
      micCtx,
      micDest,
      voiceGain,
      realGain,
      earCtx,
      ears: null,
      outTracks: new Map(), // track given to WhatsApp -> { realTracks, ownsReal }
      playing: new Set(),
      playAt: 0,
      armedAt: Date.now(),
      hadCall: false,
      answered: false, // the sidebar saw the customer pick up
      quietSince: 0,
      takenOver: false,
      timer: null,
      lastJson: "",
    };
    agent = a;
    try {
      const url = URL.createObjectURL(
        new Blob([PCM_WORKLET], { type: "application/javascript" }),
      );
      await earCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch (err) {
      disarmAgent("error");
      emitAgent({ type: "error", error: `Agent audio failed: ${err.message || err}` });
      return;
    }
    if (agent !== a) return; // disarmed while loading
    const worklet = new AudioWorkletNode(earCtx, "wa-pcm-tap", {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    const sink = earCtx.createGain();
    sink.gain.value = 0;
    origConnect.call(worklet, sink);
    origConnect.call(sink, earCtx.destination); // keeps the worklet running
    worklet.port.onmessage = (e) => {
      if (agent !== a) return;
      const pcm = new Int16Array(e.data);
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) {
        const v = Math.abs(pcm[i]);
        if (v > peak) peak = v;
      }
      emitAgent({ type: "audio", audio: toBase64(e.data), level: peak / 0x8000 });
    };
    a.ears = createBus(earCtx, ["them", "web"]);
    Object.values(a.ears.gains).forEach((g) => origConnect.call(g, worklet));
    micCtx.resume().catch(() => {});
    earCtx.resume().catch(() => {});
    a.timer = setInterval(agentTick, 500);
    emitAgentState(true);
  }

  // ownsReal: we opened the real mic (getUserMedia path) and must stop it;
  // otherwise it is WhatsApp's, and it ending means WhatsApp let go.
  function agentMicStream(real, { ownsReal = true } = {}) {
    const a = agent;
    const realTracks = real.getAudioTracks();
    realTracks.forEach((t) => {
      const src = sourceFrom(a.micCtx, new MediaStream([t]));
      origConnect.call(src, a.realGain);
    });
    // A clone per request: WhatsApp stopping it doesn't kill the virtual mic
    const track = a.micDest.stream.getAudioTracks()[0].clone();
    ownTracks.add(track);
    a.outTracks.set(track, { realTracks, ownsReal });
    return new MediaStream([track, ...real.getVideoTracks()]);
  }

  // A track given to WhatsApp counts as in use until it (or, when the mic was
  // WhatsApp's own, the mic behind it) has ended
  function outTrackLive(track, entry) {
    if (!isLive(track)) return false;
    return entry.ownsReal || entry.realTracks.some(isLive);
  }

  function playAgentAudio(b64) {
    const a = agent;
    if (!a || a.takenOver || !b64) return;
    const pcm = new Int16Array(fromBase64(b64));
    if (!pcm.length) return;
    const buf = a.micCtx.createBuffer(1, pcm.length, AGENT_SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = a.micCtx.createBufferSource();
    src.buffer = buf;
    origConnect.call(src, a.voiceGain);
    const now = a.micCtx.currentTime;
    if (a.playAt < now + 0.05) a.playAt = now + 0.05;
    src.start(a.playAt);
    a.playAt += buf.duration;
    a.playing.add(src);
    src.onended = () => a.playing.delete(src);
  }

  // Customer started talking (barge-in): drop what the agent hasn't said yet
  function clearAgentAudio() {
    const a = agent;
    if (!a) return;
    a.playing.forEach((src) => {
      try {
        src.stop();
      } catch (_) {}
    });
    a.playing.clear();
    a.playAt = 0;
  }

  function takeOverFromAgent() {
    const a = agent;
    if (!a) return;
    clearAgentAudio();
    a.takenOver = true;
    a.voiceGain.gain.value = 0;
    a.realGain.gain.value = 1;
    emitAgentState();
  }

  function agentState() {
    const a = agent;
    let liveOut = 0;
    if (a) a.outTracks.forEach((entry, t) => outTrackLive(t, entry) && (liveOut += 1));
    return {
      type: "state",
      armed: !!a,
      onCall: liveOut > 0,
      them: !!a?.ears && busCountLive(a.ears, "them") > 0,
      webAudio: !!a?.ears && a.ears.tees.size > 0,
      speaking: !!a && a.playing.size > 0,
      takenOver: !!a?.takenOver,
    };
  }

  function emitAgentState(force) {
    if (!agent) return;
    const state = agentState();
    const json = JSON.stringify(state);
    if (!force && json === agent.lastJson) return;
    agent.lastJson = json;
    emitAgent(state);
  }

  function agentTick() {
    const a = agent;
    if (!a) return;
    const { them } = busTick(a.ears);
    let liveOut = 0;
    a.outTracks.forEach((entry, track) => {
      if (outTrackLive(track, entry)) {
        liveOut += 1;
        return;
      }
      // WhatsApp released its mic: release ours too
      track.stop();
      if (entry.ownsReal) entry.realTracks.forEach((t) => t.stop());
      a.outTracks.delete(track);
    });
    // The call is on while WhatsApp holds the agent's mic or a call track is
    // live. Without either signal (audio only via the page), the sidebar
    // decides when it ends.
    if (liveOut || them) {
      a.hadCall = true;
      a.quietSince = 0;
    } else if (a.hadCall) {
      a.quietSince = a.quietSince || Date.now();
      if (Date.now() - a.quietSince >= CALL_END_GRACE_MS) {
        disarmAgent("call-ended");
        return;
      }
    } else if (!a.answered && Date.now() - a.armedAt > AGENT_NO_ANSWER_MS) {
      disarmAgent("no-answer");
      return;
    }
    emitAgentState();
  }

  function disarmAgent(reason) {
    const a = agent;
    if (!a) return;
    agent = null;
    clearInterval(a.timer);
    a.playing.forEach((src) => {
      try {
        src.stop();
      } catch (_) {}
    });
    if (a.ears) closeBus(a.ears);
    // Tracks WhatsApp still holds go silent; a mic we opened is released
    a.outTracks.forEach((entry) => {
      if (entry.ownsReal) entry.realTracks.forEach((t) => t.stop());
    });
    a.micCtx.close().catch(() => {});
    a.earCtx.close().catch(() => {});
    emitAgent({ type: "ended", reason });
  }

  // ---- Commands from the sidebar ----

  function parseDetail(e) {
    try {
      return JSON.parse(e.detail);
    } catch (_) {
      return null;
    }
  }

  document.addEventListener(CMD_EVENT, (e) => {
    const msg = parseDetail(e);
    if (msg?.cmd === "start") startRecording(String(msg.chatName || ""));
    else if (msg?.cmd === "stop") stopRecording("stopped");
    else if (msg?.cmd === "ping") emitState();
  });

  document.addEventListener(AGENT_CMD_EVENT, (e) => {
    const msg = parseDetail(e);
    if (msg?.cmd === "arm") armAgent();
    else if (msg?.cmd === "play") playAgentAudio(String(msg.audio || ""));
    else if (msg?.cmd === "clear") clearAgentAudio();
    else if (msg?.cmd === "takeover") takeOverFromAgent();
    else if (msg?.cmd === "answered" && agent) agent.answered = true;
    else if (msg?.cmd === "disarm") disarmAgent(String(msg.reason || "stopped"));
    else if (msg?.cmd === "ping") {
      if (agent) emitAgentState(true);
      else emitAgent({ type: "idle" });
    }
  });

  // A refresh would lose the recording — ask first
  window.addEventListener("beforeunload", (e) => {
    if (rec || agent) e.preventDefault();
  });
})();
