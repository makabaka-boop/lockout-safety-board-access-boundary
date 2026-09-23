import { Pool, type PoolClient } from 'pg'

const CONNECTION_STRING =
  process.env.DATABASE_URL ??
  'postgres://loto:loto@127.0.0.1:5432/loto'

/** 默认单例池：CLI / migrate / seed 使用 */
export const pool = new Pool({
  connectionString: CONNECTION_STRING,
  max: Number(process.env.PG_POOL_MAX ?? 10),
})

/** 每个 API 实例使用自己的连接池（实例间不共享进程内状态） */
export function createPool(max?: number): Pool {
  const p = new Pool({
    connectionString: CONNECTION_STRING,
    max: max ?? Number(process.env.PG_POOL_MAX ?? 10),
  })
  // 空闲连接上的错误（如数据库重启）只记录、不拖垮进程
  p.on('error', (err) => {
    console.error('[db] idle client error:', err.message)
  })
  return p
}

// 空闲连接上的错误（如数据库重启）只记录、不拖垮进程
for (const p of [pool]) {
  p.on('error', (err) => {
    console.error('[db] idle client error:', err.message)
  })
}

export type DbClient = Pool | PoolClient

export async function withTransaction<T>(
  db: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
