let ws = null;
let reconnectTimer = null;

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
  if (message?.type !== 'wa-api-request') return false;

  const { method, url, body } = message;
  if (!url || !method) {
    sendResponse({ ok: false, error: 'Missing method or URL' });
    return false;
  }

  (async () => {
    try {
      const options = {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      };
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
        sendResponse({
          ok: false,
          status: res.status,
          error: data?.message || `HTTP ${res.status}`,
          data
        });
        return;
      }

      sendResponse({ ok: true, status: res.status, data });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || 'Network error' });
    }
  })();

  return true;
});
