// Prisma 7 CLI config. The CLI does not auto-load .env; Node 21+'s
// process.loadEnvFile covers local dev without a dotenv dependency.
import { defineConfig } from 'prisma/config'

try {
  process.loadEnvFile()
} catch {
  // No .env file (e.g. CI / Railway) — env vars come from the platform.
}

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
})
