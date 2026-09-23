import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { pool } from './db.js'
import { BoardError } from './board.js'
import type { Role, User } from '../shared/types.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'loto-dev-secret-change-me'
const TOKEN_TTL = '8h'

interface UserRow {
  id: number
  username: string
  display_name: string
  password_hash: string
  role: Role
}

export async function verifyCredentials(
  username: string,
  password: string,
): Promise<{ token: string; user: User }> {
  const { rows } = await pool.query<UserRow>(
    `SELECT id, username, display_name, password_hash, role
     FROM users WHERE username = $1`,
    [username],
  )
  const row = rows[0]
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw new BoardError('UNAUTHORIZED', '账号或密码错误')
  }
  const user: User = {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
  }
  const token = jwt.sign(
    { sub: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  )
  return { token, user }
}

export interface AuthPrincipal {
  username: string
  role: Role
}

export function signToken(p: AuthPrincipal): string {
  return jwt.sign({ sub: p.username, role: p.role }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  })
}

export function verifyToken(token: string): AuthPrincipal {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload
    if (!payload.sub || !payload.role) throw new Error('bad token')
    return { username: payload.sub, role: payload.role as Role }
  } catch {
    throw new BoardError('UNAUTHORIZED', '登录态无效或已过期，请重新登录')
  }
}
