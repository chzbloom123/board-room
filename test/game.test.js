import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, prisma, resetDb, createProfile, login } from './helpers.js'

let app
let cookieA
let cookieB
let board

before(async () => {
  app = buildApp({ logger: false })
  await app.ready()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
})

const CSV = [
  'Alpha,100,QA1?,AA1',
  'Alpha,200,QA2?,AA2',
  'Bravo,100,QB1?,AB1',
  'Bravo,200,QB2?,AB2',
].join('\n')

beforeEach(async () => {
  await resetDb()
  await createProfile('Group A', 'password-a')
  await createProfile('Group B', 'password-b')
  cookieA = (await login(app, 'Group A', 'password-a')).cookie
  cookieB = (await login(app, 'Group B', 'password-b')).cookie
  board = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/boards',
        headers: { cookie: cookieA },
        payload: { name: 'Game board', csv: CSV },
      })
    ).body,
  ).board
})

const post = (url, cookie, payload) =>
  app.inject({ method: 'POST', url, headers: { cookie }, payload })
const get = (url, cookie) => app.inject({ method: 'GET', url, headers: { cookie } })

async function startSession(cookie = cookieA, players = [{ name: 'Red team' }, { name: 'Blue team' }]) {
  const res = await post('/api/sessions', cookie, { boardId: board.id, players })
  assert.equal(res.statusCode, 200)
  return JSON.parse(res.body).session
}

const scores = (session) => session.state.players.map((p) => p.score)
const used = (session) => session.state.usedCells

test('scripted playthrough: award → deduct → undo deduction → close via correct → undo (PLAN Phase 4 exit 1)', async () => {
  let s = await startSession()
  assert.deepEqual(scores(s), [0, 0])

  // Award: player 0 answers Alpha-100 correctly — scores AND closes the cell.
  let res = await post(`/api/sessions/${s.id}/events`, cookieA, {
    playerIdx: 0, correct: true, topicIdx: 0, cellIdx: 0, closesCell: true,
  })
  s = JSON.parse(res.body).session
  assert.deepEqual(scores(s), [100, 0])
  assert.deepEqual(used(s), [[0, 0]])

  // Deduct: player 1 answers Bravo-200 wrong — cell stays open.
  res = await post(`/api/sessions/${s.id}/events`, cookieA, {
    playerIdx: 1, correct: false, topicIdx: 1, cellIdx: 1, closesCell: false,
  })
  s = JSON.parse(res.body).session
  assert.deepEqual(scores(s), [100, -200])
  assert.deepEqual(used(s), [[0, 0]])

  // Undo the deduction.
  res = await post(`/api/sessions/${s.id}/undo`, cookieA)
  s = JSON.parse(res.body).session
  assert.deepEqual(scores(s), [100, 0])
  assert.deepEqual(used(s), [[0, 0]])

  // Close Bravo-200 via a correct answer from player 1.
  res = await post(`/api/sessions/${s.id}/events`, cookieA, {
    playerIdx: 1, correct: true, topicIdx: 1, cellIdx: 1, closesCell: true,
  })
  s = JSON.parse(res.body).session
  assert.deepEqual(scores(s), [100, 200])
  assert.deepEqual(used(s), [[0, 0], [1, 1]])

  // Undo after cell close: cell reopens AND score reverts, atomically.
  res = await post(`/api/sessions/${s.id}/undo`, cookieA)
  s = JSON.parse(res.body).session
  assert.deepEqual(scores(s), [100, 0])
  assert.deepEqual(used(s), [[0, 0]])

  // Log length reflects remaining history: award only.
  assert.equal(s.state.log.length, 1)
})

test('negative scores are allowed and preserved (SPEC §6.5)', async () => {
  let s = await startSession()
  const res = await post(`/api/sessions/${s.id}/events`, cookieA, {
    playerIdx: 0, correct: false, topicIdx: 0, cellIdx: 0, closesCell: false,
  })
  s = JSON.parse(res.body).session
  assert.deepEqual(scores(s), [-100, 0])
})

test('"no one got it" closes the cell without scoring', async () => {
  let s = await startSession()
  const res = await post(`/api/sessions/${s.id}/events`, cookieA, {
    topicIdx: 0, cellIdx: 1, closesCell: true,
  })
  s = JSON.parse(res.body).session
  assert.deepEqual(scores(s), [0, 0])
  assert.deepEqual(used(s), [[0, 1]])

  // Undo reopens it.
  const undone = JSON.parse((await post(`/api/sessions/${s.id}/undo`, cookieA)).body).session
  assert.deepEqual(used(undone), [])
})

test('resume: state read back from another login is identical (PLAN Phase 4 exit 2)', async () => {
  let s = await startSession()
  await post(`/api/sessions/${s.id}/events`, cookieA, {
    playerIdx: 0, correct: true, topicIdx: 0, cellIdx: 0, closesCell: true,
  })
  const after = JSON.parse(
    (await post(`/api/sessions/${s.id}/events`, cookieA, {
      playerIdx: 1, correct: false, topicIdx: 1, cellIdx: 0, closesCell: false,
    })).body,
  ).session

  // "Different browser, same profile": a brand-new login session.
  const freshCookie = (await login(app, 'Group A', 'password-a')).cookie
  const resumed = JSON.parse(
    (await get(`/api/sessions/${s.id}`, freshCookie)).body,
  )
  assert.deepEqual(resumed.session.state, after.state)
  assert.equal(resumed.board.id, board.id)
  // Undo availability survives resume (log is non-empty) and works.
  assert.equal(resumed.session.state.log.length, 2)
  const undone = JSON.parse(
    (await post(`/api/sessions/${s.id}/undo`, freshCookie)).body,
  ).session
  assert.deepEqual(scores(undone), [100, 0])

  // The library shows the active session for the board.
  const list = JSON.parse((await get('/api/boards', freshCookie)).body)
  assert.equal(list[0].activeSessionId, s.id)
})

test('two sessions under one profile run simultaneously without cross-talk (PLAN Phase 4 exit 3)', async () => {
  const secondBoard = JSON.parse(
    (await post('/api/boards', cookieA, { name: 'Second board', csv: CSV })).body,
  ).board
  const s1 = await startSession()
  const res2 = await post('/api/sessions', cookieA, {
    boardId: secondBoard.id,
    players: [{ name: 'Solo' }],
  })
  const s2 = JSON.parse(res2.body).session

  // Interleave events across the two sessions.
  await post(`/api/sessions/${s1.id}/events`, cookieA, {
    playerIdx: 0, correct: true, topicIdx: 0, cellIdx: 0, closesCell: true,
  })
  await post(`/api/sessions/${s2.id}/events`, cookieA, {
    playerIdx: 0, correct: false, topicIdx: 1, cellIdx: 1, closesCell: false,
  })
  await post(`/api/sessions/${s1.id}/undo`, cookieA)

  const final1 = JSON.parse((await get(`/api/sessions/${s1.id}`, cookieA)).body).session
  const final2 = JSON.parse((await get(`/api/sessions/${s2.id}`, cookieA)).body).session
  assert.deepEqual(scores(final1), [0, 0])
  assert.deepEqual(used(final1), [])
  assert.deepEqual(scores(final2), [-200])
  assert.equal(final2.state.log.length, 1)
})

test('server rejects invalid events', async () => {
  const s = await startSession()

  // Bad indices.
  assert.equal(
    (await post(`/api/sessions/${s.id}/events`, cookieA, { playerIdx: 0, correct: true, topicIdx: 9, cellIdx: 0, closesCell: true })).statusCode,
    400,
  )
  // No such player.
  assert.equal(
    (await post(`/api/sessions/${s.id}/events`, cookieA, { playerIdx: 5, correct: true, topicIdx: 0, cellIdx: 0, closesCell: true })).statusCode,
    400,
  )
  // Used cell can't be scored again.
  await post(`/api/sessions/${s.id}/events`, cookieA, { topicIdx: 0, cellIdx: 0, closesCell: true })
  assert.equal(
    (await post(`/api/sessions/${s.id}/events`, cookieA, { playerIdx: 0, correct: true, topicIdx: 0, cellIdx: 0, closesCell: true })).statusCode,
    409,
  )
  // Undo on an empty log.
  await post(`/api/sessions/${s.id}/undo`, cookieA)
  assert.equal((await post(`/api/sessions/${s.id}/undo`, cookieA)).statusCode, 409)

  // Finished session accepts nothing.
  await post(`/api/sessions/${s.id}/end`, cookieA)
  assert.equal(
    (await post(`/api/sessions/${s.id}/events`, cookieA, { playerIdx: 0, correct: true, topicIdx: 0, cellIdx: 0, closesCell: true })).statusCode,
    409,
  )
})

test('player setup validation: at least one player, distinct names', async () => {
  assert.equal(
    (await post('/api/sessions', cookieA, { boardId: board.id, players: [] })).statusCode,
    400,
  )
  assert.equal(
    (await post('/api/sessions', cookieA, { boardId: board.id, players: [{ name: 'X' }, { name: 'X' }] })).statusCode,
    400,
  )
  assert.equal(
    (await post('/api/sessions', cookieA, { boardId: board.id, players: [{ name: '  ' }] })).statusCode,
    400,
  )
})

test('sessions are bucket-scoped like boards (SPEC §8.3)', async () => {
  const s = await startSession()
  assert.equal((await get(`/api/sessions/${s.id}`, cookieB)).statusCode, 404)
  assert.equal(
    (await post(`/api/sessions/${s.id}/events`, cookieB, { topicIdx: 0, cellIdx: 0, closesCell: true })).statusCode,
    404,
  )
  assert.equal((await post(`/api/sessions/${s.id}/undo`, cookieB)).statusCode, 404)
  assert.equal((await post(`/api/sessions/${s.id}/end`, cookieB)).statusCode, 404)
  // B can't start a session on A's board either.
  assert.equal(
    (await post('/api/sessions', cookieB, { boardId: board.id, players: [{ name: 'X' }] })).statusCode,
    404,
  )
})

test('ending a session clears the library indicator', async () => {
  const s = await startSession()
  await post(`/api/sessions/${s.id}/end`, cookieA)
  const list = JSON.parse((await get('/api/boards', cookieA)).body)
  assert.equal(list[0].activeSessionId, null)
})
