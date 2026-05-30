const TRANSLATIONS = {
  en: {
    'longpress.speeding':     'Speeding ×{rate}',
    'longpress.seekHint':     '← → to seek',
    'framestepper.back10':    'Back 10 frames',
    'framestepper.back1':     'Back 1 frame',
    'framestepper.forward1':  'Forward 1 frame',
    'framestepper.forward10': 'Forward 10 frames',
    'screenshot.button':      'Screenshot',
    'screenshot.subtitles':   'Include subtitles',
    'osd.brightness':         'Brightness',
    'osd.volume':             'Volume',
    'screenshot.drm':         'DRM-protected content cannot be captured',
    'screenshot.srt':         'SRT/VTT subtitles cannot be included in screenshot',
    'screenshot.saved':       'Screenshot saved',
    'screenshot.hwdecode':    'Screenshot failed: this browser cannot capture hardware-decoded video frames.',
    'frameExport.button':      'Frame Export',
    'frameExport.title':       'Frame Export',
    'frameExport.loading':     'Loading',
    'frameExport.close':       'Close',
    'frameExport.selected':    'Selected',
    'frameExport.loadPrev':    '← Prev 1s',
    'frameExport.loadNext':    'Next 1s →',
    'frameExport.atStart':     'Reached start',
    'frameExport.atEnd':       'Reached end',
    'frameExport.loadError':   'Load failed',
    'frameExport.selectAll':   'Select all',
    'frameExport.deselectAll': 'Deselect all',
    'frameExport.junk':        'Junk frame',
  },
  zh: {
    'longpress.speeding':     '正在加速 ×{rate}',
    'longpress.seekHint':     '← → 调节进度',
    'framestepper.back10':    '后退 10 帧',
    'framestepper.back1':     '后退 1 帧',
    'framestepper.forward1':  '前进 1 帧',
    'framestepper.forward10': '前进 10 帧',
    'screenshot.button':      '截图',
    'screenshot.subtitles':   '包含字幕',
    'osd.brightness':         '亮度',
    'osd.volume':             '音量',
    'screenshot.drm':         '受版权保护的内容无法截图',
    'screenshot.srt':         'SRT/VTT 字幕无法包含在截图中',
    'screenshot.saved':       '截图已保存',
    'screenshot.hwdecode':    '截图失败：此浏览器无法捕获硬件解码的视频帧。',
    'frameExport.button':      '剪辑工坊',
    'frameExport.title':       '剪辑工坊',
    'frameExport.loading':     '加载中',
    'frameExport.close':       '关闭',
    'frameExport.selected':    '已选',
    'frameExport.loadPrev':    '← 前1s',
    'frameExport.loadNext':    '后1s →',
    'frameExport.atStart':     '已到开头',
    'frameExport.atEnd':       '已到结尾',
    'frameExport.loadError':   '加载失败',
    'frameExport.selectAll':   '全选',
    'frameExport.deselectAll': '全不选',
    'frameExport.junk':        '垃圾帧',
  },
  ja: {
    'longpress.speeding':     '高速再生 ×{rate}',
    'longpress.seekHint':     '← → でシーク',
    'framestepper.back10':    '10フレーム戻る',
    'framestepper.back1':     '1フレーム戻る',
    'framestepper.forward1':  '1フレーム進む',
    'framestepper.forward10': '10フレーム進む',
    'screenshot.button':      'スクリーンショット',
    'screenshot.subtitles':   '字幕を含める',
    'osd.brightness':         '明るさ',
    'osd.volume':             '音量',
    'screenshot.drm':         'DRMで保護されたコンテンツはキャプチャできません',
    'screenshot.srt':         'SRT/VTT字幕はスクリーンショットに含められません',
    'screenshot.saved':       'スクリーンショットを保存しました',
    'screenshot.hwdecode':    'スクリーンショット失敗：このブラウザはハードウェアデコード動画をキャプチャできません。',
    'frameExport.button':      'フレーム出力',
    'frameExport.title':       'フレーム出力',
    'frameExport.loading':     '読み込み中',
    'frameExport.close':       '閉じる',
    'frameExport.selected':    '選択',
    'frameExport.loadPrev':    '← 1秒前',
    'frameExport.loadNext':    '1秒後 →',
    'frameExport.atStart':     '先頭です',
    'frameExport.atEnd':       '末尾です',
    'frameExport.loadError':   '読み込み失敗',
    'frameExport.selectAll':   '全選択',
    'frameExport.deselectAll': '全解除',
    'frameExport.junk':        '不良フレーム',
  },
} as const;

type TranslationKey = keyof typeof TRANSLATIONS.en;

function detectLang(): 'en' | 'zh' | 'ja' {
  const lang =
    document.documentElement.lang ||
    navigator.language ||
    'en';
  const prefix = lang.toLowerCase().split('-')[0];
  if (prefix === 'zh') return 'zh';
  if (prefix === 'ja') return 'ja';
  return 'en';
}

const _lang = detectLang();

export function t(key: TranslationKey): string {
  return TRANSLATIONS[_lang][key] ?? TRANSLATIONS.en[key] ?? key;
}
