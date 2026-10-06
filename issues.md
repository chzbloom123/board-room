# issues.md — append-only build log

One entry per surprise, workaround, deviation, quirk, or unruled decision.
Never edit or delete past entries.

---

**2026-07-16 · Phase 1** — Prisma 7 (latest at build time) differs materially from
the Prisma 5/6 the spec era assumed: the CLI no longer auto-loads `.env`, database
URLs move out of `schema.prisma` into `prisma.config.ts`, and the default
`prisma-client` generator emits TypeScript source requiring a driver adapter
(`@prisma/adapter-pg`). Resolution: `prisma.config.ts` uses Node's built-in
`process.loadEnvFile()` (no dotenv dependency), and the app imports the generated
`.ts` client directly — Node 24's native type stripping runs it with no build step,
so the spec's no-build-pipeline rule holds. Consequence: Node 24+ is a hard
requirement, documented in README and package.json `engines`.

**2026-07-16 · Phase 1** — `prisma.config.ts` is the one TypeScript file in the
repo. It is executed only by the Prisma CLI (which loads TS config natively), never
by the app. Chose the `.ts` name because it is what Prisma generates and documents;
a `.js` variant is less-trodden ground.

**2026-07-16 · Phase 2** — `node --test test/` fails on Windows (treats the
directory as a module path). Resolution: test script uses an explicit glob
(`node --test "test/*.test.js"`), which also stops the runner picking up
`test/helpers.js` as a zero-assertion "passing test".

**2026-07-16 · Phase 2** — Plan puts board routes in Phase 3, but SPEC §8.3
(cross-profile isolation) is required as an automated test in Phase 2. Resolved
by building the two read-only board routes (list, get-by-id) in Phase 2 so the
invariant test runs against a real bucket-scoped route now; Phase 3 adds the
writes through the same scoping.

**2026-07-16 · Phase 3** — Spec lists "fewer than 4 columns" as an error but is
silent on more than 4. Decision: more than 4 is also an error (the likely cause
is an unquoted comma; the message says to quote the field). Logged as a decision
made without an explicit ruling.

**2026-07-16 · Phase 3** — The `hidden` attribute lost to author CSS twice
(`#view-login { display:flex }` and `input { display:block }` both outrank the
UA's `[hidden]` rule). Fixed with a global `[hidden] { display:none !important }`.
Found by browser smoke test, not by API tests — worth keeping the habit of
driving the real UI each phase.

**2026-07-16 · Phase 3** — Tests and dev share one Postgres; the suite's resetDb
wipes demo login profiles. Mitigation: `npm run seed` recreates the two demo
profiles (Steam Ops / Night Shift). Acceptable for v1; a separate test database
would be the clean fix if it ever bites harder.

**2026-07-16 · Phase 3** — Test files run concurrently by default in node:test
and stomped each other's DB state. Test script pins --test-concurrency=1.

**2026-07-16 · Phase 4** — Judging semantics decided without an explicit ruling:
a "correct" judgment both scores and closes the cell in ONE log entry
(closesCell:true), so undoing it reverts score and reopens the cell atomically —
matching PLAN's "close cell via correct answer → undo (cell reopens, score
reverts)". Wrong answers leave the cell open for other players; "No one got it"
closes with no score; "Back to board" dismisses without closing (misclick path).

**2026-07-16 · Phase 4** — Multiple simultaneous active sessions per board are
allowed (no server constraint); the library's Resume points at the most recent.
Blocking would contradict SPEC §3's concurrent-instructor requirement in the
same-board edge case.

**2026-07-16 · Phase 4** — Chrome autofill fills the profile-name field with an
email on the login form. Harmless (login just fails), but autocomplete
attributes may deserve a look in Phase 5 polish.

**2026-10-05 · Phase 5 (owner-directed enhancement pass)** — Owner reviewed the
as-scoped build ("works, but boring") and asked for an open-ended pass to make the
app more interesting, functional and attractive, with question content left to
SMEs. This widens Phase 5 beyond "presentation only" into instructor conveniences,
but the standing rules were kept: game logic on the server is untouched (sessions.js
unchanged; Phase 4 suite is the proof), SPEC §7 items (Daily Doubles, wagers,
timers, player devices, frameworks) were NOT built, one parser/one validator holds
(the new spreadsheet-paste support is a tab→CSV text transform that feeds
boardFromCsv, with a test). What was added: display typeface + four colour themes
(per-browser preference), board intro cascade, cell-to-modal zoom, answer reveal
animation, animated score count-up with floating +/− badges, leader crown and
"picks next" badge (both derived client-side from the existing log), synthesized
Web Audio sound effects with a mute toggle, a results screen with podium/confetti
that also auto-opens when the board is cleared, Rematch (ends the session, starts a
new one with the same teams via existing routes), random-question roulette, a
progress counter, an extended shortcut set with a help overlay, colour picking and
"use last time's teams" in setup, library cards with topic chips + search +
duplicate + CSV download, and editor template/sample/stats/preview-detail.
Server change limited to `topicNames` in the board summary. The uncommitted Phase 5
polish found in the working tree (shortcuts, clamp sizes, 30-day cookie maxAge)
was folded into this pass.

**2026-10-05 · Phase 5** — The display typeface (Bebas Neue, Inter) loads from
Google Fonts via a `<link>`; there is still no build step, but a projector machine
with no internet falls back to Impact / Arial Narrow / system-ui. Acceptable for
v1; self-hosting the font files under /public is the fix if an offline classroom
ever looks wrong.

**2026-10-05 · Phase 5** — "End game" was replaced by "Results": it now opens a
standings overlay without ending the session; "Finish & return to library" is what
calls POST /end. Rationale: an accidental click on End game used to be
unrecoverable (no un-end route), while Results is harmless. Behaviour decided
without an explicit ruling.

**2026-10-05 · Phase 5 (owner override of SPEC §7)** — Owner explicitly asked for a
final-round question ("final jeopardy") with an original think-music piece, after
reviewing the enhancement pass. SPEC §7 lists Final Jeopardy and wagers as out of
scope; this is an owner ruling, so it is built rather than refused. Design: a board
gets an optional `final` JSON column ({category, question, answer}); the SME adds it
in the same CSV as one row whose points column is the word `final` (the one parser
handles it; errors for a second final row or missing fields; a final-only board is
an error). Session state gains `final: { wagers, judged }` once wagers are locked
(`POST /final/start`, wagers validated server-side as integers 0..max(score,0));
each judgment is an ordinary log entry with `final:true` and points = the locked
wager, so single-level undo and resume work unchanged. Still NOT built from §7:
Daily Doubles and enforced timers — the think music has a visible progress bar for
the length of the song (~30 s) but nothing locks when it ends. UI label is "Final
Round" rather than the trademarked name. The music is an original composition in
3/4 (the TV cue is 4/4 swing), same synthesized voices as the other effects.

**2026-10-05 · Phase 5** — Prisma 7 quirk: `prisma migrate dev` applied the
`board_final` migration but did not regenerate the client in `src/generated`;
every board create failed with "Unknown argument `final`" until `npx prisma
generate` was run by hand. Also: writing SQL NULL into a nullable Json column needs
`Prisma.DbNull`, plain `null` is rejected — wrapped in `jsonOrNull()` in boards.js.

**2026-10-06 · Phase 6/7 (owner ruling over SPEC §3)** — Owner asked for
self-service instructor sign-up so new instructors can create their own login and
bucket, with the site owner as global admin. SPEC §3 lists "no registration" as a
non-goal; this is an explicit owner ruling, so it is built. Shape kept deliberately
small: a profile is still a shared group credential (name + one password), still no
per-user identities, no email, no reset flows (admin resets). Sign-up is gated by
`REGISTRATION_CODE` (unset = open, `off` = closed, otherwise an invite code) so a
public Railway URL does not accumulate strangers' buckets. Added alongside: an
instructor can change their own password (current password required), and auth
endpoints throttle after 30 failed attempts from one address (429 for 15 min;
successes reset the count, so a shared classroom machine is never locked out).

**2026-10-06 · Phase 6** — Profile delete policy: BLOCK IF NON-EMPTY (PLAN's
recommended option). A profile that still owns boards or any game session (active
or finished) cannot be deleted; the admin moves or deletes its boards first (deleting
a board removes its sessions). Moving a board moves its sessions with it, so a live
game can be resumed by the destination bucket.

**2026-10-06 · Phase 7** — Railway shaping: `prisma` moved from devDependencies to
dependencies and a `postinstall: prisma generate` script added, because
`src/generated/` is git-ignored and Railway's build must regenerate the client;
with a devDependency the CLI would be missing from a production install.
`railway.json` runs `npx prisma migrate deploy` as the pre-deploy command and points
the health check at `/healthz`. Cookie `secure` is now on when NODE_ENV=production
OR when RAILWAY_ENVIRONMENT is present, so a forgotten NODE_ENV cannot ship
insecure cookies on Railway. Backups: Railway's Postgres service has its own
backups (dashboard → database → Backups); as a provider-independent second copy the
admin panel downloads a full JSON backup and `npm run backup` / `npm run restore`
do the same from the CLI (`railway run npm run backup` works against the live DB).

**2026-10-06 · Phase 7** — `npm audit fix` (non-breaking) applied for fastify,
@fastify/static, find-my-way, fast-uri, brace-expansion and hono. Four "high"
findings remain, all inside the Prisma 7 CLI's dependency chain (deepmerge-ts,
@prisma/config, mysql2 — unused, we are on Postgres); the only offered fix is a
downgrade to Prisma 6, which is a breaking change and not worth it: those packages
run at CLI/build time, not in the request path. Re-check on the next Prisma release.
