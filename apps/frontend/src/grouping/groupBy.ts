import type { GroupByMode, PlayRecord, TimeGroup } from '../types'
import type { Locale, Translations } from '../i18n'
import { getLabelByMode } from '../i18n'

function getGroupKey(date: Date, mode: GroupByMode): string {
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()

  switch (mode) {
    case 'day':
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    case 'week': {
      const monday = getMonday(date)
      const wy = monday.getFullYear()
      const wm = monday.getMonth() + 1
      const wd = monday.getDate()
      return `week-${wy}-${String(wm).padStart(2, '0')}-${String(wd).padStart(2, '0')}`
    }
    case 'month':
      return `${y}-${String(m).padStart(2, '0')}`
    case 'quarter': {
      const q = Math.ceil(m / 3)
      return `${y}-Q${q}`
    }
    case 'year':
      return `${y}`
  }
}

function getMonday(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  d.setHours(0, 0, 0, 0)
  return d
}

export function groupByMode(
  records: PlayRecord[],
  mode: GroupByMode,
  locale: Locale,
  t: Translations,
  groupDedup = false,
): TimeGroup[] {
  const groupMap = new Map<string, { label: string; date: Date; records: PlayRecord[] }>()

  for (const record of records) {
    const key = getGroupKey(record.playedDate, mode)
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        label: getLabelByMode(record.playedDate, mode, locale, t),
        date: record.playedDate,
        records: [],
      })
    }
    groupMap.get(key)!.records.push(record)
  }

  const rawGroups = Array.from(groupMap.values())
    .filter((g) => g.records.length > 0)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .map((g) => ({
      label: g.label,
      startDate: g.date,
      endDate: g.date,
      records: g.records,
    }))

  if (!groupDedup) return rawGroups
  return rawGroups.map(deduplicateGroup)
}

// 去重：同一 itemId 保留 playedDate 最大的一条
export function deduplicateGroup(group: TimeGroup): TimeGroup {
  const seen = new Map<string, PlayRecord>()
  for (const record of group.records) {
    const existing = seen.get(record.itemId)
    if (!existing || record.playedDate > existing.playedDate) {
      seen.set(record.itemId, record)
    }
  }
  return { ...group, records: Array.from(seen.values()) }
}
