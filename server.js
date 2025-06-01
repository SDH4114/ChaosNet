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

const clients = new Map();

wss.on('connection', (ws) => {
  let username = '';

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'join') {
      username = data.user;
      clients.set(ws, username);
      broadcast({ type: 'system', text: `👋 ${username} присоединился к чату` });
      return;
    }

    if (data.type === 'message') {
      // Проверка на команду kick
      if (data.text.startsWith('kick:')) {
        const target = data.text.split(':')[1]?.trim();
        if (['SDH', 'GodOfLies'].includes(username)) {
          for (const [client, nick] of clients.entries()) {
            if (nick === target && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'kick', text: 'Вы были кикнуты администратором.' }));
              client.close();
              clients.delete(client);
              broadcast({ type: 'system', text: `⚠️ ${target} был кикнут администратором ${username}` });
              break;
            }
          }
        }
        return;
      }

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