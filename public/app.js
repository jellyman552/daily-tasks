'use strict';

const $ = sel => document.querySelector(sel);
const state = { date: null, today: null, data: null, editing: null, days: new Set(), highlight: null };

// ---------- helpers ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Not signed in.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function parseDate(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); }
function dateKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDays(key, n) { const d = parseDate(key); d.setDate(d.getDate() + n); return dateKey(d); }
function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function addMin(hhmm, min) {
  const [h, m] = hhmm.split(':').map(Number); const t = (h * 60 + m + min) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
function fmtClock(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtDur(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function repeatText(days) {
  const s = [...days].sort();
  if (s.length === 7) return 'Every day';
  if (s.join() === '1,2,3,4,5') return 'Weekdays';
  if (s.join() === '0,6') return 'Weekends';
  return 'Every ' + [1, 2, 3, 4, 5, 6, 0].filter(d => s.includes(d)).map(d => DAY_NAMES[d]).join(', ');
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- screens ----------

function showLogin() { $('#main').hidden = true; $('#login').hidden = false; setTimeout(() => $('#password').focus(), 50); }
function showMain() { $('#login').hidden = true; $('#main').hidden = false; }

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    await load();
  } catch (err) { $('#login-error').textContent = err.message; }
});

// ---------- loading and rendering ----------

async function load() {
  const q = state.date ? `?date=${state.date}` : '';
  const data = await api('/api/state' + q);
  state.data = data; state.today = data.today;
  if (!state.date) state.date = data.date;
  showMain();
  render();
  renderNotifyBanner();
}

function render() {
  const { tasks } = state.data;
  const d = parseDate(state.date);
  const long = d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const rel = state.date === state.today ? 'Today' : state.date === addDays(state.today, 1) ? 'Tomorrow' : state.date === addDays(state.today, -1) ? 'Yesterday' : null;
  $('#day-label').textContent = rel ? `${rel} · ${long.split(',')[0]}` : long;
  $('#today-btn').hidden = state.date === state.today;

  const done = tasks.filter(t => t.status === 'done').length;
  const counted = tasks.filter(t => t.status !== 'skipped').length;
  const totalMin = tasks.filter(t => t.status !== 'skipped').reduce((a, t) => a + t.duration, 0);
  $('#summary').innerHTML = tasks.length
    ? `${done} of ${counted} done · ${fmtDur(totalMin)} planned<div class="bar"><i style="width:${counted ? (done / counted) * 100 : 0}%"></i></div>`
    : '';
  $('#empty').hidden = tasks.length > 0;

  const now = Date.now();
  $('#task-list').innerHTML = tasks.map(t => {
    const start = new Date(t.startAt).getTime(), end = new Date(t.endAt).getTime();
    let pill = '', progress = '';
    if (t.status === 'active') {
      pill = `<span class="pill active">Now · ${Math.max(1, Math.round((end - now) / 60000))} min left</span>`;
      progress = `<div class="progress"><i style="width:${Math.min(100, ((now - start) / (end - start)) * 100)}%"></i></div>`;
    } else if (t.status === 'overdue') {
      const isToday = t.occurrence === state.today;
      pill = isToday ? `<span class="pill overdue">${fmtDur(Math.round((now - end) / 60000))} over</span>` : `<span class="pill overdue">Not done</span>`;
      if (isToday) progress = `<div class="progress"><i style="width:100%"></i></div>`;
    } else if (t.status === 'done') {
      pill = `<span class="pill">Done ${fmtClock(t.completedAt)}</span>`;
    } else if (t.status === 'skipped') {
      pill = `<span class="pill">Skipped</span>`;
    }
    const finished = t.status === 'done' || t.status === 'skipped';
    const actions = finished
      ? `<button data-act="undo">Undo</button><button data-act="edit">Edit</button>`
      : `<button class="done-btn" data-act="done">Done</button><button data-act="skip">Skip</button><button data-act="edit">Edit</button>`;
    return `<li class="task ${t.status}${state.highlight === t.id ? ' highlight' : ''}" data-id="${t.id}">
      <div class="time">${fmtTime(t.start)}<small>to ${fmtTime(addMin(t.start, t.duration))}</small></div>
      <div class="body">
        <div class="title">${esc(t.title)}</div>
        <div class="meta"><span>${fmtDur(t.duration)}</span>${t.days?.length ? `<span>· ${repeatText(t.days)}</span>` : ''}${pill}</div>
        ${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ''}
      </div>
      ${progress}
      <div class="actions">${actions}</div>
    </li>`;
  }).join('');

  if (state.highlight) {
    const el = document.querySelector(`.task[data-id="${state.highlight}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => { state.highlight = null; document.querySelectorAll('.task.highlight').forEach(e => e.classList.remove('highlight')); }, 4000);
  }
}

$('#task-list').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const id = btn.closest('.task').dataset.id;
  const task = state.data.tasks.find(t => t.id === id);
  const act = btn.dataset.act;
  if (act === 'edit') return openEditor(task);
  const status = act === 'done' ? 'done' : act === 'skip' ? 'skipped' : null;
  try {
    await api(`/api/tasks/${id}/status`, { method: 'POST', body: { date: state.date, status } });
    await load();
    if (status === 'done') toast(`Nice. "${task.title}" is done.`);
  } catch (err) { toast(err.message); }
});

function go(date) { state.date = date; load().catch(err => toast(err.message)); }
$('#prev-day').onclick = () => go(addDays(state.date, -1));
$('#next-day').onclick = () => go(addDays(state.date, 1));
$('#today-btn').onclick = () => go(state.today);
document.addEventListener('click', e => { if (e.target.closest('[data-action="add"]')) openEditor(null); });

// ---------- editor ----------

const form = $('#task-form');
function syncDayChips() {
  document.querySelectorAll('#day-chips button').forEach(b => b.classList.toggle('on', state.days.has(+b.dataset.day)));
  const d = parseDate(state.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  $('#repeat-hint').textContent = state.days.size ? repeatText(state.days) : `Just once, on ${d}`;
}
function syncDurationChips() {
  const v = +form.duration.value;
  document.querySelectorAll('#duration-chips button').forEach(b => b.classList.toggle('on', +b.dataset.min === v));
}

function openEditor(task) {
  state.editing = task;
  $('#editor-title').textContent = task ? 'Edit task' : 'New task';
  $('#editor-error').textContent = '';
  $('#delete-btn').hidden = !task;
  form.title.value = task?.title || '';
  form.notes.value = task?.notes || '';
  form.duration.value = task?.duration || 30;
  if (task) form.start.value = task.start;
  else {
    // Default to the next half hour.
    const n = new Date(); n.setMinutes(n.getMinutes() < 30 ? 30 : 60, 0, 0);
    form.start.value = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
  }
  state.days = new Set(task?.days || []);
  syncDayChips(); syncDurationChips();
  $('#editor').showModal();
  if (!task) setTimeout(() => form.title.focus(), 50);
}

$('#duration-chips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  form.duration.value = b.dataset.min; syncDurationChips();
});
form.duration.addEventListener('input', syncDurationChips);
$('#day-chips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = +b.dataset.day; state.days.has(d) ? state.days.delete(d) : state.days.add(d); syncDayChips();
});
document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
  const p = b.dataset.preset;
  state.days = new Set(p === 'all' ? [0, 1, 2, 3, 4, 5, 6] : p === 'weekdays' ? [1, 2, 3, 4, 5] : []);
  syncDayChips();
}));

form.addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    title: form.title.value, start: form.start.value, duration: +form.duration.value, notes: form.notes.value,
    days: [...state.days],
    // A one-off task keeps its original date when edited; a new one lands on the day being viewed.
    date: state.editing?.date || state.date,
  };
  try {
    if (state.editing) await api(`/api/tasks/${state.editing.id}`, { method: 'PUT', body });
    else await api('/api/tasks', { method: 'POST', body });
    $('#editor').close();
    await load();
  } catch (err) { $('#editor-error').textContent = err.message; }
});

$('#delete-btn').addEventListener('click', async () => {
  const t = state.editing;
  const msg = t.days?.length ? `Delete "${t.title}"? This removes it from every day it repeats.` : `Delete "${t.title}"?`;
  if (!confirm(msg)) return;
  try { await api(`/api/tasks/${t.id}`, { method: 'DELETE' }); $('#editor').close(); await load(); }
  catch (err) { $('#editor-error').textContent = err.message; }
});

document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

// ---------- notifications ----------

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function b64ToUint8(b64) {
  const s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enablePush() {
  if (!pushSupported) throw new Error(isIOS && !isStandalone ? 'Open this from your Home Screen icon first.' : 'This browser cannot receive push notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Turn them on in Settings › Notifications › Tasks.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(state.data.vapidPublicKey) });
  await api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}

async function renderNotifyBanner() {
  const banner = $('#notify-banner');
  if (isIOS && !isStandalone) {
    banner.innerHTML = `<strong>Add this to your Home Screen</strong> to get reminders. Tap the Share button, choose <em>Add to Home Screen</em>, then open Tasks from the new icon.`;
    banner.hidden = false; return;
  }
  if (!pushSupported) { banner.hidden = true; return; }
  const sub = await currentSubscription().catch(() => null);
  if (Notification.permission === 'granted' && sub) {
    banner.hidden = true;
    // Keep the server's copy fresh (it drops subscriptions that expire).
    api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } }).catch(() => {});
    return;
  }
  if (Notification.permission === 'denied') {
    banner.innerHTML = 'Notifications are blocked for this app. Turn them on in iPhone Settings › Notifications › Tasks.';
  } else {
    banner.innerHTML = `Get a nudge when each task should start, and a check-in if it runs long.<button class="primary" id="banner-enable">Turn on notifications</button>`;
    $('#banner-enable').onclick = () => enablePush().then(() => { toast('Notifications are on.'); renderNotifyBanner(); }).catch(err => toast(err.message));
  }
  banner.hidden = false;
}

// ---------- settings ----------

$('#settings-btn').onclick = async () => {
  const s = state.data.settings;
  const sub = await currentSubscription().catch(() => null);
  $('#push-status').textContent = !pushSupported
    ? (isIOS && !isStandalone ? 'Open Tasks from your Home Screen icon to turn on notifications.' : 'This browser cannot receive push notifications.')
    : sub && Notification.permission === 'granted' ? 'Notifications are on for this device.' : 'Notifications are off for this device.';
  $('#enable-push').hidden = !pushSupported || (sub && Notification.permission === 'granted');
  $('#test-push').hidden = !sub;
  $('#nudge-rules').textContent = `You get "time to start" at each task's start time. If a task isn't marked done ${s.graceMin} min after its estimate runs out, you get "did you finish?", repeated every ${s.repeatMin} min, up to ${s.maxNudges} times.`;
  $('#settings').showModal();
};
$('#enable-push').onclick = () => enablePush().then(() => { toast('Notifications are on.'); $('#settings').close(); renderNotifyBanner(); }).catch(err => toast(err.message));
$('#test-push').onclick = () => api('/api/test-push', { method: 'POST' }).then(() => toast('Sent. It should arrive in a few seconds.')).catch(err => toast(err.message));
$('#copy-widget').onclick = async () => {
  const link = `${location.origin}/api/widget?key=${state.data.widgetKey}`;
  try { await navigator.clipboard.writeText(link); toast('Widget link copied.'); }
  catch { prompt('Copy this link:', link); }
};
$('#logout').onclick = async () => {
  const sub = await currentSubscription().catch(() => null);
  if (sub) { await api('/api/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  $('#settings').close(); showLogin();
};

// ---------- start ----------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// A tapped notification opens /?task=<id>; highlight that task.
const params = new URLSearchParams(location.search);
if (params.get('task')) { state.highlight = params.get('task'); history.replaceState(null, '', '/'); }
navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'open-task') { state.highlight = e.data.id; state.date = state.today; load().catch(() => {}); }
});

load().catch(() => {});
// Keep "now / over" labels current, and refresh when the app comes back to the foreground.
setInterval(() => { if (!document.hidden && state.data && !$('#main').hidden) load().catch(() => {}); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.data) return;
  // Roll over to the new day if the app was left open overnight.
  if (state.date === state.today) state.date = null;
  load().catch(() => {});
});
