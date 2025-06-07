const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 10000;
const MESSAGE_LIFETIME = 1000 * 60 * 60 * 24 * 7; // 14дней

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

function storeMessage(room, data) {
  if (!roomMessages[room]) roomMessages[room] = [];
  roomMessages[room].push({ ...data, timestamp: Date.now() });

  // очистка сообщений
  roomMessages[room] = roomMessages[room].filter(m => Date.now() - m.timestamp < MESSAGE_LIFETIME);
}

function broadcast(room, data) {
  const json = JSON.stringify(data);
  for (const [client, u] of clients.entries()) {
    if (u.room === room && client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

wss.on('connection', (ws) => {
  let userData = { nick: '', id: '', room: '' };

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'join') {
      userData.nick = data.user;
      userData.id = data.id || 'guest_' + Math.random().toString(36).substring(7);
      userData.room = data.room || 'general';
      clients.set(ws, userData);

      if (!roomMessages[userData.room]) {
        roomMessages[userData.room] = [];
      }

      // старые сообщения
      roomMessages[userData.room].forEach(m => ws.send(JSON.stringify(m)));

      const joinText = `${userData.nick} joined the room`;
      storeMessage(userData.room, { type: 'system', text: joinText });
      broadcast(userData.room, { type: 'system', text: joinText });
      return;
    }

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
        const users = Array.from(clients.values())
          .filter(u => u.room === userData.room)
          .map(u => {
            let role = 'user';
            if (['SDH', 'GodOfLies'].includes(u.nick)) role = 'admin';
            if (u.id.startsWith('guest_')) role = 'guest';
            return `${u.nick} (${u.id}) — ${role}`;
          });

        const listText = `Online users:\n` + users.join('\n');
        storeMessage(userData.room, { type: 'system', text: listText });
        ws.send(JSON.stringify({ type: 'system', text: listText }));
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
            const notice = `⚠️ ${u.nick} was ${command}ed by ${userData.nick}`;
            storeMessage(userData.room, { type: 'system', text: notice });
            broadcast(userData.room, { type: 'system', text: notice });
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
      }
      if (!roomMessages[room]._lastDateTag) {
        roomMessages[room]._lastDateTag = '';
      }

      if (roomMessages[room]._lastDateTag !== dateString) {
        roomMessages[room]._lastDateTag = dateString;
        const dateMessage = `${dateString}`;
        storeMessage(room, { type: 'system', text: dateMessage });
        broadcast(room, { type: 'system', text: dateMessage });
      }

      storeMessage(room, { type: 'message', text, user: userData.nick });
      broadcast(room, { type: 'message', text, user: userData.nick });
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
      delete roomMessages[userData.room];
    }

    if (userData.nick) {
      const leftMsg = `${userData.nick} left the room`;
      storeMessage(userData.room, { type: 'system', text: leftMsg });
      broadcast(userData.room, { type: 'system', text: leftMsg });
    }
  });
});

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