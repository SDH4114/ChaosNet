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
  { nick: "YaVaLuK", id: "YK2300", password: "y2v3l0k0" }
];

app.post('/auth', (req, res) => {
  const { id, nick, password } = req.body;
  const user = USERS.find(u => u.id === id && u.nick === nick && u.password === password);
  if (user) return res.status(200).send("OK");
  res.status(401).send("Unauthorized");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map(); // WebSocket => { nick, id }

wss.on('connection', (ws) => {
  let username = '';
  let userId = '';

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'join') {
      username = data.user;
      userId = data.id || 'guest';
      clients.set(ws, { nick: username, id: userId });
      broadcast({ type: 'system', text: `👋 ${username} joined the chat` });
      return;
    }

    if (data.type === 'message') {
      const text = data.text.trim();

      if (text.toLowerCase() === "log out") {
        ws.send(JSON.stringify({ type: 'logout' }));
        ws.close();
        return;
      }

      if (text === '/list') {
        const list = Array.from(clients.values()).map(u => u.nick).join(', ');
        ws.send(JSON.stringify({ type: 'system', text: `🧾 Online users: ${list}` }));
        return;
      }

      if (text.startsWith('/kick ') || text.startsWith('/ban ')) {
        const command = text.startsWith('/ban ') ? 'ban' : 'kick';
        const targetNick = text.split(' ')[1]?.trim();

        if (!['SDH', 'GodOfLies'].includes(username)) return;

        for (const [client, user] of clients.entries()) {
          if (user.nick === targetNick && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: command,
              text: command === 'ban' ? 'You were banned.' : 'You were kicked.'
            }));
            client.close();
            clients.delete(client);
            broadcast({ type: 'system', text: `⚠️ ${targetNick} was ${command}ed by ${username}` });
            return;
          }
        }
        return;
      }

      broadcast({ type: 'message', text: text, user: username });
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
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});