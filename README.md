# Board Room

An instructor-run, Jeopardy-style training game. One instructor drives a board on a
projector or screen share; the group answers out loud. Boards are built from CSV,
stored per instructor group, and playable with live scoring, undo, a final round,
and session resume.

## Requirements

- Node.js **24+** (the app runs Prisma's generated TypeScript client directly via
  Node's built-in type stripping — no build step)
- Docker (for local PostgreSQL)

## Local setup (fresh clone)

```sh
# 1. Install dependencies (postinstall generates the Prisma client)
npm install

# 2. Create your local env file
cp .env.example .env
#    Edit .env: set ADMIN_USER, ADMIN_PASSWORD and SESSION_SECRET to real values.
#    The default DATABASE_URL matches docker-compose.yml — leave it as is.

# 3. Start PostgreSQL
docker compose up -d

# 4. Apply database migrations
npx prisma migrate dev

# 5. Start the server (applies any pending migrations first)
npm start
```

The app is now at <http://localhost:3000>. `GET /healthz` returns 200 when the
server can reach the database, 503 when it cannot. `npm run seed` creates two demo
instructor profiles (Steam Ops / demo-pass-a, Night Shift / demo-pass-b).

## Environment variables

All configuration is via environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Site-owner admin credential (not a database row); signs in at `/admin` |
| `SESSION_SECRET` | Signs session cookies — long random string in production |
| `REGISTRATION_CODE` | Instructor sign-up: unset = open, `off` = disabled, anything else = required invite code |
| `PORT` | Listen port (Railway sets this) |
| `NODE_ENV` | `production` turns on Secure cookies; Railway is detected automatically |

## Who logs in where

- **Instructors** sign in on the home page with a *profile*: a shared group login
  (name + one password) that owns its own bucket of boards and games. New instructors
  create a profile with "Create an instructor login" (gated by `REGISTRATION_CODE`),
  and can change the profile's password from the library.
- **The site admin** signs in at `/admin` with `ADMIN_USER` / `ADMIN_PASSWORD` and
  can create, rename, reset the password of, or delete instructor profiles; see,
  move, and delete every board; force-end live games; and download a full backup.
  Deleting a profile is blocked while it still owns boards or games.

## Running a game

Boards come from CSV (`topic,points,question,answer`, one row per question). In
the editor you can upload a file, paste text, or paste straight from Excel /
Google Sheets (tab-separated text is detected and converted). "Download template"
gives you a blank 6 × 5 board to fill in. To add a **final round**, include one row
whose points column is the word `final`: the topic column becomes the final category.
During the game a ★ Final round button appears; teams wager up to their score, the
question is shown with ~30 seconds of think music, then each team is judged ±wager.

During a live game:

| Key | Action |
|---|---|
| `Space` | Reveal the answer |
| `1`–`6` / `Shift`+`1`–`6` | Mark player 1–6 correct / wrong (after reveal, and in the final round) |
| `N` | No one got it — close the question |
| `Esc` | Back to the board |
| `R` | Pick a random open question |
| `U` | Undo the last scoring event |
| `M` | Mute / unmute sound effects |
| `F` | Toggle fullscreen |
| `?` | Shortcut help |

Shortcuts never fire while typing in a text field. Sound, colour theme and
"last time's teams" are remembered per browser; all game state lives on the
server, so refreshing or switching machines resumes the game exactly.

## Tests

```sh
npm test
```

Tests require the local Postgres container to be running. They reset the database,
so run `npm run seed` afterwards if you want the demo profiles back.

## Deploying to Railway

The repo is shaped for Railway: config via env vars only, binds `0.0.0.0` on
`PORT`, `/healthz` for health checks, migrations run before each deploy
(`railway.json`), Secure cookies when `RAILWAY_ENVIRONMENT` is present.

1. **Push the repo to GitHub** (never commit `.env`; `.gitignore` already excludes it).
2. In Railway: **New Project → Deploy from GitHub repo** → pick this repo. Railway
   builds with Railpack (Node 24 from `engines`), runs `npm install` (which generates
   the Prisma client), then `npm start`.
3. **Add a database**: in the project, **+ New → Database → PostgreSQL**.
4. **Set variables** on the app service (Variables tab):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference the Postgres service) |
   | `ADMIN_USER` | your admin login name |
   | `ADMIN_PASSWORD` | a strong password |
   | `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `REGISTRATION_CODE` | an invite code to give new instructors (or `off`) |
   | `NODE_ENV` | `production` |

5. **Deploy**. `npm start` runs `prisma migrate deploy` before booting the server, so
   the schema is created/updated on every deploy; `railway.json` also lists it as a
   pre-deploy command and points the health check at `/healthz`.
6. **Generate a public domain** on the service (Settings → Networking). Open it,
   create the first instructor login (with the invite code), and sign in at
   `/admin` with the admin credentials.

If `npm install` on Railway ever skips dev dependencies, nothing breaks: `prisma`
is a runtime dependency on purpose.

### Backups

Two independent copies:

- **Railway Postgres backups** — in the Railway dashboard open the Postgres service →
  **Backups** and enable the schedule (daily/weekly/monthly, plan-dependent). This is
  a full database snapshot you can restore from the same tab.
- **App-level JSON backup** — provider-independent. The admin panel's
  **Download full backup** button, or from the CLI:

  ```sh
  npm run backup                       # local DB → backups/board-room-backup-<date>.json
  railway run npm run backup           # same, against the Railway database
  npm run restore -- backups/<file>    # into whatever DATABASE_URL points at
  ```

  The file holds every instructor profile (with its bcrypt password hash, so logins
  survive a restore) and every board. Treat it like the database itself. Restore
  matches profiles by name and never overwrites an existing board; pass
  `--reset-passwords` to also replace existing profiles' passwords with the backup's.
  Live game sessions are not included — they are ephemeral.
