import { getFps } from '../lib/fps-cache'
import { clamp } from '../lib/utils'

export async function stepFrames(
  videoEl: HTMLVideoElement,
  delta: number,
  itemId: string
): Promise<void> {
  const fps = await getFps(itemId);
  if (!videoEl.paused) videoEl.pause();
  videoEl.currentTime = clamp(
    videoEl.currentTime + delta / fps,
    0,
    videoEl.duration || 0
  );
}
