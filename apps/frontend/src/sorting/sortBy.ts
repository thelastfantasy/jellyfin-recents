import type { PlayRecord, SortByMode, SortOrder } from '../types'

export function sortRecords(
  records: PlayRecord[],
  sortBy: SortByMode,
  sortOrder: SortOrder,
): PlayRecord[] {
  const sorted = [...records].sort((a, b) => {
    let result = 0

    switch (sortBy) {
      case 'title':
        result = a.title.localeCompare(b.title, 'zh-CN')
        break
      case 'playedDate':
        result = a.playedDate.getTime() - b.playedDate.getTime()
        break
      case 'favoritedAt':
        // 收藏时间：有收藏时间的降序排前，null 排末尾，次级按 playedDate desc
        if (!a.favoritedAt && !b.favoritedAt) {
          result = b.playedDate.getTime() - a.playedDate.getTime()
          return result
        } else if (!a.favoritedAt) {
          return 1  // a 无收藏 → 排后
        } else if (!b.favoritedAt) {
          return -1 // b 无收藏 → b 排后
        } else {
          result = b.favoritedAt.getTime() - a.favoritedAt.getTime()
        }
        return result // favoritedAt 模式固定降序，不再翻转
      case 'releaseDate':
        // null 排末尾
        if (!a.releaseDate && !b.releaseDate) result = 0
        else if (!a.releaseDate) result = 1
        else if (!b.releaseDate) result = -1
        else result = a.releaseDate.getTime() - b.releaseDate.getTime()
        break
      case 'addedDate':
        // null 排末尾
        if (!a.addedDate && !b.addedDate) result = 0
        else if (!a.addedDate) result = 1
        else if (!b.addedDate) result = -1
        else result = a.addedDate.getTime() - b.addedDate.getTime()
        break
    }

    return sortOrder === 'desc' ? -result : result
  })

  return sorted
}
