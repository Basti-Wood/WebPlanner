'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db } = require('./db');
const { sessionMiddleware, initPassport, ensureAuth, setFlash, passport, googleEnabled } = require('./auth');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = String(process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const GOOGLE_CALLBACK_URL = BASE_URL + '/auth/google/callback';
/* Bump this whenever styles change — it forces browsers to refetch main.css. */
const APP_VERSION = '1.5.0';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

/* The app normally sits behind a reverse proxy (Caddy/Nginx) that terminates
   TLS. Trust one proxy hop so `req.secure` / `req.protocol` reflect HTTPS —
   this is what makes the Secure session cookie work behind the proxy. */
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));

app.use(sessionMiddleware);
initPassport();
app.use(passport.initialize());
app.use(passport.session());

/* ------------------------------ helpers ------------------------------ */

const TAB_COLORS = ['indigo', 'emerald', 'rose', 'amber', 'sky', 'violet'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n) { return String(n).padStart(2, '0'); }
function normEmail(v) { return String(v || '').trim().toLowerCase(); }

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const prefix = name + '=';
  for (const part of header.split(';')) {
    const p = part.trim();
    if (p.startsWith(prefix)) return p.slice(prefix.length);
  }
  return '';
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function ensureCalendarToken(userId) {
  const row = db.prepare('SELECT calendar_token FROM users WHERE id = ?').get(userId);
  if (row && row.calendar_token) return row.calendar_token;
  const token = randomToken();
  db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(token, userId);
  return token;
}

/* ICS escaping + formatting helpers for the calendar feed. */
function icsText(v) {
  return String(v || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function foldLine(line) {
  if (line.length <= 70) return line;
  let out = '';
  let rest = line;
  while (rest.length > 60) {
    out += rest.slice(0, 60) + '\r\n ';
    rest = rest.slice(60);
  }
  return out + rest;
}

function icsStamp(isoUtc) {
  const d = new Date(isoUtc);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function sqliteStamp(sqliteDate) {
  const d = new Date(String(sqliteDate).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function parseOffset(v) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = 0;
  return Math.max(-840, Math.min(840, n));
}

/* Convert a local datetime-local string (browser time) + tz offset (minutes) to ISO UTC. */
function utcFromLocalInput(value, offsetMin) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + (offsetMin || 0) * 60000).toISOString();
}

/* Shift an ISO UTC timestamp by the stored browser offset and return local parts. */
function localParts(iso, offsetMin) {
  const d = new Date(new Date(iso).getTime() - (offsetMin || 0) * 60000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes()
  };
}

function fmtDue(iso, offsetMin) {
  if (!iso) return '';
  const p = localParts(iso, offsetMin);
  return `${p.d} ${MONTHS_SHORT[p.m]} ${p.y}, ${pad(p.hh)}:${pad(p.mm)}`;
}

function inputValue(iso, offsetMin) {
  if (!iso) return '';
  const p = localParts(iso, offsetMin);
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
}

function dayKey(iso, offsetMin) {
  const p = localParts(iso, offsetMin);
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
}

function pct(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

function getTabs(userId) {
  return db.prepare('SELECT * FROM tabs WHERE user_id = ? ORDER BY position, id').all(userId);
}

function getTab(userId, tabId) {
  return db.prepare('SELECT * FROM tabs WHERE id = ? AND user_id = ?').get(tabId, userId);
}

function getTask(userId, taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
}

function tabStats(userId) {
  return db.prepare(`
    SELECT t.id, t.name, t.color, t.parent_id, COUNT(k.id) AS total, COALESCE(SUM(k.done), 0) AS done
    FROM tabs t
    LEFT JOIN tasks k ON k.tab_id = t.id
    WHERE t.user_id = ?
    GROUP BY t.id
    ORDER BY t.position, t.id
  `).all(userId);
}

function overallStats(userId) {
  return db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM tasks WHERE user_id = ?').get(userId);
}

/* Build parent/child tree and decorate with labels + subtask counts. */
function taskTree(rows) {
  const parents = [];
  const byId = new Map();
  for (const r of rows) {
    r.children = [];
    r.subtotal = 0;
    r.subdone = 0;
    byId.set(r.id, r);
  }
  for (const r of rows) {
    if (r.parent_id && byId.has(r.parent_id)) {
      const p = byId.get(r.parent_id);
      p.children.push(r);
      p.subtotal += 1;
      if (r.done) p.subdone += 1;
    } else {
      parents.push(r);
    }
  }
  for (const r of rows) {
    r.startLabel = fmtDue(r.start_at, r.tz_offset);
    r.dueLabel = fmtDue(r.due_at, r.tz_offset);
    r.overdue = Boolean(r.due_at && !r.done && Date.parse(r.due_at) < Date.now());
  }
  const open = parents.filter((p) => !p.done).sort((a, b) => {
    const ad = a.due_at ? Date.parse(a.due_at) : Infinity;
    const bd = b.due_at ? Date.parse(b.due_at) : Infinity;
    return ad - bd;
  });
  const done = parents.filter((p) => p.done);
  return open.concat(done);
}

/* Build a parent/child tree of tabs (for grouped tabs in nav and home). */
function buildTabTree(rows) {
  const byId = new Map();
  for (const t of rows) {
    t.children = [];
    byId.set(t.id, t);
  }
  const roots = [];
  for (const t of rows) {
    if (t.parent_id && byId.has(t.parent_id)) byId.get(t.parent_id).children.push(t);
    else roots.push(t);
  }
  return roots;
}

/* Roll each descendant's task totals into its master tab. */
function rollupTabStats(nodes) {
  for (const tab of nodes) {
    tab.ownTotal = Number(tab.total || 0);
    tab.ownDone = Number(tab.done || 0);
    rollupTabStats(tab.children);
    tab.total = tab.ownTotal + tab.children.reduce((sum, child) => sum + child.total, 0);
    tab.done = tab.ownDone + tab.children.reduce((sum, child) => sum + child.done, 0);
  }
  return nodes;
}

function findTabInTree(nodes, tabId) {
  for (const tab of nodes) {
    if (tab.id === Number(tabId)) return tab;
    const found = findTabInTree(tab.children, tabId);
    if (found) return found;
  }
  return null;
}

/* True if tabId sits somewhere below ancestorId in the tab tree (cycle guard). */
function isDescendantOf(tabId, ancestorId) {
  let cur = db.prepare('SELECT parent_id FROM tabs WHERE id = ?').get(tabId);
  const seen = new Set();
  while (cur && cur.parent_id) {
    if (cur.parent_id === ancestorId) return true;
    if (seen.has(cur.parent_id)) return false;
    seen.add(cur.parent_id);
    cur = db.prepare('SELECT parent_id FROM tabs WHERE id = ?').get(cur.parent_id);
  }
  return false;
}

function buildGrid(y, m, byDay) {
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // Monday start
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(y, m, i - lead + 1));
    const inMonth = d.getUTCMonth() === m;
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    cells.push({ day: d.getUTCDate(), key, inMonth, tasks: byDay.get(key) || [] });
  }
  return cells;
}

/* ---------------------------- locals + auth --------------------------- */

app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.currentPath = req.path;
  res.locals.currentTabId = null;
  res.locals.theme = getCookie(req, 'theme') === 'dark' ? 'dark' : '';
  res.locals.version = APP_VERSION;
  res.locals.googleEnabled = googleEnabled;
  res.locals.tabs = req.user ? getTabs(req.user.id) : [];
  res.locals.tabTree = req.user ? buildTabTree(getTabs(req.user.id)) : [];
  res.locals.fmtDue = fmtDue;
  res.locals.inputValue = inputValue;
  res.locals.pct = pct;
  next();
});

/* -------------------------------- auth -------------------------------- */

app.get('/', (req, res) => res.redirect(req.user ? '/home' : '/login'));

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/home');
  res.render('login', { title: 'Log in' });
});

app.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      console.warn('[auth] local login failed for', normEmail(req.body.email), '—', (info && info.message) || 'unknown reason');
      setFlash(req, 'error', (info && info.message) || 'Invalid email or password.');
      return res.redirect('/login');
    }
    req.logIn(user, (e) => (e ? next(e) : res.redirect('/home')));
  })(req, res, next);
});

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/home');
  res.render('register', { title: 'Register' });
});

app.post('/register', (req, res, next) => {
  const name = String(req.body.name || '').trim();
  const email = normEmail(req.body.email);
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const fail = (msg) => { setFlash(req, 'error', msg); return res.redirect('/register'); };

  if (name.length < 2) return fail('Please enter your name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Please enter a valid email address.');
  if (password.length < 6) return fail('Password must be at least 6 characters.');
  if (password !== confirm) return fail('Passwords do not match.');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return fail('An account with this email already exists — try logging in.');

  const hash = bcrypt.hashSync(password, 10);
  let info;
  try {
    info = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(email, name.slice(0, 60), hash);
  } catch (err) {
    console.error('[auth] registration failed:', err.message);
    return fail('Registration failed — please try again.');
  }
  const user = { id: info.lastInsertRowid, email, name: name.slice(0, 60) };
  req.login(user, (e) => (e ? next(e) : res.redirect('/home')));
});

app.get('/auth/google', (req, res, next) => {
  console.log(`[google] login requested (host=${req.get('host') || '-'}, protocol=${req.protocol}, forwarded-proto=${req.get('x-forwarded-proto') || '-'})`);
  if (!googleEnabled) {
    console.error('[google] login requested, but GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing');
    setFlash(req, 'error', 'Google login is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.');
    return res.redirect('/login');
  }
  /* Google requires this redirect_uri to match both the Cloud Console entry
     and the redirect_uri used later while exchanging the authorization code. */
  console.log(`[google] redirecting to Google (redirect_uri=${GOOGLE_CALLBACK_URL})`);
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    callbackURL: GOOGLE_CALLBACK_URL
  })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  console.log(`[google] callback received (error=${req.query.error || 'none'}, code=${req.query.code ? 'present' : 'missing'})`);
  passport.authenticate('google', { callbackURL: GOOGLE_CALLBACK_URL }, (err, user, info) => {
    if (err) {
      console.error('[google] callback error:', err && err.stack ? err.stack : err);
      setFlash(req, 'error', 'Google sign-in failed: ' + (err.message || 'unknown error'));
      return res.redirect('/login');
    }
    if (!user) {
      console.error('[google] authentication failed:', info);
      setFlash(req, 'error', 'Google sign-in failed: ' + (info && info.message ? info.message : 'unknown reason'));
      return res.redirect('/login');
    }
    req.logIn(user, (e) => {
      if (e) {
        console.error('[google] session login failed:', e && e.stack ? e.stack : e);
        return next(e);
      }
      console.log(`[google] login succeeded for user ${user.id}`);
      return res.redirect('/home');
    });
  })(req, res, next);
});

app.get('/logout', (req, res) => {
  req.logout(() => {});
  req.session.destroy(() => res.redirect('/login'));
});

/* Toggle dark mode; returns to the page the request came from. */
app.post('/theme', (req, res) => {
  const nextTheme = getCookie(req, 'theme') === 'dark' ? 'light' : 'dark';
  res.cookie('theme', nextTheme, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 365 * 24 * 3600 * 1000,
    secure: BASE_URL.startsWith('https://')
  });
  const back = String(req.body.redirect || '/');
  res.redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/');
});

/* -------------------------------- home -------------------------------- */

app.get('/home', ensureAuth, (req, res) => {
  const overall = overallStats(req.user.id);
  const tabs = tabStats(req.user.id);
  const upcoming = db.prepare(`
    SELECT k.id, k.title, k.due_at, k.tz_offset, b.id AS tab_id, b.name AS tab_name, b.color
    FROM tasks k
    JOIN tabs b ON b.id = k.tab_id
    WHERE k.user_id = ? AND k.done = 0 AND k.parent_id IS NULL AND k.due_at IS NOT NULL
    ORDER BY k.due_at
    LIMIT 8
  `).all(req.user.id);
  for (const u of upcoming) {
    u.dueLabel = fmtDue(u.due_at, u.tz_offset);
    u.overdue = Date.parse(u.due_at) < Date.now();
  }
  const tabTree = rollupTabStats(buildTabTree(tabs));
  res.render('home', { title: 'Home', overall, tabs, tabTree, upcoming, TAB_COLORS });
});

/* -------------------------------- tabs -------------------------------- */

app.post('/tabs', ensureAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) {
    setFlash(req, 'error', 'Please give the tab a name.');
    return res.redirect('/home');
  }
  const color = TAB_COLORS.includes(req.body.color) ? req.body.color : 'indigo';
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tabs WHERE user_id = ?').get(req.user.id).p;
  db.prepare('INSERT INTO tabs (user_id, name, color, position) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name.slice(0, 40), color, pos);
  res.redirect('/home');
});

app.post('/tabs/:id/delete', ensureAuth, (req, res) => {
  const tab = getTab(req.user.id, req.params.id);
  if (!tab) return res.redirect('/home');
  db.prepare('DELETE FROM tabs WHERE id = ?').run(tab.id);
  setFlash(req, 'success', `Tab "${tab.name}" deleted.`);
  res.redirect('/home');
});

/* Drag & drop: group one tab under another (empty parent_id = top level). */
app.post('/tabs/move-parent', ensureAuth, (req, res) => {
  const tab = getTab(req.user.id, req.body.tab_id);
  if (!tab) return res.redirect('/home');
  let parentId = null;
  const pid = String(req.body.parent_id || '').trim();
  if (pid) {
    const parent = getTab(req.user.id, pid);
    if (!parent) {
      setFlash(req, 'error', 'That tab does not exist.');
      return res.redirect('/home');
    }
    if (parent.id === tab.id || isDescendantOf(parent.id, tab.id)) {
      setFlash(req, 'error', 'You cannot group a tab under itself.');
      return res.redirect('/home');
    }
    parentId = parent.id;
  }
  db.prepare('UPDATE tabs SET parent_id = ? WHERE id = ?').run(parentId, tab.id);
  res.redirect('/home');
});

app.get('/tabs/:id', ensureAuth, (req, res) => {
  const tabTree = rollupTabStats(buildTabTree(tabStats(req.user.id)));
  const tab = findTabInTree(tabTree, req.params.id);
  if (!tab) return res.redirect('/home');
  const rows = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND tab_id = ? ORDER BY created_at, id')
    .all(req.user.id, tab.id);
  const parents = taskTree(rows);
  const ownDone = rows.filter((r) => r.done).length;
  const parent = tab.parent_id ? getTab(req.user.id, tab.parent_id) : null;
  res.locals.currentTabId = tab.id;
  res.render('tab', {
    title: tab.name,
    tab,
    parent,
    children: tab.children,
    tasks: parents,
    ownTotal: rows.length,
    ownDone,
    total: tab.total,
    done: tab.done
  });
});

app.post('/tabs/:id/tasks', ensureAuth, (req, res) => {
  const tab = getTab(req.user.id, req.params.id);
  if (!tab) return res.redirect('/home');
  const title = String(req.body.title || '').trim();
  if (!title) {
    setFlash(req, 'error', 'Please give the task a title.');
    return res.redirect(`/tabs/${tab.id}`);
  }
  const offset = parseOffset(req.body.tz_offset);
  const startAt = req.body.start ? utcFromLocalInput(req.body.start, offset) : null;
  const dueAt = req.body.due ? utcFromLocalInput(req.body.due, offset) : null;
  db.prepare('INSERT INTO tasks (user_id, tab_id, title, notes, start_at, due_at, tz_offset) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, tab.id, title.slice(0, 200), String(req.body.notes || '').slice(0, 2000), startAt, dueAt, offset);
  res.redirect(`/tabs/${tab.id}`);
});

/* -------------------------------- tasks ------------------------------- */

/* Quick add from the calendar page. */
app.post('/tasks', ensureAuth, (req, res) => {
  const tab = getTab(req.user.id, req.body.tab_id);
  if (!tab) {
    setFlash(req, 'error', 'Pick a tab first.');
    return res.redirect('/calendar');
  }
  const title = String(req.body.title || '').trim();
  if (!title) {
    setFlash(req, 'error', 'Please give the task a title.');
    return res.redirect('/calendar');
  }
  const offset = parseOffset(req.body.tz_offset);
  const startAt = req.body.start ? utcFromLocalInput(req.body.start, offset) : null;
  const dueAt = req.body.due ? utcFromLocalInput(req.body.due, offset) : null;
  db.prepare('INSERT INTO tasks (user_id, tab_id, title, start_at, due_at, tz_offset) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, tab.id, title.slice(0, 200), startAt, dueAt, offset);
  res.redirect('/calendar');
});

app.post('/tasks/:id/toggle', ensureAuth, (req, res) => {
  const task = getTask(req.user.id, req.params.id);
  if (!task) return res.redirect('/home');
  const target = task.done ? 0 : 1;
  const ids = [task.id];
  const stack = [task.id];
  while (stack.length) {
    const id = stack.pop();
    for (const c of db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(id)) {
      ids.push(c.id);
      stack.push(c.id);
    }
  }
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE tasks SET done = ? WHERE id IN (${placeholders})`).run(target, ...ids);
  res.redirect(`/tabs/${task.tab_id}`);
});

app.post('/tasks/:id/delete', ensureAuth, (req, res) => {
  const task = getTask(req.user.id, req.params.id);
  if (!task) return res.redirect('/home');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  res.redirect(`/tabs/${task.tab_id}`);
});

app.post('/tasks/:id/subtask', ensureAuth, (req, res) => {
  const parent = getTask(req.user.id, req.params.id);
  if (!parent) return res.redirect('/home');
  const title = String(req.body.title || '').trim();
  if (title) {
    db.prepare('INSERT INTO tasks (user_id, tab_id, parent_id, title, tz_offset) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, parent.tab_id, parent.id, title.slice(0, 200), parent.tz_offset);
  }
  res.redirect(`/tabs/${parent.tab_id}`);
});

app.post('/tasks/:id/schedule', ensureAuth, (req, res) => {
  const task = getTask(req.user.id, req.params.id);
  if (!task) return res.redirect('/home');
  const offset = parseOffset(req.body.tz_offset);
  const startAt = req.body.start ? utcFromLocalInput(req.body.start, offset) : null;
  const dueAt = req.body.due ? utcFromLocalInput(req.body.due, offset) : null;
  db.prepare('UPDATE tasks SET start_at = ?, due_at = ?, tz_offset = ?, reminded = 0, reminded_start = 0, reminded_due = 0 WHERE id = ?')
    .run(startAt, dueAt, offset, task.id);
  res.redirect(`/tabs/${task.tab_id}`);
});

/* ------------------------------ calendar ------------------------------ */

app.get('/calendar', ensureAuth, (req, res) => {
  const now = new Date();
  let y = parseInt(req.query.y, 10);
  let m = parseInt(req.query.m, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 0 || m > 11) {
    y = now.getUTCFullYear();
    m = now.getUTCMonth();
  }

  const rows = db.prepare(`
    SELECT k.id, k.title, k.start_at, k.due_at, k.tz_offset, k.done, k.tab_id, b.color, b.name AS tab_name
    FROM tasks k
    JOIN tabs b ON b.id = k.tab_id
    WHERE k.user_id = ? AND k.parent_id IS NULL AND (k.start_at IS NOT NULL OR k.due_at IS NOT NULL)
  `).all(req.user.id);

  const byDay = new Map();
  for (const r of rows) {
    const hasDue = Boolean(r.due_at);
    const anchor = r.start_at || r.due_at;
    const from = dayKey(anchor, r.tz_offset);
    const to = hasDue ? dayKey(r.due_at, r.tz_offset) : from;
    const pStart = localParts(anchor, r.tz_offset);
    const pDue = hasDue ? localParts(r.due_at, r.tz_offset) : pStart;
    const cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    let steps = 0;
    while (cursor <= end && steps < 92) {
      const key = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`;
      const isStart = key === from;
      const isDue = hasDue && key === to;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({
        id: r.id,
        tab_id: r.tab_id,
        title: r.title,
        color: r.color,
        done: Boolean(r.done),
        time: isStart ? `${pad(pStart.hh)}:${pad(pStart.mm)}` : (isDue ? `${pad(pDue.hh)}:${pad(pDue.mm)}` : ''),
        isStart,
        isDue,
        overdue: hasDue && !r.done && Date.parse(r.due_at) < Date.now()
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      steps += 1;
    }
  }

  const todayKey = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const prev = new Date(Date.UTC(y, m - 1, 1));
  const next = new Date(Date.UTC(y, m + 1, 1));
  const dayParam = String(req.query.day || '');
  const prefillDate = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : '';
  const calendarToken = ensureCalendarToken(req.user.id);

  res.render('calendar', {
    title: 'Calendar',
    y, m,
    grid: buildGrid(y, m, byDay),
    monthLabel: `${MONTHS_FULL[m]} ${y}`,
    prevLink: `/calendar?y=${prev.getUTCFullYear()}&m=${prev.getUTCMonth()}`,
    nextLink: `/calendar?y=${next.getUTCFullYear()}&m=${next.getUTCMonth()}`,
    todayKey,
    prefillDate,
    feedUrl: `${BASE_URL}/feed/${calendarToken}.ics`
  });
});

app.post('/calendar/reset-token', ensureAuth, (req, res) => {
  const token = randomToken();
  db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(token, req.user.id);
  setFlash(req, 'success', 'New calendar link created. Update your calendar app with it.');
  res.redirect('/calendar');
});

/* ---------------------------- calendar feed ---------------------------- */

/* Public iCal feed of a user's task deadlines (Apple/Google subscribe here). */
app.get('/feed/:token.ics', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[0-9a-f]{48}$/.test(token)) return res.status(404).send('Not found');
  const user = db.prepare('SELECT id, name FROM users WHERE calendar_token = ?').get(token);
  if (!user) return res.status(404).send('Not found');

  const tasks = db.prepare(`
    SELECT k.id, k.title, k.start_at, k.due_at, k.done, k.created_at, b.name AS tab_name
    FROM tasks k
    JOIN tabs b ON b.id = k.tab_id
    WHERE k.user_id = ? AND k.parent_id IS NULL AND (k.start_at IS NOT NULL OR k.due_at IS NOT NULL)
  `).all(user.id);

  const reminderOffset = /^P(\d+[WDHMS])+$/i.test(String(process.env.CAL_REMIND_OFFSET || '').trim())
    ? String(process.env.CAL_REMIND_OFFSET).trim()
    : 'P2D';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Planner//Planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Planner',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];
  for (const t of tasks) {
    const anchor = t.start_at || t.due_at;
    const start = new Date(anchor);
    if (isNaN(start.getTime())) continue;
    let end;
    if (t.due_at) {
      const due = new Date(t.due_at);
      end = due.getTime() > start.getTime() ? due : new Date(start.getTime() + 60 * 60 * 1000);
    } else {
      end = new Date(start.getTime() + 60 * 60 * 1000);
    }
    const dtstamp = sqliteStamp(t.created_at) || icsStamp(anchor);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:task-${t.id}@planner`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${icsStamp(start.toISOString())}`);
    lines.push(`DTEND:${icsStamp(end.toISOString())}`);
    lines.push(`SUMMARY:${icsText(`${t.title} — ${t.tab_name}`)}`);
    lines.push(`DESCRIPTION:${icsText(`Task in tab "${t.tab_name}" · ${BASE_URL}`)}`);
    if (t.done) {
      lines.push('STATUS:CANCELLED');
    } else {
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${icsText(`Reminder: ${t.title} is due soon`)}`);
      lines.push(`TRIGGER:-${reminderOffset}`);
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(lines.map(foldLine).join('\r\n') + '\r\n');
});

/* ------------------------------ fallbacks ----------------------------- */

app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  console.error(`[server] error on ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  res.status(500).send('Something went wrong.');
});

/* -------------------------------- start ------------------------------- */

startScheduler();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Planner listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] Public URL (BASE_URL): ${BASE_URL}`);
  console.log(`[server] Google login: ${googleEnabled ? 'enabled' : 'disabled'}`);
  if (googleEnabled) console.log(`[server] Google callback URL: ${GOOGLE_CALLBACK_URL}`);
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-me') {
    console.warn('[server] WARNING: SESSION_SECRET is not set — set a strong secret in .env');
  }
});
