const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const crypto = require("crypto");
require('dotenv').config();

const PORT = process.env.PORT || 10000;
const app = express();

app.use(cors({ origin: 'https://chaosnet.onrender.com' })); // замените на реальный домен

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const BUCKET = 'chat-uploads';

app.use(express.static('public'));
app.use(express.json());
app.use(helmet());
app.disable('x-powered-by');

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 минута
  max: 10, // максимум 10 запросов
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/auth", limiter);
app.use("/register", limiter);
app.use("/admin-action", limiter);

const upload = multer({ dest: 'temp_uploads/' });


app.post('/register', async (req, res) => {
  const { id, nick, password } = req.body;

  if (typeof nick !== 'string' || nick.length < 3 || nick.length > 30 || /[^a-zA-Z0-9_]/.test(nick)) {
    return res.status(400).send("Invalid nickname");
  }
  if (typeof password !== 'string' || password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).send("Password must be at least 8 chars with numbers and uppercase letters");
  }

  if (!id || !nick || !password) {
    return res.status(400).send("All fields required");
  }

  // Check if nickname already taken
  const { data: existingNick } = await supabase
    .from('users')
    .select('nick')
    .eq('nick', nick)
    .maybeSingle();

  if (existingNick) return res.status(409).send("Nickname already taken");

  const { data: existing, error: fetchError } = await supabase
    .from('users')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) return res.status(500).send("Error checking existing user");
  if (existing) return res.status(409).send("User already exists");

  const { error } = await supabase
    .from('users')
    .insert({ id, nick, password });

  if (error) return res.status(500).send("Error creating user");
  res.status(201).send("User registered");
});


app.post('/auth', async (req, res) => {
  const { id, nick, password } = req.body;

  if (typeof nick !== 'string' || nick.length < 3 || nick.length > 30 || /[^a-zA-Z0-9_]/.test(nick)) {
    return res.status(400).send("Invalid nickname");
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).send("Password too weak");
  }

  const { data: users, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .eq('nick', nick)
    .eq('password', password)
    .maybeSingle();

  if (error) return res.status(500).send("Server error");
  if (!users) return res.status(401).send("Unauthorized");
  res.status(200).send("OK");
});

app.post('/check-admin', async (req, res) => {
  const { id } = req.body;

  if (!id) return res.status(400).json({ admin: false });

  try {
    const { data, error } = await supabase
      .from('users')
      .select('AdminStatus')
      .eq('id', id)
      .limit(1)
      .single();

    if (error || !data) {
      console.error("Supabase admin check error:", error?.message || "No data");
      return res.status(500).json({ admin: false });
    }

    return res.status(200).json({ admin: data.AdminStatus === true });
  } catch (err) {
    console.error("Unexpected error during admin check:", err);
    return res.status(500).json({ admin: false });
  }
});

app.post('/set-admin', async (req, res) => {
  const { nick, isAdmin } = req.body;

  if (!nick || typeof isAdmin !== 'boolean') {
    return res.status(400).send("Invalid data");
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .update({ AdminStatus: isAdmin })
      .eq('nick', nick)
      .select();
    if (error) {
      console.error("Error updating admin status:", error.message);
      return res.status(500).send("Failed to update admin status");
    }

    if (!data || data.length === 0) {
      console.error("No matching user found to update admin status.");
      return res.status(404).send("User not found");
    }

    res.status(200).send(`Admin status ${isAdmin ? "granted to" : "removed from"} ${nick}`);
  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).send("Server error");
  }
});

app.get('/active-rooms', (req, res) => {
  const uniqueRooms = new Set();
  for (const client of clients.values()) {
    if (client.room) {
      uniqueRooms.add(client.room);
    }
  }
  res.json({ rooms: Array.from(uniqueRooms) });
});

app.post('/admin-action', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).send("No command provided");

  const giveMatch = command.match(/^\/give admin (\w+)$/i);
  const takeMatch = command.match(/^\/take admin (\w+)$/i);

  // /kill <nick> command
  const killMatch = command.match(/^\/kill (\w+)$/i);
  if (killMatch) {
    const nick = killMatch[1];
    if (nick.length < 3 || nick.length > 30 || /[^a-zA-Z0-9_]/.test(nick)) {
      return res.status(400).send("Invalid nickname");
    }
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('nick', nick);

    if (error) return res.status(500).send("Failed to delete user");
    return res.status(200).send(`${nick} has been deleted`);
  }

  if (giveMatch) {
    const nick = giveMatch[1];
    if (nick.length < 3 || nick.length > 30 || /[^a-zA-Z0-9_]/.test(nick)) {
      return res.status(400).send("Invalid nickname");
    }
    const { error, data } = await supabase
      .from('users')
      .update({ AdminStatus: true })
      .eq('nick', nick);

    if (error) return res.status(500).send("Failed to give admin");
    return res.status(200).send(`${nick} is now admin`);
  }

  if (takeMatch) {
    const nick = takeMatch[1];
    if (nick.length < 3 || nick.length > 30 || /[^a-zA-Z0-9_]/.test(nick)) {
      return res.status(400).send("Invalid nickname");
    }
    const { error, data } = await supabase
      .from('users')
      .update({ AdminStatus: false })
      .eq('nick', nick);

    if (error) return res.status(500).send("Failed to remove admin");
    return res.status(200).send(`${nick} is no longer admin`);
  }

  return res.status(400).send("Invalid command");
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

    if (data.type === 'activeRoom') {
      userData.room = data.room;
      clients.set(ws, userData);
      return;
    }

    if (data.type === 'join') {
      userData.nick = data.user;
      userData.id = data.id || 'guest_' + Math.random().toString(36).substring(7);
      userData.room = data.room || 'general';
      clients.set(ws, userData);

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
      // Save system join message
      await supabase.from('messages').insert({
        room: userData.room,
        user: 'system',
        text: `${userData.nick} joined`,
        image_url: '',
        timestamp: now
      });
      // Broadcast join message
      broadcast(userData.room, {
        type: 'join',
        user: userData.nick,
        timestamp: now
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
    const now = new Date().toISOString();
    // Save system leave message
    await supabase.from('messages').insert({
      room: userData.room,
      user: 'system',
      text: `${userData.nick} left`,
      image_url: '',
      timestamp: now
    });
    broadcast(userData.room, {
      type: 'leave',
      user: userData.nick,
      timestamp: now
    });
    clients.delete(ws);
    const room = userData.room;

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
      try {
        client.send(json);
      } catch (err) {
        console.error("WebSocket send error:", err);
      }
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
    text: encryptMessage(content)
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

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data:;");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

function encryptMessage(message) {
  const cipher = crypto.createCipher('aes-256-cbc', process.env.ENCRYPT_KEY || 'default_key_123456789012345678901234');
  let encrypted = cipher.update(message, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}
