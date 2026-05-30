import { injectStyles } from './styles';
import { createFrameStepButtons, stepFrames } from './framestepper';
import { takeScreenshot } from './screenshot';
import { initGestures, setSeekSeconds } from './gestures';
import { initLongPress } from './long-press';
import { initTrickplay, setTrickplayEnabled } from './trickplay';
import { t } from './i18n';
import { ICON_SCREENSHOT, ICON_FRAME_EXPORT } from './icons';

const ROOT_ID = 'jfs-enhancer-root';

let _currentVideoEl: HTMLVideoElement | null = null;
let _cachedItemId = '';
// URL-based item ID captured when the video element switches; cleared once video src catches up.
// Prevents stale currentSrc from leaking the previous video's item ID during transition.
let _pendingItemId = '';
let _speedRate = 2.0;
let _trickplayEnabled = true;

async function loadGestureConfig(): Promise<void> {
  // Jellyfin initializes ApiClient asynchronously from localStorage; poll until the
  // access token is available (up to 5s) so we fetch user-specific settings, not defaults.
  let ac = (window as any).ApiClient;
  let token: string = (typeof ac?.accessToken === 'function' ? ac.accessToken() : ac?._accessToken) ?? '';
  for (let i = 0; i < 10 && !token; i++) {
    await new Promise<void>(r => setTimeout(r, 500));
    ac = (window as any).ApiClient;
    token = (typeof ac?.accessToken === 'function' ? ac.accessToken() : ac?._accessToken) ?? '';
  }
  if (!token) return; // still no token → keep defaults
  try {
    const res = await fetch(`/JellyfinSuite/PlayerEnhancer/Config?api_key=${encodeURIComponent(token)}`);
    if (!res.ok) return;
    const cfg = await res.json() as { trickplayEnabled?: boolean; seekSeconds?: number; speedRate?: number };
    if (typeof cfg.trickplayEnabled === 'boolean') {
      _trickplayEnabled = cfg.trickplayEnabled;
      setTrickplayEnabled(_trickplayEnabled);
    }
    if (typeof cfg.seekSeconds === 'number' && cfg.seekSeconds > 0) {
      setSeekSeconds(cfg.seekSeconds);
    }
    if (typeof cfg.speedRate === 'number' && cfg.speedRate >= 1.25) {
      _speedRate = cfg.speedRate;
    }
  } catch {
    // keep default
  }
}

function extractItemIdFromSearch(search: string): string {
  return new URLSearchParams(search).get('id') ?? '';
}

function extractItemIdFromUrl(url: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex < 0) return '';
  return extractItemIdFromSearch(url.slice(qIndex + 1));
}

// Jellyfin video src: /Videos/{itemId}/master.m3u8?...
function extractItemIdFromVideoSrc(src: string): string {
  const m = src.match(/\/Videos\/([0-9a-f-]{32,36})\//i);
  return m?.[1] ?? '';
}

function getItemId(): string {
  const videoId = _currentVideoEl
    ? extractItemIdFromVideoSrc(_currentVideoEl.currentSrc || _currentVideoEl.src)
    : '';

  // Transition mode: video element just switched but currentSrc still holds the old stream.
  // Return the URL-captured pending ID until video src catches up.
  if (_pendingItemId) {
    if (videoId === _pendingItemId) {
      _pendingItemId = ''; // video src confirmed — transition complete
    } else {
      return _pendingItemId;
    }
  }

  // Steady state: prefer videoId (avoids parent series/season ID that URL can carry)
  return videoId
    || extractItemIdFromUrl(window.location.href)
    || extractItemIdFromUrl(window.location.hash)
    || _cachedItemId;
}

export function initInjector(): void {
  injectStyles();
  loadGestureConfig();
  window.addEventListener('jfs:seekSecondsChanged', (e: Event) => {
    const { seconds } = (e as CustomEvent<{ seconds: number }>).detail;
    if (typeof seconds === 'number' && seconds > 0) setSeekSeconds(seconds);
  });
  window.addEventListener('jfs:speedRateChanged', (e: Event) => {
    const { rate } = (e as CustomEvent<{ rate: number }>).detail;
    if (typeof rate === 'number' && rate >= 1.25) _speedRate = rate;
  });
  window.addEventListener('jfs:trickplayEnabledChanged', (e: Event) => {
    const { enabled } = (e as CustomEvent<{ enabled: boolean }>).detail;
    if (typeof enabled !== 'boolean') return;
    _trickplayEnabled = enabled;
    setTrickplayEnabled(enabled);
    if (enabled && _currentVideoEl) initTrickplay(getItemId, _currentVideoEl);
  });

  // Jellyfin uses @remix-run/router with history.pushState — no hashchange fires.
  // Intercept pushState to capture item ID before the URL changes.
  const _origPushState = history.pushState.bind(history);
  history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
    const id = extractItemIdFromUrl(window.location.href);
    if (id) _cachedItemId = id;
    return _origPushState(data, unused, url);
  };

  const observer = new MutationObserver(() => tryInject());
  observer.observe(document.body, { childList: true, subtree: true });
  tryInject();
}

function tryInject(): void {
  const container = document.querySelector('.videoPlayerContainer');
  if (!container) return;

  const videoEl = container.querySelector<HTMLVideoElement>('video.htmlvideoplayer');
  if (!videoEl) return;

  // Reset filter and re-init gestures when video element changes
  if (videoEl !== _currentVideoEl) {
    if (_currentVideoEl) _currentVideoEl.style.filter = '';
    _currentVideoEl = videoEl;
    // Capture URL item ID now: currentSrc may still hold the old stream during transition
    _pendingItemId = extractItemIdFromUrl(window.location.href)
      || extractItemIdFromUrl(window.location.hash)
      || '';
    initGestures(videoEl, getItemId);
    initLongPress(videoEl, () => _speedRate);
    if (_trickplayEnabled) initTrickplay(getItemId, videoEl);
  }

  // Ensure root marker exists (idempotent)
  if (!document.getElementById(ROOT_ID)) {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    container.appendChild(root);
  }

  // Inject OSD buttons; presence-check so we re-inject if Jellyfin rebuilds the OSD
  const osdButtons = document.querySelector<HTMLElement>(
    '.osdControls .buttons.focuscontainer-x'
  );
  if (osdButtons && !osdButtons.querySelector('.jfs-enhancer-framestep-wrap')) {
    injectPlayerButtons(osdButtons, videoEl);
  }
}


function injectPlayerButtons(
  osdButtons: HTMLElement,
  videoEl: HTMLVideoElement
): void {
  // ── Frame step buttons ──────────────────────────────────────────────────
  const frameStepWrap = createFrameStepButtons();
  const [btnBack10, btnBack1, btnFwd1, btnFwd10] = Array.from(
    frameStepWrap.querySelectorAll('button')
  );

  btnBack10.addEventListener('click', () => stepFrames(videoEl, -10, getItemId()));
  btnBack1.addEventListener('click',  () => stepFrames(videoEl, -1,  getItemId()));
  btnFwd1.addEventListener('click',   () => stepFrames(videoEl,  1,  getItemId()));
  btnFwd10.addEventListener('click',  () => stepFrames(videoEl,  10, getItemId()));

  // ── Screenshot button + subtitle switch ────────────────────────────────
  // Firefox for Android cannot capture hardware-decoded video frames — skip screenshot UI
  const ua = navigator.userAgent;
  const isFirefoxMobile = ua.includes('Firefox') && ua.includes('Android') && !ua.includes('Chrome');
  if (isFirefoxMobile) {
    const dirLtr = osdButtons.querySelector<HTMLElement>('div[dir="ltr"]');
    if (dirLtr) dirLtr.after(frameStepWrap);
    else osdButtons.append(frameStepWrap);
    return;
  }

  const screenshotWrap = document.createElement('div');
  screenshotWrap.className = 'jfs-enhancer-screenshot-wrap';

  const screenshotBtn = document.createElement('button');
  screenshotBtn.className = 'jfs-enhancer-btn';
  screenshotBtn.title = t('screenshot.button');
  screenshotBtn.innerHTML = ICON_SCREENSHOT;

  const switchLabel = document.createElement('label');
  switchLabel.className = 'jfs-enhancer-switch';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = false;
  const toggleTrack = document.createElement('span');
  toggleTrack.className = 'jfs-enhancer-toggle-track';
  switchLabel.appendChild(checkbox);
  switchLabel.appendChild(toggleTrack);
  switchLabel.appendChild(document.createTextNode(t('screenshot.subtitles')));

  screenshotBtn.addEventListener('click', () => {
    const title = document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || undefined;
    takeScreenshot(videoEl, checkbox.checked, title, getItemId());
  });

  // Firefox mobile 上 label>checkbox 的 touch 联动不可靠，直接处理 touchend
  switchLabel.addEventListener('touchend', (e) => {
    e.preventDefault(); // 阻止合成 click 造成二次触发
    checkbox.checked = !checkbox.checked;
  }, { passive: false });

  screenshotWrap.appendChild(screenshotBtn);
  screenshotWrap.appendChild(switchLabel);

  // Show subtitle toggle only when subtitles are actually active
  function updateSubtitleToggleVisibility() {
    const hasAssSubtitles = !!document.querySelector('.libassjs-canvas-parent canvas');
    const srtEl = document.querySelector('.videoSubtitles');
    const hasSrtSubtitles = !!srtEl && srtEl.textContent!.trim().length > 0;
    const active = hasAssSubtitles || hasSrtSubtitles;
    switchLabel.style.display = active ? '' : 'none';
    screenshotWrap.classList.toggle('jfs-has-subtitles', active);
  }
  updateSubtitleToggleVisibility();
  const subtitleObserver = new MutationObserver(updateSubtitleToggleVisibility);
  subtitleObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

  // ── Frame Export button ──────────────────────────────────────────────────
  const frameExportBtn = document.createElement('button');
  frameExportBtn.className = 'jfs-enhancer-btn';
  frameExportBtn.title = t('frameExport.button');
  frameExportBtn.innerHTML = ICON_FRAME_EXPORT;
  frameExportBtn.addEventListener('click', () => {
    const itemId = getItemId();
    if (!itemId) return;
    // Placeholder: openFrameExportModal will be implemented in Phase 3 (US1)
    const videoEl = _currentVideoEl;
    if (!videoEl) return;
    import('./frame-export').then(m => m.openFrameExportModal(videoEl, itemId));
  });

  // Insert after the screenshot wrap
  const dirLtr = osdButtons.querySelector<HTMLElement>('div[dir="ltr"]');
  if (dirLtr) {
    dirLtr.after(frameStepWrap);
    frameStepWrap.after(screenshotWrap);
    screenshotWrap.after(frameExportBtn);
  } else {
    osdButtons.append(frameStepWrap);
    osdButtons.append(screenshotWrap);
    osdButtons.append(frameExportBtn);
  }

}
