import type { GroupByMode } from '../types'
import type { Translations } from './types'
import { zh } from './locales/zh'
import { en } from './locales/en'
import { ja } from './locales/ja'

export type { Translations } from './types'
export type Locale = 'zh' | 'en' | 'ja'

const LOCALES: Record<Locale, Translations> = { zh, en, ja }

/** Intl locale tags for each supported locale */
const INTL_TAG: Record<Locale, string> = {
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
}

// ── Locale detection ──────────────────────────────────────────────

export function mapToLocale(tag: string): Locale {
  if (tag.startsWith('zh')) return 'zh'
  if (tag.startsWith('ja')) return 'ja'
  return 'en'
}

/**
 * Detect locale from Jellyfin's user settings (async) with fallback
 * to document lang and browser language.
 */
export async function detectLocale(): Promise<Locale> {
  try {
    const client = window.ApiClient
    if (client) {
      const userId = client.getCurrentUserId()
      const data = await client.ajax({
        url: client.getUrl(`Users/${userId}`),
        type: 'GET',
        dataType: 'json',
      }) as { Configuration?: { UiCulture?: string } }
      const culture = data?.Configuration?.UiCulture
      if (culture) return mapToLocale(culture)
    }
  } catch { /* fall through */ }

  // Fallback: Jellyfin sets document.documentElement.lang via globalize
  const docLang = document.documentElement.lang
  if (docLang) return mapToLocale(docLang)

  return mapToLocale(navigator.language || 'en')
}

export function getTranslations(locale: Locale): Translations {
  return LOCALES[locale]
}

// ── Date formatting for cards ─────────────────────────────────────

export function formatPlayedDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_TAG[locale], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

// ── Group label generation ────────────────────────────────────────

function getMonday(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  d.setHours(0, 0, 0, 0)
  return d
}

function getSunday(monday: Date): Date {
  const d = new Date(monday)
  d.setDate(d.getDate() + 6)
  return d
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

function getISOWeekYear(date: Date): number {
  const thu = new Date(date)
  const dow = date.getDay() || 7
  thu.setDate(date.getDate() + 4 - dow)
  return thu.getFullYear()
}

const QUARTER_INDEX: Record<number, 0 | 1 | 2 | 3> = {
  1: 0, 2: 0, 3: 0,
  4: 1, 5: 1, 6: 1,
  7: 2, 8: 2, 9: 2,
  10: 3, 11: 3, 12: 3,
}

const QUARTER_RANGE: Record<number, [number, number]> = {
  1: [1, 3], 2: [1, 3], 3: [1, 3],
  4: [4, 6], 5: [4, 6], 6: [4, 6],
  7: [7, 9], 8: [7, 9], 9: [7, 9],
  10: [10, 12], 11: [10, 12], 12: [10, 12],
}

export function getDayLabel(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_TAG[locale], {
    year: 'numeric', month: 'long', day: 'numeric',
  }).format(date)
}

export function getWeekLabel(date: Date, locale: Locale): string {
  const monday = getMonday(date)
  const sunday = getSunday(monday)
  const weekNum = getISOWeek(monday)
  const weekYear = getISOWeekYear(monday)
  const fmt = new Intl.DateTimeFormat(INTL_TAG[locale], { month: 'long', day: 'numeric' })
  const monStr = fmt.format(monday)
  const sunStr = fmt.format(sunday)
  if (locale === 'en') return `Week ${weekNum}, ${weekYear} (${monStr} – ${sunStr})`
  if (locale === 'ja') return `${weekYear}年第${weekNum}週 (${monStr}〜${sunStr})`
  return `${weekYear}年第${weekNum}周 (${monStr}-${sunStr})`
}

export function getMonthLabel(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_TAG[locale], {
    year: 'numeric', month: 'long',
  }).format(date)
}

export function getQuarterLabel(date: Date, locale: Locale, t: Translations): string {
  const month = date.getMonth() + 1
  const year = date.getFullYear()
  const qi = QUARTER_INDEX[month]
  const [startMonth, endMonth] = QUARTER_RANGE[month]
  const season = t.quarterNames[qi]
  if (locale === 'en') {
    const fmtM = new Intl.DateTimeFormat('en-US', { month: 'short' })
    const start = new Date(year, startMonth - 1, 1)
    const end = new Date(year, endMonth - 1, 1)
    return `${season} ${year} (${fmtM.format(start)}–${fmtM.format(end)})`
  }
  return `${year}年${season} (${startMonth}-${endMonth}月)`
}

export function getYearLabel(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_TAG[locale], { year: 'numeric' }).format(date)
}

export function getLabelByMode(date: Date, mode: GroupByMode, locale: Locale, t: Translations): string {
  switch (mode) {
    case 'day':     return getDayLabel(date, locale)
    case 'week':    return getWeekLabel(date, locale)
    case 'month':   return getMonthLabel(date, locale)
    case 'quarter': return getQuarterLabel(date, locale, t)
    case 'year':    return getYearLabel(date, locale)
  }
}
