let ws = null;
let reconnectTimer = null;

importScripts('posAuth.js');

async function attachPosAuthHeaders(url, headers) {
  const auth = await readPosAuth(url);
  const next = { ...headers };
  if (auth.token) {
    next.Authorization = `Bearer ${auth.token}`;
  }
  return next;
}

function connectWebSocket() {
  try {
    if (typeof WebSocket === 'undefined') {
      console.warn('WebSocket is not available in this context');
      return;
    }

    if (ws) {
      try {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      } catch (_) {}
      ws = null;
    }

    ws = new WebSocket('ws://localhost:3000');

    ws.onopen = () => {
      console.log('WebSocket connection established');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('Received from server:', data);

        if (data && data.type === 'start-sending') {
          chrome.tabs.query({ url: '*://web.whatsapp.com/*' }, (tabs) => {
            for (const tab of tabs) {
              chrome.tabs.sendMessage(tab.id, { type: 'wa-start-sending' }).catch(() => {
                chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: () => {
                    window.postMessage({ type: 'wa-start-sending-from-socket' }, '*');
                  }
                });
              });
            }
          });
        }
      } catch (e) {
        console.error('WebSocket message error:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket closed, retrying in 3s...');
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (ws) {
        try {
          ws.close();
        } catch (_) {}
      }
    };
  } catch (e) {
    console.error('Failed to start WebSocket:', e);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, 3000);
}

// Keep click/popup independent from socket connection
setTimeout(connectWebSocket, 0);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'wa-post-incoming-chat') {
    (async () => {
      const hintUrl =
        message.receiveUrlTemplate ||
        message.apiUrl ||
        'http://localhost:5173/api/chat/create/:token';
      const auth = await readPosAuth(hintUrl);
      if (!auth.token) {
        sendResponse({ ok: false, error: 'Not logged in to AI POS' });
        return;
      }

      const template =
        message.receiveUrlTemplate ||
        `${String(auth.origin || 'http://localhost:5173').replace(/\/+$/, '')}/api/chat/create/:token`;
      const url = buildReceivePostUrl(template, auth.token);
      if (!url) {
        sendResponse({ ok: false, error: 'Invalid chat API URL' });
        return;
      }

      const body = buildChatCreateBody(message.payload || {});

      try {
        const headers = await attachPosAuthHeaders(url, {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        });
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
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
            url
          });
          sendResponse({
            ok: false,
            status: res.status,
            error: errorInfo.summary,
            url,
            data,
            errorInfo
          });
          return;
        }

        sendResponse({ ok: true, status: res.status, data, url, body });
      } catch (err) {
        const errorInfo = formatApiErrorInfo({ error: err.message || 'Network error' });
        sendResponse({
          ok: false,
          error: errorInfo.summary,
          errorInfo
        });
      }
    })();
    return true;
  }

  if (message?.type === 'wa-get-pos-auth') {
    (async () => {
      const hintUrl = message.apiUrl || message.origin || 'http://localhost:5173/api/';
      const auth = await readPosAuth(hintUrl);
      const urls = auth.authenticated
        ? buildDefaultApiUrls(auth.origin, auth.companyId)
        : null;
      sendResponse({
        ...auth,
        companyName: formatCompanyDisplayName(auth.companyName),
        urls
      });
    })();
    return true;
  }

  if (message?.type !== 'wa-api-request') return false;

  const { method, url, body } = message;
  if (!url || !method) {
    sendResponse({ ok: false, error: 'Missing method or URL' });
    return false;
  }

  (async () => {
    try {
      const headers = await attachPosAuthHeaders(url, {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      });
      const options = { method, headers };
      if (body && method !== 'GET' && method !== 'HEAD') {
        options.body = JSON.stringify(body);
      }

      const res = await fetch(url, options);
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
          url
        });
        sendResponse({
          ok: false,
          status: res.status,
          error: errorInfo.summary,
          url,
          data,
          errorInfo
        });
        return;
      }

      sendResponse({ ok: true, status: res.status, data });
    } catch (err) {
      const errorInfo = formatApiErrorInfo({ error: err.message || 'Network error' });
      sendResponse({
        ok: false,
        error: errorInfo.summary,
        errorInfo
      });
    }
  })();

  return true;
});
