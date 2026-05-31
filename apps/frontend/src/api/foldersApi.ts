import { getCurrentUserId } from './jellyfinClient'

export interface AncestorEntry {
  Id: string
  Name: string
  ServerId: string
}

export async function getFolderViewEnabled(): Promise<boolean> {
  if (!window.ApiClient) return false
  try {
    const url = window.ApiClient.getUrl('System/Configuration')
    const data = (await window.ApiClient.ajax({ url, type: 'GET', dataType: 'json' })) as {
      EnableFolderView?: boolean
    }
    return data.EnableFolderView === true
  } catch {
    return false
  }
}

export async function getItemAncestors(itemId: string): Promise<AncestorEntry[]> {
  if (!window.ApiClient) return []
  try {
    const userId = getCurrentUserId()
    const url = window.ApiClient.getUrl(`Items/${itemId}/Ancestors`, { userId })
    const data = await window.ApiClient.ajax({ url, type: 'GET', dataType: 'json' }) as AncestorEntry[]
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
