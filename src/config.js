// All configuration comes from environment variables (SPEC §9).
// Local dev reads .env via Node's built-in loader; production (Railway)
// supplies real env vars and has no .env file.
try {
  process.loadEnvFile()
} catch {
  // No .env file — fine outside local dev.
}

const required = ['DATABASE_URL', 'ADMIN_USER', 'ADMIN_PASSWORD', 'SESSION_SECRET']
const missing = required.filter((name) => !process.env[name])
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
}

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  adminUser: process.env.ADMIN_USER,
  adminPassword: process.env.ADMIN_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,
  port: Number(process.env.PORT ?? 3000),
  host: '0.0.0.0',
  isProduction: process.env.NODE_ENV === 'production',
}
