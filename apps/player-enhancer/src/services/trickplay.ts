import { atom, getDefaultStore } from 'jotai'
const jstore = getDefaultStore()
function $val<T>(a: ReturnType<typeof atom<T>>) {
  return { get value(): T { return jstore.get(a) }, set value(v: T) { jstore.set(a, v) }, peek(): T { return jstore.get(a) } }
}

interface ThumbState {
  visible: boolean
  src: string
  top: string
  transform: string
}

const _sThumbState = atom<ThumbState>({
  visible: false,
  src: '',
  top: '0px',
  transform: 'translate(-50%, -50%)',
})
export const thumbStateAtom = _sThumbState
export const sThumbState = $val(_sThumbState)

interface SeekPreviewMeta {
  base: string;
  token: string;
}

const _cache = new Map<string, SeekPreviewMeta>();
let _pendingKey: string | null = null;

// Frames confirmed loaded into the browser cache (`${itemId}:${alignedMs}`)
const _loadedKeys = new Set<string>();
const _warmImages = new Map<string, HTMLImageElement>();

// Deduplicate prefetch: track recently-sent aligned keys to avoid flooding the server.
const _prefetchSent = new Map<string, number>();
const PREFETCH_DEDUP_MS = 200;

// SSE connection for ready-frame notifications (one per active video)
let _readyStreamEs: EventSource | null = null;
let _readyStreamItemId: string | null = null;

// Limit concurrent FETCH requests to 1 to avoid overwhelming the daemon on large files
let _fetchInFlight = false;

// Retry timer for SSE open attempts
let _initRetryTimer: ReturnType<typeof setTimeout> | null = null;

let _globalEnabled = true;

export function setTrickplayEnabled(enabled: boolean): void {
  _globalEnabled = enabled;
  if (!enabled) {
    hideTrickplayThumb();
    closeTrickplayStream();
  }
}

export function closeTrickplayStream(): void {
  if (_initRetryTimer) { clearTimeout(_initRetryTimer); _initRetryTimer = null; }
  if (_readyStreamEs) { _readyStreamEs.close(); _readyStreamEs = null; _readyStreamItemId = null; }
}

function getRawToken(): string {
  const ac = window.ApiClient;
  if (!ac) return '';
  return (typeof ac.accessToken === 'function' ? ac.accessToken() : ac._accessToken) ?? '';
}

function getServerAddress(): string {
  const ac = window.ApiClient;
  if (!ac) return '';
  return (typeof ac.serverAddress === 'function' ? ac.serverAddress() : ac._serverAddress) ?? '';
}

export function initTrickplay(getItemId: () => string, videoEl: HTMLVideoElement): void {
  if (_initRetryTimer) { clearTimeout(_initRetryTimer); _initRetryTimer = null; }

  const RETRY_DELAYS = [0, 1000, 2000, 3000];
  let attempt = 0;

  const tryOpen = (): void => {
    if (attempt >= RETRY_DELAYS.length) return;
    const delay = RETRY_DELAYS[attempt++];
    if (delay === 0) {
      doOpen();
    } else {
      _initRetryTimer = setTimeout(() => { _initRetryTimer = null; doOpen(); }, delay);
    }
  };

  const doOpen = (): void => {
    const id = getItemId();
    const meta = ensureMeta(id);
    if (meta && id) {
      openReadyStream(id, meta, videoEl);
    } else {
      tryOpen();
    }
  };

  tryOpen();
}

function ensureMeta(itemId: string): SeekPreviewMeta | undefined {
  if (!itemId) return undefined;
  if (!_cache.has(itemId)) {
    const base = getServerAddress();
    const token = getRawToken();
    if (base) _cache.set(itemId, { base, token });
  }
  return _cache.get(itemId);
}

function openReadyStream(itemId: string, meta: SeekPreviewMeta, videoEl: HTMLVideoElement): void {
  if (_readyStreamEs) {
    _readyStreamEs.close();
    _readyStreamEs = null;
    _readyStreamItemId = null;
    _loadedKeys.clear();
    _warmImages.clear();
  }

  const posMs = Math.floor((videoEl.currentTime || 0) * 1000);
  const url = `${meta.base}/JellyfinSuite/SeekPreview/${itemId}/ready-stream?positionMs=${posMs}&api_key=${meta.token}`;
  const es = new EventSource(url);
  _readyStreamEs = es;
  _readyStreamItemId = itemId;

  es.onmessage = (e) => {
    let posMs: number
    try { posMs = JSON.parse(e.data).frameReady } catch { posMs = Number(e.data) }
    if (!isFinite(posMs)) return;
    const key = `${itemId}:${posMs}`;
    if (_loadedKeys.has(key)) return;
    const img = new Image();
    img.onload = () => { _loadedKeys.add(key); _warmImages.set(key, img); };
    img.src = makeUrl(meta, itemId, posMs);
  };

  es.onerror = () => {
    es.close();
    if (_readyStreamEs === es) { _readyStreamEs = null; _readyStreamItemId = null; }
  };
}

function makeUrl(meta: SeekPreviewMeta, itemId: string, alignedMs: number): string {
  return `${meta.base}/JellyfinSuite/SeekPreview/${itemId}?positionMs=${alignedMs}&api_key=${meta.token}`;
}

export function showTrickplayThumb(
  posMs: number,
  itemId: string,
  videoEl: HTMLVideoElement,
  alignMs: number = 100,
  direction: 1 | -1 | 0 = 0,
): void {
  if (!_globalEnabled) return;
  const meta = ensureMeta(itemId);
  if (!meta) return;

  if (!_readyStreamEs || _readyStreamItemId !== itemId) openReadyStream(itemId, meta, videoEl);

  const rect = videoEl.getBoundingClientRect();
  const osd = document.querySelector<HTMLElement>('.jfs-seek-osd');
  let top: string, transform: string;
  if (osd) {
    const osdRect = osd.getBoundingClientRect();
    top = `${Math.round(osdRect.bottom + 8)}px`;
    transform = 'translate(-50%, 0)';
  } else {
    top = `${Math.round(rect.top + rect.height * 0.65)}px`;
    transform = 'translate(-50%, -50%)';
  }

  const aligned = Math.floor(posMs / alignMs) * alignMs;
  const exactKey = `${itemId}:${aligned}`;

  _pendingKey = exactKey;

  const exactUrl = makeUrl(meta, itemId, aligned);

  if (_loadedKeys.has(exactKey)) {
    sThumbState.value = { visible: true, src: exactUrl, top, transform };
    return;
  }

  // Fuzzy match: show nearest already-loaded frame
  const FUZZY_RANGE = 15000;
  let fuzzyFound = false;
  for (let d = 500; d <= FUZZY_RANGE; d += 500) {
    const fwd = aligned + d;
    const bwd = aligned - d;
    const first  = direction >= 0 ? fwd : bwd;
    const second = direction >= 0 ? bwd : fwd;
    if (_loadedKeys.has(`${itemId}:${first}`)) {
      sThumbState.value = { visible: true, src: makeUrl(meta, itemId, first), top, transform };
      fuzzyFound = true;
      break;
    }
    if (_loadedKeys.has(`${itemId}:${second}`)) {
      sThumbState.value = { visible: true, src: makeUrl(meta, itemId, second), top, transform };
      fuzzyFound = true;
      break;
    }
  }
  if (!fuzzyFound) {
    const lower30 = Math.floor(aligned / 30000) * 30000;
    const upper30 = lower30 + 30000;
    const candidates = direction > 0 ? [upper30, lower30]
      : direction < 0 ? [lower30, upper30]
      : (aligned - lower30 <= upper30 - aligned ? [lower30, upper30] : [upper30, lower30]);
    for (const c of candidates) {
      if (c >= 0 && _loadedKeys.has(`${itemId}:${c}`)) {
        sThumbState.value = { visible: true, src: makeUrl(meta, itemId, c), top, transform };
        fuzzyFound = true;
        break;
      }
    }
  }
  if (!fuzzyFound) {
    sThumbState.value = { ...sThumbState.peek(), visible: false };
  }

  if (_fetchInFlight) return;
  _fetchInFlight = true;
  const preload = new Image();
  preload.onload = () => {
    _fetchInFlight = false;
    _loadedKeys.add(exactKey);
    if (_pendingKey === exactKey) {
      sThumbState.value = { visible: true, src: exactUrl, top, transform };
    }
  };
  preload.onerror = () => { _fetchInFlight = false; };
  preload.src = exactUrl;
}

export function prefetchFrame(posMs: number, itemId: string): void {
  const meta = ensureMeta(itemId);
  if (!meta || posMs < 0) return;
  const aligned = Math.floor(posMs / 100) * 100;
  const key = `${itemId}:${aligned}`;
  if (_loadedKeys.has(key)) return;
  const now = Date.now();
  const last = _prefetchSent.get(key) ?? 0;
  if (now - last < PREFETCH_DEDUP_MS) return;
  _prefetchSent.set(key, now);
  const url = `${meta.base}/JellyfinSuite/SeekPreview/${itemId}?positionMs=${aligned}&prefetch=true&api_key=${meta.token}`;
  void fetch(url);
}

export function hideTrickplayThumb(): void {
  sThumbState.value = { ...sThumbState.peek(), visible: false };
  _pendingKey = null;
}
