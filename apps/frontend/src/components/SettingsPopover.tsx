import { useState, useRef } from 'preact/hooks'
import { MdSettings } from 'react-icons/md'
import type { GroupByMode } from '../types'
import { useLocale } from '../i18n/context'
import { Popover } from './Popover'

interface Props {
  groupBy: GroupByMode
  pageSize: number
  onChange: (size: number) => void
}

const PRESETS: Record<GroupByMode, number[]> = {
  day: [7, 14, 30, 60],
  week: [4, 8, 13, 26],
  month: [3, 6, 12, 24],
  quarter: [1, 2, 3, 4],
  year: [1, 2, 3, 5],
}

export const DEFAULTS: Record<GroupByMode, number> = {
  day: 30,
  week: 13,
  month: 6,
  quarter: 2,
  year: 1,
}

function getPopoverStyle(btn: HTMLElement): Record<string, string> {
  const r = btn.getBoundingClientRect()
  const w = 192
  const h = 160

  let left = r.left + r.width / 2 - w / 2
  if (left < 4) left = 4
  if (left + w > window.innerWidth - 4) left = window.innerWidth - w - 4

  let top = r.bottom + 4
  if (top + h > window.innerHeight - 4) top = r.top - h - 4
  if (top < 4) top = 4

  return { top: `${top}px`, left: `${left}px` }
}

export function SettingsPopover({ groupBy, pageSize, onChange }: Props) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<Record<string, string>>({})
  const btnRef = useRef<HTMLButtonElement>(null)

  const label = t.groupPerPage[groupBy]
  const presets = PRESETS[groupBy]

  function handleToggle(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!open) {
      requestAnimationFrame(() => {
        if (btnRef.current) setStyle(getPopoverStyle(btnRef.current))
      })
    }
    setOpen((v) => !v)
  }

  function commitSize(val: number) {
    onChange(val)
  }

  return (
    <div class="jfs-settings-btn-wrap">
      <button
        ref={btnRef}
        class="jfs-settings-gear-btn"
        onClick={handleToggle}
        title={t.settingsTitle}
      >
        <MdSettings size={16} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div
          class="jfs-settings-popover"
          style={{
            position: 'fixed',
            ...style,
            zIndex: '999999',
          }}
        >
          <div class="jfs-settings-popover__title">{t.settingsTitle}</div>
          <div class="jfs-settings-popover__mode">{label}</div>
          <div class="jfs-settings-popover__presets">
            {presets.map((n) => (
              <button
                key={n}
                class={`jfs-settings-popover__btn${pageSize === n ? ' jfs-settings-popover__btn--active' : ''}`}
                onClick={() => commitSize(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <div class="jfs-settings-popover__row">
            <input
              class="jfs-settings-popover__input"
              type="number"
              min="1"
              max="999"
              value={pageSize}
              onInput={(e) => {
                const v = parseInt((e.target as HTMLInputElement).value, 10)
                if (v > 0) commitSize(v)
              }}
            />
            <span class="jfs-settings-popover__unit">{label}</span>
          </div>
        </div>
      </Popover>
    </div>
  )
}
