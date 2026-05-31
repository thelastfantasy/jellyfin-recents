import { signal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import { stepFrames } from '../services/framestepper'
import { takeScreenshot } from '../services/screenshot'
import { t } from '../lib/i18n'
import { ICON_BACK10, ICON_BACK1, ICON_FORWARD1, ICON_FORWARD10, ICON_SCREENSHOT, ICON_FRAME_EXPORT } from '../lib/icons'

export const sProgressPercent = signal(0)
export const sProgressVisible = signal(false)

interface OsdButtonsProps {
  videoEl: HTMLVideoElement
  getItemId: () => string
  onOpenFrameExport: () => void
}

function SvgHtml({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

function SubtitleToggle() {
  useEffect(() => {
    const eventEl = document.querySelector('.videoSubtitles')
    if (!eventEl || !eventEl.textContent?.trim()) return
    const observer = new MutationObserver(() => {
      const srtEl = document.querySelector('.videoSubtitles')
      const hasAss = !!document.querySelector('.libassjs-canvas-parent canvas')
      const hasSrt = !!srtEl?.textContent?.trim()
      const active = hasAss || hasSrt
      const wrap = document.querySelector('.jfs-enhancer-screenshot-wrap') as HTMLElement | null
      if (wrap) wrap.classList.toggle('jfs-has-subtitles', active)
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])

  return (
    <label class="jfs-enhancer-switch">
      <input type="checkbox" />
      <span class="jfs-enhancer-toggle-track" />
      {t('screenshot.subtitles')}
    </label>
  )
}

function ScreenshotButton({ videoEl, getItemId }: Pick<OsdButtonsProps, 'videoEl' | 'getItemId'>) {
  const wrapperRef = useRef<HTMLDivElement>(null)

  const handleClick = () => {
    const checkbox = wrapperRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const title = document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || undefined
    takeScreenshot(videoEl, checkbox?.checked ?? false, title, getItemId())
  }

  return (
    <div class="jfs-enhancer-screenshot-wrap" ref={wrapperRef}>
      <button class="jfs-enhancer-btn" title={t('screenshot.button')} onClick={handleClick}>
        <SvgHtml html={ICON_SCREENSHOT} />
      </button>
      <SubtitleToggle />
    </div>
  )
}

function FrameExportButton({ onOpen }: { onOpen: () => void }) {
  return (
    <div class="jfs-enhancer-frameexport-wrap" style="display:inline-flex;align-items:center;gap:4px;">
      <button class="jfs-enhancer-btn" title={t('frameExport.button')} onClick={onOpen}>
        <SvgHtml html={ICON_FRAME_EXPORT} />
      </button>
      {sProgressVisible.value && (
        <button class="jfs-enhancer-prog-indicator">
          {sProgressPercent.value}%
        </button>
      )}
    </div>
  )
}

export function OsdButtons({ videoEl, getItemId, onOpenFrameExport }: OsdButtonsProps) {
  const itemId = getItemId()
  return (
    <>
      <div class="jfs-enhancer-framestep-wrap" style="display:inline-flex;align-items:center;">
        <button class="jfs-enhancer-btn" title={t('framestepper.back10')} onClick={() => stepFrames(videoEl, -10, itemId)}>
          <SvgHtml html={ICON_BACK10} />
        </button>
        <button class="jfs-enhancer-btn" title={t('framestepper.back1')} onClick={() => stepFrames(videoEl, -1, itemId)}>
          <SvgHtml html={ICON_BACK1} />
        </button>
        <button class="jfs-enhancer-btn" title={t('framestepper.forward1')} onClick={() => stepFrames(videoEl, 1, itemId)}>
          <SvgHtml html={ICON_FORWARD1} />
        </button>
        <button class="jfs-enhancer-btn" title={t('framestepper.forward10')} onClick={() => stepFrames(videoEl, 10, itemId)}>
          <SvgHtml html={ICON_FORWARD10} />
        </button>
      </div>
      <ScreenshotButton videoEl={videoEl} getItemId={getItemId} />
      <FrameExportButton onOpen={onOpenFrameExport} />
    </>
  )
}
