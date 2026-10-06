import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, prisma, resetDb, createProfile, login, sessionCookieOf } from './helpers.js'
import { config } from '../src/config.js'

// Self-service instructor sign-up (owner ruling over SPEC §3's "no
// registration"; see issues.md). The local test .env leaves
// REGISTRATION_CODE unset, so sign-up is open here; the code-gated and
// closed modes are exercised through config overrides below.

let app

before(async () => {
  app = buildApp({ logger: false })
  await app.ready()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetDb()
})

const register = (payload, a = app) => a.inject({ method: 'POST', url: '/api/register', payload })
const json = (res) => JSON.parse(res.body)

test('sign-up creates a profile, logs it in via the cookie only, and the new bucket is empty and isolated', async () => {
  assert.equal(config.registration, 'open', 'tests expect REGISTRATION_CODE unset locally')
  assert.deepEqual(json(await app.inject({ method: 'GET', url: '/api/config' })), { registration: 'open' })

  const res = await register({ name: '  Day Shift ', password: 'a-good-password' })
  assert.equal(res.statusCode, 201)
  assert.equal(json(res).profile.name, 'Day Shift')
  const cookie = sessionCookieOf(res)
  assert.ok(cookie, 'sign-up sets the session cookie')
  assert.match(String(res.headers['set-cookie']), /HttpOnly/i)
  assert.ok(!res.headers.location, 'no redirect carrying state in a URL')

  const me = json(await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } }))
  assert.equal(me.profile.name, 'Day Shift')
  assert.deepEqual(json(await app.inject({ method: 'GET', url: '/api/boards', headers: { cookie } })), [])

  // Stored as a hash; the plain password can log in afterwards.
  const row = await prisma.instructorProfile.findUnique({ where: { name: 'Day Shift' } })
  assert.ok(row.passwordHash.startsWith('$2'))
  assert.equal((await login(app, 'Day Shift', 'a-good-password')).res.statusCode, 200)

  // Another sign-up cannot see the first bucket.
  await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie }, payload: { name: 'B', csv: 'Alpha,100,Q?,A' } })
  const other = sessionCookieOf(await register({ name: 'Other Crew', password: 'another-password' }))
  assert.deepEqual(json(await app.inject({ method: 'GET', url: '/api/boards', headers: { cookie: other } })), [])
})

test('sign-up validation: short names, short passwords, duplicates', async () => {
  await createProfile('Taken', 'whatever-pass')
  assert.equal((await register({ name: 'X', password: 'a-good-password' })).statusCode, 400)
  assert.equal((await register({ name: 'Fine Name', password: 'short' })).statusCode, 400)
  assert.equal((await register({ name: 'Taken', password: 'a-good-password' })).statusCode, 409)
  assert.equal((await register({ name: 'taken ', password: 'a-good-password' })).statusCode, 201, 'names are case-sensitive but trimmed')
  assert.equal((await register({})).statusCode, 400)
})

test('sign-up honours REGISTRATION_CODE: code required, or closed', async () => {
  const original = { registration: config.registration, registrationCode: config.registrationCode }
  try {
    config.registration = 'code'
    config.registrationCode = 'steam-2026'
    assert.deepEqual(json(await app.inject({ method: 'GET', url: '/api/config' })), { registration: 'code' })
    assert.equal((await register({ name: 'No Code', password: 'a-good-password' })).statusCode, 403)
    assert.equal((await register({ name: 'Bad Code', password: 'a-good-password', code: 'wrong' })).statusCode, 403)
    assert.equal((await register({ name: 'Good Code', password: 'a-good-password', code: ' steam-2026 ' })).statusCode, 201)

    config.registration = 'closed'
    assert.equal((await register({ name: 'Closed', password: 'a-good-password', code: 'steam-2026' })).statusCode, 403)
    assert.equal(await prisma.instructorProfile.count({ where: { name: 'Closed' } }), 0)
  } finally {
    Object.assign(config, original)
  }
})

test('instructors can change their own password (current password required)', async () => {
  await createProfile('Group A', 'password-a')
  const { cookie } = await login(app, 'Group A', 'password-a')
  const change = (payload) => app.inject({ method: 'POST', url: '/api/me/password', headers: { cookie }, payload })
  assert.equal((await change({ currentPassword: 'wrong', newPassword: 'brand-new-pass' })).statusCode, 401)
  assert.equal((await change({ currentPassword: 'password-a', newPassword: 'short' })).statusCode, 400)
  assert.equal((await change({ currentPassword: 'password-a', newPassword: 'brand-new-pass' })).statusCode, 200)
  assert.equal((await login(app, 'Group A', 'password-a')).res.statusCode, 401)
  assert.equal((await login(app, 'Group A', 'brand-new-pass')).res.statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: '/api/me/password', payload: {} })).statusCode, 401, 'anonymous cannot change anything')
})

test('repeated failed logins from one address are throttled; a success clears the count', async () => {
  // Own app instance so the limiter state does not leak into other tests.
  const limited = buildApp({ logger: false })
  await limited.ready()
  try {
    await createProfile('Group A', 'password-a')
    for (let i = 0; i < 30; i++) {
      const res = await login(limited, 'Group A', 'nope')
      assert.equal(res.res.statusCode, 401)
    }
    assert.equal((await login(limited, 'Group A', 'nope')).res.statusCode, 429)
    assert.equal((await login(limited, 'Group A', 'password-a')).res.statusCode, 429, 'throttle applies to everyone on that address')
    assert.equal((await register({ name: 'Blocked', password: 'a-good-password' }, limited)).statusCode, 429)
    assert.equal((await limited.inject({ method: 'POST', url: '/api/admin/login', payload: { user: config.adminUser, password: config.adminPassword } })).statusCode, 429)

    // A fresh app = a fresh window; 29 failures then a success resets to zero.
    const fresh = buildApp({ logger: false })
    await fresh.ready()
    try {
      for (let i = 0; i < 29; i++) await login(fresh, 'Group A', 'nope')
      assert.equal((await login(fresh, 'Group A', 'password-a')).res.statusCode, 200)
      for (let i = 0; i < 29; i++) await login(fresh, 'Group A', 'nope')
      assert.equal((await login(fresh, 'Group A', 'password-a')).res.statusCode, 200, 'count was reset by the earlier success')
    } finally {
      await fresh.close()
    }
  } finally {
    await limited.close()
  }
})
