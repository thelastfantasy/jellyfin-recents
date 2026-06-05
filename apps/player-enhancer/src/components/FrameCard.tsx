import { useAtomValue } from 'jotai'
import { useEffect, useRef } from 'react'

import type { FrameEntry } from '../core/state'
import { _itemId, prefetchDoneAtom,prefetchTotalAtom } from '../core/state'
import { bench } from '../lib/bench'
import { t } from '../lib/i18n'
import { formatTime } from '../lib/utils'

const ICON_VIEW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>
</svg>`
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
</svg>`
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`

export interface FrameCardProps {
  frame: FrameEntry
  idx: number
  pressing?: boolean
  onMouseDown: (idx: number, e: MouseEvent) => void
  onView:      (idx: number) => void
  onDownload:  (idx: number) => void
  onRemove:    (idx: number) => void
  onRetry:     (idx: number) => void
  onToggle:    (idx: number, checked: boolean) => void
  onLoadError: (idx: number) => void
}

export function FrameCard({
  frame, idx, pressing,
  onMouseDown, onView, onDownload, onRemove, onRetry, onToggle, onLoadError,
}: FrameCardProps) {
  const prefTotal = useAtomValue(prefetchTotalAtom)
  const prefDone  = useAtomValue(prefetchDoneAtom)

  const srcLoggedRef = useRef(false)
  useEffect(() => {
    if (frame.jpegUrl && !srcLoggedRef.current) {
      srcLoggedRef.current = true
      bench.mark('img_src_set', { idx, posMs: frame.posMs })
    }
  }, [frame.jpegUrl])
  const prefetchPct = prefTotal > 0
    ? prefDone / prefTotal * 100
    : 100

  const imgContent = frame.loadError
    ? (
      <div className="jfs-fe-err-ph">
        <span>{t('frameExport.loadError')}</span>
        <button className="jfs-fe-retry-btn" onClick={e => { e.stopPropagation(); onRetry(idx) }}>
          {t('frameExport.retry')}
        </button>
      </div>
    )
    : frame.jpegUrl
      ? (
        <img
          src={frame.jpegUrl}
          alt={formatTime(frame.posMs)}
          onError={() => onLoadError(idx)}
          onLoad={() => bench.mark('img_loaded', { idx, posMs: frame.posMs })}
        />
      )
      : <div className="jfs-fe-loading"><div className="jfs-fe-load-bar" style={{ width: `${prefetchPct}%` }} /></div>

  const displayMs = frame.actualPtsMs ?? frame.posMs

  return (
    <div
      className={`jfs-fe-card${frame.selected ? ' sel' : ''}${frame.isJunk ? ' junk' : ''}${pressing ? ' jfs-pressing' : ''}`}
      data-idx={String(idx)}
      style={{ cursor: 'pointer' }}
      onMouseDown={e => onMouseDown(idx, e.nativeEvent)}
    >
      {frame.isJunk && <span className="jfs-fe-badge">{frame.junkReason || t('frameExport.junk')}</span>}
      {imgContent}
      <div className="jfs-fe-card-acts" onTouchStart={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
        <button
          className="jfs-fe-card-act jfs-fe-view-btn"
          title={t('card.view')}
          dangerouslySetInnerHTML={{ __html: ICON_VIEW }}
          onClick={e => { e.stopPropagation(); onView(idx) }}
        />
        <button
          className="jfs-fe-card-act jfs-fe-dl-btn"
          title={t('card.download')}
          dangerouslySetInnerHTML={{ __html: ICON_DOWNLOAD }}
          onClick={e => { e.stopPropagation(); onDownload(idx) }}
        />
        <button
          className="jfs-fe-card-act jfs-fe-rm-btn"
          title={t('card.remove')}
          dangerouslySetInnerHTML={{ __html: ICON_TRASH }}
          onClick={e => { e.stopPropagation(); onRemove(idx) }}
        />
      </div>
      <div className="jfs-fe-card-foot">
        <input
          type="checkbox"
          checked={frame.selected}
          className="jfs-fe-cb"
          style={{ cursor: 'pointer' }}
          onTouchStart={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
          onChange={e => { e.stopPropagation(); onToggle(idx, (e.target as HTMLInputElement).checked) }}
        />
        {formatTime(displayMs)}
        {frame.fiIdx >= 0 && <span className="jfs-fe-frnum">#{frame.fiIdx}</span>}
      </div>
    </div>
  )
}
