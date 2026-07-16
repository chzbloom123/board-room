import { prisma } from './db.js'
import { requireProfile } from './auth.js'

// All routes here are bucket-scoped: the owning profile comes from the
// session (request.profile), and every query filters on ownerProfileId.
// A resource that exists but belongs to another bucket returns 404 —
// indistinguishable from not existing at all.
export async function boardRoutes(app) {
  app.addHook('preHandler', requireProfile)

  app.get('/api/boards', async (request) => {
    const boards = await prisma.board.findMany({
      where: { ownerProfileId: request.profile.id },
      orderBy: { updatedAt: 'desc' },
    })
    return boards.map(boardSummary)
  })

  app.get('/api/boards/:id', async (request, reply) => {
    const board = await prisma.board.findFirst({
      where: { id: request.params.id, ownerProfileId: request.profile.id },
    })
    if (!board) return reply.code(404).send({ error: 'Board not found' })
    return board
  })
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
