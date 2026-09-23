import { useEffect, useState, useCallback } from 'react'
import type { User } from '../shared/types.js'
import { api, tokenStore } from './api.js'
import { Login } from './components/Login.js'
import { TicketList } from './components/TicketList.js'

export function App() {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)

  const restore = useCallback(async () => {
    if (!tokenStore.get()) {
      setReady(true)
      return
    }
    try {
      const { user } = await api.me()
      setUser(user)
    } catch {
      tokenStore.clear()
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    restore()
  }, [restore])

  if (!ready) return <div className="container">加载中…</div>
  if (!user) return <Login onLoggedIn={setUser} />

  return (
    <TicketList
      user={user}
      onLogout={() => {
        tokenStore.clear()
        setUser(null)
      }}
    />
  )
}
