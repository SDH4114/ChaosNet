const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const PORT = process.env.PORT || 10000;
const app = express();

app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on('connection', (ws) => {
  let username = '';

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'join') {
      username = data.user;
      clients.set(ws, username);
      broadcast({ type: 'system', text: `👋 ${username} присоединился к чату` });
    }

    if (data.type === 'message') {
      broadcast({ type: 'message', text: data.text, user: username });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (username) {
      broadcast({ type: 'system', text: `❌ ${username} покинул чат` });
    }
  });
});

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const client of clients.keys()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

server.listen(PORT, () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});