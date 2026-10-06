import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { config } from './config.js'
import { prisma } from './db.js'

const SESSION_COOKIE = 'session'
const BCRYPT_ROUNDS = 10
const NAME_MIN = 2
const NAME_MAX = 40
const PASSWORD_MIN = 8

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProduction,
  path: '/',
  signed: true,
  // Not a browser-session cookie: an instructor's login must survive a
  // browser restart on the classroom machine mid-day.
  maxAge: 60 * 60 * 24 * 30, // 30 days, in seconds
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

// Credential checks for a public URL: after too many FAILED attempts from one
// address, auth endpoints answer 429 for a while. Successes reset the count,
// so a busy classroom machine is never locked out by normal use. State lives
// on the app instance so tests get a fresh limiter per buildApp().
const FAIL_LIMIT = 30
const FAIL_WINDOW_MS = 15 * 60 * 1000

function limiterFor(app) {
  return app.authFailures
}

function tooManyFailures(app, request) {
  const entry = limiterFor(app).get(request.ip)
  if (!entry) return false
  if (Date.now() > entry.resetAt) {
    limiterFor(app).delete(request.ip)
    return false
  }
  return entry.count >= FAIL_LIMIT
}

function recordFailure(app, request) {
  const map = limiterFor(app)
  const entry = map.get(request.ip)
  if (!entry || Date.now() > entry.resetAt) {
    map.set(request.ip, { count: 1, resetAt: Date.now() + FAIL_WINDOW_MS })
  } else {
    entry.count++
  }
}

function recordSuccess(app, request) {
  limiterFor(app).delete(request.ip)
}

export function validateProfileName(name) {
  if (typeof name !== 'string') return 'Profile name required'
  const trimmed = name.trim()
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) {
    return `Profile name must be ${NAME_MIN}–${NAME_MAX} characters`
  }
  return null
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters`
  }
  if (password.length > 200) return 'Password is too long'
  return null
}

export function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
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
  // Decorations must happen while the plugin registers (never after ready).
  app.decorate('authFailures', new Map())

  // What the login screen needs to know: whether sign-up is open, closed,
  // or needs an invite code. Never the code itself.
  app.get('/api/config', async () => ({ registration: config.registration }))

  app.post('/api/login', async (request, reply) => {
    if (tooManyFailures(app, request)) {
      return reply.code(429).send({ error: 'Too many failed attempts — try again in a few minutes' })
    }
    const { name, password } = request.body ?? {}
    if (typeof name !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Name and password required' })
    }
    const profile = await prisma.instructorProfile.findUnique({ where: { name: name.trim() } })
    const ok = profile && (await bcrypt.compare(password, profile.passwordHash))
    if (!ok) {
      recordFailure(app, request)
      return reply.code(401).send({ error: 'Wrong profile name or password' })
    }
    recordSuccess(app, request)
    setSession(reply, { t: 'profile', id: profile.id })
    return { profile: { id: profile.id, name: profile.name } }
  })

  // Self-service sign-up: creates a profile (a new, empty bucket) and logs
  // it in. Gated by REGISTRATION_CODE (see config.js).
  app.post('/api/register', async (request, reply) => {
    if (config.registration === 'closed') {
      return reply.code(403).send({ error: 'Sign-up is disabled — ask the site admin for a login' })
    }
    if (tooManyFailures(app, request)) {
      return reply.code(429).send({ error: 'Too many failed attempts — try again in a few minutes' })
    }
    const { name, password, code } = request.body ?? {}
    if (config.registration === 'code') {
      if (typeof code !== 'string' || !timingSafeEqualStrings(code.trim(), config.registrationCode)) {
        recordFailure(app, request)
        return reply.code(403).send({ error: 'Invite code is wrong or missing' })
      }
    }
    const nameError = validateProfileName(name)
    if (nameError) return reply.code(400).send({ error: nameError })
    const passwordError = validatePassword(password)
    if (passwordError) return reply.code(400).send({ error: passwordError })

    const trimmed = name.trim()
    const existing = await prisma.instructorProfile.findUnique({ where: { name: trimmed } })
    if (existing) return reply.code(409).send({ error: 'That profile name is already taken' })

    const profile = await prisma.instructorProfile.create({
      data: { name: trimmed, passwordHash: await hashPassword(password) },
      select: { id: true, name: true },
    })
    recordSuccess(app, request)
    setSession(reply, { t: 'profile', id: profile.id })
    return reply.code(201).send({ profile })
  })

  // An instructor changes their own password (current password required).
  app.post('/api/me/password', { preHandler: requireProfile }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body ?? {}
    const full = await prisma.instructorProfile.findUnique({ where: { id: request.profile.id } })
    const ok = typeof currentPassword === 'string' && (await bcrypt.compare(currentPassword, full.passwordHash))
    if (!ok) return reply.code(401).send({ error: 'Current password is wrong' })
    const passwordError = validatePassword(newPassword)
    if (passwordError) return reply.code(400).send({ error: passwordError })
    await prisma.instructorProfile.update({
      where: { id: request.profile.id },
      data: { passwordHash: await hashPassword(newPassword) },
    })
    return { ok: true }
  })

  app.post('/api/admin/login', async (request, reply) => {
    if (tooManyFailures(app, request)) {
      return reply.code(429).send({ error: 'Too many failed attempts — try again in a few minutes' })
    }
    const { user, password } = request.body ?? {}
    if (typeof user !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'User and password required' })
    }
    const userOk = timingSafeEqualStrings(user, config.adminUser)
    const passOk = timingSafeEqualStrings(password, config.adminPassword)
    if (!userOk || !passOk) {
      recordFailure(app, request)
      return reply.code(401).send({ error: 'Wrong admin credentials' })
    }
    recordSuccess(app, request)
    setSession(reply, { t: 'admin' })
    return { admin: true }
  })

  app.post('/api/logout', async (request, reply) => {
    clearSession(reply)
    return { ok: true }
  })

  app.get('/api/me', async (request, reply) => {
    const session = readSession(request)
    if (session?.t === 'admin') return { type: 'admin', user: config.adminUser }
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
