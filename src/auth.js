import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { config } from './config.js'
import { prisma } from './db.js'

const SESSION_COOKIE = 'session'

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProduction,
  path: '/',
  signed: true,
}

// Login state lives ONLY in this HttpOnly signed cookie. Nothing
// auth-related is ever accepted from a URL (SPEC §8).
function setSession(reply, payload) {
  reply.setCookie(SESSION_COOKIE, JSON.stringify(payload), cookieOptions)
}

function clearSession(reply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

function readSession(request) {
  const raw = request.cookies[SESSION_COOKIE]
  if (!raw) return null
  const unsigned = request.unsignCookie(raw)
  if (!unsigned.valid) return null
  try {
    return JSON.parse(unsigned.value)
  } catch {
    return null
  }
}

function timingSafeEqualStrings(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

// preHandler: resolves the instructor profile from the session cookie and
// attaches request.profile. Bucket scoping derives from this — never from
// client-supplied ids (SPEC §3).
export async function requireProfile(request, reply) {
  const session = readSession(request)
  if (!session || session.t !== 'profile') {
    return reply.code(401).send({ error: 'Not logged in' })
  }
  const profile = await prisma.instructorProfile.findUnique({
    where: { id: session.id },
    select: { id: true, name: true },
  })
  if (!profile) {
    clearSession(reply)
    return reply.code(401).send({ error: 'Not logged in' })
  }
  request.profile = profile
}

export async function requireAdmin(request, reply) {
  const session = readSession(request)
  if (!session || session.t !== 'admin') {
    return reply.code(403).send({ error: 'Admin access required' })
  }
}

export async function authRoutes(app) {
  app.post('/api/login', async (request, reply) => {
    const { name, password } = request.body ?? {}
    if (typeof name !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Name and password required' })
    }
    const profile = await prisma.instructorProfile.findUnique({ where: { name } })
    const ok = profile && (await bcrypt.compare(password, profile.passwordHash))
    if (!ok) {
      return reply.code(401).send({ error: 'Wrong profile name or password' })
    }
    setSession(reply, { t: 'profile', id: profile.id })
    return { profile: { id: profile.id, name: profile.name } }
  })

  app.post('/api/admin/login', async (request, reply) => {
    const { user, password } = request.body ?? {}
    if (typeof user !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'User and password required' })
    }
    const userOk = timingSafeEqualStrings(user, config.adminUser)
    const passOk = timingSafeEqualStrings(password, config.adminPassword)
    if (!userOk || !passOk) {
      return reply.code(401).send({ error: 'Wrong admin credentials' })
    }
    setSession(reply, { t: 'admin' })
    return { admin: true }
  })

  app.post('/api/logout', async (request, reply) => {
    clearSession(reply)
    return { ok: true }
  })

  app.get('/api/me', async (request, reply) => {
    const session = readSession(request)
    if (session?.t === 'admin') return { type: 'admin' }
    if (session?.t === 'profile') {
      const profile = await prisma.instructorProfile.findUnique({
        where: { id: session.id },
        select: { id: true, name: true },
      })
      if (profile) return { type: 'profile', profile }
    }
    return reply.code(401).send({ error: 'Not logged in' })
  })
}
