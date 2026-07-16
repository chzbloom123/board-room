import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildApp,
  prisma,
  resetDb,
  createProfile,
  login,
  adminLogin,
} from './helpers.js'
import { config } from '../src/config.js'

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

test('SPEC §8.1 — no auth token, session id, or credential in any URL', async () => {
  await createProfile('Steam Ops', 'ops-password-1')
  const { res, cookie } = await login(app, 'Steam Ops', 'ops-password-1')
  assert.equal(res.statusCode, 200)

  // Auth state travels only in an HttpOnly cookie.
  const setCookie = String(res.headers['set-cookie'])
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Lax/i)

  // Every flow in the app uses fixed URLs; no route puts auth in the path
  // or query. Prove the server also IGNORES auth smuggled via query string:
  const cookieValue = encodeURIComponent(cookie.replace(/^session=/, ''))
  for (const url of [
    `/api/me?session=${cookieValue}`,
    `/api/boards?token=${cookieValue}`,
    `/api/me?cookie=${cookieValue}`,
  ]) {
    const smuggled = await app.inject({ method: 'GET', url })
    assert.equal(smuggled.statusCode, 401, `auth via URL must not work: ${url}`)
  }

  // The same value in the cookie header IS accepted — the cookie is the
  // one and only session channel.
  const proper = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie },
  })
  assert.equal(proper.statusCode, 200)
})

test('SPEC §8.2 — copied URL opened in a clean browser lands unauthenticated', async () => {
  await createProfile('Steam Ops', 'ops-password-1')
  const { cookie } = await login(app, 'Steam Ops', 'ops-password-1')

  // A logged-in browser can reach the API...
  const authed = await app.inject({ method: 'GET', url: '/api/boards', headers: { cookie } })
  assert.equal(authed.statusCode, 200)

  // ...but the same URLs from a cookie-less (clean) browser are 401,
  // and the page itself serves the app shell (whose entry state is login).
  for (const url of ['/api/boards', '/api/me']) {
    const clean = await app.inject({ method: 'GET', url })
    assert.equal(clean.statusCode, 401, `clean browser must not be authenticated: ${url}`)
  }
  const page = await app.inject({ method: 'GET', url: '/' })
  assert.equal(page.statusCode, 200)
  assert.doesNotMatch(page.body, /session=/)
})

test('SPEC §8.3 — bucket-scoped routes reject another profile\'s resources', async () => {
  const profileA = await createProfile('Group A', 'password-a')
  await createProfile('Group B', 'password-b')
  const boardA = await prisma.board.create({
    data: {
      ownerProfileId: profileA.id,
      name: 'A board',
      topics: [{ name: 'T', cells: [{ points: 100, question: 'Q', answer: 'A' }] }],
    },
  })

  const a = await login(app, 'Group A', 'password-a')
  const b = await login(app, 'Group B', 'password-b')

  // Owner sees it.
  const own = await app.inject({
    method: 'GET',
    url: `/api/boards/${boardA.id}`,
    headers: { cookie: a.cookie },
  })
  assert.equal(own.statusCode, 200)

  // The other profile gets 404 by id and an empty list.
  const cross = await app.inject({
    method: 'GET',
    url: `/api/boards/${boardA.id}`,
    headers: { cookie: b.cookie },
  })
  assert.equal(cross.statusCode, 404)

  const list = await app.inject({
    method: 'GET',
    url: '/api/boards',
    headers: { cookie: b.cookie },
  })
  assert.deepEqual(JSON.parse(list.body), [])
})

test('SPEC §8.4 — no credential material in logs', async () => {
  const lines = []
  const captureApp = buildApp({
    logger: true,
    loggerStream: { write: (line) => lines.push(line) },
  })
  await captureApp.ready()
  try {
    await createProfile('Steam Ops', 'super-secret-password-42')
    const bad = await captureApp.inject({
      method: 'POST',
      url: '/api/login',
      payload: { name: 'Steam Ops', password: 'wrong-guess-99' },
    })
    assert.equal(bad.statusCode, 401)
    const good = await login(captureApp, 'Steam Ops', 'super-secret-password-42')
    assert.equal(good.res.statusCode, 200)
    await captureApp.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: good.cookie },
    })

    const logText = lines.join('')
    assert.ok(lines.length > 0, 'expected request logs to be captured')
    for (const secret of [
      'super-secret-password-42',
      'wrong-guess-99',
      good.cookie.replace(/^session=/, '').split('.')[0],
      config.sessionSecret,
      config.adminPassword,
    ]) {
      assert.ok(!logText.includes(secret), `log output must not contain: ${secret}`)
    }
    const { passwordHash } = await prisma.instructorProfile.findUnique({
      where: { name: 'Steam Ops' },
    })
    assert.ok(!logText.includes(passwordHash), 'log output must not contain password hash')
  } finally {
    await captureApp.close()
  }
})

test('passwords are stored as hashes, never plaintext (SPEC §3)', async () => {
  await createProfile('Steam Ops', 'plain-password-7')
  const row = await prisma.instructorProfile.findUnique({ where: { name: 'Steam Ops' } })
  assert.ok(!row.passwordHash.includes('plain-password-7'))
  assert.match(row.passwordHash, /^\$2/)
})

test('concurrent logins for the same profile are both valid (SPEC §3)', async () => {
  await createProfile('Steam Ops', 'ops-password-1')
  const first = await login(app, 'Steam Ops', 'ops-password-1')
  const second = await login(app, 'Steam Ops', 'ops-password-1')

  for (const session of [first, second]) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: session.cookie },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).profile.name, 'Steam Ops')
  }
})

test('admin login: env credentials in, wrong password out', async () => {
  const good = await adminLogin(app, config.adminUser, config.adminPassword)
  assert.equal(good.res.statusCode, 200)
  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: good.cookie },
  })
  assert.deepEqual(JSON.parse(me.body), { type: 'admin' })

  const bad = await adminLogin(app, config.adminUser, 'not-the-password')
  assert.equal(bad.res.statusCode, 401)
  assert.equal(bad.cookie, null)
})

test('logout clears the session', async () => {
  await createProfile('Steam Ops', 'ops-password-1')
  const { cookie } = await login(app, 'Steam Ops', 'ops-password-1')
  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })
  assert.equal(out.statusCode, 200)
  const cleared = String(out.headers['set-cookie'])
  assert.match(cleared, /session=;/)
})

test('tampered session cookie is rejected', async () => {
  await createProfile('Steam Ops', 'ops-password-1')
  const { cookie } = await login(app, 'Steam Ops', 'ops-password-1')
  const forged = cookie.slice(0, -4) + 'AAAA'
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: forged } })
  assert.equal(res.statusCode, 401)
})
