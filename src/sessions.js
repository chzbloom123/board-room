import { prisma } from './db.js'
import { requireProfile } from './auth.js'

// Live game sessions (SPEC §6.5–6.6). The scoring log is the single source
// of truth: every event appends one log entry and applies it to the
// materialized players/usedCells; undo pops the last entry and reverts
// exactly what it applied. State persists on every event — resume is just
// reading the row back.
//
// Log entry: { playerIdx|null, points|null, correct|null, topicIdx, cellIdx,
//              closesCell, ts }
//   playerIdx present → score change of (correct ? +points : -points)
//   closesCell true   → the cell became used
// A "correct" judgment closes the cell in the same entry, so undoing it
// reopens the cell AND reverts the score atomically (PLAN Phase 4 exit 1).

const PLAYER_COLORS = ['#fca311', '#4ade80', '#60a5fa', '#f472b6', '#a78bfa', '#f87171']

export async function sessionRoutes(app) {
  app.addHook('preHandler', requireProfile)

  app.post('/api/sessions', async (request, reply) => {
    const { boardId, players } = request.body ?? {}
    const board = await prisma.board.findFirst({
      where: { id: boardId ?? '', ownerProfileId: request.profile.id },
    })
    if (!board) return reply.code(404).send({ error: 'Board not found' })

    if (!Array.isArray(players) || players.length === 0) {
      return reply.code(400).send({ error: 'At least one player is required' })
    }
    const names = players.map((p) => String(p?.name ?? '').trim())
    if (names.some((n) => n === '')) {
      return reply.code(400).send({ error: 'Every player needs a name' })
    }
    if (new Set(names).size !== names.length) {
      return reply.code(400).send({ error: 'Player names must be distinct' })
    }

    const session = await prisma.gameSession.create({
      data: {
        ownerProfileId: request.profile.id,
        boardId: board.id,
        status: 'active',
        state: {
          players: names.map((name, i) => ({
            name,
            color: typeof players[i]?.color === 'string' ? players[i].color : PLAYER_COLORS[i % PLAYER_COLORS.length],
            score: 0,
          })),
          usedCells: [],
          log: [],
        },
      },
    })
    return { session }
  })

  app.get('/api/sessions/:id', async (request, reply) => {
    const session = await findOwn(request)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    const board = await prisma.board.findFirst({ where: { id: session.boardId } })
    return { session, board }
  })

  // One scoring/closing event. Applies and persists atomically.
  app.post('/api/sessions/:id/events', async (request, reply) => {
    const session = await findOwn(request)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (session.status !== 'active') {
      return reply.code(409).send({ error: 'Session is finished' })
    }
    const board = await prisma.board.findFirst({ where: { id: session.boardId } })
    const state = session.state
    const { playerIdx = null, correct = null, topicIdx, cellIdx, closesCell = false } = request.body ?? {}

    const cell = board?.topics?.[topicIdx]?.cells?.[cellIdx]
    if (!Number.isInteger(topicIdx) || !Number.isInteger(cellIdx) || !cell) {
      return reply.code(400).send({ error: 'No such cell' })
    }
    if (isUsed(state, topicIdx, cellIdx)) {
      return reply.code(409).send({ error: 'Cell already used' })
    }
    if (playerIdx === null && !closesCell) {
      return reply.code(400).send({ error: 'Event does nothing' })
    }

    const entry = {
      playerIdx: null,
      points: null,
      correct: null,
      topicIdx,
      cellIdx,
      closesCell: Boolean(closesCell),
      ts: new Date().toISOString(),
    }
    if (playerIdx !== null) {
      if (!Number.isInteger(playerIdx) || !state.players[playerIdx]) {
        return reply.code(400).send({ error: 'No such player' })
      }
      if (typeof correct !== 'boolean') {
        return reply.code(400).send({ error: 'correct must be true or false' })
      }
      // Points always come from the board cell — never from the client.
      entry.playerIdx = playerIdx
      entry.points = cell.points
      entry.correct = correct
      state.players[playerIdx].score += correct ? cell.points : -cell.points
    }
    if (entry.closesCell) {
      state.usedCells.push([topicIdx, cellIdx])
    }
    state.log.push(entry)

    const updated = await prisma.gameSession.update({
      where: { id: session.id },
      data: { state },
    })
    return { session: updated }
  })

  // Undo: revert the last log entry — score change and, if it closed the
  // cell, the cell's used state (SPEC §6.5).
  app.post('/api/sessions/:id/undo', async (request, reply) => {
    const session = await findOwn(request)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (session.status !== 'active') {
      return reply.code(409).send({ error: 'Session is finished' })
    }
    const state = session.state
    const entry = state.log.pop()
    if (!entry) return reply.code(409).send({ error: 'Nothing to undo' })

    if (entry.playerIdx !== null && state.players[entry.playerIdx]) {
      state.players[entry.playerIdx].score -= entry.correct ? entry.points : -entry.points
    }
    if (entry.closesCell) {
      state.usedCells = state.usedCells.filter(
        ([t, c]) => !(t === entry.topicIdx && c === entry.cellIdx),
      )
    }

    const updated = await prisma.gameSession.update({
      where: { id: session.id },
      data: { state },
    })
    return { session: updated, undone: entry }
  })

  app.post('/api/sessions/:id/end', async (request, reply) => {
    const session = await findOwn(request)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    const updated = await prisma.gameSession.update({
      where: { id: session.id },
      data: { status: 'finished' },
    })
    return { session: updated }
  })

  function findOwn(request) {
    return prisma.gameSession.findFirst({
      where: { id: request.params.id, ownerProfileId: request.profile.id },
    })
  }
}

function isUsed(state, topicIdx, cellIdx) {
  return state.usedCells.some(([t, c]) => t === topicIdx && c === cellIdx)
}
