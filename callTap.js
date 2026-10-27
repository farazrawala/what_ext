// Runs in the page itself (MAIN world) from document_start, so it sees call
// audio as WhatsApp creates it: your mic from getUserMedia, the other person
// from RTCPeerConnection / <audio>.srcObject, and anything played through
// Web Audio. Idle until the sidebar arms the AI call agent. While armed,
// WhatsApp's mic is swapped for a virtual one that carries the agent's voice
// (your real mic stays muted until you take over), and the other person's
// voice is streamed out as 24 kHz PCM. The sidebar (content.js) talks to it
// with CustomEvents whose detail is a JSON string; it relays the agent audio
// to the provider via the background script. Call recording is not included.
(() => {
  if (window.__waCallTap) return;
  window.__waCallTap = true;

  const AGENT_CMD_EVENT = "wa-ext:agent-cmd";
  const AGENT_EVENT = "wa-ext:agent-evt";
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
  // Each bus mixes the call's live sources into one AudioContext.
  // The agent's ears listen to the other person (and page audio if no call track).
  const buses = new Set();
  let agent = null;

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
  // while armed. Elsewhere it only notes the mic so a later arm can use it.
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

  // ---- Hooks (passive until an agent call starts) ----

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

  // A refresh would drop the agent call — ask first
  window.addEventListener("beforeunload", (e) => {
    if (agent) e.preventDefault();
  });
})();
