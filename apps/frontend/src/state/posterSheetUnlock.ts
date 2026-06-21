const REQUIRED_CLICKS = 7
const WINDOW_MS = 5000

let clicks = 0
let timer: ReturnType<typeof setTimeout> | null = null

export function _resetState(): void {
  clicks = 0
  if (timer) { clearTimeout(timer); timer = null }
}

export function registerPosterViewClick(): boolean {
  clicks++
  if (timer) clearTimeout(timer)
  if (clicks >= REQUIRED_CLICKS) {
    clicks = 0
    localStorage.setItem('jfs-poster-unlocked', '1')
    return true
  }
  timer = setTimeout(() => { clicks = 0 }, WINDOW_MS)
  return false
}

export function isPosterUnlocked(): boolean {
  if (localStorage.getItem('jfs-poster-unlocked') === null) {
    try {
      const v = localStorage.getItem('jr-poster-unlocked')
      if (v !== null) { localStorage.setItem('jfs-poster-unlocked', v); localStorage.removeItem('jr-poster-unlocked') }
    } catch { /* localStorage 不可用时静默失败 */ }
  }
  return localStorage.getItem('jfs-poster-unlocked') === '1'
}
