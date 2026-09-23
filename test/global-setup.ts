// Vitest 全局装配：启动一个真实的嵌入式 PostgreSQL（供全部测试共享）。
// 不使用任何假数据库 / 假接口——竞争条件必须在真实 MVCC + 行锁上复现。
import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const PG_PORT = 54322
const DATA_DIR = resolve(process.cwd(), 'test/pg-data')

export default async function setup() {
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`
  process.env.PG_POOL_MAX = '20'
  process.env.JWT_SECRET = 'test-secret'

  const { default: EmbeddedPostgres } = await import('embedded-postgres')

  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: true,
    initdbFlags: [],
    postgresFlags: [],
  })

  await pg.initialise()
  await pg.start()
  await pg.createDatabase('loto_test')

  const admin = pg.getPgClient('loto_test')
  await admin.connect()
  await admin.query(`DO $$ BEGIN
    CREATE ROLE loto WITH LOGIN PASSWORD 'loto';
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`)
  await admin.query('GRANT ALL PRIVILEGES ON DATABASE loto_test TO loto')
  await admin.query('GRANT ALL ON SCHEMA public TO loto')
  await admin.end()

  process.env.DATABASE_URL = `postgres://loto:loto@127.0.0.1:${PG_PORT}/loto_test`
  console.log(`[test] embedded PostgreSQL ready on port ${PG_PORT}`)

  return async () => {
    await pg.stop().catch(() => {})
    rmSync(DATA_DIR, { recursive: true, force: true })
  }
}
