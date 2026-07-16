# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project State

This is a greenfield project. **SPEC.md is the build contract** (what to build) and **PLAN.md is the build plan** (in what order, and how completion is proven) — read both before doing any work. Where the spec says something is out of scope, do not build it; where it gives an acceptance criterion, the feature is not done until that criterion is demonstrated. If the spec and the plan conflict, stop and say so — do not resolve it silently.

**Board Room** — a reusable, instructor-run Jeopardy-style training game. One instructor drives the app live on a projector; the audience answers out loud. No player devices.

## Architecture (fixed by spec)

- **Backend:** Node.js + Fastify, Prisma ORM, PostgreSQL (Docker locally)
- **Frontend:** Vanilla JS/HTML/CSS served statically by Fastify. **No React, no framework, no bundler, no build step.** The served file is the written file. The UI is three screens (library, board editor, live game) plus a question modal.
- **Deployment:** Railway. Shape for it from the first commit: all config via env vars (`DATABASE_URL`, `ADMIN_USER`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `PORT`), bind `0.0.0.0`, `/healthz` endpoint, migrations run via deploy command, env-aware cookie `secure` flag.

## Expected Commands (once scaffolded)

- Local Postgres: `docker compose up`
- Prisma migrations: `npx prisma migrate dev`
- Local config: `.env` (git-ignored) with a committed `.env.example`

## Key Design Decisions

**Auth is two layers, deliberately small** (SPEC.md §3):
- Instructor profiles are *shared group credentials* (name + one password per group), not per-user accounts. Concurrent logins per profile are allowed — do not build single-session enforcement.
- Admin is a single env-var credential, not a database row. Admin UI is a plain maintenance hatch, not a product surface.
- Every query is scoped server-side (`WHERE owner_profile_id = ?`). Never trust a client-supplied profile id.
- **Hard invariant (tested, not assumed):** no auth token, session id, or credential ever appears in a URL — the app's URL will be on a projector. Login state lives in an HttpOnly, SameSite cookie. Passwords are bcrypt/argon2 hashes.

**Data model leans on JSONB** (SPEC.md §4): a board is a document (`topics` Json column), not normalized join tables. Game session `state.log` is an append-only list of scoring events; single-level undo works by reverting the last log entry — the log *is* the undo mechanism.

**CSV import** (SPEC.md §5): `topic,points,question,answer`, header auto-detected. Errors (block save) vs. warnings (allow save with notice) are enumerated in the spec. Validation happens at parse time with row-level messages; a bad CSV must never produce a saved board that breaks mid-session.

## Explicitly Out of Scope (do not build or leave TODOs for)

Daily Doubles / Final Jeopardy / wagers / timers, player devices or buzzers, per-user accounts or roles, RLS/database-level tenancy, analytics beyond the current session, any frontend framework or build step. (SPEC.md §7)

## Working the Plan (PLAN.md)

- **Phases run in order** (1 Skeleton → 2 Auth+security tests → 3 Boards/CSV → 4 Live game → 5 Presentation polish → 6 Admin → 7 Deployment readiness). A phase is complete only when every exit criterion has been **demonstrated** — a command run, a test passing, an output shown — never asserted. Don't start a phase until the prior phase's exit criteria are shown (exception: trivial fixes to earlier-phase regressions).
- **Human checkpoints (⛳)** after Phase 2 (login flows), Phase 4 (full playthrough), and Phase 7 (owner walkthrough): stop, present the state, and wait.
- **`issues.md` is an append-only log** — one entry (timestamp, phase, paragraph, what was done) per surprise, workaround, spec deviation, library quirk, or unruled decision. Never edit or delete past entries. Write-heavy, read-light: don't re-read the full log before decisions. Distilling it is a later pass by a separate agent, not this build's job.
- **When blocked or the spec is ambiguous: log it, ask, wait.** Do not pick silently.
- **One parser, one validator, one scoring-log implementation** — never a second copy of any of them.
- Phase 3 requires the **CSV fixture set before parser code** (minimum 8 fixtures, each paired with expected errors/warnings in a test table).
- Phase 5 changes presentation only — game logic is frozen there; logic bugs found are fixed as Phase 4 regressions and Phase 4's suite must stay green.

## Notes

- A single-file HTML visual prototype exists from an earlier design pass — reference for look/feel (navy/gold game-show aesthetic) only, **not** code to port. Its `window.storage` layer must not appear in this build.
- CSV validation needs a fixture set of at least 6 broken CSVs (see §6.2 AC).
- Keyboard shortcuts must not fire while typing in an input.
