# Board Room

An instructor-run, Jeopardy-style training game. One instructor drives a board on a
projector or screen share; the group answers out loud. Boards are built from CSV,
stored per instructor group, and playable with live scoring, undo, and session resume.

## Requirements

- Node.js **24+** (the app runs Prisma's generated TypeScript client directly via
  Node's built-in type stripping — no build step)
- Docker (for local PostgreSQL)

## Local setup (fresh clone)

```sh
# 1. Install dependencies (also generates the Prisma client)
npm install

# 2. Create your local env file
cp .env.example .env
#    Edit .env: set ADMIN_PASSWORD and SESSION_SECRET to real values.
#    The default DATABASE_URL matches docker-compose.yml — leave it as is.

# 3. Start PostgreSQL
docker compose up -d

# 4. Apply database migrations
npx prisma migrate dev

# 5. Start the server
npm start
```

The app is now at <http://localhost:3000>. `GET /healthz` returns 200 when the
server can reach the database, 503 when it cannot.

## Environment variables

All configuration is via environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Site-owner admin credential (not a database row) |
| `SESSION_SECRET` | Signs session cookies — long random string in production |
| `PORT` | Listen port (Railway sets this) |

## Tests

```sh
npm test
```

Tests require the local Postgres container to be running.
