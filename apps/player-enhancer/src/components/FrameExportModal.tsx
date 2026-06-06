import { useMutation, useQuery } from "@tanstack/react-query";
import { atom, getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { Suspense, memo, useCallback, useEffect, useMemo, useRef } from "react";
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
  setFiIndexComplete,
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

// Returns the array index of the frame "containing" ms (last frame with ms <= target).
// A frame spans [its ms, next frame's ms). Returns 0 if before all frames.
function frameIdxAt(frames: FrameInfoEntry[], ms: number): number {
  for (let i = frames.length - 1; i >= 0; i--)
    if (frames[i].ms <= ms) return i;
  return 0;
}

// Binary search: first index where frames[i].ms >= ms
function bsFirst(frames: FrameInfoEntry[], ms: number): number {
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].ms < ms) lo = mid + 1; else hi = mid; }
  return lo;
}

// Binary search: last index where frames[i].ms <= ms (-1 if none)
function bsLast(frames: FrameInfoEntry[], ms: number): number {
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].ms <= ms) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

// Re-sync _fi.minIdx / _fi.maxIdx after _fi.index expands (Queue B batches shift positions).
function resyncFiRange(index: FrameInfoEntry[]) {
  if (_minPosMs > _maxPosMs || index.length === 0) return;
  const newMin = bsFirst(index, _minPosMs);
  const newMax = bsLast(index, _maxPosMs);
  if (newMin < index.length) setFiMinIdx(newMin);
  if (newMax >= 0)           setFiMaxIdx(newMax);
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

const FrameExportModalInner = memo(function FrameExportModalInner({
  videoEl,
  itemId,
  minimized,
  posMs,
}: {
  videoEl: HTMLVideoElement;
  itemId: string;
  minimized: boolean;
  posMs: number;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (_frames.length === 0) return;
    // 用展示范围中心（不用 posMs），确保返回的 fiIdx 与 _frames 一致
    const centerMs = Math.round((_minPosMs + _maxPosMs) / 2);
    bench.mark('prefetch_triggered', { centerMs })
    prefetchAbortRef.current = openPrefetchRangeStream(
      itemId,
      { currentTimeMs: centerMs, beforeSeconds: 1, afterSeconds: 1, includeCurrentFrame: true, width: 320 },
      (fiIdx) => {
        const idx = _frames.findIndex((f) => f.fiIdx === fiIdx);
        if (idx >= 0) markFrameReady(idx);
        else bench.mark('prefetch_no_match', { fiIdx, framesLen: _frames.length });
      },
      () => {},
      () => {},
    );
  }, [itemId, markFrameReady]);

  // Applies the ±1s display range centered at ms, then triggers prefetch.
  // Returns true if range was applied; false if grid was already showing or index not there yet.
  const applyRangeAt = useCallback((frames: FrameInfoEntry[], ms: number): boolean => {
    if (_frames.length > 0) return false;
    const center = frameIdxAt(frames, ms);
    // index 还没推送到目标位置，继续等 SSE 后续批次
    if (Math.abs(frames[center].ms - ms) > 1500) return false;
    const [rangeStart, rangeEnd] = findRangeFromCenter(frames, center);
    applyFrameRange(frames, ms, rangeStart, rangeEnd);
    triggerPrefetch();
    return true;
  }, [triggerPrefetch]);

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
    bench.mark('modal_open', {
      itemId,
      posMs,
      sameItem: itemId === _itemId,
      hasSavedState: !!_savedState && _savedState.itemId === itemId,
      existingFrames: _frames.length,
      hasFrameIndex: _fi.index !== null,
    })
    setVideoEl(videoEl);
    setActiveTaskId("");
    if (itemId !== _itemId) {
      setFrameIndex(null);
      setFpsFrac({ num: 24, den: 1 });
      setFrames([]);
    } else if (_frames.length > 0 && (posMs < _minPosMs || posMs > _maxPosMs)) {
      setFrames([]);
    }
    setItemId(itemId);
    videoEl.pause();
    setBodyModalOpen(true);
    setGesturesSuspended(true);
  }, [videoEl, itemId, posMs]);

  useEffect(() => {
    if (fetchedName) setItemTitle(fetchedName);
  }, [fetchedName]);

  // savedState restore — runs before the streaming effect (definition order)
  useEffect(() => {
    if (
      _savedState &&
      _savedState.itemId === itemId &&
      posMs >= _savedState.minPosMs &&
      posMs <= _savedState.maxPosMs
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
  }, [videoEl, itemId, posMs]);

  // frameInfo streaming — incremental: Queue A batch shows grid, Queue B fills index.
  // Pattern: if index is already available → apply range immediately, open SSE for priority
  //          adjustment only; if not → open SSE, wait for first batch, then apply range.
  useEffect(() => {
    frameAccRef.current = [];
    if (!itemId) return;

    const ms = posMs;
    sPage.value = "grid";
    sLightboxIdx.value = null;

    const currentIndex = (_fi.index !== null && _fi.index.length > 0) ? _fi.index : null;
    const hadIndex = currentIndex !== null;

    if (hadIndex) {
      const wasComplete = _fi.indexComplete;
      bench.mark('frameinfo_sse_priority_adjust', { ms, frameIndexSize: currentIndex.length, wasComplete })
      applyRangeAt(currentIndex, ms);
      setFiIndexComplete(true);
      if (wasComplete) return; // index was already complete — skip SSE
    } else {
      setFiIndexComplete(false);
      bench.mark('frameinfo_sse_open', { ms, savedStateFrames: _frames.length })
    }

    const es = openFrameInfoStream(itemId, ms,
      (batch) => {
        const minMs = batch.reduce((a, f) => Math.min(a, f.ms), Infinity)
        const maxMs = batch.reduce((a, f) => Math.max(a, f.ms), -Infinity)

        if (hadIndex) {
          // Priority adjustment: log and close — index was already complete
          bench.mark('priority_adjust_batch_recv', { targetMs: ms, batchSize: batch.length, minMs, maxMs, offMs: minMs - ms })
          es.close()
          return
        }

        // First visit: accumulate index, show grid on first successful applyRangeAt
        bench.once('frameinfo_first_batch', 'frameinfo_first_batch_recv', { count: batch.length, targetMs: ms, minMs, maxMs, offMs: minMs - ms })
        frameAccRef.current = [...frameAccRef.current, ...batch];
        const sorted = [...frameAccRef.current].sort((a, b) => a.ms - b.ms);
        setFrameIndex(sorted);
        if (applyRangeAt(sorted, ms)) {
          bench.mark('grid_shown', { framesInRange: sorted.length })
        } else {
          // Queue B batch: index expanded, resync minIdx/maxIdx to _minPosMs/_maxPosMs
          resyncFiRange(sorted);
        }
      },
      (fps) => {
        setFpsFrac(fps);
      },
      () => {
        const sorted = [...frameAccRef.current].sort((a, b) => a.ms - b.ms);
        const seen = new Set<number>();
        const deduped = sorted.filter(f => {
          if (seen.has(f.frameIndex)) return false;
          seen.add(f.frameIndex);
          return true;
        });
        setFrameIndex(deduped);
        resyncFiRange(deduped);
        setFiIndexComplete(true);
      },
      () => {},
    );

    return () => es.close();
  }, [itemId, videoEl, posMs, applyRangeAt]);

  useEffect(() => {
    return () => { prefetchAbortRef.current?.abort(); };
  }, []);

  // ── 7. Callbacks ────────────────────────────────────────────────────────────

  const expandBack = useCallback(() => {
    if (!_fi.index || _frames.length === 0) return;
    const firstFrame = _frames[0];
    const boundaryMs = firstFrame.posMs;
    const sliceEnd = bsLast(_fi.index, boundaryMs - 1); // last frame with ms < boundaryMs
    const start = bsFirst(_fi.index, boundaryMs - 1000);
    if (sliceEnd < 0 || start > sliceEnd) return;
    bench.mark('expand_back', {
      addingFiIdxRange: [start, sliceEnd],
      anchorFiIdx: _fi.index[start].frameIndex,
      framesBefore: _frames.length,
    });
    setFrames([..._fi.index.slice(start, sliceEnd + 1).map(makeEntry), ..._frames]);
    setFiMinIdx(start);
    setMinPosMs(_fi.index[start].ms);
    prefetchAbortRef.current?.abort();
    prefetchAbortRef.current = openPrefetchRangeStream(
      itemId,
      { currentFrameIndex: firstFrame.fiIdx, beforeSeconds: 1, includeCurrentFrame: false, width: 320 },
      (fiIdx) => { const idx = _frames.findIndex(f => f.fiIdx === fiIdx); if (idx >= 0) markFrameReady(idx); else bench.mark('prefetch_no_match_back', { fiIdx }); },
      () => bench.mark('expand_back_prefetch_done'),
      () => bench.mark('expand_back_prefetch_error'),
    );
  }, [itemId, markFrameReady]);

  const expandForward = useCallback(() => {
    if (!_fi.index || _frames.length === 0) return;
    const lastFrame = _frames[_frames.length - 1];
    const boundaryMs = lastFrame.posMs;
    const sliceStart = bsFirst(_fi.index, boundaryMs + 1); // first frame with ms > boundaryMs
    const end = bsLast(_fi.index, boundaryMs + 1000);
    if (sliceStart >= _fi.index.length || end < sliceStart) return;
    bench.mark('expand_forward', {
      addingFiIdxRange: [sliceStart, end],
      anchorFiIdx: _fi.index[sliceStart].frameIndex,
      framesBefore: _frames.length,
    });
    setFrames([..._frames, ..._fi.index.slice(sliceStart, end + 1).map(makeEntry)]);
    setFiMaxIdx(end);
    setMaxPosMs(_fi.index[end].ms);
    prefetchAbortRef.current?.abort();
    prefetchAbortRef.current = openPrefetchRangeStream(
      itemId,
      { currentFrameIndex: lastFrame.fiIdx, afterSeconds: 1, includeCurrentFrame: false, width: 320 },
      (fiIdx) => { const idx = _frames.findIndex(f => f.fiIdx === fiIdx); if (idx >= 0) markFrameReady(idx); else bench.mark('prefetch_no_match_fwd', { fiIdx }); },
      () => bench.mark('expand_forward_prefetch_done'),
      () => bench.mark('expand_forward_prefetch_error'),
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
  }, [closeModal]);

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
  }, [handleClose]);

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
              loading={!hasFrames || _itemId !== itemId}
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
});

function FrameExportModalApp() {
  const modalInfo = useAtomValue(_feOpen);
  const minimized = useAtomValue(modalMinimizedAtom);
  if (!modalInfo) return null;
  const posMs = Math.round(modalInfo.videoEl.currentTime * 1000);
  return (
    <FrameExportModalInner
      videoEl={modalInfo.videoEl}
      itemId={modalInfo.itemId}
      minimized={minimized}
      posMs={posMs}
    />
  );
}

export { FrameExportModalApp };
