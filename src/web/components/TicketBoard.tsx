import { useEffect } from 'react'
import type { User } from '../../shared/types.js'
import { api } from '../api.js'
import { describeBlockers, useBoard } from '../useBoard.js'

export function TicketBoard({
  ticketId,
  user,
  onBack,
}: {
  ticketId: number
  user: User
  onBack: () => void
}) {
  const { snapshot, loading, notice, busy, reload, mutate } = useBoard(ticketId)

  // 每 5 秒后台轮询一次，另一浏览器的变更会反映过来；
  // 但写操作仍严格以“操作发起时页面所见修订号”裁决。
  useEffect(() => {
    const timer = setInterval(() => reload(), 5000)
    return () => clearInterval(timer)
  }, [reload])

  if (loading || !snapshot) {
    return (
      <div className="container">
        <button className="secondary" onClick={onBack}>
          ← 返回列表
        </button>
        <p className="muted">加载牌板中…</p>
      </div>
    )
  }

  const { ticket, points, locks, personnel, blockers } = snapshot
  const terminal = ticket.status === 'energized'
  const authorized = personnel.some((p) => p.username === user.username)
  const myLock = locks.find((l) => l.username === user.username)
  const canReset =
    user.role === 'lead' && !terminal && blockers.length === 0

  return (
    <div className="container" data-testid={`board-${ticketId}`}>
      <div className="row">
        <button className="secondary" onClick={onBack} data-testid="back-btn">
          ← 返回列表
        </button>
        <button className="secondary" onClick={() => reload()} data-testid="reload-btn">
          ⟳ 刷新牌板
        </button>
      </div>

      <header className="card board-head">
        <div>
          <h2>
            #{ticket.id} {ticket.device}
          </h2>
          <div className="muted small">
            协调员：{ticket.coordinator} · 创建于{' '}
            {new Date(ticket.created_at).toLocaleString('zh-CN')}
          </div>
        </div>
        <div className="board-state">
          <span className={`status ${terminal ? 'energized' : 'maintenance'}`}>
            {terminal ? '已复位送电' : '检修中'}
          </span>
          <span className="revision" data-testid="revision">
            修订号 {ticket.revision}
          </span>
        </div>
      </header>

      {notice && (
        <div
          className={`banner ${
            notice.kind === 'success'
              ? 'success'
              : notice.kind === 'conflict'
                ? 'warn'
                : notice.kind === 'forbidden'
                  ? 'error'
                  : notice.kind === 'info'
                    ? 'info'
                    : 'error'
          }`}
          data-testid="board-notice"
        >
          {notice.text}
        </div>
      )}

      {terminal && (
        <div className="banner warn" data-testid="terminal-banner">
          该票已复位送电（终态）。此后任何隔离点确认或个人锁挂/撤请求都将被拒绝。
        </div>
      )}

      <section className="card">
        <h3>必检隔离点（{points.filter((p) => p.confirmed_by != null).length}/{points.length} 已确认）</h3>
        <table className="points-table">
          <thead>
            <tr>
              <th>#</th>
              <th>隔离点</th>
              <th>确认人</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.id} data-testid={`point-row-${p.id}`}>
                <td>{p.position}</td>
                <td>{p.label}</td>
                <td>
                  {p.confirmed_by ? (
                    <>
                      <strong>{p.confirmed_by}</strong>
                      <span className="muted small">
                        {' '}
                        {p.confirmed_at &&
                          new Date(p.confirmed_at).toLocaleString('zh-CN')}
                      </span>
                    </>
                  ) : (
                    <span className="muted">未确认</span>
                  )}
                </td>
                <td>
                  {user.role === 'worker' &&
                    !p.confirmed_by &&
                    !terminal &&
                    authorized && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          mutate((rev) => api.confirm(ticketId, p.id, rev))
                        }
                        data-testid={`confirm-${p.id}`}
                      >
                        确认此点
                      </button>
                    )}
                  {p.confirmed_by && <span className="tag ok">已隔离确认</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {user.role === 'worker' && !authorized && !terminal && (
          <div className="banner error">你未被授权在该票上确认隔离点。</div>
        )}
      </section>

      <section className="card">
        <h3>个人锁（{locks.length} 把挂出）</h3>
        {locks.length === 0 ? (
          <p className="muted">当前没有个人锁。</p>
        ) : (
          <ul className="lock-list" data-testid="lock-list">
            {locks.map((l) => (
              <li key={l.id} className="lock-item" data-testid={`lock-${l.username}`}>
                🔒 {l.display_name}（<code>{l.username}</code>）
                <span className="muted small">
                  {' '}
                  {new Date(l.created_at).toLocaleString('zh-CN')}
                </span>
              </li>
            ))}
          </ul>
        )}
        {user.role === 'worker' && !terminal && authorized && (
          <div className="row">
            <button
              disabled={busy || !!myLock}
              onClick={() => mutate((rev) => api.placeLock(ticketId, rev))}
              title={myLock ? '每人每张票只能挂一把个人锁' : undefined}
              data-testid="place-lock"
            >
              {myLock ? '已挂我的个人锁' : '挂上我的个人锁'}
            </button>
            <button
              className="secondary"
              disabled={busy || !myLock}
              onClick={() => mutate((rev) => api.removeLock(ticketId, rev))}
              data-testid="remove-lock"
            >
              撤下我的个人锁
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h3>授权检修人员</h3>
        <div className="personnel">
          {personnel.map((p) => (
            <span key={p.username} className="tag">
              {p.display_name}（<code>{p.username}</code>）
            </span>
          ))}
        </div>
      </section>

      {user.role === 'lead' && (
        <section className="card reset-box">
          <h3>送电裁决</h3>
          {terminal ? (
            <div className="banner warn">
              设备已送电。复位最多只能成功一次，再次复位被拒绝。
            </div>
          ) : blockers.length === 0 ? (
            <p className="ok">全部必检点已确认且个人锁为零，满足送电条件。</p>
          ) : (
            <div className="banner error" data-testid="reset-blockers">
              暂不能送电，阻断项：{describeBlockers(blockers)}
            </div>
          )}
          {!terminal && (
            <button
              disabled={busy || !canReset}
              title={canReset ? undefined : '存在阻断项'}
              onClick={() => mutate((rev) => api.reset(ticketId, rev))}
              data-testid="reset-btn"
            >
              复位并送电
            </button>
          )}
        </section>
      )}
    </div>
  )
}
