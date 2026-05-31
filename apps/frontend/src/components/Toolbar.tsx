import { MdArrowDownward, MdArrowUpward, MdGridView, MdViewModule, MdViewList, MdBuild } from 'react-icons/md'
import type { GroupByMode, MediaFilter, SortByMode, ViewMode, ViewSettings } from '../types'
import { useLocale } from '../i18n/context'
import { SettingsPopover } from './SettingsPopover'
import { registerPosterViewClick } from '../state/posterSheetUnlock'
import { PosterSheetSettingsPanel } from './PosterSheetSettingsPanel'
import { PlayerEnhancerPanel } from './PlayerEnhancerPanel'
import { Popover } from './Popover'

interface Props {
  settings: ViewSettings
  onSettingsChange: (patch: Partial<ViewSettings>) => void
  onPosterUnlocked?: () => void
  onDisablePoster?: () => void
  posterUnlocked?: boolean
  showPosterSettings?: boolean
  onTogglePosterSettings?: () => void
  isAdmin?: boolean
  showEnhancerPanel?: boolean
  onToggleEnhancerPanel?: () => void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = (props: { size?: number }) => any

const VIEW_MODE_ICONS: { value: ViewMode; icon: IconComponent }[] = [
  { value: 'thumbnail', icon: MdGridView as IconComponent },
  { value: 'poster', icon: MdViewModule as IconComponent },
  { value: 'list', icon: MdViewList as IconComponent },
]

export function Toolbar({ settings, onSettingsChange, onPosterUnlocked, onDisablePoster, posterUnlocked = false, showPosterSettings = false, onTogglePosterSettings, isAdmin = false, showEnhancerPanel = false, onToggleEnhancerPanel }: Props) {
  const { t } = useLocale()

  const GROUP_OPTIONS: { value: GroupByMode; label: string }[] = [
    { value: 'day', label: t.groupDay },
    { value: 'week', label: t.groupWeek },
    { value: 'month', label: t.groupMonth },
    { value: 'quarter', label: t.groupQuarter },
    { value: 'year', label: t.groupYear },
  ]

  const SORT_OPTIONS: { value: SortByMode; label: string }[] = [
    { value: 'playedDate', label: t.sortPlayedDate },
    { value: 'title', label: t.sortTitle },
    { value: 'favoritedAt', label: t.sortFavoritedAt },
    { value: 'releaseDate', label: t.sortReleaseDate },
    { value: 'addedDate', label: t.sortAddedDate },
  ]

  const MEDIA_OPTIONS: { value: MediaFilter; label: string }[] = [
    { value: 'video', label: t.filterVideo },
    { value: 'audio', label: t.filterAudio },
    { value: 'all', label: t.filterAll },
  ]

  const VIEW_MODE_TITLES: Record<ViewMode, string> = {
    thumbnail: t.viewThumbnail,
    poster: t.viewPoster,
    list: t.viewList,
  }

  return (
    <div class="jfs-toolbar">
      {/* 左侧：数据筛选控制（分组 / 排序 / 类型） */}
      <div class="jfs-toolbar__left">
        <div class="jfs-toolbar__group">
          <label class="jfs-toolbar__label">{t.groupLabel}</label>
          <select
            class="jfs-toolbar__select"
            value={settings.groupBy}
            onChange={(e) => onSettingsChange({ groupBy: (e.target as HTMLSelectElement).value as GroupByMode })}
          >
            {GROUP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <SettingsPopover
            groupBy={settings.groupBy}
            pageSize={settings.pageSize}
            onChange={(size) => onSettingsChange({ pageSize: size })}
          />
        </div>

        <div class="jfs-toolbar__group">
          <label class="jfs-toolbar__label">{t.sortLabel}</label>
          <select
            class="jfs-toolbar__select"
            value={settings.sortBy}
            onChange={(e) => onSettingsChange({ sortBy: (e.target as HTMLSelectElement).value as SortByMode })}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            class="jfs-toolbar__sort-order"
            onClick={() => onSettingsChange({ sortOrder: settings.sortOrder === 'desc' ? 'asc' : 'desc' })}
            title={settings.sortOrder === 'desc' ? t.sortDesc : t.sortAsc}
          >
            {settings.sortOrder === 'desc' ? <MdArrowDownward size={16} /> : <MdArrowUpward size={16} />}
          </button>
        </div>

        <div class="jfs-toolbar__group">
          <label class="jfs-toolbar__label">{t.typeLabel}</label>
          <select
            class="jfs-toolbar__select"
            value={settings.mediaFilter}
            onChange={(e) => onSettingsChange({ mediaFilter: (e.target as HTMLSelectElement).value as MediaFilter })}
          >
            {MEDIA_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 右侧：显示控制（视图 / 勾选框） */}
      <div class="jfs-toolbar__right">
        <div class="jfs-toolbar__group">
          <label class="jfs-toolbar__label">{t.viewLabel}</label>
          <div class="jfs-toolbar__view-modes">
            {VIEW_MODE_ICONS.map((o) => (
              <button
                key={o.value}
                class={`jfs-toolbar__view-btn${settings.viewMode === o.value ? ' jfs-toolbar__view-btn--active' : ''}`}
                title={o.value === 'poster' ? 'Click me 7 times' : VIEW_MODE_TITLES[o.value]}
                onClick={() => {
                  if (o.value === 'poster') {
                    if (registerPosterViewClick()) onPosterUnlocked?.()
                  }
                  onSettingsChange({ viewMode: o.value })
                }}
              >
                <o.icon size={18} />
              </button>
            ))}
          </div>
        </div>

        <div class="jfs-toolbar__right-stack">
          <div class="jfs-toolbar__group">
            <label class="jfs-toolbar__label jfs-toolbar__label--toggle">
              <input
                type="checkbox"
                checked={settings.showRepeats}
                onChange={(e) => onSettingsChange({ showRepeats: (e.target as HTMLInputElement).checked })}
              />
              {t.showRepeats}
            </label>
            <label class={`jfs-toolbar__label jfs-toolbar__label--toggle${!settings.showRepeats ? ' jfs-toolbar__label--disabled' : ''}`}>
              <input
                type="checkbox"
                checked={settings.groupDedup}
                disabled={!settings.showRepeats}
                onChange={(e) => onSettingsChange({ groupDedup: (e.target as HTMLInputElement).checked })}
              />
              {t.groupDedup}
            </label>
          </div>

          {posterUnlocked && (
            <div class="jfs-toolbar__poster-row">
              <button
                class={`jfs-toolbar__poster-toggle${showPosterSettings ? ' jfs-toolbar__poster-toggle--active' : ''}`}
                title={t.posterQueueSettings}
                onClick={onTogglePosterSettings}
              >
                <MdGridView size={16} />
                <span>{t.posterQueueSettings}</span>
              </button>
              {isAdmin && (
                <button
                  class={`jfs-toolbar__poster-toggle${showEnhancerPanel ? ' jfs-toolbar__poster-toggle--active' : ''}`}
                  title={t.enhancerTitle}
                  onClick={onToggleEnhancerPanel}
                >
                  <MdBuild size={16} />
                  <span>{t.enhancerTitle}</span>
                </button>
              )}
            </div>
          )}
          {!posterUnlocked && isAdmin && (
            <div class="jfs-toolbar__poster-row">
              <button
                class={`jfs-toolbar__poster-toggle${showEnhancerPanel ? ' jfs-toolbar__poster-toggle--active' : ''}`}
                title={t.enhancerTitle}
                onClick={onToggleEnhancerPanel}
              >
                <MdBuild size={16} />
                <span>{t.enhancerTitle}</span>
              </button>
            </div>
          )}
          <Popover open={!!(posterUnlocked && showPosterSettings)} onClose={() => onTogglePosterSettings?.()}>
            <div class="jfs-poster-settings-modal">
              <div class="jfs-poster-settings-modal__header">
                <span>{t.posterQueueSettings}</span>
                <button class="jfs-poster-settings-modal__close" onClick={() => onTogglePosterSettings?.()}>✕</button>
              </div>
              <div class="jfs-poster-settings-modal__body">
                <PosterSheetSettingsPanel
                  videoDuration={null}
                  onGenerate={() => {}}
                  settingsOnly={true}
                  onDisable={onDisablePoster}
                />
              </div>
            </div>
          </Popover>
          <Popover open={!!(isAdmin && showEnhancerPanel)} onClose={() => onToggleEnhancerPanel?.()}>
            <PlayerEnhancerPanel onClose={() => onToggleEnhancerPanel?.()} />
          </Popover>
        </div>
      </div>
    </div>
  )
}
