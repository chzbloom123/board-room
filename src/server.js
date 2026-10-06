import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { prisma } from './db.js'
import { authRoutes } from './auth.js'
import { boardRoutes } from './boards.js'
import { sessionRoutes } from './sessions.js'
import { adminRoutes } from './admin.js'

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

// Redact anything that could carry credential material out of request logs.
// Auth state travels in cookies; bodies of auth routes carry passwords.
const logRedactions = {
  paths: [
    'req.headers.cookie',
    'req.headers.authorization',
    'res.headers["set-cookie"]',
  ],
  censor: '[redacted]',
}

export function buildApp({ logger = true, loggerStream } = {}) {
  const app = Fastify({
    logger: logger ? { redact: logRedactions, stream: loggerStream } : false,
    trustProxy: true, // Railway terminates TLS in front of the app
    bodyLimit: 2 * 1024 * 1024, // a board CSV is kilobytes; 2 MB is generous
  })

  app.register(fastifyCookie, { secret: config.sessionSecret })

  app.register(fastifyStatic, { root: publicDir })

  // The admin panel is its own small page: /admin → public/admin.html.
  app.get('/admin', (request, reply) => reply.sendFile('admin.html'))

  app.register(authRoutes)
  app.register(boardRoutes)
  app.register(sessionRoutes)
  app.register(adminRoutes)

  app.get('/healthz', async (request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return { status: 'ok' }
    } catch (err) {
      request.log.error({ err }, 'healthz database check failed')
      return reply.code(503).send({ status: 'unavailable' })
    }
  })

  return app
}
