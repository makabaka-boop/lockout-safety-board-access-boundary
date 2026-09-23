import { useState } from 'react'
import { api } from '../api.js'
import type { Snapshot } from '../../shared/types.js'

interface WorkerOption {
  id: number
  username: string
  display_name: string
}

export function CreateTicketForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (s: Snapshot) => void
}) {
  const [device, setDevice] = useState('')
  const [pointCount, setPointCount] = useState(3)
  const [labels, setLabels] = useState<string[]>(['', '', ''])
  const [workers, setWorkers] = useState<WorkerOption[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  async function ensureWorkers() {
    if (loaded) return
    const { workers } = await api.workers()
    setWorkers(workers)
    setLoaded(true)
  }
  ensureWorkers()

  function changeCount(n: number) {
    const count = Math.max(1, Math.min(20, Math.floor(n) || 1))
    setPointCount(count)
    setLabels((prev) => {
      const next = prev.slice(0, count)
      while (next.length < count) next.push('')
      return next
    })
  }

  function toggle(username: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!device.trim()) return setError('设备名称不能为空')
    if (labels.some((l) => !l.trim())) return setError('所有隔离点都必须命名')
    if (new Set(labels.map((l) => l.trim())).size !== labels.length) {
      return setError('隔离点名称不能重复')
    }
    if (picked.size === 0) return setError('至少勾选 1 名授权检修人员')
    setBusy(true)
    try {
      const { snapshot } = await api.createTicket(
        device.trim(),
        labels.map((l) => l.trim()),
        [...picked],
      )
      onCreated(snapshot)
    } catch (err) {
      setError(err instanceof Error ? err.message : '建票失败')
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={submit} data-testid="create-ticket-form">
      <h2>新建作业票</h2>
      <label>
        设备名称
        <input
          value={device}
          onChange={(e) => setDevice(e.target.value)}
          placeholder="如：3 号循环水泵"
          data-testid="new-device"
        />
      </label>

      <label>
        隔离点数量（1–20）
        <input
          type="number"
          min={1}
          max={20}
          value={pointCount}
          onChange={(e) => changeCount(Number(e.target.value))}
          data-testid="new-point-count"
        />
      </label>

      <div className="points-editor">
        {labels.map((label, i) => (
          <label key={i}>
            必检点 {i + 1}
            <input
              value={label}
              onChange={(e) =>
                setLabels((prev) => {
                  const next = [...prev]
                  next[i] = e.target.value
                  return next
                })
              }
              data-testid={`new-point-${i}`}
            />
          </label>
        ))}
      </div>

      <fieldset>
        <legend>授权检修人员（至少 1 人，可多选）</legend>
        {workers.length === 0 && <p className="muted">加载人员中…</p>}
        <div className="checkbox-grid">
          {workers.map((w) => (
            <label key={w.username} className="checkbox">
              <input
                type="checkbox"
                checked={picked.has(w.username)}
                onChange={() => toggle(w.username)}
                data-testid={`pick-${w.username}`}
              />
              {w.display_name}（<code>{w.username}</code>）
            </label>
          ))}
        </div>
      </fieldset>

      {error && <div className="banner error" data-testid="create-error">{error}</div>}

      <div className="row">
        <button type="submit" disabled={busy} data-testid="create-submit">
          {busy ? '提交中…' : '创建'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}
