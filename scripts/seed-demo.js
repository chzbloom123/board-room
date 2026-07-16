// Creates/refreshes two local demo profiles. Dev convenience only.
//   node scripts/seed-demo.js
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db.js'

const profiles = [
  ['Steam Ops', 'demo-pass-a'],
  ['Night Shift', 'demo-pass-b'],
]

for (const [name, password] of profiles) {
  const passwordHash = await bcrypt.hash(password, 10)
  await prisma.instructorProfile.upsert({
    where: { name },
    update: { passwordHash },
    create: { name, passwordHash },
  })
  console.log(`profile ready: ${name} / ${password}`)
}
await prisma.$disconnect()
