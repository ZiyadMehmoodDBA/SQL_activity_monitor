// Guard browser-specific mocks: this setup file also runs for
// `@vitest-environment node` test files (tests/server/**), where `window`,
// `global.fetch` stubs, and DOM mocks must not be installed.
const isBrowser = typeof window !== 'undefined'

if (isBrowser) {
  await import('@testing-library/jest-dom')

  // ── localStorage mock ──────────────────────────────────────────────────────
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

  // ── sessionStorage mock ────────────────────────────────────────────────────
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

  // ── ResizeObserver stub ──────────────────────────────────────────────────
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  // ── window.confirm / alert stubs ─────────────────────────────────────────
  global.confirm = vi.fn(() => true)
  global.alert   = vi.fn()

  // ── fetch stub ───────────────────────────────────────────────────────────
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) })
  )

  // ── jest shim for @testing-library + Vitest fake timers ──────────────────
  // @testing-library/dom's waitFor only advances fake timers when a global
  // `jest` object with `advanceTimersByTime` is present.
  globalThis.jest = {
    advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })
}

// vi.mock calls are hoisted and safe in both environments (no-op when the
// module is never imported by a node test).
const makeSocket = () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), connected: false })
vi.mock('socket.io-client', () => ({
  io: vi.fn(makeSocket),
  default: vi.fn(makeSocket),
}))

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
