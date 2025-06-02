const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const PORT = process.env.PORT || 10000;
const app = express();

app.use(express.static('public'));
app.use(express.json());

const USERS = [
  { nick: "SDH", id: "SH4114", password: "DH44752187" },
  { nick: "GodOfLies", id: "CL7770", password: "DH44752187" },
  { nick: "Billvechen", id: "FB3541", password: "Bifarkanon100" },
  { nick: "Fern", id: "FN3525", password: "D1p7L0q2" },
  { nick: "YaVaLuK", id: "YK2300", password: "y2v3l0k0" },
  { nick: "Maclover", id: "TU2589", password: "Turqay888Secretniggas" }
];

app.post('/auth', (req, res) => {
  const { id, nick, password } = req.body;
  const user = USERS.find(u => u.id === id && u.nick === nick && u.password === password);
  if (user) return res.status(200).send("OK");
  res.status(401).send("Unauthorized");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map(); // ws => { nick, id, room }

wss.on('connection', (ws) => {
  let userData = { nick: '', id: '', room: '' };

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'join') {
      userData.nick = data.user;
      userData.id = data.id || 'guest_' + Math.random().toString(36).substring(7);
      userData.room = data.room || 'general';
      clients.set(ws, userData);

      broadcast(userData.room, { type: 'system', text: `👋 ${userData.nick} joined the room` });
      return;
    }

    if (data.type === 'message') {
      const text = data.text.trim();

      // ==== Commands ====
      if (text.toLowerCase() === 'log out') {
        ws.send(JSON.stringify({ type: 'logout' }));
        ws.close();
        return;
      }

      if (text.toLowerCase() === 'exit') {
        ws.send(JSON.stringify({ type: 'kick' }));
        ws.close();
        return;
      }

      if (text.toLowerCase() === '/list') {
        const list = Array.from(clients.values())
          .filter(u => u.room === userData.room)
          .map(u => `${u.nick} (${u.id})`);
        ws.send(JSON.stringify({ type: 'list', users: list }));
        return;
      }

      if (text.startsWith('/kick ') || text.startsWith('/ban ')) {
        const command = text.startsWith('/ban ') ? 'ban' : 'kick';
        const targetName = text.split(' ')[1]?.trim();

        if (!['SDH', 'GodOfLies'].includes(userData.nick)) return;

        for (const [client, u] of clients.entries()) {
          if ((u.nick === targetName || u.id === targetName) && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: command, text: `You were ${command}ed by admin.` }));
            client.close();
            clients.delete(client);
            broadcast(u.room, { type: 'system', text: `⚠️ ${u.nick} was ${command}ed by ${userData.nick}` });
            return;
          }
        }
        return;
      }

      broadcast(userData.room, { type: 'message', text, user: userData.nick });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (userData.nick) {
      broadcast(userData.room, { type: 'system', text: `❌ ${userData.nick} left the chat` });
    }
  });
});

function broadcast(room, data) {
  const json = JSON.stringify(data);
  for (const [client, u] of clients.entries()) {
    if (u.room === room && client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});