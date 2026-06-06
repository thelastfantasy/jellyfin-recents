import { useAtomValue } from 'jotai'
import type { ChangeEvent } from 'react'

import {
  _fi, _frames, _maxPosMs,
  _minPosMs, _videoEl, exportTypeAtom, frameInterval,
  framesAtom, paramsOpenAtom, prefetchDoneAtom,
  prefetchTotalAtom, setFrames, settingsAtom, sExportType, sParamsOpen,
  updateSettings,
} from '../core/state'
import { t } from '../lib/i18n'
import { FrameGrid } from './FrameGrid'
import { FrameGridSkeleton } from './FrameGridSkeleton'
import { ParamsPanel } from './ParamsPanel'

export function GridPage({ onClose, onExpandBack, onExpandForward, onGenerate, loading = false }: {
  onClose:        () => void
  onExpandBack:   () => void
  onExpandForward: () => void
  onGenerate:     () => void
  loading?:       boolean
}) {
  const frames      = useAtomValue(framesAtom)
  const exportType  = useAtomValue(exportTypeAtom)
  const settings    = useAtomValue(settingsAtom)
  const paramsOpen  = useAtomValue(paramsOpenAtom)
  const prefTotal   = useAtomValue(prefetchTotalAtom)
  const prefDone    = useAtomValue(prefetchDoneAtom)

  const visible      = frames.filter(f => !f.removed)
  const selectedCount = visible.filter(f => f.selected).length
  const allSel       = visible.length > 0 && selectedCount === visible.length
  const removedCount = frames.filter(f => f.removed).length
  const isMobile     = window.innerWidth < 600

  const dur    = _videoEl?.duration ?? 0
  const maxMs  = (isFinite(dur) && dur > 0) ? dur * 1000 : 0
  const playMs = (_videoEl?.currentTime ?? 0) * 1000
  const atStart = playMs <= 1000 || (_fi.index ? _fi.minIdx <= 0 : _minPosMs <= 0)
  const atEnd   = (maxMs > 0 && maxMs - playMs < 1000)
    || (_fi.index
      ? _fi.maxIdx >= (_fi.index.length - 1)
      : (maxMs > 0 && _maxPosMs >= maxMs - frameInterval()))
  const countLabel = prefTotal > 0 && prefDone < prefTotal
    ? `${t('frameExport.loading')} ${prefDone}/${prefTotal}`
    : `${isMobile ? '' : t('frameExport.selected') + ' '}${selectedCount}/${visible.length}`

  const canGenerate = selectedCount > 1 && visible.filter(f => f.selected).every(f => f.jpegUrl && !f.loadError)
  const displayFormat = exportType === 'animate' ? settings.animateFormat : settings.stitchFormat
  const formatOpts = exportType === 'animate' ? ['gif', 'webp'] : ['png', 'webp']

  function handleSelectAll() {
    const val = !visible.every(f => f.selected)
    setFrames(_frames.map(f => f.removed ? f : { ...f, selected: val }))
  }

  function handleRestore() {
    setFrames(_frames.map(f => f.removed ? { ...f, removed: false, selected: true } : f))
  }

  function handleSparseChange(e: ChangeEvent<HTMLSelectElement>) {
    const spacing = parseInt(e.target.value) || 0
    if (spacing <= 0) return
    setFrames(_frames.map((f, i) => f.removed ? f : { ...f, selected: i % spacing === 0 }))
    ;(e.target as HTMLSelectElement).value = '0'
  }

  function handleFormatChange(e: ChangeEvent<HTMLSelectElement>) {
    const formatValue = e.target.value
    if (exportType === 'animate') updateSettings({ animateFormat: formatValue as 'gif' | 'webp' })
    else                          updateSettings({ stitchFormat:  formatValue as 'png' | 'webp' })
  }

  return (
    <div className="jfs-fe-osd">
      {loading ? <FrameGridSkeleton count={Math.round(2 * _fi.fpsFrac.num / _fi.fpsFrac.den)} /> : <FrameGrid />}
      {paramsOpen && <ParamsPanel />}
      <div className="jfs-fe-row sep-t" id="jfs-fe-tbar">
        <span className="jfs-fe-title">{t('frameExport.title')}</span>
        <div className="jfs-fe-seg">
          <button className={`jfs-fe-seg-btn${exportType === 'animate' ? ' active' : ''}`} onClick={() => { sExportType.value = 'animate' }}>{t('grid.animate')}</button>
          <button className={`jfs-fe-seg-btn${exportType === 'stitch' ? ' active' : ''}`} onClick={() => { sExportType.value = 'stitch' }}>{t('grid.stitch')}</button>
        </div>
        <select id="jfs-fe-format" className="jfs-fe-sel" value={displayFormat} onChange={handleFormatChange}>
          {formatOpts.map(option => <option key={option} value={option}>{option.toUpperCase()}</option>)}
        </select>
        <select id="jfs-fe-sparse" className="jfs-fe-sel" title={t('grid.sparseTitle')} style={{ minWidth: '0' }} onChange={handleSparseChange}>
          <option value="0">{t('grid.sparse')}</option>
          <option value="1">全</option>
          <option value="2">½</option>
          <option value="3">⅓</option>
          <option value="4">¼</option>
        </select>
        <button id="jfs-fe-params-toggle" className="jfs-fe-btn g" onClick={() => { sParamsOpen.value = !sParamsOpen.value }}>
          {paramsOpen ? `${t('grid.params')} ▾` : `${t('grid.params')} ▴`}
        </button>
        <span className="jfs-fe-tbar-break" />
        <div className="jfs-fe-spacer" />
        <span className="jfs-fe-muted">
          {countLabel}
          <button className="jfs-fe-btn g" style={{ fontSize: '11px', padding: '2px 7px', marginLeft: '4px' }} onClick={handleSelectAll}>
            {allSel ? t('frameExport.deselectAll') : t('frameExport.selectAll')}
          </button>
          {removedCount > 0 && (
            <button className="jfs-fe-btn" style={{ fontSize: '11px', padding: '2px 7px', marginLeft: '4px', background: 'rgba(239,68,68,0.75)' }} onClick={handleRestore}>
              {t('grid.restore').replace('{n}', String(removedCount))}
            </button>
          )}
        </span>
        <button id="jfs-fe-prev" className="jfs-fe-btn" disabled={atStart} onClick={onExpandBack}>
          {atStart ? t('frameExport.atStart') : t('frameExport.loadPrev')}
        </button>
        <button id="jfs-fe-next" className="jfs-fe-btn" disabled={atEnd} onClick={onExpandForward}>
          {atEnd ? t('frameExport.atEnd') : t('frameExport.loadNext')}
        </button>
        <button id="jfs-fe-generate" className="jfs-fe-btn p" disabled={!canGenerate} onClick={onGenerate}>
          {exportType === 'animate' ? t('grid.generate.animate') : t('grid.generate.stitch')}
        </button>
        <button id="jfs-fe-close" className="jfs-fe-btn g" style={{ padding: '2px 8px', fontSize: '16px' }} onClick={onClose}>✕</button>
      </div>
    </div>
  )
}
