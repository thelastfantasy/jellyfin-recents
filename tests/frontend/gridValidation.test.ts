import { describe, it, expect } from 'bun:test'
import { isGridValid, maxFrames } from '../../apps/frontend/src/utils/gridValidation'

describe('isGridValid', () => {
  it('2×4 grid for 30 s video → valid (3.75 s/frame)', () => {
    expect(isGridValid(2, 4, 30)).toBe(true)
  })

  it('6×8 grid for 30 s video → invalid (0.625 s/frame)', () => {
    expect(isGridValid(6, 8, 30)).toBe(false)
  })

  it('boundary: exactly 2 s/frame → valid', () => {
    // 10 frames, 20 s → exactly 2 s/frame
    expect(isGridValid(2, 5, 20)).toBe(true)
  })

  it('boundary: 2 s/frame minus epsilon → invalid', () => {
    // 11 frames, 21 s → 1.909 s/frame
    expect(isGridValid(1, 11, 21)).toBe(false)
  })

  it('standard 6×8 grid for 3600 s video → valid (75 s/frame)', () => {
    expect(isGridValid(6, 8, 3600)).toBe(true)
  })

  it('single frame for any positive duration → valid', () => {
    expect(isGridValid(1, 1, 2)).toBe(true)
    expect(isGridValid(1, 1, 1)).toBe(false) // < 2 s
  })
})

describe('maxFrames', () => {
  it('30 s → 15 frames max', () => {
    expect(maxFrames(30)).toBe(15)
  })

  it('3600 s → 1800 frames max', () => {
    expect(maxFrames(3600)).toBe(1800)
  })

  it('fractional duration floors correctly', () => {
    // 5.9 s → floor(5.9/2) = 2
    expect(maxFrames(5.9)).toBe(2)
  })
})
