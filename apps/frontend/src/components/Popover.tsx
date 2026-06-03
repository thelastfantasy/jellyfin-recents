import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  open: boolean
  onClose: () => void
  children: ReactNode
}

export function Popover({ open, onClose, children }: Props) {
  if (!open) return null
  return createPortal(
    <div>
      <div className="jfs-popover-overlay" onClick={onClose} />
      {children}
    </div>,
    document.body,
  )
}
