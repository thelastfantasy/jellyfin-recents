export type GroupByMode = 'day' | 'week' | 'month' | 'quarter' | 'year'
export type SortByMode = 'playedDate' | 'title' | 'favoritedAt' | 'releaseDate' | 'addedDate'
export type SortOrder = 'asc' | 'desc'
export type MediaFilter = 'video' | 'audio' | 'all'
export type ViewMode = 'thumbnail' | 'poster' | 'list'

export interface PlayRecord {
  itemId: string
  title: string
  playedDate: Date
  favoritedAt: Date | null
  releaseDate: Date | null
  addedDate: Date | null
  mediaType: 'video' | 'audio'
  imagePrimaryTag: string | null
  seriesName: string | null
  seriesId: string | null
  seasonNumber: number | null
  episodeNumber: number | null
  parentId: string | null
  hasAncestors: boolean
  playbackPositionTicks: number | null
  videoDuration: number | null
}

export interface TimeGroup {
  label: string
  startDate: Date
  endDate: Date
  records: PlayRecord[]
}

export interface GroupedPage {
  groups: TimeGroup[]
  pageIndex: number
  totalPages: number
}

export interface ViewSettings {
  groupBy: GroupByMode
  sortBy: SortByMode
  sortOrder: SortOrder
  mediaFilter: MediaFilter
  showRepeats: boolean
  groupDedup: boolean
  viewMode: ViewMode
  pageSize: number
  pageSizes: Record<string, number>
}
