import { useMutation, useQuery } from "@tanstack/react-query";
import { atom, getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import { frameUrl, generateExportMutation, openFrameInfoStream, openPrefetchRangeStream } from "../api/frameExportApi";
import { itemNameQuery } from "../api/jellyfinApi";
import type { FrameEntry, FrameInfoEntry } from "../core/state";
import {
  _feOpen,
  _fi,
  _frames,
  _itemId,
  _maxPosMs,
  _minPosMs,
  _savedState,
  framesAtom,
  modalMinimizedAtom,
  pageAtom,
  setActiveTaskId,
  setDragMode,
  setFiMaxIdx,
  setFiMinIdx,
  setFpsFrac,
  setFrameIndex,
  setFrames,
  setItemId,
  setItemTitle,
  setLastClickedIdx,
  setMaxPosMs,
  setMinPosMs,
  setSavedState,
  setSuppressNextMousedown,
  setVideoEl,
  sExportType,
  sFileSize,
  sLightboxIdx,
  sModalPhase,
  sPage,
  sPrefetchDone,
  sPrefetchTotal,
  sProgressTaskId,
  sResultUrl,
  sSettings,
} from "../core/state";
import { setGesturesSuspended } from "../hooks/useGestures";
import { bench } from "../lib/bench";
import { t } from "../lib/i18n";
import { CropPopover } from "./CropPopover";
import { ErrorBoundary } from "./ErrorBoundary";
import { FrameGridSkeleton } from "./FrameGridSkeleton";
import { GridPage } from "./GridPage";
import { Lightbox } from "./Lightbox";
import { ProgressPage } from "./ProgressPage";
import { ResultPage } from "./ResultPage";

// ── Module-level helpers ───────────────────────────────────────────────────────

const jstore = getDefaultStore();
const MODAL_BODY_CLASS = "jfs-fe-open";

function setBodyModalOpen(open: boolean) {
  if (open) document.body.classList.add(MODAL_BODY_CLASS);
  else document.body.classList.remove(MODAL_BODY_CLASS);
}

function findCenterFrameIndex(
  frames: FrameInfoEntry[],
  currentMs: number,
): number {
  for (let i = frames.length - 1; i >= 0; i--)
    if (frames[i].ms <= currentMs) return i;
  return 0;
}

function findRangeFromCenter(
  frames: FrameInfoEntry[],
  centerIndex: number,
): [number, number] {
  const startMs = frames[centerIndex].ms - 1000;
  const endMs = frames[centerIndex].ms + 1000;
  let rangeStart = 0;
  for (let i = 0; i < frames.length; i++)
    if (frames[i].ms >= startMs) {
      rangeStart = i;
      break;
    }
  let rangeEnd = frames.length - 1;
  for (let i = frames.length - 1; i >= 0; i--)
    if (frames[i].ms <= endMs) {
      rangeEnd = i;
      break;
    }
  return [rangeStart, rangeEnd];
}

function makeEntry(f: FrameInfoEntry): FrameEntry {
  return {
    posMs: f.ms,
    fiIdx: f.frameIndex,
    selected: true,
    jpegUrl: "",
    isJunk: false,
    junkReason: null,
  };
}

function applyFrameRange(
  frames: FrameInfoEntry[],
  center: number,
  start: number,
  end: number,
) {
  setFiMinIdx(start);
  setFiMaxIdx(end);
  const slice = frames.slice(start, end + 1);
  setMinPosMs(slice[0]?.ms ?? center);
  setMaxPosMs(slice[slice.length - 1]?.ms ?? center);
  setFrames(slice.map(makeEntry));
}

// ── Inner modal ───────────────────────────────────────────────────────────────

function FrameExportModalInner({
  videoEl,
  itemId,
  minimized,
}: {
  videoEl: HTMLVideoElement;
  itemId: string;
  minimized: boolean;
}) {
  // ── 1. Refs + atoms + local ──────────────────────────────────────────────────

  const closeModal = useSetAtom(_feOpen)

  useEffect(() => {
    const onDetach = () => {
      if (!videoEl.isConnected) {
        setGesturesSuspended(false)
        setBodyModalOpen(false)
        closeModal(null)
      }
    }
    const mo = new MutationObserver(onDetach)
    mo.observe(videoEl.parentElement ?? document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])

  const rootRef = useRef<HTMLDivElement>(null)
  const prefetchAbortRef = useRef<AbortController | null>(null)
  const page = useAtomValue(pageAtom)

  // ── 2. State ────────────────────────────────────────────────────────────────

  const hasFramesAtom = useMemo(() => atom(get => get(framesAtom).length > 0), [])
  const hasFrames = useAtomValue(hasFramesAtom)

  // ── 3. Frame index accumulator ───────────────────────────────────────────────

  const frameAccRef = useRef<FrameInfoEntry[]>([])

  const { data: fetchedName } = useQuery(itemNameQuery(itemId));

  // ── 4. Mutations ────────────────────────────────────────────────────────────

  const generateMutation = useMutation(generateExportMutation());

  // ── 5. Helpers ──────────────────────────────────────────────────────────────

  function framesPerSecond(): number {
    return Math.round(_fi.fpsFrac.num / _fi.fpsFrac.den);
  }

  const markFrameReady = useCallback((idx: number) => {
    bench.once('first_thumb_ready', 'first_thumb_url_set', { idx })
    setFrames(
      _frames.map((f, i) =>
        i === idx
          ? { ...f, jpegUrl: frameUrl(_itemId, f.fiIdx, f.posMs, 320), loadError: false }
          : f,
      ),
    );
  }, []);

  const triggerPrefetch = useCallback(() => {
    prefetchAbortRef.current?.abort();
    if (_minPosMs > _maxPosMs) return;
    const centerMs = Math.round((_minPosMs + _maxPosMs) / 2);
    const beforeSeconds = (centerMs - _minPosMs) / 1000;
    const afterSeconds = (_maxPosMs - centerMs) / 1000;
    bench.mark('prefetch_triggered', { centerMs, beforeSeconds, afterSeconds })
    prefetchAbortRef.current = openPrefetchRangeStream(
      itemId,
      { currentTimeMs: centerMs, beforeSeconds, afterSeconds, includeCurrentFrame: true, width: 320 },
      (fiIdx) => {
        const idx = _frames.findIndex((f) => f.fiIdx === fiIdx);
        if (idx >= 0) markFrameReady(idx);
      },
      () => {},
      () => {},
    );
  }, [itemId, markFrameReady]);

  function saveState() {
    setSavedState({
      itemId: _itemId,
      frames: _frames.map((f) => ({ ...f })),
      exportType: sExportType.value,
      minPosMs: _minPosMs,
      maxPosMs: _maxPosMs,
      fpsFrac: { ..._fi.fpsFrac },
      lastClickedIdx: -1,
      fiMinIdx: _fi.minIdx,
      fiMaxIdx: _fi.maxIdx,
    });
  }

  // ── 6. Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    bench.reset()
    bench.mark('modal_open', { itemId, posMs: Math.round(videoEl.currentTime * 1000) })
    setVideoEl(videoEl);
    setActiveTaskId("");
    if (itemId !== _itemId) {
      setFrameIndex(null);
      setFpsFrac({ num: 24, den: 1 });
      setFrames([]);
    }
    setItemId(itemId);
    videoEl.pause();
    setBodyModalOpen(true);
    setGesturesSuspended(true);
  }, [videoEl, itemId]);

  useEffect(() => {
    if (fetchedName) setItemTitle(fetchedName);
  }, [fetchedName]);

  // savedState restore — runs before the streaming effect (definition order)
  useEffect(() => {
    const ms = Math.round(videoEl.currentTime * 1000);
    if (
      _savedState &&
      _savedState.itemId === itemId &&
      ms >= _savedState.minPosMs &&
      ms <= _savedState.maxPosMs
    ) {
      setFrames(_savedState.frames.map((f) => ({ ...f })));
      sExportType.value = _savedState.exportType;
      setMinPosMs(_savedState.minPosMs);
      setMaxPosMs(_savedState.maxPosMs);
      setFpsFrac(_savedState.fpsFrac);
      setLastClickedIdx(_savedState.lastClickedIdx);
      setFiMinIdx(_savedState.fiMinIdx);
      setFiMaxIdx(_savedState.fiMaxIdx);
      sPrefetchTotal.value = 0;
      sPrefetchDone.value = 0;
      sPage.value = "grid";
      sLightboxIdx.value = null;
    }
  }, [videoEl, itemId]);

  // frameInfo streaming — incremental: Queue A batch shows grid, Queue B fills index
  useEffect(() => {
    frameAccRef.current = [];
    if (!itemId) return;

    const ms = Math.round(videoEl.currentTime * 1000);
    sPage.value = "grid";
    sLightboxIdx.value = null;

    if (_fi.index !== null && _fi.index.length > 0) {
      // Repeat visit: show grid immediately, open SSE only for priority adjustment
      bench.mark('frameinfo_sse_priority_adjust', { ms, frameIndexSize: _fi.index.length })
      if (!_frames.length) {
        const center = findCenterFrameIndex(_fi.index, ms);
        const [rangeStart, rangeEnd] = findRangeFromCenter(_fi.index, center);
        applyFrameRange(_fi.index, ms, rangeStart, rangeEnd);
        triggerPrefetch();
      }
      const es = openFrameInfoStream(itemId, ms, () => es.close(), () => {}, () => {});
      return () => es.close();
    }

    // First visit: build frame index incrementally from SSE
    let gridShown = _frames.length > 0; // savedState may have set frames already
    bench.mark('frameinfo_sse_open', { ms, savedStateFrames: _frames.length })

    const es = openFrameInfoStream(
      itemId, ms,
      (batch) => {
        bench.once('frameinfo_first_batch', 'frameinfo_first_batch_recv', { count: batch.length })
        frameAccRef.current = [...frameAccRef.current, ...batch];
        const sorted = [...frameAccRef.current].sort((a, b) => a.ms - b.ms);
        setFrameIndex(sorted);
        if (!gridShown) {
          gridShown = true;
          bench.mark('grid_shown', { framesInRange: sorted.length })
          const center = findCenterFrameIndex(sorted, ms);
          const [rangeStart, rangeEnd] = findRangeFromCenter(sorted, center);
          applyFrameRange(sorted, ms, rangeStart, rangeEnd);
          triggerPrefetch();
        }
      },
      (fps) => {
        setFpsFrac(fps);
        const sorted = [...frameAccRef.current].sort((a, b) => a.ms - b.ms);
        const seen = new Set<number>();
        setFrameIndex(sorted.filter(f => {
          if (seen.has(f.frameIndex)) return false;
          seen.add(f.frameIndex);
          return true;
        }));
      },
      () => {},
    );

    return () => es.close();
  }, [itemId, triggerPrefetch]);

  useEffect(() => {
    return () => { prefetchAbortRef.current?.abort(); };
  }, []);

  // ── 7. Callbacks ────────────────────────────────────────────────────────────

  const expandBack = useCallback(() => {
    if (!_fi.index) return;
    const step = framesPerSecond(), start = _fi.minIdx - step;
    if (start < 0) return;
    const oldMinPosMs = _minPosMs;
    setFrames([..._fi.index.slice(start, _fi.minIdx).map(makeEntry), ..._frames]);
    setFiMinIdx(start);
    setMinPosMs(_fi.index[start].ms);
    prefetchAbortRef.current?.abort();
    prefetchAbortRef.current = openPrefetchRangeStream(
      itemId,
      { currentTimeMs: oldMinPosMs, beforeSeconds: (oldMinPosMs - _fi.index[start].ms) / 1000 + 0.1, afterSeconds: 0, includeCurrentFrame: false, width: 320 },
      (fiIdx) => { const idx = _frames.findIndex(f => f.fiIdx === fiIdx); if (idx >= 0) markFrameReady(idx); },
      () => {}, () => {},
    );
  }, [itemId, markFrameReady]);

  const expandForward = useCallback(() => {
    if (!_fi.index) return;
    const step = framesPerSecond(), end = _fi.maxIdx + step;
    if (end >= _fi.index.length) return;
    const oldMaxPosMs = _maxPosMs;
    setFrames([..._frames, ..._fi.index.slice(_fi.maxIdx + 1, end + 1).map(makeEntry)]);
    setFiMaxIdx(end);
    setMaxPosMs(_fi.index[end].ms);
    prefetchAbortRef.current?.abort();
    prefetchAbortRef.current = openPrefetchRangeStream(
      itemId,
      { currentTimeMs: oldMaxPosMs, beforeSeconds: 0, afterSeconds: (_fi.index[end].ms - oldMaxPosMs) / 1000 + 0.1, includeCurrentFrame: false, width: 320 },
      (fiIdx) => { const idx = _frames.findIndex(f => f.fiIdx === fiIdx); if (idx >= 0) markFrameReady(idx); },
      () => {}, () => {},
    );
  }, [itemId, markFrameReady]);

  const submitGenerate = useCallback(() => {
    const exportType = sExportType.value;
    const settings = sSettings.value;
    const selected = _frames.filter((f) => f.selected && !f.removed);
    if (
      selected.length > 240 &&
      !confirm(t("export.largeWarning").replace("{n}", String(selected.length)))
    )
      return;
    const format =
      exportType === "animate" ? settings.animateFormat : settings.stitchFormat;
    const body = {
      itemId: _itemId,
      itemTitle: "",
      type: exportType,
      frames: selected.map((f) =>
        f.fiIdx >= 0
          ? { frameIdx: f.fiIdx }
          : { positionMs: Math.round(f.posMs) },
      ),
      params: {
        format,
        resizeMode: settings.width.mode === "userInput" ? "width" : "height",
        customWidth: settings.width.value || null,
        customHeight: settings.height.value || null,
        resolutionPreset: settings.resolutionPreset,
        speed: settings.speed,
        loopCount: settings.loopCount,
        cropX: settings.cropRect?.x ?? 0,
        cropY: settings.cropRect?.y ?? 0,
        cropW: settings.cropRect?.w ?? 0,
        cropH: settings.cropRect?.h ?? 0,
        quality:
          exportType === "animate"
            ? settings.animateQuality
            : settings.stitchQuality,
      },
    };
    generateMutation.mutate(body, {
      onSuccess: (taskId) => {
        sProgressTaskId.value = taskId;
        sPage.value = "progress";
      },
      onError: (e) => {
        alert(
          t("export.failed").replace(
            "{msg}",
            e instanceof Error ? e.message : String(e),
          ),
        );
      },
    });
  }, [generateMutation]);

  const handleClose = useCallback(() => {
    setGesturesSuspended(false);
    setBodyModalOpen(false);
    sLightboxIdx.value = null;
    sModalPhase.value = "skeleton";
    setLastClickedIdx(-1);
    setDragMode(false);
    setSuppressNextMousedown(false);
    if (_itemId && _frames.length > 0) saveState();
    closeModal(null);
  }, []);

  const handleMinimize = useCallback(() => {
    setGesturesSuspended(false);
    setBodyModalOpen(false);
    jstore.set(modalMinimizedAtom, true);
    if (_itemId && _frames.length > 0) saveState();
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (sLightboxIdx.value !== null) sLightboxIdx.value = null;
    else handleClose();
  }, []);

  // ── 9. Render ───────────────────────────────────────────────────────────────

  return createPortal(
    <ErrorBoundary
      fallback={
        <div style={{ color: "#f87171", padding: 16 }}>
          {t("progress.failed")}
        </div>
      }
    >
      <Suspense fallback={<FrameGridSkeleton count={48} />}>
        <div
          ref={rootRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          style={{
            position: "fixed",
            bottom: 12,
            left: "50%",
            zIndex: 99999,
            display: minimized ? "none" : "flex",
            flexDirection: "column",
            width: "min(92vw, 960px)",
            marginLeft: "calc(-1 * min(46vw, 480px))",
            fontFamily:
              '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
            pointerEvents: "auto",
          }}
        >
          {page === "grid" && (
            <GridPage
              onClose={handleClose}
              onExpandBack={expandBack}
              onExpandForward={expandForward}
              onGenerate={submitGenerate}
              loading={!hasFrames}
            />
          )}
          {page === "progress" && (
            <ProgressPage
              onClose={handleClose}
              onMinimize={handleMinimize}
              onResult={(url, size) => {
                sResultUrl.value = url;
                sFileSize.value = size;
                sPage.value = "result";
              }}
            />
          )}
          {page === "result" && (
            <ResultPage
              onClose={handleClose}
              onBack={() => {
                sPage.value = "grid";
              }}
            />
          )}
          <Lightbox />
          <CropPopover />
        </div>
      </Suspense>
    </ErrorBoundary>,
    document.body,
  );
}

function FrameExportModalApp() {
  const modalInfo = useAtomValue(_feOpen);
  const minimized = useAtomValue(modalMinimizedAtom);
  if (!modalInfo) return null;
  return (
    <FrameExportModalInner
      videoEl={modalInfo.videoEl}
      itemId={modalInfo.itemId}
      minimized={minimized}
    />
  );
}

export { FrameExportModalApp };
