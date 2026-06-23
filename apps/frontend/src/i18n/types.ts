export interface Translations {
  // App title (sidebar / page header)
  appTitle: string
  // Toolbar labels
  groupLabel: string
  sortLabel: string
  typeLabel: string
  viewLabel: string
  // Group by options
  groupDay: string
  groupWeek: string
  groupMonth: string
  groupQuarter: string
  groupYear: string
  // Sort by options
  sortPlayedDate: string
  sortTitle: string
  sortFavoritedAt: string
  sortReleaseDate: string
  sortAddedDate: string
  // Media filter options
  filterVideo: string
  filterAudio: string
  filterAll: string
  // Sort order button tooltips
  sortDesc: string
  sortAsc: string
  // Checkbox
  showRepeats: string
  groupDedup: string
  // View mode button tooltips
  viewThumbnail: string
  viewPoster: string
  viewList: string
  // Status messages
  loading: string
  empty: string
  retry: string
  loadError: string
  // Card actions
  play: string
  resume: string
  favorite: string
  unfavorite: string
  // Media type badge
  video: string
  audio: string
  // Quarter season names: [winter, spring, summer, autumn]
  quarterNames: [string, string, string, string]
  // Folder view
  folderViewTitle: string
  folderViewEmpty: string
  // Settings popover
  settingsTitle: string
  groupPerPage: Record<string, string>
  // Poster sheet settings panel
  posterSettingsTitle: string
  posterGrid: string
  posterRows: string
  posterCols: string
  posterFrames: string
  posterTooMany: string
  posterThumbWidth: string
  posterMode: string
  posterDeterministic: string
  posterDeterministicTip: string
  posterRandom: string
  posterRandomTip: string
  posterOverlay: string
  posterBrandingLabel: string
  posterVideoInfo: string
  posterFileSize: string
  posterResolutionFps: string
  posterVideoEncoding: string
  posterAudioEncoding: string
  posterDuration: string
  posterSubtitles: string
  posterTimestamp: string
  posterTimestampFont: string
  posterTimestampBg: string
  posterTimestampShadow: string
  posterTimestampPos: string
  posterTimestampPosInsideBottomLeft: string
  posterTimestampPosOutsideBottomLeft: string
  posterTimestampPosInsideBottomCenter: string
  posterTimestampPosOutsideBottomCenter: string
  posterTimestampPosInsideBottomRight: string
  posterTimestampPosOutsideBottomRight: string
  posterTheme: string
  posterFont: string
  posterBrandingFont: string
  posterBrandingLatinFont: string
  posterBrandingCjkFont: string
  posterLang: string
  posterLangEn: string
  posterLangZh: string
  posterLangJa: string
  posterHeadless: string
  posterHeadlessTip: string
  posterPreview: string
  posterPreviewLoading: string
  posterGenerate: string
  posterDisable: string
  // Poster queue widget
  posterQueue: string
  posterQueueRemove: string
  posterQueueSettings: string
  posterGenerate2: string
  // Lightbox actions
  lightboxZoomIn: string
  lightboxZoomOut: string
  lightboxFit: string
  lightboxDownload: string
  lightboxDelete: string
  lightboxClose: string
  // Group navigation
  groupPrev: string
  groupNext: string
  chapterFallback: string
  guessOp: string
  guessEd: string
  posterGlobalSkip: string
  posterGlobalSkipAdd: string
  skipSettings: string
  skipAndGenerate: string
  skipSegments: string
  generateNow: string
  skipDuration: string
  skipByChapter: string
  skipBySegment: string
  skipChaptersLoading: string
  skipTimeFormat: string
  skipEmpty: string
  skipRemove: string
  skipAddSegment: string
  skipQuickStart60: string
  skipQuickStart90: string
  skipQuickEnd60: string
  skipQuickEnd90: string
  skipClearAll: string
  cancel: string
  skipIgnoreGlobal: string
  skipAddToGlobal: string
  skipGlobalFull: string
  skipSegmentSpan: string
  posterCustomFonts: string
  posterCustomFontHint: string
  posterCustomFontChoose: string
  posterCustomFontUpload: string
  posterCustomFontDelete: string
  posterCustomFontSuffix: string
  // Frame export queue widget
  exportQueue: string
  exportQueueRemove: string
  exportQueueDownload: string
  exportQueueUpscaled: string
  exportQueueOriginal: string
  exportQueueUpscaledLabel: string
  clipWorkshopQueue: string
  exportFormat: string
  exportSize: string
  // Player Enhancer management panel (admin only)
  enhancerTitle: string
  enhancerStatusEnabled: string
  enhancerStatusDisabled: string
  enhancerInject: string
  enhancerRemove: string
  enhancerReloadHint: string
  enhancerErrorHint: string
  enhancerSeekLabel: string
  enhancerSeekUnit: string
  enhancerSeekSave: string
  enhancerSpeedLabel: string
  enhancerSpeedUnit: string
  enhancerIndexHtmlNote: string
  enhancerBrowserNote: string
  enhancerTrickplayLabel: string
  enhancerHwDecodeLabel: string
  enhancerHwDecodeHint: string
  enhancerHwDecodeUnsupported: string
  enhancerHwDecodeStrategyPerformance: string
  enhancerHwDecodeStrategyPerformanceHint: string
  enhancerHwDecodeStrategyIdle: string
  enhancerHwDecodeStrategyIdleHint: string
}
