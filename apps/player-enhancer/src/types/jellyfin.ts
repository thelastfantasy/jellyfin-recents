export interface MediaStream {
  Type: 'Video' | 'Audio' | 'Subtitle' | string;
  RealFrameRate?: number;
  AverageFrameRate?: number;
}

export interface MediaSource {
  MediaStreams?: MediaStream[];
}

export interface PlaybackItem {
  Id: string;
  Name?: string;
  MediaSources?: MediaSource[];
}

export interface PlaybackManager {
  currentItem(): PlaybackItem | null | undefined;
}

export interface JellyfinEvents {
  on(target: unknown, event: string, fn: (...args: unknown[]) => void): void;
  off(target: unknown, event: string, fn: (...args: unknown[]) => void): void;
}

export interface JellyfinPluginDeps {
  playbackManager: PlaybackManager;
  events: JellyfinEvents;
}

declare global {
  interface Window {
    ApiClient?: {
      serverAddress(): string;
      accessToken(): string;
      getCurrentUserId(): string;
      getUrl(name: string, params?: Record<string, string>): string;
      ajax(req: { url: string; type?: string; dataType?: string }): Promise<unknown>;
      getJSON(url: string): Promise<unknown>;
      getCurrentUser(): Promise<{ Policy?: { IsAdministrator?: boolean } }>;
    };
  }
}
