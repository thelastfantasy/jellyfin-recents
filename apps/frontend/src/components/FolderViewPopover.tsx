import { useState, useRef, useCallback } from 'preact/hooks'
import { MdFolder } from 'react-icons/md'
import type { AncestorEntry } from '../api/foldersApi'
import { getItemAncestors } from '../api/foldersApi'
import { useLocale } from '../i18n/context'
import { Popover } from './Popover'

interface Props {
  itemId: string
  showTypeLabel?: boolean
  viewMode?: string
}

const POPOVER_WIDTH = 260
const POPOVER_ITEM_HEIGHT = 32

function computeStyle(btn: HTMLElement, entryCount: number, isList: boolean): Record<string, string> {
  const r = btn.getBoundingClientRect()
  const estH = Math.min(Math.max(entryCount, 1), 8) * POPOVER_ITEM_HEIGHT + 40

  const style: Record<string, string> = {}

  if (isList) {
    style.right = `${window.innerWidth - r.right}px`
  } else {
    let left = r.left
    if (left + POPOVER_WIDTH > window.innerWidth - 8) {
      left = r.right - POPOVER_WIDTH
    }
    if (left < 4) left = 4
    style.left = `${left}px`
  }

  let top = r.bottom + 4
  if (top + estH > window.innerHeight - 8) {
    top = r.top - estH - 4
  }
  if (top < 4) top = 4
  style.top = `${top}px`

  style.position = 'fixed'
  style.zIndex = '999999'
  return style
}

export function FolderViewPopover({ itemId, showTypeLabel, viewMode }: Props) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [ancestors, setAncestors] = useState<AncestorEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [style, setStyle] = useState<Record<string, string>>({})
  const btnRef = useRef<HTMLButtonElement>(null)
  const fetchingRef = useRef(false)

  const close = useCallback(() => {
    setOpen(false)
    setLoading(false)
  }, [])

  function updatePosition(count: number) {
    if (!btnRef.current) return
    setStyle(computeStyle(btnRef.current, count, viewMode === 'list'))
  }

  async function handleToggle(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (open) { close(); return }
    if (fetchingRef.current) return

    setOpen(true)
    setLoading(true)
    fetchingRef.current = true
    requestAnimationFrame(() => updatePosition(3))

    try {
      const list = await getItemAncestors(itemId)
      const filtered = list.length > 1 ? list.slice(0, -1) : list
      setAncestors(filtered)
      setLoading(false)
      requestAnimationFrame(() => updatePosition(filtered.length))
    } catch {
      setLoading(false)
      close()
    } finally {
      fetchingRef.current = false
    }
  }

  const isList = viewMode === 'list'

  return (
    <div class={`jfs-folder-btn-wrap${showTypeLabel && !isList ? ' jfs-folder-btn-wrap--with-type' : ''}${isList ? ' jfs-folder-btn-wrap--list' : ''}`}>
      <button
        ref={btnRef}
        class={`jfs-folder-btn${isList ? ' jfs-folder-btn--list' : ''}`}
        onClick={handleToggle}
        title={t.folderViewTitle}
      >
        {loading ? (
          <span class="jfs-folder-btn__spinner" />
        ) : (
          <MdFolder size={24} />
        )}
      </button>
      <Popover open={open} onClose={close}>
        <div class="jfs-folder-popover" style={style}>
            <div class="jfs-folder-popover__title">{t.folderViewTitle}</div>
            {loading ? (
              <div class="jfs-folder-popover__loading">
                <span class="jfs-folder-popover__sk" />
                <span class="jfs-folder-popover__sk" />
                <span class="jfs-folder-popover__sk" />
              </div>
            ) : (
              <ul class="jfs-folder-popover__list">
                {ancestors.map((a, i) => (
                  <li key={a.Id} class={`jfs-folder-popover__item jfs-folder-popover__item--l${i}`}>
                    <a
                      class="jfs-folder-popover__link"
                      href={`#!/list.html?parentId=${a.Id}&serverId=${a.ServerId}`}
                      onClick={close}
                      title={a.Name}
                    >
                      <span class="jfs-folder-popover__lvl" />
                      <span class="jfs-folder-popover__text">{a.Name}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
      </Popover>
    </div>
  )
}
