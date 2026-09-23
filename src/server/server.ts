import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { Pool } from 'pg'
import { createPool } from './db.js'
import { runMigrations } from './migrate.js'
import { seedUsers } from './seed.js'
import { verifyToken, verifyCredentials, type AuthPrincipal } from './auth.js'
import {
  BoardError,
  confirmPoint,
  createTicket,
  getSnapshot,
  listTickets,
  placeLock,
  removeLock,
  resetTicket,
} from './board.js'
import type { ErrorBody, Role } from '../shared/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  INTERNAL: 500,
}

function sendError(reply: FastifyReply, err: BoardError) {
  const body: ErrorBody = {
    error: {
      code: err.code,
      message: err.message,
      ...(err.extra.snapshot ? { snapshot: err.extra.snapshot } : {}),
      ...(err.extra.latestRevision !== undefined
        ? { latestRevision: err.extra.latestRevision }
        : {}),
      ...(err.extra.blockers ? { blockers: err.extra.blockers } : {}),
    },
  }
  reply.status(STATUS_BY_CODE[err.code] ?? 500).send(body)
}

function authenticate(
  req: FastifyRequest,
  _reply: FastifyReply,
): AuthPrincipal {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    throw new BoardError('UNAUTHORIZED', '缺少登录令牌')
  }
  return verifyToken(header.slice('Bearer '.length).trim())
}

function requireRole(principal: AuthPrincipal, roles: Role[]) {
  if (!roles.includes(principal.role)) {
    throw new BoardError(
      'FORBIDDEN',
      `该操作要求角色: ${roles.join(' / ')}，当前为 ${principal.role}`,
    )
  }
}

interface BodyWithRevision {
  revision?: number
}

export interface ServerHandle {
  app: FastifyInstance
  db: Pool
  stop: () => Promise<void>
}

/** 构建一个 API 实例：自带独立数据库连接池（compose 下多实例各自独立） */
export async function buildServer(): Promise<ServerHandle> {
  const db = createPool()
  const app = Fastify({ logger: process.env.LOG_REQUESTS === '1' })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BoardError) {
      sendError(reply, err)
      return
    }
    // Fastify 校验错误等 → 稳定 JSON
    if ((err as { validation?: unknown }).validation) {
      const body: ErrorBody = {
        error: { code: 'VALIDATION', message: err.message },
      }
      reply.status(400).send(body)
      return
    }
    app.log.error(err)
    const body: ErrorBody = {
      error: { code: 'INTERNAL', message: '服务器内部错误' },
    }
    reply.status(500).send(body)
  })

  // ------------------------------------------------------------- 认证
  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string }
    if (!body.username || !body.password) {
      throw new BoardError('VALIDATION', '需要 username 与 password')
    }
    const result = await verifyCredentials(body.username, body.password)
    reply.status(200).send(result)
  })

  app.get('/api/me', async (req, reply) => {
    const principal = authenticate(req, reply)
    const { rows } = await db.query(
      `SELECT id, username, display_name, role FROM users WHERE username = $1`,
      [principal.username],
    )
    if (rows.length === 0) throw new BoardError('UNAUTHORIZED', '账号不存在')
    reply.status(200).send({ user: rows[0] })
  })

  // 列出可选的检修人员（协调员建票时使用）
  app.get('/api/workers', async (req, reply) => {
    authenticate(req, reply)
    const { rows } = await db.query(
      `SELECT id, username, display_name FROM users WHERE role = 'worker' ORDER BY id`,
    )
    reply.status(200).send({ workers: rows })
  })

  // ------------------------------------------------------------- 票读取
  app.get('/api/tickets', async (req, reply) => {
    authenticate(req, reply)
    const tickets = await listTickets(db)
    reply.status(200).send({ tickets })
  })

  app.get<{ Params: { id: string } }>(
    '/api/tickets/:id',
    async (req, reply) => {
      authenticate(req, reply)
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) throw new BoardError('VALIDATION', '票号无效')
      const snapshot = await getSnapshot(db, id)
      reply.status(200).send({ snapshot })
    },
  )

  // ------------------------------------------------------------- 新建票
  app.post('/api/tickets', async (req, reply) => {
    const principal = authenticate(req, reply)
    requireRole(principal, ['coordinator'])
    const body = (req.body ?? {}) as {
      device?: string
      points?: string[]
      personnel?: string[]
    }
    const snapshot = await createTicket(
      {
        device: body.device ?? '',
        pointLabels: Array.isArray(body.points) ? body.points : [],
        personnel: Array.isArray(body.personnel) ? body.personnel : [],
        coordinatorUsername: principal.username,
      },
      db,
    )
    reply.status(201).send({ snapshot })
  })

  // ------------------------------------------------------------- 确认点
  app.post<{ Params: { id: string }; Body: BodyWithRevision & { pointId?: number } }>(
    '/api/tickets/:id/confirm',
    async (req, reply) => {
      const principal = authenticate(req, reply)
      requireRole(principal, ['worker'])
      const ticketId = Number(req.params.id)
      const pointId = Number(req.body?.pointId)
      if (!Number.isInteger(ticketId) || !Number.isInteger(pointId)) {
        throw new BoardError('VALIDATION', '票号或隔离点号无效')
      }
      const snapshot = await confirmPoint(
        db,
        principal,
        ticketId,
        pointId,
        Number(req.body?.revision),
      )
      reply.status(200).send({ snapshot })
    },
  )

  // ------------------------------------------------------------- 挂锁
  app.post<{ Params: { id: string }; Body: BodyWithRevision }>(
    '/api/tickets/:id/locks',
    async (req, reply) => {
      const principal = authenticate(req, reply)
      requireRole(principal, ['worker'])
      const ticketId = Number(req.params.id)
      if (!Number.isInteger(ticketId)) {
        throw new BoardError('VALIDATION', '票号无效')
      }
      const snapshot = await placeLock(
        db,
        principal,
        ticketId,
        Number(req.body?.revision),
      )
      reply.status(200).send({ snapshot })
    },
  )

  // ------------------------------------------------------------- 撤锁
  app.delete<{ Params: { id: string }; Body: BodyWithRevision }>(
    '/api/tickets/:id/locks',
    async (req, reply) => {
      const principal = authenticate(req, reply)
      requireRole(principal, ['worker'])
      const ticketId = Number(req.params.id)
      if (!Number.isInteger(ticketId)) {
        throw new BoardError('VALIDATION', '票号无效')
      }
      const snapshot = await removeLock(
        db,
        principal,
        ticketId,
        Number(req.body?.revision),
      )
      reply.status(200).send({ snapshot })
    },
  )

  // ------------------------------------------------------------- 复位
  app.post<{ Params: { id: string }; Body: BodyWithRevision }>(
    '/api/tickets/:id/reset',
    async (req, reply) => {
      const principal = authenticate(req, reply)
      requireRole(principal, ['lead'])
      const ticketId = Number(req.params.id)
      if (!Number.isInteger(ticketId)) {
        throw new BoardError('VALIDATION', '票号无效')
      }
      const snapshot = await resetTicket(
        db,
        principal,
        ticketId,
        Number(req.body?.revision),
      )
      reply.status(200).send({ snapshot })
    },
  )

  // ------------------------------------------------------------- 健康检查
  app.get('/api/health', async (_req, reply) => {
    await db.query('SELECT 1')
    reply.status(200).send({ ok: true })
  })

  // ------------------------------------------------------------- 静态页面
  const distDir = resolve(__dirname, '../../dist')
  if (existsSync(distDir)) {
    app.register(fastifyStatic, { root: distDir, prefix: '/' })
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html')
    })
  }

  const stop = async () => {
    await app.close()
    await db.end()
  }

  return { app, db, stop }
}

async function main() {
  const port = Number(process.env.PORT ?? 4101)
  const host = process.env.HOST ?? '0.0.0.0'

  // 等待数据库就绪并完成迁移/种子（compose 下 db 可能刚启动）
  const bootDb = createPool()
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await bootDb.query('SELECT 1')
      break
    } catch {
      console.log(`[server] 等待数据库就绪… (${attempt}/30)`)
      await new Promise((r) => setTimeout(r, 1000))
      if (attempt === 30) {
        await bootDb.end()
        throw new Error('数据库不可用')
      }
    }
  }
  await runMigrations(bootDb)
  await seedUsers(bootDb)
  await bootDb.end()

  const { app, stop } = await buildServer()
  await app.listen({ port, host })
  console.log(`[server] LOTO API 已监听 http://${host}:${port}`)

  const shutdown = async () => {
    await stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
