import { useMutation, useQuery } from "@tanstack/react-query";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { frameUrl, generateExportMutation, openPrefetchRangeStream } from "../api/frameExportApi";
import { itemNameQuery } from "../api/jellyfinApi";
import { suite } from "../api/routes";
import type { FrameEntry, FrameInfoEntry } from "../core/state";
import {
  _feOpen,
  _fiMaxIdx,
  _fiMinIdx,
  _fpsFrac,
  _frameIndex,
  _frames,
  _itemId,
  _maxPosMs,
  _minPosMs,
  _savedState,
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
import { apiUrl } from "../lib/fetchApi";
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

// ── Generic SSE hook ────────────────────────────────────────────────────────

/**
 * Opens an EventSource, parses each JSON message via `parse`,
 * accumulates valid items, and signals `done` when the stream ends.
 * `getUrl` returns null to skip the connection.
 */
function useSse<T>(
  getUrl: () => string | null,
  parse: (data: any) => T | null | "done",
  deps: React.DependencyList,
): { items: T[]; done: boolean } {
  const [state, setState] = useState<{ items: T[]; done: boolean }>({
    items: [],
    done: false,
  });

  useEffect(() => {
    const url = getUrl();
    if (!url) return;
    const acc: T[] = [];
    const es = new EventSource(url);
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (acc.length === 0) {
        es.close();
        setState({ items: [], done: true });
      }
    }, 30000);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      es.close();
      setState({ items: [...acc], done: true });
    };
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (Array.isArray(data)) {
          for (const item of data) {
            const result = parse(item);
            if (result === "done") {
              finish();
              break;
            } else if (result !== null) acc.push(result);
          }
        } else {
          const result = parse(data);
          if (result === "done") {
            finish();
          } else if (result !== null) {
            acc.push(result);
          }
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      // only finish on error if we already received data
      if (acc.length > 0) finish();
    };
    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, deps);

  return state;
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
  const playbackMs = Math.round(videoEl.currentTime * 1000)

  // ── 2. State ────────────────────────────────────────────────────────────────

  const [firstThumbnailReady, setFirstThumbnailReady] = useState(false)

  // ── 3. SSE Streams ────────────────────────────────────────────────────────────

  const fpsRef = useRef({ num: 24, den: 1 });

  const frameInfoSse = useSse<FrameInfoEntry>(
    // _frameIndex !== null → 帧索引已由后台预加载完整建立，跳过重复请求
    () => (_frameIndex === null && !!itemId && !Number.isNaN(playbackMs))
      ? apiUrl(suite.frameInfoStream(itemId, playbackMs))
      : null,
    (data) => {
      if (data?.fps) {
        fpsRef.current = data.fps
        return 'done'
      }
      if (data && typeof data.ms === 'number') return data as FrameInfoEntry
      return null
    },
    [itemId],
  )

  const frameInfoReady = frameInfoSse.done || (_frameIndex !== null && _frameIndex.length > 0)

  useEffect(() => {
    if (frameInfoSse.done) {
      setFpsFrac(fpsRef.current);
      if (frameInfoSse.items.length > 0) {
        const sorted = [...frameInfoSse.items].sort((a, b) => a.ms - b.ms)
        setFrameIndex(sorted)
      }
    }
  }, [frameInfoSse.done]);

  const { data: fetchedName } = useQuery(itemNameQuery(itemId));

  // ── 4. Mutations ────────────────────────────────────────────────────────────

  const generateMutation = useMutation(generateExportMutation());

  // ── 5. Helpers ──────────────────────────────────────────────────────────────

  function framesPerSecond(): number {
    return Math.round(_fpsFrac.num / _fpsFrac.den);
  }

  const markFrameReady = useCallback((idx: number) => {
    setFrames(
      _frames.map((f, i) =>
        i === idx
          ? { ...f, jpegUrl: frameUrl(_itemId, f.fiIdx, f.posMs, 320), loadError: false }
          : f,
      ),
    );
    setFirstThumbnailReady(true);
  }, []);

  const triggerPrefetch = useCallback(() => {
    prefetchAbortRef.current?.abort();
    if (_minPosMs > _maxPosMs) return;
    const centerMs = Math.round((_minPosMs + _maxPosMs) / 2);
    const beforeSeconds = (centerMs - _minPosMs) / 1000;
    const afterSeconds = (_maxPosMs - centerMs) / 1000;
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
      fpsFrac: { ..._fpsFrac },
      lastClickedIdx: -1,
      fiMinIdx: _fiMinIdx,
      fiMaxIdx: _fiMaxIdx,
    });
  }

  // ── 6. Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    setVideoEl(videoEl);
    setActiveTaskId("");
    if (itemId !== _itemId) {
      setFrameIndex(null);
      setFpsFrac({ num: 24, den: 1 });
      setTimeout(() => setFirstThumbnailReady(false), 0);
    }
    setItemId(itemId);
    videoEl.pause();
    setBodyModalOpen(true);
    setGesturesSuspended(true);
  }, [videoEl, itemId]);

  useEffect(() => {
    if (fetchedName) setItemTitle(fetchedName);
  }, [fetchedName]);


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
      setTimeout(() => setFirstThumbnailReady(true), 0);
      return;
    }
    if (_frameIndex && _frameIndex.length > 0 && !_frames.length) {
      const centerIndex = findCenterFrameIndex(_frameIndex, ms);
      const [rangeStart, rangeEnd] = findRangeFromCenter(_frameIndex, centerIndex);
      sPage.value = "grid";
      sLightboxIdx.value = null;
      applyFrameRange(_frameIndex, ms, rangeStart, rangeEnd);
      setTimeout(triggerPrefetch, 0);
      return;
    }
    sPage.value = "grid";
    sLightboxIdx.value = null;
  }, [videoEl, itemId, frameInfoSse.done, triggerPrefetch]);

  useEffect(() => {
    return () => { prefetchAbortRef.current?.abort(); };
  }, []);

  // ── 7. Callbacks ────────────────────────────────────────────────────────────

  const expandBack = useCallback(() => {
    if (!_frameIndex) return;
    const step = framesPerSecond(),
      start = _fiMinIdx - step;
    if (start < 0) return;
    const entries = _frameIndex.slice(start, _fiMinIdx).map(makeEntry);
    setFrames([...entries, ..._frames]);
    setFiMinIdx(start);
    setMinPosMs(_frameIndex[start].ms);
    triggerPrefetch();
  }, [triggerPrefetch]);

  const expandForward = useCallback(() => {
    if (!_frameIndex) return;
    const step = framesPerSecond(),
      end = _fiMaxIdx + step;
    if (end >= _frameIndex.length) return;
    const entries = _frameIndex.slice(_fiMaxIdx + 1, end + 1).map(makeEntry);
    setFrames([..._frames, ...entries]);
    setFiMaxIdx(end);
    setMaxPosMs(_frameIndex[end].ms);
    triggerPrefetch();
  }, [triggerPrefetch]);

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
              loading={!frameInfoReady && !firstThumbnailReady}
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
