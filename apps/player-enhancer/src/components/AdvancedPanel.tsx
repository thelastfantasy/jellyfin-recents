import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import type { ChangeEvent } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'

import {
  activateOrtVersionMutation,
  devicesQuery,
  downloadModelMutation,
  downloadOrtVersionMutation,
  hwDecodeSettingsQuery,
  modelsQuery,
  openModelDownloadProgressStream,
  openOrtVersionDownloadProgressStream,
  ortVersionsQuery,
  updateHwDecodeSettingsMutation,
} from '../api/frameExportApi'
import { exportTypeAtom, settingsAtom, updateSettings } from '../core/state'
import { t } from '../lib/i18n'
import { formatBytes } from '../lib/utils'

const MODEL_FAMILIES = [
  { id: 'lightglue', fallbackLabel: 'LightGlue' },
  { id: 'efficient-loftr', fallbackLabel: 'EfficientLoFTR' },
]

interface PendingDownload {
  family: string
  version: string
  fileSizeBytes: number | null
}

export function AdvancedPanel() {
  const st = useAtomValue(settingsAtom)
  // LightGlue/EfficientLoFTR are the panorama keypoint-matching models — frame-forge's animate
  // path (SubmitAnimateTaskAsync) doesn't take a deviceId/modelFamily/modelVersion parameter at
  // all, so these controls are inert no-ops on the 动画 tab; hide them there instead of showing
  // settings that silently do nothing. ORT runtime management stays visible in both tabs since
  // it's also what the separate "提升画质" upscale flow uses, regardless of source export type.
  const isAnim = useAtomValue(exportTypeAtom) === 'animate'
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const { data: devices, isLoading: devicesLoading } = useQuery({ ...devicesQuery(), enabled: open })
  const { data: modelList, isLoading: modelsLoading } = useQuery({ ...modelsQuery(), enabled: open })
  const { data: ortList } = useQuery({ ...ortVersionsQuery(), enabled: open })
  const { data: hwDecode } = useQuery({ ...hwDecodeSettingsQuery(), enabled: open })
  const [versionOpen, setVersionOpen] = useState(false)
  const versionRef = useRef<HTMLDivElement>(null)
  const [deviceOpen, setDeviceOpen] = useState(false)
  const deviceRef = useRef<HTMLDivElement>(null)

  const [pending, setPending] = useState<PendingDownload | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadPercent, setDownloadPercent] = useState(0)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const evtSourceRef = useRef<EventSource | null>(null)

  const [ortDownloadingVersion, setOrtDownloadingVersion] = useState<string | null>(null)
  const [ortDownloadPercent, setOrtDownloadPercent] = useState(0)
  const [ortDownloadError, setOrtDownloadError] = useState<string | null>(null)
  const ortEvtSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!versionOpen) return
    function onClickOutside(e: MouseEvent) {
      if (versionRef.current && !versionRef.current.contains(e.target as Node)) setVersionOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [versionOpen])

  useEffect(() => {
    if (!deviceOpen) return
    function onClickOutside(e: MouseEvent) {
      if (deviceRef.current && !deviceRef.current.contains(e.target as Node)) setDeviceOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [deviceOpen])

  useEffect(() => () => evtSourceRef.current?.close(), [])
  useEffect(() => () => ortEvtSourceRef.current?.close(), [])

  function selectDevice(id: string | undefined) {
    updateSettings({ deviceId: id })
    setDeviceOpen(false)
  }

  function handleFamilyChange(e: ChangeEvent<HTMLSelectElement>) {
    updateSettings({ modelFamily: e.target.value, modelVersion: undefined })
    setPending(null)
  }

  function selectVersion(version: string | undefined) {
    updateSettings({ modelVersion: version })
    setVersionOpen(false)
  }

  function selectCatalogVersion(m: { family: string; version: string; fileSizeBytes: number | null }) {
    // FR-005b: a catalog-only (not-yet-downloaded) version can't be used directly — show a
    // download prompt instead of committing it to settings.
    setDownloadError(null)
    setPending({ family: m.family, version: m.version, fileSizeBytes: m.fileSizeBytes })
    setVersionOpen(false)
  }

  function startDownload() {
    if (!pending) return
    const { family, version } = pending
    setDownloading(true)
    setDownloadPercent(0)
    setDownloadError(null)
    downloadModelMutation().mutationFn({ family, version })
      .then(() => {
        const evtSource = openModelDownloadProgressStream(family, version)
        evtSourceRef.current = evtSource
        evtSource.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data) as { percent?: number; status?: string; error?: string }
            if (typeof data.percent === 'number') setDownloadPercent(data.percent)
            if (data.status === 'installed') {
              evtSource.close()
              setDownloading(false)
              queryClient.invalidateQueries({ queryKey: ['stitchModels'] })
              updateSettings({ modelFamily: family, modelVersion: version })
              setPending(null)
            } else if (data.status === 'error') {
              evtSource.close()
              setDownloading(false)
              setDownloadError(data.error ?? 'download failed')
            }
          } catch { /* ignore malformed frame */ }
        }
        evtSource.onerror = () => {
          evtSource.close()
          setDownloading(false)
          setDownloadError('connection lost')
        }
      })
      .catch((err: unknown) => {
        setDownloading(false)
        setDownloadError(err instanceof Error ? err.message : String(err))
      })
  }

  function startOrtDownload(version: string) {
    setOrtDownloadingVersion(version)
    setOrtDownloadPercent(0)
    setOrtDownloadError(null)
    downloadOrtVersionMutation().mutationFn({ version })
      .then(() => {
        const evtSource = openOrtVersionDownloadProgressStream(version)
        ortEvtSourceRef.current = evtSource
        evtSource.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data) as { percent?: number; status?: string; error?: string }
            if (typeof data.percent === 'number') setOrtDownloadPercent(data.percent)
            if (data.status === 'installed') {
              evtSource.close()
              setOrtDownloadingVersion(null)
              queryClient.invalidateQueries({ queryKey: ['stitchOrtVersions'] })
            } else if (data.status === 'error') {
              evtSource.close()
              setOrtDownloadingVersion(null)
              setOrtDownloadError(data.error ?? 'download failed')
            }
          } catch { /* ignore malformed frame */ }
        }
        evtSource.onerror = () => {
          evtSource.close()
          setOrtDownloadingVersion(null)
          setOrtDownloadError('connection lost')
        }
      })
      .catch((err: unknown) => {
        setOrtDownloadingVersion(null)
        setOrtDownloadError(err instanceof Error ? err.message : String(err))
      })
  }

  function activateOrtVersion(version: string) {
    activateOrtVersionMutation().mutationFn({ version })
      .then(() => queryClient.invalidateQueries({ queryKey: ['stitchOrtVersions'] }))
      .catch((err: unknown) => setOrtDownloadError(err instanceof Error ? err.message : String(err)))
  }

  // Optimistic update + server-response correction (contracts/rest-api.md §"前端调用点") — the
  // server may degrade an unrecognised deviceStrategy to "performance", so the cache is always
  // overwritten with whatever the PUT response actually says, not just the locally-intended value.
  function updateHwDecode(patch: { enabled?: boolean; deviceStrategy?: string }) {
    if (!hwDecode) return
    const next = { ...hwDecode, ...patch }
    queryClient.setQueryData(['hwDecodeSettings'], next)
    updateHwDecodeSettingsMutation().mutationFn({ enabled: next.enabled, deviceStrategy: next.deviceStrategy })
      .then(dto => queryClient.setQueryData(['hwDecodeSettings'], dto))
      .catch(() => queryClient.invalidateQueries({ queryKey: ['hwDecodeSettings'] }))
  }

  // AMD/Intel GPU 在当前实现里都没有真正跑起来的 EP（AMD 没有 ROCm 分支直接落到 CPU；Intel 的
  // OpenVINO 分支虽然写了，但 Linux 下非 NVIDIA 显卡现在下载的 ORT 包根本没编译 OpenVINO EP，
  // 同样落到 CPU——见 project_arc_a380_untestable 记忆），选了它们和选 CPU 没有实际区别，只会让
  // 列表显得"有选项却没用"。只把 NVIDIA GPU 和 CPU 作为可选项展示；这两类之外的设备仍然能通过
  // GET /Stitch/Devices 拿到（未来真的接上 ROCm/OpenVINO 时只需去掉这个过滤器）。
  const deviceOptions = (devices ?? []).filter(d => d.vendor === 'NVIDIA' || d.deviceType === 'CPU')
  const selectedDevice = deviceOptions.find(d => d.id === st.deviceId)
  const deviceTriggerLabel = st.deviceId === undefined
    ? t('advanced.deviceAuto')
    : (selectedDevice?.modelName ?? selectedDevice?.displayName ?? st.deviceId)

  const models = modelList?.models ?? []
  // FR-013: settings.modelFamily stays undefined until the user touches the selector (so it's
  // omitted from the generate request and the daemon picks its own default); the select still
  // needs a concrete value to display, so it falls back to the first family for that purpose only.
  const effectiveFamily = st.modelFamily ?? MODEL_FAMILIES[0].id
  const familyOptions = MODEL_FAMILIES.map(f => ({
    id: f.id,
    label: models.find(m => m.family === f.id)?.displayName ?? f.fallbackLabel,
  }))

  const familyModels = models.filter(m => m.family === effectiveFamily)
  const installed = familyModels.filter(m => m.status === 'installed').sort((a, b) => b.version.localeCompare(a.version))
  const catalogOnly = familyModels.filter(m => m.status === 'catalog').sort((a, b) => b.version.localeCompare(a.version))
  const currentVersionLabel = st.modelVersion ?? t('advanced.latest')

  const ortVersions = ortList?.versions ?? []
  const ortInstalled = ortVersions.filter(v => v.status === 'installed').sort((a, b) => b.version.localeCompare(a.version))
  const ortUpdateCandidate = ortVersions.find(v => v.status === 'catalog')

  return (
    <div className="jfs-fe-advanced">
      <button type="button" className="jfs-fe-advanced-toggle" onClick={() => setOpen(o => !o)}>
        <span>{t('advanced.title')}</span>
        <span className={`jfs-fe-advanced-chevron${open ? ' open' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="jfs-fe-advanced-body">
          <p className="jfs-fe-advanced-warning">{t('advanced.warning')}</p>
          <div className="jfs-fe-pbar nopad">
            <div className="jfs-fe-pgroup">
              <div className="jfs-fe-pgroup-body">
                <label className="jfs-fe-lbl" style={{ gap: '5px', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    className="jfs-fe-toggle-chk"
                    checked={hwDecode?.enabled ?? true}
                    disabled={!hwDecode || hwDecode.supported === false}
                    onChange={e => updateHwDecode({ enabled: e.target.checked })}
                  />
                  <span className="jfs-fe-toggle-track" />
                </label>
                {hwDecode?.multiDeviceAvailable && hwDecode.enabled && (
                  <select
                    className="jfs-fe-sel"
                    value={hwDecode.deviceStrategy}
                    onChange={e => updateHwDecode({ deviceStrategy: e.target.value })}
                  >
                    <option value="performance">{t('advanced.hwDecodeStrategyPerformance')}</option>
                    <option value="idle-resource">{t('advanced.hwDecodeStrategyIdle')}</option>
                  </select>
                )}
              </div>
              <div className="jfs-fe-pgroup-label">{t('advanced.hwDecode')}</div>
              {hwDecode?.supported === false && (
                <div className="jfs-fe-muted" style={{ fontSize: '11px' }}>
                  {t('advanced.hwDecodeUnsupported').replace('{reason}', hwDecode.unsupportedReason ?? '')}
                </div>
              )}
            </div>
            <div className="jfs-fe-pgroup-sep" />
            {!isAnim && (<>
              <div className="jfs-fe-pgroup" ref={deviceRef}>
                <div className="jfs-fe-pgroup-body">
                  <button
                    type="button"
                    className="jfs-fe-sel jfs-fe-combobox-trigger"
                    disabled={devicesLoading}
                    onClick={() => setDeviceOpen(o => !o)}
                  >
                    {deviceTriggerLabel}
                  </button>
                  {deviceOpen && (
                    <ul className="jfs-fe-combobox-list">
                      <li
                        className={`jfs-fe-combobox-item${st.deviceId === undefined ? ' selected' : ''}`}
                        onClick={() => selectDevice(undefined)}
                      >
                        {t('advanced.deviceAuto')}
                      </li>
                      {deviceOptions.map(d => (
                        <li
                          key={d.id}
                          className={`jfs-fe-combobox-item two-line${st.deviceId === d.id ? ' selected' : ''}`}
                          onClick={() => selectDevice(d.id)}
                        >
                          <div className="jfs-fe-combobox-item-main">
                            {d.modelName ?? d.displayName}{d.isDefault ? ' ★' : ''}
                          </div>
                          <div className="jfs-fe-combobox-item-sub">
                            {d.id}{d.devicePath ? ` · ${d.devicePath}` : ''}{d.vramMb ? ` · ${(d.vramMb / 1024).toFixed(1)}GB` : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="jfs-fe-pgroup-label">{t('advanced.device')}</div>
              </div>
              <div className="jfs-fe-pgroup-sep" />

              <div className="jfs-fe-pgroup">
                <div className="jfs-fe-pgroup-body">
                  <select className="jfs-fe-sel" value={effectiveFamily} disabled={modelsLoading} onChange={handleFamilyChange}>
                    {familyOptions.map(f => (
                      <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                    <option value="disabled">{t('advanced.modelDisabled')}</option>
                  </select>
                </div>
                <div className="jfs-fe-pgroup-label">{t('advanced.model')}</div>
              </div>

              {effectiveFamily !== 'disabled' && (<>
                <div className="jfs-fe-pgroup-sep" />
                <div className="jfs-fe-pgroup" ref={versionRef}>
                  <div className="jfs-fe-pgroup-body">
                    <button type="button" className="jfs-fe-sel jfs-fe-combobox-trigger" onClick={() => setVersionOpen(o => !o)}>
                      {currentVersionLabel}
                    </button>
                    {versionOpen && (
                      <ul className="jfs-fe-combobox-list">
                        <li
                          className={`jfs-fe-combobox-item${st.modelVersion === undefined ? ' selected' : ''}`}
                          onClick={() => selectVersion(undefined)}
                        >
                          {t('advanced.latest')}
                        </li>
                        {installed.map(m => (
                          <li
                            key={m.version}
                            className={`jfs-fe-combobox-item installed${st.modelVersion === m.version ? ' selected' : ''}`}
                            onClick={() => selectVersion(m.version)}
                          >
                            {m.version}
                          </li>
                        ))}
                        {catalogOnly.map(m => (
                          <li
                            key={m.version}
                            className="jfs-fe-combobox-item catalog"
                            onClick={() => selectCatalogVersion(m)}
                          >
                            {m.version}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="jfs-fe-pgroup-label">{t('advanced.modelVersion')}</div>
                </div>
              </>)}
              <div className="jfs-fe-pgroup-sep" />
            </>)}

            <div className="jfs-fe-pgroup">
              <div className="jfs-fe-pgroup-body">
                <span className="jfs-fe-muted">{ortList?.activeVersion ?? '—'}</span>
                {ortDownloadingVersion ? (
                  <div className="jfs-fe-progress jfs-fe-progress-sm">
                    <div className="jfs-fe-bar" style={{ width: `${ortDownloadPercent}%` }} />
                    <span className="jfs-fe-progress-label">{t('advanced.downloading')} {ortDownloadPercent}%</span>
                  </div>
                ) : ortUpdateCandidate ? (
                  <button type="button" className="jfs-fe-btn p" onClick={() => startOrtDownload(ortUpdateCandidate.version)}>
                    {t('advanced.updateTo').replace('{version}', ortUpdateCandidate.version)}
                  </button>
                ) : (
                  <button type="button" className="jfs-fe-btn g" onClick={() => queryClient.invalidateQueries({ queryKey: ['stitchOrtVersions'] })}>
                    {t('advanced.checkUpdates')}
                  </button>
                )}
              </div>
              <div className="jfs-fe-pgroup-label">{t('advanced.ortVersion')}</div>
            </div>

            {ortInstalled.filter(v => !v.isActive).map(v => (
              <Fragment key={v.version}>
                <div className="jfs-fe-pgroup-sep" />
                <div className="jfs-fe-pgroup">
                  <div className="jfs-fe-pgroup-body">
                    <span className="jfs-fe-muted">{v.version}</span>
                    <button type="button" className="jfs-fe-btn g" onClick={() => activateOrtVersion(v.version)}>
                      {t('advanced.activate')}
                    </button>
                  </div>
                </div>
              </Fragment>
            ))}
          </div>

          {ortDownloadError && <span className="jfs-fe-download-error">{ortDownloadError}</span>}

          {pending && (
            <div className="jfs-fe-download-prompt">
              <span className="jfs-fe-muted">
                {t('advanced.downloadFirst')}
                {pending.fileSizeBytes ? ` (${formatBytes(pending.fileSizeBytes)})` : ''}
              </span>
              {downloading ? (
                <div className="jfs-fe-progress jfs-fe-progress-sm">
                  <div className="jfs-fe-bar" style={{ width: `${downloadPercent}%` }} />
                  <span className="jfs-fe-progress-label">{t('advanced.downloading')} {downloadPercent}%</span>
                </div>
              ) : (
                <div className="jfs-fe-download-prompt-actions">
                  <button type="button" className="jfs-fe-btn p" onClick={startDownload}>
                    {t('advanced.download')}
                  </button>
                  <button type="button" className="jfs-fe-btn g" onClick={() => setPending(null)}>×</button>
                </div>
              )}
              {downloadError && <span className="jfs-fe-download-error">{downloadError}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
