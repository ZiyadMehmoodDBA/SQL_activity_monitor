// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { MemoryScanStore } from '../../server/indexScanStore.js'

describe('smoke', () => {
  it('imports MemoryScanStore', () => {
    expect(typeof MemoryScanStore).toBe('function')
  })
})
