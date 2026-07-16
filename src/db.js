import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client.ts'
import { config } from './config.js'

const adapter = new PrismaPg({ connectionString: config.databaseUrl })

export const prisma = new PrismaClient({ adapter })
