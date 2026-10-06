// Writes a full JSON backup (profiles + boards) to ./backups/.
//   npm run backup                      → backups/board-room-backup-<date>.json
//   npm run backup -- /path/to/out.json → that file
// Against Railway: `railway run npm run backup` uses the live DATABASE_URL.
// The file contains password hashes — store it like you would the database.
import fs from 'node:fs'
import path from 'node:path'
import { buildBackup } from '../src/admin.js'
import { prisma } from '../src/db.js'

const data = await buildBackup()
const stamp = data.exportedAt.replace(/[:T]/g, '-').slice(0, 19)
const out = process.argv[2] ?? path.join('backups', `board-room-backup-${stamp}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(data, null, 2))
const boards = data.profiles.reduce((n, p) => n + p.boards.length, 0)
console.log(`wrote ${out}: ${data.profiles.length} profiles, ${boards} boards`)
await prisma.$disconnect()
