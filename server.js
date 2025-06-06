const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 10000;
const app = express();

app.use(express.static('public'));
app.use(express.json());
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

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

const clients = new Map();
const roomMessages = {}; 

wss.on('connection', (ws) => {
  let userData = { nick: '', id: '', room: '' };

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'message') {
      const text = data.text.trim();

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
          .map(u => u.nick);
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

      // 🗓️ Проверка даты и системное сообщение
      const now = new Date();
      const dateString = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      const room = userData.room;

      if (!roomMessages[room]) {
        roomMessages[room] = [];
      }
      if (!roomMessages[room]._lastDateTag) {
        roomMessages[room]._lastDateTag = '';
      }

      if (roomMessages[room]._lastDateTag !== dateString) {
        roomMessages[room]._lastDateTag = dateString;
        roomMessages[room].push(`📅 ${dateString}`);
        broadcast(room, { type: 'system', text: `📅 ${dateString}` });
      }

      // добавляем сообщение пользователя
      roomMessages[room].push(`${userData.nick}: ${text}`);
      broadcast(room, { type: 'message', text, user: userData.nick });
    }

  ws.on('close', () => {
    clients.delete(ws);
    const stillInRoom = Array.from(clients.values()).some(u => u.room === userData.room);

    if (!stillInRoom) {
      const messages = roomMessages[userData.room];
      if (messages && messages.length > 0) {
        const log = messages.join('\n');
        sendEmail(`Chat room "${userData.room}" is now empty.\n\nLogs:\n${log}`);
      }
      delete roomMessages[userData.room];
    }

    if (userData.nick) {
      broadcast(userData.room, { type: 'system', text: `❌ ${userData.nick} left the room` });
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

function sendEmail(content) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER,
    subject: 'Chat log from ChaosNet',
    text: content
  };

  transporter.sendMail(mailOptions, (err, info) => {
    if (err) {
      console.error('Email error:', err);
    } else {
      console.log('Email sent:', info.response);
    }
  });
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});