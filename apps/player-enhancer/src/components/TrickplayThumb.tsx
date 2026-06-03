import { useAtomValue } from 'jotai'

import { thumbStateAtom } from '../services/trickplay'

export function TrickplayThumb() {
  const state = useAtomValue(thumbStateAtom)
  if (!state.visible || !state.src) return null
  return (
    <div className="jfs-speed-osd__thumb-wrap" style={{ display: 'block', top: state.top, transform: state.transform }}>
      <img className="jfs-speed-osd__thumb-img" src={state.src} />
    </div>
  )
}
