import { useEffect, useState, useRef } from 'preact/hooks'
import type { TimeGroup, ViewSettings } from '../types'
import type { Locale } from '../i18n'
import { getTranslations } from '../i18n'
import { LocaleContext } from '../i18n/context'
import { getHistoryPlayed } from '../api/historyApi'
import { getFolderViewEnabled } from '../api/foldersApi'
import { groupByMode } from '../grouping/groupBy'
import { sortRecords } from '../sorting/sortBy'
import { loadSettings, saveSettings } from '../state/viewSettings'
import { isPosterUnlocked } from '../state/posterSheetUnlock'
import { Toolbar } from './Toolbar'
import { GroupSection } from './GroupSection'
import { Pagination } from './Pagination'
import { DEFAULTS } from './SettingsPopover'
import { PosterQueueWidget } from './PosterQueueWidget'
import { FrameExportQueueWidget } from './FrameExportQueueWidget'

// 注入 scrollbar-gutter: stable 到 html
if (typeof document !== 'undefined' && !document.getElementById('jfs-scrollbar-gutter')) {
  const s = document.createElement('style')
  s.id = 'jfs-scrollbar-gutter'
  s.textContent = 'html { scrollbar-gutter: stable; }'
  document.head.appendChild(s)
}

interface Props {
  locale: Locale
}

function getTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function App({ locale }: Props) {
  const t = getTranslations(locale)

  const [settings, setSettings] = useState<ViewSettings>(loadSettings)
  const [pageIndex, setPageIndex] = useState(0)
  const [groups, setGroups] = useState<TimeGroup[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enableFolderView, setEnableFolderView] = useState(false)
  const [posterUnlocked, setPosterUnlocked] = useState(isPosterUnlocked)
  const [showPosterSettings, setShowPosterSettings] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [showEnhancerPanel, setShowEnhancerPanel] = useState(false)
  const skipSpinnerRef = useRef(false)

  useEffect(() => {
    getFolderViewEnabled().then(setEnableFolderView)
  }, [])

  useEffect(() => {
    if (!window.ApiClient) return
    const userId = window.ApiClient.getCurrentUserId()
    const url = window.ApiClient.getUrl(`Users/${userId}`)
    window.ApiClient.ajax({ url, type: 'GET', dataType: 'json' })
      .then((user: unknown) => {
        const u = user as { Policy?: { IsAdministrator?: boolean } }
        setIsAdmin(u?.Policy?.IsAdministrator ?? false)
      })
      .catch(() => setIsAdmin(false))
  }, [])

  useEffect(() => {
    if (settings.pageSize === 0) {
      const g = settings.groupBy
      const v = settings.pageSizes[g] ?? DEFAULTS[g]
      handleSettingsChange({ pageSize: v })
    }
  }, [])

  async function fetchData(s: ViewSettings, page: number) {
    if (!skipSpinnerRef.current) setLoading(true)
    setError(null)
    try {
      const { records, totalCount: count, totalPages: pages } = await getHistoryPlayed({
        groupBy: s.groupBy,
        page,
        tz: getTimezone(),
        sortBy: s.sortBy,
        sortOrder: s.sortOrder,
        mediaFilter: s.mediaFilter,
        showRepeats: s.showRepeats,
        groupDedup: s.groupDedup,
        pageSize: s.pageSize,
      })

      const grouped = groupByMode(records, s.groupBy, locale, t, s.groupDedup).map((g) => ({
        ...g,
        records: sortRecords(g.records, s.sortBy, s.sortOrder),
      }))

      setGroups(grouped)
      setTotalCount(count)
      setTotalPages(Math.max(1, pages))
    } catch (e) {
      setError(e instanceof Error ? e.message : t.loadError)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData(settings, pageIndex).finally(() => { skipSpinnerRef.current = false })
  }, [settings, pageIndex])

  function handleSettingsChange(patch: Partial<ViewSettings>) {
    const next = { ...settings, ...patch }
    if (patch.groupBy && patch.groupBy !== settings.groupBy) {
      next.pageSize = next.pageSizes[patch.groupBy] ?? DEFAULTS[patch.groupBy]
    }
    if (patch.pageSize && patch.pageSize !== settings.pageSize) {
      next.pageSizes = { ...next.pageSizes, [settings.groupBy]: patch.pageSize }
    }

    if (patch.groupDedup !== undefined || patch.showRepeats !== undefined) {
      skipSpinnerRef.current = true
    }

    setSettings(next)
    saveSettings(next)
    if (patch.groupBy || patch.pageSize || patch.mediaFilter) {
      setPageIndex(0)
    }
  }

  function handlePageChange(index: number) {
    setPageIndex(index)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function handleDisablePoster() {
    localStorage.removeItem('jfs-poster-unlocked')
    setPosterUnlocked(false)
    setShowPosterSettings(false)
  }

  return (
    <LocaleContext.Provider value={{ locale, t }}>
      <div class="jfs-app">
        <Toolbar
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onPosterUnlocked={() => setPosterUnlocked(true)}
          onDisablePoster={handleDisablePoster}
          posterUnlocked={posterUnlocked}
          showPosterSettings={showPosterSettings}
          onTogglePosterSettings={() => setShowPosterSettings(v => !v)}
          isAdmin={isAdmin}
          showEnhancerPanel={showEnhancerPanel}
          onToggleEnhancerPanel={() => setShowEnhancerPanel(v => !v)}
        />

        {loading && (
          <div class="jfs-status jfs-status--loading">
            <span class="jfs-spinner" />
            {t.loading}
          </div>
        )}

        {error && !loading && (
          <div class="jfs-status jfs-status--error">
            <p>⚠️ {error}</p>
            <button class="jfs-btn" onClick={() => fetchData(settings, pageIndex)}>{t.retry}</button>
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div class="jfs-status jfs-status--empty">
            <p>{t.empty}</p>
          </div>
        )}

        {!loading && !error && groups.map((group, i) => (
          <GroupSection
            key={group.label}
            group={group}
            showTypeLabel={settings.mediaFilter === 'all'}
            viewMode={settings.viewMode}
            enableFolderView={enableFolderView}
            posterUnlocked={posterUnlocked}
            groupIndex={i}
            totalGroups={groups.length}
            hasPrevPage={pageIndex > 0}
            hasNextPage={pageIndex < totalPages - 1}
            onPageNav={(dir) => handlePageChange(dir === 'next' ? pageIndex + 1 : pageIndex - 1)}
          />
        ))}

        {totalCount > 0 && (
          <Pagination
            pageIndex={pageIndex}
            totalPages={totalPages}
            totalCount={totalCount}
            onPageChange={handlePageChange}
          />
        )}
      </div>
      {posterUnlocked && <PosterQueueWidget />}
      <FrameExportQueueWidget />
    </LocaleContext.Provider>
  )
}
