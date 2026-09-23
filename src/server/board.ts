// 牌板裁决层：所有状态变更都在单条数据库事务内完成。
//
// 并发正确性的关键（两个 API 实例共享同一 PostgreSQL，各持独立连接池）：
//  1. 每个写事务先执行 SELECT ... FROM tickets WHERE id=$1 FOR UPDATE，
//     取得票行的排他行锁。两个实例上的“撤最后一锁”与“复位”因此被
//     数据库强制串行化：后到者阻塞，直到先到者提交，随后重新读到
//     revision/锁数/确认数的最新值。
//  2. 每个写请求必须携带页面所见 revision；与库中不符即 409 CONFLICT，
//     事务回滚，牌板保持当前状态，并返回最新快照。
//  3. 复位（reset）的“全部点已确认 + 锁数为零 + 仍在检修”判定与状态
//     翻转、revision 自增在同一事务原子提交，杜绝失锁更新（lost update）。
//  4. 票进入 energized 后，确认/挂锁/撤锁一律 409 terminal，保证
//     “成功后拒绝任何确认或挂锁”。
import type { Pool, PoolClient } from 'pg'
import type {
  IsolationPoint,
  PersonalLock,
  Snapshot,
  Ticket,
  User,
} from '../shared/types.js'
import { pool as defaultPool, withTransaction, type DbClient } from './db.js'

export class BoardError extends Error {
  constructor(
    public code:
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'CONFLICT'
      | 'NOT_FOUND'
      | 'VALIDATION'
      | 'INTERNAL',
    message: string,
    public extra: {
      snapshot?: Snapshot
      latestRevision?: number
      blockers?: string[]
    } = {},
  ) {
    super(message)
    this.name = 'BoardError'
  }
}

// ---------------------------------------------------------------- 读取

interface TicketRow {
  id: number
  device: string
  status: Ticket['status']
  coordinator: string
  revision: number
  created_at: string
  updated_at: string
}

function mapTicket(r: TicketRow): Ticket {
  return {
    id: r.id,
    device: r.device,
    status: r.status,
    coordinator: r.coordinator,
    revision: Number(r.revision),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

async function readTicket(
  client: DbClient,
  ticketId: number,
): Promise<TicketRow | null> {
  const { rows } = await client.query<TicketRow>(
    `SELECT id, device, status, coordinator, revision, created_at, updated_at
     FROM tickets WHERE id = $1`,
    [ticketId],
  )
  return rows[0] ?? null
}

async function readSnapshot(
  client: DbClient,
  row: TicketRow,
): Promise<Snapshot> {
  // 注意：client 可能是事务内的 PoolClient，pg 不允许同一连接上并发查询，
  // 因此这里必须顺序 await（不能用 Promise.all 并发）。
  const pointsRes = await client.query<IsolationPoint>(
    `SELECT id, ticket_id, position, label, confirmed_by, confirmed_at
     FROM isolation_points WHERE ticket_id = $1 ORDER BY position, id`,
    [row.id],
  )
  const locksRes = await client.query(
    `SELECT l.id, l.ticket_id, l.username, u.display_name, l.created_at
     FROM personal_locks l
     JOIN users u ON u.username = l.username
     WHERE l.ticket_id = $1
     ORDER BY l.id`,
    [row.id],
  )
  const authRes = await client.query<User>(
    `SELECT u.id, u.username, u.display_name, u.role
     FROM authorizations a
     JOIN users u ON u.username = a.username
     WHERE a.ticket_id = $1
     ORDER BY u.id`,
    [row.id],
  )
  const ticket = mapTicket(row)
  return {
    ticket,
    points: pointsRes.rows,
    locks: locksRes.rows as unknown as PersonalLock[],
    personnel: authRes.rows,
    blockers: computeBlockers(ticket, pointsRes.rows, locksRes.rows.length),
  }
}

export async function getSnapshot(
  db: Pool,
  ticketId: number,
): Promise<Snapshot> {
  const row = await readTicket(db, ticketId)
  if (!row) throw new BoardError('NOT_FOUND', '作业票不存在')
  return readSnapshot(db, row)
}

export async function listTickets(db: Pool = defaultPool): Promise<Snapshot[]> {
  const { rows } = await db.query<TicketRow>(
    `SELECT id, device, status, coordinator, revision, created_at, updated_at
     FROM tickets ORDER BY id DESC`,
  )
  return Promise.all(rows.map((r) => readSnapshot(db, r)))
}

function computeBlockers(
  ticket: Ticket,
  points: Pick<IsolationPoint, 'confirmed_by'>[],
  lockCount: number,
): string[] {
  const blockers: string[] = []
  if (ticket.status === 'energized') {
    blockers.push('terminal') // 票已复位送电，终态不可逆
    return blockers
  }
  const unconfirmed = points.filter((p) => p.confirmed_by == null).length
  if (unconfirmed > 0) blockers.push(`points:${unconfirmed}`)
  if (lockCount > 0) blockers.push(`locks:${lockCount}`)
  return blockers
}

// ---------------------------------------------------------------- 写入

/**
 * 取票行排他锁 + 越权校验 + 校验修订号；返回锁内最新行与快照。
 * 顺序很重要：先判定票级授权（FORBIDDEN 稳定优先于 CONFLICT），
 * 再比对修订号；修订号过期时返回的快照是 FOR UPDATE 锁内读取的最新值。
 */
async function lockTicketForWrite(
  client: PoolClient,
  actor: Actor,
  ticketId: number,
  expectedRevision: number | undefined,
): Promise<{ row: TicketRow; snapshot: Snapshot }> {
  const { rows } = await client.query<TicketRow>(
    `SELECT id, device, status, coordinator, revision, created_at, updated_at
     FROM tickets WHERE id = $1 FOR UPDATE`,
    [ticketId],
  )
  const row = rows[0]
  if (!row) throw new BoardError('NOT_FOUND', '作业票不存在')

  const snapshot = await readSnapshot(client, row)

  // 票级授权：检修人员必须在该票授权名单内；送电负责人/协调员不受此限
  if (actor.role === 'worker') {
    const { rows: auth } = await client.query(
      `SELECT 1 FROM authorizations WHERE ticket_id = $1 AND username = $2`,
      [ticketId, actor.username],
    )
    if (auth.length === 0) {
      throw new BoardError('FORBIDDEN', '你未被授权操作该作业票', {
        snapshot,
      })
    }
  }

  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
    throw new BoardError('VALIDATION', '必须携带页面所见修订号 revision', {
      snapshot,
    })
  }
  if (Number(row.revision) !== expectedRevision) {
    throw new BoardError(
      'CONFLICT',
      `页面已过期：页面修订号 ${expectedRevision}，当前修订号 ${row.revision}`,
      {
        snapshot,
        latestRevision: Number(row.revision),
        blockers: snapshot.blockers,
      },
    )
  }
  return { row, snapshot }
}

async function bumpRevision(
  client: PoolClient,
  ticketId: number,
): Promise<number> {
  const { rows } = await client.query<{ revision: number }>(
    `UPDATE tickets
       SET revision = revision + 1, updated_at = now()
     WHERE id = $1
     RETURNING revision`,
    [ticketId],
  )
  return Number(rows[0].revision)
}

export interface CreateTicketInput {
  device: string
  pointLabels: string[]
  personnel: string[] // 授权作业人员用户名
  coordinatorUsername: string
}

/** 协调员新建票：1–20 个隔离点、至少 1 名授权人员。新建本身是第 1 个修订。 */
export async function createTicket(
  input: CreateTicketInput,
  db: Pool = defaultPool,
): Promise<Snapshot> {
  const device = input.device?.trim()
  if (!device) throw new BoardError('VALIDATION', '设备名称不能为空')
  if (
    !Array.isArray(input.pointLabels) ||
    input.pointLabels.length < 1 ||
    input.pointLabels.length > 20
  ) {
    throw new BoardError('VALIDATION', '隔离点数量必须在 1 到 20 之间')
  }
  const labels = input.pointLabels.map((l) => l?.trim() ?? '')
  if (labels.some((l) => !l)) {
    throw new BoardError('VALIDATION', '隔离点名称不能为空')
  }
  if (new Set(labels).size !== labels.length) {
    throw new BoardError('VALIDATION', '隔离点名称不能重复')
  }
  if (
    !Array.isArray(input.personnel) ||
    input.personnel.length < 1 ||
    new Set(input.personnel).size !== input.personnel.length
  ) {
    throw new BoardError('VALIDATION', '至少指定 1 名且不重复的授权作业人员')
  }

  return withTransaction(db, async (client) => {
    const { rows: userRows } = await client.query<{ username: string }>(
      `SELECT username FROM users
       WHERE username = ANY($1::text[]) AND role = 'worker'`,
      [input.personnel],
    )
    const valid = new Set(userRows.map((r) => r.username))
    const bad = input.personnel.filter((p) => !valid.has(p))
    if (bad.length > 0) {
      throw new BoardError(
        'VALIDATION',
        `以下人员不存在或不是检修人员: ${bad.join(', ')}`,
      )
    }

    const { rows: coordRows } = await client.query<{ username: string }>(
      `SELECT username FROM users WHERE username = $1 AND role = 'coordinator'`,
      [input.coordinatorUsername],
    )
    if (coordRows.length === 0) {
      throw new BoardError('FORBIDDEN', '仅协调员可新建作业票')
    }

    const ticket = await client.query<TicketRow>(
      `INSERT INTO tickets (device, coordinator, revision)
       VALUES ($1, $2, 1)
       RETURNING id, device, status, coordinator, revision, created_at, updated_at`,
      [device, input.coordinatorUsername],
    )
    const id = ticket.rows[0].id

    for (let i = 0; i < labels.length; i++) {
      await client.query(
        `INSERT INTO isolation_points (ticket_id, position, label)
         VALUES ($1, $2, $3)`,
        [id, i + 1, labels[i]],
      )
    }
    for (const username of input.personnel) {
      await client.query(
        `INSERT INTO authorizations (ticket_id, username) VALUES ($1, $2)`,
        [id, username],
      )
    }
    return readSnapshot(client, ticket.rows[0])
  })
}

export interface Actor {
  username: string
  role: User['role']
}

/** 登录人员在【被授权】的票上确认隔离点（不可取消、不可代签） */
export async function confirmPoint(
  db: Pool,
  actor: Actor,
  ticketId: number,
  pointId: number,
  expectedRevision: number,
): Promise<Snapshot> {
  if (actor.role !== 'worker') {
    throw new BoardError('FORBIDDEN', '仅被授权的检修人员可确认隔离点')
  }
  return withTransaction(db, async (client) => {
    const { snapshot } = await lockTicketForWrite(
      client,
      actor,
      ticketId,
      expectedRevision,
    )

    if (snapshot.ticket.status !== 'maintenance') {
      throw new BoardError(
        'CONFLICT',
        '作业票已复位送电，终态不可再确认隔离点',
        { snapshot, blockers: snapshot.blockers },
      )
    }

    const point = snapshot.points.find((p) => p.id === pointId)
    if (!point) throw new BoardError('NOT_FOUND', '隔离点不存在', { snapshot })
    if (point.confirmed_by != null) {
      throw new BoardError(
        'CONFLICT',
        `隔离点「${point.label}」已由 ${point.confirmed_by} 确认`,
        { snapshot },
      )
    }

    await client.query(
      `UPDATE isolation_points
         SET confirmed_by = $1, confirmed_at = now()
       WHERE id = $2 AND ticket_id = $3 AND confirmed_by IS NULL`,
      [actor.username, pointId, ticketId],
    )
    await bumpRevision(client, ticketId)
    return readSnapshotAndRelockGuard(client, ticketId)
  })
}

/** 挂上自己唯一的一把个人锁（每票一把，DB 唯一约束兜底） */
export async function placeLock(
  db: Pool,
  actor: Actor,
  ticketId: number,
  expectedRevision: number,
): Promise<Snapshot> {
  if (actor.role !== 'worker') {
    throw new BoardError('FORBIDDEN', '仅检修人员可挂个人锁')
  }
  return withTransaction(db, async (client) => {
    const { snapshot } = await lockTicketForWrite(
      client,
      actor,
      ticketId,
      expectedRevision,
    )

    if (snapshot.ticket.status !== 'maintenance') {
      throw new BoardError('CONFLICT', '作业票已复位送电，终态不可再挂锁', {
        snapshot,
        blockers: snapshot.blockers,
      })
    }

    if (snapshot.locks.some((l) => l.username === actor.username)) {
      throw new BoardError('CONFLICT', '你在该票上已挂有个人锁，每人限挂一把', {
        snapshot,
      })
    }

    try {
      await client.query(
        `INSERT INTO personal_locks (ticket_id, username) VALUES ($1, $2)`,
        [ticketId, actor.username],
      )
    } catch (err: unknown) {
      // 唯一约束冲突 = 并发下另一请求抢先挂锁
      if ((err as { code?: string }).code === '23505') {
        throw new BoardError('CONFLICT', '你在该票上已挂有个人锁，每人限挂一把')
      }
      throw err
    }
    await bumpRevision(client, ticketId)
    return readSnapshotAndRelockGuard(client, ticketId)
  })
}

/** 撤下自己的个人锁（只能撤自己的） */
export async function removeLock(
  db: Pool,
  actor: Actor,
  ticketId: number,
  expectedRevision: number,
): Promise<Snapshot> {
  if (actor.role !== 'worker') {
    throw new BoardError('FORBIDDEN', '仅检修人员可撤个人锁')
  }
  return withTransaction(db, async (client) => {
    const { snapshot } = await lockTicketForWrite(
      client,
      actor,
      ticketId,
      expectedRevision,
    )

    if (snapshot.ticket.status !== 'maintenance') {
      throw new BoardError('CONFLICT', '作业票已复位送电，终态不可撤锁', {
        snapshot,
        blockers: snapshot.blockers,
      })
    }

    const { rowCount } = await client.query(
      `DELETE FROM personal_locks WHERE ticket_id = $1 AND username = $2`,
      [ticketId, actor.username],
    )
    if (rowCount === 0) {
      throw new BoardError('CONFLICT', '你在该票上没有个人锁可撤', { snapshot })
    }
    await bumpRevision(client, ticketId)
    return readSnapshotAndRelockGuard(client, ticketId)
  })
}

/**
 * 送电负责人复位（送电）：
 * 仅当 全部点已确认 + 锁数为 0 + 票仍在检修。判定与翻转原子提交。
 */
export async function resetTicket(
  db: Pool,
  actor: Actor,
  ticketId: number,
  expectedRevision: number,
): Promise<Snapshot> {
  if (actor.role !== 'lead') {
    throw new BoardError('FORBIDDEN', '仅送电负责人可执行复位送电')
  }
  return withTransaction(db, async (client) => {
    const { row, snapshot } = await lockTicketForWrite(
      client,
      actor,
      ticketId,
      expectedRevision,
    )

    if (row.status === 'energized') {
      throw new BoardError('CONFLICT', '作业票已复位送电，终态不可再次复位', {
        snapshot,
        latestRevision: Number(row.revision),
        blockers: ['terminal'],
      })
    }

    const unconfirmed = snapshot.points.filter((p) => p.confirmed_by == null)
    if (unconfirmed.length > 0 || snapshot.locks.length > 0) {
      const blockers = [
        ...(unconfirmed.length > 0
          ? [`points:${unconfirmed.length}`]
          : []),
        ...(snapshot.locks.length > 0
          ? [`locks:${snapshot.locks.length}`]
          : []),
      ]
      throw new BoardError(
        'CONFLICT',
        `当前不满足送电条件（未确认点 ${unconfirmed.length} 个、个人锁 ${snapshot.locks.length} 把）`,
        {
          snapshot,
          latestRevision: Number(row.revision),
          blockers,
        },
      )
    }

    const { rowCount } = await client.query(
      `UPDATE tickets
         SET status = 'energized', revision = revision + 1, updated_at = now()
       WHERE id = $1 AND status = 'maintenance' AND revision = $2`,
      [ticketId, expectedRevision],
    )
    if (rowCount !== 1) {
      throw new BoardError('CONFLICT', '作业票已被其他请求更新，请刷新后重试', {
        snapshot,
        latestRevision: Number(row.revision),
        blockers: snapshot.blockers,
      })
    }

    return readSnapshotAndRelockGuard(client, ticketId)
  })
}

// 提交前在同一事务内重新读取，确保返回的快照就是落库结果
async function readSnapshotAndRelockGuard(
  client: PoolClient,
  ticketId: number,
): Promise<Snapshot> {
  const row = await readTicket(client, ticketId)
  if (!row) throw new BoardError('INTERNAL', '作业票在写入后消失')
  return readSnapshot(client, row)
}
