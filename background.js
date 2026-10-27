importScripts("env.js", "posAuth.js");

// Dev-only WebSocket trigger (ws://localhost:3000). Live/store builds don't
// ship localSocket.js and don't set localSocket, so this never loads there.
if (self.WA_ENV && self.WA_ENV.localSocket) {
  importScripts("localSocket.js");
}

const BLOCKED_API_URL =
  "Blocked: that URL is not this extension's Store Sync POS chat API";

async function attachPosAuthHeaders(url, headers) {
  if (typeof isAllowedPosApiUrl === "function" && !isAllowedPosApiUrl(url)) {
    throw new Error(BLOCKED_API_URL);
  }
  const auth = await readPosAuth(url);
  const next = { ...headers };
  const sameOrigin =
    auth.origin &&
    typeof normalizeApiOrigin === "function" &&
    normalizeApiOrigin(auth.origin) === normalizeApiOrigin(url);
  if (auth.token && sameOrigin) {
    next.Authorization = `Bearer ${auth.token}`;
  }
  return next;
}

function safeApiUrl(url) {
  return typeof redactSensitiveUrl === "function" ? redactSensitiveUrl(url) : "";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (message?.type === "wa-pos-auth-sync") {
    (async () => {
      const auth = message.auth || {};
      if (!auth.token) {
        sendResponse({ ok: false });
        return;
      }
      const payload = {
        token: auth.token,
        companyId: auth.companyId || "",
        companyName: auth.companyName || "",
        origin: normalizeApiOrigin(auth.origin || preferredPosHosts()[0]),
        updatedAt: Date.now(),
      };
      try {
        await chrome.storage.local.set({
          [posAuthCacheKey(payload.origin)]: payload,
        });
        console.log("[WA] POS auth synced from page →", {
          origin: payload.origin,
          companyId: payload.companyId
            ? String(payload.companyId).slice(0, 8)
            : "",
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "wa-post-incoming-chat") {
    (async () => {
      await syncWaEnvOverride();
      const env = typeof getWaEnv === "function" ? getWaEnv() : null;
      const defaultOrigin = env?.posOrigin || "http://localhost:8000";
      const hintUrl =
        message.receiveUrlTemplate ||
        message.apiUrl ||
        `${resolveChatApiBase(defaultOrigin)}/create/:token`;
      const auth = await readPosAuth(hintUrl);
      if (!auth.token) {
        sendResponse({ ok: false, error: "Not logged in to AI POS" });
        return;
      }

      const template =
        message.receiveUrlTemplate ||
        `${resolveChatApiBase(auth.origin || defaultOrigin)}/create/:token`;
      if (typeof isAllowedPosApiUrl === "function" && !isAllowedPosApiUrl(template)) {
        sendResponse({ ok: false, error: BLOCKED_API_URL });
        return;
      }
      const url = buildReceivePostUrl(template, auth.token);
      if (!url || (typeof isAllowedPosApiUrl === "function" && !isAllowedPosApiUrl(url))) {
        sendResponse({ ok: false, error: "Invalid chat API URL" });
        return;
      }

      const body = buildChatCreateBody(message.payload || {});
      console.log("[WA] POST /api/chat/create", {
        url: safeApiUrl(url),
        messageId: body.message_id || "",
        chars: String(body.message || "").length,
      });

      try {
        const headers = await attachPosAuthHeaders(url, {
          Accept: "application/json",
          "Content-Type": "application/json",
        });
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }

        if (!res.ok) {
          const errorInfo = formatApiErrorInfo({
            status: res.status,
            data,
            error: extractApiErrorMessage(data),
            url,
          });
          sendResponse({
            ok: false,
            status: res.status,
            error: errorInfo.summary,
            url: safeApiUrl(url),
            data,
            errorInfo,
          });
          return;
        }

        sendResponse({
          ok: true,
          status: res.status,
          data,
          url: safeApiUrl(url),
        });
      } catch (err) {
        const errorInfo = formatApiErrorInfo({
          error: err.message || "Network error",
        });
        sendResponse({
          ok: false,
          error: errorInfo.summary,
          errorInfo,
        });
      }
    })();
    return true;
  }

  if (message?.type === "wa-get-pos-auth") {
    (async () => {
      await syncWaEnvOverride();
      const env = typeof getWaEnv === "function" ? getWaEnv() : null;
      const defaultHint =
        env ?
          `${resolveChatApiBase(env.posOrigin)}/`
        : "http://localhost:8000/api/chat/";
      const hintUrl = message.apiUrl || message.origin || defaultHint;
      const auth = await readPosAuth(hintUrl);
      console.log("[WA] wa-get-pos-auth →", {
        hintUrl,
        env: env?.name,
        authenticated: auth.authenticated,
        origin: auth.origin,
        companyId: auth.companyId ? String(auth.companyId).slice(0, 8) : "",
      });
      const urls =
        auth.authenticated ?
          buildDefaultApiUrls(auth.origin, auth.companyId)
        : null;
      sendResponse({
        ...auth,
        companyName: formatCompanyDisplayName(auth.companyName),
        urls,
        env: env ? { name: env.name, label: env.label, posUrl: env.posUrl } : null,
      });
    })();
    return true;
  }

  if (message?.type !== "wa-api-request") return false;

  const { method, url, body } = message;
  if (!url || !method) {
    sendResponse({ ok: false, error: "Missing method or URL" });
    return false;
  }

  (async () => {
    await syncWaEnvOverride();
    try {
      const headers = await attachPosAuthHeaders(url, {
        Accept: "application/json",
        "Content-Type": "application/json",
      });
      const options = { method, headers };
      if (body && method !== "GET" && method !== "HEAD") {
        options.body = JSON.stringify(body);
      }

      console.log("[WA] API request →", method, safeApiUrl(url));
      const res = await fetch(url, options);
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      const looksLikeHtml =
        typeof text === "string" &&
        /^\s*</.test(text) &&
        /<!doctype html|<html[\s>]/i.test(text);
      if (looksLikeHtml) {
        const errorInfo = formatApiErrorInfo({
          status: res.status,
          data,
          error:
            "API returned HTML instead of JSON — check chat API base URL (live uses /pos_admin/api/chat)",
          url,
        });
        console.warn("[WA] API returned non-JSON/HTML →", {
          method,
          url: safeApiUrl(url),
          status: res.status,
        });
        sendResponse({
          ok: false,
          status: res.status,
          error: errorInfo.summary,
          url: safeApiUrl(url),
          data,
          errorInfo,
        });
        return;
      }

      if (!res.ok) {
        const errorInfo = formatApiErrorInfo({
          status: res.status,
          data,
          error: extractApiErrorMessage(data),
          url,
        });
        console.warn("[WA] API request failed →", {
          method,
          url: safeApiUrl(url),
          status: res.status,
          received_id: data?.received_id ?? data?.receivedId,
        });
        sendResponse({
          ok: false,
          status: res.status,
          error: errorInfo.summary,
          url: safeApiUrl(url),
          data,
          errorInfo,
        });
        return;
      }

      console.log("[WA] API response ←", {
        method,
        url: safeApiUrl(url),
        status: res.status,
        success: data?.success,
        dataKeys:
          data?.data && typeof data.data === "object" ?
            Object.keys(data.data)
          : data && typeof data === "object" ?
            Object.keys(data)
          : [],
      });
      sendResponse({ ok: true, status: res.status, data });
    } catch (err) {
      const errorInfo = formatApiErrorInfo({
        error: err.message || "Network error",
      });
      sendResponse({
        ok: false,
        error: errorInfo.summary,
        errorInfo,
      });
    }
  })();

  return true;
});

// ---- AI call agent: one live voice session per call (Gemini or Grok) ----
// content.js opens a "wa-call-agent" port and relays audio both ways. API keys
// live in extension storage (Settings tab) and are only used here. Both
// providers speak the same port protocol:
//   in:  start, audio, greet, tool_result, stop
//   out: ready, audio, interrupt, transcript, tool, error, closed
const AGENT_SETTINGS_KEY = "wa_grok_agent_settings";
const AGENT_AUDIO_RATE = 24000;
const AGENT_OUTCOMES = [
  "confirmed",
  "cancelled",
  "change_requested",
  "call_back_later",
  "wrong_number",
  "unclear",
];
const AGENT_TOOL_TEXT = {
  outcome: "Save the result of this order confirmation call as soon as it is clear.",
  notes: "Short note in English: changes wanted, reason for cancelling, or when to call back.",
  endCall: "Hang up. Call this only after you have said goodbye.",
};

const GROK_CLIENT_SECRET_URL = "https://api.x.ai/v1/realtime/client_secrets";
const GROK_REALTIME_URL = "wss://api.x.ai/v1/realtime?model=grok-voice-latest";
const GROK_AGENT_TOOLS = [
  {
    type: "function",
    name: "record_order_outcome",
    description: AGENT_TOOL_TEXT.outcome,
    parameters: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: AGENT_OUTCOMES },
        notes: { type: "string", description: AGENT_TOOL_TEXT.notes },
      },
      required: ["outcome"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: AGENT_TOOL_TEXT.endCall,
    parameters: { type: "object", properties: {} },
  },
];

const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
// Live transcription can't tell spoken Urdu from Hindi and writes Devanagari;
// finished lines are rewritten in Urdu script by this small text model.
const GEMINI_SCRIPT_MODEL = "gemini-flash-lite-latest";
const GEMINI_SCRIPT_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SCRIPT_MODEL}:generateContent`;
const DEVANAGARI = /[ऀ-ॿ]/;
const GEMINI_AGENT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "record_order_outcome",
        description: AGENT_TOOL_TEXT.outcome,
        parameters: {
          type: "OBJECT",
          properties: {
            outcome: { type: "STRING", enum: AGENT_OUTCOMES },
            notes: { type: "STRING", description: AGENT_TOOL_TEXT.notes },
          },
          required: ["outcome"],
        },
      },
      { name: "end_call", description: AGENT_TOOL_TEXT.endCall },
    ],
  },
];

function agentErrorText(provider, status, detail) {
  const d = String(detail || "");
  if (/credits|spending limit/i.test(d)) {
    return "Your xAI account is out of credits or reached its monthly spending limit. Add credits or raise the limit at console.x.ai → Billing, then try again.";
  }
  if (/quota|rate limit|resource.?exhausted/i.test(d) || status === 429) {
    return provider === "gemini" ?
        "Gemini's free-tier limit was reached. Wait a minute and try again, or use a paid key."
      : "xAI rate limit reached. Wait a minute and try again.";
  }
  if (status === 401 || /api key not valid|invalid api key|unauthenticated/i.test(d)) {
    return "The API key wasn't accepted — check it in Settings → AI call agent.";
  }
  return `${provider === "gemini" ? "Gemini" : "xAI"} error${status ? ` ${status}` : ""}: ${d.slice(0, 200)}`;
}

function decodeWsText(data) {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

// Grok: OpenAI-style realtime events, authenticated with a short-lived secret
function openGrokSession(settings, msg, post) {
  let ws = null;
  let closed = false;
  let ready = false;
  let configured = false;
  let retriedWithoutTranscription = false;
  // Tool results are held until the response that asked for them is done
  let pendingCalls = 0;
  let responseDone = true;
  let wantReply = false;
  let agentText = "";
  const sessionConfig = {
    instructions: String(msg.instructions || ""),
    voice: String(msg.voice || "ara"),
    audio: {
      input: {
        format: { type: "audio/pcm", rate: AGENT_AUDIO_RATE },
        transcription: { model: "grok-transcribe" },
      },
      output: { format: { type: "audio/pcm", rate: AGENT_AUDIO_RATE } },
    },
    turn_detection: { type: "server_vad" },
    tools: GROK_AGENT_TOOLS,
  };

  const send = (m) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch (_) {}
  };
  const fail = (error) => {
    post({ type: "error", error, fatal: true });
    close();
  };
  const configure = () => {
    if (configured) return;
    configured = true;
    send({ type: "session.update", session: sessionConfig });
  };
  const maybeReply = () => {
    if (!responseDone || pendingCalls > 0 || !wantReply) return;
    wantReply = false;
    send({ type: "response.create" });
  };

  function onServerEvent(m) {
    switch (m.type) {
      case "conversation.created":
      case "session.created":
        configure();
        break;
      case "session.updated":
        if (!ready) {
          ready = true;
          post({ type: "ready" });
        }
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (m.delta) post({ type: "audio", audio: m.delta });
        break;
      case "input_audio_buffer.speech_started":
        post({ type: "interrupt" });
        break;
      case "response.created":
        responseDone = false;
        break;
      case "response.done":
        responseDone = true;
        maybeReply();
        break;
      case "response.function_call_arguments.done":
        pendingCalls += 1;
        post({ type: "tool", name: m.name, call_id: m.call_id, args: m.arguments || "{}" });
        break;
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.completed":
        if (m.transcript) {
          post({
            type: "transcript",
            role: "customer",
            text: m.transcript,
            itemId: String(m.item_id || ""),
          });
        }
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        agentText += m.delta || "";
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        post({ type: "transcript", role: "agent", text: m.transcript || agentText });
        agentText = "";
        break;
      case "error": {
        const error = m.error?.message || "Grok reported an error";
        console.warn("[WA] Grok error →", m);
        // Transcription settings rejected? Retry the session without them.
        if (!ready && configured && !retriedWithoutTranscription) {
          retriedWithoutTranscription = true;
          delete sessionConfig.audio.input.transcription;
          send({ type: "session.update", session: sessionConfig });
          break;
        }
        post({ type: "error", error, fatal: !ready });
        break;
      }
    }
  }

  (async () => {
    const apiKey = String(settings.apiKey || "").trim();
    if (!apiKey) {
      fail("Add your xAI API key in Settings → AI call agent.");
      return;
    }
    let secret = "";
    try {
      const res = await fetch(GROK_CLIENT_SECRET_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expires_after: { seconds: 300 } }),
      });
      const text = await res.text();
      if (!res.ok) {
        let detail = text;
        try {
          const body = JSON.parse(text);
          detail = body?.error || body?.message || body?.code || text;
        } catch (_) {}
        fail(agentErrorText("grok", res.status, detail));
        return;
      }
      const data = JSON.parse(text);
      secret = data?.value || data?.client_secret?.value || "";
    } catch (err) {
      fail(`Couldn't reach xAI: ${err?.message || err}`);
      return;
    }
    if (!secret) {
      fail("xAI didn't return a session token.");
      return;
    }
    if (closed) return;

    ws = new WebSocket(GROK_REALTIME_URL, [`xai-client-secret.${secret}`]);
    // Configure on the created event; fall back in case none arrives
    ws.onopen = () => setTimeout(configure, 1500);
    ws.onmessage = (e) => {
      try {
        onServerEvent(JSON.parse(decodeWsText(e.data)));
      } catch (_) {}
    };
    ws.onerror = () => {
      if (!ready) fail("Couldn't connect to Grok.");
    };
    ws.onclose = (e) => {
      if (closed) return;
      closed = true;
      post({ type: "closed", code: e.code, reason: e.reason || "" });
    };
  })();

  return {
    audio(b64) {
      send({ type: "input_audio_buffer.append", audio: b64 });
    },
    // Spoken word for word; it is the agent's turn, so no response.create
    greet(text) {
      send({
        type: "conversation.item.create",
        item: {
          type: "force_message",
          role: "assistant",
          interruptible: false,
          content: [{ type: "output_text", text }],
        },
      });
    },
    toolResult(callId, output, respond) {
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      });
      pendingCalls = Math.max(0, pendingCalls - 1);
      if (respond) wantReply = true;
      maybeReply();
    },
    close,
  };
}

// Gemini Live: BidiGenerateContent over WebSocket, key in the URL
function openGeminiSession(settings, msg, post) {
  let ws = null;
  let closed = false;
  let ready = false;
  let inText = "";
  let inItem = 0;
  let outText = "";
  let outItem = 0;
  let skipGreetingTranscript = false;
  // Calls from one toolCall message are answered together
  let pendingIds = new Set();
  let pendingResponses = [];
  const callNames = new Map();

  const send = (m) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch (_) {}
  };
  const fail = (error) => {
    post({ type: "error", error, fatal: true });
    close();
  };

  async function toUrduScript(text) {
    const res = await fetch(GEMINI_SCRIPT_URL, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "Rewrite the user's text in Urdu script exactly as an Urdu speaker would write it. Keep the same words and meaning; do not translate, answer or add anything. Output only the rewritten text.",
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 300 },
      }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .trim();
  }

  // Shows the line as heard, then swaps in the Urdu-script version
  function postTranscript(role, text, itemId) {
    post({ type: "transcript", role, text, itemId });
  }

  function finishLine(role, text, itemId) {
    if (!text || !DEVANAGARI.test(text)) return;
    toUrduScript(text)
      .then((urdu) => {
        if (urdu) postTranscript(role, urdu, itemId);
      })
      .catch(() => {});
  }

  function finishCustomerLine() {
    if (!inText) return;
    const text = inText.trim();
    inText = "";
    finishLine("customer", text, `in-${inItem}`);
  }

  function onServerMessage(m) {
    if (m.setupComplete && !ready) {
      ready = true;
      post({ type: "ready" });
    }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) post({ type: "interrupt" });
      if (sc.inputTranscription?.text) {
        if (!inText) inItem += 1;
        inText += sc.inputTranscription.text;
        postTranscript("customer", inText.trim(), `in-${inItem}`);
      }
      const parts = sc.modelTurn?.parts || [];
      // The agent starts answering once the customer has finished
      if (parts.length || sc.outputTranscription?.text) finishCustomerLine();
      parts.forEach((p) => {
        if (p.inlineData?.data) post({ type: "audio", audio: p.inlineData.data });
      });
      if (sc.outputTranscription?.text) outText += sc.outputTranscription.text;
      if (sc.turnComplete) {
        finishCustomerLine();
        const text = outText.trim();
        outText = "";
        // The sidebar already shows the greeting it asked for
        if (skipGreetingTranscript) {
          skipGreetingTranscript = false;
        } else if (text) {
          outItem += 1;
          postTranscript("agent", text, `out-${outItem}`);
          finishLine("agent", text, `out-${outItem}`);
        }
      }
    }
    if (m.toolCall?.functionCalls?.length) {
      pendingIds = new Set();
      pendingResponses = [];
      m.toolCall.functionCalls.forEach((fc) => {
        pendingIds.add(fc.id);
        callNames.set(fc.id, fc.name);
        post({ type: "tool", name: fc.name, call_id: fc.id, args: JSON.stringify(fc.args || {}) });
      });
    }
    if (m.goAway) console.warn("[WA] Gemini session ending soon →", m.goAway);
  }

  const apiKey = String(settings.geminiKey || "").trim();
  if (!apiKey) {
    setTimeout(() => fail("Add your Gemini API key in Settings → AI call agent."), 0);
  } else {
    const model = String(msg.model || "").trim() || GEMINI_DEFAULT_MODEL;
    ws = new WebSocket(`${GEMINI_LIVE_URL}?key=${encodeURIComponent(apiKey)}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      send({
        setup: {
          model: `models/${model.replace(/^models\//, "")}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: String(msg.voice || "Kore") },
              },
            },
          },
          systemInstruction: { parts: [{ text: String(msg.instructions || "") }] },
          tools: GEMINI_AGENT_TOOLS,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });
    };
    ws.onmessage = (e) => {
      try {
        onServerMessage(JSON.parse(decodeWsText(e.data)));
      } catch (_) {}
    };
    ws.onerror = () => {
      if (!ready) fail("Couldn't connect to Gemini.");
    };
    ws.onclose = (e) => {
      if (closed) return;
      closed = true;
      // Setup problems (bad key, model, quota) arrive as the close reason
      if (!ready) post({ type: "error", error: agentErrorText("gemini", 0, e.reason || `closed (${e.code})`), fatal: true });
      else post({ type: "closed", code: e.code, reason: e.reason || "" });
    };
  }

  return {
    audio(b64) {
      send({
        realtimeInput: {
          audio: { data: b64, mimeType: `audio/pcm;rate=${AGENT_AUDIO_RATE}` },
        },
      });
    },
    // No verbatim-speech event here, so ask for the line word for word
    greet(text) {
      skipGreetingTranscript = true;
      send({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [
                {
                  text: `The customer just answered the call. Say exactly this, word for word, then stop and wait for them: ${text}`,
                },
              ],
            },
          ],
          turnComplete: true,
        },
      });
    },
    // Gemini carries on by itself once every call in the batch is answered
    toolResult(callId, output) {
      if (!pendingIds.has(callId)) return;
      let response = {};
      try {
        response = JSON.parse(output);
      } catch (_) {}
      pendingIds.delete(callId);
      pendingResponses.push({ id: callId, name: callNames.get(callId) || "", response });
      if (pendingIds.size) return;
      send({ toolResponse: { functionResponses: pendingResponses } });
      pendingResponses = [];
    },
    close,
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "wa-call-agent") return;
  let session = null;
  let closed = false;
  const post = (msg) => {
    try {
      port.postMessage(msg);
    } catch (_) {}
  };

  port.onDisconnect.addListener(() => {
    closed = true;
    session?.close();
  });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === "start" && !session) {
      let settings = {};
      try {
        const stored = await chrome.storage.local.get(AGENT_SETTINGS_KEY);
        settings = stored?.[AGENT_SETTINGS_KEY] || {};
      } catch (_) {}
      if (closed) return;
      session =
        msg.provider === "grok" ?
          openGrokSession(settings, msg, post)
        : openGeminiSession(settings, msg, post);
    } else if (msg?.type === "audio") {
      session?.audio(msg.audio);
    } else if (msg?.type === "greet") {
      session?.greet(String(msg.text || ""));
    } else if (msg?.type === "tool_result") {
      session?.toolResult(msg.call_id, String(msg.output || "{}"), !!msg.respond);
    } else if (msg?.type === "stop") {
      session?.close();
    }
  });
});
