// 演示账号种子数据。密码哈希使用 bcrypt；幂等（重复执行不报错、不覆盖）。
import bcrypt from 'bcryptjs'
import type { Pool } from 'pg'
import { pool } from './db.js'

interface SeedUser {
  username: string
  displayName: string
  password: string
  role: 'coordinator' | 'worker' | 'lead'
}

export const SEED_USERS: SeedUser[] = [
  {
    username: 'coord',
    displayName: '协调员·钱工',
    password: 'coord123',
    role: 'coordinator',
  },
  {
    username: 'zhang',
    displayName: '检修·张师傅',
    password: 'worker123',
    role: 'worker',
  },
  {
    username: 'li',
    displayName: '检修·李师傅',
    password: 'worker123',
    role: 'worker',
  },
  {
    username: 'wang',
    displayName: '检修·王师傅',
    password: 'worker123',
    role: 'worker',
  },
  {
    username: 'lead',
    displayName: '送电负责人·赵班',
    password: 'lead123',
    role: 'lead',
  },
]

export async function seedUsers(db: Pool = pool) {
  for (const u of SEED_USERS) {
    const hash = await bcrypt.hash(u.password, 10)
    await db.query(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, u.displayName, hash, u.role],
    )
  }
  console.log(`[seed] ${SEED_USERS.length} 个账号已就绪`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedUsers()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err)
      await pool.end()
      process.exit(1)
    })
}
