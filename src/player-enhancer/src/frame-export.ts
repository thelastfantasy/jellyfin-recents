// ── Frame Export Modal — Grid Page (US1-3), Progress Page (US7), Result Page (US7) ──

let _modalRoot: HTMLDivElement | null = null
let _videoEl: HTMLVideoElement | null = null
let _itemId = ''
let _currentPage: 'grid' | 'progress' | 'result' = 'grid'
let _activeTaskId = ''

// State
let _frames: FrameEntry[] = []
let _minPosMs = 0
let _maxPosMs = 0

interface FrameEntry {
  posMs: number
  selected: boolean
  jpegUrl: string
  isJunk: boolean
  junkReason: string | null
}

function getBaseUrl(): string {
  const ac = (window as any).ApiClient
  return ac?.serverAddress?.() ?? ac?._serverAddress ?? ''
}

function getToken(): string {
  const ac = (window as any).ApiClient
  return (typeof ac?.accessToken === 'function' ? ac.accessToken() : ac?._accessToken) ?? ''
}

function frameUrl(posMs: number, width: number): string {
  const base = getBaseUrl()
  const token = getToken()
  return `${base}/JellyfinSuite/FrameExport/${_itemId}?positionMs=${posMs}&width=${width}&api_key=${encodeURIComponent(token)}`
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const frac = Math.floor((ms % 1000) / 100)
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}`
}

// ── Public API ──────────────────────────────────────────────────────────────

export function openFrameExportModal(videoEl: HTMLVideoElement, itemId: string): void {
  _videoEl = videoEl
  _itemId = itemId
  _currentPage = 'grid'
  _frames = []
  _activeTaskId = ''

  // Create modal root
  _modalRoot = document.createElement('div')
  _modalRoot.className = 'fixed inset-0 z-[99999] flex items-center justify-center'
  _modalRoot.addEventListener('click', (e) => {
    if (e.target === _modalRoot) closeModal()
  })
  document.body.appendChild(_modalRoot)

  showGridPage()
  loadInitialFrames()
}

function closeModal(): void {
  if (_activeTaskId) {
    fetch(`${getBaseUrl()}/JellyfinSuite/FrameExport/Result/${_activeTaskId}?api_key=${encodeURIComponent(getToken())}`, { method: 'DELETE' }).catch(() => {})
  }
  _modalRoot?.remove()
  _modalRoot = null
}

// ── Grid Page ───────────────────────────────────────────────────────────────

function showGridPage(): void {
  if (!_modalRoot) return
  _currentPage = 'grid'
  _modalRoot.innerHTML = `
    <div class="alive-card d3 alive-enter-scale max-w-3xl w-full mx-4 max-h-[90vh] flex flex-col overflow-hidden">
      <div class="alive-stack alive-stack-h items-center justify-between p-4 border-b border-slate-200">
        <h2 class="text-lg font-semibold text-slate-900">帧导出</h2>
        <button id="jfs-fe-close" class="alive-button alive-button-ghost alive-button-sm">✕</button>
      </div>
      <div id="jfs-fe-grid" class="grid grid-cols-4 gap-3 p-4 overflow-y-auto flex-1"></div>
      <div class="alive-stack alive-stack-h items-center justify-between p-3 border-t border-slate-200 bg-slate-50">
        <span id="jfs-fe-count" class="text-sm text-slate-600">加载中...</span>
        <div class="flex gap-2">
          <button id="jfs-fe-prev" class="alive-button alive-button-secondary alive-button-sm" disabled>← 向前</button>
          <button id="jfs-fe-next" class="alive-button alive-button-secondary alive-button-sm">向后 →</button>
        </div>
      </div>
    </div>
  `

  document.getElementById('jfs-fe-close')?.addEventListener('click', closeModal)
  document.getElementById('jfs-fe-prev')?.addEventListener('click', () => expandFrames(-1))
  document.getElementById('jfs-fe-next')?.addEventListener('click', () => expandFrames(1))
}

async function loadInitialFrames(): Promise<void> {
  if (!_videoEl) return
  const durationMs = (_videoEl.duration ?? 0) * 1000
  const centerMs = _videoEl.currentTime * 1000
  const positions = samplePositions(centerMs, durationMs, 5, 5)
  _minPosMs = positions[0] ?? centerMs
  _maxPosMs = positions[positions.length - 1] ?? centerMs

  _frames = await loadFrameBatch(positions)
  renderGrid()
}

function samplePositions(centerMs: number, durationMs: number, before: number, after: number): number[] {
  const results: number[] = []
  // Sample every ~2 seconds within range
  const stepMs = 2000
  for (let i = -before; i <= after; i++) {
    const ms = Math.max(0, Math.min(durationMs, centerMs + i * stepMs))
    results.push(ms)
  }
  return results
}

async function loadFrameBatch(positions: number[]): Promise<FrameEntry[]> {
  const entries: FrameEntry[] = []
  const chunkSize = 4

  for (let i = 0; i < positions.length; i += chunkSize) {
    const chunk = positions.slice(i, i + chunkSize)
    const results = await Promise.all(
      chunk.map(async (posMs) => {
        const url = frameUrl(posMs, 320)
        try {
          const res = await fetch(url)
          if (!res.ok) return { posMs, selected: true, jpegUrl: '', isJunk: false, junkReason: null }
          const blob = await res.blob()
          const jpegUrl = URL.createObjectURL(blob)
          const qualityHeader = res.headers.get('X-Frame-Quality')
          let isJunk = false
          let junkReason: string | null = null
          if (qualityHeader) {
            try {
              const q = JSON.parse(qualityHeader) as { isJunk: boolean; junkReason: string | null }
              isJunk = q.isJunk
              junkReason = q.junkReason
            } catch { /* ignore */ }
          }
          return { posMs, selected: !isJunk, jpegUrl, isJunk, junkReason }
        } catch {
          return { posMs, selected: true, jpegUrl: '', isJunk: false, junkReason: null }
        }
      })
    )
    entries.push(...results)
  }
  return entries
}

async function expandFrames(direction: number): Promise<void> {
  if (!_videoEl) return
  const durationMs = (_videoEl.duration ?? 0) * 1000
  const stepMs = 2000
  const count = 10

  let newPositions: number[] = []
  if (direction < 0) {
    newPositions = []
    for (let i = count; i >= 1; i--) {
      const ms = _minPosMs - i * stepMs
      if (ms < 0) break
      newPositions.unshift(ms)
    }
    _minPosMs = newPositions[0] ?? _minPosMs
  } else {
    for (let i = 1; i <= count; i++) {
      const ms = _maxPosMs + i * stepMs
      if (ms > durationMs) break
      newPositions.push(ms)
    }
    _maxPosMs = newPositions[newPositions.length - 1] ?? _maxPosMs
  }

  if (newPositions.length === 0) {
    const btn = document.getElementById(direction < 0 ? 'jfs-fe-prev' : 'jfs-fe-next')
    if (btn) {
      btn.setAttribute('disabled', '')
      btn.textContent = direction < 0 ? '已到开头' : '已到结尾'
    }
    return
  }

  const btn = document.getElementById(direction < 0 ? 'jfs-fe-prev' : 'jfs-fe-next')
  if (btn) btn.setAttribute('disabled', '')
  const newFrames = await loadFrameBatch(newPositions)

  if (direction < 0) {
    _frames = [...newFrames, ..._frames]
  } else {
    _frames.push(...newFrames)
  }

  if (btn) btn.removeAttribute('disabled')
  if (direction < 0) {
    const isAtStart = _minPosMs <= 0
    const prevBtn = document.getElementById('jfs-fe-prev')
    if (prevBtn && isAtStart) {
      prevBtn.setAttribute('disabled', '')
      prevBtn.textContent = '已到开头'
    }
  }
  renderGrid()
}

function renderGrid(): void {
  const grid = document.getElementById('jfs-fe-grid')
  if (!grid) return

  grid.innerHTML = _frames
    .map((f, i) => {
      const junkClass = f.isJunk ? 'opacity-50 border-2 border-red-400' : ''
      const junkBadge = f.isJunk
        ? `<span class="alive-badge alive-badge-red alive-badge-sm absolute top-1 left-1 text-[10px]">${f.junkReason || '垃圾帧'}</span>`
        : ''
      return `
      <div class="relative ${junkClass} rounded-lg overflow-hidden bg-slate-100">
        ${junkBadge}
        <img src="${f.jpegUrl}" onerror="this.parentElement.innerHTML='<div class=\\'w-full aspect-video flex items-center justify-center text-slate-400 text-xs\\'>加载失败</div>'"
             class="w-full aspect-video object-cover cursor-pointer"
             alt="${formatTime(f.posMs)}" />
        <label class="alive-stack alive-stack-h items-center gap-1 p-1 text-xs text-slate-500">
          <input type="checkbox" ${f.selected ? 'checked' : ''} data-idx="${i}" class="jfs-fe-cb" />
          ${formatTime(f.posMs)}
        </label>
      </div>`
    })
    .join('')

  // Wire checkboxes
  grid.querySelectorAll('.jfs-fe-cb').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const idx = parseInt((e.target as HTMLInputElement).dataset.idx ?? '')
      if (!isNaN(idx) && _frames[idx]) {
        _frames[idx].selected = (e.target as HTMLInputElement).checked
        updateCount()
      }
    })
  })

  updateCount()
  updateExpandButtons()
}

function updateCount(): void {
  const el = document.getElementById('jfs-fe-count')
  if (!el) return
  const selected = _frames.filter((f) => f.selected).length
  el.textContent = `已选 ${selected} / 总数 ${_frames.length} 帧`
}

function updateExpandButtons(): void {
  const prevBtn = document.getElementById('jfs-fe-prev')
  const nextBtn = document.getElementById('jfs-fe-next')
  if (_minPosMs <= 0 && prevBtn) {
    prevBtn.setAttribute('disabled', '')
    prevBtn.textContent = '已到开头'
  }
  if (_videoEl && _maxPosMs >= (_videoEl.duration ?? 0) * 1000 - 2000 && nextBtn) {
    nextBtn.setAttribute('disabled', '')
    nextBtn.textContent = '已到结尾'
  }
}

// ── Progress Page (Phase 7 stub) ────────────────────────────────────────────

export function showProgressPage(taskId: string): void {
  _activeTaskId = taskId
  _currentPage = 'progress'
  // Placeholder — Phase 7 will implement SSE connection + progress bar
}

export function showResultPage(resultUrl: string, fileSize: number): void {
  _currentPage = 'result'
  // Placeholder — Phase 7 will implement result preview + download/delete
}
