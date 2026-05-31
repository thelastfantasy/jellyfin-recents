import { sThumbState } from '../services/trickplay'

export function TrickplayThumb() {
  const state = sThumbState.value
  if (!state.visible || !state.src) return null
  return (
    <div class="jfs-speed-osd__thumb-wrap" style={{ display: 'block', top: state.top, transform: state.transform }}>
      <img class="jfs-speed-osd__thumb-img" src={state.src} />
    </div>
  )
}
