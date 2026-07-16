import bcrypt from 'bcryptjs'
import { buildApp } from '../src/server.js'
import { prisma } from '../src/db.js'

export { buildApp, prisma }

export async function resetDb() {
  await prisma.gameSession.deleteMany()
  await prisma.board.deleteMany()
  await prisma.instructorProfile.deleteMany()
}

export async function createProfile(name, password) {
  return prisma.instructorProfile.create({
    data: { name, passwordHash: await bcrypt.hash(password, 4) },
  })
}

export function sessionCookieOf(res) {
  const setCookie = res.headers['set-cookie']
  const all = Array.isArray(setCookie) ? setCookie : [setCookie].filter(Boolean)
  const header = all.find((c) => c.startsWith('session='))
  return header ? header.split(';')[0] : null
}

export async function login(app, name, password) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { name, password },
  })
  return { res, cookie: sessionCookieOf(res) }
}

export async function adminLogin(app, user, password) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { user, password },
  })
  return { res, cookie: sessionCookieOf(res) }
}
