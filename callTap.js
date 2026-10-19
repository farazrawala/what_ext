// Runs in the page itself (MAIN world) from document_start, so it sees call
// audio as WhatsApp creates it: your mic from getUserMedia, the other person
// from RTCPeerConnection / <audio>.srcObject, and anything played through
// Web Audio. It does nothing until the sidebar sends "start"; then it mixes
// those voices into one recording (no screen, no share prompt) and downloads
// it as an .mp3 (vendor/lame.min.js, loaded into this world by the manifest).
// The sidebar (content.js) talks to it with CustomEvents whose detail is a
// JSON string.
(() => {
  if (window.__waCallTap) return;
  window.__waCallTap = true;

  const CMD_EVENT = "wa-ext:call-rec-cmd";
  const STATE_EVENT = "wa-ext:call-rec-state";
  // 24 kHz mono: clear voices, ~360 KB per minute as MP3
  const OUTPUT_SAMPLE_RATE = 24000;
  const MP3_KBPS = 48;
  // Save on its own once every call track has been gone this long
  const CALL_END_GRACE_MS = 3000;

  const micTracks = new Set();
  const remoteTracks = new Set();
  const playingNodes = new Set(); // WeakRef<AudioNode> wired to the speakers
  let rec = null;
  let lastStateJson = "";

  const origConnect = window.AudioNode?.prototype.connect;
  const origDisconnect = window.AudioNode?.prototype.disconnect;

  const isLive = (track) => !!track && track.readyState === "live";

  function addTrack(set, kind, track) {
    if (!track || track.kind !== "audio" || !isLive(track)) return;
    if (kind === "them" && micTracks.has(track)) return;
    set.forEach((t) => {
      if (!isLive(t)) set.delete(t);
    });
    set.add(track);
    if (rec) connectTrack(track, kind);
  }

  // ---- Hooks (passive until a recording starts) ----

  const mediaDevicesProto = window.MediaDevices?.prototype;
  if (mediaDevicesProto?.getUserMedia) {
    const origGetUserMedia = mediaDevicesProto.getUserMedia;
    mediaDevicesProto.getUserMedia = function (...args) {
      return origGetUserMedia.apply(this, args).then((stream) => {
        try {
          stream.getAudioTracks().forEach((t) => addTrack(micTracks, "you", t));
        } catch (_) {}
        return stream;
      });
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

  // Covers calls whose audio is decoded in the page and played via Web Audio
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
          if (rec) teeNode(this);
        }
      } catch (_) {}
      return out;
    };
  }

  // ---- Recording ----

  function connectTrack(track, kind) {
    if (!rec || rec.sources.has(track) || !isLive(track)) return;
    try {
      const node = rec.ctx.createMediaStreamSource(new MediaStream([track]));
      origConnect.call(node, rec.gains[kind]);
      rec.sources.set(track, { node, kind });
    } catch (err) {
      console.warn("[WA] call tap: could not add track →", err);
    }
  }

  function teeNode(node) {
    if (!rec || rec.tees.has(node)) return;
    try {
      let bus = rec.buses.get(node.context);
      if (!bus) {
        bus = node.context.createMediaStreamDestination();
        rec.buses.set(node.context, bus);
        const src = rec.ctx.createMediaStreamSource(bus.stream);
        origConnect.call(src, rec.gains.web);
      }
      origConnect.call(node, bus);
      rec.tees.set(node, bus);
    } catch (err) {
      console.warn("[WA] call tap: could not tap Web Audio →", err);
    }
  }

  function countLive(kind) {
    let n = 0;
    rec.sources.forEach((s, track) => {
      if (s.kind === kind && isLive(track)) n += 1;
    });
    return n;
  }

  function getState(extra = {}) {
    return {
      recording: !!rec,
      startedAt: rec?.startedAt || 0,
      you: rec ? countLive("you") > 0 : false,
      them: rec ? countLive("them") > 0 : false,
      // Page audio is tapped too (may be their voice, may be just sounds)
      webAudio: rec ? rec.tees.size > 0 : false,
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
    rec.sources.forEach((s, track) => {
      if (isLive(track)) return;
      try {
        s.node.disconnect();
      } catch (_) {}
      rec.sources.delete(track);
    });
    const you = countLive("you");
    const them = countLive("them");
    // The same voice can arrive twice (track + Web Audio) — prefer the track
    rec.gains.web.gain.value = them ? 0 : 1;

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
    const gains = {};
    ["you", "them", "web"].forEach((k) => {
      gains[k] = ctx.createGain();
      origConnect.call(gains[k], out);
    });
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
      gains,
      recorder,
      chatName,
      startedAt: Date.now(),
      stoppedAt: 0,
      reason: "",
      sources: new Map(), // track -> { node, kind }
      buses: new Map(), // page AudioContext -> MediaStreamDestination
      tees: new Map(), // page AudioNode -> bus
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

    micTracks.forEach((t) => connectTrack(t, "you"));
    remoteTracks.forEach((t) => connectTrack(t, "them"));
    playingNodes.forEach((ref) => {
      const node = ref.deref();
      if (node) teeNode(node);
      else playingNodes.delete(ref);
    });

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
    r.tees.forEach((bus, node) => {
      try {
        origDisconnect.call(node, bus);
      } catch (_) {}
    });
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

  document.addEventListener(CMD_EVENT, (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (msg?.cmd === "start") startRecording(String(msg.chatName || ""));
    else if (msg?.cmd === "stop") stopRecording("stopped");
    else if (msg?.cmd === "ping") emitState();
  });

  // A refresh would lose the recording — ask first
  window.addEventListener("beforeunload", (e) => {
    if (rec) e.preventDefault();
  });
})();
