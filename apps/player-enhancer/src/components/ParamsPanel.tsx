import { useAtomValue } from 'jotai'
import type { ChangeEvent, FormEvent, KeyboardEvent, WheelEvent } from 'react'
import { useEffect } from 'react'

import type { ExportSettings } from '../core/state'
import { _videoEl, exportTypeAtom,sCropOpen, settingsAtom, updateSettings } from '../core/state'
import { t } from '../lib/i18n'
import { AdvancedPanel } from './AdvancedPanel'

const ICON_CROP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 2 6 17 21 17"/><polyline points="2 6 17 6 17 21"/></svg>`

function computeAutoDim(video: HTMLVideoElement | null, crop: { w: number; h: number } | null, userDim: number, isWidth: boolean): number {
  if (!video || userDim <= 0) return 0
  const vw = video.videoWidth  || 1
  const vh = video.videoHeight || 1
  if (crop && crop.w > 0 && crop.h > 0) {
    const cw = crop.w * vw
    const ch = crop.h * vh
    return Math.round(isWidth ? userDim * cw / ch : userDim * ch / cw)
  }
  return Math.round(isWidth ? userDim * vw / vh : userDim * vh / vw)
}

export function ParamsPanel() {
  const st      = useAtomValue(settingsAtom)
  const isAnim  = useAtomValue(exportTypeAtom) === 'animate'
  const curQuality  = isAnim ? st.animateQuality : st.stitchQuality
  const isLossless  = curQuality <= 0
  const presets     = ['original', '1080p', '720p', '480p', '360p']

  const w = st.width
  const h = st.height
  const widthIsUser  = w.mode === 'userInput'
  const heightIsUser = h.mode === 'userInput'

  const autoWidth  = heightIsUser && h.value > 0 ? computeAutoDim(_videoEl, st.cropRect, h.value, true) : 0
  const autoHeight = widthIsUser  && w.value > 0 ? computeAutoDim(_videoEl, st.cropRect, w.value, false) : 0

  useEffect(() => {
    if (widthIsUser && w.value > 0) {
      const ah = computeAutoDim(_videoEl, st.cropRect, w.value, false)
      if (ah && ah !== h.value) updateSettings({ height: { value: ah, mode: 'autoAdjust' } })
    } else if (heightIsUser && h.value > 0) {
      const aw = computeAutoDim(_videoEl, st.cropRect, h.value, true)
      if (aw && aw !== w.value) updateSettings({ width: { value: aw, mode: 'autoAdjust' } })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.width.mode, st.width.value, st.height.mode, st.height.value, st.cropRect, _videoEl?.videoWidth, _videoEl?.videoHeight])

  function handleCustomToggle(e: ChangeEvent<HTMLInputElement>) {
    const checked = e.target.checked
    if (!checked) updateSettings({
      useCustomResolution: false,
      width:  { value: 0, mode: 'autoAdjust' },
      height: { value: 0, mode: 'autoAdjust' },
    })
    else updateSettings({
      useCustomResolution: true,
      resolutionPreset: 'original',
      width:  { value: _videoEl?.videoWidth || 0, mode: 'userInput' },
      height: { value: 0, mode: 'autoAdjust' },
    })
  }

  function handlePresetChange(e: ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value
    if (val !== 'original') updateSettings({
      resolutionPreset: val,
      width:  { value: 0, mode: 'autoAdjust' },
      height: { value: 0, mode: 'autoAdjust' },
    })
    else updateSettings({ resolutionPreset: val })
  }

  function handleWidthInput(e: FormEvent<HTMLInputElement>) {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    const patch: Partial<ExportSettings> = { width: { value: v, mode: 'userInput' as const }, resolutionPreset: 'original' }
    if (v > 0 && _videoEl) {
      patch.height = { value: computeAutoDim(_videoEl, st.cropRect, v, false), mode: 'autoAdjust' as const }
    } else {
      patch.height = { value: 0, mode: 'autoAdjust' as const }
    }
    updateSettings(patch)
  }

  function handleHeightInput(e: FormEvent<HTMLInputElement>) {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    const patch: Partial<ExportSettings> = { height: { value: v, mode: 'userInput' as const }, resolutionPreset: 'original' }
    if (v > 0 && _videoEl) {
      patch.width = { value: computeAutoDim(_videoEl, st.cropRect, v, true), mode: 'autoAdjust' as const }
    } else {
      patch.width = { value: 0, mode: 'autoAdjust' as const }
    }
    updateSettings(patch)
  }

  function handleSpeedChange(e: ChangeEvent<HTMLSelectElement>) {
    updateSettings({ speed: parseFloat(e.target.value) || 1.0 })
  }

  function handleLoopInput(e: FormEvent<HTMLInputElement>) {
    updateSettings({ loopCount: Math.max(0, Math.min(99, parseInt((e.target as HTMLInputElement).value) || 0)) })
  }

  function handleLosslessChange(e: ChangeEvent<HTMLInputElement>) {
    const checked   = e.target.checked
    const qualVal   = isAnim ? st.animateQuality : st.stitchQuality
    const fallback  = qualVal > 0 ? qualVal : 0.75
    if (isAnim) updateSettings({ animateQuality: checked ? 0 : fallback })
    else        updateSettings({ stitchQuality:  checked ? 0 : fallback })
  }

  function handleQualityChange(e: ChangeEvent<HTMLSelectElement>) {
    const v = parseFloat(e.target.value) || 0.75
    if (isAnim) updateSettings({ animateQuality: v })
    else        updateSettings({ stitchQuality:  v })
  }

  const qualityOptions = [
    { v: 0.85, label: t('params.quality85') },
    { v: 0.75, label: t('params.quality75') },
    { v: 0.60, label: t('params.quality60') },
  ]
  const qualVal = isLossless ? 0.75 : curQuality

  return (
    <div className="jfs-fe-pbar dark-bg sep-b">
      {isAnim && <>
        <div className="jfs-fe-pgroup">
          <div className="jfs-fe-pgroup-body">
            <label className="jfs-fe-lbl" style={{ gap: '5px', whiteSpace: 'nowrap' }}>
              <span className="jfs-fe-muted" style={{ fontSize: '11px' }}>{t('params.preset')}</span>
              <input type="checkbox" className="jfs-fe-toggle-chk" checked={st.useCustomResolution} onChange={handleCustomToggle} />
              <span className="jfs-fe-toggle-track" />
              <span className="jfs-fe-muted" style={{ fontSize: '11px' }}>{t('params.custom')}</span>
            </label>
            {!st.useCustomResolution
              ? <select className="jfs-fe-sel" value={st.resolutionPreset} onChange={handlePresetChange}>
                  {presets.map(p => <option key={p} value={p}>{p === 'original' ? t('params.original') : p}</option>)}
                </select>
              : <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span className="jfs-fe-muted" style={{ width: '16px' }}>{t('params.width')}</span>
                    <input type="number" value={widthIsUser ? (w.value || '') : (autoWidth || '')} placeholder={widthIsUser ? 'px' : 'auto'} className="jfs-fe-inp" style={{ width: '56px' }}
                      disabled={!widthIsUser}
                      onInput={handleWidthInput}
                      onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                      onWheel={(e: WheelEvent) => e.stopPropagation()} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span className="jfs-fe-muted" style={{ width: '16px' }}>{t('params.height')}</span>
                    <input type="number" value={heightIsUser ? (h.value || '') : (autoHeight || '')} placeholder={heightIsUser ? 'px' : 'auto'} className="jfs-fe-inp" style={{ width: '56px' }}
                      disabled={!heightIsUser}
                      onInput={handleHeightInput}
                      onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                      onWheel={(e: WheelEvent) => e.stopPropagation()} />
                  </div>
                </>
            }
          </div>
          <div className="jfs-fe-pgroup-label">{t('params.resolution')}</div>
        </div>
        <div className="jfs-fe-pgroup-sep" />

        <div className="jfs-fe-pgroup">
          <div className="jfs-fe-pgroup-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span className="jfs-fe-muted" style={{ width: '28px' }}>{t('params.speed')}</span>
              <select className="jfs-fe-sel" value={String(st.speed)} onChange={handleSpeedChange}>
                {[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map(v => <option key={v} value={String(v)}>{v}x</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span className="jfs-fe-muted" style={{ width: '28px' }}>{t('params.loop')}</span>
              <input type="number" min={0} max={99} value={st.loopCount} className="jfs-fe-inp" style={{ width: '44px' }}
                onInput={handleLoopInput}
                onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                onWheel={(e: WheelEvent) => e.stopPropagation()} />
              <span className="jfs-fe-muted">(0=∞)</span>
            </div>
          </div>
          <div className="jfs-fe-pgroup-label">{t('params.animation')}</div>
        </div>
        <div className="jfs-fe-pgroup-sep" />

        <div className="jfs-fe-pgroup">
          <div className="jfs-fe-pgroup-body" style={{ justifyContent: 'center', alignItems: 'center', flex: '1' }}>
            <button
              className={`jfs-fe-btn${st.cropRect ? ' p' : ''}`}
              onClick={() => { sCropOpen.value = true }}
              title={st.cropRect ? t('params.cropActive') : t('params.cropSet')}
              style={{ padding: '5px', width: '30px', height: '30px', fontSize: '0' }}
              dangerouslySetInnerHTML={{ __html: ICON_CROP }}
            />
          </div>
          <div className="jfs-fe-pgroup-label">{t('params.crop')}</div>
        </div>
        <div className="jfs-fe-pgroup-sep" />
      </>}

      <div className="jfs-fe-pgroup">
        <div className="jfs-fe-pgroup-body">
          <label className="jfs-fe-lbl">
            <input type="checkbox" checked={isLossless} onChange={handleLosslessChange} style={{ cursor: 'pointer' }} />
            {t('params.lossless')}
          </label>
          <select className="jfs-fe-sel" disabled={isLossless} value={String(qualVal)} onChange={handleQualityChange}>
            {qualityOptions.map(o => <option key={o.v} value={String(o.v)}>{o.label}</option>)}
          </select>
        </div>
        <div className="jfs-fe-pgroup-label">{t('params.quality')}</div>
      </div>

      <AdvancedPanel />
    </div>
  )
}
