import { Api, Jellyfin } from '@jellyfin/sdk'

declare global {
  interface Window {
    ApiClient?: {
      serverAddress(): string
      accessToken(): string
      getCurrentUserId(): string
      getUrl(name: string, params?: Record<string, string>): string
      ajax(request: { url: string; type?: string; dataType?: string }): Promise<unknown>
      getItem(userId: string, itemId: string): Promise<unknown>
      serverId(): string
    }
  }
}

let _api: Api | null = null

export function getApi(): Api {
  if (_api) return _api

  const client = window.ApiClient
  if (!client) {
    throw new Error('window.ApiClient is not available. Access this page through Jellyfin Web.')
  }

  const jellyfin = new Jellyfin({
    clientInfo: { name: 'Jellyfin Suite', version: '1.0.0' },
    deviceInfo: { name: 'Browser', id: 'jellyfin-suite-browser' },
  })

  _api = jellyfin.createApi(client.serverAddress(), client.accessToken())
  return _api
}

export function getCurrentUserId(): string {
  if (!window.ApiClient) {
    throw new Error('window.ApiClient is not available.')
  }
  return window.ApiClient.getCurrentUserId()
}
