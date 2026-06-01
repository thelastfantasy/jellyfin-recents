import { useState, useEffect, useCallback } from 'react'

interface CacheEntry<T> {
  data: T
  error: unknown
  status: 'loading' | 'success' | 'error'
  ts: number
}

const _cache = new Map<string, CacheEntry<unknown>>()

export interface UseQueryResult<T> {
  data: T | null
  isLoading: boolean
  error: unknown | null
  refetch: () => void
}

export function useQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  { staleMs = 30_000, enabled = true }: { staleMs?: number; enabled?: boolean } = {},
): UseQueryResult<T> {
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    if (!enabled) return

    const existing = _cache.get(key)
    if (existing?.status === 'success' && Date.now() - existing.ts < staleMs) {
      return
    }
    if (existing?.status === 'loading') {
      return
    }

    let cancelled = false
    const promise = fetcher()
    _cache.set(key, { data: undefined as unknown as T, error: null, status: 'loading', ts: Date.now() })
    // Schedule re-render via microtask to avoid sync setState in effect
    Promise.resolve().then(() => forceUpdate(n => n + 1))

    promise.then(d => {
      if (cancelled) return
      _cache.set(key, { data: d, error: null, status: 'success', ts: Date.now() })
      forceUpdate(n => n + 1)
    }).catch(e => {
      if (cancelled) return
      _cache.set(key, { data: undefined as unknown as T, error: e, status: 'error', ts: Date.now() })
      forceUpdate(n => n + 1)
    })

    return () => { cancelled = true }
  }, [key, enabled])

  const cached = _cache.get(key)
  if (!cached || cached.status === 'loading') {
    return { data: null, isLoading: true, error: null, refetch: () => { _cache.delete(key); forceUpdate(n => n + 1) } }
  }
  if (cached.status === 'error') {
    return { data: null, isLoading: false, error: cached.error, refetch: () => { _cache.delete(key); forceUpdate(n => n + 1) } }
  }
  return { data: cached.data as T, isLoading: false, error: null, refetch: () => { _cache.delete(key); forceUpdate(n => n + 1) } }
}

export function useMutation<T, V = void>(
  fn: (vars: V) => Promise<T>,
  opts?: { onSuccess?: (data: T) => void; onError?: (err: unknown) => void },
) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const mutate = useCallback(async (vars: V): Promise<T> => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await fn(vars)
      opts?.onSuccess?.(data)
      return data
    } catch (e) {
      setError(e)
      opts?.onError?.(e)
      throw e
    } finally {
      setIsLoading(false)
    }
  }, [fn])

  return { mutate, isLoading, error }
}


