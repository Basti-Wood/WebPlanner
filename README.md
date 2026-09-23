# 📅 Planner

A lightweight, self-hosted personal planner that runs entirely in Docker.

- **Tasks & subtasks** — every task can have checkable subtasks, with per-task progress.
- **Groups** — drag & drop tasks into groups within a tab.
- **Tabs** — create your own tabs (e.g. “PC tasks”, “Household”, …) with colors; drag one tab onto another to group them. Nothing is pre-filled.
- **Home** — one overview of everything: overall % done, open tasks, per-tab progress, upcoming deadlines.
- **Calendar** — month view that shows all tasks on their due dates (overdue ones in red).
- **Login** — email + password, or Google sign-in.
- **Dark mode** — 🌙/☀️ toggle in the header, remembered per browser.
- **Deadline emails** — a scheduled check sends a `noreply` email when a task's deadline approaches (or passes).
- **Lightweight** — Node.js + Express + SQLite, server-rendered Tailwind CSS, no frontend framework.

## Quick start

```bash
# 1. configure (optional)
copy .env.example .env        # Windows: copy .env.example .env

# 2. build & start
docker compose up -d --build

# 3. open
# http://localhost:3000
```

Register a new account, create a tab, and you're ready to plan.

Your data (SQLite database) lives in the `planner_data` Docker volume, so it survives container restarts/rebuilds.

## Configuration (.env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_PORT` | `3000` | Port the website is exposed on |
| `BASE_URL` | `http://localhost:3000` | Public URL (used for Google OAuth callback + email links) |
| `SESSION_SECRET` | *(must change!)* | Secret used to sign login sessions |
| `REMIND_HOURS` | `24` | Hours before a deadline that the reminder email is sent |
| `CRON_SCHEDULE` | `0 8 * * *` | When the daily deadline check runs |
| `TZ` | `UTC` | Timezone used for that schedule |

### Google login (optional)

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create an **OAuth consent screen** and **OAuth Client ID** (Web application).
2. Add `http://localhost:3000/auth/google/callback` (or `https://your-domain/auth/google/callback`) as an authorized redirect URI.
3. Put the credentials in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and restart with `docker compose up -d`.

If unset, the Google button is hidden and email/password login still works.

### Can't log in on your server? (works locally, fails on the server)

The most common causes, in order:

1. **`BASE_URL` is wrong on the server.** It must be the URL you open in the browser, e.g. `BASE_URL=https://planner.bastiwood.com`. If you copied your local `.env` to the server it may still say `http://localhost:3030`, which makes Google redirect the browser to *your* machine and breaks the OAuth callback. Check what the container actually uses:
   ```bash
   docker compose logs planner | grep 'Public URL'
   ```
2. **The Google redirect URI isn't registered.** In Google Cloud Console → your OAuth client → *Authorized redirect URIs*, add `https://planner.bastiwood.com/auth/google/callback` (must match `BASE_URL` exactly). Also make sure your OAuth consent screen is **published** (or your account is listed as a test user). If you see Google's `redirect_uri_mismatch` error page, this is it.
3. **The proxy forwards HTTPS correctly.** Caddy/Nginx must terminate TLS and forward requests to the container (the app trusts one proxy hop and sets the `Secure` cookie accordingly). If you open the site over plain `http://` while the cookie is `Secure`, the browser drops it and logins loop back to the login page.
4. **The database volume is writable.** `docker compose logs planner` — if you see `[session-store] set error`, the `planner_data` volume is not writable by the `node` user.
5. **The account really exists on the server.** The server has its own SQLite database — accounts created locally aren't on the server. Register again on the server.

After changing `.env`, rebuild/restart: `docker compose up -d --build`. Failed local logins are logged (`[auth] local login failed for …`), so `docker compose logs -f planner` will tell you exactly why a login was rejected.

### Deadline emails (optional)

Set these in `.env` to send real emails through any SMTP server:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-account@gmail.com
SMTP_PASS=your-app-password        # for Gmail: an App password
SMTP_FROM=Planner <noreply@yourdomain.com>
```

> If SMTP is **not** configured, reminders are still generated and saved to `./data/outbox/` inside the container (and printed in the logs), so you can see what would have been sent.

How it works: once a day (per `CRON_SCHEDULE`), every unfinished task whose start or deadline falls within the next `REMIND_HOURS` — or is already past — triggers an email: one when the task **starts** (if it has a start date) and one when the **deadline** approaches (or passes). Each stage emails only once; re-editing the dates re-arms them.

## Sync with Apple / Google Calendar (iCal feed)

The Calendar page has a private subscription link. Both Apple Calendar and Google Calendar can subscribe to it:

- **Apple Calendar** — File → New Calendar Subscription, paste the link (on iPhone: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar).
- **Google Calendar** — Other calendars → From URL, paste the link.

Notes:

- Tasks can have a **start** and a **due** date — they appear in your calendar for the whole span. Checking a task off marks it cancelled in the feed, so it disappears.
- The feed includes an alert `CAL_REMIND_OFFSET` before the deadline (default `P2D` = 2 days). Apple Calendar honors feed alarms; Google does not show alarms for subscribed calendars — the built-in email reminders cover you there.
- Google fetches the link from the internet, so `BASE_URL` must be publicly reachable (Apple Calendar works locally too).
- The link is secret — treat it like a password. "New link" on the Calendar page invalidates the old one.

## Local development (without Docker)

```bash
npm install
npm run build:css     # compiles Tailwind CSS into public/css/main.css
node src/server.js    # needs the same env vars as .env.example
```

## Project layout

```
src/server.js       Express app + routes
src/db.js           SQLite schema (users, tabs, tasks, sessions)
src/auth.js         Passport (local + Google) and session store
src/mailer.js       Nodemailer (falls back to ./data/outbox)
src/scheduler.js    Daily deadline check (node-cron)
views/              EJS templates (Tailwind classes)
public/css/input.css Tailwind entry point
```

## Notes

- Due dates are converted using your browser's timezone when you create a task, so they display correctly no matter what timezone the container runs in.
- Passwords are hashed with bcrypt; Google users are linked by Google ID/email.
- This is a small single-node app — perfect for one or a few users on a home server. Put a reverse proxy (e.g. Caddy/Nginx + HTTPS) in front if you expose it to the internet.
