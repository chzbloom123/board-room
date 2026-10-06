import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, prisma, resetDb, createProfile, login, adminLogin } from './helpers.js'
import { config } from '../src/config.js'

// Phase 6: every admin action end-to-end, plus the layer separation
// (admin routes reject instructor sessions and vice versa).

let app
let admin // admin cookie
let cookieA
let profileA
let profileB

before(async () => {
  app = buildApp({ logger: false })
  await app.ready()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
})

const CSV = 'Alpha,100,QA1?,AA1\nAlpha,200,QA2?,AA2'

beforeEach(async () => {
  await resetDb()
  profileA = await createProfile('Group A', 'password-a')
  profileB = await createProfile('Group B', 'password-b')
  cookieA = (await login(app, 'Group A', 'password-a')).cookie
  admin = (await adminLogin(app, config.adminUser, config.adminPassword)).cookie
  assert.ok(admin, 'admin login must succeed with env credentials')
})

const call = (method, url, cookie, payload) => app.inject({ method, url, headers: { cookie }, payload })
const json = (res) => JSON.parse(res.body)

async function boardFor(cookie, name = 'Board') {
  return json(await call('POST', '/api/boards', cookie, { name, csv: CSV })).board
}

test('admin routes reject instructor sessions and anonymous requests; instructor routes reject admin', async () => {
  for (const url of ['/api/admin/profiles', '/api/admin/boards', '/api/admin/sessions', '/api/admin/backup']) {
    assert.equal((await call('GET', url, cookieA)).statusCode, 403, `instructor must get 403 on ${url}`)
    assert.equal((await call('GET', url, '')).statusCode, 403, `anonymous must get 403 on ${url}`)
    assert.equal((await call('GET', url, admin)).statusCode, 200, `admin must get 200 on ${url}`)
  }
  assert.equal((await call('GET', '/api/boards', admin)).statusCode, 401, 'admin session is not an instructor')
  const me = json(await call('GET', '/api/me', admin))
  assert.equal(me.type, 'admin')
})

test('profiles: list with counts, create, rename, reset password, delete (block-if-nonempty)', async () => {
  await boardFor(cookieA, 'A1')
  let list = json(await call('GET', '/api/admin/profiles', admin))
  assert.deepEqual(
    list.map((p) => [p.name, p.boardCount, p.activeSessionCount]),
    [['Group A', 1, 0], ['Group B', 0, 0]],
  )

  // create (validation + duplicate)
  assert.equal((await call('POST', '/api/admin/profiles', admin, { name: 'X', password: 'longenough1' })).statusCode, 400)
  assert.equal((await call('POST', '/api/admin/profiles', admin, { name: 'Group C', password: 'short' })).statusCode, 400)
  assert.equal((await call('POST', '/api/admin/profiles', admin, { name: 'Group A', password: 'longenough1' })).statusCode, 409)
  const created = json(await call('POST', '/api/admin/profiles', admin, { name: '  Group C ', password: 'c-password-1' }))
  assert.equal(created.profile.name, 'Group C')
  assert.equal((await login(app, 'Group C', 'c-password-1')).res.statusCode, 200, 'new profile can log in')

  // rename (and clash)
  assert.equal((await call('PUT', `/api/admin/profiles/${profileB.id}`, admin, { name: 'Group A' })).statusCode, 409)
  const renamed = json(await call('PUT', `/api/admin/profiles/${profileB.id}`, admin, { name: 'Night Shift' }))
  assert.equal(renamed.profile.name, 'Night Shift')
  assert.equal((await login(app, 'Night Shift', 'password-b')).res.statusCode, 200)

  // reset password
  assert.equal((await call('POST', `/api/admin/profiles/${profileB.id}/password`, admin, { password: 'new-password-9' })).statusCode, 200)
  assert.equal((await login(app, 'Night Shift', 'password-b')).res.statusCode, 401, 'old password stops working')
  assert.equal((await login(app, 'Night Shift', 'new-password-9')).res.statusCode, 200)

  // delete: blocked while boards exist, allowed when empty
  const blocked = await call('DELETE', `/api/admin/profiles/${profileA.id}`, admin)
  assert.equal(blocked.statusCode, 409)
  assert.match(json(blocked).error, /still owns 1 board/)
  assert.equal((await call('DELETE', `/api/admin/profiles/${profileB.id}`, admin)).statusCode, 200)
  assert.equal((await login(app, 'Night Shift', 'new-password-9')).res.statusCode, 401, 'deleted profile cannot log in')
  assert.equal((await call('DELETE', `/api/admin/profiles/${profileB.id}`, admin)).statusCode, 404)
  list = json(await call('GET', '/api/admin/profiles', admin))
  assert.deepEqual(list.map((p) => p.name), ['Group A', 'Group C'])
})

test('boards: all-buckets view, move between buckets (with its sessions), delete any board', async () => {
  const a1 = await boardFor(cookieA, 'A1')
  const session = json(await call('POST', '/api/sessions', cookieA, { boardId: a1.id, players: [{ name: 'Red' }] })).session

  let all = json(await call('GET', '/api/admin/boards', admin))
  assert.deepEqual(all.map((b) => [b.name, b.owner.name, b.hasActiveSession]), [['A1', 'Group A', true]])

  // move A1 to Group B
  assert.equal((await call('PUT', `/api/admin/boards/${a1.id}/owner`, admin, { ownerProfileId: 'nope' })).statusCode, 400)
  assert.equal((await call('PUT', `/api/admin/boards/${a1.id}/owner`, admin, { ownerProfileId: profileB.id })).statusCode, 200)

  // gone from A (list, fetch, session), present and playable in B
  assert.deepEqual(json(await call('GET', '/api/boards', cookieA)), [])
  assert.equal((await call('GET', `/api/boards/${a1.id}`, cookieA)).statusCode, 404)
  assert.equal((await call('GET', `/api/sessions/${session.id}`, cookieA)).statusCode, 404)
  const cookieB = (await login(app, 'Group B', 'password-b')).cookie
  const inB = json(await call('GET', '/api/boards', cookieB))
  assert.deepEqual(inB.map((b) => [b.name, b.activeSessionId]), [['A1', session.id]])
  const resumed = json(await call('GET', `/api/sessions/${session.id}`, cookieB))
  assert.equal(resumed.board.id, a1.id)
  const played = await call('POST', `/api/sessions/${session.id}/events`, cookieB, { playerIdx: 0, correct: true, topicIdx: 0, cellIdx: 0, closesCell: true })
  assert.equal(played.statusCode, 200, 'moved board is playable in the destination bucket')

  // delete any board (and its sessions)
  assert.equal((await call('DELETE', `/api/admin/boards/${a1.id}`, admin)).statusCode, 200)
  assert.deepEqual(json(await call('GET', '/api/boards', cookieB)), [])
  assert.equal(await prisma.gameSession.count(), 0)
  assert.equal((await call('DELETE', `/api/admin/boards/${a1.id}`, admin)).statusCode, 404)
})

test('sessions: list active games and force-end one', async () => {
  const a1 = await boardFor(cookieA, 'A1')
  const session = json(await call('POST', '/api/sessions', cookieA, { boardId: a1.id, players: [{ name: 'Red' }, { name: 'Blue' }] })).session
  let list = json(await call('GET', '/api/admin/sessions', admin))
  assert.equal(list.length, 1)
  assert.equal(list[0].boardName, 'A1')
  assert.deepEqual(list[0].players, ['Red 0', 'Blue 0'])

  assert.equal((await call('POST', `/api/admin/sessions/${session.id}/end`, admin)).statusCode, 200)
  list = json(await call('GET', '/api/admin/sessions', admin))
  assert.equal(list.length, 0)
  const afterEnd = await call('POST', `/api/sessions/${session.id}/events`, cookieA, { topicIdx: 0, cellIdx: 0, closesCell: true })
  assert.equal(afterEnd.statusCode, 409, 'instructor can no longer score a force-ended game')
  const lib = json(await call('GET', '/api/boards', cookieA))
  assert.equal(lib[0].activeSessionId, null)
})

test('backup: contains every profile (hash, not password) and board with its final round', async () => {
  await call('POST', '/api/boards', cookieA, { name: 'With final', csv: CSV + '\nCat,final,FQ?,FA' })
  const res = await call('GET', '/api/admin/backup', admin)
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-disposition'], /board-room-backup-\d{4}-\d{2}-\d{2}\.json/)
  const data = json(res)
  assert.equal(data.kind, 'full-backup')
  assert.deepEqual(data.profiles.map((p) => p.name), ['Group A', 'Group B'])
  const a = data.profiles[0]
  assert.ok(a.passwordHash.startsWith('$2'), 'bcrypt hash, never the password')
  assert.ok(!JSON.stringify(data).includes('password-a'))
  assert.equal(a.boards.length, 1)
  assert.deepEqual(a.boards[0].final, { category: 'Cat', question: 'FQ?', answer: 'FA' })
  assert.equal(a.boards[0].topics[0].name, 'Alpha')
})
