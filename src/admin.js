import { prisma } from './db.js'
import { requireAdmin, validateProfileName, validatePassword, hashPassword } from './auth.js'

// Site-owner maintenance hatch (SPEC §6.8). Every route requires the admin
// session (env credentials, never a database row). Instructor sessions get
// 403 here, and admin sessions get 401 on instructor routes — the two
// layers never overlap.
//
// Profile deletion policy (PLAN Phase 6): BLOCK IF NON-EMPTY. A profile
// that still owns boards or game sessions cannot be deleted; move or delete
// its boards first (finished sessions are removed with their board). This
// makes "delete" always reversible-by-inspection: nothing disappears that
// the admin has not looked at.

export async function adminRoutes(app) {
  app.addHook('preHandler', requireAdmin)

  // ---- Instructor profiles ----

  app.get('/api/admin/profiles', async () => {
    const [profiles, boards, sessions] = await Promise.all([
      prisma.instructorProfile.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, createdAt: true } }),
      prisma.board.groupBy({ by: ['ownerProfileId'], _count: { _all: true } }),
      prisma.gameSession.groupBy({ by: ['ownerProfileId'], where: { status: 'active' }, _count: { _all: true } }),
    ])
    const boardCount = new Map(boards.map((b) => [b.ownerProfileId, b._count._all]))
    const activeCount = new Map(sessions.map((s) => [s.ownerProfileId, s._count._all]))
    return profiles.map((p) => ({
      ...p,
      boardCount: boardCount.get(p.id) ?? 0,
      activeSessionCount: activeCount.get(p.id) ?? 0,
    }))
  })

  app.post('/api/admin/profiles', async (request, reply) => {
    const { name, password } = request.body ?? {}
    const nameError = validateProfileName(name)
    if (nameError) return reply.code(400).send({ error: nameError })
    const passwordError = validatePassword(password)
    if (passwordError) return reply.code(400).send({ error: passwordError })
    const trimmed = name.trim()
    if (await prisma.instructorProfile.findUnique({ where: { name: trimmed } })) {
      return reply.code(409).send({ error: 'That profile name is already taken' })
    }
    const profile = await prisma.instructorProfile.create({
      data: { name: trimmed, passwordHash: await hashPassword(password) },
      select: { id: true, name: true, createdAt: true },
    })
    return reply.code(201).send({ profile })
  })

  app.put('/api/admin/profiles/:id', async (request, reply) => {
    const profile = await prisma.instructorProfile.findUnique({ where: { id: request.params.id } })
    if (!profile) return reply.code(404).send({ error: 'Profile not found' })
    const { name } = request.body ?? {}
    const nameError = validateProfileName(name)
    if (nameError) return reply.code(400).send({ error: nameError })
    const trimmed = name.trim()
    const clash = await prisma.instructorProfile.findUnique({ where: { name: trimmed } })
    if (clash && clash.id !== profile.id) {
      return reply.code(409).send({ error: 'That profile name is already taken' })
    }
    const updated = await prisma.instructorProfile.update({
      where: { id: profile.id },
      data: { name: trimmed },
      select: { id: true, name: true, createdAt: true },
    })
    return { profile: updated }
  })

  app.post('/api/admin/profiles/:id/password', async (request, reply) => {
    const profile = await prisma.instructorProfile.findUnique({ where: { id: request.params.id } })
    if (!profile) return reply.code(404).send({ error: 'Profile not found' })
    const { password } = request.body ?? {}
    const passwordError = validatePassword(password)
    if (passwordError) return reply.code(400).send({ error: passwordError })
    await prisma.instructorProfile.update({
      where: { id: profile.id },
      data: { passwordHash: await hashPassword(password) },
    })
    return { ok: true }
  })

  app.delete('/api/admin/profiles/:id', async (request, reply) => {
    const profile = await prisma.instructorProfile.findUnique({ where: { id: request.params.id } })
    if (!profile) return reply.code(404).send({ error: 'Profile not found' })
    const [boards, sessions] = await Promise.all([
      prisma.board.count({ where: { ownerProfileId: profile.id } }),
      prisma.gameSession.count({ where: { ownerProfileId: profile.id } }),
    ])
    if (boards > 0 || sessions > 0) {
      return reply.code(409).send({
        error: `"${profile.name}" still owns ${boards} board${boards === 1 ? '' : 's'} and ${sessions} game session${sessions === 1 ? '' : 's'} — move or delete them first`,
      })
    }
    await prisma.instructorProfile.delete({ where: { id: profile.id } })
    return { ok: true }
  })

  // ---- Boards across all buckets ----

  app.get('/api/admin/boards', async () => {
    const boards = await prisma.board.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { owner: { select: { id: true, name: true } } },
    })
    const active = await prisma.gameSession.findMany({ where: { status: 'active' }, select: { boardId: true } })
    const activeBoards = new Set(active.map((s) => s.boardId))
    return boards.map((b) => ({
      id: b.id,
      name: b.name,
      owner: b.owner,
      topicCount: Array.isArray(b.topics) ? b.topics.length : 0,
      questionCount: Array.isArray(b.topics) ? b.topics.reduce((n, t) => n + (t.cells?.length ?? 0), 0) : 0,
      hasFinal: Boolean(b.final),
      hasActiveSession: activeBoards.has(b.id),
      updatedAt: b.updatedAt,
    }))
  })

  // Move a board to another bucket. Its game sessions move with it so the
  // destination can resume or end them; the source loses all trace.
  app.put('/api/admin/boards/:id/owner', async (request, reply) => {
    const board = await prisma.board.findUnique({ where: { id: request.params.id } })
    if (!board) return reply.code(404).send({ error: 'Board not found' })
    const { ownerProfileId } = request.body ?? {}
    const target = await prisma.instructorProfile.findUnique({ where: { id: String(ownerProfileId ?? '') } })
    if (!target) return reply.code(400).send({ error: 'Destination profile not found' })
    await prisma.$transaction([
      prisma.board.update({ where: { id: board.id }, data: { ownerProfileId: target.id } }),
      prisma.gameSession.updateMany({ where: { boardId: board.id }, data: { ownerProfileId: target.id } }),
    ])
    return { ok: true }
  })

  app.delete('/api/admin/boards/:id', async (request, reply) => {
    const board = await prisma.board.findUnique({ where: { id: request.params.id } })
    if (!board) return reply.code(404).send({ error: 'Board not found' })
    await prisma.$transaction([
      prisma.gameSession.deleteMany({ where: { boardId: board.id } }),
      prisma.board.delete({ where: { id: board.id } }),
    ])
    return { ok: true }
  })

  // ---- Game sessions ----

  app.get('/api/admin/sessions', async () => {
    const sessions = await prisma.gameSession.findMany({
      where: { status: 'active' },
      orderBy: { updatedAt: 'desc' },
      include: { owner: { select: { id: true, name: true } } },
    })
    const boardIds = [...new Set(sessions.map((s) => s.boardId))]
    const boards = await prisma.board.findMany({ where: { id: { in: boardIds } }, select: { id: true, name: true } })
    const boardName = new Map(boards.map((b) => [b.id, b.name]))
    return sessions.map((s) => ({
      id: s.id,
      owner: s.owner,
      boardName: boardName.get(s.boardId) ?? '(deleted board)',
      players: (s.state?.players ?? []).map((p) => `${p.name} ${p.score}`),
      events: s.state?.log?.length ?? 0,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }))
  })

  app.post('/api/admin/sessions/:id/end', async (request, reply) => {
    const session = await prisma.gameSession.findUnique({ where: { id: request.params.id } })
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    await prisma.gameSession.update({ where: { id: session.id }, data: { status: 'finished' } })
    return { ok: true }
  })

  // ---- Backup ----
  // Everything needed to rebuild the site's content elsewhere: profiles
  // (with password hashes, so logins survive a restore — the file is
  // sensitive, treat it like the database) and every board. Live game
  // state is deliberately left out; it is ephemeral.
  app.get('/api/admin/backup', async (request, reply) => {
    const data = await buildBackup()
    const stamp = data.exportedAt.slice(0, 10)
    reply.header('content-disposition', `attachment; filename="board-room-backup-${stamp}.json"`)
    return data
  })
}

export async function buildBackup() {
  const profiles = await prisma.instructorProfile.findMany({
    orderBy: { name: 'asc' },
    include: { boards: { orderBy: { name: 'asc' } } },
  })
  return {
    app: 'board-room',
    kind: 'full-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: profiles.map((p) => ({
      name: p.name,
      passwordHash: p.passwordHash,
      createdAt: p.createdAt,
      boards: p.boards.map((b) => ({
        name: b.name,
        topics: b.topics,
        final: b.final ?? null,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      })),
    })),
  }
}
