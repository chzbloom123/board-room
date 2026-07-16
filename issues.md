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
