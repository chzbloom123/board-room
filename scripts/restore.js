// Restores a backup written by `npm run backup` (or the admin panel's
// "Download backup") into the database pointed at by DATABASE_URL.
//   npm run restore -- backups/board-room-backup-2026-10-06.json
// Profiles are matched by name: an existing profile keeps its current
// password unless --reset-passwords is passed; a missing profile is created
// with the backed-up hash. Boards are added (never overwritten) unless an
// identically named board already exists in that bucket, which is skipped.
// Live game sessions are not part of backups.
import fs from 'node:fs'
import { prisma } from '../src/db.js'

const file = process.argv.find((a) => a.endsWith('.json'))
if (!file) {
  console.error('usage: npm run restore -- <backup.json> [--reset-passwords]')
  process.exit(1)
}
const resetPasswords = process.argv.includes('--reset-passwords')
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
if (data.app !== 'board-room' || data.kind !== 'full-backup') {
  console.error('not a Board Room full backup file')
  process.exit(1)
}

let createdProfiles = 0
let createdBoards = 0
let skippedBoards = 0
for (const p of data.profiles) {
  let profile = await prisma.instructorProfile.findUnique({ where: { name: p.name } })
  if (!profile) {
    profile = await prisma.instructorProfile.create({ data: { name: p.name, passwordHash: p.passwordHash } })
    createdProfiles++
  } else if (resetPasswords) {
    await prisma.instructorProfile.update({ where: { id: profile.id }, data: { passwordHash: p.passwordHash } })
  }
  for (const b of p.boards) {
    const exists = await prisma.board.findFirst({ where: { ownerProfileId: profile.id, name: b.name } })
    if (exists) {
      skippedBoards++
      continue
    }
    await prisma.board.create({
      data: { ownerProfileId: profile.id, name: b.name, topics: b.topics, final: b.final ?? undefined },
    })
    createdBoards++
  }
}
console.log(`restored: ${createdProfiles} profiles created, ${createdBoards} boards created, ${skippedBoards} boards skipped (already present)`)
await prisma.$disconnect()
