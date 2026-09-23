// PostgreSQL 结构：作业票、必检点、授权人员、个人锁、单调修订号
// 每个文件按顺序执行一次（schema_migrations 记账）。
export interface Migration {
  name: string
  sql: string
}

export const migrations: Migration[] = [
  {
    name: '001_init.sql',
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('coordinator','worker','lead'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id          SERIAL PRIMARY KEY,
  device      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'maintenance'
              CHECK (status IN ('maintenance','energized')),
  coordinator TEXT NOT NULL REFERENCES users(username),
  -- 单调修订号：每次牌板变更 +1，乐观并发控制的依据
  revision    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS isolation_points (
  id           SERIAL PRIMARY KEY,
  ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  label        TEXT NOT NULL,
  confirmed_by TEXT REFERENCES users(username),
  confirmed_at TIMESTAMPTZ,
  UNIQUE (ticket_id, position)
);
CREATE INDEX IF NOT EXISTS idx_points_ticket ON isolation_points(ticket_id);

-- 一张票上的授权作业人员（登录人员仅能在被授权的票上操作）
CREATE TABLE IF NOT EXISTS authorizations (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  username  TEXT NOT NULL REFERENCES users(username),
  PRIMARY KEY (ticket_id, username)
);
CREATE INDEX IF NOT EXISTS idx_auth_user ON authorizations(username);

-- 个人锁：每人每张票至多一把（DB 唯一约束兜底，防重复挂锁）
CREATE TABLE IF NOT EXISTS personal_locks (
  id         SERIAL PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  username   TEXT NOT NULL REFERENCES users(username),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, username)
);
CREATE INDEX IF NOT EXISTS idx_locks_ticket ON personal_locks(ticket_id);
`,
  },
]
