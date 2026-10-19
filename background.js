importScripts("env.js", "posAuth.js");

// Dev-only WebSocket trigger (ws://localhost:3000). Live/store builds don't
// ship localSocket.js and don't set localSocket, so this never loads there.
if (self.WA_ENV && self.WA_ENV.localSocket) {
  importScripts("localSocket.js");
}

async function attachPosAuthHeaders(url, headers) {
  const auth = await readPosAuth(url);
  const next = { ...headers };
  if (auth.token) {
    next.Authorization = `Bearer ${auth.token}`;
  }
  return next;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
      const url = buildReceivePostUrl(template, auth.token);
      if (!url) {
        sendResponse({ ok: false, error: "Invalid chat API URL" });
        return;
      }

      const body = buildChatCreateBody(message.payload || {});
      console.log("[WA] POST /api/chat/create", { url, payload: body });

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
            url,
            data,
            body,
            errorInfo,
          });
          return;
        }

        sendResponse({ ok: true, status: res.status, data, url, body });
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

      console.log("[WA] API request →", method, url);
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
        console.warn("[WA] API returned non-JSON/HTML →", { method, url, status: res.status });
        sendResponse({
          ok: false,
          status: res.status,
          error: errorInfo.summary,
          url,
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
          url,
          status: res.status,
          received_id: data?.received_id ?? data?.receivedId,
          data,
        });
        sendResponse({
          ok: false,
          status: res.status,
          error: errorInfo.summary,
          url,
          data,
          errorInfo,
        });
        return;
      }

      console.log("[WA] API response ←", {
        method,
        url,
        status: res.status,
        success: data?.success,
        dataKeys:
          data?.data && typeof data.data === "object" ?
            Object.keys(data.data)
          : data && typeof data === "object" ?
            Object.keys(data)
          : [],
        data,
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
