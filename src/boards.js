import { prisma } from './db.js'
import { requireProfile } from './auth.js'
// The single shared parser/validator — the same file the browser loads.
import { boardFromCsv, validateTopics } from '../public/js/csv.js'

// All routes here are bucket-scoped: the owning profile comes from the
// session (request.profile), and every query filters on ownerProfileId.
// A resource that exists but belongs to another bucket returns 404 —
// indistinguishable from not existing at all.
export async function boardRoutes(app) {
  app.addHook('preHandler', requireProfile)

  app.get('/api/boards', async (request) => {
    const [boards, activeSessions] = await Promise.all([
      prisma.board.findMany({
        where: { ownerProfileId: request.profile.id },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.gameSession.findMany({
        where: { ownerProfileId: request.profile.id, status: 'active' },
        select: { id: true, boardId: true },
      }),
    ])
    const sessionByBoard = new Map(activeSessions.map((s) => [s.boardId, s.id]))
    return boards.map((b) => ({
      ...boardSummary(b),
      activeSessionId: sessionByBoard.get(b.id) ?? null,
    }))
  })

  app.get('/api/boards/:id', async (request, reply) => {
    const board = await findOwn(request)
    if (!board) return reply.code(404).send({ error: 'Board not found' })
    return board
  })

  // Server-side validation is the gate: a bad CSV can never become a saved
  // board (SPEC §5), whatever the client did.
  app.post('/api/boards', async (request, reply) => {
    const { name, csv } = request.body ?? {}
    const parsed = parseAndValidate(name, csv)
    if (parsed.errors.length > 0) {
      return reply.code(400).send({ errors: parsed.errors, warnings: parsed.warnings })
    }
    const board = await prisma.board.create({
      data: {
        ownerProfileId: request.profile.id,
        name: name.trim(),
        topics: parsed.topics,
      },
    })
    return { board, warnings: parsed.warnings }
  })

  // A validation error must leave the stored board untouched (SPEC §6.3) —
  // guaranteed here because nothing is written unless validation passes.
  app.put('/api/boards/:id', async (request, reply) => {
    const existing = await findOwn(request)
    if (!existing) return reply.code(404).send({ error: 'Board not found' })
    const { name, csv } = request.body ?? {}
    const parsed = parseAndValidate(name, csv)
    if (parsed.errors.length > 0) {
      return reply.code(400).send({ errors: parsed.errors, warnings: parsed.warnings })
    }
    const board = await prisma.board.update({
      where: { id: existing.id },
      data: { name: name.trim(), topics: parsed.topics },
    })
    return { board, warnings: parsed.warnings }
  })

  app.delete('/api/boards/:id', async (request, reply) => {
    const existing = await findOwn(request)
    if (!existing) return reply.code(404).send({ error: 'Board not found' })
    await prisma.gameSession.deleteMany({ where: { boardId: existing.id } })
    await prisma.board.delete({ where: { id: existing.id } })
    return { ok: true }
  })

  // Export/import is the backup and colleague-handoff path (SPEC §6.4).
  app.get('/api/boards/:id/export', async (request, reply) => {
    const board = await findOwn(request)
    if (!board) return reply.code(404).send({ error: 'Board not found' })
    return {
      app: 'board-room',
      version: 1,
      name: board.name,
      topics: board.topics,
    }
  })

  app.post('/api/boards/import', async (request, reply) => {
    const { name, topics } = request.body ?? {}
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ errors: [{ message: 'Board name required' }] })
    }
    const { errors, warnings } = validateTopics(topics)
    if (errors.length > 0) {
      return reply.code(400).send({ errors, warnings })
    }
    const board = await prisma.board.create({
      data: { ownerProfileId: request.profile.id, name: name.trim(), topics },
    })
    return { board, warnings }
  })

  function findOwn(request) {
    return prisma.board.findFirst({
      where: { id: request.params.id, ownerProfileId: request.profile.id },
    })
  }
}

function parseAndValidate(name, csv) {
  const errors = []
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push({ message: 'Board name required' })
  }
  if (typeof csv !== 'string') {
    errors.push({ message: 'CSV text required' })
    return { errors, warnings: [], topics: [] }
  }
  const parsed = boardFromCsv(csv)
  return {
    topics: parsed.topics,
    errors: [...errors, ...parsed.errors],
    warnings: parsed.warnings,
  }
}

function boardSummary(board) {
  const topics = Array.isArray(board.topics) ? board.topics : []
  return {
    id: board.id,
    name: board.name,
    topicCount: topics.length,
    questionCount: topics.reduce((n, t) => n + (t.cells?.length ?? 0), 0),
    updatedAt: board.updatedAt,
  }
}
