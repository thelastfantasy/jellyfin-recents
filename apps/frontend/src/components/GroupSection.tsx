import { Fragment } from 'preact'
import { useRef, useLayoutEffect } from 'preact/hooks'
import { RiArrowDropUpFill, RiArrowDropDownFill } from 'react-icons/ri'
import type { TimeGroup, ViewMode, PlayRecord } from '../types'
import { PlayRecordCard } from './PlayRecordCard'
import { useLocale } from '../i18n/context'

interface Props {
  group: TimeGroup
  showTypeLabel?: boolean
  viewMode?: ViewMode
  enableFolderView?: boolean
  posterUnlocked?: boolean
  groupIndex: number
  totalGroups: number
  hasPrevPage: boolean
  hasNextPage: boolean
  onPageNav: (direction: 'prev' | 'next') => void
}

function getRecordKey(r: PlayRecord): string {
  return `${r.itemId}-${r.playedDate.getTime()}`
}

function scrollToGroupHeader(index: number) {
  const cards = document.querySelectorAll<HTMLElement>('.jfs-group__cards')
  const el = cards[index]
  if (!el) return
  const title = el.previousElementSibling as HTMLElement | null
  const titleH = title?.offsetHeight ?? 50
  window.scrollTo({ top: el.offsetTop - titleH - 56, behavior: 'smooth' })
  if (title) {
    title.classList.remove('jfs-group__title--highlight')
    void title.offsetWidth
    title.classList.add('jfs-group__title--highlight')
    title.addEventListener('animationend', () => title.classList.remove('jfs-group__title--highlight'), { once: true })
  }
}

export function GroupSection({
  group, showTypeLabel = false, viewMode = 'thumbnail',
  enableFolderView = false, posterUnlocked = false,
  groupIndex, totalGroups, hasPrevPage, hasNextPage, onPageNav,
}: Props) {
  const { t } = useLocale()
  const cardsRef = useRef<HTMLDivElement>(null)
  const prevRectsRef = useRef<Map<string, DOMRect>>(new Map())
  const prevRecordsRef = useRef<PlayRecord[]>([])
  const cardClonesRef = useRef<Map<string, HTMLElement>>(new Map())

  useLayoutEffect(() => {
    if (group.records.length === 0) return
    const el = cardsRef.current
    if (!el) return

    const cards = el.querySelectorAll<HTMLElement>('.jfs-card')

    // 1. 捕获新位置（在任何 transform 之前）
    const nextRects = new Map<string, DOMRect>()
    cards.forEach(c => {
      const id = c.getAttribute('data-jfs-id')
      if (id) nextRects.set(id, c.getBoundingClientRect())
    })

    // 2. 克隆当前卡片供下次渲染的退出动画使用（在 FLIP transform 之前捕获，位置准确）
    const newClones = new Map<string, HTMLElement>()
    cards.forEach(c => {
      const id = c.getAttribute('data-jfs-id')
      if (!id) return
      const rect = nextRects.get(id)
      if (!rect) return
      const clone = c.cloneNode(true) as HTMLElement
      clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;z-index:50;pointer-events:none;opacity:1;animation:none;transition:none;`
      newClones.set(id, clone)
    })

    if (prevRectsRef.current.size > 0) {
      const nextKeys = new Set(group.records.map(getRecordKey))
      const elRect = el.getBoundingClientRect()

      // 3. 退出动画：用上次渲染保存的克隆淡出被移除的卡片
      prevRecordsRef.current.forEach(r => {
        const key = getRecordKey(r)
        if (nextKeys.has(key)) return
        const clone = cardClonesRef.current.get(key)
        if (!clone) return
        // 裁剪到分组当前下边界，防止残影覆盖下方分组内容
        const cloneTop = parseFloat(clone.style.top)
        const cloneHeight = parseFloat(clone.style.height)
        const overflowBottom = Math.max(0, cloneTop + cloneHeight - elRect.bottom)
        if (overflowBottom > 0) {
          clone.style.clipPath = `inset(0 0 ${overflowBottom}px 0)`
        }
        document.body.appendChild(clone)
        requestAnimationFrame(() => {
          clone.style.opacity = '0'
          clone.style.transition = 'opacity 0.15s ease-out'
          setTimeout(() => clone.remove(), 150)
        })
      })

      // 4. FLIP：将留存卡片从旧位置平移到新位置
      cards.forEach(c => {
        const id = c.getAttribute('data-jfs-id')
        if (!id) return
        const prev = prevRectsRef.current.get(id)
        const next = nextRects.get(id)
        if (!prev || !next) return

        const dx = prev.left - next.left
        const dy = prev.top - next.top
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return

        c.style.transform = `translate(${dx}px, ${dy}px)`
        c.style.transition = 'none'
        requestAnimationFrame(() => {
          c.style.transition = 'transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
          c.style.transform = ''
        })
      })
    }

    // 5. 更新 ref，克隆是在 FLIP 之前捕获的，位置正确
    prevRectsRef.current = nextRects
    prevRecordsRef.current = group.records.slice()
    cardClonesRef.current = newClones
  }, [group.records])

  const isFirst = groupIndex === 0
  const isLast = groupIndex === totalGroups - 1
  const canUp = !isFirst || hasPrevPage
  const canDown = !isLast || hasNextPage

  function handleUp() {
    if (!isFirst) scrollToGroupHeader(groupIndex - 1)
    else if (hasPrevPage) onPageNav('prev')
  }

  function handleDown() {
    if (!isLast) scrollToGroupHeader(groupIndex + 1)
    else if (hasNextPage) onPageNav('next')
  }

  if (group.records.length === 0) return null

  return (
    <Fragment>
      <h2 class="jfs-group__title">
        <span class="jfs-group__title-text">{group.label}</span>
        <span class="jfs-group__nav">
          <button
            class="jfs-group__nav-btn"
            onClick={handleUp}
            disabled={!canUp}
            title={t.groupPrev}
          >
            <RiArrowDropUpFill />
          </button>
          <button
            class="jfs-group__nav-btn"
            onClick={handleDown}
            disabled={!canDown}
            title={t.groupNext}
          >
            <RiArrowDropDownFill />
          </button>
        </span>
      </h2>
      <div ref={cardsRef} class={`jfs-group__cards jfs-group__cards--${viewMode}`}>
        {group.records.map((record) => (
          <PlayRecordCard
            key={getRecordKey(record)}
            record={record}
            showTypeLabel={showTypeLabel}
            viewMode={viewMode}
            enableFolderView={enableFolderView}
            posterUnlocked={posterUnlocked}
          />
        ))}
      </div>
    </Fragment>
  )
}
