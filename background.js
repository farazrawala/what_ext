let ws;

function connectWebSocket() {
  ws = new WebSocket('ws://localhost:3000'); // Change port if needed

  ws.onopen = () => {
    console.log('WebSocket connection established');
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('Received from server:', data);

    try {
      const data = JSON.parse(event.data);
      if (data && data.type === 'start-sending') {
        // Send message to all tabs with content script
        chrome.tabs.query({url: '*://web.whatsapp.com/*'}, (tabs) => {
          for (const tab of tabs) {
            chrome.scripting.executeScript({
              target: {tabId: tab.id},
              func: () => {
                window.postMessage({type: 'wa-start-sending-from-socket'}, '*');
              }
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
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    ws.close();
  };
}

connectWebSocket();
