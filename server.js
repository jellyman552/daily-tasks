'use strict';
// Daily Tasks: a tiny task server with Web Push reminders.
// No framework: Node's http module, a JSON file for storage, and the web-push library.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const NUDGE_GRACE_MIN = num(process.env.NUDGE_GRACE_MIN, 10);   // how far past the estimate before "did you finish?"
const NUDGE_REPEAT_MIN = num(process.env.NUDGE_REPEAT_MIN, 30); // re-ask this often while still not done
const NUDGE_MAX = num(process.env.NUDGE_MAX, 3);                // total "did you finish?" pushes per task per day
const LATE_WINDOW_MIN = 15; // don't send a reminder that is more than this late (e.g. after downtime)
const TICK_MS = 20 * 1000;

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

if (!APP_PASSWORD) {
  console.error('APP_PASSWORD is not set. Set it in your .env file before starting.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- storage ----------

const DB_FILE = path.join(DATA_DIR, 'db.json');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const db = Object.assign(
  { tasks: [], completions: {}, subscriptions: [], sent: {} },
  loadJson(DB_FILE, {})
);
function save() { saveJson(DB_FILE, db); }

// VAPID keys and the cookie-signing secret are generated once and kept in data/keys.json.
let keys = loadJson(KEYS_FILE, null);
if (!keys) {
  const v = webpush.generateVAPIDKeys();
  keys = { vapidPublicKey: v.publicKey, vapidPrivateKey: v.privateKey, cookieSecret: crypto.randomBytes(32).toString('hex') };
  saveJson(KEYS_FILE, keys);
  console.log('Generated new VAPID keys in', KEYS_FILE);
}
webpush.setVapidDetails(VAPID_SUBJECT, keys.vapidPublicKey, keys.vapidPrivateKey);

// ---------- dates (server-local time; set TZ in .env) ----------

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDateKey(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function isDateKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
function at(date, hhmm) { const [h, m] = hhmm.split(':').map(Number); const d = parseDateKey(date); d.setHours(h, m, 0, 0); return d; }

function occursOn(task, date) {
  if (task.date) return task.date === date;
  return Array.isArray(task.days) && task.days.includes(parseDateKey(date).getDay());
}

function taskView(task, date, now) {
  const key = `${task.id}|${date}`;
  const done = db.completions[key] || null;
  const start = at(date, task.start);
  const end = new Date(start.getTime() + task.duration * 60000);
  let status;
  if (done) status = done.status;               // 'done' | 'skipped'
  else if (now < start) status = 'upcoming';
  else if (now < end) status = 'active';
  else status = 'overdue';
  return { ...task, occurrence: date, status, startAt: start.toISOString(), endAt: end.toISOString(), completedAt: done ? done.at : null };
}

function endClock(t) {
  const [h, m] = t.start.split(':').map(Number); const e = (h * 60 + m + t.duration) % 1440;
  return `${pad(Math.floor(e / 60))}:${pad(e % 60)}`;
}

function tasksFor(date, now = new Date()) {
  return db.tasks.filter(t => occursOn(t, date)).map(t => taskView(t, date, now))
    .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

// ---------- auth ----------

function sign(v) { return crypto.createHmac('sha256', keys.cookieSecret).update(v).digest('hex'); }
const SESSION_VALUE = () => 'v1.' + sign('session:' + sign(APP_PASSWORD)); // changes if the password changes

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Read-only key for the lock screen widget. Also changes if the password changes.
const WIDGET_KEY = () => sign('widget:' + sign(APP_PASSWORD)).slice(0, 32);

function authed(req) { return safeEqual(parseCookies(req).sid || '', SESSION_VALUE()); }

const loginAttempts = new Map(); // ip -> { count, until }
function loginBlocked(ip) { const a = loginAttempts.get(ip); return a && a.until > Date.now(); }
function loginFailed(ip) {
  const a = loginAttempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 5) { a.until = Date.now() + 15 * 60000; a.count = 0; }
  loginAttempts.set(ip, a);
}

// ---------- push ----------

async function pushAll(payload) {
  const body = JSON.stringify(payload);
  let changed = false;
  await Promise.all(db.subscriptions.map(async sub => {
    try {
      await webpush.sendNotification(sub, body, { TTL: 60 * 30, urgency: 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.subscriptions = db.subscriptions.filter(s => s.endpoint !== sub.endpoint);
        changed = true;
      } else {
        console.error('push failed:', err.statusCode || '', err.body || err.message);
      }
    }
  }));
  if (changed) save();
}

function fmtDuration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Runs every TICK_MS: sends "time to start" and "did you finish?" pushes for today's tasks.
async function tick() {
  const now = new Date();
  const today = dateKey(now);
  const late = LATE_WINDOW_MIN * 60000;
  let changed = false;

  for (const t of tasksFor(today, now)) {
    if (t.status === 'done' || t.status === 'skipped') continue;
    const key = `${t.id}|${today}`;
    const sent = db.sent[key] || (db.sent[key] = { start: false, nudges: 0 });
    const start = new Date(t.startAt).getTime();
    const end = new Date(t.endAt).getTime();

    if (!sent.start && now >= start) {
      sent.start = true; changed = true;
      if (now - start <= late) {
        await pushAll({
          title: `Time to start: ${t.title}`,
          body: `Planned for ${fmtDuration(t.duration)}, until ${new Date(end).toTimeString().slice(0, 5)}.`,
          tag: `start-${key}`, url: `/?task=${t.id}`,
        });
      }
    }

    const firstNudge = end + NUDGE_GRACE_MIN * 60000;
    if (sent.nudges < NUDGE_MAX && now >= firstNudge) {
      const due = firstNudge + sent.nudges * NUDGE_REPEAT_MIN * 60000;
      if (now >= due) {
        // If the server was down, skip ahead instead of sending a burst of catch-up pushes.
        const behind = NUDGE_REPEAT_MIN > 0 ? Math.floor((now - due) / (NUDGE_REPEAT_MIN * 60000)) : 0;
        sent.nudges = Math.min(NUDGE_MAX, sent.nudges + behind + 1); changed = true;
        if (now - due - behind * NUDGE_REPEAT_MIN * 60000 <= late) {
          const over = Math.round((now - end) / 60000);
          await pushAll({
            title: `Did you finish ${t.title}?`,
            body: `It's ${fmtDuration(over)} past the ${fmtDuration(t.duration)} estimate. Tap to mark it done.`,
            tag: `nudge-${key}`, url: `/?task=${t.id}`,
          });
        }
      }
    }
  }

  // Forget sent-markers older than two days.
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 2);
  const cutoffKey = dateKey(cutoff);
  for (const k of Object.keys(db.sent)) {
    if (k.split('|')[1] < cutoffKey) { delete db.sent[k]; changed = true; }
  }
  if (changed) save();
}

// ---------- validation ----------

function cleanTask(input, existing = {}) {
  const t = { ...existing };
  if ('title' in input) t.title = String(input.title || '').trim().slice(0, 120);
  if ('notes' in input) t.notes = String(input.notes || '').trim().slice(0, 1000);
  if ('start' in input) t.start = input.start;
  if ('duration' in input) t.duration = Math.round(Number(input.duration));
  if ('date' in input || 'days' in input) {
    const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number))].filter(d => d >= 0 && d <= 6).sort() : [];
    if (days.length) { t.days = days; t.date = null; }
    else { t.date = input.date; t.days = []; }
  }
  if (!t.title) throw new Error('Give the task a name.');
  if (!isTime(t.start)) throw new Error('Start time must look like 07:30.');
  if (!(t.duration >= 1 && t.duration <= 24 * 60)) throw new Error('Estimated time must be between 1 minute and 24 hours.');
  if (!t.days?.length && !isDateKey(t.date)) throw new Error('Pick a date or at least one repeat day.');
  return t;
}

// ---------- http ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 100000) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      // Unknown paths fall back to the app shell.
      if (!path.extname(rel)) return serveStatic(req, res, '/');
      return send(res, 404, { error: 'Not found' });
    }
    // no-cache = revalidate each time, so updates show up right away on the phone.
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (p === '/api/login' && method === 'POST') {
    if (loginBlocked(ip)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
    const body = await readBody(req);
    if (!safeEqual(body.password || '', APP_PASSWORD)) { loginFailed(ip); return send(res, 401, { error: 'Wrong password.' }); }
    loginAttempts.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${SESSION_VALUE()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` });
  }
  if (p === '/api/logout' && method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }

  // Lock screen widget: read-only summary of today, authorized by ?key= instead of the cookie.
  if (p === '/api/widget' && method === 'GET') {
    if (!safeEqual(url.searchParams.get('key') || '', WIDGET_KEY())) return send(res, 401, { error: 'Bad widget key.' });
    const now = new Date();
    const tasks = tasksFor(dateKey(now), now);
    const pick = t => t && { title: t.title, start: t.start, end: endClock(t), duration: t.duration, status: t.status, startAt: t.startAt, endAt: t.endAt };
    const open = tasks.filter(t => t.status !== 'done' && t.status !== 'skipped');
    const current = open.filter(t => t.status === 'active' || t.status === 'overdue').pop() || null;
    const next = open.find(t => t.status === 'upcoming') || null;
    return send(res, 200, {
      now: now.toISOString(),
      done: tasks.filter(t => t.status === 'done').length,
      total: tasks.filter(t => t.status !== 'skipped').length,
      current: pick(current),
      next: pick(next),
      upcoming: open.filter(t => t.status === 'upcoming').slice(0, 4).map(pick),
    });
  }

  if (!authed(req)) return send(res, 401, { error: 'Not signed in.' });

  if (p === '/api/state' && method === 'GET') {
    const now = new Date();
    const today = dateKey(now);
    const date = isDateKey(url.searchParams.get('date')) ? url.searchParams.get('date') : today;
    return send(res, 200, {
      today, date, now: now.toISOString(),
      tasks: tasksFor(date, now),
      vapidPublicKey: keys.vapidPublicKey,
      subscriptions: db.subscriptions.length,
      widgetKey: WIDGET_KEY(),
      settings: { graceMin: NUDGE_GRACE_MIN, repeatMin: NUDGE_REPEAT_MIN, maxNudges: NUDGE_MAX },
    });
  }

  if (p === '/api/tasks' && method === 'POST') {
    const task = cleanTask(await readBody(req), { id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    db.tasks.push(task); save();
    return send(res, 201, task);
  }

  let m = p.match(/^\/api\/tasks\/([\w-]+)$/);
  if (m) {
    const idx = db.tasks.findIndex(t => t.id === m[1]);
    if (idx < 0) return send(res, 404, { error: 'Task not found.' });
    if (method === 'PUT') {
      const updated = cleanTask(await readBody(req), db.tasks[idx]);
      // Editing the time re-arms today's reminders for it.
      for (const k of Object.keys(db.sent)) if (k.startsWith(updated.id + '|')) delete db.sent[k];
      db.tasks[idx] = updated; save();
      return send(res, 200, updated);
    }
    if (method === 'DELETE') {
      const id = db.tasks[idx].id;
      db.tasks.splice(idx, 1);
      for (const store of [db.completions, db.sent]) for (const k of Object.keys(store)) if (k.startsWith(id + '|')) delete store[k];
      save();
      return send(res, 200, { ok: true });
    }
  }

  m = p.match(/^\/api\/tasks\/([\w-]+)\/status$/);
  if (m && method === 'POST') {
    const body = await readBody(req);
    if (!db.tasks.some(t => t.id === m[1])) return send(res, 404, { error: 'Task not found.' });
    if (!isDateKey(body.date)) return send(res, 400, { error: 'Missing date.' });
    const key = `${m[1]}|${body.date}`;
    if (body.status === 'done' || body.status === 'skipped') db.completions[key] = { status: body.status, at: new Date().toISOString() };
    else delete db.completions[key];
    save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/subscribe' && method === 'POST') {
    const { subscription } = await readBody(req);
    if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.keys) return send(res, 400, { error: 'Bad subscription.' });
    db.subscriptions = db.subscriptions.filter(s => s.endpoint !== subscription.endpoint);
    db.subscriptions.push({ endpoint: subscription.endpoint, keys: subscription.keys });
    save();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/unsubscribe' && method === 'POST') {
    const { endpoint } = await readBody(req);
    db.subscriptions = db.subscriptions.filter(s => s.endpoint !== endpoint); save();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/test-push' && method === 'POST') {
    if (!db.subscriptions.length) return send(res, 400, { error: 'No device has turned on notifications yet.' });
    await pushAll({ title: 'Notifications are working', body: "You'll get a nudge when each task should start.", tag: 'test', url: '/' });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    return send(res, 400, { error: err.message || 'Something went wrong.' });
  }
});

server.listen(PORT, () => {
  console.log(`Daily Tasks listening on :${PORT} (timezone ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  tick().catch(e => console.error('tick failed', e));
  setInterval(() => tick().catch(e => console.error('tick failed', e)), TICK_MS);
});
