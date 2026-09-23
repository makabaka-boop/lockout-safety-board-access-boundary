// 前后端共享的数据结构与稳定错误 JSON 定义

export type Role = 'coordinator' | 'worker' | 'lead'

export type TicketStatus = 'maintenance' | 'energized'

export interface User {
  id: number
  username: string
  display_name: string
  role: Role
}

export interface IsolationPoint {
  id: number
  ticket_id: number
  position: number
  label: string
  confirmed_by: string | null
  confirmed_at: string | null
}

export interface PersonalLock {
  id: number
  ticket_id: number
  username: string
  display_name: string
  created_at: string
}

export interface Ticket {
  id: number
  device: string
  status: TicketStatus
  coordinator: string
  revision: number
  created_at: string
  updated_at: string
}

/** 裁决快照：API 返回、页面所见、乐观锁依据，三者完全一致 */
export interface Snapshot {
  ticket: Ticket
  points: IsolationPoint[]
  personnel: User[]
  locks: PersonalLock[]
  /** 当前业务阻断项；status=energized 时始终含 terminal */
  blockers: string[]
}

export interface TicketSummary {
  id: number
  device: string
  status: TicketStatus
  revision: number
  coordinator: string
  point_count: number
  confirmed_count: number
  lock_count: number
  blockers: string[]
  updated_at: string
}

/** 稳定 JSON 错误体：code 为机器可读稳定码，message 为中文说明 */
export interface ErrorBody {
  error: {
    code:
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'CONFLICT'
      | 'NOT_FOUND'
      | 'VALIDATION'
      | 'INTERNAL'
    message: string
    /** 409/部分 403 时附带最新牌板，供前端立即重载 */
    snapshot?: Snapshot
    /** 409 修订冲突时存在 */
    latestRevision?: number
    blockers?: string[]
  }
}

export interface LoginResponse {
  token: string
  user: User
}
