import { suite } from './routes'

type FiEntry = { ms: number; isKey: boolean; frameIndex: number }
type FiStreamItem = FiEntry | { fps: { num: number; den: number } }

export function frameInfoStreamer(itemId: string, centerMs: number): AsyncIterable<FiStreamItem> {
  const es = new EventSource(suite.frameInfoStream(itemId, centerMs))
  let done = false
  let error: unknown = null
  let pending: ((v: IteratorResult<FiStreamItem>) => void) | null = null
  const queue: IteratorResult<FiStreamItem>[] = []

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (Array.isArray(data)) {
        for (const item of data as FiEntry[]) queue.push({ value: item, done: false })
      } else if (data?.fps) {
        queue.push({ value: { fps: data.fps }, done: false })
        queue.push({ value: undefined as never, done: true })
        es.close()
        done = true
      }
    } catch { /* ignore */ }
    if (pending) { const p = pending; pending = null; p(queue.shift()!) }
  }
  es.onerror = () => {
    es.close()
    error = new Error('stream end')
    done = true
    if (pending) { const p = pending; pending = null; p({ value: undefined as never, done: true }) }
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<FiStreamItem> {
      return {
        next(): Promise<IteratorResult<FiStreamItem>> {
          if (queue.length > 0) return Promise.resolve(queue.shift()!)
          if (done) return Promise.resolve({ value: undefined as never, done: true })
          if (error) return Promise.reject(error)
          return new Promise(resolve => { pending = resolve })
        },
      }
    },
  }
}

export function prefetchStreamer(itemId: string, width: number, fiIdx: number[]): AsyncIterable<number> {
  const url = suite.frameExport.prefetchReady(itemId, width, fiIdx)
  const es = new EventSource(url)
  let done = false
  let pending: ((v: IteratorResult<number>) => void) | null = null
  const queue: IteratorResult<number>[] = []

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (data.done) {
        done = true; es.close()
        queue.push({ value: undefined as never, done: true })
      } else if (typeof data.frameReady === 'number') {
        queue.push({ value: data.frameReady, done: false })
      }
    } catch { /* ignore */ }
    if (pending) { const p = pending; pending = null; p(queue.shift()!) }
  }
  es.onerror = () => {
    es.close(); done = true
    if (pending) { const p = pending; pending = null; p({ value: undefined as never, done: true }) }
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<number> {
      return {
        next(): Promise<IteratorResult<number>> {
          if (queue.length > 0) return Promise.resolve(queue.shift()!)
          if (done) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise(resolve => { pending = resolve })
        },
      }
    },
  }
}
