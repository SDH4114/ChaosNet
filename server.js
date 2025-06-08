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
  try {
    fs.writeFileSync(filePath, JSON.stringify(roomMessages[room], null, 2));
  } catch (e) {
    console.error(`Failed to save messages for room ${room}:`, e);
  }
}

function loadMessagesFromFile(room) {
  const filePath = path.join(CHAT_DIR, `${room}.json`);
  if (fs.existsSync(filePath)) {
    try {
      roomMessages[room] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`Failed to load messages for room ${room}:`, e);
      roomMessages[room] = [];
    }
  }
}

function storeSystemMessage(room, text) {
  const msg = { type: 'system', text, timestamp: Date.now() };
  if (!roomMessages[room]) roomMessages[room] = [];
  roomMessages[room].push(msg);
  saveMessagesToFile(room);
  broadcast(room, msg);
}

wss.on('connection', (ws) => {
  let userData = { nick: '', id: '', room: '' };

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    const now = Date.now();
    const room = userData.room;

    // Загружаем историю, если нужно
    if (!roomMessages[room]) {
      loadMessagesFromFile(room);
      if (!roomMessages[room]) roomMessages[room] = [];
    }

    // Сообщение-текст
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

      if (text.startsWith('/kick ') || text.startsWith('/ban ')) {
        const command = text.startsWith('/ban ') ? 'ban' : 'kick';
        const targetName = text.split(' ')[1]?.trim();
        if (!['SDH', 'GodOfLies'].includes(userData.nick)) return;

        for (const [client, u] of clients.entries()) {
          if ((u.nick === targetName || u.id === targetName) && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: command, text: `You were ${command}ed by admin.` }));
            client.close();
            clients.delete(client);
            storeSystemMessage(u.room, `${u.nick} was ${command}ed by ${userData.nick}`);
            return;
          }
        }
        return;
      }

      // Сохраняем и рассылаем текст
      roomMessages[room] = roomMessages[room].filter(m => now - m.timestamp < MESSAGE_LIFETIME);
      const msgObj = { type: 'message', text, user: userData.nick, timestamp: now };
      roomMessages[room].push(msgObj);
      saveMessagesToFile(room);
      broadcast(room, msgObj);
    }

    // Сообщение-изображение
    if (data.type === 'image' && data.image) {
      const msgObj = {
        type: 'image',
        image: data.image,       // base64 строка
        filename: data.filename || 'image',
        user: userData.nick,
        timestamp: now
      };
      roomMessages[room].push(msgObj);
      saveMessagesToFile(room);
      broadcast(room, msgObj);
      return;
    }

    // Подключение к комнате
    if (data.type === 'join') {
      userData.nick = data.user;
      userData.id = data.id || 'guest_' + Math.random().toString(36).substring(7);
      userData.room = data.room || 'general';
      clients.set(ws, userData);

      if (!roomMessages[userData.room]) {
        loadMessagesFromFile(userData.room);
        if (!roomMessages[userData.room]) roomMessages[userData.room] = [];
      }

      const history = roomMessages[userData.room];
      history.forEach(m => ws.send(JSON.stringify(m)));

      storeSystemMessage(userData.room, `${userData.nick} joined the room`);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    const stillInRoom = Array.from(clients.values()).some(u => u.room === userData.room);

    if (!stillInRoom) {
      const messages = roomMessages[userData.room];
      if (messages && messages.length > 0) {
        const log = messages.map(m => `${m.user || 'SYSTEM'}: ${m.text || '[image]'}`).join('\n');
        sendEmail(`Chat room "${userData.room}" is now empty.\n\nLogs:\n${log}`);
      }
    }

    if (userData.nick) {
      storeSystemMessage(userData.room, `${userData.nick} left the room`);
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
    if (err) console.error('Email error:', err);
    else console.log('Email sent:', info.response);
  });
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});