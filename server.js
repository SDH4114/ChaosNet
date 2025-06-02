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
  let username = '';
  let userId = '';
  let userRoom = '';

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'join') {
      username = data.user;
      userId = data.id || 'guest';
      userRoom = data.room || 'default';
      clients.set(ws, { nick: username, id: userId, room: userRoom });

      broadcast({ type: 'system', text: `👋 ${username} joined the chat` }, userRoom);
      return;
    }

    if (data.type === 'message') {
      const text = data.text.trim();

      if (text.toLowerCase() === "log out") {
        ws.send(JSON.stringify({ type: 'logout' }));
        ws.close();
        return;
      }

      if (text.toLowerCase() === "exit") {
        ws.send(JSON.stringify({ type: 'kick' }));
        ws.close();
        return;
      }

      if (text === '/list') {
        const list = Array.from(clients.values())
          .filter(u => u.room === userRoom)
          .map(u => `${u.nick} (${u.id})`);
        ws.send(JSON.stringify({ type: 'list', users: Array.from(clients.values()).filter(u => u.room === userRoom) }));
        return;
      }

      if (text.startsWith('/kick ') || text.startsWith('/ban ')) {
        const command = text.startsWith('/ban ') ? 'ban' : 'kick';
        const targetNick = text.split(' ')[1]?.trim();

        if (!['SDH', 'GodOfLies'].includes(username)) return;

        for (const [client, user] of clients.entries()) {
          if (user.nick === targetNick && user.room === userRoom && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: command,
              text: command === 'ban' ? 'You were banned.' : 'You were kicked.'
            }));
            client.close();
            clients.delete(client);
            broadcast({ type: 'system', text: `⚠️ ${targetNick} was ${command}ed by ${username}` }, userRoom);
            return;
          }
        }
        return;
      }

      broadcast({ type: 'message', text: text, user: username }, userRoom);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (username && userRoom) {
      broadcast({ type: 'system', text: `❌ ${username} left the chat` }, userRoom);
    }
  });
});

function broadcast(data, room) {
  const json = JSON.stringify(data);
  for (const [client, user] of clients.entries()) {
    if (user.room === room && client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

server.listen(PORT, () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});