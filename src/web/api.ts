import type {
  ErrorBody,
  LoginResponse,
  Snapshot,
  User,
} from '../shared/types.js'

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ErrorBody,
  ) {
    super(body.error.message)
    this.name = 'ApiError'
  }
  get code() {
    return this.body.error.code
  }
  get snapshot(): Snapshot | undefined {
    return this.body.error.snapshot
  }
  get blockers(): string[] | undefined {
    return this.body.error.blockers
  }
}

const TOKEN_KEY = 'loto.token'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

async function request<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = tokenStore.get()
  if (token) headers.Authorization = `Bearer ${token}`
  if (payload !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(path, {
    method,
    headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) {
    throw new ApiError(res.status, data as ErrorBody)
  }
  return data as T
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('POST', '/api/login', { username, password }),
  me: () => request<{ user: User }>('GET', '/api/me'),
  workers: () =>
    request<{ workers: Array<Pick<User, 'id' | 'username' | 'display_name'>> }>(
      'GET',
      '/api/workers',
    ),
  listTickets: () => request<{ tickets: Snapshot[] }>('GET', '/api/tickets'),
  ticket: (id: number) =>
    request<{ snapshot: Snapshot }>('GET', `/api/tickets/${id}`),
  createTicket: (device: string, points: string[], personnel: string[]) =>
    request<{ snapshot: Snapshot }>('POST', '/api/tickets', {
      device,
      points,
      personnel,
    }),
  confirm: (id: number, pointId: number, revision: number) =>
    request<{ snapshot: Snapshot }>('POST', `/api/tickets/${id}/confirm`, {
      pointId,
      revision, // 每次变更携带页面所见修订号
    }),
  placeLock: (id: number, revision: number) =>
    request<{ snapshot: Snapshot }>('POST', `/api/tickets/${id}/locks`, {
      revision,
    }),
  removeLock: (id: number, revision: number) =>
    request<{ snapshot: Snapshot }>('DELETE', `/api/tickets/${id}/locks`, {
      revision,
    }),
  reset: (id: number, revision: number) =>
    request<{ snapshot: Snapshot }>('POST', `/api/tickets/${id}/reset`, {
      revision,
    }),
}
