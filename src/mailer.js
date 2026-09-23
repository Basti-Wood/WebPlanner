'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { DATA_DIR } = require('./db');

/* Build a transport only if SMTP is configured. */
let transporter = null;
if (process.env.SMTP_HOST) {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined
  });
}

const FROM = process.env.SMTP_FROM || 'Planner <noreply@planner.local>';

/* Send via SMTP or save to ./data/outbox when SMTP is not configured. */
async function deliver({ to, subject, text, html }) {
  if (transporter) {
    await transporter.sendMail({ from: FROM, to, subject, text, html });
    console.log(`[mailer] sent "${subject}" to ${to}`);
  } else {
    const outbox = path.join(DATA_DIR, 'outbox');
    fs.mkdirSync(outbox, { recursive: true });
    const file = path.join(outbox, `reminder-${Date.now()}.txt`);
    fs.writeFileSync(file, `To: ${to}\nFrom: ${FROM}\nSubject: ${subject}\n\n${text}`);
    console.log(`[mailer] SMTP not configured — saved "${subject}" to ${file}`);
  }
  return true;
}

function footer() {
  return 'This is an automated message from your Planner — please do not reply.';
}

/* Deadline reminder (approaching or overdue). */
async function sendDeadlineReminder({ email, name, title, dueAt, overdue, url }) {
  const dueText = new Date(dueAt).toUTCString();
  const subject = overdue ? `Overdue task: ${title}` : `Deadline approaching: ${title}`;
  const bodyLine = overdue
    ? `is now overdue (was due ${dueText}).`
    : `is due on ${dueText}.`;
  const text = `Hi ${name || 'there'},\n\nYour task "${title}" ${bodyLine}\n\nOpen your planner to check it off: ${url}\n\n${footer()}`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:520px">
    <p>Hi ${name || 'there'},</p>
    <p>Your task <strong>"${title}"</strong> ${bodyLine}</p>
    <p><a href="${url}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open planner</a></p>
    <p style="color:#94a3b8;font-size:12px">${footer()}</p>
  </div>`;
  return deliver({ to: email, subject, text, html });
}

/* Start reminder (task is starting soon or has already started). */
async function sendStartReminder({ email, name, title, startAt, dueAt, url }) {
  const started = Date.parse(startAt) < Date.now();
  const startText = new Date(startAt).toUTCString();
  const subject = started ? `Started: ${title}` : `Starting: ${title}`;
  const bodyLine = started
    ? `has started (start date ${startText}).`
    : `starts on ${startText}.`;
  const dueLine = dueAt ? `\nIt is due on ${new Date(dueAt).toUTCString()}.` : '';
  const text = `Hi ${name || 'there'},\n\nYour task "${title}" ${bodyLine}${dueLine}\n\nOpen your planner: ${url}\n\n${footer()}`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:520px">
    <p>Hi ${name || 'there'},</p>
    <p>Your task <strong>"${title}"</strong> ${bodyLine}</p>
    ${dueAt ? `<p>It is due on ${new Date(dueAt).toUTCString()}.</p>` : ''}
    <p><a href="${url}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open planner</a></p>
    <p style="color:#94a3b8;font-size:12px">${footer()}</p>
  </div>`;
  return deliver({ to: email, subject, text, html });
}

module.exports = { sendDeadlineReminder, sendStartReminder, hasTransport: Boolean(transporter) };
