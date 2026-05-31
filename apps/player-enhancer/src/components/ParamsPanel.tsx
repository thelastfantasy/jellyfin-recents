import { sSettings, sExportType, sCropOpen, updateSettings, _videoEl } from '../core/state'
import type { ExportSettings } from '../core/state'
import { t } from '../lib/i18n'

const ICON_CROP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 2 6 17 21 17"/><polyline points="2 6 17 6 17 21"/></svg>`

export function ParamsPanel() {
  const st      = sSettings.value
  const isAnim  = sExportType.value === 'animate'
  const curQuality  = isAnim ? st.animateQuality : st.stitchQuality
  const isLossless  = curQuality <= 0
  const presets     = ['original', '1080p', '720p', '480p', '360p']

  function handleCustomToggle(e: Event) {
    const checked = (e.target as HTMLInputElement).checked
    if (!checked) updateSettings({ useCustomResolution: false, customWidth: 0, customHeight: 0 })
    else          updateSettings({ useCustomResolution: true, resolutionPreset: 'original' })
  }

  function handlePresetChange(e: Event) {
    const val = (e.target as HTMLSelectElement).value
    if (val !== 'original') updateSettings({ resolutionPreset: val, resizeMode: 'width', customWidth: 0, customHeight: 0 })
    else                    updateSettings({ resolutionPreset: val })
  }

  function handleWidthInput(e: Event) {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    const patch: Partial<ExportSettings> = { customWidth: v, resizeMode: 'width', resolutionPreset: 'original' }
    if (v > 0 && _videoEl) {
      const cr = st.cropRect
      const hRatio = cr
        ? (cr.h * (_videoEl.videoHeight || 1)) / (cr.w * (_videoEl.videoWidth || 1))
        : (_videoEl.videoHeight || 1) / (_videoEl.videoWidth || 1)
      patch.customHeight = Math.round(v * hRatio)
    } else {
      patch.customHeight = 0
    }
    updateSettings(patch)
  }

  function handleHeightInput(e: Event) {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    const patch: Partial<ExportSettings> = { customHeight: v, resizeMode: 'height', resolutionPreset: 'original' }
    if (v > 0 && _videoEl) {
      const cr = st.cropRect
      const wRatio = cr
        ? (cr.w * (_videoEl.videoWidth  || 1)) / (cr.h * (_videoEl.videoHeight || 1))
        : (_videoEl.videoWidth || 1) / (_videoEl.videoHeight || 1)
      patch.customWidth = Math.round(v * wRatio)
    } else {
      patch.customWidth = 0
    }
    updateSettings(patch)
  }

  function handleSpeedChange(e: Event) {
    updateSettings({ speed: parseFloat((e.target as HTMLSelectElement).value) || 1.0 })
  }

  function handleLoopInput(e: Event) {
    updateSettings({ loopCount: Math.max(0, Math.min(99, parseInt((e.target as HTMLInputElement).value) || 0)) })
  }

  function handleLosslessChange(e: Event) {
    const checked   = (e.target as HTMLInputElement).checked
    const qualVal   = isAnim ? st.animateQuality : st.stitchQuality
    const fallback  = qualVal > 0 ? qualVal : 0.75
    if (isAnim) updateSettings({ animateQuality: checked ? 0 : fallback })
    else        updateSettings({ stitchQuality:  checked ? 0 : fallback })
  }

  function handleQualityChange(e: Event) {
    const v = parseFloat((e.target as HTMLSelectElement).value) || 0.75
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
    <div class="jfs-fe-pbar dark-bg sep-b">
      {isAnim && <>
        <div class="jfs-fe-pgroup">
          <div class="jfs-fe-pgroup-body">
            <label class="jfs-fe-lbl" style={{ gap: '5px', whiteSpace: 'nowrap' }}>
              <span class="jfs-fe-muted" style={{ fontSize: '11px' }}>{t('params.preset')}</span>
              <input type="checkbox" class="jfs-fe-toggle-chk" checked={st.useCustomResolution} onChange={handleCustomToggle} />
              <span class="jfs-fe-toggle-track" />
              <span class="jfs-fe-muted" style={{ fontSize: '11px' }}>{t('params.custom')}</span>
            </label>
            {!st.useCustomResolution
              ? <select class="jfs-fe-sel" value={st.resolutionPreset} onChange={handlePresetChange}>
                  {presets.map(p => <option key={p} value={p}>{p === 'original' ? t('params.original') : p}</option>)}
                </select>
              : <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span class="jfs-fe-muted" style={{ width: '16px' }}>{t('params.width')}</span>
                    <input type="number" value={st.customWidth || ''} placeholder="px" class="jfs-fe-inp" style={{ width: '56px' }}
                      onInput={handleWidthInput}
                      onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                      onWheel={(e: WheelEvent) => e.stopPropagation()} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span class="jfs-fe-muted" style={{ width: '16px' }}>{t('params.height')}</span>
                    <input type="number" value={st.customHeight || ''} placeholder="auto" class="jfs-fe-inp" style={{ width: '56px' }}
                      onInput={handleHeightInput}
                      onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                      onWheel={(e: WheelEvent) => e.stopPropagation()} />
                  </div>
                </>
            }
          </div>
          <div class="jfs-fe-pgroup-label">{t('params.resolution')}</div>
        </div>
        <div class="jfs-fe-pgroup-sep" />

        <div class="jfs-fe-pgroup">
          <div class="jfs-fe-pgroup-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span class="jfs-fe-muted" style={{ width: '28px' }}>{t('params.speed')}</span>
              <select class="jfs-fe-sel" value={String(st.speed)} onChange={handleSpeedChange}>
                {[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map(v => <option key={v} value={String(v)}>{v}x</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span class="jfs-fe-muted" style={{ width: '28px' }}>{t('params.loop')}</span>
              <input type="number" min={0} max={99} value={st.loopCount} class="jfs-fe-inp" style={{ width: '44px' }}
                onInput={handleLoopInput}
                onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                onWheel={(e: WheelEvent) => e.stopPropagation()} />
              <span class="jfs-fe-muted">(0=∞)</span>
            </div>
          </div>
          <div class="jfs-fe-pgroup-label">{t('params.animation')}</div>
        </div>
        <div class="jfs-fe-pgroup-sep" />

        <div class="jfs-fe-pgroup">
          <div class="jfs-fe-pgroup-body" style={{ justifyContent: 'center', alignItems: 'center', flex: '1' }}>
            <button
              class={`jfs-fe-btn${st.cropRect ? ' p' : ''}`}
              onClick={() => { sCropOpen.value = true }}
              title={st.cropRect ? t('params.cropActive') : t('params.cropSet')}
              style={{ padding: '5px', width: '30px', height: '30px', fontSize: '0' }}
              dangerouslySetInnerHTML={{ __html: ICON_CROP }}
            />
          </div>
          <div class="jfs-fe-pgroup-label">{t('params.crop')}</div>
        </div>
        <div class="jfs-fe-pgroup-sep" />
      </>}

      <div class="jfs-fe-pgroup">
        <div class="jfs-fe-pgroup-body">
          <label class="jfs-fe-lbl">
            <input type="checkbox" checked={isLossless} onChange={handleLosslessChange} style={{ cursor: 'pointer' }} />
            {t('params.lossless')}
          </label>
          <select class="jfs-fe-sel" disabled={isLossless} value={String(qualVal)} onChange={handleQualityChange}>
            {qualityOptions.map(o => <option key={o.v} value={String(o.v)}>{o.label}</option>)}
          </select>
        </div>
        <div class="jfs-fe-pgroup-label">{t('params.quality')}</div>
      </div>
    </div>
  )
}
