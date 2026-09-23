import { useState } from 'react'
import type { User } from '../../shared/types.js'
import { api, tokenStore } from '../api.js'

const DEMO: Array<{ username: string; password: string; hint: string }> = [
  { username: 'coord', password: 'coord123', hint: '协调员' },
  { username: 'zhang', password: 'worker123', hint: '检修人员' },
  { username: 'lead', password: 'lead123', hint: '送电负责人' },
]

export function Login({ onLoggedIn }: { onLoggedIn: (u: User) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.login(username.trim(), password)
      tokenStore.set(res.token)
      onLoggedIn(res.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container narrow">
      <h1>检修隔离牌板</h1>
      <p className="muted">能量隔离与上锁挂牌（LOTO）作业系统</p>
      <form onSubmit={submit} className="card">
        <label>
          账号
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            data-testid="login-username"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="login-password"
          />
        </label>
        {error && (
          <div className="banner error" data-testid="login-error">
            {error}
          </div>
        )}
        <button disabled={busy} data-testid="login-submit">
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
      <div className="card demo">
        <strong>演示账号</strong>
        <ul>
          {DEMO.map((d) => (
            <li key={d.username}>
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  setUsername(d.username)
                  setPassword(d.password)
                }}
              >
                {d.hint}：<code>{d.username}</code> / <code>{d.password}</code>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
