'use strict';

const cron = require('node-cron');
const { db } = require('./db');
const { sendDeadlineReminder, sendStartReminder } = require('./mailer');

const BASE_URL = String(process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

/**
 * Find unfinished top-level tasks whose start or deadline falls within the
 * reminder window (or is already past) and send one email per stage.
 */
async function checkDeadlines() {
  const hours = parseFloat(process.env.REMIND_HOURS || '24');
  const windowMs = (Number.isFinite(hours) ? hours : 24) * 3600 * 1000;
  const now = Date.now();

  const rows = db.prepare(`
    SELECT t.id, t.title, t.start_at, t.due_at, t.reminded_start, t.reminded_due, u.email, u.name
    FROM tasks t
    JOIN users u ON u.id = t.user_id
    WHERE t.done = 0 AND t.parent_id IS NULL
      AND (t.start_at IS NOT NULL OR t.due_at IS NOT NULL)
  `).all();

  let sent = 0;
  for (const row of rows) {
    const startMs = Date.parse(row.start_at || '');
    const dueMs = Date.parse(row.due_at || '');

    if (Number.isFinite(startMs) && !row.reminded_start && startMs <= now + windowMs) {
      try {
        await sendStartReminder({
          email: row.email,
          name: row.name,
          title: row.title,
          startAt: row.start_at,
          dueAt: row.due_at,
          url: BASE_URL
        });
        db.prepare('UPDATE tasks SET reminded_start = 1 WHERE id = ?').run(row.id);
        sent += 1;
      } catch (err) {
        console.error(`[scheduler] failed start reminder for task ${row.id}: ${err.message}`);
      }
    }

    if (Number.isFinite(dueMs) && !row.reminded_due && dueMs <= now + windowMs) {
      try {
        await sendDeadlineReminder({
          email: row.email,
          name: row.name,
          title: row.title,
          dueAt: row.due_at,
          overdue: dueMs < now,
          url: BASE_URL
        });
        db.prepare('UPDATE tasks SET reminded_due = 1 WHERE id = ?').run(row.id);
        sent += 1;
      } catch (err) {
        console.error(`[scheduler] failed deadline reminder for task ${row.id}: ${err.message}`);
      }
    }
  }
  if (sent) console.log(`[scheduler] sent ${sent} reminder(s)`);
}

function startScheduler() {
  const schedule = process.env.CRON_SCHEDULE || '0 8 * * *';
  try {
    const options = process.env.TZ ? { timezone: process.env.TZ } : undefined;
    cron.schedule(schedule, () => {
      checkDeadlines().catch((err) => console.error('[scheduler] error:', err));
    }, options);
    console.log(`[scheduler] deadline check scheduled at "${schedule}"${process.env.TZ ? ' (' + process.env.TZ + ')' : ''}`);
  } catch (err) {
    console.error(`[scheduler] invalid CRON_SCHEDULE, reminders disabled: ${err.message}`);
  }
  /* Catch-up check shortly after boot (e.g. reminders missed while offline). */
  setTimeout(() => {
    checkDeadlines().catch((err) => console.error('[scheduler] boot check error:', err));
  }, 10 * 1000);
}

module.exports = { startScheduler, checkDeadlines };
