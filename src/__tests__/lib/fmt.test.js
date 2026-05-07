import { describe, it, expect } from 'vitest'
import { fmtNum, fmtBytes, fmtMs, fmtJobDuration, kSuffix } from '../../lib/fmt'

describe('fmtNum', () => {
  it('returns — for null/undefined', () => {
    expect(fmtNum(null)).toBe('—')
    expect(fmtNum(undefined)).toBe('—')
  })
  it('formats numbers with locale separators', () => {
    expect(fmtNum(1000)).toMatch(/1[,.]000/)
    expect(fmtNum(0)).toBe('0')
  })
})

describe('fmtBytes', () => {
  it('returns — for null', () => expect(fmtBytes(null)).toBe('—'))
  it('formats KB', () => expect(fmtBytes(2048)).toBe('2 KB'))
  it('formats MB', () => expect(fmtBytes(2 * 1048576)).toBe('2.0 MB'))
  it('formats GB', () => expect(fmtBytes(3 * 1073741824)).toBe('3.0 GB'))
  it('formats TB', () => expect(fmtBytes(2 * 1099511627776)).toBe('2.0 TB'))
})

describe('fmtMs', () => {
  it('returns — for null', () => expect(fmtMs(null)).toBe('—'))
  it('formats seconds', () => expect(fmtMs(45000)).toBe('45s'))
  it('formats minutes', () => expect(fmtMs(3 * 60 * 1000)).toBe('3m'))
  it('formats hours', () => expect(fmtMs(2 * 60 * 60 * 1000)).toBe('2h'))
  it('0ms = 0s', () => expect(fmtMs(0)).toBe('0s'))
})

describe('fmtJobDuration', () => {
  it('returns — for falsy', () => expect(fmtJobDuration(0)).toBe('—'))
  it('formats seconds only', () => expect(fmtJobDuration(45)).toBe('45s'))
  it('formats minutes and seconds', () => expect(fmtJobDuration(215)).toBe('2m 15s'))
  it('formats hours minutes seconds', () => expect(fmtJobDuration(12345)).toBe('1h 23m 45s'))
})

describe('kSuffix', () => {
  it('returns — for null', () => expect(kSuffix(null)).toBe('—'))
  it('leaves small numbers as-is', () => expect(kSuffix(999)).toBe('999'))
  it('formats thousands', () => expect(kSuffix(1500)).toBe('1.5k'))
  it('formats millions', () => expect(kSuffix(2000000)).toBe('2.0M'))
})
