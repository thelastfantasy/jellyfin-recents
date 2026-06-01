import { atom, getDefaultStore } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { stepFrames } from '../services/framestepper'
import { takeScreenshot } from '../services/screenshot'
import { t } from '../lib/i18n'
import { ICON_BACK10, ICON_BACK1, ICON_FORWARD1, ICON_FORWARD10, ICON_SCREENSHOT, ICON_FRAME_EXPORT } from '../lib/icons'

const _sProgressPercent = atom(0)
const _sProgressVisible = atom(false)
const store = getDefaultStore()

export const progressPercentAtom = _sProgressPercent
export const progressVisibleAtom = _sProgressVisible

export const sProgressPercent = {
  get value() { return store.get(_sProgressPercent) },
  set value(v: number) { store.set(_sProgressPercent, v) },
}

export const sProgressVisible = {
  get value() { return store.get(_sProgressVisible) },
  set value(v: boolean) { store.set(_sProgressVisible, v) },
}

interface OsdButtonsProps {
  videoEl: HTMLVideoElement
  getItemId: () => string
  onOpenFrameExport: () => void
}

function SvgHtml({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

function SubtitleToggle() {
  return (
    <label className="jfs-enhancer-switch">
      <input type="checkbox" />
      <span className="jfs-enhancer-toggle-track" />
      {t('screenshot.subtitles')}
    </label>
  )
}

function ScreenshotButton({ videoEl, getItemId }: Pick<OsdButtonsProps, 'videoEl' | 'getItemId'>) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [hasSubtitles, setHasSubtitles] = useState(false)

  useEffect(() => {
    const check = () => {
      const srtEl = document.querySelector('.videoSubtitles')
      const hasAss = !!document.querySelector('.libassjs-canvas-parent canvas')
      const hasSrt = !!srtEl?.textContent?.trim()
      setHasSubtitles(hasAss || hasSrt)
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])

  const handleClick = () => {
    const checkbox = wrapperRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const title = document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || undefined
    takeScreenshot(videoEl, checkbox?.checked ?? false, title, getItemId())
  }

  return (
    <div className={`jfs-enhancer-screenshot-wrap${hasSubtitles ? ' jfs-has-subtitles' : ''}`} ref={wrapperRef}>
      <button className="jfs-enhancer-btn" title={t('screenshot.button')} onClick={handleClick}>
        <SvgHtml html={ICON_SCREENSHOT} />
      </button>
      {hasSubtitles && <SubtitleToggle />}
    </div>
  )
}

function FrameExportButton({ onOpen }: { onOpen: () => void }) {
  const visible = useAtomValue(progressVisibleAtom)
  const percent = useAtomValue(progressPercentAtom)
  return (
    <div className="jfs-enhancer-frameexport-wrap" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <button className="jfs-enhancer-btn" title={t('frameExport.button')} onClick={onOpen}>
        <SvgHtml html={ICON_FRAME_EXPORT} />
      </button>
      {visible && (
        <button className="jfs-enhancer-prog-indicator">
          {percent}%
        </button>
      )}
    </div>
  )
}

export function OsdButtons({ videoEl, getItemId, onOpenFrameExport }: OsdButtonsProps) {
  const itemId = getItemId()
  return (
    <>
      <div className="jfs-enhancer-framestep-wrap" style={{ display: 'inline-flex', alignItems: 'center' }}>
        <button className="jfs-enhancer-btn" title={t('framestepper.back10')} onClick={() => stepFrames(videoEl, -10, itemId)}>
          <SvgHtml html={ICON_BACK10} />
        </button>
        <button className="jfs-enhancer-btn" title={t('framestepper.back1')} onClick={() => stepFrames(videoEl, -1, itemId)}>
          <SvgHtml html={ICON_BACK1} />
        </button>
        <button className="jfs-enhancer-btn" title={t('framestepper.forward1')} onClick={() => stepFrames(videoEl, 1, itemId)}>
          <SvgHtml html={ICON_FORWARD1} />
        </button>
        <button className="jfs-enhancer-btn" title={t('framestepper.forward10')} onClick={() => stepFrames(videoEl, 10, itemId)}>
          <SvgHtml html={ICON_FORWARD10} />
        </button>
      </div>
      <ScreenshotButton videoEl={videoEl} getItemId={getItemId} />
      <FrameExportButton onOpen={onOpenFrameExport} />
    </>
  )
}
