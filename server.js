const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const webpush = require('web-push');
// --- Web Push (VAPID) ---
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
  console.warn('VAPID keys/subject missing in .env (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT)');
} else {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const PORT = process.env.PORT || 10000;
const app = express();
// Body parsers MUST be before route handlers
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
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

// --- Push subscriptions storage helpers (Supabase) ---
async function upsertSubscription({ endpoint, p256dh, auth, room, user_id, nick }) {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .upsert(
      { endpoint, p256dh, auth, room, user_id, nick },
      { onConflict: 'endpoint,room' }
    )
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function removeSubscriptionForRoom(endpoint, room) {
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('room', room);
}

async function removeSubscription(endpoint) {
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

async function listRoomSubscriptions(room, excludeUserId) {
  let q = supabase.from('push_subscriptions').select('endpoint,p256dh,auth,user_id,room');
  if (room) q = q.eq('room', room);
  if (excludeUserId) q = q.neq('user_id', excludeUserId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// --- HTTP endpoints for push subscribe/unsubscribe/test/health ---
app.post('/push/subscribe', async (req, res) => {
  try {
    console.log('SUBSCRIBE body:', req.body);
    const { subscription, room, rooms, userId, nick } = req.body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys.p256dh;
    const auth = subscription.keys.auth;

    const roomsToSave = Array.isArray(rooms) && rooms.length ? rooms : [room || 'main'];

    for (const r of roomsToSave) {
      await upsertSubscription({
        endpoint,
        p256dh,
        auth,
        room: String(r || 'main'),
        user_id: userId || null,
        nick: nick || null
      });
    }

    return res.status(200).json({ ok: true, saved: roomsToSave.length });
  } catch (e) {
    console.error('subscribe error:', e.message || e);
    return res.status(500).json({ error: 'subscribe failed' });
  }
});

app.post('/push/subscribe-many', async (req, res) => {
  try {
    const { subscription, rooms, userId, nick } = req.body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    if (!Array.isArray(rooms) || rooms.length === 0) {
      return res.status(400).json({ error: 'No rooms provided' });
    }
    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys.p256dh;
    const auth = subscription.keys.auth;

    for (const r of rooms) {
      await upsertSubscription({
        endpoint,
        p256dh,
        auth,
        room: String(r || 'main'),
        user_id: userId || null,
        nick: nick || null
      });
    }
    return res.status(200).json({ ok: true, saved: rooms.length });
  } catch (e) {
    console.error('subscribe-many error:', e.message || e);
    return res.status(500).json({ error: 'subscribe-many failed' });
  }
});

app.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint, room } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'No endpoint' });
    if (room) {
      await removeSubscriptionForRoom(endpoint, String(room));
    } else {
      await removeSubscription(endpoint);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('unsubscribe error:', e.message || e);
    return res.status(500).json({ error: 'unsubscribe failed' });
  }
});

app.post('/push/test', async (req, res) => {
  try {
    const { room, title, body } = req.body || {};
    await sendPushToRoom(room || 'main', { title: title || 'ChaosNet test', body: body || 'It works!' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('push test error:', e.message || e);
    return res.status(500).json({ error: 'test failed' });
  }
});

// List rooms by userId, nick, or endpoint from push_subscriptions (fallbacks supported)
app.get('/push/list', async (req, res) => {
  try {
    const userId   = (req.query.userId || '').trim();
    const nick     = (req.query.nick || '').trim();
    const endpoint = (req.query.endpoint || '').trim();

    const rooms = new Set();

    async function addRoomsBy(filter) {
      const { data, error } = await supabase
        .from('push_subscriptions')
        .select('room')
        .match(filter);
      if (!error && Array.isArray(data)) {
        for (const r of data) {
          const v = String(r.room || '').trim();
          if (v) rooms.add(v);
        }
      }
    }

    if (userId) await addRoomsBy({ user_id: userId });
    if (rooms.size === 0 && nick) await addRoomsBy({ nick });
    if (rooms.size === 0 && endpoint) await addRoomsBy({ endpoint });

    return res.json({ rooms: Array.from(rooms) });
  } catch (e) {
    console.error('push/list exception:', e);
    return res.status(500).json({ rooms: [] });
  }
});

// Quick reply endpoint: accepts text and posts it into a room, then notifies subscribers
app.get('/push/health', (req, res) => {
  res.json({ vapidConfigured: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) });
});

async function sendPushToRoom(room, payload, excludeUserId) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = await listRoomSubscriptions(room, excludeUserId);
  const tasks = subs.map(async (row) => {
    const sub = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth }
    };
    const data = Object.assign(
      { title: 'ChaosNet', body: 'New message', icon: '/img/ChaosNetLogo.png', tag: `room:${room}` },
      payload || {},
      { data: { room } }
    );
    try {
      await webpush.sendNotification(sub, JSON.stringify(data));
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try { await removeSubscription(row.endpoint); } catch(_) {}
      } else {
        console.warn('sendNotification error:', err.statusCode, err.body || err.message);
      }
    }
  });
  await Promise.allSettled(tasks);
}

// --- Feature flags ---
// Suppress system join/leave messages on the server (still hidden on client anyway).
// Set SUPPRESS_SYSTEM_MESSAGES=0 in .env if you want them back.
const SUPPRESS_SYSTEM_MESSAGES = process.env.SUPPRESS_SYSTEM_MESSAGES === '0' ? false : true;

// Lightweight env injection for static HTML: replaces [[VAPID_PUBLIC_KEY_REPLACED_AT_RUNTIME]]
app.get(['/', '/index.html', '/chat.html', '/select.html'], (req, res, next) => {
  const p = req.path === '/' ? '/index.html' : req.path;
  const full = path.join(__dirname, 'public', p.replace(/^\//,''));
  fs.readFile(full, 'utf8', (err, txt) => {
    if (err) return next();
    const out = txt.replace(/\[\[VAPID_PUBLIC_KEY_REPLACED_AT_RUNTIME\]\]/g, process.env.VAPID_PUBLIC_KEY || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(out);
  });
});

// Dynamically serve a Service Worker at /sw.js
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { self.clients.claim(); });

/* ===== IndexedDB для счётчиков непрочитанных ===== */
const DB_NAME = 'chaosnet-unread';
const STORE = 'rooms';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const st = tx.objectStore(STORE);
    const g = st.get(key);
    g.onsuccess = () => resolve(g.result || 0);
    g.onerror = () => reject(g.error);
  });
}

async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const p = st.put(val, key);
    p.onsuccess = () => resolve();
    p.onerror = () => reject(p.error);
  });
}

async function idbAll() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const st = tx.objectStore(STORE);
    const out = {};
    const req = st.openCursor();
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return resolve(out);
      out[cur.key] = cur.value || 0;
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/* ===== Helpers: уведомление и широковещалка в окна ===== */
function showChatNotification(data) {
  const title = data.title || 'ChaosNet';
  const body = data.body || 'New message';
  const icon = data.icon || '/img/ChaosNetLogo.png';
  const badge = data.badge || '/img/ChaosNetLogo.png';
  const tag = data.tag || (data.data && data.data.room ? 'room:' + data.data.room : 'chaosnet');
  const ts = Date.now();
  const room = (data.data && data.data.room) || 'main';
  const actions = [{ action: 'open', title: 'Open' }];

  return self.registration.showNotification(title, {
    body, icon, badge, tag, timestamp: ts,
    data: { ...(data.data || {}), room },
    actions
  });
}

async function broadcastToClients(msg) {
  try {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      try { c.postMessage(msg); } catch(_) {}
    }
  } catch (_) {}
}

/* ===== Счётчики ===== */
async function incUnread(room) {
  if (!room) return;
  const cur = (await idbGet(room)) || 0;
  await idbSet(room, cur + 1);
}

async function clearUnread(room) {
  if (!room) return;
  await idbSet(room, 0);
}

/* ===== PUSH: инкрементим счётчик даже при закрытом приложении ===== */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(_) {}

  event.waitUntil((async () => {
    const room = (data && data.data && data.data.room) ? data.data.room : 'main';

    // 1) показываем уведомление
    await showChatNotification(data);

    // 2) bump счётчик в IndexedDB
    try { await incUnread(room); } catch(_) {}

    // 3) Сообщаем всем окнам — обновите бейджи
    await broadcastToClients({ type: 'roomHasNew', room });
  })());
});

/* ===== Клик по уведомлению: открыть/сфокусировать и обнулить счётчик ===== */
async function openOrFocusRoom(room) {
  const url = '/chat.html?room=' + encodeURIComponent(room);
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const c of list) {
    try {
      const u = new URL(c.url);
      if (u.pathname.endsWith('/chat.html')) {
        const params = new URLSearchParams(u.search || '');
        if (params.get('room') === room) {
          await c.focus();
          return c;
        }
      }
    } catch(_) {}
  }
  if (list.length) {
    const c = list[0];
    try { await c.focus(); } catch(_) {}
    try { await c.navigate(url); } catch(_) {}
    return c;
  }
  await clients.openWindow(url);
  return null;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = (event.notification && event.notification.data) || {};
  const room = (d && d.room) ? d.room : 'main';

  event.waitUntil((async () => {
    try { await clearUnread(room); } catch(_) {}
    // сообщаем страницам для очистки локального ls-бейджа
    await broadcastToClients({ type: 'openedFromNotification', room });
    await openOrFocusRoom(room);
  })());
});

/* ===== Сообщения от страниц (Select/Chat) ===== */
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  const portPost = (m) => {
    // ответить именно отправителю, если можем
    try {
      if (event.source && event.source.postMessage) {
        event.source.postMessage(m);
        return;
      }
    } catch(_) {}
    // иначе всем
    broadcastToClients(m);
  };

  if (msg.type === 'getUnreadSnapshot') {
    event.waitUntil((async () => {
      const map = await idbAll().catch(() => ({}));
      portPost({ type: 'unreadSnapshot', map });
    })());
  } else if (msg.type === 'clearUnread' && msg.room) {
    event.waitUntil((async () => {
      await clearUnread(msg.room);
      portPost({ type: 'unreadSnapshot', map: await idbAll().catch(() => ({})) });
    })());
  } else if (msg.type === 'bumpUnread' && msg.room) {
    event.waitUntil((async () => {
      await incUnread(msg.room);
      portPost({ type: 'unreadSnapshot', map: await idbAll().catch(() => ({})) });
    })());
  }
});
`);
});

app.use(express.static('public'));

const upload = multer({ dest: 'temp_uploads/' });

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).send('ok ' + new Date().toISOString());
});
// Явный HEAD, Express и так обрабатывает, но пусть будет
app.head('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).end();
});

// (необязательно, но помогает редким таймаутам keep-alive)
server.keepAliveTimeout = 70000;  // 70s
server.headersTimeout   = 75000;  // 75s


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

// --- Get user by nickname -> avatar for chat list ---
app.post('/get-user-by-nick', async (req, res) => {
  const { nick } = req.body || {};
  if (!nick) return res.status(400).json({ error: 'No nick provided' });

  try {
    const { data, error } = await supabase
      .from('users')
      .select('nick, avatar, AdminStatus')
      .eq('nick', nick)
      .maybeSingle();

    if (error) {
      console.error('Supabase get-user-by-nick error:', error.message);
      return res.status(500).json({ error: 'Server error' });
    }
    if (!data) return res.status(404).json({ error: 'User not found' });

    return res.status(200).json({
      nick: data.nick,
      avatar: data.avatar || null,
      avatar_url: data.avatar || null,
      AdminStatus: data.AdminStatus === true
    });
  } catch (err) {
    console.error('Unexpected error in /get-user-by-nick:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/update-user', async (req, res) => {
  const { id, password, nick } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  const update = {};

  // Optional: update password
  if (typeof password === 'string') {
    if (password.length > 128) {
      return res.status(400).json({ error: 'Password too long' });
    }
    update.password = password;
  }

  // Optional: update nick with uniqueness check
  if (typeof nick === 'string') {
    const trimmedNick = nick.trim();
    if (!trimmedNick) {
      return res.status(400).json({ error: 'Nick cannot be empty' });
    }
    if (trimmedNick.length > 32) {
      return res.status(400).json({ error: 'Nick too long' });
    }

    // Check if this nick is already used by another user
    const { data: existingNick, error: nickErr } = await supabase
      .from('users')
      .select('id')
      .eq('nick', trimmedNick)
      .maybeSingle();

    if (nickErr) {
      console.error('Supabase check nick error:', nickErr.message);
      return res.status(500).json({ error: 'Server error' });
    }

    if (existingNick && existingNick.id !== id) {
      return res.status(409).json({ error: 'Nickname already taken' });
    }

    update.nick = trimmedNick;
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .update(update)
      .eq('id', id)
      .select('id, nick, password, AdminStatus, Subscription, avatar')
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

async function insertMessageRow(row) {
  // Insert a message and safely select only existing columns.
  // We no longer rely on the old "timestamp" column (it may not exist).
  let res = await supabase
    .from('messages')
    .insert(row)
    .select('id, created_at')
    .single();

  if (res?.error) {
    const msg = String(res.error.message || '');

    // If schema is missing optional columns like filename/reply_*,
    // retry with a minimal row shape and minimal SELECT.
    if (
      /(filename|reply_to_id|reply_snapshot)/i.test(msg) ||
      /column .* does not exist/i.test(msg)
    ) {
      const { filename, reply_to_id, reply_snapshot, ...row2 } = row;

      res = await supabase
        .from('messages')
        .insert(row2)
        .select('id, created_at')
        .single();
    }
  }

  return res;
}

function normalizeTimestampForClient(rowOrTs) {
  const raw = (rowOrTs && typeof rowOrTs === 'object') ? (rowOrTs.created_at || rowOrTs.timestamp) : rowOrTs;
  let s = raw ? String(raw) : '';
  if (!s) return new Date().toISOString();
  // If string already contains timezone (Z or +hh:mm), keep it
  if (/Z$|[+\-]\d\d:\d\d$/.test(s)) return s;
  // If it's ISO without zone, treat as UTC
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s + 'Z';
  try { return new Date(s).toISOString(); } catch { return new Date().toISOString(); }
}

async function fetchHistoryOrdered(room) {
  // Try by created_at, then fallback to legacy timestamp, then id
  let res = await supabase.from('messages').select('*').eq('room', room).order('created_at', { ascending: true });
  if (res.error) {
    res = await supabase.from('messages').select('*').eq('room', room).order('timestamp', { ascending: true });
  }
  if (res.error) {
    res = await supabase.from('messages').select('*').eq('room', room).order('id', { ascending: true });
  }
  return res.data || [];
}

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

function isDataUrl(str) {
  return typeof str === 'string' && str.startsWith('data:');
}

function dataUrlToBuffer(dataUrl) {
  // expected format: data:<mime>;base64,<data>
  const match = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl || '');
  if (!match) return null;
  const mime = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');
  // map common mimes to extensions
  const subtype = (mime.split('/')[1] || '').toLowerCase();
  const extMap = {
    jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif',
    mp4: 'mp4', quicktime: 'mov', webm: 'webm',
    mpeg: 'mp3', mp3: 'mp3', ogg: 'ogg', wav: 'wav', 'x-wav': 'wav', 'aac': 'aac', 'mp4a-latm': 'm4a', 'mp4': 'm4a',
    pdf: 'pdf', zip: 'zip'
  };
  const ext = extMap[subtype] || (subtype ? subtype.replace(/[^a-z0-9]/g, '') : 'bin');
  return { mime, buffer, ext };
}

async function uploadBufferToStorage(buffer, mime, suggestedName = '') {
  const safeName = (suggestedName || '').replace(/[^a-zA-Z0-9._-]/g, '');
  const dot = safeName.lastIndexOf('.');
  const suggestedExt = dot >= 0 ? safeName.slice(dot + 1) : '';
  const extFromName = suggestedExt ? suggestedExt : (mime.split('/')[1] || 'bin');
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${extFromName}`;
  const { error } = await supabase.storage.from(BUCKET).upload(filename, buffer, {
    contentType: mime || 'application/octet-stream',
    cacheControl: '3600',
    upsert: false
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return { publicUrl: data.publicUrl, filename };
}

function inferTypeFromUrl(url, filename = '') {
  const name = (filename || url || '').toLowerCase();
  if (/(\.png|\.jpg|\.jpeg|\.webp|\.gif)(\?|#|$)/.test(name)) return 'image';
  if (/(\.mp4|\.webm|\.mov|\.mkv)(\?|#|$)/.test(name)) return 'video';
  if (/(\.mp3|\.ogg|\.wav|\.m4a|\.aac)(\?|#|$)/.test(name)) return 'audio';
  return 'file';
}


// Helpers: room user list and combined flags
function getRoomUsers(room) {
  const arr = [];
  for (const u of clients.values()) {
    if (u.room === room && u.nick) arr.push(u.nick);
  }
  // unique
  return Array.from(new Set(arr));
}

async function getUserFlags(userId) {
  if (!userId || userId.startsWith('guest_')) return { isAdmin: false, isSubscribed: false };
  try {
    const { data, error } = await supabase
      .from('users')
      .select('AdminStatus, Subscription')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return { isAdmin: false, isSubscribed: false };
    return {
      isAdmin: data.AdminStatus === true,
      isSubscribed: data.Subscription === true
    };
  } catch (_) {
    return { isAdmin: false, isSubscribed: false };
  }
}

wss.on('connection', (ws) => {
  let userData = { nick: '', id: '', room: '' };
  // --- WS heartbeat to detect dead connections ---
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (msg) => {
    const data = JSON.parse(msg);
    const room = userData.room;

    if (data.type === 'activeRoom') {
      userData.room = data.room;
      clients.set(ws, userData);
      // respond with current users in this room
      ws.send(JSON.stringify({ type: 'userlist', users: getRoomUsers(userData.room) }));
      return;
    }

    if (data.type === 'join') {
      userData.nick = data.user;
      userData.id = data.id || 'guest_' + Math.random().toString(36).substring(7);
      userData.room = data.room || 'general';
      clients.set(ws, userData);

      await deleteOldMessages(userData.room);

      const history = await fetchHistoryOrdered(userData.room);

      // Inform the client that historical backlog is starting (so UI can mute unread counters)
      try {
        ws.send(JSON.stringify({ type: 'history_start', room: userData.room }));
      } catch (_) {}

      // Send only meaningful history rows (skip rows without text and without image_url)
      const filteredHistory = (history || []).filter((m) => {
        const t = (m.text || '').trim();
        const img = (m.image_url || '').trim();
        return (t.length > 0) || (img.length > 0);
      });

      filteredHistory.forEach(m => {
        const inferredType = (m.image_url && String(m.image_url).trim() !== '')
          ? inferTypeFromUrl(m.image_url, m.filename)
          : 'message';
        ws.send(JSON.stringify({
          type: inferredType,
          id: m.id,
          text: m.text,
          image: m.image_url,
          filename: m.filename || undefined,
          user: m.user,
          timestamp: normalizeTimestampForClient(m),
          isHistory: true
        }));
      });

      // Inform the client that historical backlog is finished
      try {
        ws.send(JSON.stringify({ type: 'history_end', room: userData.room }));
      } catch (_) {}

      // Optionally keep server-side system join log (suppressed by default)
      if (!SUPPRESS_SYSTEM_MESSAGES) {
        const insSys = await supabase
          .from('messages')
          .insert({
            room: userData.room,
            user: 'system',
            text: `${userData.nick} joined`,
            image_url: ''
          })
          .select('id, created_at, timestamp')
          .single();

        const tsSys = normalizeTimestampForClient(insSys?.data);
        broadcast(userData.room, {
          type: 'join',
          user: userData.nick,
          timestamp: tsSys
        });
      }

      // Always broadcast current user list
      broadcast(userData.room, { type: 'userlist', users: getRoomUsers(userData.room) });
      return;
    }

    if (data.type === 'message') {
      // Flags
      const { isAdmin, isSubscribed } = await getUserFlags(userData.id);

      const text = (data.text || '').trim();

      // Ignore empty text messages
      if (!text) {
        return;
      }

      // Length limit for non-subscribed users is applied to the actual message text only
      if (!isAdmin && !isSubscribed && text && text.length > 444) {
        ws.send(JSON.stringify({ type: 'error', text: 'Message too long for non-subscribed users.' }));
        return;
      }

      const now = new Date().toISOString();

      const row = {
        room,
        user: userData.nick,
        text,
        image_url: null,
        filename: null
      };

      let insertedId = null;
      let ins;
      try {
        ins = await insertMessageRow(row);
        insertedId = ins?.data?.id || null;
      } catch (e) {
        console.error('Unexpected insert (text) exception:', e);
      }

      const tsOut = normalizeTimestampForClient(ins?.data) || now;

      broadcast(room, {
        type: 'message',
        id: insertedId,
        text,
        user: userData.nick,
        timestamp: tsOut,
        isHistory: false
      });
      // --- Push notification for text message ---
      try {
        await sendPushToRoom(room, { title: `${userData.nick} • ${room}`, body: (text || 'Message') }, userData.id);
      } catch(_) {}
      activeMessages.set(room, true);
    }

    // Handle explicit user list requests from client
    if (data.type === 'requestUserList') {
      const users = getRoomUsers(userData.room || data.room);
      ws.send(JSON.stringify({ type: 'userlist', users }));
      return;
    }

    // Delete message (owner or admin)
    if (data.type === 'delete') {
      let msgId = data.id;
      if (!msgId) {
        ws.send(JSON.stringify({ type: 'delete_error', id: null, reason: 'No message id provided.' }));
        return;
      }
      // Coerce numeric-looking ids to numbers to avoid eq() mismatch
      if (typeof msgId === 'string' && /^\d+$/.test(msgId)) {
        msgId = Number(msgId);
      }
      try {
        // Fetch the row to verify permissions and to know room & possible media to clean
        const { data: row, error: selErr } = await supabase
          .from('messages')
          .select('id, room, user, image_url, filename')
          .eq('id', msgId)
          .maybeSingle();

        if (selErr) {
          console.error('Delete select error:', selErr.message);
          ws.send(JSON.stringify({ type: 'delete_error', id: msgId, reason: 'Server error' }));
          return;
        }
        if (!row) {
          ws.send(JSON.stringify({ type: 'delete_error', id: msgId, reason: 'Message not found' }));
          return;
        }

        // Only author or admin can delete
        const { isAdmin } = await getUserFlags(userData.id);
        if (row.user !== userData.nick && !isAdmin) {
          ws.send(JSON.stringify({ type: 'delete_error', id: msgId, reason: 'Not allowed' }));
          return;
        }

        // Delete DB row
        const { error: delErr } = await supabase
          .from('messages')
          .delete()
          .eq('id', row.id);

        if (delErr) {
          console.error('Delete DB error:', delErr.message);
          ws.send(JSON.stringify({ type: 'delete_error', id: msgId, reason: 'Failed to delete' }));
          return;
        }

        // Best-effort: remove uploaded file from Storage if it points to our bucket
        try { await deleteFileFromPublicUrl(row.image_url); } catch (_) {}

        // Notify requester and broadcast to room participants
        try { ws.send(JSON.stringify({ type: 'delete_ok', id: row.id })); } catch (_) {}
        broadcast(row.room, { type: 'delete', id: row.id });
      } catch (e) {
        console.error('Unexpected delete error:', e);
        ws.send(JSON.stringify({ type: 'delete_error', id: msgId, reason: 'Server error' }));
      }
      return;
    }

    const incomingType = normalizeIncomingType(data.type, data.image);
    if (['image', 'video', 'audio', 'file'].includes(incomingType)) {
      if (!data.image && !Array.isArray(data.images)) {
        ws.send(JSON.stringify({ type: 'error', text: 'No media provided.' }));
        return;
      }

      const { isAdmin, isSubscribed } = await getUserFlags(userData.id);
      const caption = (data.text || '').trim();
      if (!isAdmin && !isSubscribed && caption && caption.length > 444) {
        ws.send(JSON.stringify({ type: 'error', text: 'Caption too long for non-subscribed users.' }));
        return;
      }

      const files = Array.isArray(data.images)
        ? data.images
        : [{ image: data.image, filename: data.filename }];

      for (const file of files) {
        const raw = file.image;
        const isData = isDataUrl(raw);

        // Decide the effective type: prefer explicit client type, else from URL or data
        let thisType = (data.type && ['image','video','audio','file'].includes(data.type)) ? data.type : null;
        if (!thisType) thisType = isData ? inferTypeFromData(raw) : inferTypeFromUrl(raw, file.filename);

        // Size limits (only enforce precisely for data URLs where we know the bytes)
        if (isData) {
          const parsed = dataUrlToBuffer(raw);
          if (!parsed) {
            ws.send(JSON.stringify({ type: 'error', text: 'Unsupported data URL.' }));
            return;
          }
          const { buffer, mime } = parsed;
          if (thisType === 'image') {
            const maxImage = (isAdmin || isSubscribed) ? 7 * 1024 * 1024 : 2 * 1024 * 1024;
            if (buffer.length > maxImage) {
              ws.send(JSON.stringify({ type: 'error', text: `Image "${file.filename || ''}" is too large. Max size is ${(isAdmin || isSubscribed) ? '7MB' : '2MB'}.` }));
              return;
            }
          } else {
            const maxBig = 30 * 1024 * 1024; // 30MB for video/audio/other
            if (buffer.length > maxBig) {
              ws.send(JSON.stringify({ type: 'error', text: `File "${file.filename || ''}" is too large. Max size is 30MB.` }));
              return;
            }
          }
        }
      }

      // If we got here, sizes are acceptable. Now store each file (data URLs -> Storage) and broadcast URLs.
      const now2 = new Date().toISOString();
      for (const file of files) {
        let urlToSend = file.image;
        let filenameToStore = file.filename || undefined;
        let thisType = (data.type && ['image','video','audio','file'].includes(data.type)) ? data.type : null;

        if (isDataUrl(file.image)) {
          const parsed = dataUrlToBuffer(file.image);
          if (!parsed) continue; // skip invalid
          const { buffer, mime, ext } = parsed;
          // Prefer original extension from filename if present
          const suggestedName = filenameToStore || `upload.${ext}`;
          try {
            const { publicUrl, filename } = await uploadBufferToStorage(buffer, mime, suggestedName);
            urlToSend = publicUrl;
            filenameToStore = filenameToStore || filename;
          } catch (e) {
            console.error('Storage upload failed:', e.message || e);
            ws.send(JSON.stringify({ type: 'error', text: 'Upload failed.' }));
            return;
          }
          if (!thisType) thisType = mime && mime.startsWith('image/') ? 'image' : (mime.startsWith('video/') ? 'video' : (mime.startsWith('audio/') ? 'audio' : 'file'));
        } else {
          if (!thisType) thisType = inferTypeFromUrl(file.image, file.filename);
        }

        const row = {
          room,
          user: userData.nick,
          text: caption,
          image_url: urlToSend,
          filename: filenameToStore || null
        };

        const ins2 = await insertMessageRow(row);
        const insertedId2 = ins2?.data?.id || null;
        const tsOut2 = normalizeTimestampForClient(ins2?.data) || now2;

        broadcast(room, {
          type: thisType,
          id: insertedId2,
          text: caption,
          image: urlToSend,
          filename: filenameToStore,
          user: userData.nick,
          timestamp: tsOut2,
          isHistory: false
        });
        // --- Push notification for media message ---
        try {
          const label = caption ? caption : (thisType.charAt(0).toUpperCase() + thisType.slice(1));
          await sendPushToRoom(room, { title: `${userData.nick} • ${room}`, body: label }, userData.id);
        } catch(_) {}
      }
      activeMessages.set(room, true);
    }
  });

  ws.on('close', async () => {
    if (!SUPPRESS_SYSTEM_MESSAGES) {
      const insSys = await supabase
        .from('messages')
        .insert({
          room: userData.room,
          user: 'system',
          text: `${userData.nick} left`,
          image_url: ''
        })
        .select('id, created_at, timestamp')
        .single();

      const tsSys = normalizeTimestampForClient(insSys?.data);
      broadcast(userData.room, {
        type: 'leave',
        user: userData.nick,
        timestamp: tsSys
      });
    }

    clients.delete(ws);

    // Always broadcast current user list after someone leaves
    broadcast(userData.room, { type: 'userlist', users: getRoomUsers(userData.room) });

    const room = userData.room;
    const stillInRoom = Array.from(clients.values()).some(u => u.room === room);

    if (!stillInRoom && activeMessages.get(room)) {
      const logs = await fetchHistoryOrdered(room);

      const logText = (logs || []).map(m => `${normalizeTimestampForClient(m)} — ${m.user}: ${m.text || '[attachment]'}`).join('\n');
      // sendEmail(`Chat room "${room}" is now empty.\n\nMessages:\n${logText}`);
      activeMessages.delete(room);
    }
  });
});

// Helper: if a public URL points to our Supabase bucket, remove the object
async function deleteFileFromPublicUrl(publicUrl) {
  if (!publicUrl || typeof publicUrl !== 'string') return;
  try {
    // Example public URL:
    // https://YOUR-PROJECT.supabase.co/storage/v1/object/public/chat-uploads/filename.ext
    const m = publicUrl.match(/\/object\/public\/([^/]+)\/(.+)$/);
    if (!m) return;
    const bucket = m[1];
    const pathInBucket = m[2];
    // Only act on known buckets
    if (bucket !== BUCKET && bucket !== AVATARS_BUCKET) return;
    await supabase.storage.from(bucket).remove([pathInBucket]);
  } catch (_) {
    // best-effort
  }
}

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
  const cutoffIso = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

  // Try delete by created_at first
  let res = await supabase
    .from('messages')
    .select('id')
    .lt('created_at', cutoffIso)
    .eq('room', room);

  if (res.error) {
    // Fallback to legacy timestamp column
    res = await supabase
      .from('messages')
      .select('id')
      .lt('timestamp', cutoffIso)
      .eq('room', room);
  }

  const idsToDelete = res.data?.map(m => m.id) || [];
  if (idsToDelete.length > 0) {
    await supabase.from('messages').delete().in('id', idsToDelete);
    console.log(`Deleted ${idsToDelete.length} old messages in room ${room}`);
  }
}

// Periodic ping to all clients; closes connections that didn't respond with pong
const HEARTBEAT_MS = 30000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, HEARTBEAT_MS);

// Clear interval when server closes
wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});