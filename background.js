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
