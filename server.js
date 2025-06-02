const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const fs = require('fs');

const PORT = process.env.PORT || 10000;
const app = express();

app.use(express.static('public'));
app.use(express.json());

const USERS = [
  { nick: "SDH", id: "SH4114", password: "DH44752187" },
  { nick: "GodOfLies", id: "CL7770", password: "DH44752187" },
  { nick: "Billvechen", id: "FB3541", password: "Bifarkanon100" },
  { nick: "Fern", id: "FN3525", password: "D1p7L0q2" },
  { nick: "YaVaLuK", id: "YK2300", password: "y2v3l0k0" }
];

const userHistory = {}; // { username: { rooms: Set(), targets: Set() } }

app.post('/auth', (req, res) => {
  const { id, nick, password } = req.body;
  const user = USERS.find(u => u.id === id && u.nick === nick && u.password === password);
  if (user) return res.status(200).send("OK");
  res.status(401).send("Unauthorized");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map(); // ws -> {nick, id, room, target}

wss.on('connection', (ws) => {
  let username = '';
  let userId = '';
  let room = '';
  let target = '';

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'join') {
      username = data.user;
      userId = data.id || 'guest';
      room = data.room || '';
      target = data.target || '';

      clients.set(ws, { nick: username, id: userId, room, target });

      if (!userHistory[username]) userHistory[username] = { rooms: new Set(), targets: new Set() };
      if (room) userHistory[username].rooms.add(room);
      if (target) userHistory[username].targets.add(target);

      broadcast({ type: 'system', text: `👋 ${username} joined the chat` });
      return;
    }

    if (data.type === 'message') {
      if (data.text === 'exit') {
        ws.send(JSON.stringify({ type: 'exit', text: 'You exited the chat.' }));
        ws.close();
        return;
      }

      if (data.text === '/list') {
        const list = Array.from(clients.values())
          .map(user => `${user.nick}\n🆔 ${user.id}`)
          .join('\n\n');
        ws.send(JSON.stringify({ type: 'system', text: `👥 Users:\n\n${list}` }));
        return;
      }

      if (data.text.startsWith('/kick ')) {
        const targetNick = data.text.split(' ')[1];
        if (["SDH", "GodOfLies"].includes(username)) {
          for (const [client, info] of clients.entries()) {
            if (info.nick === targetNick) {
              client.send(JSON.stringify({ type: 'redirect', text: 'You were kicked.', to: 'select.html' }));
              client.close();
              clients.delete(client);
              broadcast({ type: 'system', text: `⚠️ ${targetNick} was kicked by ${username}` });
              break;
            }
          }
        }
        return;
      }

      if (data.text.startsWith('/ban ')) {
        const targetNick = data.text.split(' ')[1];
        if (["SDH", "GodOfLies"].includes(username)) {
          for (const [client, info] of clients.entries()) {
            if (info.nick === targetNick) {
              client.send(JSON.stringify({ type: 'redirect', text: 'You were banned.', to: 'login.html' }));
              client.close();
              clients.delete(client);
              broadcast({ type: 'system', text: `🚫 ${targetNick} was banned by ${username}` });
              break;
            }
          }
        }
        return;
      }

      broadcast({ type: 'message', text: data.text, user: username, room, target });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (username) {
      broadcast({ type: 'system', text: `❌ ${username} left the chat` });
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
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
