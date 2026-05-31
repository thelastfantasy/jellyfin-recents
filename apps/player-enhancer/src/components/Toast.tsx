import { signal } from '@preact/signals'

interface ToastEntry { msg: string; id: number }

export const sToast = signal<ToastEntry | null>(null)

let _toastSeq = 0

export function showToast(msg: string, ms = 2800): void {
  const id = ++_toastSeq
  sToast.value = { msg, id }
  setTimeout(() => {
    if (sToast.value?.id === id) sToast.value = null
  }, ms)
}

export function Toast() {
  const entry = sToast.value
  if (!entry) return null
  return <div class="jfs-fe-toast">{entry.msg}</div>
}
