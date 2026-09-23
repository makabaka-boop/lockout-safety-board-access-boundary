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
} from './harness.js'

beforeAll(startTwoInstances)
afterAll(stopTwoInstances)
beforeEach(resetData)

describe('认证与角色', () => {
  it('错误密码返回稳定 UNAUTHORIZED JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_A}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'coord', password: 'wrong' }),
    })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error.code).toBe('UNAUTHORIZED')
    expect(typeof json.error.message).toBe('string')
  })

  it('无令牌访问受保护接口 → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_A}/api/tickets`)
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error.code).toBe('UNAUTHORIZED')
  })

  it('检修人员不能新建票 → 403 FORBIDDEN', async () => {
    const zhang = await clientFor(PORT_A, CREDS.zhang)
    await expect(
      zhang.post('/api/tickets', {
        device: 'x',
        points: ['p1'],
        personnel: ['zhang'],
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('送电负责人不能新建票 → 403', async () => {
    const lead = await clientFor(PORT_A, CREDS.lead)
    const err = await lead
      .post('/api/tickets', { device: 'x', points: ['p1'], personnel: ['zhang'] })
      .catch((e) => e as HttpError)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.body.error.code).toBe('FORBIDDEN')
  })
})

describe('协调员建票', () => {
  it('可指定 1–20 个隔离点与多名人员，初始 revision=1', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: '3 号循环水泵',
      points: ['断电', '泄压', '排放'],
      personnel: ['zhang', 'li'],
    })
    expect(s.points).toHaveLength(3)
    expect(s.personnel.map((p) => p.username).sort()).toEqual(['li', 'zhang'])
    expect(s.ticket.revision).toBe(1)
    expect(s.ticket.status).toBe('maintenance')
  })

  it('0 个隔离点被拒绝', async () => {
    const coord = await clientFor(PORT_A, CREDS.coord)
    const err = await coord
      .post('/api/tickets', {
        device: 'd',
        points: [],
        personnel: ['zhang'],
      })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(400)
    expect(err.body.error.code).toBe('VALIDATION')
  })

  it('21 个隔离点被拒绝', async () => {
    const coord = await clientFor(PORT_A, CREDS.coord)
    const err = await coord
      .post('/api/tickets', {
        device: 'd',
        points: Array.from({ length: 21 }, (_, i) => `p${i}`),
        personnel: ['zhang'],
      })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(400)
    expect(err.body.error.code).toBe('VALIDATION')
  })

  it('未指定授权人员被拒绝', async () => {
    const coord = await clientFor(PORT_A, CREDS.coord)
    const err = await coord
      .post('/api/tickets', { device: 'd', points: ['p1'], personnel: [] })
      .catch((e) => e as HttpError)
    expect(err.body.error.code).toBe('VALIDATION')
  })

  it('协调员不能确认隔离点 → 403', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1'],
      personnel: ['zhang'],
    })
    const coord = await clientFor(PORT_A, CREDS.coord)
    const err = await coord
      .post(`/api/tickets/${s.ticket.id}/confirm`, {
        pointId: s.points[0].id,
        revision: 1,
      })
      .catch((e) => e as HttpError)
    expect(err.body.error.code).toBe('FORBIDDEN')
  })
})

describe('授权与隔离点确认', () => {
  it('仅授权工人可确认；未授权工人 → 403', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1', 'p2'],
      personnel: ['zhang'],
    })
    // wang 未授权
    const wang = await clientFor(PORT_B, CREDS.wang)
    const err = await wang
      .post(`/api/tickets/${s.ticket.id}/confirm`, {
        pointId: s.points[0].id,
        revision: 1,
      })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(403)
    expect(err.body.error.code).toBe('FORBIDDEN')
    // 失败保留当前牌板：点仍未确认、revision 仍为 1
    const cur = await wang.get<{ snapshot: any }>(
      `/api/tickets/${s.ticket.id}`,
    )
    expect(cur.snapshot.points[0].confirmed_by).toBeNull()
    expect(cur.snapshot.ticket.revision).toBe(1)

    // 授权工人在另一实例确认成功
    const zhang = await clientFor(PORT_B, CREDS.zhang)
    const ok = await zhang.post<{ snapshot: any }>(
      `/api/tickets/${s.ticket.id}/confirm`,
      { pointId: s.points[0].id, revision: 1 },
    )
    expect(ok.snapshot.points[0].confirmed_by).toBe('zhang')
    expect(ok.snapshot.ticket.revision).toBe(2)
  })

  it('一个点只能确认一次', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1'],
      personnel: ['zhang', 'li'],
    })
    const zhang = await clientFor(PORT_A, CREDS.zhang)
    await zhang.post(`/api/tickets/${s.ticket.id}/confirm`, {
      pointId: s.points[0].id,
      revision: 1,
    })
    const li = await clientFor(PORT_A, CREDS.li)
    const err = await li
      .post(`/api/tickets/${s.ticket.id}/confirm`, {
        pointId: s.points[0].id,
        revision: 2,
      })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(409)
  })
})

describe('个人锁', () => {
  it('每人每票至多一把锁；可撤下自己的锁，不能撤别人的', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1'],
      personnel: ['zhang', 'li'],
    })
    const zhang = await clientFor(PORT_A, CREDS.zhang)
    const li = await clientFor(PORT_B, CREDS.li)

    const locked = await zhang.post<{ snapshot: any }>(
      `/api/tickets/${s.ticket.id}/locks`,
      { revision: 1 },
    )
    expect(locked.snapshot.locks).toHaveLength(1)

    const err2 = await zhang
      .post(`/api/tickets/${s.ticket.id}/locks`, { revision: 2 })
      .catch((e) => e as HttpError)
    expect(err2.status).toBe(409)

    // li 不能撤 zhang 的锁
    const err3 = await li
      .del(`/api/tickets/${s.ticket.id}/locks`, { revision: 2 })
      .catch((e) => e as HttpError)
    expect(err3.status).toBe(409)
    expect(err3.body.error.message).toContain('没有个人锁')

    const removed = await zhang.del<{ snapshot: any }>(
      `/api/tickets/${s.ticket.id}/locks`,
      { revision: 2 },
    )
    expect(removed.snapshot.locks).toHaveLength(0)
    expect(removed.snapshot.ticket.revision).toBe(3)
  })

  it('送电负责人不能挂锁 → 403', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1'],
      personnel: ['zhang'],
    })
    const lead = await clientFor(PORT_A, CREDS.lead)
    const err = await lead
      .post(`/api/tickets/${s.ticket.id}/locks`, { revision: 1 })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(403)
  })
})

describe('乐观修订号', () => {
  it('过期请求返回 409 + 最新快照，败方牌板不变', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1', 'p2'],
      personnel: ['zhang', 'li'],
    })
    const zhangA = await clientFor(PORT_A, CREDS.zhang)
    const liB = await clientFor(PORT_B, CREDS.li)

    // 张在实例 A 确认点1（revision 1→2）
    await zhangA.post(`/api/tickets/${s.ticket.id}/confirm`, {
      pointId: s.points[0].id,
      revision: 1,
    })

    // 李仍拿着旧 revision=1 在实例 B 确认点2 → 409，附最新快照
    const err = await liB
      .post(`/api/tickets/${s.ticket.id}/confirm`, {
        pointId: s.points[1].id,
        revision: 1,
      })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(409)
    expect(err.body.error.code).toBe('CONFLICT')
    expect(err.body.error.latestRevision).toBe(2)
    expect(err.body.error.snapshot).toBeTruthy()
    expect(err.body.error.snapshot.ticket.revision).toBe(2)
    // 张的确认已在败方所见快照中可见
    expect(err.body.error.snapshot.points[0].confirmed_by).toBe('zhang')

    // 失败保留当前牌板：点2 未被李确认
    expect(err.body.error.snapshot.points[1].confirmed_by).toBeNull()
  })

  it('缺少 revision → 400', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1'],
      personnel: ['zhang'],
    })
    const zhang = await clientFor(PORT_A, CREDS.zhang)
    const err = await zhang
      .post(`/api/tickets/${s.ticket.id}/locks`, {})
      .catch((e) => e as HttpError)
    expect(err.status).toBe(400)
  })
})

describe('送电复位', () => {
  it('有点未确认或有锁时阻断，条件齐备才成功，且成功后终态', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1'],
      personnel: ['zhang'],
    })
    const lead = await clientFor(PORT_B, CREDS.lead)

    // 初始：未确认点 1
    let err = await lead
      .post(`/api/tickets/${s.ticket.id}/reset`, { revision: 1 })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(409)
    expect(err.body.error.blockers).toContain('points:1')

    const zhang = await clientFor(PORT_A, CREDS.zhang)
    await zhang.post(`/api/tickets/${s.ticket.id}/confirm`, {
      pointId: s.points[0].id,
      revision: 1,
    })
    // 挂一把锁 → locks:1
    await zhang.post(`/api/tickets/${s.ticket.id}/locks`, { revision: 2 })

    err = await lead
      .post(`/api/tickets/${s.ticket.id}/reset`, { revision: 3 })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(409)
    expect(err.body.error.blockers).toContain('locks:1')

    // 撤锁后可复位
    await zhang.del(`/api/tickets/${s.ticket.id}/locks`, { revision: 3 })
    const ok = await lead.post<{ snapshot: any }>(
      `/api/tickets/${s.ticket.id}/reset`,
      { revision: 4 },
    )
    expect(ok.snapshot.ticket.status).toBe('energized')
    expect(ok.snapshot.blockers).toEqual(['terminal'])
    expect(ok.snapshot.ticket.revision).toBe(5)

    // 终态后任何确认/挂锁被拒绝
    const e1 = await zhang
      .post(`/api/tickets/${s.ticket.id}/locks`, { revision: 5 })
      .catch((e) => e as HttpError)
    expect(e1.status).toBe(409)
    const e2 = await zhang
      .post(`/api/tickets/${s.ticket.id}/confirm`, {
        pointId: 9999,
        revision: 5,
      })
      .catch((e) => e as HttpError)
    expect(e2.status).toBe(409)
  })

  it('检修人员不能复位 → 403', async () => {
    const s = await createTicketAsCoord(PORT_A, {
      device: 'd',
      points: ['p1'],
      personnel: ['zhang'],
    })
    const zhang = await clientFor(PORT_A, CREDS.zhang)
    const err = await zhang
      .post(`/api/tickets/${s.ticket.id}/reset`, { revision: 1 })
      .catch((e) => e as HttpError)
    expect(err.status).toBe(403)
  })
})
