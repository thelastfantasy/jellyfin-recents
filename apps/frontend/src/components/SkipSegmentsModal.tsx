import React, { useEffect, useRef,useState } from 'react'
import { createPortal } from 'react-dom'
import { MdAdd, MdLanguage,MdRemove } from 'react-icons/md'

import type { SkipSegment } from '../api/posterSheetApi'
import { loadGlobalSkipSegments, saveGlobalSkipSegments } from '../api/posterSheetApi'
import { useLocale } from '../i18n/context'

interface ChapterInfo {
  startMs: number
  name: string
}

declare const window: Window & { ApiClient?: any }

async function fetchChapters(itemId: string, chapterWord: string): Promise<ChapterInfo[]> {
  const apiClient = window.ApiClient
  if (!apiClient) return []
  try {
    const userId = apiClient.getCurrentUserId()
    const url = apiClient.getUrl(`Items/${itemId}`, { Fields: 'Chapters', userId })
    const item: any = await apiClient.ajax({ type: 'GET', url, dataType: 'json' })
    const chapters: any[] = item.Chapters ?? []
    return chapters.map((ch: any, i: number) => ({
      startMs: Math.round((ch.StartPositionTicks ?? 0) / 10000),
      name: ch.Name || `${chapterWord} ${i + 1}`,
    }))
  } catch (e) {
    console.error('[JR] fetchChapters error:', e)
    return []
  }
}

function msToDisplay(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  const msv = ms % 1_000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msv).padStart(3, '0')}`
}

const OP_ED_RE = /\b(op|ed|opening|ending)\b/i
const MAX_SHORT_MS = 90_000

function guessOpEd(
  chapters: ChapterInfo[],
  videoDurationMs: number | undefined,
): Map<number, 'OP' | 'ED'> {
  const result = new Map<number, 'OP' | 'ED'>()
  if (chapters.length < 3) return result
  if (chapters.some(ch => OP_ED_RE.test(ch.name))) return result

  const lastStart = chapters[chapters.length - 1].startMs
  const total = videoDurationMs ?? lastStart * 1.1

  const dur = (i: number) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].startMs : (videoDurationMs ?? lastStart + 1)
    return end - chapters[i].startMs
  }
  const isShort = (i: number) => { const d = dur(i); return d > 0 && d <= MAX_SHORT_MS }

  // OP: scan first 3 chapters; if two consecutive short ones, first is recap → pick second
  for (let i = 0; i < Math.min(3, chapters.length - 1); i++) {
    if (isShort(i) && chapters[i].startMs < total / 3) {
      if (i === 0 && isShort(1) && chapters[1].startMs < total / 3) continue
      result.set(i, 'OP')
      break
    }
  }

  // ED: scan last 3 chapters from the end
  // If two consecutive short chapters at the end: last = next-ep preview → pick second-to-last as ED
  for (let i = chapters.length - 1; i >= Math.max(chapters.length - 3, 0); i--) {
    if (isShort(i) && chapters[i].startMs > total * 2 / 3) {
      if (i === chapters.length - 1 && i - 1 >= 0 && isShort(i - 1) && chapters[i - 1].startMs > total * 2 / 3) continue
      result.set(i, 'ED')
      break
    }
  }

  return result
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s}秒`
  if (s === 0) return `${m}分`
  return `${m}分${s}秒`
}

function formatHMS(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ── SegmentScrubber ──────────────────────────────────────────────────────────

interface ScrubberProps {
  startMs: number
  endMs: number
  maxMs: number
  onStartChange: (ms: number) => void
  onEndChange: (ms: number) => void
}

function SegmentScrubber({ startMs, endMs, maxMs, onStartChange, onEndChange }: ScrubberProps) {
  const barRef = useRef<HTMLDivElement>(null)

  function clampMs(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, Math.round(v)))
  }

  function handleThumbDown(which: 'start' | 'end', e: any) {
    e.preventDefault()
    e.stopPropagation()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)

    function msFromX(clientX: number): number {
      const bar = barRef.current
      if (!bar || maxMs <= 0) return which === 'start' ? startMs : endMs
      const rect = bar.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return Math.round(ratio * maxMs)
    }

    function onMove(me: PointerEvent) {
      const t = msFromX(me.clientX)
      if (which === 'start') onStartChange(clampMs(t, 0, endMs))
      else onEndChange(clampMs(t, startMs, maxMs))
    }

    target.addEventListener('pointermove', onMove as EventListener)
    target.addEventListener('pointerup', () => {
      target.removeEventListener('pointermove', onMove as EventListener)
    }, { once: true })
  }

  const startPct = maxMs > 0 ? (startMs / maxMs) * 100 : 0
  const endPct   = maxMs > 0 ? (endMs   / maxMs) * 100 : 100

  return (
    <div ref={barRef} className="jfs-segment-scrubber">
      <div className="jfs-segment-scrubber__track" />
      <div className="jfs-segment-scrubber__range"
        style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
      <div className="jfs-segment-scrubber__thumb"
        style={{ left: `${startPct}%` }}
        onPointerDown={(e: any) => handleThumbDown('start', e)} />
      <div className="jfs-segment-scrubber__thumb jfs-segment-scrubber__thumb--end"
        style={{ left: `${endPct}%` }}
        onPointerDown={(e: any) => handleThumbDown('end', e)} />
      <div className="jfs-segment-scrubber__labels">
        <span>{formatHMS(startMs)}</span>
        <span>{formatHMS(endMs)}</span>
      </div>
    </div>
  )
}

// ── TimeInput ────────────────────────────────────────────────────────────────

interface TimeInputProps {
  valueMs: number
  onChange: (ms: number) => void
}

export function TimeInput({ valueMs, onChange }: TimeInputProps) {
  const h   = Math.floor(valueMs / 3_600_000)
  const m   = Math.floor((valueMs % 3_600_000) / 60_000)
  const s   = Math.floor((valueMs % 60_000) / 1_000)
  const ms  = valueMs % 1_000

  function build(nh: number, nm: number, ns: number, nms: number) {
    const safe = (v: number, max: number) => Math.max(0, Math.min(max, isNaN(v) ? 0 : v))
    onChange(safe(nh, 99) * 3_600_000 + safe(nm, 59) * 60_000 + safe(ns, 59) * 1_000 + safe(nms, 999))
  }

  const n = (e: React.FormEvent<HTMLInputElement>) => +(e.target as HTMLInputElement).value
  const selectAll = (e: React.FocusEvent<HTMLInputElement>) => (e.target as HTMLInputElement).select()

  return (
    <span className="jfs-time-input">
      <input className="jfs-time-input__field jfs-time-input__field--2"
        type="number" min={0} max={99} value={h} title="小时 (0–99)"
        onFocus={selectAll} onInput={e => build(n(e), m, s, ms)} />
      <span className="jfs-time-input__sep">:</span>
      <input className="jfs-time-input__field jfs-time-input__field--2"
        type="number" min={0} max={59} value={m} title="分钟 (0–59)"
        onFocus={selectAll} onInput={e => build(h, n(e), s, ms)} />
      <span className="jfs-time-input__sep">:</span>
      <input className="jfs-time-input__field jfs-time-input__field--2"
        type="number" min={0} max={59} value={s} title="秒 (0–59)"
        onFocus={selectAll} onInput={e => build(h, m, n(e), ms)} />
      <span className="jfs-time-input__sep">.</span>
      <input className="jfs-time-input__field jfs-time-input__field--3"
        type="number" min={0} max={999} value={ms} title="毫秒 (0–999)"
        onFocus={selectAll} onInput={e => build(h, m, s, n(e))} />
    </span>
  )
}

// ── SkipSegmentsModal ────────────────────────────────────────────────────────

interface Props {
  onClose: () => void
  onConfirm?: (segments: SkipSegment[], ignoreGlobal: boolean) => void
  itemId?: string
  videoDurationMs?: number
}

export function SkipSegmentsModal({ onClose, onConfirm, itemId, videoDurationMs }: Props) {
  const { t } = useLocale()
  const [tab, setTab] = useState<'chapters' | 'segments'>('segments')
  const [chapters, setChapters] = useState<ChapterInfo[]>([])
  const [chaptersLoading, setChaptersLoading] = useState(false)
  const [segments, setSegments] = useState<SkipSegment[]>([])
  const [globalSkipsLocal, setGlobalSkipsLocal] = useState<SkipSegment[]>(() => loadGlobalSkipSegments())
  const hasGlobalSkips = globalSkipsLocal.some(s => s.endMs > s.startMs)
  const [ignoreGlobal, setIgnoreGlobal] = useState(false)
  const [fullTooltipPos, setFullTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const fullTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!itemId) return
    setChaptersLoading(true)
    fetchChapters(itemId, t.chapterFallback).then(chaps => {
      setChapters(chaps)
      if (chaps.length > 0) setTab('chapters')
      setChaptersLoading(false)
    })
  }, [itemId])

  function chapterEndMs(idx: number): number {
    return idx + 1 < chapters.length
      ? chapters[idx + 1].startMs
      : (videoDurationMs ?? chapters[idx].startMs + 1)
  }

  function isChapterSkipped(idx: number): boolean {
    const startMs = chapters[idx].startMs
    const endMs   = chapterEndMs(idx)
    return segments.some(seg => seg.startMs <= startMs && seg.endMs >= endMs)
  }

  function toggleChapter(idx: number) {
    const startMs = chapters[idx].startMs
    const endMs   = chapterEndMs(idx)
    if (isChapterSkipped(idx)) {
      setSegments(prev => prev.filter(seg => !(seg.startMs === startMs && seg.endMs === endMs)))
    } else {
      setSegments(prev => [...prev, { startMs, endMs }])
    }
  }

  function addSegment() {
    setSegments(prev => [...prev, { startMs: 0, endMs: 0 }])
  }

  function addQuickStart(ms: number) {
    setSegments(prev => [{ startMs: 0, endMs: ms }, ...prev])
  }

  function addQuickEnd(ms: number) {
    if (videoDurationMs == null || videoDurationMs <= 0) return
    setSegments(prev => [...prev, { startMs: Math.max(0, videoDurationMs - ms), endMs: videoDurationMs }])
  }

  function updateSegment(idx: number, patch: Partial<SkipSegment>) {
    setSegments(prev => prev.map((seg, i) => i === idx ? { ...seg, ...patch } : seg))
  }

  function removeSegment(idx: number) {
    setSegments(prev => prev.filter((_, i) => i !== idx))
  }

  function handleConfirm() {
    const valid = segments.filter(s => s.endMs > s.startMs)
    onConfirm?.(valid, ignoreGlobal)
    onClose()
  }

  function handleClear() {
    setSegments([])
  }

  function handleAddToGlobal(seg: SkipSegment, btn: HTMLButtonElement) {
    if (globalSkipsLocal.length >= 2) {
      if (fullTooltipTimerRef.current) clearTimeout(fullTooltipTimerRef.current)
      const rect = btn.getBoundingClientRect()
      setFullTooltipPos({ x: rect.left + rect.width / 2, y: rect.top })
      fullTooltipTimerRef.current = setTimeout(() => setFullTooltipPos(null), 2500)
      return
    }
    const next = [...globalSkipsLocal, { startMs: seg.startMs, endMs: seg.endMs }]
    saveGlobalSkipSegments(next)
    setGlobalSkipsLocal(next)
  }

  const showChaptersTab = itemId != null && (chaptersLoading || chapters.length > 0)

  const modal = createPortal(
    <div className="jfs-skip-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="jfs-skip-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="jfs-poster-settings-modal__header">
          <span>
            {t.skipSettings}
            {videoDurationMs != null && (
              <span className="jfs-skip-header-duration">{t.skipDuration} {formatHMS(videoDurationMs)}</span>
            )}
          </span>
          <button className="jfs-poster-settings-modal__close" onClick={onClose}>✕</button>
        </div>

        {/* Tab strip */}
        {showChaptersTab && (
          <div className="jfs-skip-tabs">
            <button
              className={`jfs-skip-tab${tab === 'chapters' ? ' jfs-skip-tab--active' : ''}`}
              onClick={() => setTab('chapters')}
            >{t.skipByChapter}</button>
            <button
              className={`jfs-skip-tab${tab === 'segments' ? ' jfs-skip-tab--active' : ''}`}
              onClick={() => setTab('segments')}
            >{t.skipBySegment}</button>
          </div>
        )}

        {/* Body */}
        <div className="jfs-skip-body">

          {/* Chapters tab */}
          {tab === 'chapters' && (
            <div className="jfs-skip-chapter-list">
              {chaptersLoading && (
                <div className="jfs-skip-placeholder">{t.skipChaptersLoading}</div>
              )}
              {!chaptersLoading && (() => {
                const guesses = guessOpEd(chapters, videoDurationMs)
                return chapters.map((ch, idx) => {
                  const guess = guesses.get(idx)
                  return (
                    <button
                      key={idx}
                      className={`jfs-skip-chapter-item${isChapterSkipped(idx) ? ' jfs-skip-chapter-item--active' : ''}`}
                      onClick={(e) => { toggleChapter(idx); (e.currentTarget as HTMLButtonElement).blur(); }}
                    >
                      <span className="jfs-skip-chapter-name">
                        {ch.name}
                        {guess && (
                          <span className="jfs-skip-chapter-guess">
                            {' '}({guess === 'OP' ? t.guessOp : t.guessEd})
                          </span>
                        )}
                      </span>
                      <span className="jfs-skip-chapter-time">{msToDisplay(ch.startMs)}</span>
                      <span className="jfs-skip-chapter-duration">{formatDuration(chapterEndMs(idx) - ch.startMs)}</span>
                    </button>
                  )
                })
              })()}
            </div>
          )}

          {/* Segments tab */}
          {tab === 'segments' && (
            <div className="jfs-skip-segment-list">
              <div className="jfs-skip-hint">
                {t.skipTimeFormat}
              </div>
              <div className="jfs-skip-quick-btns">
                <button className="jfs-skip-quick-btn jfs-skip-quick-btn--start" onClick={() => addQuickStart(60_000)}>{t.skipQuickStart60}</button>
                <button className="jfs-skip-quick-btn jfs-skip-quick-btn--start" onClick={() => addQuickStart(90_000)}>{t.skipQuickStart90}</button>
                <button className="jfs-skip-quick-btn jfs-skip-quick-btn--end" disabled={videoDurationMs == null} onClick={() => addQuickEnd(60_000)}>{t.skipQuickEnd60}</button>
                <button className="jfs-skip-quick-btn jfs-skip-quick-btn--end" disabled={videoDurationMs == null} onClick={() => addQuickEnd(90_000)}>{t.skipQuickEnd90}</button>
              </div>
              {segments.length === 0 && (
                <div className="jfs-skip-placeholder">{t.skipEmpty}</div>
              )}
              {segments.map((seg, idx) => {
                const segValid = seg.endMs > seg.startMs
                return (
                  <div key={idx} className="jfs-skip-segment-row">
                    <div className="jfs-skip-segment-row__controls">
                      <TimeInput valueMs={seg.startMs} onChange={v => updateSegment(idx, { startMs: v })} />
                      <span className="jfs-skip-segment-dash">—</span>
                      <TimeInput valueMs={seg.endMs} onChange={v => updateSegment(idx, { endMs: v })} />
                      <button className="jfs-skip-segment-remove" onClick={() => removeSegment(idx)} title={t.skipRemove}>
                        <MdRemove size={15} />
                      </button>
                      <button
                        className="jfs-skip-segment-add-global"
                        disabled={!segValid}
                        title={t.skipAddToGlobal}
                        onClick={e => handleAddToGlobal(seg, e.currentTarget as HTMLButtonElement)}
                      >
                        <MdLanguage size={15} />
                      </button>
                      {segValid && (
                        <span className="jfs-skip-segment-span">
                          {t.skipSegmentSpan} {formatDuration(seg.endMs - seg.startMs)}
                        </span>
                      )}
                    </div>
                    {videoDurationMs != null && videoDurationMs > 0 && (
                      <SegmentScrubber
                        startMs={seg.startMs}
                        endMs={seg.endMs}
                        maxMs={videoDurationMs}
                        onStartChange={v => updateSegment(idx, { startMs: v })}
                        onEndChange={v => updateSegment(idx, { endMs: v })}
                      />
                    )}
                  </div>
                )
              })}
              <button className="jfs-skip-segment-add" onClick={addSegment}>
                <MdAdd size={15} />
                {t.skipAddSegment}
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="jfs-skip-footer">
          {/* Global skip intervals — shown for awareness / quick deletion */}
          {globalSkipsLocal.some(s => s.endMs > s.startMs) && (
            <div className="jfs-skip-global-display">
              <span className="jfs-skip-global-display__title">{t.posterGlobalSkip}</span>
              {globalSkipsLocal.map((seg, idx) => seg.endMs > seg.startMs ? (
                <div key={idx} className="jfs-skip-global-display__row">
                  <span className="jfs-skip-global-display__range">
                    {msToDisplay(seg.startMs)}&nbsp;—&nbsp;{msToDisplay(seg.endMs)}
                  </span>
                  <button
                    className="jfs-skip-global-display__del"
                    title={t.skipRemove}
                    onClick={() => {
                      const next = globalSkipsLocal.filter((_, i) => i !== idx)
                      saveGlobalSkipSegments(next)
                      setGlobalSkipsLocal(next)
                    }}
                  >
                    <MdRemove size={13} />
                  </button>
                </div>
              ) : null)}
            </div>
          )}
          <label className={`jfs-skip-footer__ignore-label${!hasGlobalSkips ? ' jfs-skip-footer__ignore-label--disabled' : ''}`}>
            <input
              type="checkbox"
              checked={ignoreGlobal}
              disabled={!hasGlobalSkips}
              onChange={e => setIgnoreGlobal((e.target as HTMLInputElement).checked)}
            />
            {t.skipIgnoreGlobal}
          </label>
          <div className="jfs-skip-footer__actions">
            <button className="jfs-skip-footer__clear" onClick={handleClear}>{t.skipClearAll}</button>
            <span style={{ flex: 1 }} />
            <button className="jfs-skip-footer__cancel" onClick={onClose}>{t.cancel}</button>
            <button className="jfs-skip-footer__confirm" onClick={handleConfirm}>{t.posterGenerate}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )

  return (
    <>
      {modal}
      {fullTooltipPos && createPortal(
        <div
          className="jfs-skip-full-tooltip"
          style={{ left: fullTooltipPos.x, top: fullTooltipPos.y }}
        >
          {t.skipGlobalFull}
        </div>,
        document.body
      )}
    </>
  )
}
