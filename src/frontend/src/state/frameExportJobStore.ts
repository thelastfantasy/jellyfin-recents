export interface ExportTaskEntry {
  taskId: string
  itemId: string
  itemTitle: string
  type: 'animate' | 'stitch'
  status: 'running' | 'complete' | 'error' | 'cancelled'
  percent: number
  resultUrl?: string
  fileSize?: number
  error?: string
  addedAt: number
}

const _tasks = new Map<string, ExportTaskEntry>()

function notify(): void {
  window.dispatchEvent(new CustomEvent('jfs-export-tasks-changed'))
}

export function addTask(
  taskId: string, itemId: string, itemTitle: string,
  type: 'animate' | 'stitch', addedAt?: number
): void {
  _tasks.set(taskId, {
    taskId, itemId, itemTitle, type,
    status: 'running', percent: 0, addedAt: addedAt ?? Date.now(),
  })
  notify()
}

export function updateTask(taskId: string, patch: Partial<Omit<ExportTaskEntry, 'taskId'>>): void {
  const existing = _tasks.get(taskId)
  if (!existing) return
  Object.assign(existing, patch)
  notify()
}

export function removeTask(taskId: string): void {
  _tasks.delete(taskId)
  notify()
}

export function getTasks(): ExportTaskEntry[] {
  return Array.from(_tasks.values())
}
