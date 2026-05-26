import './alive.css'

const STYLE_ID = 'jfs-enhancer-styles'

// Remaining Jellyfin overrides that AliveUI doesn't handle.
// AliveUI's Preflight resets button borders/backgrounds/padding,
// so we add back the essential OSD button styling.
const JELLYFIN_OVERRIDES = `
  /* Hide Jellyfin native rewind/fastforward - replaced by F+/-1/F+/-10 */
  .osdControls .btnRewind,
  .osdControls .btnFastForward {
    display: none !important;
  }

  /* Suppress Jellyfin native volume OSD - replaced by swipe OSD */
  .volumeOsd {
    display: none !important;
  }

  /* Hide Jellyfin OSD during drag-seek */
  body.jfs-seeking .videoOsdBottom,
  body.jfs-seeking .videoOsdTop,
  body.jfs-seeking .upNextContainer {
    opacity: 0 !important;
    pointer-events: none !important;
  }

  /* OSD button baseline */
  .jfs-enhancer-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 8px;
    cursor: pointer;
    color: #fff;
    opacity: 0.75;
    transition: opacity 0.15s;
    border-radius: 4px;
    flex-shrink: 0;
    touch-action: manipulation;
  }
  .jfs-enhancer-btn:hover { opacity: 1; background: rgba(255,255,255,0.12); }
  .jfs-enhancer-btn:active { background: rgba(255,255,255,0.22); }
  .jfs-enhancer-btn svg { width: 20px; height: 20px; pointer-events: none; }

  /* F+/-10 adaptive: hide on narrow viewports */
  .videoOsdBottom .buttons { container-type: inline-size; }
  .jfs-enhancer-framestep-wrap > button:first-child,
  .jfs-enhancer-framestep-wrap > button:last-child {
    display: none;
  }
  @container (min-width: 800px) {
    .jfs-enhancer-framestep-wrap > button:first-child,
    .jfs-enhancer-framestep-wrap > button:last-child {
      display: inline-flex;
    }
  }

  /* Screenshot wrap pill styling */
  .jfs-enhancer-screenshot-wrap {
    display: inline-flex;
    align-items: center;
    gap: 0;
  }
  .jfs-enhancer-screenshot-wrap.jfs-has-subtitles {
    background: rgba(255,255,255,0.08);
    border-radius: 20px;
    padding: 0 10px 0 0;
  }
  .jfs-enhancer-screenshot-wrap.jfs-has-subtitles > .jfs-enhancer-btn {
    border-radius: 20px 0 0 20px;
  }

  /* Subtitle switch */
  .jfs-enhancer-switch {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
  }
  .jfs-enhancer-switch input[type="checkbox"] {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .jfs-enhancer-toggle-track {
    position: relative;
    display: inline-block;
    width: 28px;
    height: 16px;
    background: rgba(255,255,255,0.25);
    border-radius: 8px;
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .jfs-enhancer-switch input:checked ~ .jfs-enhancer-toggle-track {
    background: #00a4dc;
  }
  .jfs-enhancer-toggle-track::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .jfs-enhancer-switch input:checked ~ .jfs-enhancer-toggle-track::after {
    transform: translateX(12px);
  }

  /* Brightness/Volume OSD (left/right vertical bar) */
  .jfs-enhancer-osd {
    position: fixed;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(0,0,0,0.65);
    color: #fff;
    border-radius: 12px;
    padding: 18px 10px;
    width: 62px;
    min-height: 180px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    pointer-events: none;
    user-select: none;
    z-index: 99999;
    transition: opacity 0.3s;
  }
  .jfs-enhancer-osd--left  { left: 18%; }
  .jfs-enhancer-osd--right { right: 18%; }
  .jfs-enhancer-osd__icon   { font-size: 24px; line-height: 1; }
  .jfs-enhancer-osd__pct    { font-size: 15px; font-weight: bold; line-height: 1; }
  .jfs-enhancer-osd__label  { font-size: 11px; opacity: 0.75; line-height: 1; }
  .jfs-enhancer-osd__bar-track {
    width: 6px;
    height: 90px;
    background: rgba(255,255,255,0.25);
    border-radius: 3px;
    position: relative;
    overflow: hidden;
    flex-shrink: 0;
  }
  .jfs-enhancer-osd__bar-fill {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    background: #fff;
    border-radius: 3px;
    transition: height 0.1s;
  }

  /* Speed OSD + Seek OSD */
  .jfs-speed-osd,
  .jfs-seek-osd {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%,-50%);
    background: rgba(0,0,0,0.65);
    color: #fff;
    border-radius: 12px;
    padding: 10px 20px;
    pointer-events: none;
    user-select: none;
    z-index: 99999;
    text-align: center;
    white-space: nowrap;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .jfs-speed-osd__line1, .jfs-seek-osd__line1 {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.3;
  }
  .jfs-speed-osd__line2 {
    font-size: 13px;
    opacity: 0.85;
    line-height: 1.3;
    margin-top: 2px;
  }

  /* Seek Preview Thumb */
  .jfs-speed-osd__thumb-wrap {
    position: fixed;
    left: 50%;
    z-index: 99999;
    pointer-events: none;
    padding: 5px;
    background: rgba(10,10,10,0.5);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.65);
    display: none;
  }
  .jfs-speed-osd__thumb-img {
    display: block;
    border-radius: 6px;
    object-fit: contain;
    background-color: #000;
    width: clamp(120px, 20dvw, 320px);
    height: auto;
  }

  /* Seek ripple animation */
  .jfs-enhancer-ripple {
    position: fixed;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    z-index: 99999;
  }
  .jfs-enhancer-ripple-left  { left: 0; }
  .jfs-enhancer-ripple-right { right: 0; }
  .jfs-enhancer-ripple-bg {
    width: 150px;
    height: 220px;
    background: rgba(0,0,0,0.42);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    animation: jfs-ripple-fade 0.95s ease-out forwards;
  }
  .jfs-enhancer-ripple-right .jfs-enhancer-ripple-bg {
    border-radius: 110px 0 0 110px;
    padding-left: 16px;
  }
  .jfs-enhancer-ripple-left .jfs-enhancer-ripple-bg {
    border-radius: 0 110px 110px 0;
    padding-right: 16px;
  }
  .jfs-enhancer-ripple-arrows {
    display: flex;
    flex-direction: row;
    gap: 2px;
    height: 40px;
    align-items: center;
  }
  .jfs-enhancer-ripple-arrow {
    font-size: 36px;
    line-height: 1;
    color: #fff;
    display: inline-block;
    opacity: 0;
  }
  .jfs-enhancer-ripple-right .jfs-enhancer-ripple-arrow {
    animation: jfs-arrow-right 0.65s ease-in-out infinite;
  }
  .jfs-enhancer-ripple-left .jfs-enhancer-ripple-arrow {
    animation: jfs-arrow-left 0.65s ease-in-out infinite;
  }
  .jfs-enhancer-ripple-arrow:nth-child(1) { animation-delay: 0s; }
  .jfs-enhancer-ripple-arrow:nth-child(2) { animation-delay: 0.18s; }
  .jfs-enhancer-ripple-arrow:nth-child(3) { animation-delay: 0.36s; }
  .jfs-enhancer-ripple-label {
    color: #fff;
    font-size: 16px;
    font-weight: 600;
    text-shadow: 0 1px 3px rgba(0,0,0,0.6);
  }
  @keyframes jfs-arrow-right {
    0%   { opacity: 0; transform: translateX(-5px); }
    25%  { opacity: 1; transform: translateX(0); }
    75%  { opacity: 1; transform: translateX(5px); }
    100% { opacity: 0; transform: translateX(10px); }
  }
  @keyframes jfs-arrow-left {
    0%   { opacity: 0; transform: translateX(5px); }
    25%  { opacity: 1; transform: translateX(0); }
    75%  { opacity: 1; transform: translateX(-5px); }
    100% { opacity: 0; transform: translateX(-10px); }
  }
  @keyframes jfs-ripple-fade {
    0%   { opacity: 1; }
    65%  { opacity: 1; }
    100% { opacity: 0; }
  }
`

export function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = JELLYFIN_OVERRIDES
  document.head.appendChild(style)
}
