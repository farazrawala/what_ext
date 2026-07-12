const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let lastClient = null;

// Log when a new WebSocket client connects
wss.on('connection', (ws) => {
  lastClient = ws;
  console.log('New user arrived', ws);
  if (ws._socket) {
    console.log('Socket ID:', ws._socket.remoteAddress + ':' + ws._socket.remotePort);
  }
});

// wss.on('onmessage', () => {
//   console.log('Message sent to frontend:');
// });

// Serve the HTML page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>WhatsApp Socket Trigger</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; }
        button { font-size: 1.2em; padding: 10px 30px; }
      </style>
    </head>
    <body>
      <h2>WhatsApp Extension Socket Control</h2>
      <button id="startBtn">Start Sending Message</button>
      <script>
        document.getElementById('startBtn').onclick = function() {
          fetch('/trigger', { method: 'POST' });
        };
      </script>
    </body>
    </html>
  `);
});

// Endpoint to trigger the socket event
app.post('/trigger', (req, res) => {
  if (lastClient && lastClient.readyState === WebSocket.OPEN) {
    lastClient.send(JSON.stringify({ type: 'start-sending' }));
    console.log('Message sent to frontend:');
  }
  res.sendStatus(200);
});

// Start the server
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
}); 