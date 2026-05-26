// ── Frame Export Modal — Grid Page (US1-3), Progress Page (US7), Result Page (US7) ──

let _modalRoot: HTMLDivElement | null = null
let _videoEl: HTMLVideoElement | null = null
let _itemId = ''
let _activeTaskId = ''
let _exportType: 'animate' | 'stitch' = 'animate'

// State
let _frames: FrameEntry[] = []
let _minPosMs = 0
let _maxPosMs = 0

// ── Settings (localStorage) ─────────────────────────────────────────────────
interface ExportSettings {
  animateFormat: 'gif' | 'webp'
  stitchFormat: 'png' | 'webp-lossless'
  resizeMode: 'width' | 'height'
  customWidth: number
  customHeight: number
  resolutionPreset: string
  fps: number
  loopCount: number
}

const DEFAULT_SETTINGS: ExportSettings = {
  animateFormat: 'gif',
  stitchFormat: 'png',
  resizeMode: 'width',
  customWidth: 0,
  customHeight: 0,
  resolutionPreset: 'original',
  fps: 5,
  loopCount: 0,
}

function loadSettings(): ExportSettings {
  try {
    const raw = localStorage.getItem('jfs-frameexport-settings')
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(s: ExportSettings): void {
  try { localStorage.setItem('jfs-frameexport-settings', JSON.stringify(s)) } catch { /* ignore */ }
}

let _settings = loadSettings()
let _paramsOpen = false

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
  _modalRoot.innerHTML = `
    <div class="alive-card d3 alive-enter-scale max-w-3xl w-full mx-4 max-h-[90vh] flex flex-col overflow-hidden">
      <div class="alive-stack alive-stack-h items-center justify-between p-4 border-b border-slate-200">
        <h2 class="text-lg font-semibold text-slate-900">帧导出</h2>
        <button id="jfs-fe-close" class="alive-button alive-button-ghost alive-button-sm">✕</button>
      </div>
      <div id="jfs-fe-grid" class="grid grid-cols-4 gap-3 p-4 overflow-y-auto flex-1"></div>
      <div class="alive-stack alive-stack-v p-3 border-t border-slate-200 bg-slate-50 gap-2">
        ${renderParamsPanel()}
        <div class="alive-stack alive-stack-h items-center justify-between">
          <span id="jfs-fe-count" class="text-sm text-slate-600">加载中...</span>
          <div class="flex gap-2">
            <button id="jfs-fe-prev" class="alive-button alive-button-secondary alive-button-sm" disabled>← 向前</button>
            <button id="jfs-fe-next" class="alive-button alive-button-secondary alive-button-sm">向后 →</button>
            <button id="jfs-fe-type" class="alive-button alive-button-ghost alive-button-sm">全景图</button>
            <button id="jfs-fe-generate" class="alive-button alive-button-primary alive-button-sm">生成动画</button>
          </div>
        </div>
      </div>
    </div>
  `

  document.getElementById('jfs-fe-close')?.addEventListener('click', closeModal)
  document.getElementById('jfs-fe-prev')?.addEventListener('click', () => expandFrames(-1))
  document.getElementById('jfs-fe-next')?.addEventListener('click', () => expandFrames(1))
  document.getElementById('jfs-fe-generate')?.addEventListener('click', submitGenerate)
  document.getElementById('jfs-fe-type')?.addEventListener('click', toggleType)
}

function toggleType(): void {
  _exportType = _exportType === 'animate' ? 'stitch' : 'animate'
  const genBtn = document.getElementById('jfs-fe-generate')
  const typeBtn = document.getElementById('jfs-fe-type')
  if (genBtn) genBtn.textContent = _exportType === 'animate' ? '生成动画' : '导出全景图'
  if (typeBtn) typeBtn.textContent = _exportType === 'animate' ? '全景图' : '动画'
  refreshParamsUI()
}

function renderParamsPanel(): string {
  const fmt = _exportType === 'animate' ? _settings.animateFormat : _settings.stitchFormat
  const isAnim = _exportType === 'animate'
  const opts = isAnim ? ['gif', 'webp'] : ['png', 'webp-lossless']
  const fmtOptions = opts.map(o => `<option value="${o}" ${fmt === o ? 'selected' : ''}>${o.toUpperCase()}</option>`).join('')

  const presets = ['original', '1080p', '720p', '480p', '360p']
  const resOptions = presets.map(p => `<option value="${p}" ${_settings.resolutionPreset === p ? 'selected' : ''}>${p === 'original' ? '原始' : p}</option>`).join('')

  const display = _paramsOpen ? '' : 'hidden'

  return `
    <div class="alive-stack alive-stack-h items-center gap-2">
      <select id="jfs-fe-format" class="alive-select text-xs py-1">${fmtOptions}</select>
      <button id="jfs-fe-params-toggle" class="alive-button alive-button-ghost alive-button-xs text-[11px]">参数 ▾</button>
    </div>
    <div id="jfs-fe-params" class="${display} alive-stack alive-stack-v gap-2 p-2 bg-slate-100 rounded-lg text-xs">
      <div class="alive-stack alive-stack-h items-center gap-2">
        <span class="text-slate-600 w-12">分辨率</span>
        <select id="jfs-fe-preset" class="alive-select text-xs flex-1">${resOptions}</select>
      </div>
      <div class="alive-stack alive-stack-h items-center gap-2">
        <label class="text-slate-600 cursor-pointer"><input type="radio" name="resizeMode" value="width" ${_settings.resizeMode === 'width' ? 'checked' : ''} class="mr-1 jfs-fe-mode" />宽</label>
        <label class="text-slate-600 cursor-pointer"><input type="radio" name="resizeMode" value="height" ${_settings.resizeMode === 'height' ? 'checked' : ''} class="mr-1 jfs-fe-mode" />高</label>
        <input id="jfs-fe-cw" type="number" value="${_settings.customWidth || ''}" placeholder="px" class="alive-input text-xs w-16 py-0.5" ${_settings.resizeMode === 'height' ? 'disabled' : ''} />
        <span class="text-slate-400">×</span>
        <input id="jfs-fe-ch" type="number" value="${_settings.customHeight || ''}" placeholder="auto" class="alive-input text-xs w-16 py-0.5" ${_settings.resizeMode === 'width' ? 'disabled' : ''} />
      </div>
      ${isAnim ? `
      <div class="alive-stack alive-stack-h items-center gap-2">
        <span class="text-slate-600 w-12">帧率</span>
        <input id="jfs-fe-fps" type="range" min="1" max="30" value="${_settings.fps}" class="flex-1" />
        <span id="jfs-fe-fps-val" class="text-slate-600 w-8">${_settings.fps}fps</span>
      </div>
      <div class="alive-stack alive-stack-h items-center gap-2">
        <span class="text-slate-600 w-12">循环</span>
        <input id="jfs-fe-loop" type="number" min="0" max="99" value="${_settings.loopCount}" class="alive-input text-xs w-16 py-0.5" />
        <span class="text-slate-400">(0=无限)</span>
      </div>
      ` : ''}
    </div>
  `
}

function refreshParamsUI(): void {
  const panel = document.getElementById('jfs-fe-params')
  if (!panel) return
  panel.outerHTML = renderParamsPanel()
  wireParams()
}

function wireParams(): void {
  document.getElementById('jfs-fe-params-toggle')?.addEventListener('click', () => {
    _paramsOpen = !_paramsOpen
    refreshParamsUI()
  })
  document.getElementById('jfs-fe-format')?.addEventListener('change', (e) => {
    if (_exportType === 'animate') _settings.animateFormat = (e.target as HTMLSelectElement).value as 'gif' | 'webp'
    else _settings.stitchFormat = (e.target as HTMLSelectElement).value as 'png' | 'webp-lossless'
    saveSettings(_settings)
  })
  document.getElementById('jfs-fe-preset')?.addEventListener('change', (e) => {
    _settings.resolutionPreset = (e.target as HTMLSelectElement).value
    if (_settings.resolutionPreset !== 'original') {
      _settings.resizeMode = 'width'
      _settings.customWidth = 0
      _settings.customHeight = 0
    }
    saveSettings(_settings)
    refreshParamsUI()
  })
  document.querySelectorAll('.jfs-fe-mode').forEach((r) => {
    r.addEventListener('change', (e) => {
      _settings.resizeMode = (e.target as HTMLInputElement).value as 'width' | 'height'
      saveSettings(_settings)
      refreshParamsUI()
    })
  })
  document.getElementById('jfs-fe-cw')?.addEventListener('input', (e) => {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    _settings.customWidth = v
    _settings.resolutionPreset = 'original'
    if (v > 0 && _videoEl) {
      const ratio = (_videoEl.videoHeight || 1) / (_videoEl.videoWidth || 1)
      _settings.customHeight = Math.round(v * ratio)
    }
    saveSettings(_settings)
    refreshParamsUI()
  })
  document.getElementById('jfs-fe-ch')?.addEventListener('input', (e) => {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    _settings.customHeight = v
    _settings.resolutionPreset = 'original'
    if (v > 0 && _videoEl) {
      const ratio = (_videoEl.videoWidth || 1) / (_videoEl.videoHeight || 1)
      _settings.customWidth = Math.round(v * ratio)
    }
    saveSettings(_settings)
    refreshParamsUI()
  })
  document.getElementById('jfs-fe-fps')?.addEventListener('input', (e) => {
    _settings.fps = parseInt((e.target as HTMLInputElement).value) || 5
    saveSettings(_settings)
    const val = document.getElementById('jfs-fe-fps-val')
    if (val) val.textContent = `${_settings.fps}fps`
  })
  document.getElementById('jfs-fe-loop')?.addEventListener('input', (e) => {
    _settings.loopCount = Math.max(0, Math.min(99, parseInt((e.target as HTMLInputElement).value) || 0))
    saveSettings(_settings)
  })
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

// ── Generate / Progress / Result ────────────────────────────────────────────

async function submitGenerate(): Promise<void> {
  const selected = _frames.filter((f) => f.selected)
  if (selected.length < 2) {
    alert('至少需要选择 2 帧')
    return
  }
  if (selected.length > 50 && !confirm(`选中 ${selected.length} 帧，文件可能较大。继续？`)) return

  const format = _exportType === 'animate' ? _settings.animateFormat : _settings.stitchFormat
  const body = {
    itemId: _itemId,
    itemTitle: document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'export',
    type: _exportType,
    frames: selected.map((f) => ({ positionMs: f.posMs })),
    params: {
      format,
      resizeMode: _settings.resizeMode,
      customWidth: _settings.customWidth || null,
      customHeight: _settings.customHeight || null,
      resolutionPreset: _settings.resolutionPreset,
      fps: _settings.fps,
      loopCount: _settings.loopCount,
    },
  }

  const res = await fetch(`${getBaseUrl()}/JellyfinSuite/FrameExport/Generate?api_key=${encodeURIComponent(getToken())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    alert(`生成失败: ${res.status}`)
    return
  }

  const { taskId } = await res.json() as { taskId: string }
  showProgressPage(taskId)
}

export function showProgressPage(taskId: string): void {
  _activeTaskId = taskId
  if (!_modalRoot) return

  _modalRoot.innerHTML = `
    <div class="alive-card d3 alive-enter-scale max-w-md w-full mx-4">
      <div class="p-6">
        <h2 class="text-lg font-semibold text-slate-900 mb-4">生成中</h2>
        <div class="alive-progress">
          <div id="jfs-fe-progress-bar" class="alive-progress-bar" style="width:0%"></div>
        </div>
        <p id="jfs-fe-progress-text" class="text-sm text-slate-500 mt-2">准备中...</p>
      </div>
      <div class="p-3 border-t border-slate-200">
        <button id="jfs-fe-cancel" class="alive-button alive-button-secondary alive-button-sm w-full">取消</button>
      </div>
    </div>
  `

  document.getElementById('jfs-fe-cancel')?.addEventListener('click', () => {
    fetch(`${getBaseUrl()}/JellyfinSuite/FrameExport/Cancel/${taskId}?api_key=${encodeURIComponent(getToken())}`, { method: 'POST' }).catch(() => {})
    closeModal()
  })

  // SSE connection
  const evSrc = new EventSource(`${getBaseUrl()}/JellyfinSuite/FrameExport/Progress?taskId=${encodeURIComponent(taskId)}&api_key=${encodeURIComponent(getToken())}`)
  let retries = 0

  evSrc.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as { status: string; percent: number; phase: string; current: number; total: number; resultUrl?: string; fileSize?: number; error?: string }
      const bar = document.getElementById('jfs-fe-progress-bar')
      const text = document.getElementById('jfs-fe-progress-text')
      if (bar) bar.style.width = `${data.percent}%`
      if (text) text.textContent = `${data.phase || '处理中...'} (${Math.round(data.percent)}%)`

      if (data.status === 'complete' && data.resultUrl) {
        evSrc.close()
        showResultPage(data.resultUrl, data.fileSize ?? 0)
      } else if (data.status === 'error') {
        evSrc.close()
        if (text) text.textContent = `错误: ${data.error || '未知错误'}`
        document.getElementById('jfs-fe-cancel')!.textContent = '关闭'
      }
    } catch { /* ignore */ }
  }

  evSrc.onerror = () => {
    if (retries++ < 3) return // auto-reconnect
    evSrc.close()
    const text = document.getElementById('jfs-fe-progress-text')
    if (text) text.textContent = '连接中断，请重试'
  }
}

export function showResultPage(resultUrl: string, fileSize: number): void {
  if (!_modalRoot) return

  const fullUrl = resultUrl.startsWith('http') ? resultUrl : `${getBaseUrl()}${resultUrl}?api_key=${encodeURIComponent(getToken())}`
  const sizeStr = fileSize > 1024 * 1024 ? `${(fileSize / 1024 / 1024).toFixed(1)} MB` : `${(fileSize / 1024).toFixed(0)} KB`

  _modalRoot.innerHTML = `
    <div class="alive-card d3 alive-enter-scale max-w-2xl w-full mx-4 max-h-[90vh] flex flex-col overflow-hidden">
      <div class="alive-stack alive-stack-h items-center justify-between p-4 border-b border-slate-200">
        <button id="jfs-fe-back" class="alive-button alive-button-ghost alive-button-sm">← 返回</button>
        <h2 class="text-lg font-semibold text-slate-900">预览</h2>
        <button id="jfs-fe-close2" class="alive-button alive-button-ghost alive-button-sm">✕</button>
      </div>
      <div class="flex-1 flex items-center justify-center p-4 bg-slate-50 overflow-auto">
        <img src="${fullUrl}" class="max-w-full max-h-full object-contain rounded-lg shadow-lg" alt="result" />
      </div>
      <div class="alive-stack alive-stack-h items-center justify-between p-4 border-t border-slate-200">
        <span class="text-sm text-slate-500">${sizeStr}</span>
        <div class="flex gap-2">
          <button id="jfs-fe-download" class="alive-button alive-button-primary alive-button-sm">下载</button>
          <button id="jfs-fe-delete" class="alive-button alive-button-secondary alive-button-sm">删除</button>
        </div>
      </div>
    </div>
  `

  document.getElementById('jfs-fe-back')?.addEventListener('click', () => {
    if (_activeTaskId) {
      fetch(`${getBaseUrl()}/JellyfinSuite/FrameExport/Result/${_activeTaskId}?api_key=${encodeURIComponent(getToken())}`, { method: 'DELETE' }).catch(() => {})
    }
    showGridPage()
  })
  document.getElementById('jfs-fe-close2')?.addEventListener('click', closeModal)
  document.getElementById('jfs-fe-delete')?.addEventListener('click', () => {
    fetch(`${getBaseUrl()}/JellyfinSuite/FrameExport/Result/${_activeTaskId}?api_key=${encodeURIComponent(getToken())}`, { method: 'DELETE' }).catch(() => {})
    showGridPage()
  })
  document.getElementById('jfs-fe-download')?.addEventListener('click', () => {
    window.open(fullUrl, '_blank')
  })
}
