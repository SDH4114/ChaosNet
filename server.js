const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const { randomBytes, createCipheriv, createDecipheriv } = require('crypto');
require('dotenv').config();

const PORT = process.env.PORT || 10000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const BUCKET = 'chat-Uploads';
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
const SALT_ROUNDS = 10;

// Create temp_uploads directory
const TEMP_UPLOADS_DIR = 'temp_uploads';
fs.mkdir(TEMP_UPLOADS_DIR, { recursive: true }).catch(err => console.error('Error creating temp_uploads:', err));

// Security
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || 'https://chaosnet.onrender.com/login.html' }));
app.use(express.static('public'));
app.use(express.json());

// Rate limiting
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many login attempts' });
app.use('/auth', authLimiter);
app.use('/register', authLimiter);

// Multer setup
const upload = multer({ dest: TEMP_UPLOADS_DIR });

// Validate ID format
const validateIdFormat = (id) => /^[A-Z]{2}\d{4}$/.test(id);

// Registration
app.post('/register', async (req, res) => {
  const { id, nick, password } = req.body;
  if (!id || !nick || !password) return res.status(400).send('All fields required');
  if (!validateIdFormat(id)) return res.status(400).send('ID must be AA0000');
  if (!validator.isLength(nick, { min: 3, max: 20 }) || !validator.isAlphanumeric(nick, 'en-US', { ignore: '_' }))
    return res.status(400).send('Nickname: 3-20 chars, letters/numbers/_');
  if (!validator.isLength(password, { min: 8 })) return res.status(400).send('Password min 8 chars');

  try {
    const { data: existingNick } = await supabase.from('users').select('nick').eq('nick', nick).maybeSingle();
    if (existingNick) return res.status(409).send('Nickname taken');
    const { data: existingId } = await supabase.from('users').select('id').eq('id', id).maybeSingle();
    if (existingId) return res.status(409).send('ID taken');
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const { error } = await supabase.from('users').insert({ id, nick, password: hashedPassword, AdminStatus: false });
    if (error) return res.status(500).send('Error creating user');
    res.status(201).send('User registered');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Authentication
app.post('/auth', async (req, res) => {
  const { id, nick, password } = req.body;
  if (!id || !nick || !password) return res.status(400).send('All fields required');
  if (!validateIdFormat(id)) return res.status(400).send('ID must be AA0000');

  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('id', id).eq('nick', nick).maybeSingle();
    if (error) return res.status(500).send('Server error');
    if (!user) return res.status(401).send('Invalid credentials');
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).send('Invalid credentials');
    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Check admin status
app.post('/check-admin', async (req, res) => {
  const { id } = req.body;
  if (!id || !validateIdFormat(id)) return res.status(400).json({ admin: false });

  try {
    const { data, error } = await supabase.from('users').select('AdminStatus').eq('id', id).maybeSingle();
    if (error || !data) return res.status(404).json({ admin: false });
    res.status(200).json({ admin: data.AdminStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ admin: false });
  }
});

// Set admin status
app.post('/set-admin', async (req, res) => {
  const { nick, isAdmin } = req.body;
  if (!nick || typeof isAdmin !== 'boolean') return res.status(400).send('Invalid data');

  try {
    const { data, error } = await supabase.from('users').update({ AdminStatus: isAdmin }).eq('nick', nick).select();
    if (error) return res.status(500).send('Failed to update admin');
    if (!data?.length) return res.status(404).send('User not found');
    res.status(200).send(`Admin ${isAdmin ? 'granted to' : 'removed from'} ${nick}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Get active rooms
app.get('/active-rooms', (req, res) => {
  const uniqueRooms = new Set(clients.values().filter(c => c.room).map(c => c.room));
  res.json({ rooms: [...uniqueRooms] });
});

// Admin actions
app.post('/admin-action', async (req, res) => {
  const { command } = req.body;
  if (!command || !validator.isLength(command, { min: 1, max: 100 })) return res.status(400).send('Invalid command');

  const giveMatch = command.match(/^\/give admin (\w+)$/i);
  const takeMatch = command.match(/^\/take admin (\w+)$/i);
  const killMatch = command.match(/^\/kill (\w+)$/i);

  try {
    if (killMatch) {
      const nick = killMatch[1];
      const { error } = await supabase.from('users').delete().eq('nick', nick);
      return error ? res.status(500).send('Failed to delete') : res.status(200).send(`${nick} deleted`);
    }
    if (giveMatch) {
      const nick = giveMatch[1];
      const { error } = await supabase.from('users').update({ AdminStatus: true }).eq('nick', nick);
      return error ? res.status(500).send('Failed to grant') : res.status(200).send(`${nick} is admin`);
    }
    if (takeMatch) {
      const nick = takeMatch[1];
      const { error } = await supabase.from('users').update({ AdminStatus: false }).eq('nick', nick);
      return error ? res.status(500).send('Failed to remove') : res.status(200).send(`${nick} no longer admin`);
    }
    return res.status(400).send('Invalid command');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Upload images
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');

  try {
    const fileExt = path.extname(req.file.originalname);
    const fileName = `${Date.now()}_${Math.random().toString(36).substring(2)}${fileExt}`;
    const filePath = path.join(TEMP_UPLOADS_DIR, req.file.filename);
    const fileBuffer = await fs.readFile(filePath);

    const { error } = await supabase.storage.from(BUCKET).upload(fileName, fileBuffer, { contentType: req.file.mimetype, upsert: false });
    await fs.unlink(filePath).catch(err => console.error('Temp file delete error:', err));

    if (error) return res.status(500).send('Upload error');
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
    res.status(200).json({ url: data.publicUrl });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Encrypt and decrypt messages
function encryptMessage(message) {
  if (!message) return { encrypted: '', iv: '' };
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(message, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { encrypted, iv: iv.toString('hex') };
}

function decryptMessage(encrypted, iv) {
  if (!encrypted || !iv) return '';
  try {
    const decipher = createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(iv, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return '[Decryption error]';
  }
}

const clients = new Map();
const activeMessages = new Map();

wss.on('connection', (ws) => {
  let userData = { nick: '', id: '', room: '' };

  ws.on('message', async (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }
    const now = new Date().toISOString();
    const room = userData.room || data.room || 'general';

    if (data.type === 'activeRoom') { userData.room = validator.escape(data.room || 'general'); clients.set(ws, userData); return; }
    if (data.type === 'join') {
      userData.nick = validator.escape(data.user || 'guest');
      userData.id = validator.escape(data.id || `guest_${Math.random().toString(36).substring(7)}`);
      userData.room = validator.escape(data.room || 'general');
      clients.set(ws, userData);
      await deleteOldMessages(userData.room);
      const { data: history, error } = await supabase.from('messages').select('*').eq('room', userData.room).order('timestamp');
      if (!error) history.forEach(m => ws.send(JSON.stringify({ type: m.image_url ? 'image' : 'message', text: m.text ? decryptMessage(m.text, m.iv) : '', image: m.image_url, user: m.user, timestamp: m.timestamp })));
      broadcast(userData.room, { type: 'join', user: userData.nick, timestamp: now });
      return;
    }
    if (data.type === 'message') {
      const cleanText = validator.escape(data.text || '');
      const { encrypted, iv } = encryptMessage(cleanText);
      const { error } = await supabase.from('messages').insert({ room, user: userData.nick, text: encrypted, iv, image_url: '', timestamp: now });
      if (!error) { broadcast(room, { type: 'message', text: cleanText, user: userData.nick, timestamp: now }); activeMessages.set(room, true); }
    }
    if (data.type === 'image') {
      const cleanText = data.text ? validator.escape(data.text) : '';
      const { encrypted, iv } = cleanText ? encryptMessage(cleanText) : { encrypted: '', iv: '' };
      const { error } = await supabase.from('messages').insert({ room, user: userData.nick, text: encrypted, iv, image_url: data.image, timestamp: now });
      if (!error) { broadcast(room, { type: 'image', text: cleanText, image: data.image, user: userData.nick, timestamp: now }); activeMessages.set(room, true); }
    }
    if (data.type === 'requestUserList') {
      const users = [...clients.values()].filter(u => u.room === data.room).map(u => u.nick);
      ws.send(JSON.stringify({ type: 'userlist', users }));
    }
  });

  ws.on('close', async () => {
    if (userData.nick && userData.room) broadcast(userData.room, { type: 'leave', user: userData.nick, timestamp: new Date().toISOString() });
    clients.delete(ws);
    const room = userData.room;
    if (![...clients.values()].some(u => u.room === room) && activeMessages.get(room)) {
      const { data: logs, error } = await supabase.from('messages').select('*').eq('room', room).order('timestamp');
      if (!error) {
        const logText = logs.map(m => `${m.timestamp} — ${m.user}: ${m.text ? decryptMessage(m.text, m.iv) : '[image]'}`).join('\n');
        await sendEmail(`Chat room "${room}" empty.\n\nMessages:\n${logText}`);
      }
      activeMessages.delete(room);
    }
  });
});

function broadcast(room, data) {
  const json = JSON.stringify(data);
  for (const [client, u] of clients) if (u.room === room && client.readyState === WebSocket.OPEN) client.send(json);
}

async function sendEmail(content) {
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD } });
  await transporter.sendMail({ from: process.env.EMAIL_USER, to: process.env.EMAIL_USER, subject: 'ChaosNet: Chat log', text: content }).catch(console.error);
}

async function deleteOldMessages(room) {
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const { data: oldMessages, error } = await supabase.from('messages').select('id').lt('timestamp', fifteenDaysAgo).eq('room', room);
  if (!error && oldMessages?.length) await supabase.from('messages').delete().in('id', oldMessages.map(m => m.id)).then(() => console.log(`Deleted ${oldMessages.length} messages in ${room}`)).catch(console.error);
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));