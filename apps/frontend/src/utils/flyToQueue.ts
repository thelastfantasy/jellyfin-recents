export function flyToQueue(sourceEl: Element): void {
  const sourceRect = sourceEl.getBoundingClientRect()
  const target = document.querySelector<HTMLElement>('.jfs-queue-widget')

  let targetCx: number
  let targetCy: number
  let targetW: number

  if (target) {
    const r = target.getBoundingClientRect()
    targetCx = r.left + r.width / 2
    targetCy = r.top + r.height / 2
    targetW = r.width
  } else {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const margin = 1.5 * rem
    targetW = 44
    targetCx = window.innerWidth - margin - targetW / 2
    targetCy = window.innerHeight - margin - targetW / 2
  }

  const clone = document.createElement('div')
  const img = sourceEl.querySelector('img')
  if (img) {
    const ci = img.cloneNode() as HTMLImageElement
    ci.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;'
    clone.appendChild(ci)
  }

  Object.assign(clone.style, {
    position: 'fixed',
    top: `${sourceRect.top}px`,
    left: `${sourceRect.left}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
    zIndex: '9999',
    pointerEvents: 'none',
    borderRadius: '6px',
    overflow: 'hidden',
    willChange: 'transform, opacity',
    transition:
      'transform 0.52s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.36s ease 0.18s, border-radius 0.52s ease',
  })

  document.body.appendChild(clone)
  clone.getBoundingClientRect() // force reflow

  const tx = targetCx - (sourceRect.left + sourceRect.width / 2)
  const ty = targetCy - (sourceRect.top + sourceRect.height / 2)
  const scale = (targetW / sourceRect.width) * 0.7

  Object.assign(clone.style, {
    transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
    opacity: '0',
    borderRadius: '50%',
  })

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    clone.remove()
    if (target) {
      target.classList.add('jfs-queue-widget--arrived')
      setTimeout(() => target.classList.remove('jfs-queue-widget--arrived'), 600)
    }
  }

  clone.addEventListener('transitionend', cleanup, { once: true })
  setTimeout(cleanup, 700)
}
