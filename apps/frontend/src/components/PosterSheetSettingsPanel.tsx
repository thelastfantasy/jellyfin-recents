import { useState, useCallback, useEffect, useRef } from 'preact/hooks'
import { MdAdd, MdRemove } from 'react-icons/md'
import { StartJobRequest, OverlaySettingsDto, fetchPreview, SkipSegment, loadGlobalSkipSegments, saveGlobalSkipSegments, listUserFonts, uploadFont, deleteUserFont, UserFontInfo } from '../api/posterSheetApi'
import { isGridValid, maxFrames as calcMaxFrames } from '../utils/gridValidation'
import { useLocale } from '../i18n/context'
import { Lightbox } from './Lightbox'
import { downloadBlob } from '../utils/download'
import { TimeInput } from './SkipSegmentsModal'

const THEMES = ['classic', 'dark', 'light', 'cinematic', 'minimal', 'transparent'] as const
const LATIN_FONTS = [
  { value: 'noto-sans',  label: 'Noto Sans',        style: '' },
  { value: 'noto-serif', label: 'Noto Serif',        style: 'font-style:italic' },
  { value: 'roboto',     label: 'Roboto',            style: '' },
  { value: 'oswald',     label: 'Oswald',            style: 'font-weight:700;letter-spacing:0.05em' },
  { value: 'playfair',   label: 'Playfair',          style: 'font-style:italic' },
  { value: 'cinzel',     label: 'Cinzel',            style: 'letter-spacing:0.08em' },
] as const
const CJK_FONTS = [
  { value: 'noto-sans-jp',  label: 'Noto Sans' },
  { value: 'noto-serif-jp', label: 'Noto Serif' },
] as const
const OVERLAY_FONTS = [
  { value: 'noto-sans-jp',  label: 'Noto Sans' },
  { value: 'noto-serif-jp', label: 'Noto Serif' },
] as const
const MODES = ['deterministic', 'random'] as const
const LANGS = ['en', 'zh', 'ja'] as const
const TIMESTAMP_FONTS = [
  { value: 'roboto-mono', label: 'Roboto Mono' },
  { value: 'vollkorn',    label: 'Vollkorn' },
] as const

function hasCJK(s: string) {
  return /[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/.test(s)
}
function hasLatin(s: string) {
  return /[a-zA-Z]/.test(s)
}

type TimestampPos = 'inside-top-left' | 'inside-top-center' | 'inside-top-right' | 'inside-bottom-left' | 'outside-bottom-left' | 'inside-bottom-center' | 'outside-bottom-center' | 'inside-bottom-right' | 'outside-bottom-right'

interface Props {
  videoDuration: number | null
  onGenerate: (req: StartJobRequest) => void
  settingsOnly?: boolean
  onDisable?: () => void
}

function loadSettings() {
  return {
    rows: Number(localStorage.getItem('jfs-poster-rows') ?? 6),
    cols: Number(localStorage.getItem('jfs-poster-cols') ?? 8),
    thumbWidth: Math.min(600, Math.max(160, Number(localStorage.getItem('jfs-poster-thumb-width') ?? 320))),
    mode: (localStorage.getItem('jfs-poster-mode') ?? 'deterministic') as 'deterministic' | 'random',
    overlay: (() => {
      try {
        const saved = JSON.parse(localStorage.getItem('jfs-poster-overlay') ?? 'null')
        return saved ? { ...defaultOverlay(), ...saved } : defaultOverlay()
      } catch { return defaultOverlay() }
    })(),
  }
}

function defaultOverlay(): OverlaySettingsDto {
  return {
    brandingEnabled: true,
    brandingText: 'Jellyfin Suite',
    videoInfoEnabled: true,
    showFileSize: true,
    showResolutionFps: true,
    showVideoEncoding: true,
    showAudioEncoding: true,
    showDuration: true,
    showSubtitles: true,
    showFrameTimestamp: false,
    timestampFont: 'roboto-mono',
    timestampBg: true,
    timestampShadow: false,
    colorTheme: 'classic',
    fontFamily: 'noto-sans-jp',
    brandingLatinFont: 'noto-sans',
    brandingCjkFont: 'noto-sans-jp',
    lang: 'en',
    timestampPosition: 'inside-bottom-left',
  }
}


function TimestampPosPicker({ value, onChange }: { value: TimestampPos; onChange: (v: TimestampPos) => void }) {
  const inside = [
    { v: 'inside-top-left'      as const, style: { top: 4, left: 4 } },
    { v: 'inside-top-center'    as const, style: { top: 4, left: '50%', marginLeft: -14 } },
    { v: 'inside-top-right'     as const, style: { top: 4, right: 4 } },
    { v: 'inside-bottom-left'   as const, style: { bottom: 4, left: 4 } },
    { v: 'inside-bottom-center' as const, style: { bottom: 4, left: '50%', marginLeft: -14 } },
    { v: 'inside-bottom-right'  as const, style: { bottom: 4, right: 4 } },
  ]
  const outside = [
    { v: 'outside-bottom-left'  as const, style: { bottom: 2, left: 16 } },
    { v: 'outside-bottom-center' as const, style: { bottom: 2, left: '50%', marginLeft: -14 } },
    { v: 'outside-bottom-right' as const, style: { bottom: 2, right: 16 } },
  ]
  return (
    <div class="jfs-tspicker">
      <div class="jfs-tspicker__inner">
        {inside.map(p => (
          <button
            key={p.v}
            class={`jfs-tspicker__btn${value === p.v ? ' jfs-tspicker__btn--active' : ''}`}
            style={p.style}
            onClick={(e) => { onChange(p.v); (e.currentTarget as HTMLButtonElement).blur(); }}
            title={p.v}
          >00:00</button>
        ))}
      </div>
      {/* Outside buttons between inner and outer borders */}
      {outside.map(p => (
        <button
          key={p.v}
          class={`jfs-tspicker__btn${value === p.v ? ' jfs-tspicker__btn--active' : ''}`}
          style={{...p.style, position: 'absolute'}}
          onClick={(e) => { onChange(p.v); (e.currentTarget as HTMLButtonElement).blur(); }}
          title={p.v}
        >00:00</button>
      ))}
    </div>
  )
}

export function PosterSheetSettingsPanel({ videoDuration, onGenerate, settingsOnly = false, onDisable }: Props) {
  const { t } = useLocale()
  const init = loadSettings()
  const [rows, setRows] = useState(init.rows)
  const [cols, setCols] = useState(init.cols)
  const [thumbWidth, setThumbWidth] = useState(init.thumbWidth)
  const [mode, setMode] = useState(init.mode)
  const [overlay, setOverlay] = useState<OverlaySettingsDto>(init.overlay)
  const [headless, setHeadless] = useState(() => localStorage.getItem('jfs-poster-headless') === '1')
  const [globalSkips, setGlobalSkips] = useState<SkipSegment[]>(() => loadGlobalSkipSegments())
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLightboxOpen, setPreviewLightboxOpen] = useState(false)

  const [userFonts, setUserFonts] = useState<UserFontInfo[]>([])
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listUserFonts().then(setUserFonts).catch(() => {})
  }, [])

  async function handleUpload() {
    if (!uploadFile) return
    setUploading(true)
    setUploadError(null)
    try {
      const font = await uploadFont(uploadFile)
      setUserFonts(prev => prev.some(f => f.key === font.key) ? prev : [...prev, font])
      setUploadFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  async function handleDeleteFont(key: string) {
    try {
      await deleteUserFont(key)
      setUserFonts(prev => prev.filter(f => f.key !== key))
    } catch { /* best-effort */ }
  }

  const isShortVideo = videoDuration !== null && videoDuration < 120
  const frameMax = videoDuration !== null ? calcMaxFrames(videoDuration) : Infinity
  const frameCount = rows * cols
  const tooManyFrames = videoDuration !== null && !isGridValid(rows, cols, videoDuration)

  function persist(newRows: number, newCols: number, newThumbWidth: number, newMode: typeof mode, newOverlay: typeof overlay) {
    localStorage.setItem('jfs-poster-rows', String(newRows))
    localStorage.setItem('jfs-poster-cols', String(newCols))
    localStorage.setItem('jfs-poster-thumb-width', String(newThumbWidth))
    localStorage.setItem('jfs-poster-mode', newMode)
    localStorage.setItem('jfs-poster-overlay', JSON.stringify(newOverlay))
  }

  function updateRows(v: number) { setRows(v); persist(v, cols, thumbWidth, mode, overlay) }
  function updateCols(v: number) { setCols(v); persist(rows, v, thumbWidth, mode, overlay) }
  function updateThumbWidth(v: number) { setThumbWidth(v); persist(rows, cols, v, mode, overlay) }
  function updateMode(v: typeof mode) { setMode(v); persist(rows, cols, thumbWidth, v, overlay) }
  function updateOverlay(patch: Partial<OverlaySettingsDto>) {
    const next = { ...overlay, ...patch }
    setOverlay(next)
    persist(rows, cols, thumbWidth, mode, next)
  }
  function updateHeadless(v: boolean) {
    setHeadless(v)
    localStorage.setItem('jfs-poster-headless', v ? '1' : '0')
  }

  function addGlobalSkip() {
    if (globalSkips.length >= 2) return
    const next = [...globalSkips, { startMs: 0, endMs: 0 }]
    setGlobalSkips(next); saveGlobalSkipSegments(next)
  }
  function removeGlobalSkip(idx: number) {
    const next = globalSkips.filter((_, i) => i !== idx)
    setGlobalSkips(next); saveGlobalSkipSegments(next)
  }
  function updateGlobalSkip(idx: number, patch: Partial<SkipSegment>) {
    const next = globalSkips.map((s, i) => i === idx ? { ...s, ...patch } : s)
    setGlobalSkips(next); saveGlobalSkipSegments(next)
  }

  const effectiveOverlay = headless
    ? { ...overlay, brandingEnabled: false, videoInfoEnabled: false }
    : overlay

  const handleGenerate = useCallback(() => {
    const validSkips = globalSkips.filter(s => s.endMs > s.startMs)
    const req: StartJobRequest = {
      rows, cols, thumbWidth, mode,
      seed: mode === 'random' ? crypto.randomUUID() : undefined,
      overlay: effectiveOverlay,
      ...(validSkips.length > 0 ? { skipSegments: validSkips } : {}),
    }
    onGenerate(req)
  }, [rows, cols, mode, effectiveOverlay, globalSkips, onGenerate])

  const handlePreview = useCallback(async () => {
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const blob = await fetchPreview(effectiveOverlay, rows, cols, thumbWidth)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      const url = URL.createObjectURL(blob)
      setPreviewUrl(url)
      setPreviewLightboxOpen(true)
    } catch (e: unknown) {
      setPreviewError(e instanceof Error ? (e.message ?? t.posterPreview) : t.posterPreview)
    } finally {
      setPreviewLoading(false)
    }
  }, [effectiveOverlay, rows, cols, thumbWidth, previewUrl, t])

  const validPresets = isShortVideo
    ? ([[2,3],[2,4],[3,4],[2,6],[3,3]] as [number,number][])
        .filter(([r,c]) => r * c <= frameMax)
    : null

  const brandText   = overlay.brandingText ?? ''
  const brandCJK    = hasCJK(brandText)
  const brandLatin  = hasLatin(brandText)
  const showLatin   = brandLatin || !brandCJK
  const showCJK     = brandCJK || !brandLatin

  const toFontOption = ({ key, displayName }: UserFontInfo) => ({
    value: key,
    label: `${displayName} ${t.posterCustomFontSuffix}`,
    custom: true,
  })
  // Custom fonts are only added to the branding pickers (Latin/CJK), filtered by detected script.
  // They are NOT offered for the overlay/timestamp font — that always uses a bundled font.
  const latinFontsAll = [...LATIN_FONTS, ...userFonts.filter(f => f.script === 'latin').map(toFontOption)]
  const cjkFontsAll   = [...CJK_FONTS,   ...userFonts.filter(f => f.script === 'cjk').map(toFontOption)]
  const overlayFontsAll = [...OVERLAY_FONTS]

  return (
    <div class="jfs-poster-settings">
      <h3 class="jfs-poster-settings__title">{t.posterSettingsTitle}</h3>

      {/* Grid size */}
      <div class="jfs-poster-settings__section">
        <label class="jfs-poster-settings__label">{t.posterGrid}</label>
        {validPresets ? (
          <div class="jfs-poster-settings__presets">
            {validPresets.map(([r, c]) => (
              <button
                key={`${r}x${c}`}
                class={`jfs-poster-settings__preset-btn${rows === r && cols === c ? ' jfs-poster-settings__preset-btn--active' : ''}`}
                onClick={(e) => { updateRows(r); updateCols(c); (e.currentTarget as HTMLButtonElement).blur(); }}
              >
                {r}x{c}
              </button>
            ))}
          </div>
        ) : (
          <div class="jfs-poster-settings__sliders">
            <div class="jfs-poster-settings__slider-row">
              <span>{t.posterCols}: {cols}</span>
              <input type="range" min={1} max={12} value={cols}
                onInput={(e) => updateCols(Number((e.target as HTMLInputElement).value))} />
            </div>
            <div class="jfs-poster-settings__slider-row">
              <span>{t.posterRows}: {rows}</span>
              <input type="range" min={1} max={20} value={rows}
                onInput={(e) => updateRows(Number((e.target as HTMLInputElement).value))} />
            </div>
            <div class="jfs-poster-settings__frame-count">
              {frameCount} {t.posterFrames}
              {tooManyFrames && (
                <span class="jfs-poster-settings__warn">
                  {' '}({t.posterTooMany} {frameMax})
                </span>
              )}
            </div>
            <div class="jfs-poster-settings__slider-row">
              <span>{t.posterThumbWidth}: {thumbWidth}px</span>
              <input type="range" min={160} max={600} step={40} value={thumbWidth}
                onInput={(e) => updateThumbWidth(Number((e.target as HTMLInputElement).value))} />
            </div>
          </div>
        )}
      </div>

      {/* Mode — toggle buttons */}
      <div class="jfs-poster-settings__section">
        <label class="jfs-poster-settings__label">{t.posterMode}</label>
        <div class="jfs-poster-settings__theme-group">
          {MODES.map(m => (
            <button
              key={m}
              class={`jfs-poster-settings__theme-btn${mode === m ? ' jfs-poster-settings__theme-btn--active' : ''}`}
              onClick={(e) => { updateMode(m); (e.currentTarget as HTMLButtonElement).blur(); }}
              title={m === 'deterministic' ? t.posterDeterministicTip : t.posterRandomTip}
            >
              {m === 'deterministic' ? t.posterDeterministic : t.posterRandom}
            </button>
          ))}
        </div>
        <p class="jfs-poster-settings__mode-desc">
          {mode === 'deterministic' ? t.posterDeterministicTip : t.posterRandomTip}
        </p>
      </div>

      {/* Global skip segments */}
      <div class="jfs-poster-settings__section">
        <label class="jfs-poster-settings__label">{t.posterGlobalSkip}</label>
        <div class="jfs-poster-settings__global-skips">
          {globalSkips.map((seg, idx) => (
            <div key={idx} class="jfs-skip-segment-row">
              <div class="jfs-skip-segment-row__controls">
                <TimeInput valueMs={seg.startMs} onChange={v => updateGlobalSkip(idx, { startMs: v })} />
                <span class="jfs-skip-segment-dash">—</span>
                <TimeInput valueMs={seg.endMs} onChange={v => updateGlobalSkip(idx, { endMs: v })} />
                <button class="jfs-skip-segment-remove" onClick={() => removeGlobalSkip(idx)} title="删除">
                  <MdRemove size={15} />
                </button>
              </div>
            </div>
          ))}
          {globalSkips.length < 2 && (
            <button class="jfs-skip-segment-add" onClick={addGlobalSkip}>
              <MdAdd size={15} />{t.posterGlobalSkipAdd}
            </button>
          )}
        </div>
      </div>

      {/* Overlay settings */}
      <div class="jfs-poster-settings__section">
        <label class="jfs-poster-settings__label">{t.posterOverlay}</label>

        {/* Headless mode */}
        <div class="jfs-poster-settings__check-row jfs-poster-settings__check-row--headless">
          <input type="checkbox" id="headless" checked={headless}
            onChange={e => updateHeadless((e.target as HTMLInputElement).checked)} />
          <label for="headless">{t.posterHeadless}</label>
          <span class="jfs-poster-settings__headless-tip">{t.posterHeadlessTip}</span>
        </div>

        {/* Branding */}
        <div class={`jfs-poster-settings__check-row${headless ? ' jfs-poster-settings__check-row--muted' : ''}`}>
          <input type="checkbox" id="branding" checked={overlay.brandingEnabled}
            disabled={headless}
            onChange={e => updateOverlay({ brandingEnabled: (e.target as HTMLInputElement).checked })} />
          <label for="branding">{t.posterBrandingLabel}</label>
          {overlay.brandingEnabled && (
            <input type="text" class="jfs-poster-settings__text-input"
              value={overlay.brandingText} maxLength={200}
              onInput={e => updateOverlay({ brandingText: (e.target as HTMLInputElement).value })} />
          )}
        </div>
        {overlay.brandingEnabled && (
          <div class={`jfs-poster-settings__sub-checks${headless ? ' jfs-poster-settings__sub-checks--muted' : ''}`}>
            {showLatin && (
              <>
                <label class="jfs-poster-settings__label" style="margin-bottom:0.3rem">
                  {brandCJK ? t.posterBrandingLatinFont : t.posterBrandingFont}
                </label>
                <div class="jfs-poster-settings__font-group">
                  {latinFontsAll.map(f => (
                    <button
                      key={f.value}
                      disabled={headless}
                      class={`jfs-poster-settings__font-btn${'custom' in f && f.custom ? ' jfs-poster-settings__font-btn--custom' : ''}${overlay.brandingLatinFont === f.value ? ' jfs-poster-settings__font-btn--active' : ''}`}
                      style={'style' in f ? (f as { style: string }).style : ''}
                      onClick={(e) => { updateOverlay({ brandingLatinFont: f.value }); (e.currentTarget as HTMLButtonElement).blur(); }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            {showCJK && (
              <>
                <label class="jfs-poster-settings__label" style="margin-bottom:0.3rem;margin-top:0.4rem">
                  {brandLatin ? t.posterBrandingCjkFont : t.posterBrandingFont}
                </label>
                <div class="jfs-poster-settings__font-group">
                  {cjkFontsAll.map(f => (
                    <button
                      key={f.value}
                      disabled={headless}
                      class={`jfs-poster-settings__font-btn${'custom' in f && f.custom ? ' jfs-poster-settings__font-btn--custom' : ''}${overlay.brandingCjkFont === f.value ? ' jfs-poster-settings__font-btn--active' : ''}`}
                      onClick={(e) => { updateOverlay({ brandingCjkFont: f.value }); (e.currentTarget as HTMLButtonElement).blur(); }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Video info */}
        <div class={`jfs-poster-settings__check-row${headless ? ' jfs-poster-settings__check-row--muted' : ''}`}>
          <input type="checkbox" id="videoInfo" checked={overlay.videoInfoEnabled}
            disabled={headless}
            onChange={e => updateOverlay({ videoInfoEnabled: (e.target as HTMLInputElement).checked })} />
          <label for="videoInfo">{t.posterVideoInfo}</label>
        </div>
        {overlay.videoInfoEnabled && (
          <div class={`jfs-poster-settings__sub-checks${headless ? ' jfs-poster-settings__sub-checks--muted' : ''}`}>
            {([
              ['showFileSize', 'posterFileSize'],
              ['showDuration', 'posterDuration'],
              ['showResolutionFps', 'posterResolutionFps'],
              ['showVideoEncoding', 'posterVideoEncoding'],
              ['showAudioEncoding', 'posterAudioEncoding'],
              ['showSubtitles', 'posterSubtitles'],
            ] as [keyof OverlaySettingsDto, keyof typeof t][]).map(([key, labelKey]) => (
              <div key={key} class="jfs-poster-settings__check-row">
                <input type="checkbox" id={key} checked={overlay[key] as boolean}
                  disabled={headless}
                  onChange={e => updateOverlay({ [key]: (e.target as HTMLInputElement).checked })} />
                <label for={key}>{t[labelKey]}</label>
              </div>
            ))}
          </div>
        )}

        {/* Timestamp badge */}
        <div class="jfs-poster-settings__check-row">
          <input type="checkbox" id="timestamp" checked={overlay.showFrameTimestamp}
            onChange={e => updateOverlay({ showFrameTimestamp: (e.target as HTMLInputElement).checked })} />
          <label for="timestamp">{t.posterTimestamp}</label>
        </div>

        {/* Timestamp options — font, bg, shadow, position */}
        {overlay.showFrameTimestamp && (
          <div class="jfs-poster-settings__sub-checks">
            <div class="jfs-poster-settings__check-row">
              <span class="jfs-poster-settings__label" style="margin-bottom:0">{t.posterTimestampFont}</span>
              <div class="jfs-poster-settings__theme-group" style="margin-top:0.25rem">
                {TIMESTAMP_FONTS.map(f => (
                  <button
                    key={f.value}
                    class={`jfs-poster-settings__theme-btn${overlay.timestampFont === f.value ? ' jfs-poster-settings__theme-btn--active' : ''}`}
                    onClick={(e) => { updateOverlay({ timestampFont: f.value }); (e.currentTarget as HTMLButtonElement).blur(); }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div class="jfs-poster-settings__check-row" style="margin-top:0.35rem">
              <input type="checkbox" id="ts-bg" checked={overlay.timestampBg}
                onChange={e => updateOverlay({ timestampBg: (e.target as HTMLInputElement).checked })} />
              <label for="ts-bg">{t.posterTimestampBg}</label>
            </div>
            <div class="jfs-poster-settings__check-row">
              <input type="checkbox" id="ts-shadow" checked={overlay.timestampShadow}
                onChange={e => updateOverlay({ timestampShadow: (e.target as HTMLInputElement).checked })} />
              <label for="ts-shadow">{t.posterTimestampShadow}</label>
            </div>
            <label class="jfs-poster-settings__label" style="margin-bottom:0.3rem;margin-top:0.35rem">{t.posterTimestampPos}</label>
            <TimestampPosPicker
              value={overlay.timestampPosition as TimestampPos}
              onChange={v => updateOverlay({ timestampPosition: v })}
            />
          </div>
        )}
      </div>

      {/* Color theme — toggle buttons */}
      <div class="jfs-poster-settings__section">
        <label class="jfs-poster-settings__label">{t.posterTheme}</label>
        <div class="jfs-poster-settings__theme-group">
          {THEMES.map(theme => (
            <button
              key={theme}
              class={`jfs-poster-settings__theme-btn${overlay.colorTheme === theme ? ' jfs-poster-settings__theme-btn--active' : ''}`}
              onClick={(e) => { updateOverlay({ colorTheme: theme }); (e.currentTarget as HTMLButtonElement).blur(); }}
            >
              {theme.charAt(0).toUpperCase() + theme.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Font family for overlay labels/timestamps — CJK-capable only */}
      <div class="jfs-poster-settings__section">
        <label class="jfs-poster-settings__label">{t.posterFont}</label>
        <div class="jfs-poster-settings__font-group">
          {overlayFontsAll.map(f => (
            <button
              key={f.value}
              class={`jfs-poster-settings__font-btn${'custom' in f && f.custom ? ' jfs-poster-settings__font-btn--custom' : ''}${overlay.fontFamily === f.value ? ' jfs-poster-settings__font-btn--active' : ''}`}
              onClick={(e) => { updateOverlay({ fontFamily: f.value }); (e.currentTarget as HTMLButtonElement).blur(); }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Overlay language — toggle buttons */}
      <div class="jfs-poster-settings__section">
        <label class="jfs-poster-settings__label">{t.posterLang}</label>
        <div class="jfs-poster-settings__theme-group">
          {LANGS.map(lang => (
            <button
              key={lang}
              class={`jfs-poster-settings__theme-btn${overlay.lang === lang ? ' jfs-poster-settings__theme-btn--active' : ''}`}
              onClick={(e) => { updateOverlay({ lang }); (e.currentTarget as HTMLButtonElement).blur(); }}
            >
              {lang === 'en' ? t.posterLangEn : lang === 'zh' ? t.posterLangZh : t.posterLangJa}
            </button>
          ))}
        </div>
      </div>

      {/* Custom fonts */}
      <div class="jfs-poster-settings__section">
        <label class="jfs-poster-settings__label">{t.posterCustomFonts}</label>
        <p class="jfs-poster-settings__hint">{t.posterCustomFontHint}</p>
        {userFonts.length > 0 && (
          <div class="jfs-poster-settings__custom-font-list">
            {userFonts.map((f) => (
              <div key={f.key} class="jfs-poster-settings__custom-font-row">
                <span class="jfs-poster-settings__custom-font-name">{f.displayName || f.key.slice('custom-'.length)}</span>
                <span class="jfs-poster-settings__custom-font-tags">
                  <span class={`jfs-poster-settings__custom-font-tag jfs-poster-settings__custom-font-tag--${f.script}`}>{f.script.toUpperCase()}</span>
                  <span class="jfs-poster-settings__custom-font-tag jfs-poster-settings__custom-font-tag--format">{f.format.toUpperCase()}</span>
                  {f.isSerif === true && <span class="jfs-poster-settings__custom-font-tag jfs-poster-settings__custom-font-tag--meta">Serif</span>}
                  {f.isSerif === false && <span class="jfs-poster-settings__custom-font-tag jfs-poster-settings__custom-font-tag--meta">Sans</span>}
                  {f.isMonospace && <span class="jfs-poster-settings__custom-font-tag jfs-poster-settings__custom-font-tag--meta">Mono</span>}
                  {f.isBold && <span class="jfs-poster-settings__custom-font-tag jfs-poster-settings__custom-font-tag--meta">Bold</span>}
                  {f.isItalic && <span class="jfs-poster-settings__custom-font-tag jfs-poster-settings__custom-font-tag--meta">Italic</span>}
                  {f.hasLigatures && <span class="jfs-poster-settings__custom-font-tag jfs-poster-settings__custom-font-tag--meta">Liga</span>}
                </span>
                <button
                  class="jfs-poster-settings__custom-font-del"
                  onClick={() => handleDeleteFont(f.key)}
                  title={t.posterCustomFontDelete}
                >
                  <MdRemove size={14} />
                  {t.posterCustomFontDelete}
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Hidden native file input triggered by styled button */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          style="display:none"
          onChange={e => setUploadFile((e.target as HTMLInputElement).files?.[0] ?? null)}
        />
        <div class="jfs-poster-settings__custom-font-upload">
          <button
            class="jfs-poster-settings__theme-btn"
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            {t.posterCustomFontChoose}
          </button>
          {uploadFile && (
            <>
              <span class="jfs-poster-settings__custom-font-selected">{uploadFile.name}</span>
              <button
                class="jfs-poster-settings__theme-btn jfs-poster-settings__theme-btn--accent"
                disabled={uploading}
                onClick={handleUpload}
                type="button"
              >
                {t.posterCustomFontUpload}
              </button>
            </>
          )}
        </div>
        {uploadError && <p class="jfs-poster-settings__preview-error">{uploadError}</p>}
      </div>

      {/* Preview + Disable row */}
      <div class="jfs-poster-settings__section">
        <div class="jfs-poster-settings__preview-row">
          <button class="jfs-poster-settings__preview-btn" onClick={handlePreview} disabled={previewLoading}>
            {previewLoading ? t.posterPreviewLoading : t.posterPreview}
          </button>
          <span class="jfs-poster-settings__row-spacer" />
          {onDisable && (
            <button class="jfs-poster-settings__disable-btn" onClick={onDisable} title={t.posterDisable}>
              {t.posterDisable}
            </button>
          )}
        </div>
        {previewError && <p class="jfs-poster-settings__preview-error">{previewError}</p>}
      </div>

      {previewLightboxOpen && previewUrl && (
        <Lightbox
          src={previewUrl}
          alt={t.posterPreview}
          onClose={() => setPreviewLightboxOpen(false)}
          onDownload={() => downloadBlob(previewUrl, 'poster-preview.webp')}
        />
      )}

      {!settingsOnly && (
        <button
          class="jfs-poster-settings__generate-btn"
          onClick={handleGenerate}
          disabled={tooManyFrames}
        >
          {t.posterGenerate} ({rows}x{cols} = {frameCount} {t.posterFrames})
        </button>
      )}

    </div>
  )
}
