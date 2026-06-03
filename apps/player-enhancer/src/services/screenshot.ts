import { t } from '../lib/i18n'
import { showToast } from '../components/Toast'
import { fetchItemName } from '../api/jellyfinApi'
import { frameStartMsQuery } from '../api/seekPreviewApi'
import { queryClient } from '../core/queryClient'
export { fetchItemName }

function sanitize(name: string): string {
  return name.replace(/[^\w一-鿿぀-ヿ가-힯\- ]/g, '_').trim() || 'screenshot';
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function hasContent(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  // Sample 5 points; any non-transparent pixel means we captured something
  const pts: [number, number][] = [
    [w >> 1, h >> 1],
    [w >> 2, h >> 2], [(3 * w) >> 2, h >> 2],
    [w >> 2, (3 * h) >> 2], [(3 * w) >> 2, (3 * h) >> 2],
  ];
  return pts.some(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3] > 0);
}

async function drawVideoFrame(
  videoEl: HTMLVideoElement,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): Promise<void> {
  type AnyWin = Record<string, unknown>;
  type AnyEl = Record<string, unknown>;

  // Path 1: captureStream + ImageCapture — handles hardware-decoded GPU frames
  const hasCapture = typeof (videoEl as unknown as AnyEl).captureStream === 'function';
  const hasImageCapture = typeof (window as unknown as AnyWin).ImageCapture === 'function';
  if (hasCapture && hasImageCapture) {
    let track: MediaStreamTrack | undefined;
    try {
      const stream = (videoEl as unknown as { captureStream(): MediaStream }).captureStream();
      track = stream.getVideoTracks()[0];
      if (track) {
        type IC = { grabFrame(): Promise<ImageBitmap> };
        const ic = new (window as unknown as { ImageCapture: new (t: MediaStreamTrack) => IC }).ImageCapture(track);
        // Give the stream one animation frame to produce a live frame
        await new Promise(r => requestAnimationFrame(r));
        const bmp = await ic.grabFrame();
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        if (hasContent(ctx, w, h)) return;
        ctx.clearRect(0, 0, w, h);
      }
    } catch { /* fall through */ } finally {
      track?.stop();
    }
  }

  // Path 2: requestVideoFrameCallback — fires at frame-presentation time
  if (typeof (videoEl as unknown as AnyEl).requestVideoFrameCallback === 'function') {
    try {
      await new Promise<void>((resolve, reject) => {
        (videoEl as unknown as { requestVideoFrameCallback(cb: () => void): void })
          .requestVideoFrameCallback(() => {
            try { ctx.drawImage(videoEl, 0, 0, w, h); resolve(); }
            catch (e) { reject(e); }
          });
      });
      if (hasContent(ctx, w, h)) return;
      ctx.clearRect(0, 0, w, h);
    } catch { /* fall through */ }
  }

  // Path 3: createImageBitmap — dedicated frame-capture path
  try {
    const bmp = await createImageBitmap(videoEl);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    if (hasContent(ctx, w, h)) return;
    ctx.clearRect(0, 0, w, h);
  } catch { /* fall through */ }

  // Path 4: direct drawImage (last resort)
  ctx.drawImage(videoEl, 0, 0, w, h);
}

export async function takeScreenshot(
  videoEl: HTMLVideoElement,
  includeSubtitles: boolean,
  itemTitle?: string,
  itemId?: string
): Promise<void> {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) return;

  const posMs = Math.round(videoEl.currentTime * 1000);
  // Fetch item name from API (episode Name, not series name from document.title).
  // Concurrently with canvas capture; falls back to passed itemTitle.
  const itemNamePromise = itemId ? fetchItemName(itemId) : Promise.resolve(null);
  // Start frame-info fetch concurrently with canvas capture; 5 s timeout, silently falls back.
  const frameStartMsPromise = itemId ? queryClient.fetchQuery(frameStartMsQuery(itemId, posMs)) : Promise.resolve(null);

  // DOM-attached canvas works around Firefox Android hardware-decode black-frame bug
  // (OffscreenCanvas cannot read hardware-decoded frames on Firefox for Android)
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none;';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }

  try {
    await drawVideoFrame(videoEl, ctx, w, h);
  } catch (e) {
    canvas.remove();
    if (e instanceof DOMException && e.name === 'SecurityError') {
      showToast(t('screenshot.drm'));
      return;
    }
    throw e;
  }

  // Detect hardware-decode failure: all paths produced a transparent frame
  if (!hasContent(ctx, w, h)) {
    canvas.remove();
    showToast(t('screenshot.hwdecode'));
    return;
  }

  if (includeSubtitles) {
    // ASS/SSA via libass canvas
    const assCanvas = document.querySelector<HTMLCanvasElement>(
      '.libassjs-canvas-parent canvas'
    );
    if (assCanvas) {
      try { ctx.drawImage(assCanvas, 0, 0, w, h); } catch { /* cross-origin guard */ }
    }
    // SRT/VTT native ::cue — cannot be captured by Canvas API, silently skipped
  }

  const [blob, frameStartMs, itemName] = await Promise.all([
    new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png')),
    frameStartMsPromise.catch(() => null),
    itemNamePromise.catch(() => null),
  ]);
  canvas.remove();

  if (!blob) throw new Error('toBlob returned null');
  const title = sanitize(itemName ?? itemTitle ?? 'screenshot');
  const ts = frameStartMs ?? posMs;
  const hh = String(Math.floor(ts / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((ts % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((ts % 60000) / 1000)).padStart(2, '0');
  const ms = String(ts % 1000).padStart(3, '0');
  downloadBlob(blob, `jellyfin-screenshot-${title}-${hh}-${mm}-${ss}-${ms}.png`);
}
