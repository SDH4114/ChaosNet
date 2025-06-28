const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const BUCKET = 'chat-uploads';

app.use(express.static('public'));
app.use(express.json());

const upload = multer({ dest: 'temp_uploads/' });

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

app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file');

  const fileExt = path.extname(req.file.originalname);
  const fileName = `${Date.now()}_${Math.random().toString(36).substring(2)}${fileExt}`;
  const filePath = req.file.path;
  const fileBuffer = fs.readFileSync(filePath);

  const { error } = await supabase.storage.from(BUCKET).upload(fileName, fileBuffer, {
    contentType: req.file.mimetype,
    upsert: false
  });
  fs.unlinkSync(filePath);

  if (error) return res.status(500).send('Upload error');

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
  res.status(200).json({ url: data.publicUrl });
});

const clients = new Map();
const activeMessages = new Map();

wss.on('connection', (ws) => {
  let userData = { nick: '', id: '', room: '' };

  ws.on('message', async (msg) => {
    const data = JSON.parse(msg);
    const now = new Date().toISOString();
    const room = userData.room;

    if (data.type === 'join') {
      userData.nick = data.user;
      userData.id = data.id || 'guest_' + Math.random().toString(36).substring(7);
      userData.room = data.room || 'general';
      clients.set(ws, userData);

      await supabase.from('messages').insert({
        room: userData.room,
        user: 'system',
        text: `${userData.nick} joined`,
        image_url: '',
        timestamp: now
      });

      broadcast(userData.room, {
        type: 'system',
        text: `${userData.nick} joined`,
        timestamp: now
      });

      await deleteOldMessages(userData.room);

      const { data: history } = await supabase
        .from('messages')
        .select('*')
        .eq('room', userData.room)
        .order('timestamp', { ascending: true });

      history.forEach(m => {
        ws.send(JSON.stringify({
          type: m.image_url ? 'image' : 'message',
          text: m.text,
          image: m.image_url,
          user: m.user,
          timestamp: m.timestamp
        }));
      });
      return;
    }

    if (data.type === 'message') {
      const message = {
        room,
        user: userData.nick,
        text: data.text,
        image_url: '',
        timestamp: now
      };
      await supabase.from('messages').insert(message);
      broadcast(room, { type: 'message', text: data.text, user: userData.nick, timestamp: now });
      activeMessages.set(room, true);
    }

    if (data.type === 'image') {
      const message = {
        room,
        user: userData.nick,
        text: data.text || '',
        image_url: data.image,
        timestamp: now
      };
      await supabase.from('messages').insert(message);
      broadcast(room, { type: 'image', text: data.text, image: data.image, user: userData.nick, timestamp: now });
      activeMessages.set(room, true);
    }
  });

  ws.on('close', async () => {
    clients.delete(ws);
    const room = userData.room;

    // 👉 Системное сообщение о выходе
    if (userData.nick && room) {
      const leaveTime = new Date().toISOString();
      await supabase.from('messages').insert({
        room: room,
        user: 'system',
        text: `${userData.nick} left`,
        image_url: '',
        timestamp: leaveTime
      });
      broadcast(room, {
        type: 'system',
        text: `${userData.nick} left`,
        timestamp: leaveTime
      });
    }

    const stillInRoom = Array.from(clients.values()).some(u => u.room === room);

    if (!stillInRoom && activeMessages.get(room)) {
      const { data: logs } = await supabase
        .from('messages')
        .select('*')
        .eq('room', room)
        .order('timestamp');

      const logText = logs.map(m => `${m.timestamp} — ${m.user}: ${m.text || '[image]'}`).join('\n');
      sendEmail(`Chat room "${room}" is now empty.\n\nMessages:\n${logText}`);
      activeMessages.delete(room);
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
    subject: 'ChaosNet: chat log on empty room',
    text: content
  };

  transporter.sendMail(mailOptions, (err, info) => {
    if (err) console.error('Email error:', err);
    else console.log('Email sent:', info.response);
  });
}

async function deleteOldMessages(room) {
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const { data: oldMessages } = await supabase
    .from('messages')
    .select('id')
    .lt('timestamp', fifteenDaysAgo)
    .eq('room', room);

  if (oldMessages && oldMessages.length > 0) {
    const idsToDelete = oldMessages.map(m => m.id);
    await supabase.from('messages').delete().in('id', idsToDelete);
    console.log(`Deleted ${idsToDelete.length} old messages in room ${room}`);
  }
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
