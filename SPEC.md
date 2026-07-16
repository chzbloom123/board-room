# Board Room — Build Specification (v1)

A reusable, instructor-run Jeopardy-style training game. Replaces the PowerPoint boards
training teams rebuild from scratch every session.

This document is the contract for the build. Where it says a thing is out of scope, do not
build it. Where it gives an acceptance criterion, the feature is not done until that
criterion is demonstrated, not asserted.

---

## 1. Problem and Users

**Problem.** Training teams rebuild the same Jeopardy review game in PowerPoint every time.
Slow, fragile mid-session, and the result can't be reused or handed off.

**Primary user.** One instructor running a live session — in a room on a projector, or over
screen share. The group watches and answers out loud. No player devices. The instructor is
the only person touching the app.

**Secondary use.** Casual play at home on a second screen. Same flows, no special handling.

**Success looks like:**
- An instructor who has never seen the tool builds and runs a board without instructions.
- During a session, everything needed (board, scores, judging) is visible without menu hunting.
- It feels like a game show board, not a spreadsheet.

---

## 2. Architecture

| Layer | Choice |
|---|---|
| Backend | Node.js + Fastify |
| ORM | Prisma |
| Database | PostgreSQL |
| Frontend | Vanilla JS / HTML / CSS, served statically by Fastify. **No React, no framework, no build step.** |
| Dev environment | localhost, Docker for Postgres |
| Deployment target | Railway (spec everything toward it from day one; see §9) |

**Frontend note.** The UI is three screens plus a modal (library, board editor, live game).
Plain JS modules are sufficient. Do not introduce a bundler, a framework, or a build
pipeline. If a file is served, it is the file that was written.

**A visual prototype exists** (single-file HTML from an earlier design pass). Treat it as a
reference for look, feel, and layout — navy/gold game-show aesthetic, board grid, question
modal, scoreboard — not as code to port. Its storage layer (`window.storage`) does not
exist outside the prototype environment and must not appear in this build.

---

## 3. Auth Model — Two Layers, Deliberately Small

This is light multi-tenancy via app-level scoping. It is **not** DayZero. Explicit
non-goals: no RLS, no per-user accounts, no registration, no roles beyond the two below,
no email, no password reset flows (admin resets passwords manually).

### Instructor profiles
- A profile is a **shared group credential**: a profile name + one password used by the
  whole group (e.g., "Steam Ops"). No individual identities inside a group, by design.
- Each profile is a bucket. Boards and game sessions belong to exactly one profile.
  A logged-in profile sees only its own bucket.
- Scoping is enforced server-side on every query (`WHERE owner_profile_id = ?`).
  Never trust a client-supplied profile id.
- **Concurrent logins per profile are allowed.** Two instructors from the same group may
  be logged in and running different sessions simultaneously. Do not build single-session
  enforcement.

### Admin (site owner)
- A single credential from environment variables (`ADMIN_USER`, `ADMIN_PASSWORD`).
  Not a row in the profiles table.
- Admin capabilities: create / rename / delete instructor profiles; reset a profile's
  password; view all buckets; move a board between buckets; delete any board; force-end
  any game session.
- Admin UI can be plain and utilitarian. It is a maintenance hatch, not a product surface.

### Session mechanics
- Passwords stored as bcrypt (or argon2) hashes. Never plaintext, never logged.
- Login state in an **HttpOnly, SameSite cookie**. 
- **Invariant (tested, not assumed): no auth token, session id, or credential ever appears
  in a URL.** This app's URL will be on a projector. See acceptance criteria §8.

---

## 4. Data Model

Lean on JSONB. A board is naturally a document; do not normalize topics/questions into
join tables.

```prisma
model InstructorProfile {
  id           String   @id @default(cuid())
  name         String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
  boards       Board[]
  sessions     GameSession[]
}

model Board {
  id             String   @id @default(cuid())
  ownerProfileId String
  name           String
  topics         Json     // [{ name, cells: [{ points, question, answer }] }]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  owner          InstructorProfile @relation(fields: [ownerProfileId], references: [id])
}

model GameSession {
  id             String   @id @default(cuid())
  ownerProfileId String
  boardId        String
  state          Json     // { players: [{ name, color, score }], usedCells: [[ti,ci]], log: [...] }
  status         String   // "active" | "finished"
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  owner          InstructorProfile @relation(fields: [ownerProfileId], references: [id])
}
```

The session `state.log` is an append-only list of scoring events
(`{ playerIdx, points, correct, topicIdx, cellIdx, ts }`). Undo (§6.5) is implemented by
reverting the last log entry — the log is the mechanism, not a separate feature.

---

## 5. CSV Format and Validation

One row per question: `topic,points,question,answer`. Header row auto-detected and
skipped. Standard CSV quoting (fields containing commas wrapped in double quotes,
embedded quotes doubled).

**Board shape is flexible with warnings.** The classic 6 topics × 100–500 is the
reference shape, not a requirement.

**Errors (block save):**
- Row with fewer than 4 columns
- Missing topic, question, or answer
- Non-numeric points
- Duplicate point value within the same topic

**Warnings (allow save, show clearly):**
- Topic count ≠ 6
- Uneven question counts across topics
- Point values outside the 100–500 convention

Validation happens at parse time, before save, with row-level messages ("Row 12: points
'2OO' is not a number"). Import must never fail silently, and a bad CSV must never
produce a saved board that then breaks during a live session.

---

## 6. Features and Acceptance Criteria

### 6.1 Board library (per bucket)
List of the profile's boards with name, topic/question counts, and Play / Edit / Export /
Delete actions. Delete requires confirmation.
- **AC:** Two profiles with distinct boards; each sees only its own via UI *and* via
  direct API calls with the other's board ids (expect 403/404).

### 6.2 Create board from CSV
Paste or upload CSV, live-parse with preview table, errors/warnings per §5, save into the
logged-in bucket.
- **AC:** A fixture set of at least 6 broken CSVs (short row, bad points, dup points,
  missing answer, quoted commas, header/no-header) each produces the specified
  error/warning; the valid fixture saves and round-trips intact.

### 6.3 Edit existing board
Reopen a saved board's data as editable CSV text (regenerated from the stored JSON), same
validation pipeline, save updates in place.
- **AC:** Edit a question's text, save, reload — change persists; a validation error
  during edit leaves the stored board untouched.

### 6.4 Export / import JSON
Export a board as a standalone JSON file; import one into the current bucket. This is the
backup and colleague-handoff path.
- **AC:** Export → delete board → import restores it losslessly (deep-equal on topics).

### 6.5 Live game
Player setup (names/teams, distinct colors), then the board: click a value → question
modal → reveal answer → mark each player correct (+points) / wrong (−points) → cell
marked used. Scoreboard always visible, negative scores allowed and shown in red.
**Single-level undo:** a visible Undo button reverts the most recent scoring event
(score change and, if it closed the cell, the cell's used state).
- **AC:** Scripted playthrough: award, deduct, undo a deduction, undo after cell close —
  scores and board state correct at each step.

### 6.6 Session persistence and resume
Game state persists server-side on every scoring event and cell state change. Browser
refresh, tab close, or moving to another machine (same profile login) resumes the session
exactly. Library shows an "active session" indicator with a Resume option; instructor can
also end a session explicitly.
- **AC:** Mid-game, kill the tab, reopen from a different browser, log in, resume —
  scores, used cells, and undo availability identical.

### 6.7 Presentation mode
Fullscreen toggle designed for a projector: board and scoreboard large and legible from
the back of a room, question modal typography sized for distance. Keyboard shortcuts:
**Space** = reveal answer, **Esc** = close modal, **F** = toggle fullscreen. Shortcuts
must not fire while typing in an input.
- **AC:** Manual check at 1280×720: question text readable at distance (≥ ~40px
  effective), shortcuts work, shortcuts don't fire in text inputs.

### 6.8 Admin panel
Login via env credentials; manage profiles (create/rename/delete/reset password), view
all buckets, move/delete boards, force-end sessions.
- **AC:** Each admin action verified end-to-end; profile deletion defines and enforces a
  documented behavior for its boards (block-if-nonempty or cascade — pick one, document it).

---

## 7. Explicitly Out of Scope (v1)

Do not build, scaffold, or leave TODOs for:
- Daily Doubles, Final Jeopardy rounds, wagers, question timers
  (an instructor can run a final question verbally; not worth the code)
- Player-facing devices, buzzers, or a separate audience display
- Per-user accounts, registration, password-reset emails, roles
- RLS or database-level tenancy
- Analytics or scoring history beyond the current session
- React or any frontend framework; any bundler or build step

---

## 8. Security Acceptance Criteria (tested invariants)

1. No auth token, session id, or credential appears in any URL — verified by exercising
   every flow (login, play, resume, admin) while asserting on `location.href` and all
   fetch URLs.
2. A URL copied from a logged-in browser and opened in a clean browser lands on the login
   page, never in an authenticated state.
3. All bucket-scoped API routes reject requests for another profile's resources
   (automated test with two profiles).
4. Password hashes only; no credential material in logs.

---

## 9. Deployment Posture (Railway)

Build on localhost, deploy when done — but shaped for Railway from the first commit:

- All configuration via environment variables: `DATABASE_URL`, `ADMIN_USER`,
  `ADMIN_PASSWORD`, `SESSION_SECRET`, `PORT`. No config files with secrets; `.env` for
  local dev, git-ignored, with a committed `.env.example`.
- Server binds `0.0.0.0` and honors `PORT`.
- Prisma migrations run via a release/deploy command, not manually.
- A `/healthz` endpoint returning 200 for Railway health checks.
- Cookie `secure` flag environment-aware (on in production).
- Local Postgres via `docker compose up`; the same `DATABASE_URL` shape Railway provides.

- **AC:** Fresh clone + `.env` + `docker compose up` + migrate + start = working app,
  following only the README. No step that exists only in someone's head.

---

## 10. Build Order (summary — detailed phases live in PLAN.md)

1. Skeleton: Fastify, Prisma, Postgres via Docker, healthz, env config
2. Auth: profiles, admin, sessions, security invariants (§8) tested here, not later
3. Boards: CSV parse/validate against fixtures, CRUD, export/import
4. Game: play flow, scoring log, undo, persistence/resume
5. Presentation polish: fullscreen, shortcuts, projector legibility
6. Admin panel
7. Deployment readiness: README walkthrough test, Railway config check
