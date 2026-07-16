import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { prisma } from './db.js'

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

export function buildApp({ logger = true } = {}) {
  const app = Fastify({
    logger: logger ? { redact: logRedactions } : false,
    trustProxy: true, // Railway terminates TLS in front of the app
  })

  app.register(fastifyCookie, { secret: config.sessionSecret })

  app.register(fastifyStatic, { root: publicDir })

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
