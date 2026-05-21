import '@testing-library/jest-dom'

// ── localStorage mock ──────────────────────────────────────────────────────────
const localStorageMock = (() => {
  let store = {}
  return {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(window, 'localStorage', { value: localStorageMock })

// ── sessionStorage mock ────────────────────────────────────────────────────────
const sessionStorageMock = (() => {
  let store = {}
  return {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(window, 'sessionStorage', { value: sessionStorageMock })

// ── socket.io-client mock ──────────────────────────────────────────────────────
vi.mock('socket.io-client', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
  })),
}))

// ── @tanstack/react-virtual mock ───────────────────────────────────────────────
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }) => ({
    getTotalSize: () => count * (estimateSize ? estimateSize(0) : 40),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        key: i,
        index: i,
        start: i * (estimateSize ? estimateSize(i) : 40),
        size: estimateSize ? estimateSize(i) : 40,
      })),
    measureElement: vi.fn(),
  }),
}))

// ── ResizeObserver stub ────────────────────────────────────────────────────────
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// ── window.confirm / alert stubs ──────────────────────────────────────────────
global.confirm = vi.fn(() => true)
global.alert   = vi.fn()

// ── fetch stub ────────────────────────────────────────────────────────────────
global.fetch = vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
)

// ── jest shim for @testing-library + Vitest fake timers ────────────────────────
// @testing-library/dom's waitFor only advances fake timers when a global `jest`
// object with `advanceTimersByTime` is present. Vitest does not provide one, so
// without this shim waitFor() hangs whenever a test calls vi.useFakeTimers().
globalThis.jest = {
  advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms),
}

// Reset mocks between tests
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})
