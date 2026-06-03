import { useCallback,useEffect, useState } from 'react'
import { MdGif } from 'react-icons/md'

import { deleteTask, listTasks, withAuth } from '../api/frameExportQueueApi'
import { useLocale } from '../i18n/context'
import type { ExportTaskEntry} from '../state/frameExportJobStore';
import { addTask,getTasks, removeTask, updateTask } from '../state/frameExportJobStore'
import { downloadBlob } from '../utils/download'
import { FrameExportJobRunner } from './FrameExportJobRunner'
import { Lightbox } from './Lightbox'
import { Popover } from './Popover'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function extFromUrl(url: string): string {
  const seg = url.split('.').pop() ?? ''
  return seg.toUpperCase()
}

export function FrameExportQueueWidget() {
  const { t } = useLocale()
  const [tasks, setTasks] = useState<ExportTaskEntry[]>(getTasks)
  const [open, setOpen] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [lightboxTaskId, setLightboxTaskId] = useState<string | null>(null)

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
        className="jfs-export-widget"
        onClick={() => setOpen(v => !v)}
        title={t.clipWorkshopQueue}
        aria-label={t.clipWorkshopQueue}
      >
        <MdGif size={26} />
        {badgeCount > 0 && (
          <span className="jfs-export-widget__badge">{badgeCount}</span>
        )}
      </button>

      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="jfs-export-popover">
          <div className="jfs-queue-popover__header">
            <span>{t.clipWorkshopQueue}</span>
            <button className="jfs-queue-popover__header-close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="jfs-queue-popover__list">
            {[...tasks].sort((a, b) => b.addedAt - a.addedAt).map(task => (
              <div
                key={task.taskId}
                className={`jfs-queue-popover__item jfs-queue-popover__item--${
                  task.status === 'complete' ? 'done' : task.status
                }`}
              >
                <div className="jfs-queue-popover__item-header">
                  <span className="jfs-queue-popover__title" title={task.itemTitle}>
                    <span className="jfs-export-type-badge">{task.type.toUpperCase()}</span>
                    {task.resultUrl && (
                      <>
                        <span className="jfs-export-type-badge jfs-export-type-badge--fmt">
                          {extFromUrl(task.resultUrl)}
                        </span>
                        {task.fileSize != null && (
                          <span className="jfs-export-type-badge jfs-export-type-badge--size">
                            {formatSize(task.fileSize)}
                          </span>
                        )}
                      </>
                    )}
                    {task.itemTitle}
                  </span>
                  <button
                    className="jfs-queue-popover__delete"
                    onClick={() => handleDelete(task)}
                    title={t.exportQueueRemove}
                  >✕</button>
                </div>

                {task.status === 'running' && (
                  <div className="jfs-queue-popover__bar">
                    <div
                      className="jfs-queue-popover__bar-fill jfs-export-bar-fill"
                      style={{ width: `${Math.round(task.percent)}%` }}
                    />
                    <span className="jfs-queue-popover__bar-text">
                      {Math.round(task.percent)}%
                    </span>
                  </div>
                )}

                {task.status === 'error' && (
                  <div className="jfs-queue-popover__status-text jfs-queue-popover__status-text--error">
                    {task.error ?? 'Error'}
                  </div>
                )}

                {task.status === 'complete' && task.resultUrl && (() => {
                  const url = withAuth(task.resultUrl)
                  const filename = task.resultUrl.split('/').pop() ?? 'output'
                  return (
                    <>
                      <img
                        src={url}
                        alt={task.itemTitle}
                        className="jfs-queue-popover__thumb"
                        onClick={() => { setLightboxSrc(url); setLightboxTaskId(task.taskId) }}
                      />
                      <a href={url} download={filename} className="jfs-export-download-btn">
                        {t.exportQueueDownload}
                      </a>
                    </>
                  )
                })()}
              </div>
            ))}
          </div>
        </div>
      </Popover>

      {lightboxSrc && (
        <Lightbox
          src={lightboxSrc}
          alt="Export result"
          onClose={() => { setLightboxSrc(null); setLightboxTaskId(null) }}
          onDownload={() => lightboxSrc && downloadBlob(lightboxSrc, `export-${lightboxTaskId}.${lightboxSrc.split('.').pop()}`)}
          onDelete={lightboxTaskId ? () => {
            const task = tasks.find(t => t.taskId === lightboxTaskId)
            if (task) handleDelete(task)
            setLightboxSrc(null)
            setLightboxTaskId(null)
          } : undefined}
        />
      )}
    </>
  )
}
