// server.js
const WebSocket = require('ws');
const server = new WebSocket.Server({ port: 8080 });

const clients = new Map();

server.on('connection', (ws) => {
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
      broadcast({ type: 'system', text: `❌ ${username} вышел из чата` });
    }
  });
});

function broadcast(data) {
  const json = JSON.stringify(data);
  for (let client of clients.keys()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

console.log("✅ WebSocket сервер запущен на ws://localhost:8080");