// 执行迁移（幂等）：docker-compose 的 verify 服务、本地 CLI 均可调用
import type { PoolClient } from 'pg'
import { pool } from './db.js'
import { migrations } from './migrations.js'

type MigrationRunner = PoolClient | typeof pool

export async function runMigrations(client: MigrationRunner = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  for (const m of migrations) {
    const { rows } = await client.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1',
      [m.name],
    )
    if (rows.length === 0) {
      await client.query(m.sql)
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [
        m.name,
      ])
      console.log(`[migrate] applied ${m.name}`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(async () => {
      await pool.end()
    })
    .catch(async (err) => {
      console.error(err)
      await pool.end()
      process.exit(1)
    })
}
