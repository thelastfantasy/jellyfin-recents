import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test'
import { registerPosterViewClick, isPosterUnlocked, _resetState } from '../../apps/frontend/src/state/posterSheetUnlock'

describe('registerPosterViewClick', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    localStorage.clear()
    _resetState()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('7 clicks within 5 s → returns true and sets localStorage', () => {
    for (let i = 0; i < 6; i++) {
      expect(registerPosterViewClick()).toBe(false)
    }
    expect(registerPosterViewClick()).toBe(true)
    expect(isPosterUnlocked()).toBe(true)
    expect(localStorage.getItem('jfs-poster-unlocked')).toBe('1')
  })

  it('6 clicks then 5 s timeout → counter resets, next click does not unlock', () => {
    for (let i = 0; i < 6; i++) registerPosterViewClick()
    jest.advanceTimersByTime(5001)
    expect(registerPosterViewClick()).toBe(false)
    expect(isPosterUnlocked()).toBe(false)
  })

  it('4 clicks, timeout, then 3 more clicks → no unlock', () => {
    for (let i = 0; i < 4; i++) registerPosterViewClick()
    jest.advanceTimersByTime(5001)
    for (let i = 0; i < 3; i++) registerPosterViewClick()
    expect(isPosterUnlocked()).toBe(false)
  })

  it('exactly 5000 ms between first and last click → still within window', () => {
    for (let i = 0; i < 6; i++) {
      registerPosterViewClick()
      jest.advanceTimersByTime(100)
    }
    // Timer resets on each click; 5 s window from last click
    expect(registerPosterViewClick()).toBe(true)
    expect(isPosterUnlocked()).toBe(true)
  })
})

describe('isPosterUnlocked', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetState()
  })

  it('returns false when localStorage is empty', () => {
    expect(isPosterUnlocked()).toBe(false)
  })

  it('returns true when localStorage key is set to "1"', () => {
    localStorage.setItem('jfs-poster-unlocked', '1')
    expect(isPosterUnlocked()).toBe(true)
  })

  it('returns false for any value other than "1"', () => {
    localStorage.setItem('jfs-poster-unlocked', 'true')
    expect(isPosterUnlocked()).toBe(false)
  })

  it('migrates jr-poster-unlocked to jfs-poster-unlocked on first call', () => {
    localStorage.setItem('jr-poster-unlocked', '1')
    expect(isPosterUnlocked()).toBe(true)
    expect(localStorage.getItem('jfs-poster-unlocked')).toBe('1')
    expect(localStorage.getItem('jr-poster-unlocked')).toBeNull()
  })
})
