// @vitest-environment jsdom
// 界面测试：React + Testing Library，所有 /api 请求都打到真实 Fastify + PostgreSQL。
// 重点覆盖"旧页面 / 并发请求"场景下界面自动重载到最新快照。
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import React from 'react'
import {
  startTwoInstances,
  stopTwoInstances,
  resetData,
  clientFor,
  CREDS,
} from '../harness.js'
import { tokenStore } from '../../src/web/api.js'

const AppModule = await import('../../src/web/App.js')
const App = AppModule.App

beforeAll(startTwoInstances)
afterAll(stopTwoInstances)
beforeEach(async () => {
  cleanup()
  await resetData()
  tokenStore.clear()
})
afterEach(cleanup)

function renderApp() {
  return render(React.createElement(App))
}

async function loginAs(username: string, password: string) {
  fireEvent.change(screen.getByTestId('login-username'), {
    target: { value: username },
  })
  fireEvent.change(screen.getByTestId('login-password'), {
    target: { value: password },
  })
  fireEvent.click(screen.getByTestId('login-submit'))
  await waitFor(() => expect(screen.getByText('＋ 新建作业票')).toBeTruthy())
}

async function createTicketFromUi(device: string, points: string[]) {
  fireEvent.click(screen.getByTestId('new-ticket-btn'))
  await waitFor(() =>
    expect(screen.getByTestId('create-ticket-form')).toBeTruthy(),
  )
  fireEvent.change(screen.getByTestId('new-device'), {
    target: { value: device },
  })
  fireEvent.change(screen.getByTestId('new-point-count'), {
    target: { value: String(points.length) },
  })
  points.forEach((p, i) => {
    fireEvent.change(screen.getByTestId(`new-point-${i}`), {
      target: { value: p },
    })
  })
  await waitFor(() =>
    expect(screen.getByTestId('pick-zhang')).toBeTruthy(),
  )
  fireEvent.click(screen.getByTestId('pick-zhang'))
  fireEvent.click(screen.getByTestId('pick-li'))
  fireEvent.click(screen.getByTestId('create-submit'))
}

describe('界面：登录与建票', () => {
  it('错误密码显示错误条', async () => {
    renderApp()
    fireEvent.change(screen.getByTestId('login-username'), {
      target: { value: 'coord' },
    })
    fireEvent.change(screen.getByTestId('login-password'), {
      target: { value: 'nope' },
    })
    fireEvent.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(screen.getByTestId('login-error')).toBeTruthy())
  })

  it('协调员建票后进入牌板，显示修订号 1', async () => {
    renderApp()
    await loginAs('coord', 'coord123')
    await createTicketFromUi('1 号风机', ['断电', '泄压'])
    await waitFor(() =>
      expect(screen.getByTestId('revision').textContent).toContain('修订号 1'),
    )
    expect(screen.getByText('断电')).toBeTruthy()
    expect(screen.getByText('泄压')).toBeTruthy()
  })
})

describe('界面：过期请求自动重载最新牌板', () => {
  it('检修人员持旧页面确认时，409 后界面重载并发者的结果，且可继续操作', async () => {
    // 准备一张两必检点、zhang/li 均授权的票
    const coord = await clientFor(4171, CREDS.coord)
    const created = await coord.post<{ snapshot: any }>('/api/tickets', {
      device: '2 号泵',
      points: ['断电', '泄压'],
      personnel: ['zhang', 'li'],
    })
    const ticketId = created.snapshot.ticket.id
    const point1 = created.snapshot.points[0]
    const point2 = created.snapshot.points[1]

    // 张师傅的浏览器登录并打开牌板（页面所见 revision=1）
    renderApp()
    fireEvent.change(screen.getByTestId('login-username'), {
      target: { value: 'zhang' },
    })
    fireEvent.change(screen.getByTestId('login-password'), {
      target: { value: 'worker123' },
    })
    fireEvent.click(screen.getByTestId('login-submit'))
    await waitFor(() =>
      expect(screen.getByTestId(`ticket-card-${ticketId}`)).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId(`ticket-card-${ticketId}`))
    await waitFor(() =>
      expect(screen.getByTestId('revision').textContent).toContain('修订号 1'),
    )

    // 与此同时，李师傅在另一个浏览器（直接打另一实例的真实 API）确认了点1：
    // 数据库 revision 1 → 2
    const li = await clientFor(4172, CREDS.li)
    await li.post(`/api/tickets/${ticketId}/confirm`, {
      pointId: point1.id,
      revision: 1,
    })

    // 张师傅的旧页面仍点"确认此点"（点1）→ 必然 409
    fireEvent.click(screen.getByTestId(`confirm-${point1.id}`))

    // 界面收到 CONFLICT，自动重载：修订号变 2，显示过期提示，点1 显示 li 已确认
    await waitFor(() =>
      expect(screen.getByTestId('revision').textContent).toContain('修订号 2'),
    )
    const notice = screen.getByTestId('board-notice')
    expect(notice.textContent).toContain('页面已过期')
    const row1 = screen.getByTestId(`point-row-${point1.id}`)
    expect(within(row1).getByText('li')).toBeTruthy()
    // 张的确认没有落库（失败保留牌板，未代签）
    expect(within(row1).queryByText('zhang')).toBeNull()

    // 重载后张用最新修订号确认点2成功，修订号推进到 3
    fireEvent.click(screen.getByTestId(`confirm-${point2.id}`))
    await waitFor(() =>
      expect(screen.getByTestId('revision').textContent).toContain('修订号 3'),
    )
    const row2 = screen.getByTestId(`point-row-${point2.id}`)
    expect(within(row2).getByText('zhang')).toBeTruthy()
  })

  it('送电复位收到并发冲突后，牌板立即采用最新修订号、锁数和阻断项', async () => {
    const coord = await clientFor(4171, CREDS.coord)
    const created = await coord.post<{ snapshot: any }>('/api/tickets', {
      device: '4 号电机',
      points: ['断电'],
      personnel: ['zhang'],
    })
    const ticketId = created.snapshot.ticket.id
    const point = created.snapshot.points[0]

    const zhang = await clientFor(4172, CREDS.zhang)
    const confirmed = await zhang.post<{ snapshot: any }>(
      `/api/tickets/${ticketId}/confirm`,
      { pointId: point.id, revision: 1 },
    )
    const readyRevision = confirmed.snapshot.ticket.revision

    renderApp()
    fireEvent.change(screen.getByTestId('login-username'), {
      target: { value: 'lead' },
    })
    fireEvent.change(screen.getByTestId('login-password'), {
      target: { value: 'lead123' },
    })
    fireEvent.click(screen.getByTestId('login-submit'))
    await waitFor(() =>
      expect(screen.getByTestId(`ticket-card-${ticketId}`)).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId(`ticket-card-${ticketId}`))
    await waitFor(() =>
      expect(screen.getByText('全部必检点已确认且个人锁为零，满足送电条件。')).toBeTruthy(),
    )
    expect((screen.getByTestId('reset-btn') as HTMLButtonElement).disabled).toBe(
      false,
    )

    // 负责人旧页面仍显示无锁时，检修人员在另一实例挂锁。
    await zhang.post(`/api/tickets/${ticketId}/locks`, {
      revision: readyRevision,
    })

    fireEvent.click(screen.getByTestId('reset-btn'))

    // 不能只更新提示：牌板本身必须刷新到冲突响应中的最新快照。
    await waitFor(() =>
      expect(screen.getByTestId('revision').textContent).toContain(
        `修订号 ${readyRevision + 1}`,
      ),
    )
    expect(screen.getByTestId('board-notice').textContent).toContain('页面已过期')
    expect(screen.getByTestId('lock-list').textContent).toContain('zhang')
    expect(screen.getByTestId('reset-blockers').textContent).toContain(
      '个人锁 1 把',
    )
    expect((screen.getByTestId('reset-btn') as HTMLButtonElement).disabled).toBe(
      true,
    )

    // 撤锁后旧牌板仍不能绕过按钮；刷新到最新快照后才能送电。
    await zhang.del(`/api/tickets/${ticketId}/locks`, {
      revision: readyRevision + 1,
    })
    fireEvent.click(screen.getByTestId('reload-btn'))
    await waitFor(() =>
      expect(screen.queryByTestId('reset-blockers')).toBeNull(),
    )
    fireEvent.click(screen.getByTestId('reset-btn'))
    await waitFor(() =>
      expect(screen.getByTestId('revision').textContent).toContain(
        `修订号 ${readyRevision + 3}`,
      ),
    )
    expect(screen.getByTestId('terminal-banner')).toBeTruthy()
  })

  it('送电负责人页面看到的阻断项随并发撤锁更新，刷新后可复位，终态拒绝挂锁', async () => {
    const coord = await clientFor(4171, CREDS.coord)
    const created = await coord.post<{ snapshot: any }>('/api/tickets', {
      device: '3 号阀',
      points: ['断电'],
      personnel: ['zhang'],
    })
    const ticketId = created.snapshot.ticket.id
    const point = created.snapshot.points[0]

    // 张确认点、挂锁（revision → 3）
    const zhang = await clientFor(4172, CREDS.zhang)
    const c1 = await zhang.post<{ snapshot: any }>(
      `/api/tickets/${ticketId}/confirm`,
      { pointId: point.id, revision: 1 },
    )
    const c2 = await zhang.post<{ snapshot: any }>(
      `/api/tickets/${ticketId}/locks`,
      { revision: c1.snapshot.ticket.revision },
    )
    const revWithLock = c2.snapshot.ticket.revision

    // 送电负责人打开页面：看到 locks:1 阻断，按钮禁用
    renderApp()
    fireEvent.change(screen.getByTestId('login-username'), {
      target: { value: 'lead' },
    })
    fireEvent.change(screen.getByTestId('login-password'), {
      target: { value: 'lead123' },
    })
    fireEvent.click(screen.getByTestId('login-submit'))
    await waitFor(() =>
      expect(screen.getByTestId(`ticket-card-${ticketId}`)).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId(`ticket-card-${ticketId}`))
    await waitFor(() =>
      expect(screen.getByTestId('reset-blockers').textContent).toContain(
        '个人锁 1 把',
      ),
    )
    expect((screen.getByTestId('reset-btn') as HTMLButtonElement).disabled).toBe(
      true,
    )

    // 张在另一浏览器撤下最后一锁
    await zhang.del(`/api/tickets/${ticketId}/locks`, {
      revision: revWithLock,
    })

    // 负责人点"刷新牌板"（等同轮询）→ 阻断消失，按钮可用
    fireEvent.click(screen.getByTestId('reload-btn'))
    await waitFor(() =>
      expect(screen.queryByTestId('reset-blockers')).toBeNull(),
    )
    expect((screen.getByTestId('reset-btn') as HTMLButtonElement).disabled).toBe(
      false,
    )

    // 复位成功：进入终态
    fireEvent.click(screen.getByTestId('reset-btn'))
    await waitFor(() =>
      expect(screen.getByTestId('terminal-banner')).toBeTruthy(),
    )
    expect(screen.getByText('已复位送电')).toBeTruthy()

    // 终态后张再尝试挂锁（API 级验证 UI 所依赖的契约）
    const zhangAfter = await clientFor(4171, CREDS.zhang)
    const err = await zhangAfter
      .post(`/api/tickets/${ticketId}/locks`, {
        revision: revWithLock + 2,
      })
      .catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.body.error.snapshot.blockers).toEqual(['terminal'])
  })
})
