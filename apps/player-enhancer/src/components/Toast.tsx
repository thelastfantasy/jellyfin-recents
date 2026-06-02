import { atom, getDefaultStore } from 'jotai'
import { useAtomValue } from 'jotai'
const jstore = getDefaultStore()
function $val<T>(a: ReturnType<typeof atom<T>>) {
  return { get value(): T { return jstore.get(a) }, set value(v: T) { jstore.set(a, v) } }
}

interface ToastEntry { msg: string; id: number }

export const toastAtom = atom<ToastEntry | null>(null)
export const sToast = $val(toastAtom)

let _toastSeq = 0

export function showToast(msg: string, ms = 2800): void {
  const id = ++_toastSeq
  sToast.value = { msg, id }
  setTimeout(() => {
    if (sToast.value?.id === id) sToast.value = null
  }, ms)
}

export function Toast() {
  const entry = useAtomValue(toastAtom)
  if (!entry) return null
  return <div className="jfs-fe-toast">{entry.msg}</div>
}
