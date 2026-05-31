import { getCurrentUserId } from './jellyfinClient'
import type { GroupByMode, MediaFilter, PlayRecord, SortByMode, SortOrder } from '../types'
import type { components } from '@jfs/api-types'

type PlayHistoryResponse = components['schemas']['PlayHistoryResponse']

export interface HistoryResult {
  records: PlayRecord[]
  totalCount: number
  totalPages: number
}

export interface HistoryQuery {
  groupBy: GroupByMode
  page: number
  tz: string
  sortBy: SortByMode
  sortOrder: SortOrder
  mediaFilter: MediaFilter
  showRepeats: boolean
  groupDedup: boolean
  pageSize: number
}

export async function getHistoryPlayed(query: HistoryQuery): Promise<HistoryResult> {
  const userId = getCurrentUserId()
  if (!window.ApiClient) throw new Error('ApiClient unavailable')

  const params: Record<string, string> = {
    userId,
    groupBy: query.groupBy,
    page: String(query.page),
    tz: query.tz,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    showRepeats: String(query.showRepeats),
  }
  if (query.mediaFilter !== 'all') params['mediaType'] = query.mediaFilter
  if (query.groupDedup) params['groupDedup'] = 'true'
  params['pageSize'] = String(query.pageSize)

  const url = window.ApiClient.getUrl('JellyfinSuite/PlayHistory', params)
  const data = (await window.ApiClient.ajax({ url, type: 'GET', dataType: 'json' })) as PlayHistoryResponse

  const records = (data.entries ?? []).map((entry): PlayRecord => ({
    itemId: entry.itemId ?? '',
    title: entry.title ?? '未知标题',
    playedDate: new Date(entry.playedDate ?? 0),
    favoritedAt: entry.favoritedAt ? new Date(entry.favoritedAt) : null,
    releaseDate: entry.releaseDate ? new Date(entry.releaseDate) : null,
    addedDate: entry.addedDate ? new Date(entry.addedDate) : null,
    mediaType: entry.mediaType === 'audio' ? 'audio' : 'video',
    imagePrimaryTag: entry.imagePrimaryTag ?? null,
    seriesName: entry.seriesName ?? null,
    seriesId: entry.seriesId ?? null,
    seasonNumber: entry.seasonNumber ?? null,
    episodeNumber: entry.episodeNumber ?? null,
    parentId: null,
    hasAncestors: entry.hasAncestors ?? false,
    playbackPositionTicks: entry.playbackPositionTicks ?? null,
    videoDuration: entry.videoDuration ?? null,
  }))

  return { records, totalCount: data.totalCount ?? 0, totalPages: data.totalPages ?? 0 }
}
