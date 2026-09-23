'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'planner.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT,
  google_id     TEXT,
  calendar_token TEXT
);

CREATE TABLE IF NOT EXISTS tabs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  color    TEXT NOT NULL DEFAULT 'indigo',
  position INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES tabs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tab_id   INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tab_id     INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  group_id   INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  start_at   TEXT,
  due_at     TEXT,
  tz_offset  INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  reminded   INTEGER NOT NULL DEFAULT 0,
  reminded_start INTEGER NOT NULL DEFAULT 0,
  reminded_due INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
CREATE INDEX IF NOT EXISTS idx_tasks_tab ON tasks(tab_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_groups_tab ON groups(tab_id);
`);

/* Migration: databases created before groups existed. */
const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
if (!taskColumns.includes('group_id')) {
  db.exec('ALTER TABLE tasks ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL');
}

/* Migration: databases created before tab grouping existed. */
const tabColumns = db.prepare('PRAGMA table_info(tabs)').all().map((c) => c.name);
if (!tabColumns.includes('parent_id')) {
  db.exec('ALTER TABLE tabs ADD COLUMN parent_id INTEGER REFERENCES tabs(id) ON DELETE SET NULL');
}

/* Migration: databases created before the calendar feed existed. */
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('calendar_token')) {
  db.exec('ALTER TABLE users ADD COLUMN calendar_token TEXT');
}

/* Migration: databases created before start dates and staged reminders existed. */
const taskCols2 = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
if (!taskCols2.includes('start_at')) {
  db.exec('ALTER TABLE tasks ADD COLUMN start_at TEXT');
}
if (!taskCols2.includes('reminded_start')) {
  db.exec('ALTER TABLE tasks ADD COLUMN reminded_start INTEGER NOT NULL DEFAULT 0');
}
if (!taskCols2.includes('reminded_due')) {
  db.exec('ALTER TABLE tasks ADD COLUMN reminded_due INTEGER NOT NULL DEFAULT 0');
}

module.exports = { db, DATA_DIR };
