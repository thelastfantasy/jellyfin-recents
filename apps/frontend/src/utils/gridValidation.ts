export const MIN_SPACING_SECS = 2

/** Returns true when the grid fits within the video with ≥2 s per frame. */
export function isGridValid(rows: number, cols: number, durationSecs: number): boolean {
  const frameCount = rows * cols
  if (frameCount === 0) return false
  return durationSecs / frameCount >= MIN_SPACING_SECS
}

/** Maximum number of frames allowed for a given duration. */
export function maxFrames(durationSecs: number): number {
  return Math.floor(durationSecs / MIN_SPACING_SECS)
}
