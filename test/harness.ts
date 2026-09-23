// 测试基础设施：
//  - 两个真实 Fastify API 实例，各自独立 pg 连接池、监听不同端口
//    （模拟 compose 中 api-1 / api-2，仅共享 PostgreSQL 裁决）
//  - 每个测试前用真实 SQL 清空业务表（无任何假接口/内存实现）
import { buildServer, type ServerHandle } from '../src/server/server.js'
import { runMigrations } from '../src/server/migrate.js'
import { seedUsers, SEED_USERS } from '../src/server/seed.js'
import { pool } from '../src/server/db.js'
import type { ErrorBody, LoginResponse, Snapshot, User } from '../src/shared/types.js'

export const PORT_A = 4171
export const PORT_B = 4172

let instanceA: ServerHandle | null = null
let instanceB: ServerHandle | null = null

export async function startTwoInstances() {
  await runMigrations(pool)
  await seedUsers(pool)
  instanceA = await buildServer()
  instanceB = await buildServer()
  await instanceA.app.listen({ port: PORT_A, host: '127.0.0.1' })
  await instanceB.app.listen({ port: PORT_B, host: '127.0.0.1' })
}

export async function stopTwoInstances() {
  await Promise.all([instanceA?.stop(), instanceB?.stop()])
  instanceA = null
  instanceB = null
}

/** 清空业务数据，保留用户表（重新幂等播种） */
export async function resetData() {
  await pool.query('TRUNCATE personal_locks, isolation_points, authorizations, tickets RESTART IDENTITY CASCADE')
}

export function baseUrl(port: number) {
  return `http://127.0.0.1:${port}`
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: ErrorBody,
  ) {
    super(body.error.message)
  }
}

async function rawFetch(
  port: number,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  const res = await fetch(`${baseUrl(port)}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : {}
  if (!res.ok) throw new HttpError(res.status, json as ErrorBody)
  return json
}

export async function login(
  port: number,
  username: string,
  password: string,
): Promise<LoginResponse> {
  return rawFetch(port, 'POST', '/api/login', undefined, {
    username,
    password,
  })
}

export interface Client {
  token: string
  user: User
  port: number
  get: <T = any>(path: string) => Promise<T>
  post: <T = any>(path: string, body?: unknown) => Promise<T>
  del: <T = any>(path: string, body?: unknown) => Promise<T>
}

export async function clientFor(
  port: number,
  cred: { username: string; password: string },
): Promise<Client> {
  const { token, user } = await login(port, cred.username, cred.password)
  return {
    token,
    user,
    port,
    get: (path) => rawFetch(port, 'GET', path, token),
    post: (path, body) => rawFetch(port, 'POST', path, token, body ?? {}),
    del: (path, body) => rawFetch(port, 'DELETE', path, token, body ?? {}),
  }
}

export const CREDS = {
  coord: { username: 'coord', password: 'coord123' },
  lead: { username: 'lead', password: 'lead123' },
  zhang: { username: 'zhang', password: 'worker123' },
  li: { username: 'li', password: 'worker123' },
  wang: { username: 'wang', password: 'worker123' },
}

export async function createTicketAsCoord(
  port: number,
  opts: { device: string; points: string[]; personnel: string[] },
): Promise<Snapshot> {
  const coord = await clientFor(port, CREDS.coord)
  const res = await coord.post<{ snapshot: Snapshot }>('/api/tickets', opts)
  return res.snapshot
}

/** 直接读库快照（断言"败方所见与数据库一致"的基准真值） */
export async function dbSnapshot(ticketId: number): Promise<{
  status: string
  revision: number
  locks: number
  unconfirmed: number
}> {
  const [t, l, p] = await Promise.all([
    pool.query<{ status: string; revision: number }>(
      'SELECT status, revision FROM tickets WHERE id = $1',
      [ticketId],
    ),
    pool.query('SELECT count(*)::int AS c FROM personal_locks WHERE ticket_id = $1', [
      ticketId,
    ]),
    pool.query(
      `SELECT count(*)::int AS c FROM isolation_points
       WHERE ticket_id = $1 AND confirmed_by IS NULL`,
      [ticketId],
    ),
  ])
  return {
    status: t.rows[0].status,
    revision: Number(t.rows[0].revision),
    locks: l.rows[0].c,
    unconfirmed: p.rows[0].c,
  }
}

/** 确认全部点 + 清锁，使票进入可复位状态（走真实 API） */
export async function makeResetReady(
  ticketId: number,
  workerPorts: Array<{ port: number; username: string; password: string }>,
) {
  const snap = await (
    await clientFor(workerPorts[0].port, {
      username: workerPorts[0].username,
      password: workerPorts[0].password,
    })
  ).get<{ snapshot: Snapshot }>(`/api/tickets/${ticketId}`)

  for (const point of snap.snapshot.points) {
    if (point.confirmed_by != null) continue
    // 找一个授权工人（都被授权）确认
    const w = workerPorts[0]
    const c = await clientFor(w.port, { username: w.username, password: w.password })
    const cur = await c.get<{ snapshot: Snapshot }>(`/api/tickets/${ticketId}`)
    await c.post(`/api/tickets/${ticketId}/confirm`, {
      pointId: point.id,
      revision: cur.snapshot.ticket.revision,
    })
  }

  // 撤掉所有现存个人锁
  for (const w of workerPorts) {
    const c = await clientFor(w.port, { username: w.username, password: w.password })
    const cur = await c.get<{ snapshot: Snapshot }>(`/api/tickets/${ticketId}`)
    if (cur.snapshot.locks.some((l) => l.username === w.username)) {
      await c.del(`/api/tickets/${ticketId}/locks`, {
        revision: cur.snapshot.ticket.revision,
      })
    }
  }
}

export { SEED_USERS }
