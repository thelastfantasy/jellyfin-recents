import type { ViewSettings } from '../types'
import { SETTINGS_KEY, SETTINGS_KEY_LEGACY } from '../constants'

const DEFAULT_SETTINGS: ViewSettings = {
  groupBy: 'week',
  sortBy: 'playedDate',
  sortOrder: 'desc',
  mediaFilter: 'video',
  showRepeats: false,
  groupDedup: false,
  viewMode: 'thumbnail',
  pageSize: 0,
  pageSizes: {},
}

function migrateOnce(): void {
  try {
    if (localStorage.getItem(SETTINGS_KEY) === null) {
      const legacy = localStorage.getItem(SETTINGS_KEY_LEGACY)
      if (legacy !== null) {
        localStorage.setItem(SETTINGS_KEY, legacy)
        localStorage.removeItem(SETTINGS_KEY_LEGACY)
      }
    }
  } catch {
    // localStorage 不可用时静默失败
  }
}

export function loadSettings(): ViewSettings {
  migrateOnce()
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: ViewSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // localStorage 不可用时静默失败
  }
}
