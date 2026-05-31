import '../types/jellyfin';

interface ItemResponse {
  MediaSources?: Array<{
    MediaStreams?: Array<{
      Type?: string;
      RealFrameRate?: number;
      AverageFrameRate?: number;
    }>;
  }>;
}

const _cache = new Map<string, number>();

export async function getFps(itemId: string): Promise<number> {
  const cached = _cache.get(itemId);
  if (cached !== undefined) return cached;

  try {
    const data = (await window.ApiClient?.getJSON(
      `/Items/${itemId}?Fields=MediaSources`
    )) as ItemResponse | undefined;

    const videoStream = data?.MediaSources?.[0]?.MediaStreams?.find(
      (s) => s.Type === 'Video'
    );
    const fps = videoStream?.RealFrameRate ?? videoStream?.AverageFrameRate ?? 24;
    _cache.set(itemId, fps);
    return fps;
  } catch {
    return 24;
  }
}
