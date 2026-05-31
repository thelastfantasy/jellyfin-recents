import { useState, useEffect, useCallback } from 'preact/hooks'
import { MdGif } from 'react-icons/md'
import { Popover } from './Popover'
import { getTasks, addTask, updateTask, removeTask, ExportTaskEntry } from '../state/frameExportJobStore'
import { listTasks, deleteTask, withAuth } from '../api/frameExportQueueApi'
import { useLocale } from '../i18n/context'
import { FrameExportJobRunner } from './FrameExportJobRunner'

export function FrameExportQueueWidget() {
  const { t } = useLocale()
  const [tasks, setTasks] = useState<ExportTaskEntry[]>(getTasks)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    listTasks().then(serverTasks => {
      const localIds = new Set(getTasks().map(e => e.taskId))
      for (const st of serverTasks) {
        if (localIds.has(st.taskId)) continue
        addTask(st.taskId, st.itemId, st.itemTitle, st.type, st.createdAt || undefined)
        updateTask(st.taskId, {
          status: (st.status === 'pending' || st.status === 'running') ? 'running'
            : st.status as ExportTaskEntry['status'],
          percent:   st.status === 'complete' ? 100 : 0,
          resultUrl: st.resultUrl ?? undefined,
          fileSize:  st.fileSize  ?? undefined,
          error:     st.error     ?? undefined,
        })
      }
    })
  }, [])

  useEffect(() => {
    function handler() { setTasks(getTasks()) }
    window.addEventListener('jfs-export-tasks-changed', handler)
    return () => window.removeEventListener('jfs-export-tasks-changed', handler)
  }, [])

  const handleDelete = useCallback(async (task: ExportTaskEntry) => {
    await deleteTask(task.taskId).catch(() => {})
    removeTask(task.taskId)
  }, [])

  const badgeCount = tasks.filter(t => t.status === 'running' || t.status === 'error').length

  if (tasks.length === 0) return null

  const runningTasks = tasks.filter(t => t.status === 'running')

  return (
    <>
      {runningTasks.map(t => <FrameExportJobRunner key={t.taskId} taskId={t.taskId} />)}
      <button
        class="jfs-export-widget"
        onClick={() => setOpen(v => !v)}
        title={t.exportQueue}
        aria-label={t.exportQueue}
      >
        <MdGif size={26} />
        {badgeCount > 0 && (
          <span class="jfs-export-widget__badge">{badgeCount}</span>
        )}
      </button>

      <Popover open={open} onClose={() => setOpen(false)}>
        <div class="jfs-export-popover">
          <div class="jfs-queue-popover__header">
            <span>{t.exportQueue}</span>
            <button class="jfs-queue-popover__header-close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div class="jfs-queue-popover__list">
            {[...tasks].sort((a, b) => b.addedAt - a.addedAt).map(task => (
              <div
                key={task.taskId}
                class={`jfs-queue-popover__item jfs-queue-popover__item--${
                  task.status === 'complete' ? 'done' : task.status
                }`}
              >
                <div class="jfs-queue-popover__item-header">
                  <span class="jfs-queue-popover__title" title={task.itemTitle}>
                    <span class="jfs-export-type-badge">{task.type}</span>
                    {task.itemTitle}
                  </span>
                  <button
                    class="jfs-queue-popover__delete"
                    onClick={() => handleDelete(task)}
                    title={t.exportQueueRemove}
                  >✕</button>
                </div>

                {task.status === 'running' && (
                  <div class="jfs-queue-popover__bar">
                    <div
                      class="jfs-queue-popover__bar-fill jfs-export-bar-fill"
                      style={{ width: `${Math.round(task.percent)}%` }}
                    />
                    <span class="jfs-queue-popover__bar-text">
                      {Math.round(task.percent)}%
                    </span>
                  </div>
                )}

                {task.status === 'error' && (
                  <div class="jfs-queue-popover__status-text jfs-queue-popover__status-text--error">
                    {task.error ?? 'Error'}
                  </div>
                )}

                {task.status === 'complete' && task.resultUrl && (() => {
                  const url = withAuth(task.resultUrl)
                  const filename = task.resultUrl.split('/').pop() ?? 'output'
                  const sizeMb = task.fileSize ? ` (${(task.fileSize / 1024 / 1024).toFixed(1)} MB)` : ''
                  return (
                    <>
                      <img src={url} alt={task.itemTitle} class="jfs-queue-popover__thumb" />
                      <a href={url} download={filename} class="jfs-export-download-btn">
                        {t.exportQueueDownload}{sizeMb}
                      </a>
                    </>
                  )
                })()}
              </div>
            ))}
          </div>
        </div>
      </Popover>
    </>
  )
}
