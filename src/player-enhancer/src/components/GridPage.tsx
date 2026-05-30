import {
  sFrames, sExportType, sParamsOpen, sSettings, sPrefetchTotal, sPrefetchDone,
  updateSettings, renderGrid,
  _frames, _videoEl, _frameIndex, _fiMinIdx, _fiMaxIdx, _minPosMs, _maxPosMs,
  frameInterval,
} from '../state'
import { t } from '../i18n'
import { FrameGrid } from './FrameGrid'
import { ParamsPanel } from './ParamsPanel'

export function GridPage({ onClose, onExpand, onGenerate }: {
  onClose:    () => void
  onExpand:   (dir: number) => void
  onGenerate: () => void
}) {
  const frames      = sFrames.value
  const exportType  = sExportType.value
  const st          = sSettings.value
  const paramsOpen  = sParamsOpen.value

  const visible      = frames.filter(f => !f.removed)
  const selectedCount = visible.filter(f => f.selected).length
  const allSel       = visible.length > 0 && selectedCount === visible.length
  const removedCount = frames.filter(f => f.removed).length
  const isMobile     = window.innerWidth < 600

  const dur   = _videoEl?.duration ?? 0
  const maxMs = (isFinite(dur) && dur > 0) ? dur * 1000 : 0
  const atStart = _frameIndex ? _fiMinIdx <= 0 : _minPosMs <= 0
  const atEnd   = _frameIndex
    ? _fiMaxIdx >= (_frameIndex.length - 1)
    : (maxMs > 0 && _maxPosMs >= maxMs - frameInterval())

  const prefTotal = sPrefetchTotal.value
  const prefDone  = sPrefetchDone.value
  const countLabel = prefTotal > 0 && prefDone < prefTotal
    ? `${t('frameExport.loading')} ${prefDone}/${prefTotal}`
    : `${isMobile ? '' : t('frameExport.selected') + ' '}${selectedCount}/${visible.length}`

  function handleSelectAll() {
    const shouldSelectAll = !visible.every(f => f.selected)
    visible.forEach(f => { f.selected = shouldSelectAll })
    renderGrid()
  }

  function handleRestore() {
    _frames.forEach(f => { if (f.removed) { f.removed = false; f.selected = true } })
    renderGrid()
  }

  function handleSparseChange(e: Event) {
    const n = parseInt((e.target as HTMLSelectElement).value) || 0
    if (n <= 0) return
    _frames.forEach((f, i) => { if (!f.removed) f.selected = i % n === 0 });
    (e.target as HTMLSelectElement).value = '0'
    renderGrid()
  }

  function handleFormatChange(e: Event) {
    const val = (e.target as HTMLSelectElement).value
    if (exportType === 'animate') updateSettings({ animateFormat: val as 'gif' | 'webp' })
    else                          updateSettings({ stitchFormat:  val as 'png' | 'webp' })
  }

  const fmt        = exportType === 'animate' ? st.animateFormat : st.stitchFormat
  const formatOpts = exportType === 'animate' ? ['gif', 'webp'] : ['png', 'webp']

  return (
    <div class="jfs-fe-osd">
      <FrameGrid />
      {paramsOpen && <ParamsPanel />}
      <div class="jfs-fe-row sep-t" id="jfs-fe-tbar">
        <span class="jfs-fe-title">剪辑工坊</span>
        <div class="jfs-fe-seg">
          <button class={`jfs-fe-seg-btn${exportType === 'animate' ? ' active' : ''}`} onClick={() => { sExportType.value = 'animate' }}>动画</button>
          <button class={`jfs-fe-seg-btn${exportType === 'stitch'  ? ' active' : ''}`} onClick={() => { sExportType.value = 'stitch'  }}>全景图</button>
        </div>
        <select class="jfs-fe-sel" value={fmt} onChange={handleFormatChange}>
          {formatOpts.map(o => <option key={o} value={o}>{o.toUpperCase()}</option>)}
        </select>
        <select class="jfs-fe-sel" title="稀疏选择" style={{ minWidth: '0' }} onChange={handleSparseChange}>
          <option value="0">稀疏▾</option>
          <option value="1">全</option>
          <option value="2">½</option>
          <option value="3">⅓</option>
          <option value="4">¼</option>
        </select>
        <button class="jfs-fe-btn g" onClick={() => { sParamsOpen.value = !sParamsOpen.value }}>
          {paramsOpen ? '参数 ▾' : '参数 ▴'}
        </button>
        <span class="jfs-fe-tbar-break" />
        <div class="jfs-fe-spacer" />
        <span class="jfs-fe-muted">
          {countLabel}
          <button class="jfs-fe-btn g" style={{ fontSize: '11px', padding: '2px 7px', marginLeft: '4px' }} onClick={handleSelectAll}>
            {allSel ? t('frameExport.deselectAll') : t('frameExport.selectAll')}
          </button>
          {removedCount > 0 && (
            <button class="jfs-fe-btn" style={{ fontSize: '11px', padding: '2px 7px', marginLeft: '4px', background: 'rgba(239,68,68,0.75)' }} onClick={handleRestore}>
              还原 {removedCount} 帧
            </button>
          )}
        </span>
        <button id="jfs-fe-prev" class="jfs-fe-btn" disabled={atStart} onClick={() => onExpand(-1)}>
          {atStart ? t('frameExport.atStart') : t('frameExport.loadPrev')}
        </button>
        <button id="jfs-fe-next" class="jfs-fe-btn" disabled={atEnd} onClick={() => onExpand(1)}>
          {atEnd ? t('frameExport.atEnd') : t('frameExport.loadNext')}
        </button>
        <button class="jfs-fe-btn p" onClick={onGenerate}>
          {exportType === 'animate' ? '生成动画' : '导出全景图'}
        </button>
        <button class="jfs-fe-btn g" style={{ padding: '2px 8px', fontSize: '16px' }} onClick={onClose}>✕</button>
      </div>
    </div>
  )
}
