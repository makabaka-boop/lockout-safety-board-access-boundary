// 一次性验收引导：等待数据库就绪 → 迁移 → 播种 → 健康检查 → 退出（成功码 0）。
// docker-compose 中由 verify 服务运行；api-1/api-2 通过 depends_on
// service_completed_successfully 保证在它之后启动。
import { createPool } from './db.js'
import { runMigrations } from './migrate.js'
import { seedUsers } from './seed.js'

async function waitForDb(db: ReturnType<typeof createPool>, tries = 30) {
  for (let i = 1; i <= tries; i++) {
    try {
      await db.query('SELECT 1')
      return
    } catch {
      console.log(`[verify] 等待数据库… (${i}/${tries})`)
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error('[verify] 数据库不可用')
}

async function main() {
  const db = createPool()
  try {
    await waitForDb(db)
    await runMigrations(db)
    await seedUsers(db)
    const { rows } = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM users')
    if (Number(rows[0].c) < 5) {
      throw new Error(`[verify] 期望至少 5 个账号，实际 ${rows[0].c}`)
    }
    console.log('[verify] OK：迁移与种子数据就绪')
  } finally {
    await db.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
