import type { GroupByMode } from '../types'

const QUARTER_MONTHS: Record<number, [number, number]> = {
  1: [1, 3], 2: [1, 3], 3: [1, 3],
  4: [4, 6], 5: [4, 6], 6: [4, 6],
  7: [7, 9], 8: [7, 9], 9: [7, 9],
  10: [10, 12], 11: [10, 12], 12: [10, 12],
}

// 周一为周起始，返回该日期所在周的周一
function getMonday(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function endOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

function startOfMonth(year: number, month: number): Date {
  return new Date(year, month - 1, 1, 0, 0, 0, 0)
}

function endOfMonth(year: number, month: number): Date {
  return new Date(year, month, 0, 23, 59, 59, 999)
}

// ─── 时间窗口计算 ─────────────────────────────────────────────────────────────

export interface DateWindow {
  start: Date
  end: Date
}

export function getWeekWindow(pageIndex: number): DateWindow {
  const now = new Date()
  const thisMonday = getMonday(now)
  // pageIndex=0 → 最近 13 周；pageIndex=1 → 再往前 13 周
  const weeksBack = pageIndex * 13
  const start = new Date(thisMonday)
  start.setDate(start.getDate() - (weeksBack + 12) * 7)
  start.setHours(0, 0, 0, 0)
  const end = new Date(thisMonday)
  end.setDate(end.getDate() - weeksBack * 7 + 6)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

export function getDayWindow(pageIndex: number): DateWindow {
  const now = new Date()
  const end = endOfDay(new Date(now.getTime() - pageIndex * 30 * 86400000))
  const start = startOfDay(new Date(end.getTime() - 29 * 86400000))
  return { start, end }
}

export function getMonthWindow(pageIndex: number): DateWindow {
  const now = new Date()
  const endMonth = now.getMonth() + 1 - pageIndex * 6
  const endYear = now.getFullYear() + Math.floor((endMonth - 1) / 12)
  const normalizedEndMonth = ((endMonth - 1 + 120) % 12) + 1
  const normalizedEndYear = endYear - Math.floor((12 - endMonth) / 12)

  const startMonthRaw = normalizedEndMonth - 5
  const startMonth = ((startMonthRaw - 1 + 120) % 12) + 1
  const startYear = normalizedEndYear - (startMonthRaw <= 0 ? 1 : 0)

  return {
    start: startOfMonth(startYear, startMonth),
    end: endOfMonth(normalizedEndYear, normalizedEndMonth),
  }
}

export function getQuarterWindow(pageIndex: number): DateWindow {
  const now = new Date()
  const month = now.getMonth() + 1
  const currentQuarterEnd = QUARTER_MONTHS[month][1]

  const endMonthRaw = currentQuarterEnd - pageIndex * 3
  const yearsBack = endMonthRaw <= 0 ? Math.ceil(-endMonthRaw / 12) + 1 : 0
  const adjustedEndMonth = ((endMonthRaw - 1 + 120) % 12) + 1
  const adjustedEndYear = now.getFullYear() - yearsBack

  const startMonthRaw2 = adjustedEndMonth - 2
  const startMonth = ((startMonthRaw2 - 1 + 120) % 12) + 1
  const startYear = adjustedEndYear - (startMonthRaw2 <= 0 ? 1 : 0)

  return {
    start: startOfMonth(startYear, startMonth),
    end: endOfMonth(adjustedEndYear, adjustedEndMonth),
  }
}

export function getYearWindow(pageIndex: number): DateWindow {
  const year = new Date().getFullYear() - pageIndex
  return {
    start: startOfMonth(year, 1),
    end: endOfMonth(year, 12),
  }
}

export function getWindowByMode(mode: GroupByMode, pageIndex: number): DateWindow {
  switch (mode) {
    case 'day': return getDayWindow(pageIndex)
    case 'week': return getWeekWindow(pageIndex)
    case 'month': return getMonthWindow(pageIndex)
    case 'quarter': return getQuarterWindow(pageIndex)
    case 'year': return getYearWindow(pageIndex)
  }
}

// 每种模式的总页数上限
export const PAGE_LIMITS: Record<GroupByMode, number> = {
  day: 12,      // 最近 30×12=360 天
  week: 4,      // 最近 13×4=52 周
  month: 4,     // 最近 6×4=24 个月
  quarter: 4,   // 最近 2×4=8 个季度
  year: 5,      // 最近 5 年
}
