'use strict';

const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { db } = require('./db');

/* Minimal SQLite-backed session store (survives restarts, no extra deps). */
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    setInterval(() => {
      try {
        db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
      } catch (_) { /* ignore cleanup errors */ }
    }, 60 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?').get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (err) { console.error('[session-store] get error:', err.message); cb(err); }
  }

  set(sid, sess, cb) {
    try {
      const expires = Date.now() + (sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 24 * 3600 * 1000);
      db.prepare(
        'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'
      ).run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (err) {
      /* If this fails (e.g. the data volume is read-only), users get logged
         in and immediately bounced back to /login — log it loudly. */
      console.error('[session-store] set error:', err.message);
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (err) { console.error('[session-store] destroy error:', err.message); cb(err); }
  }

  touch(sid, sess, cb) {
    try {
      const expires = Date.now() + (sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 24 * 3600 * 1000);
      db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
      cb(null);
    } catch (err) { console.error('[session-store] touch error:', err.message); cb(err); }
  }
}

const sessionMiddleware = session({
  store: new SqliteSessionStore(),
  name: 'planner.sid',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000,
    /* 'auto' sets the Secure flag whenever the request arrived over HTTPS
       (through the reverse proxy — see `trust proxy` in server.js). This
       works both behind a TLS-terminating proxy and when hit directly. */
    secure: 'auto'
  }
});

const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function initPassport() {
  /* Email + password */
  passport.use(new LocalStrategy(
    { usernameField: 'email', passwordField: 'password' },
    (email, password, done) => {
      try {
        const user = db.prepare('SELECT * FROM users WHERE email = ?')
          .get(String(email || '').trim().toLowerCase());
        if (!user || !user.password_hash) return done(null, false, { message: 'Invalid email or password.' });
        if (!bcrypt.compareSync(password, user.password_hash)) return done(null, false, { message: 'Invalid email or password.' });
        return done(null, user);
      } catch (err) { return done(err); }
    }
  ));

  /* Google OAuth (only when configured) */
  if (googleEnabled) {
    const GoogleStrategy = require('passport-google-oauth20').Strategy;
    const base = String(process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
    console.log(`[auth] Google OAuth callback URL: ${base}/auth/google/callback`);
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: base + '/auth/google/callback'
    }, (accessToken, refreshToken, profile, done) => {
      try {
        const email = String((profile.emails && profile.emails[0] && profile.emails[0].value) || '').toLowerCase();
        if (!email) return done(null, false, { message: 'Your Google account has no email address.' });
        let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);
        if (!user) user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (user) {
          if (!user.google_id) db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(profile.id, user.id);
          return done(null, user);
        }
        const name = profile.displayName || email.split('@')[0];
        const info = db.prepare('INSERT INTO users (email, name, google_id) VALUES (?, ?, ?)')
          .run(email, name.slice(0, 60), profile.id);
        return done(null, { id: info.lastInsertRowid, email, name });
      } catch (err) { return done(err); }
    }));
  }

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    try {
      const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(id);
      done(null, user || false);
    } catch (err) { done(err); }
  });
}

function setFlash(req, type, msg) {
  req.session.flash = { type, msg };
}

function ensureAuth(req, res, next) {
  if (req.user) return next();
  setFlash(req, 'error', 'Please log in first.');
  return res.redirect('/login');
}

module.exports = { sessionMiddleware, initPassport, ensureAuth, setFlash, passport, googleEnabled };
