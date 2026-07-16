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
