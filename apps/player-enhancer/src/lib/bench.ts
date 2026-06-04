let _t0 = 0
const _fired = new Set<string>()

export const bench = {
  reset() {
    _t0 = performance.now()
    _fired.clear()
    console.log(`[bench] ▶ RESET abs=${Date.now()}`)
  },
  mark(label: string, data?: Record<string, unknown>) {
    const rel = Math.round(performance.now() - _t0)
    const extra = data ? ' ' + JSON.stringify(data) : ''
    console.log(`[bench] +${rel}ms ${label}${extra} abs=${Date.now()}`)
  },
  /** Log only the first call per key within a modal session. */
  once(key: string, label: string, data?: Record<string, unknown>) {
    if (_fired.has(key)) return
    _fired.add(key)
    bench.mark(label, data)
  },
}
