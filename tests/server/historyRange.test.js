// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseHistoryRange, VALID_RESOLUTIONS } from '../../server/historyRange.js'

const NOW = 1_700_000_000_000

describe('parseHistoryRange', () => {
  it('defaults: to = now, from = to - 1h', () => {
    expect(parseHistoryRange({}, NOW)).toEqual({ from: NOW - 3_600_000, to: NOW })
  })
  it('accepts explicit integer strings', () => {
    expect(parseHistoryRange({ from: '1000', to: '2000' }, NOW)).toEqual({ from: 1000, to: 2000 })
  })
  it('defaults from when only to given', () => {
    expect(parseHistoryRange({ to: String(NOW) }, NOW)).toEqual({ from: NOW - 3_600_000, to: NOW })
  })
  it('rejects non-numeric, negative, zero, reversed, NaN, floats', () => {
    expect(parseHistoryRange({ from: 'abc' }, NOW)).toBeNull()
    expect(parseHistoryRange({ from: '-5', to: '10' }, NOW)).toBeNull()
    expect(parseHistoryRange({ from: '0', to: '10' }, NOW)).toBeNull()
    expect(parseHistoryRange({ from: '2000', to: '1000' }, NOW)).toBeNull()
    expect(parseHistoryRange({ from: '1.5', to: '2000' }, NOW)).toBeNull()
  })
  it('exposes the valid resolution list', () => {
    expect(VALID_RESOLUTIONS).toEqual(['auto', 'raw', '1m', '15m', '1h'])
  })
})
