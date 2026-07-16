import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp, prisma, resetDb, createProfile, login } from './helpers.js'
import { csvFromTopics } from '../public/js/csv.js'

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name) => fs.readFileSync(path.join(fixtureDir, name), 'utf8')

let app
let cookieA
let cookieB

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
  await createProfile('Group A', 'password-a')
  await createProfile('Group B', 'password-b')
  cookieA = (await login(app, 'Group A', 'password-a')).cookie
  cookieB = (await login(app, 'Group B', 'password-b')).cookie
})

const post = (url, cookie, payload) =>
  app.inject({ method: 'POST', url, headers: { cookie }, payload })
const put = (url, cookie, payload) =>
  app.inject({ method: 'PUT', url, headers: { cookie }, payload })
const get = (url, cookie) => app.inject({ method: 'GET', url, headers: { cookie } })
const del = (url, cookie) => app.inject({ method: 'DELETE', url, headers: { cookie } })

test('create board from valid CSV, listed with counts', async () => {
  const res = await post('/api/boards', cookieA, {
    name: 'Safety Review',
    csv: fixture('valid-classic.csv'),
  })
  assert.equal(res.statusCode, 200)
  const { board, warnings } = JSON.parse(res.body)
  assert.deepEqual(warnings, [])
  assert.equal(board.topics.length, 6)

  const list = JSON.parse((await get('/api/boards', cookieA)).body)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'Safety Review')
  assert.equal(list[0].topicCount, 6)
  assert.equal(list[0].questionCount, 30)
})

test('bad CSV never becomes a saved board (SPEC §5)', async () => {
  const res = await post('/api/boards', cookieA, {
    name: 'Broken',
    csv: fixture('multi-error.csv'),
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.errors.length >= 4)
  assert.equal(await prisma.board.count(), 0)
})

test('odd-shaped board saves with warnings (SPEC §5)', async () => {
  const res = await post('/api/boards', cookieA, {
    name: 'Odd',
    csv: fixture('valid-odd-shape.csv'),
  })
  assert.equal(res.statusCode, 200)
  const { warnings } = JSON.parse(res.body)
  assert.equal(warnings.length, 2)
  assert.equal(await prisma.board.count(), 1)
})

test('edit persists; a validation error leaves the stored board untouched (SPEC §6.3)', async () => {
  const created = JSON.parse(
    (await post('/api/boards', cookieA, { name: 'B', csv: fixture('valid-classic.csv') })).body,
  ).board

  // Regenerate CSV exactly as the edit screen does, change one question.
  const csv = csvFromTopics(created.topics).replace(
    'What does PPE stand for?',
    'PPE is short for what?',
  )
  const edited = await put(`/api/boards/${created.id}`, cookieA, { name: 'B', csv })
  assert.equal(edited.statusCode, 200)

  const reloaded = JSON.parse((await get(`/api/boards/${created.id}`, cookieA)).body)
  assert.equal(reloaded.topics[0].cells[0].question, 'PPE is short for what?')

  // Now a broken edit: must 400 and leave the stored board exactly as it was.
  const badEdit = await put(`/api/boards/${created.id}`, cookieA, {
    name: 'B',
    csv: fixture('bad-points.csv'),
  })
  assert.equal(badEdit.statusCode, 400)
  const untouched = JSON.parse((await get(`/api/boards/${created.id}`, cookieA)).body)
  assert.deepEqual(untouched.topics, reloaded.topics)
})

test('export → delete → import restores the board losslessly (SPEC §6.4 AC)', async () => {
  const created = JSON.parse(
    (await post('/api/boards', cookieA, { name: 'Handoff', csv: fixture('quoted-commas.csv') })).body,
  ).board

  const exported = JSON.parse(
    (await get(`/api/boards/${created.id}/export`, cookieA)).body,
  )
  assert.equal(exported.app, 'board-room')

  await del(`/api/boards/${created.id}`, cookieA)
  assert.equal(await prisma.board.count(), 0)

  const imported = await post('/api/boards/import', cookieA, {
    name: exported.name,
    topics: exported.topics,
  })
  assert.equal(imported.statusCode, 200)
  const restored = JSON.parse(imported.body).board
  assert.deepEqual(restored.topics, created.topics)
  assert.equal(restored.name, 'Handoff')
})

test('import rejects malformed topics through the shared validator', async () => {
  const res = await post('/api/boards/import', cookieA, {
    name: 'Evil',
    topics: [{ name: 'T', cells: [{ points: 100, question: 'Q', answer: 'A' }, { points: 100, question: 'Q2', answer: 'A2' }] }],
  })
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).errors[0].message, /duplicate point value 100/i)
  assert.equal(await prisma.board.count(), 0)
})

test('full CSV → edit → export → import round-trip preserves topics deep-equal (PLAN Phase 3 exit 2)', async () => {
  const created = JSON.parse(
    (await post('/api/boards', cookieA, { name: 'RT', csv: fixture('valid-classic.csv') })).body,
  ).board

  // Edit view: regenerate CSV from stored JSON, save unchanged.
  const regenerated = csvFromTopics(created.topics)
  const resaved = JSON.parse(
    (await put(`/api/boards/${created.id}`, cookieA, { name: 'RT', csv: regenerated })).body,
  ).board
  assert.deepEqual(resaved.topics, created.topics)

  const exported = JSON.parse((await get(`/api/boards/${created.id}/export`, cookieA)).body)
  await del(`/api/boards/${created.id}`, cookieA)
  const imported = JSON.parse(
    (await post('/api/boards/import', cookieA, exported)).body,
  ).board
  assert.deepEqual(imported.topics, created.topics)
})

test('isolation re-check: profile B cannot touch profile A\'s board via any route (PLAN Phase 3 exit 3)', async () => {
  const boardA = JSON.parse(
    (await post('/api/boards', cookieA, { name: 'A only', csv: fixture('headerless.csv') })).body,
  ).board

  const attempts = [
    get(`/api/boards/${boardA.id}`, cookieB),
    get(`/api/boards/${boardA.id}/export`, cookieB),
    put(`/api/boards/${boardA.id}`, cookieB, { name: 'stolen', csv: 'X,100,Q,A' }),
    del(`/api/boards/${boardA.id}`, cookieB),
  ]
  for (const attempt of await Promise.all(attempts)) {
    assert.equal(attempt.statusCode, 404)
  }

  // B's list is empty; A's board is untouched and still owned by A.
  assert.deepEqual(JSON.parse((await get('/api/boards', cookieB)).body), [])
  const intact = JSON.parse((await get(`/api/boards/${boardA.id}`, cookieA)).body)
  assert.equal(intact.name, 'A only')
})

test('deleting a board requires ownership and removes its sessions', async () => {
  const board = JSON.parse(
    (await post('/api/boards', cookieA, { name: 'D', csv: fixture('headerless.csv') })).body,
  ).board
  const profileA = await prisma.instructorProfile.findUnique({ where: { name: 'Group A' } })
  await prisma.gameSession.create({
    data: {
      ownerProfileId: profileA.id,
      boardId: board.id,
      state: { players: [], usedCells: [], log: [] },
      status: 'active',
    },
  })
  const res = await del(`/api/boards/${board.id}`, cookieA)
  assert.equal(res.statusCode, 200)
  assert.equal(await prisma.gameSession.count(), 0)
})
