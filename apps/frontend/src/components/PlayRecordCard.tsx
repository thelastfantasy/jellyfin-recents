import { useState, useEffect, useRef } from 'preact/hooks'
import { MdPlayArrow, MdReplay, MdFavorite, MdFavoriteBorder, MdGridView, MdKeyboardArrowDown, MdContentCut } from 'react-icons/md'
import type { PlayRecord, ViewMode } from '../types'
import { getCurrentUserId } from '../api/jellyfinClient'
import { formatPlayedDate } from '../i18n'
import { useLocale } from '../i18n/context'
import { FolderViewPopover } from './FolderViewPopover'
import { Popover } from './Popover'
import { startJob, loadStartJobRequest, loadGlobalSkipSegments, mergeSegments } from '../api/posterSheetApi'
import type { SkipSegment } from '../api/posterSheetApi'
import { addJob, updateJob, getJobs } from '../state/posterJobStore'
import { flyToQueue } from '../utils/flyToQueue'
import { SkipSegmentsModal } from './SkipSegmentsModal'

interface Props {
  record: PlayRecord
  showTypeLabel?: boolean
  viewMode?: ViewMode
  enableFolderView?: boolean
  posterUnlocked?: boolean
}

// Jellyfin 10.10.x 用 webpack 5 打包，playbackManager 不再全局暴露。
// __webpack_require__ 和 playbackManager 都缓存到 window，跨 IIFE 重新执行时复用。
let _playbackManager: any = null

function getWebpackRequire(): any {
  const w = window as any
  if (w.__jfs_wr) return w.__jfs_wr
  const wc = w.webpackChunk as any[][]
  if (!wc) return null
  let wr: any = null
  const orig = wc.push.bind(wc)
  // 用时间戳保证 chunk ID 唯一，避免重复注册被忽略
  orig([[`jfs-wr-${Date.now()}`], {}, (__webpack_require__: any) => { wr = __webpack_require__ }])
  if (!wr) return null
  w.__jfs_wr = wr
  return wr
}

function getPlaybackManager(): any {
  if (_playbackManager) return _playbackManager
  const w = window as any
  if (w.__jfs_pm) { _playbackManager = w.__jfs_pm; return _playbackManager }
  const wr = getWebpackRequire()
  if (!wr) return null
  // 搜索所有已加载模块，找有 play/pause/isPlaying 的对象（playbackManager 特征）
  for (const id of Object.keys(wr.m)) {
    try {
      const mod = wr(id)
      if (!mod || typeof mod !== 'object') continue
      for (const exp of [mod, mod.default, ...Object.values(mod)]) {
        if (exp && typeof exp === 'object'
          && typeof (exp as any).play === 'function'
          && typeof (exp as any).pause === 'function'
          && typeof (exp as any).isPlaying === 'function') {
          _playbackManager = exp
          w.__jfs_pm = exp
          return _playbackManager
        }
      }
    } catch { /* 跳过加载失败的模块 */ }
  }
  return null
}

function playItem(itemId: string, startPositionTicks = 0): void {
  const pm = getPlaybackManager()
  if (!pm) { console.error('[JellyfinSuite] playbackManager not found'); return }
  const apiClient = window.ApiClient
  if (!apiClient) return
  const userId = getCurrentUserId()
  apiClient.getItem(userId, itemId).then((item: any) => {
    pm.play({ items: [item], startPositionTicks, serverId: apiClient.serverId() })
  })
}

async function apiToggleFavorite(itemId: string, nowFavorite: boolean): Promise<void> {
  const userId = getCurrentUserId()
  if (!window.ApiClient) throw new Error('ApiClient unavailable')
  const url = window.ApiClient.getUrl(`Users/${userId}/FavoriteItems/${itemId}`)
  await window.ApiClient.ajax({ url, type: nowFavorite ? 'POST' : 'DELETE' })
}

// ── Poster button: hover-reveal pattern (thumbnail / poster view) ──────────

interface PosterBtnHoverProps {
  record: PlayRecord
  enableFolderView: boolean
  thumbRef: { current: Element | null }
}

function PosterBtnHover({ record, enableFolderView, thumbRef }: PosterBtnHoverProps) {
  const { t } = useLocale()
  const [skipOpen, setSkipOpen] = useState(false)
  const [touchSheetOpen, setTouchSheetOpen] = useState(false)
  const [sheetPos, setSheetPos] = useState<{ top: number; left: number } | null>(null)
  const off = enableFolderView && record.hasAncestors

  function handlePosterClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (thumbRef.current) flyToQueue(thumbRef.current)
    const title = record.seriesName ? `${record.seriesName} — ${record.title}` : record.title
    const req = loadStartJobRequest()
    const globalSkips = loadGlobalSkipSegments().filter(s => s.endMs > s.startMs)
    if (globalSkips.length > 0) req.skipSegments = globalSkips
    startJob(record.itemId, req).then(id => {
      if (!getJobs().find(j => j.jobId === id)) addJob(id, record.itemId, title)
    }).catch((err: unknown) => {
      const errId = `err-${Date.now()}`
      addJob(errId, record.itemId, title)
      updateJob(errId, { status: 'error', error: err instanceof Error ? err.message : 'Failed to start job' })
    })
  }

  function handleSkipClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setSkipOpen(true)
  }

  function openTouchSheet(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const btn = e.currentTarget as HTMLButtonElement
    const rect = btn.getBoundingClientRect()
    const SHEET_W = 148
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - SHEET_W - 4))
    setSheetPos({ top: rect.bottom + 4, left })
    setTouchSheetOpen(o => !o)
  }

  function handleSkipAndGenerate(segments: SkipSegment[], ignoreGlobal: boolean) {
    if (thumbRef.current) flyToQueue(thumbRef.current)
    const title = record.seriesName ? `${record.seriesName} — ${record.title}` : record.title
    const req = loadStartJobRequest()
    const globalSkips = ignoreGlobal ? [] : loadGlobalSkipSegments()
    const merged = mergeSegments(globalSkips, segments)
    if (merged.length > 0) req.skipSegments = merged
    startJob(record.itemId, req).then(id => {
      if (!getJobs().find(j => j.jobId === id)) addJob(id, record.itemId, title)
    }).catch((err: unknown) => {
      const errId = `err-${Date.now()}`
      addJob(errId, record.itemId, title)
      updateJob(errId, { status: 'error', error: err instanceof Error ? err.message : 'Failed to start job' })
    })
  }

  return (
    <>
      <button
        class={`jfs-card__poster-btn${off ? ' jfs-card__poster-btn--offset' : ''}`}
        title={t.posterGenerate2}
        onClick={handlePosterClick}
      >
        <MdGridView size={16} />
      </button>
      <button
        class={`jfs-card__poster-skip-btn${off ? ' jfs-card__poster-skip-btn--offset' : ''}`}
        title={t.skipAndGenerate}
        onClick={handleSkipClick}
      >
        <MdKeyboardArrowDown size={14} />
        <span class="jfs-card__poster-skip-label">{t.skipSegments}</span>
      </button>
      <button
        class={`jfs-card__poster-touch-btn${off ? ' jfs-card__poster-touch-btn--offset' : ''}`}
        onClick={openTouchSheet}
      >
        <MdGridView size={16} />
      </button>
      {touchSheetOpen && sheetPos && (
        <Popover open={true} onClose={() => setTouchSheetOpen(false)}>
          <div class="jfs-card__touch-sheet" style={{ position: 'fixed', top: `${sheetPos.top}px`, left: `${sheetPos.left}px` }}>
            <button onClick={e => { e.stopPropagation(); handlePosterClick(e as any); setTouchSheetOpen(false) }}>
              <MdGridView size={14} />
              {t.generateNow}
            </button>
            <button onClick={e => { e.stopPropagation(); handleSkipClick(e as any); setTouchSheetOpen(false) }}>
              <MdContentCut size={14} />
              {t.skipSettings}
            </button>
          </div>
        </Popover>
      )}
      {skipOpen && (
        <SkipSegmentsModal
          onClose={() => setSkipOpen(false)}
          onConfirm={handleSkipAndGenerate}
          itemId={record.itemId}
          videoDurationMs={record.videoDuration !== null ? Math.round(record.videoDuration * 1000) : undefined}
        />
      )}
    </>
  )
}

// ── Poster button: menu pattern (list view) ───────────────────────────────

interface PosterBtnMenuProps {
  record: PlayRecord
  thumbRef: { current: Element | null }
}

function PosterBtnMenu({ record, thumbRef }: PosterBtnMenuProps) {
  const { t } = useLocale()
  const [skipOpen, setSkipOpen] = useState(false)
  const [touchSheetOpen, setTouchSheetOpen] = useState(false)
  const [sheetPos, setSheetPos] = useState<{ top: number; left: number } | null>(null)

  function openTouchSheet(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const btn = e.currentTarget as HTMLButtonElement
    const rect = btn.getBoundingClientRect()
    const SHEET_W = 148
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - SHEET_W - 4))
    setSheetPos({ top: rect.bottom + 4, left })
    setTouchSheetOpen(o => !o)
  }

  function handlePosterClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (thumbRef.current) flyToQueue(thumbRef.current)
    const title = record.seriesName ? `${record.seriesName} — ${record.title}` : record.title
    const req = loadStartJobRequest()
    const globalSkips = loadGlobalSkipSegments().filter(s => s.endMs > s.startMs)
    if (globalSkips.length > 0) req.skipSegments = globalSkips
    startJob(record.itemId, req).then(id => {
      if (!getJobs().find(j => j.jobId === id)) addJob(id, record.itemId, title)
    }).catch((err: unknown) => {
      const errId = `err-${Date.now()}`
      addJob(errId, record.itemId, title)
      updateJob(errId, { status: 'error', error: err instanceof Error ? err.message : 'Failed to start job' })
    })
  }

  function handleSkipClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setSkipOpen(true)
  }

  function handleSkipAndGenerate(segments: SkipSegment[], ignoreGlobal: boolean) {
    if (thumbRef.current) flyToQueue(thumbRef.current)
    const title = record.seriesName ? `${record.seriesName} — ${record.title}` : record.title
    const req = loadStartJobRequest()
    const globalSkips = ignoreGlobal ? [] : loadGlobalSkipSegments()
    const merged = mergeSegments(globalSkips, segments)
    if (merged.length > 0) req.skipSegments = merged
    startJob(record.itemId, req).then(id => {
      if (!getJobs().find(j => j.jobId === id)) addJob(id, record.itemId, title)
    }).catch((err: unknown) => {
      const errId = `err-${Date.now()}`
      addJob(errId, record.itemId, title)
      updateJob(errId, { status: 'error', error: err instanceof Error ? err.message : 'Failed to start job' })
    })
  }

  return (
    <>
      <button
        class="jfs-card__list-poster-btn"
        title={t.posterGenerate2}
        onClick={openTouchSheet}
      >
        <MdGridView size={16} />
      </button>
      {touchSheetOpen && sheetPos && (
        <Popover open={true} onClose={() => setTouchSheetOpen(false)}>
          <div class="jfs-card__touch-sheet" style={{ position: 'fixed', top: `${sheetPos.top}px`, left: `${sheetPos.left}px` }}>
            <button onClick={e => { e.stopPropagation(); handlePosterClick(e as any); setTouchSheetOpen(false) }}>
              <MdGridView size={14} />
              {t.generateNow}
            </button>
            <button onClick={e => { e.stopPropagation(); handleSkipClick(e as any); setTouchSheetOpen(false) }}>
              <MdContentCut size={14} />
              {t.skipSettings}
            </button>
          </div>
        </Popover>
      )}
      {skipOpen && (
        <SkipSegmentsModal
          onClose={() => setSkipOpen(false)}
          onConfirm={handleSkipAndGenerate}
          itemId={record.itemId}
          videoDurationMs={record.videoDuration !== null ? Math.round(record.videoDuration * 1000) : undefined}
        />
      )}
    </>
  )
}

// ── Main component ────────────────────────────────────────────────────────

export function PlayRecordCard({ record, showTypeLabel = false, viewMode = 'thumbnail', enableFolderView = false, posterUnlocked = false }: Props) {
  const { locale, t } = useLocale()
  const [isFav, setIsFav] = useState(record.favoritedAt !== null)
  const [favLoading, setFavLoading] = useState(false)
  const canResume = record.playbackPositionTicks != null && record.playbackPositionTicks > 0
  const resumeTicks = record.playbackPositionTicks ?? 0
  const thumbRef = useRef<Element>(null)

  useEffect(() => {
    function handler(e: CustomEvent<{ itemId: string; favoritedAt: string | null }>) {
      if (e.detail.itemId === record.itemId) {
        setIsFav(e.detail.favoritedAt !== null)
      }
    }
    window.addEventListener('jfs-fav-change', handler as EventListener)
    return () => window.removeEventListener('jfs-fav-change', handler as EventListener)
  }, [record.itemId])

  const imageUrl = record.imagePrimaryTag
    ? `/Items/${record.itemId}/Images/Primary?fillWidth=320&quality=90&tag=${record.imagePrimaryTag}`
    : `/Items/${record.itemId}/Images/Primary?fillWidth=320&quality=90`
  const detailUrl = `#!/details?id=${record.itemId}`
  const seriesUrl = record.seriesId ? `#!/details?id=${record.seriesId}` : null

  function handlePlayClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    playItem(record.itemId)
  }

  function handleResumeClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    playItem(record.itemId, resumeTicks)
  }

  async function handleFavClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (favLoading) return
    const next = !isFav
    const now = next ? new Date().toISOString() : null
    setIsFav(next)
    setFavLoading(true)
    try {
      await apiToggleFavorite(record.itemId, next)
      window.dispatchEvent(new CustomEvent('jfs-fav-change', { detail: { itemId: record.itemId, favoritedAt: now } }))
    } catch {
      setIsFav(!next)
      window.dispatchEvent(new CustomEvent('jfs-fav-change', { detail: { itemId: record.itemId, favoritedAt: record.favoritedAt?.toISOString() ?? null } }))
    } finally {
      setFavLoading(false)
    }
  }

  const episodeCode = record.episodeNumber != null
    ? record.seasonNumber === 0
      ? `SP${record.episodeNumber}`
      : `S${record.seasonNumber ?? 1}E${record.episodeNumber}`
    : null

  if (viewMode === 'list') {
    return (
      <div class="jfs-card jfs-card--list" data-jfs-id={`${record.itemId}-${record.playedDate.getTime()}`}>
        <a class="jfs-card__thumb jfs-card__thumb--list" href={detailUrl} ref={thumbRef as any}>
          <img
            src={imageUrl}
            alt={record.title}
            loading="lazy"
            onError={(e) => {
              const img = e.currentTarget as HTMLImageElement
              img.style.display = 'none'
              img.nextElementSibling?.classList.remove('jfs-card__thumb-placeholder--hidden')
            }}
          />
          <div class="jfs-card__thumb-placeholder jfs-card__thumb-placeholder--hidden">🎬</div>
        </a>
        <div class="jfs-card__info jfs-card__info--list">
          <div class="jfs-card__title-block">
            {record.seriesName && (
              seriesUrl
                ? <a class="jfs-card__series-name" href={seriesUrl}>{record.seriesName}</a>
                : <div class="jfs-card__series-name">{record.seriesName}</div>
            )}
            <a class="jfs-card__title" href={detailUrl} title={record.title}>
              {episodeCode && <span class="jfs-card__ep-code">{episodeCode}</span>}
              {record.title}
            </a>
            <span class="jfs-card__played-date">{formatPlayedDate(record.playedDate, locale)}</span>
          </div>
        </div>
        <div class="jfs-card__meta jfs-card__meta--list">
          {showTypeLabel && (
            <span class={`jfs-card__type-badge jfs-card__type-badge--${record.mediaType}`}>
              {record.mediaType === 'video' ? t.video : t.audio}
            </span>
          )}
          {canResume && (
            <>
              <button class="jfs-card__resume-btn jfs-card__resume-btn--sm" onClick={handleResumeClick} title={t.resume}>
                <MdPlayArrow size={16} />
              </button>
              <button class="jfs-card__fromstart-btn" onClick={handlePlayClick} title={t.play}>
                <MdReplay size={18} />
              </button>
            </>
          )}
          {posterUnlocked && record.videoDuration !== null && (
            <PosterBtnMenu record={record} thumbRef={thumbRef} />
          )}
          <button
            class={`jfs-card__fav-btn${isFav ? ' jfs-card__fav-btn--active' : ''}`}
            onClick={handleFavClick}
            title={isFav ? t.unfavorite : t.favorite}
          >
            {isFav ? <MdFavorite size={22} /> : <MdFavoriteBorder size={22} />}
          </button>
          {enableFolderView && record.hasAncestors && (
            <FolderViewPopover itemId={record.itemId} viewMode="list" />
          )}
        </div>
      </div>
    )
  }

  return (
    <div class="jfs-card" data-jfs-id={`${record.itemId}-${record.playedDate.getTime()}`}>
      <div class="jfs-card__thumb-link-wrap">
        <a class="jfs-card__thumb-link" href={detailUrl}>
          <div class="jfs-card__thumb" ref={thumbRef as any}>
            <img
              src={imageUrl}
              alt={record.title}
              loading="lazy"
              onError={(e) => {
                const img = e.currentTarget as HTMLImageElement
                img.style.display = 'none'
                img.nextElementSibling?.classList.remove('jfs-card__thumb-placeholder--hidden')
              }}
            />
            <div class="jfs-card__thumb-placeholder jfs-card__thumb-placeholder--hidden">🎬</div>
            {episodeCode && (
              <div class="jfs-card__ep-badge">{episodeCode}</div>
            )}
            {showTypeLabel && (
              <span class={`jfs-card__type-badge jfs-card__type-badge--${record.mediaType}`}>
                {record.mediaType === 'video' ? t.video : t.audio}
              </span>
            )}
            <div class="jfs-card__overlay">
              {canResume ? (
                <div class="jfs-card__overlay-center">
                  <button class="jfs-card__resume-btn" onClick={handleResumeClick} title={t.resume}>
                    <MdPlayArrow size={28} />
                  </button>
                  <button class="jfs-card__play-btn jfs-card__play-btn--small" onClick={handlePlayClick} title={t.play}>
                    <MdReplay size={15} />
                  </button>
                </div>
              ) : (
                <button class="jfs-card__play-btn" onClick={handlePlayClick} title={t.play}>
                  <MdPlayArrow size={28} />
                </button>
              )}
            </div>
            {isFav && (
              <div class="jfs-card__actions jfs-card__actions--sticky">
                <button
                  class="jfs-card__fav-btn jfs-card__fav-btn--active"
                  onClick={handleFavClick}
                  title={t.unfavorite}
                >
                  <MdFavorite size={22} />
                </button>
              </div>
            )}
            <div class="jfs-card__overlay jfs-card__overlay--actions">
              <div class="jfs-card__actions">
                <button
                  class={`jfs-card__fav-btn${isFav ? ' jfs-card__fav-btn--active' : ''}`}
                  onClick={handleFavClick}
                  title={isFav ? t.unfavorite : t.favorite}
                >
                  {isFav ? <MdFavorite size={22} /> : <MdFavoriteBorder size={22} />}
                </button>
              </div>
            </div>
          </div>
        </a>
        {enableFolderView && record.hasAncestors && (
          <FolderViewPopover itemId={record.itemId} showTypeLabel={showTypeLabel} />
        )}
        {posterUnlocked && record.videoDuration !== null && (
          <PosterBtnHover record={record} enableFolderView={enableFolderView} thumbRef={thumbRef} />
        )}
      </div>
      <div class="jfs-card__info">
        {record.seriesName && (
          seriesUrl
            ? <a class="jfs-card__series-name" href={seriesUrl}>{record.seriesName}</a>
            : <div class="jfs-card__series-name">{record.seriesName}</div>
        )}
        <a class="jfs-card__title" href={detailUrl} title={record.title}>{record.title}</a>
        <div class="jfs-card__played-date">{formatPlayedDate(record.playedDate, locale)}</div>
      </div>
    </div>
  )
}
