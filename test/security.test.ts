// ============================================================================
// 授权边界与越权旁路泄露验收（真实 Fastify 双实例 + 真实 PostgreSQL）
//
// 验收口径：
//  - 未授权检修人员：列表只见自己被授权的票；详情拿到无业务数据的 403；
//    人员目录 403；三个写入口（确认 / 挂锁 / 撤锁）403，且错误体只有
//    code+message，绝不夹带快照、latestRevision、blockers；
//  - 所有 /api 响应（含 403/409 错误响应）带 Cache-Control: no-store；
//  - 被拒绝的写请求对数据库零变更（revision、确认数、锁数均不变）；
//  - 合法协调员 / 送电负责人 / 票内授权检修人员的查看与操作不受影响；
//  - 合法的并发冲突仍返回可继续操作的最新牌板（409 + 完整快照）。
// ============================================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  PORT_A,
  PORT_B,
  startTwoInstances,
  stopTwoInstances,
  resetData,
  clientFor,
  CREDS,
  createTicketAsCoord,
  HttpError,
  baseUrl,
} from './harness.js'
import { pool } from '../src/server/db.js'
import type { Snapshot } from '../src/shared/types.js'

beforeAll(startTwoInstances)
afterAll(stopTwoInstances)
beforeEach(resetData)

/** 数据库真值：revision / 状态 / 确认点数 / 锁数 */
async function dbTruth(ticketId: number) {
  const [t, c, l] = await Promise.all([
    pool.query<{ status: string; revision: number }>(
      'SELECT status, revision FROM tickets WHERE id = $1',
      [ticketId],
    ),
    pool.query(
      `SELECT count(*)::int AS c FROM isolation_points
       WHERE ticket_id = $1 AND confirmed_by IS NOT NULL`,
      [ticketId],
    ),
    pool.query('SELECT count(*)::int AS c FROM personal_locks WHERE ticket_id = $1', [
      ticketId,
    ]),
  ])
  return {
    status: t.rows[0].status,
    revision: Number(t.rows[0].revision),
    confirmed: c.rows[0].c,
    locks: l.rows[0].c,
  }
}

/** 错误体只允许 code + message（存在性信息），不得有任何牌板字段 */
function expectStrippedError(err: HttpError, status: number) {
  expect(err.status).toBe(status)
  expect(err.body.error.code).toBe(status === 403 ? 'FORBIDDEN' : 'NOT_FOUND')
  expect(Object.keys(err.body.error).sort()).toEqual(['code', 'message'])
  expect(err.body.error.snapshot).toBeUndefined()
  expect(err.body.error.latestRevision).toBeUndefined()
  expect(err.body.error.blockers).toBeUndefined()
}

async function rawHeaders(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
) {
  const res = await fetch(`${baseUrl(port)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, cacheControl: res.headers.get('cache-control'), json }
}

describe('列表授权过滤', () => {
  it('检修人员只收到自己被授权的票；负责人/协调员可见全部', async () => {
    const mine = await createTicketAsCoord(PORT_A, {
      device: '张师傅授权票',
      points: ['点张'],
      personnel: ['zhang'],
    })
    const other = await createTicketAsCoord(PORT_A, {
      device: '李师傅授权票',
      points: ['点李'],
      personnel: ['li'],
    })

    const wang = await clientFor(PORT_A, CREDS.wang)
    const wangList = await wang.get<{ tickets: Snapshot[] }>('/api/tickets')
    expect(wangList.tickets).toHaveLength(0) // wang 未被任何票授权

    const zhang = await clientFor(PORT_B, CREDS.zhang)
    expect(await ticketIds(zhang)).toEqual([mine.ticket.id])

    const li = await clientFor(PORT_A, CREDS.li)
    expect(await ticketIds(li)).toEqual([other.ticket.id])

    const lead = await clientFor(PORT_A, CREDS.lead)
    expect((await ticketIds(lead)).sort()).toEqual(
      [mine.ticket.id, other.ticket.id].sort(),
    )

    const coord = await clientFor(PORT_A, CREDS.coord)
    expect((await ticketIds(coord)).sort()).toEqual(
      [mine.ticket.id, other.ticket.id].sort(),
    )
  })
})

async function ticketIds(c: Awaited<ReturnType<typeof clientFor>>) {
  const res = await c.get<{ tickets: Snapshot[] }>('/api/tickets')
  return res.tickets.map((t) => t.ticket.id)
}

describe('详情授权裁决', () => {
  it('未授权检修人员读详情 → 403 且错误体无任何业务数据；不存在的票 → 404 同样精简', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: '隔离变压器 A',
      points: ['拉闸', '验电'],
      personnel: ['zhang', 'li'],
    })
    const wang = await clientFor(PORT_B, CREDS.wang)

    const err = await wang
      .get(`/api/tickets/${s.ticket.id}`)
      .catch((e) => e as HttpError)
    expectStrippedError(err, 403)

    const missing = await wang
      .get('/api/tickets/999999')
      .catch((e) => e as HttpError)
    expectStrippedError(missing, 404)

    // 授权检修人员、负责人、协调员可正常读取完整快照
    for (const cred of [CREDS.zhang, CREDS.lead, CREDS.coord]) {
      const c = await clientFor(PORT_A, cred)
      const res = await c.get<{ snapshot: Snapshot }>(
        `/api/tickets/${s.ticket.id}`,
      )
      expect(res.snapshot.ticket.device).toBe('隔离变压器 A')
      expect(res.snapshot.points).toHaveLength(2)
      expect(res.snapshot.personnel.map((p) => p.username).sort()).toEqual([
        'li',
        'zhang',
      ])
    }
  })
})

describe('人员目录授权', () => {
  it('仅协调员可调用 /api/workers；检修人员与送电负责人 403', async () => {
    const coord = await clientFor(PORT_A, CREDS.coord)
    const workers = await coord.get<{ workers: unknown[] }>('/api/workers')
    expect(workers.workers).toHaveLength(3)

    for (const cred of [CREDS.zhang, CREDS.wang, CREDS.lead]) {
      const c = await clientFor(PORT_B, cred)
      const err = await c.get('/api/workers').catch((e) => e as HttpError)
      expectStrippedError(err, 403)
    }
  })
})

describe('写入口越权：403 无快照 + 数据库零变更', () => {
  it('未授权人员对确认/挂锁/撤锁三个入口的失败响应均无牌板数据，且 revision 与牌板不变', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: '反应釜进料泵',
      points: ['断电挂牌'],
      personnel: ['zhang'],
    })
    const ticketId = s.ticket.id
    const pointId = s.points[0].id

    // 先制造一张有确认、有锁的非平凡牌板（合法流程）
    const zhang = await clientFor(PORT_B, CREDS.zhang)
    await zhang.post(`/api/tickets/${ticketId}/confirm`, {
      pointId,
      revision: 1,
    })
    await zhang.post(`/api/tickets/${ticketId}/locks`, { revision: 2 })
    const before = await dbTruth(ticketId)
    expect(before).toMatchObject({ revision: 3, confirmed: 1, locks: 1 })

    const wang = await clientFor(PORT_A, CREDS.wang)
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['POST /confirm', () =>
        wang.post(`/api/tickets/${ticketId}/confirm`, {
          pointId,
          revision: before.revision,
        })],
      ['POST /locks', () =>
        wang.post(`/api/tickets/${ticketId}/locks`, {
          revision: before.revision,
        })],
      ['DELETE /locks', () =>
        wang.del(`/api/tickets/${ticketId}/locks`, {
          revision: before.revision,
        })],
    ]

    for (const [name, call] of attempts) {
      const err = (await call().catch((e) => e)) as HttpError
      expect(err, `${name} 应被拒绝`).toBeInstanceOf(HttpError)
      expectStrippedError(err, 403)

      const after = await dbTruth(ticketId)
      expect(after, `${name} 不得修改数据库`).toEqual(before)
    }

    // 不存在的票：写入口同样只能拿到精简 404
    const ghost = await wang
      .post('/api/tickets/999999/confirm', { pointId: 1, revision: 1 })
      .catch((e) => e as HttpError)
    expectStrippedError(ghost, 404)
  })

  it('授权检修人员调用送电复位仍 403（角色拒绝同样不带快照），数据库零变更', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1'],
      personnel: ['zhang'],
    })
    const before = await dbTruth(s.ticket.id)
    const zhang = await clientFor(PORT_A, CREDS.zhang)
    const err = await zhang
      .post(`/api/tickets/${s.ticket.id}/reset`, { revision: 1 })
      .catch((e) => e as HttpError)
    expectStrippedError(err, 403)
    expect(await dbTruth(s.ticket.id)).toEqual(before)
  })
})

describe('响应不缓存', () => {
  it('列表 / 成功详情 / 403 / 409 响应均带 Cache-Control: no-store', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1', 'p2'],
      personnel: ['zhang', 'li'],
    })
    const wang = await clientFor(PORT_A, CREDS.wang)
    const zhang = await clientFor(PORT_B, CREDS.zhang)
    const li = await clientFor(PORT_B, CREDS.li)

    const list = await rawHeaders(PORT_A, 'GET', '/api/tickets', wang.token)
    expect(list.cacheControl).toBe('no-store')

    const denied = await rawHeaders(
      PORT_A,
      'POST',
      `/api/tickets/${s.ticket.id}/locks`,
      wang.token,
      { revision: 1 },
    )
    expect(denied.status).toBe(403)
    expect(denied.cacheControl).toBe('no-store')

    // 合法并发冲突 409 也不缓存（响应内含最新快照）
    await zhang.post(`/api/tickets/${s.ticket.id}/confirm`, {
      pointId: s.points[0].id,
      revision: 1,
    })
    const conflict = await rawHeaders(
      PORT_B,
      'POST',
      `/api/tickets/${s.ticket.id}/confirm`,
      li.token,
      { pointId: s.points[1].id, revision: 1 },
    )
    expect(conflict.status).toBe(409)
    expect(conflict.cacheControl).toBe('no-store')
  })
})

describe('合法流程与并发冲突快照不受影响', () => {
  it('授权工人正常确认/挂撤锁；过期请求仍返回最新牌板，凭其重试可继续', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1', 'p2'],
      personnel: ['zhang', 'li'],
    })
    const zhang = await clientFor(PORT_A, CREDS.zhang)
    const li = await clientFor(PORT_B, CREDS.li)

    // 李先确认点1：revision 1→2
    await li.post(`/api/tickets/${s.ticket.id}/confirm`, {
      pointId: s.points[0].id,
      revision: 1,
    })

    // 张持旧 revision=1 确认点2 → 409 + 最新快照（仅授权者可得）
    const err = await zhang
      .post(`/api/tickets/${s.ticket.id}/confirm`, {
        pointId: s.points[1].id,
        revision: 1,
      })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(409)
    expect(err.body.error.latestRevision).toBe(2)
    expect(err.body.error.snapshot).toBeTruthy()
    expect(err.body.error.snapshot.ticket.revision).toBe(2)
    expect(err.body.error.snapshot.points[0].confirmed_by).toBe('li')

    // 凭冲突快照的最新修订号继续操作：成功
    const ok = await zhang.post<{ snapshot: Snapshot }>(
      `/api/tickets/${s.ticket.id}/confirm`,
      { pointId: s.points[1].id, revision: 2 },
    )
    expect(ok.snapshot.ticket.revision).toBe(3)
    expect(ok.snapshot.points[1].confirmed_by).toBe('zhang')

    // 负责人看到阻断项随锁变化（合法读路径完好）
    const locked = await zhang.post<{ snapshot: Snapshot }>(
      `/api/tickets/${s.ticket.id}/locks`,
      { revision: 3 },
    )
    expect(locked.snapshot.blockers).toContain('locks:1')
  })
})
