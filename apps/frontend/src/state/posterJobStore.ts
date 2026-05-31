export interface JobEntry {
  jobId: string
  itemId: string
  itemTitle: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  total: number
  imageUrl?: string
  error?: string
  addedAt: number
}

const _jobs = new Map<string, JobEntry>()

function notify(): void {
  window.dispatchEvent(new CustomEvent('jfs-poster-jobs-changed'))
}

export function addJob(jobId: string, itemId: string, itemTitle: string, addedAt?: number): void {
  _jobs.set(jobId, { jobId, itemId, itemTitle, status: 'running', progress: 0, total: 0, addedAt: addedAt ?? Date.now() })
  notify()
}

export function updateJob(jobId: string, patch: Partial<Omit<JobEntry, 'jobId'>>): void {
  const existing = _jobs.get(jobId)
  if (!existing) return
  Object.assign(existing, patch)
  notify()
}

export function removeJob(jobId: string): void {
  _jobs.delete(jobId)
  notify()
}

export function getJobs(): JobEntry[] {
  return Array.from(_jobs.values())
}
