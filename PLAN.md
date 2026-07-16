# Board Room — Build Plan (v1)

Companion to SPEC.md. The spec says *what*; this says *in what order* and *how we know each step is actually done*.

## How to work this plan

- Phases run in order. A phase is complete when every exit criterion has been **demonstrated** — a command run, a test passing, an output shown — not asserted. "Implemented and should work" is not a completion state.  
- Do not start a phase's tasks until the prior phase's exit criteria are shown. Exception: trivial fixes to earlier-phase regressions found later are always in order.  
- Log continuously to `issues.md` (see below). Do not re-read the full log before decisions; it is write-heavy, read-light.  
- If the spec and the plan conflict, stop and say so. Do not resolve the conflict silently in either direction.  
- Human checkpoints (marked **⛳**) mean: stop, present the state, and wait for a walkthrough before continuing.

## issues.md contract

Append-only log. One entry per: surprise, workaround, deviation from spec, library quirk, decision made without an explicit ruling, or anything a future maintainer would want to know. Entry format: timestamp, phase, one-paragraph description, what was done. Never edit or delete past entries. Distillation into a do/don't shortlist is a separate later pass by a separate agent — not this build's job.

---

## Phase 1 — Skeleton

**Goal:** A running Fastify app on localhost with Postgres in Docker, configured the way Railway will expect, before any feature code exists.

Tasks:

- Repo scaffold: Fastify server, static file serving from `/public`, project layout (`/src` server, `/public` frontend, `/prisma`).  
- `docker-compose.yml` for local Postgres; Prisma connected via `DATABASE_URL`.  
- Env handling: `.env` (git-ignored) \+ committed `.env.example` listing every variable from SPEC §9. Server binds `0.0.0.0`, honors `PORT`.  
- `/healthz` returning 200 with a DB connectivity check.  
- Initial Prisma schema (all three models from SPEC §4) and first migration.  
- README section: fresh-clone setup steps, written as they are performed.

Exit criteria:

1. `docker compose up` \+ migrate \+ start from a fresh clone works following only the README.  
2. `curl localhost:PORT/healthz` → 200; stopping Postgres flips it to a failure state.  
3. `git grep` shows no secrets in tracked files.

---

## Phase 2 — Auth and Security Invariants

**Goal:** Both auth layers working, with SPEC §8's invariants encoded as automated tests *in this phase*, so later phases cannot regress them unnoticed.

Tasks:

- Instructor profile login (name \+ password), bcrypt/argon2 hashing, HttpOnly SameSite session cookie, logout.  
- Admin login from env credentials; admin session distinguishable from profile session.  
- Server-side scoping middleware: every bucket-scoped route resolves the profile from the session, never from client input.  
- Automated tests for SPEC §8: (a) no token/session id/credential in any URL across login, authenticated fetches, and logout; (b) copied-URL-in-clean-browser lands on login (simulated via cookie-less request); (c) two-profile isolation — each profile's API access to the other's resource ids returns 403/404; (d) no credential material in logs at any log level.  
- Concurrent logins per profile verified allowed (two simultaneous sessions, both valid).

Exit criteria:

1. Security test suite passes; test names map one-to-one to SPEC §8 items.  
2. Manual demo: log in as two different profiles in two browsers; each sees an empty, separate world.  
3. Admin can log in; a wrong admin password cannot.

**⛳ Human checkpoint** — walk the login flows before feature work begins.

---

## Phase 3 — Boards: CSV Pipeline, CRUD, Export/Import

**Goal:** The full board lifecycle inside a bucket, built around one parser and one validator used everywhere.

Tasks:

- CSV fixture set FIRST, before parser code: minimum 8 files — valid 6×5 board; valid odd-shaped board (4 topics, uneven counts — warnings only); short row; non-numeric points; duplicate points in topic; missing answer; quoted fields with commas and embedded quotes; header \+ headerless variants. Each fixture paired with its expected errors/warnings in a test table.  
- Parser \+ validator per SPEC §5, driven by the fixtures (tests written against the table above).  
- Create screen: paste/upload, live preview table, row-level errors and warnings, save-blocked-on-errors, save-allowed-on-warnings.  
- Library screen: list with counts, Play / Edit / Export / Delete (confirm on delete).  
- Edit: regenerate CSV text from stored JSON → same pipeline → update in place. A validation error leaves the stored board untouched.  
- Export board JSON / import into current bucket.

Exit criteria:

1. Fixture test table fully green — every fixture produces exactly its expected errors/warnings, no more, no fewer.  
2. Round-trip proof: CSV → save → edit view → save → export JSON → delete → import → deep-equal with the original parsed structure.  
3. Isolation re-check: profile B cannot list, fetch, edit, export, or delete profile A's board via direct API calls.

---

## Phase 4 — Live Game

**Goal:** The core play loop with the scoring log as the single source of truth for scores, used cells, and undo.

Tasks:

- Player setup screen (names/teams, distinct colors, add/remove, minimum one player to start).  
- Board screen from the reference aesthetic: topic headers, value cells, used-cell state; scoreboard always visible, negative scores in red.  
- Question modal: question → Reveal → per-player Correct/Wrong judging → cell closes. "No one got it / Close" path also closes the cell.  
- Scoring event log per SPEC §4; scores and used cells derived from or reconciled with the log.  
- Single-level Undo button reverting the last log entry, including reopening a cell the entry closed.  
- Persistence: state written server-side on every scoring event and cell change; library shows active-session indicator with Resume; explicit End Session.

Exit criteria:

1. Scripted playthrough test: award → deduct → undo the deduction → close cell via correct answer → undo (cell reopens, score reverts) — asserted state at every step.  
2. Resume proof: mid-game, no explicit save action, kill the tab, open a different browser, log in as the same profile, resume — scores, used cells, and undo availability identical.  
3. Two sessions from the same profile run simultaneously without cross-talk.

**⛳ Human checkpoint** — play a full game against the sample board before polish.

---

## Phase 5 — Presentation Polish

**Goal:** Projector-ready. This phase changes presentation only — game logic is frozen; any logic bug found here is logged and fixed as a Phase 4 regression.

Tasks:

- Fullscreen toggle (F); Space \= reveal; Esc \= close modal; shortcuts suppressed while focus is in any input.  
- Typography/layout pass for distance legibility per SPEC §6.7.  
- Interaction feel: cell hover, modal transitions, toast feedback — restrained, in the reference aesthetic.

Exit criteria:

1. Manual 1280×720 check per SPEC §6.7 AC.  
2. Shortcut matrix demonstrated: each key in game view vs. in a text input.  
3. Phase 4's test suite still fully green (proves logic untouched).

---

## Phase 6 — Admin Panel

**Goal:** The maintenance hatch. Plain UI is fine.

Tasks:

- Profile management: create, rename, reset password, delete. Pick and document the delete-with-boards behavior (block-if-nonempty recommended); enforce it.  
- All-buckets board view; move board between buckets; delete any board.  
- Force-end any active session.

Exit criteria:

1. Each admin action demonstrated end-to-end, including the documented profile-delete behavior.  
2. A moved board appears in the destination bucket's library and is playable there; gone from the source.  
3. Admin routes reject instructor-profile sessions (403), and vice versa where applicable.

---

## Phase 7 — Deployment Readiness

**Goal:** Railway-shaped and proven reproducible. Actual deployment happens after this phase, by the owner.

Tasks:

- Verify SPEC §9 checklist: env-only config, `0.0.0.0`/`PORT`, migrate-on-release command documented, secure cookies in production mode, healthz.  
- README finalized: fresh-clone local setup AND Railway deployment steps (service \+ Postgres plugin, env vars to set, release command).  
- Fresh-clone rehearsal: clean directory, follow README verbatim, working app. Any step that required improvisation is a README bug — fix and re-run.  
- Full test suite green; final `issues.md` entry summarizing open items, if any.

Exit criteria:

1. Fresh-clone rehearsal passes with zero off-README steps.  
2. All automated tests green in one run.  
3. `git grep` for secrets clean; `.env.example` complete against the code's actual env reads.

**⛳ Human checkpoint** — owner walkthrough of the whole app, then owner performs the Railway deployment.

---

## Standing rules (all phases)

- One parser, one validator, one scoring-log implementation — never a second copy of any of them.  
- Nothing from SPEC §7 (out of scope) gets built, scaffolded, or left as a TODO.  
- When blocked or when the spec is ambiguous: log it, ask, wait. Do not pick silently.

