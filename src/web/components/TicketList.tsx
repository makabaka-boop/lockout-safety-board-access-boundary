import { useEffect, useState } from 'react'
import type { Snapshot, User } from '../../shared/types.js'
import { api } from '../api.js'
import { CreateTicketForm } from './CreateTicketForm.js'
import { TicketBoard } from './TicketBoard.js'

const ROLE_LABEL: Record<User['role'], string> = {
  coordinator: '协调员',
  worker: '检修人员',
  lead: '送电负责人',
}

export function TicketList({
  user,
  onLogout,
}: {
  user: User
  onLogout: () => void
}) {
  const [tickets, setTickets] = useState<Snapshot[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      const { tickets } = await api.listTickets()
      setTickets(tickets)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  if (selected != null) {
    return (
      <TicketBoard
        ticketId={selected}
        user={user}
        onBack={() => {
          setSelected(null)
          refresh()
        }}
      />
    )
  }

  return (
    <div className="container">
      <header className="topbar">
        <h1>检修隔离牌板</h1>
        <div className="who">
          <span className="badge">{ROLE_LABEL[user.role]}</span>
          {user.display_name}（<code>{user.username}</code>）
          <button className="secondary" onClick={onLogout}>
            退出
          </button>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      {user.role === 'coordinator' && (
        <section>
          {showCreate ? (
            <CreateTicketForm
              onCancel={() => setShowCreate(false)}
              onCreated={(s) => {
                setShowCreate(false)
                setSelected(s.ticket.id)
              }}
            />
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              data-testid="new-ticket-btn"
            >
              ＋ 新建作业票
            </button>
          )}
        </section>
      )}

      <section className="grid">
        {tickets.length === 0 && (
          <p className="muted">暂无作业票{user.role === 'coordinator' ? '，点击上方按钮新建' : ''}。</p>
        )}
        {tickets.map((s) => {
          const confirmed = s.points.filter((p) => p.confirmed_by != null).length
          return (
            <button
              key={s.ticket.id}
              className="card ticket-card"
              onClick={() => setSelected(s.ticket.id)}
              data-testid={`ticket-card-${s.ticket.id}`}
            >
              <div className="ticket-card-head">
                <strong>#{s.ticket.id} {s.ticket.device}</strong>
                <span
                  className={`status ${s.ticket.status === 'energized' ? 'energized' : 'maintenance'}`}
                >
                  {s.ticket.status === 'energized' ? '已送电' : '检修中'}
                </span>
              </div>
              <div className="muted small">
                隔离点 {confirmed}/{s.points.length} 已确认 · 个人锁 {s.locks.length} 把
              </div>
              <div className="muted small">修订号 {s.ticket.revision}</div>
            </button>
          )
        })}
      </section>
    </div>
  )
}
