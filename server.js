const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const PORT = process.env.PORT || 10000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_KEY; // anon (public) key
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY; // prefer service role

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
const BUCKET = 'chat-uploads';
const AVATARS_BUCKET = 'avatars';

app.use(express.static('public'));
app.use(express.json());

const upload = multer({ dest: 'temp_uploads/' });



app.post('/register', async (req, res) => {
  const { id, nick, password } = req.body;

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
  const { id, password } = req.body;
  if (!id || !password) {
    return res.status(400).send("ID and password required");
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('password', password)
      .maybeSingle();

    if (error) {
      console.error('Auth error:', error.message);
      return res.status(500).send("Server error");
    }
    if (!user) return res.status(401).send("Unauthorized");
    return res.status(200).send("OK");
  } catch (e) {
    console.error('Unexpected auth error:', e);
    return res.status(500).send("Server error");
  }
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


app.post('/check-subscription', async (req, res) => {
  const { id } = req.body;

  if (!id) return res.status(400).json({ subscription: false });

  try {
    const { data, error } = await supabase
      .from('users')
      .select('Subscription')
      .eq('id', id)
      .limit(1)
      .single();

    if (error || !data) {
      console.error("Supabase subscription check error:", error?.message || "No data");
      return res.status(500).json({ subscription: false });
    }

    return res.status(200).json({ subscription: data.Subscription === true });
  } catch (err) {
    console.error("Unexpected error during subscription check:", err);
    return res.status(500).json({ subscription: false });
  }
});

app.post('/get-user', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'No id provided' });

  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, nick, password, AdminStatus, Subscription, avatar')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('Supabase get-user error:', error.message);
      return res.status(500).json({ error: 'Server error' });
    }
    if (!data) return res.status(404).json({ error: 'User not found' });

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error in /get-user:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/update-user', async (req, res) => {
  const { id, password } = req.body;

  if (!id || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid data' });
  }
  if (password.length > 128) {
    return res.status(400).json({ error: 'Password too long' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .update({ password })
      .eq('id', id)
      .select('id, nick, password, AdminStatus, Subscription')
      .maybeSingle();

    if (error) {
      console.error('Supabase update-user error:', error.message);
      return res.status(500).json({ error: 'Server error' });
    }
    if (!data) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error in /update-user:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/delete-user', async (req, res) => {
  const { id, password } = req.body;
  if (!id || typeof password !== 'string') {
    return res.status(400).json({ error: 'ID and password required' });
  }
  try {
    // Verify ownership
    const { data: user, error: selErr } = await supabase
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('password', password)
      .maybeSingle();
    if (selErr) {
      console.error('Delete-user select error:', selErr.message);
      return res.status(500).json({ error: 'Server error' });
    }
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Best-effort: remove possible avatar files from both buckets
    try {
      const names = [`${id}.jpg`, `${id}.png`, `${id}.webp`];
      await Promise.all(
        names.flatMap(n => [
          supabase.storage.from(AVATARS_BUCKET).remove([n]).catch(() => null),
          supabase.storage.from(BUCKET).remove([n]).catch(() => null)
        ])
      );
    } catch(_) {}

    // Delete user row
    const { error: delErr } = await supabase
      .from('users')
      .delete()
      .eq('id', id);
    if (delErr) {
      console.error('Delete-user DB error:', delErr.message);
      return res.status(500).json({ error: 'Failed to delete user' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Unexpected delete-user error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Avatar upload/remove ----------
app.post('/avatar/upload', upload.single('avatar'), async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'No id' });
  if (!req.file) return res.status(400).json({ error: 'No file' });

  try {
    const mime = req.file.mimetype || '';
    const allowed = new Set(['image/png','image/jpeg','image/webp']);
    if (!allowed.has(mime)) {
      fs.unlink(req.file.path, () => {});
      return res.status(415).json({ error: 'Only png/jpeg/webp' });
    }

    // size limit by subscription
    const { data: userRow } = await supabase.from('users').select('Subscription').eq('id', id).maybeSingle();
    const limit = (userRow?.Subscription === true) ? 7*1024*1024 : 2*1024*1024;
    if (req.file.size > limit) {
      fs.unlink(req.file.path, () => {});
      return res.status(413).json({ error: `Too large. Max ${userRow?.Subscription === true ? '7MB' : '2MB'}` });
    }

    // determine extension
    const ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
    const objectName = `${id}.${ext}`;

    const buffer = fs.readFileSync(req.file.path);
    let targetBucket = AVATARS_BUCKET;
    let upErr = null;
    try {
      // Try avatars bucket first
      let { error } = await supabase
        .storage.from(targetBucket)
        .upload(objectName, buffer, { contentType: mime, upsert: true, cacheControl: '3600' });
      upErr = error || null;

      // Fallback to the main uploads bucket if avatars bucket does not exist
      if (upErr && /bucket not found|not found/i.test(String(upErr.message))) {
        targetBucket = BUCKET; // typically 'chat-uploads'
        const res2 = await supabase
          .storage.from(targetBucket)
          .upload(objectName, buffer, { contentType: mime, upsert: true, cacheControl: '3600' });
        upErr = res2.error || null;
      }
    } finally {
      fs.unlink(req.file.path, () => {});
    }

    if (upErr) {
      console.error('avatar upload error:', upErr.message);
      return res.status(500).json({ error: 'Upload failed', details: upErr.message });
    }

    const { data: pub } = supabase.storage.from(targetBucket).getPublicUrl(objectName);
    const publicUrl = pub.publicUrl;

    const { data: updated, error: updErr } = await supabase
      .from('users')
      .update({ avatar: publicUrl })
      .eq('id', id)
      .select('id, nick, password, AdminStatus, Subscription, avatar')
      .maybeSingle();
    if (updErr) {
      console.error('avatar db update error:', updErr.message);
      return res.status(500).json({ error: 'DB update failed' });
    }

    return res.status(200).json(updated);
  } catch (e) {
    console.error('avatar upload exception:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/avatar/remove', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'No id' });
  try {
    // try removing all common extensions
    const names = [`${id}.jpg`, `${id}.png`, `${id}.webp`];
    await Promise.all(
      names.flatMap(n => [
        supabase.storage.from(AVATARS_BUCKET).remove([n]).catch(() => null),
        supabase.storage.from(BUCKET).remove([n]).catch(() => null)
      ])
    );

    const { data, error } = await supabase
      .from('users')
      .update({ avatar: null })
      .eq('id', id)
      .select('id, nick, password, AdminStatus, Subscription, avatar')
      .maybeSingle();
    if (error) {
      console.error('avatar remove db error:', error.message);
      return res.status(500).json({ error: 'DB update failed' });
    }
    return res.status(200).json(data);
  } catch (e) {
    console.error('avatar remove exception:', e);
    return res.status(500).json({ error: 'Server error' });
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
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('nick', nick);

    if (error) return res.status(500).send("Failed to delete user");
    return res.status(200).send(`${nick} has been deleted`);
  }

  if (giveMatch) {
    const nick = giveMatch[1];
    const { error, data } = await supabase
      .from('users')
      .update({ AdminStatus: true })
      .eq('nick', nick);

    if (error) return res.status(500).send("Failed to give admin");
    return res.status(200).send(`${nick} is now admin`);
  }

  if (takeMatch) {
    const nick = takeMatch[1];
    const { error, data } = await supabase
      .from('users')
      .update({ AdminStatus: false })
      .eq('nick', nick);

    if (error) return res.status(500).send("Failed to remove admin");
    return res.status(200).send(`${nick} is no longer admin`);
  }

  return res.status(400).send("Invalid command");
});


app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file');

  const fileExt = path.extname(req.file.originalname);
  const fileName = `${Date.now()}_${Math.random().toString(36).substring(2)}${fileExt}`;
  const filePath = req.file.path;
  const fileBuffer = fs.readFileSync(filePath);

  const { error } = await supabase.storage.from(BUCKET).upload(fileName, fileBuffer, {
    contentType: req.file.mimetype || 'application/octet-stream',
    upsert: false
  });
  fs.unlinkSync(filePath);

  if (error) return res.status(500).send('Upload error');

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
  res.status(200).json({ url: data.publicUrl });
});

// Download image from Supabase Storage
app.get('/download', async (req, res) => {
  const { filename } = req.query;
  if (!filename) return res.status(400).send('No filename provided');

  try {
    const { data, error } = await supabase
      .storage
      .from(BUCKET)
      .download(filename);

    if (error || !data) {
      console.error("Download error:", error?.message);
      return res.status(404).send('File not found');
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    data.pipe(res);
  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).send('Internal server error');
  }
});

const clients = new Map();
const activeMessages = new Map();

function base64Size(b64) {
  if (!b64 || typeof b64 !== 'string') return 0;
  const idx = b64.indexOf(',');
  const raw = idx >= 0 ? b64.slice(idx + 1) : b64;
  // 3/4 rule minus padding
  let size = Math.floor(raw.length * 3 / 4);
  if (raw.endsWith('==')) size -= 2;
  else if (raw.endsWith('=')) size -= 1;
  return size;
}

function normalizeIncomingType(t, media) {
  const allowed = new Set(['image', 'video', 'audio', 'file']);
  if (allowed.has(t)) return t;
  return inferTypeFromData(media);
}

function inferTypeFromData(media) {
  if (!media) return 'message';
  if (typeof media !== 'string') return 'file';
  const head = media.slice(0, 40).toLowerCase();
  if (head.startsWith('data:image')) return 'image';
  if (head.startsWith('data:video')) return 'video';
  if (head.startsWith('data:audio')) return 'audio';
  // If it's a URL without data URI, treat as a generic file
  return 'file';
}

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
        const inferredType = inferTypeFromData(m.image_url);
        ws.send(JSON.stringify({
          type: inferredType,
          text: m.text,
          image: m.image_url,
          filename: m.filename || undefined,
          user: m.user,
          timestamp: m.timestamp
        }));
      });
      // Broadcast join message
      broadcast(userData.room, {
        type: 'join',
        user: userData.nick,
        timestamp: now
      });
      await supabase.from('messages').insert({
        room: userData.room,
        user: 'system',
        text: `${userData.nick} joined`,
        image_url: '',
        timestamp: now
      });
      return;
    }

    if (data.type === 'message') {
      // Subscription check and message length limit for non-subscribed users
      if (!userData.id.startsWith('guest_')) {
        const { data: userDataSub } = await supabase
          .from('users')
          .select('Subscription')
          .eq('id', userData.id)
          .maybeSingle();

        const isSubscribed = userDataSub?.Subscription === true;

        if (!isSubscribed && data.text && data.text.length > 444) {
          ws.send(JSON.stringify({ type: 'error', text: 'Message too long for non-subscribed users.' }));
          return;
        }
      }
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

    const incomingType = normalizeIncomingType(data.type, data.image);
    if (['image', 'video', 'audio', 'file'].includes(incomingType)) {
      if (!data.image && !Array.isArray(data.images)) {
        ws.send(JSON.stringify({ type: 'error', text: 'No media provided.' }));
        return;
      }
      if (!userData.id.startsWith('guest_')) {
        const { data: userDataSub } = await supabase
          .from('users')
          .select('Subscription')
          .eq('id', userData.id)
          .maybeSingle();

        const isSubscribed = userDataSub?.Subscription === true;

        const maxSizeBytes = 30 * 1024 * 1024; // 30MB limit for video/audio/any files
        const base64Length = base64Size(data.image);
        if (base64Length > maxSizeBytes) {
          ws.send(JSON.stringify({ type: 'error', text: `File too large. Max size is 30MB.` }));
          return;
        }
      } else {
        // For guests, treat as non-subscribed
        const maxSizeBytes = 30 * 1024 * 1024; // 30MB limit for video/audio/any files
        const base64Length = base64Size(data.image);
        if (base64Length > maxSizeBytes) {
          ws.send(JSON.stringify({ type: 'error', text: 'File too large. Max size is 30MB.' }));
          return;
        }
      }

      const files = Array.isArray(data.images)
        ? data.images
        : [{ image: data.image, filename: data.filename }];
      for (const file of files) {
        const message = {
          room,
          user: userData.nick,
          text: data.text || '',
          image_url: file.image,
          timestamp: now
        };
        await supabase.from('messages').insert(message);
        broadcast(room, {
          type: incomingType,
          text: data.text,
          image: file.image,
          filename: file.filename,
          user: userData.nick,
          timestamp: now
        });
      }
      activeMessages.set(room, true);
    }
  });

  ws.on('close', async () => {
    const now = new Date().toISOString();
    broadcast(userData.room, {
      type: 'leave',
      user: userData.nick,
      timestamp: now
    });
    await supabase.from('messages').insert({
      room: userData.room,
      user: 'system',
      text: `${userData.nick} left`,
      image_url: '',
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

      const logText = logs.map(m => `${m.timestamp} — ${m.user}: ${m.text || '[attachment]'}`).join('\n');
      // sendEmail(`Chat room "${room}" is now empty.\n\nMessages:\n${logText}`);
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

// function sendEmail(content) {
//   const transporter = nodemailer.createTransport({
//     service: 'gmail',
//     auth: {
//       user: process.env.EMAIL_USER,
//       pass: process.env.EMAIL_PASSWORD
//     }
//   });
//
//   const mailOptions = {
//     from: process.env.EMAIL_USER,
//     to: process.env.EMAIL_USER,
//     subject: 'ChaosNet: chat log on empty room',
//     text: content
//   };
//
//   transporter.sendMail(mailOptions, (err, info) => {
//     if (err) console.error('Email error:', err);
//     else console.log('Email sent:', info.response);
//   });
// }

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
