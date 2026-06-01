import playerCss from './player.css?raw'
import './alive.css'

const STYLE_ID = 'jfs-enhancer-styles'

export function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = playerCss
  document.head.appendChild(style)
}
