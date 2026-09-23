// 界面测试环境：jsdom 中把 /api/* 转发到真实的实例 A（无 mock 业务逻辑）
import { vi } from 'vitest'

const TARGET = 'http://127.0.0.1:4171'

const realFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  const resolved = url.startsWith('/api')
    ? TARGET + url
    : url.startsWith('http')
      ? url
      : TARGET + url
  return realFetch(resolved, init as RequestInit)
}

// jsdom 不实现 matchMedia / scrollTo（仅 jsdom 环境下处理）
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
  if (!window.scrollTo) {
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  }
}
