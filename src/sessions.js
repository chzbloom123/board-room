import { prisma } from './db.js'
import { requireProfile } from './auth.js'

// Live game sessions (SPEC §6.5–6.6). The scoring log is the single source
// of truth: every event appends one log entry and applies it to the
// materialized players/usedCells; undo pops the last entry and reverts
// exactly what it applied. State persists on every event — resume is just
// reading the row back.
//
// Log entry: { playerIdx|null, points|null, correct|null, topicIdx, cellIdx,
//              closesCell, final?, ts }
//   playerIdx present → score change of (correct ? +points : -points)
//   closesCell true   → the cell became used
//   final true        → a final-round judgment; points is that player's wager
// A "correct" judgment closes the cell in the same entry, so undoing it
// reopens the cell AND reverts the score atomically (PLAN Phase 4 exit 1).
//
// Final round (owner override of SPEC §7, see issues.md): state.final is
// { wagers: [n per player], judged: [playerIdx...] }. It exists once wagers
// are locked. Each judgment is an ordinary log entry with final:true, so
// undo and resume need no special machinery beyond reverting `judged`.

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
    const body = request.body ?? {}

    if (body.final === true) return finalJudgment(session, state, body, reply)

    const { playerIdx = null, correct = null, topicIdx, cellIdx, closesCell = false } = body

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

  // Final round, step 1: lock every player's wager. A wager is an integer
  // from 0 up to the player's current score (0 if they are at or below 0).
  app.post('/api/sessions/:id/final/start', async (request, reply) => {
    const session = await findOwn(request)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (session.status !== 'active') {
      return reply.code(409).send({ error: 'Session is finished' })
    }
    const board = await prisma.board.findFirst({ where: { id: session.boardId } })
    if (!board?.final) return reply.code(400).send({ error: 'This board has no final round' })
    const state = session.state
    if (state.final) return reply.code(409).send({ error: 'Final round already started' })

    const { wagers } = request.body ?? {}
    if (!Array.isArray(wagers) || wagers.length !== state.players.length) {
      return reply.code(400).send({ error: 'One wager per player is required' })
    }
    for (let i = 0; i < wagers.length; i++) {
      const w = wagers[i]
      const max = Math.max(0, state.players[i].score)
      if (!Number.isInteger(w) || w < 0 || w > max) {
        return reply.code(400).send({
          error: `${state.players[i].name} can wager between 0 and ${max}`,
        })
      }
    }
    state.final = { wagers, judged: [], ts: new Date().toISOString() }
    const updated = await prisma.gameSession.update({
      where: { id: session.id },
      data: { state },
    })
    return { session: updated }
  })

  // Final round, step 2 (via /events with final:true): judge one player.
  // Points are the locked wager — never taken from the client.
  async function finalJudgment(session, state, body, reply) {
    if (!state.final) return reply.code(409).send({ error: 'Final round has not started' })
    const { playerIdx, correct } = body
    if (!Number.isInteger(playerIdx) || !state.players[playerIdx]) {
      return reply.code(400).send({ error: 'No such player' })
    }
    if (typeof correct !== 'boolean') {
      return reply.code(400).send({ error: 'correct must be true or false' })
    }
    if (state.final.judged.includes(playerIdx)) {
      return reply.code(409).send({ error: 'Player already judged in the final round' })
    }
    const wager = state.final.wagers[playerIdx]
    const entry = {
      playerIdx,
      points: wager,
      correct,
      topicIdx: null,
      cellIdx: null,
      closesCell: false,
      final: true,
      ts: new Date().toISOString(),
    }
    state.players[playerIdx].score += correct ? wager : -wager
    state.final.judged.push(playerIdx)
    state.log.push(entry)
    const updated = await prisma.gameSession.update({
      where: { id: session.id },
      data: { state },
    })
    return { session: updated }
  }

  // Undo: revert the last log entry — score change and, if it closed the
  // cell, the cell's used state (SPEC §6.5). A final-round judgment also
  // becomes un-judged so the player can be re-judged.
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
    if (entry.final && state.final) {
      state.final.judged = state.final.judged.filter((i) => i !== entry.playerIdx)
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
