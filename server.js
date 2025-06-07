const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

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
const MESSAGE_LIFETIME = 1000 * 60 * 60 * 24 * 7;
const CHAT_DIR = path.join(__dirname, 'chatlogs');
if (!fs.existsSync(CHAT_DIR)) fs.mkdirSync(CHAT_DIR);

function saveMessagesToFile(room) {
  const filePath = path.join(CHAT_DIR, `${room}.json`);
  fs.writeFileSync(filePath, JSON.stringify(roomMessages[room], null, 2));
}

function loadMessagesFromFile(room) {
  const filePath = path.join(CHAT_DIR, `${room}.json`);
  if (fs.existsSync(filePath)) {
    try {
      roomMessages[room] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      roomMessages[room] = [];
    }
  }
}

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
          .map(u => {
            if (['SDH', 'GodOfLies'].includes(u.nick)) return `${u.nick} (admin)`;
            if (u.id.startsWith('guest_')) return `${u.nick} (guest)`;
            return `${u.nick} (user)`;
          });
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

      const now = new Date();
      const dateString = now.toLocaleDateString('en-US', { day: 'numeric', month: 'long' });
      const room = userData.room;

      if (!roomMessages[room]) {
        roomMessages[room] = [];
        loadMessagesFromFile(room);
      }

      if (!roomMessages[room]._lastDateTag) roomMessages[room]._lastDateTag = '';
      if (roomMessages[room]._lastDateTag !== dateString) {
        roomMessages[room]._lastDateTag = dateString;
        roomMessages[room].push({ type: 'system', text: `${dateString}`, timestamp: now.getTime() });
        broadcast(room, { type: 'system', text: `${dateString}` });
      }

      roomMessages[room] = roomMessages[room].filter(m => now.getTime() - m.timestamp < MESSAGE_LIFETIME);
      const msgObj = { type: 'message', text, user: userData.nick, timestamp: now.getTime() };
      roomMessages[room].push(msgObj);
      broadcast(room, msgObj);
      saveMessagesToFile(room);
    }

    if (data.type === 'join') {
      userData.nick = data.user;
      userData.id = data.id || 'guest_' + Math.random().toString(36).substring(7);
      userData.room = data.room || 'general';
      clients.set(ws, userData);

      if (!roomMessages[userData.room]) {
        loadMessagesFromFile(userData.room);
      }

      const history = roomMessages[userData.room] || [];
      history.forEach(m => ws.send(JSON.stringify(m)));

      broadcast(userData.room, { type: 'system', text: `👋 ${userData.nick} joined the room` });
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    const stillInRoom = Array.from(clients.values()).some(u => u.room === userData.room);

    if (!stillInRoom) {
      const messages = roomMessages[userData.room];
      if (messages && messages.length > 0) {
        const log = messages.map(m => `${m.user || 'SYSTEM'}: ${m.text}`).join('\n');
        sendEmail(`Chat room "${userData.room}" is now empty.\n\nLogs:\n${log}`);
      }
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
