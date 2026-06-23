//! Hardware-accelerated video decode (VAAPI for Intel/AMD, NVDEC/CUDA for NVIDIA).
//!
//! `ffmpeg-next`'s safe wrapper does not expose the `AVHWDeviceContext` API at all, so
//! this module talks to `ffmpeg_next::ffi` (a re-export of `ffmpeg_sys_next`, see
//! `ffmpeg-next`'s `lib.rs`: `pub extern crate ffmpeg_sys_next as sys; pub use sys as
//! ffi;`) directly. Every call here only touches the generic `libavutil/hwcontext.h`
//! surface (`av_hwdevice_ctx_create` / `av_hwframe_transfer_data` /
//! `AVCodecContext.hw_device_ctx`/`get_format`) — `ffmpeg-sys-next`'s `build.rs` only
//! feeds bindgen `hwcontext.h` (+ optionally `hwcontext_drm.h`), never the
//! vendor-specific `hwcontext_vaapi.h`/`hwcontext_cuda.h`, so the vendor structs
//! (`AVVAAPIDeviceContext`/`AVCUDADeviceContext`) are not bound and must not be touched
//! directly — `av_hwdevice_ctx_create` handles all vendor specifics internally once
//! given a plain device string (`"/dev/dri/renderD128"` for VAAPI, a CUDA device
//! ordinal like `"0"` for CUDA).
//!
//! This means no new build-time system dependency (`libva-dev`/`nv-codec-headers`) is
//! required — see `specs/013-frame-decode-hw-accel/research.md` §2 for the full trail.

use anyhow::{Context, Result};
use ffmpeg_next::ffi::*;
use std::ffi::CString;
use std::ptr;

/// Which vendor backend to probe/use. VAAPI covers both Intel and AMD (same ffmpeg
/// hwaccel path); NVIDIA goes through CUDA.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HwVendor {
    Vaapi,
    Cuda,
}

impl HwVendor {
    fn av_type(self) -> AVHWDeviceType {
        match self {
            HwVendor::Vaapi => AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
            HwVendor::Cuda => AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA,
        }
    }

    fn hw_pix_fmt(self) -> AVPixelFormat {
        match self {
            HwVendor::Vaapi => AVPixelFormat::AV_PIX_FMT_VAAPI,
            HwVendor::Cuda => AVPixelFormat::AV_PIX_FMT_CUDA,
        }
    }
}

/// Owns an `AVBufferRef` hw device context. Frees it via `av_buffer_unref` on drop —
/// unless ownership is transferred out via `into_raw` (used when handing it to an
/// `AVCodecContext.hw_device_ctx`, which takes ownership and frees it itself via
/// `avcodec_free_context`).
pub struct HwDeviceContext {
    ptr: *mut AVBufferRef,
}

/// `AVBufferRef` for a hw device context is designed to be shared across many decode
/// sessions (and threads — ffmpeg's `hwcontext_cuda.c` pushes/pops the right CUDA
/// context around each call internally, which is exactly what lets this be safe):
/// `av_buffer_ref` is the documented way to hand out additional owned references to
/// the same underlying device without re-initializing it. We only ever touch the
/// pointer through that refcounting API, never the pointee's fields directly, so
/// sharing it across threads via a `Mutex`-guarded cache is sound.
struct CachedDeviceCtx(*mut AVBufferRef);
unsafe impl Send for CachedDeviceCtx {}
unsafe impl Sync for CachedDeviceCtx {}

type DeviceCtxCacheKey = (HwVendor, Option<String>);
static DEVICE_CTX_CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<DeviceCtxCacheKey, CachedDeviceCtx>>> =
    std::sync::OnceLock::new();

impl HwDeviceContext {
    /// Probe + create a hw device context for `vendor`. `device` is the vendor-specific
    /// device string (`"/dev/dri/renderD128"` for VAAPI, a CUDA device ordinal such as
    /// `"0"` for CUDA), or `None` to let ffmpeg pick its own default device.
    ///
    /// Measured on real hardware (RTX 5060): a fresh `av_hwdevice_ctx_create(Cuda, ..)`
    /// costs ~230ms — CUDA context initialization is genuinely expensive, not a quick
    /// syscall. `decode_range_hw`'s callers in `frame-forge` (e.g.
    /// `handle_prefetch_range_stream`'s Pass-2) call this once *per frame*, each in its
    /// own short-lived ffmpeg decode session — paying that cost per frame made hw
    /// decode net *slower* than software despite the actual decode being faster. This
    /// caches one underlying device context per `(vendor, device)` for the daemon's
    /// whole lifetime and hands out cheap `av_buffer_ref` clones (a refcount bump, not
    /// a re-init) on every subsequent call — the real `av_hwdevice_ctx_create` now only
    /// ever runs once per vendor/device combination actually used.
    pub fn create(vendor: HwVendor, device: Option<&str>) -> Result<Self> {
        let cache = DEVICE_CTX_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
        let key: DeviceCtxCacheKey = (vendor, device.map(|s| s.to_string()));

        if let Some(cached) = cache.lock().unwrap().get(&key) {
            // SAFETY: `cached.0` is a live `AVBufferRef` the cache holds a permanent
            // reference to for the process lifetime (never unreffed) — `av_buffer_ref`
            // just increments its refcount and returns a new independently-owned
            // pointer to the same underlying device context.
            let new_ref = unsafe { av_buffer_ref(cached.0) };
            anyhow::ensure!(!new_ref.is_null(), "av_buffer_ref({vendor:?}) failed (allocation failure)");
            return Ok(Self { ptr: new_ref });
        }

        let device_c = device
            .map(CString::new)
            .transpose()
            .context("device string contains an interior NUL byte")?;
        let device_ptr = device_c.as_ref().map_or(ptr::null(), |c| c.as_ptr());

        let mut raw: *mut AVBufferRef = ptr::null_mut();
        // SAFETY: `av_hwdevice_ctx_create` takes a valid out-pointer (`&mut raw`,
        // starting null) plus either a NUL-terminated C string or NULL for `device`,
        // and `opts`/`flags` are documented as optional (NULL/0 is the common case).
        // On success it writes a new owned `AVBufferRef` into `raw`; on failure
        // (negative return) it leaves `raw` untouched (still null here), so there is
        // no partially-initialized pointer to clean up either way. `device_ptr` stays
        // valid for the call because `device_c` outlives it in this scope.
        let ret = unsafe {
            av_hwdevice_ctx_create(&mut raw, vendor.av_type(), device_ptr, ptr::null_mut(), 0)
        };
        if ret < 0 {
            anyhow::bail!("av_hwdevice_ctx_create({vendor:?}) failed: ffmpeg error {ret}");
        }

        let mut guard = cache.lock().unwrap();
        // Another thread may have created+cached one for the same key while we were
        // unlocked during the (slow) av_hwdevice_ctx_create call above — prefer
        // whichever got there first and drop the redundant one we just made, so the
        // cache only ever holds a single context per key.
        if let Some(cached) = guard.get(&key) {
            // SAFETY: see the cache-hit branch above.
            let new_ref = unsafe { av_buffer_ref(cached.0) };
            // SAFETY: `raw` is the context we just created above and own exclusively;
            // dropping it here (instead of returning it) is exactly what `av_buffer_unref`
            // is for — it was never handed to anything else.
            unsafe { av_buffer_unref(&mut raw) };
            anyhow::ensure!(!new_ref.is_null(), "av_buffer_ref({vendor:?}) failed (allocation failure)");
            return Ok(Self { ptr: new_ref });
        }
        // SAFETY: `raw` is non-null (checked via `ret < 0` above) and freshly created;
        // `av_buffer_ref` gives the cache its own independent reference to keep alive
        // for the process lifetime, separate from the one this function returns.
        let cache_ref = unsafe { av_buffer_ref(raw) };
        anyhow::ensure!(!cache_ref.is_null(), "av_buffer_ref({vendor:?}) failed (allocation failure)");
        guard.insert(key, CachedDeviceCtx(cache_ref));
        Ok(Self { ptr: raw })
    }

    /// Transfers ownership of the underlying `AVBufferRef` to the caller. After this,
    /// `Drop` becomes a no-op for this guard — the new owner is responsible for
    /// eventually releasing it (typically by assigning it to
    /// `AVCodecContext.hw_device_ctx`, which releases it when the codec context is
    /// freed).
    fn into_raw(mut self) -> *mut AVBufferRef {
        let p = self.ptr;
        self.ptr = ptr::null_mut();
        p
    }
}

impl Drop for HwDeviceContext {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            // SAFETY: `self.ptr` is either a valid `AVBufferRef` created in `create`
            // and never transferred out (`into_raw` nulls it first), or already null
            // (checked above). `av_buffer_unref` accepts `&mut *mut AVBufferRef` and
            // nulls it after decrementing the refcount, matching this guard's own
            // single-ownership invariant.
            unsafe { av_buffer_unref(&mut self.ptr) };
        }
    }
}

/// Carries the target hw pixel format into the `get_format` callback via
/// `AVCodecContext.opaque` — `get_format` is a plain C function pointer with no
/// closure-capture support, so this indirection is the standard pattern (mirrors
/// ffmpeg's own `doc/examples/hw_decode.c`).
pub struct GetFormatCtx {
    target: AVPixelFormat,
}

impl GetFormatCtx {
    /// Best-effort "stop offering the hw format" signal for use after a mid-stream
    /// transfer failure (FR-004). Only takes effect the next time ffmpeg actually
    /// re-invokes `get_format` (typically at a codec parameter change / new IDR with
    /// different parameters) — frames already mid-flight in the current GOP keep
    /// arriving in the hw format regardless, which is why callers must still handle
    /// `transfer_to_software` failures per-frame even after calling this.
    pub fn disable(&mut self) {
        self.target = AVPixelFormat::AV_PIX_FMT_NONE;
    }
}

unsafe extern "C" fn get_format(
    ctx: *mut AVCodecContext,
    fmts: *const AVPixelFormat,
) -> AVPixelFormat {
    // SAFETY: ffmpeg guarantees `ctx` is the same context `opaque` was set on (we set
    // both together in `attach_hw_device`), and `fmts` is a valid array of
    // `AVPixelFormat` terminated by `AV_PIX_FMT_NONE` — both are documented invariants
    // of `AVCodecContext.get_format`. We only read through `ctx`/`fmts`, never write,
    // and the loop below never reads past the `AV_PIX_FMT_NONE` terminator.
    unsafe {
        let target = if (*ctx).opaque.is_null() {
            AVPixelFormat::AV_PIX_FMT_NONE
        } else {
            (*(*ctx).opaque.cast::<GetFormatCtx>()).target
        };
        let mut p = fmts;
        while *p != AVPixelFormat::AV_PIX_FMT_NONE {
            if *p == target {
                return *p;
            }
            p = p.add(1);
        }
        // Target hw format wasn't offered for this stream — fall back to whatever
        // ffmpeg suggests first (typically a plain software format). The caller's
        // `is_hw_frame` check after `receive_frame` then correctly sees a non-hw
        // frame and skips the `transfer_to_software` step.
        *fmts
    }
}

/// Attaches a hw device context + `get_format` callback to an already-allocated
/// decoder context, so subsequent `avcodec_send_packet`/`avcodec_receive_frame` calls
/// (via the existing `ffmpeg_next` decode loop) produce hw-format frames.
///
/// `avctx_ptr` must come from the `ffmpeg_next::codec::decoder::Video` the caller is
/// about to drive (via its `as_mut_ptr()`), called **before** that decoder is opened
/// (ffmpeg requires `hw_device_ctx`/`get_format` to be set pre-open).
///
/// Returns a `Box<GetFormatCtx>` the caller MUST keep alive for at least as long as
/// `avctx_ptr`'s decoder — `AVCodecContext.opaque` is an untracked raw pointer, so
/// dropping this box early would leave `get_format` reading a dangling pointer on the
/// next decoded packet.
pub fn attach_hw_device(
    avctx_ptr: *mut AVCodecContext,
    device_ctx: HwDeviceContext,
    vendor: HwVendor,
) -> Box<GetFormatCtx> {
    let boxed = Box::new(GetFormatCtx { target: vendor.hw_pix_fmt() });
    // SAFETY: `avctx_ptr` is a live, not-yet-opened `AVCodecContext` owned by the
    // caller. We hand ownership of `device_ctx`'s `AVBufferRef` to the codec context
    // via `into_raw` (no extra `av_buffer_ref`), so it is released exactly once, when
    // this `AVCodecContext` is eventually freed via `avcodec_free_context`. `opaque`
    // is set to a raw pointer borrowed from `boxed`; the caller contract documented
    // above keeps `boxed` alive for the necessary duration, and `get_format` only
    // reads through it.
    unsafe {
        (*avctx_ptr).hw_device_ctx = device_ctx.into_raw();
        (*avctx_ptr).get_format = Some(get_format);
        (*avctx_ptr).opaque = boxed.as_ref() as *const GetFormatCtx as *mut std::ffi::c_void;
    }
    boxed
}

/// True if `frame` (just returned by `receive_frame`) is still in a hardware surface
/// format and needs `transfer_to_software` before any pixel-level processing (sws_scale
/// et al. cannot read hw surfaces directly).
pub fn is_hw_frame(frame: &ffmpeg_next::frame::Video, vendor: HwVendor) -> bool {
    // SAFETY: `frame.as_ptr()` is valid for any frame obtained from `receive_frame`;
    // `format` is a plain `c_int` field (ffmpeg declares `AVFrame.format` as `int`,
    // shared between pixel/sample format enums depending on media type — same pattern
    // `decoder.rs::frame_to_rgba` already relies on), so this is a read-only access
    // with no aliasing concerns.
    unsafe { (*frame.as_ptr()).format == vendor.hw_pix_fmt() as i32 }
}

/// Copies a hw-surface frame back to a normal software-format frame that the existing
/// `sws_scale`/WebP-encode pipeline in `decoder.rs` can consume unmodified.
pub fn transfer_to_software(
    hw_frame: &ffmpeg_next::frame::Video,
) -> Result<ffmpeg_next::frame::Video> {
    let mut sw_frame = ffmpeg_next::frame::Video::empty();
    // SAFETY: `av_hwframe_transfer_data` requires `dst` to be either empty (format
    // unset, which `Video::empty()` gives us) or already matching the source's implied
    // sw format/dimensions — passing an empty frame is the documented "let ffmpeg pick
    // the best matching sw format" mode. `src` must be a valid hw-surface frame, which
    // every call site below guarantees via `is_hw_frame` first. `flags = 0` is the
    // standard synchronous-copy mode (no `AV_HWFRAME_TRANSFER_DIRECTION_*` flags
    // needed for the simple to-software-copy case).
    let ret = unsafe { av_hwframe_transfer_data(sw_frame.as_mut_ptr(), hw_frame.as_ptr(), 0) };
    anyhow::ensure!(ret >= 0, "av_hwframe_transfer_data failed: ffmpeg error {ret}");
    Ok(sw_frame)
}

/// Lightweight probe: can we actually create a hw device context for `vendor` right
/// now? Used once at daemon startup (FR-010) to populate `HwDecodeCapabilities` —
/// doesn't decode anything, just exercises device creation, which fails the same way
/// (driver missing, device busy, permission denied) that a real decode attempt would.
pub fn probe(vendor: HwVendor, device: Option<&str>) -> Result<()> {
    HwDeviceContext::create(vendor, device).map(|_| ())
}

/// The three GPU vendors the device-selection UI/strategy distinguishes (data-model.md §2/§5).
/// NVIDIA always goes through the `Cuda` `HwVendor`; AMD and Intel share the `Vaapi` `HwVendor`
/// (same ffmpeg hwaccel path) and are told apart here only by which PCI vendor ID owns the
/// VAAPI-capable render node that was actually probed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeVendor {
    Nvidia,
    Amd,
    Intel,
}

#[derive(Debug, Clone)]
pub struct VendorCapability {
    pub vendor: DecodeVendor,
    pub supported: bool,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct HwDecodeCapabilities {
    pub supported: bool,
    pub vendors: Vec<VendorCapability>,
}

const PCI_VENDOR_ID_INTEL: &str = "0x8086";
const PCI_VENDOR_ID_AMD: &str = "0x1002";

/// Lists `/dev/dri/renderD*` nodes whose PCI vendor ID (`/sys/class/drm/renderDN/device/vendor`)
/// identifies them as Intel or AMD — the only way to tell those two vendors' VAAPI devices apart,
/// since `HwVendor::Vaapi` itself is vendor-agnostic (research.md §5: no monitor-attached /
/// clock-speed heuristics, just PCI classification, already the pattern
/// `DeviceEnumerationService.cs`'s `IsIntegrated` uses on the C# side).
fn enumerate_vaapi_render_nodes() -> Vec<(DecodeVendor, String)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("renderD") {
            continue;
        }
        let Ok(vendor_raw) = std::fs::read_to_string(entry.path().join("device/vendor")) else {
            continue;
        };
        let vendor = match vendor_raw.trim() {
            PCI_VENDOR_ID_INTEL => DecodeVendor::Intel,
            PCI_VENDOR_ID_AMD => DecodeVendor::Amd,
            _ => continue,
        };
        found.push((vendor, format!("/dev/dri/{name}")));
    }
    found
}

/// Probes all three vendors once (FR-010) and returns the cacheable result the daemon stores in
/// its `State` for the lifetime of the process — see `data-model.md` §2's `Unknown → Detected`
/// state transition. NVIDIA is probed directly via `HwVendor::Cuda`; AMD/Intel are probed by
/// trying every render node classified as that vendor by `enumerate_vaapi_render_nodes`, treating
/// the vendor as supported if any one of its render nodes succeeds.
pub fn detect_capabilities() -> HwDecodeCapabilities {
    let mut vendors = Vec::new();

    match HwDeviceContext::create(HwVendor::Cuda, None) {
        Ok(_) => vendors.push(VendorCapability {
            vendor: DecodeVendor::Nvidia,
            supported: true,
            reason: String::new(),
        }),
        Err(e) => vendors.push(VendorCapability {
            vendor: DecodeVendor::Nvidia,
            supported: false,
            reason: e.to_string(),
        }),
    }

    let render_nodes = enumerate_vaapi_render_nodes();
    for vendor in [DecodeVendor::Amd, DecodeVendor::Intel] {
        let candidates: Vec<&String> = render_nodes
            .iter()
            .filter(|(v, _)| *v == vendor)
            .map(|(_, path)| path)
            .collect();
        if candidates.is_empty() {
            vendors.push(VendorCapability {
                vendor,
                supported: false,
                reason: format!("no {vendor:?} GPU render node detected under /sys/class/drm"),
            });
            continue;
        }
        let mut last_err = String::new();
        let mut ok = false;
        for path in candidates {
            match HwDeviceContext::create(HwVendor::Vaapi, Some(path)) {
                Ok(_) => {
                    ok = true;
                    break;
                }
                Err(e) => last_err = e.to_string(),
            }
        }
        vendors.push(VendorCapability { vendor, supported: ok, reason: if ok { String::new() } else { last_err } });
    }

    let supported = vendors.iter().any(|v| v.supported);
    HwDecodeCapabilities { supported, vendors }
}

/// First `/dev/dri/renderD*` node classified as `vendor` — only meaningful for `Amd`/`Intel`
/// (NVIDIA doesn't address its decoder through a VAAPI render node; `HwVendor::Cuda` uses its own
/// device-ordinal addressing, `device: None` lets ffmpeg pick the default CUDA device). Used by
/// the device-selection policy (FR-012) to pin which physical GPU a VAAPI hw context actually
/// opens — passing `device: None` to `av_hwdevice_ctx_create` for VAAPI would pick *some* render
/// node, not necessarily the vendor the policy decided on, on machines with both an AMD and an
/// Intel render node present at once.
pub fn first_render_node_for(vendor: DecodeVendor) -> Option<String> {
    enumerate_vaapi_render_nodes()
        .into_iter()
        .find(|(v, _)| *v == vendor)
        .map(|(_, path)| path)
}

/// Real-time utilization percent (0-100) for `vendor`'s GPU — backs the "优先使用闲置资源"
/// device-selection strategy (FR-012). `None` means load data could not be obtained for this
/// vendor (always true for `Intel`, per research.md §4 — no driver-stable sysfs utilization file
/// across i915/xe), and callers must degrade to the static Performance rule for this pick.
pub fn query_load_percent(vendor: DecodeVendor) -> Option<u32> {
    match vendor {
        DecodeVendor::Nvidia => {
            let output = std::process::Command::new("nvidia-smi")
                .args(["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"])
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            String::from_utf8(output.stdout)
                .ok()?
                .lines()
                .next()?
                .trim()
                .parse()
                .ok()
        }
        DecodeVendor::Amd => {
            let render_path = first_render_node_for(DecodeVendor::Amd)?;
            let render_name = render_path.rsplit('/').next()?;
            std::fs::read_to_string(format!("/sys/class/drm/{render_name}/device/gpu_busy_percent"))
                .ok()?
                .trim()
                .parse()
                .ok()
        }
        DecodeVendor::Intel => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T029 (FR-004 runtime-fallback path): `decode_range_hw`'s `resolve_decoded_frame` only
    /// takes the runtime-failure branch when `is_hw_frame` is true *and* `transfer_to_software`
    /// then fails — both gated on `AVFrame.format`/`av_hwframe_transfer_data`, neither of which
    /// requires a real GPU to exercise deterministically. A frame that *claims* to be a CUDA
    /// hw-surface frame (matching `is_hw_frame`'s check) but was never actually attached to a
    /// real `hw_frames_ctx` is exactly what a genuine mid-stream hw failure looks like from this
    /// function's point of view: `av_hwframe_transfer_data` has nothing valid to copy from and
    /// fails the same way it would after a real driver-side decode error. This is the seam
    /// `resolve_decoded_frame` itself can't be unit-tested through directly (its `GetFormatCtx`
    /// parameter is only constructible via `attach_hw_device`, which needs a live
    /// `AVCodecContext` — i.e. a real decode session), but it is the entire precondition
    /// `resolve_decoded_frame`'s failure match-arm depends on.
    #[test]
    fn transfer_to_software_fails_on_frame_with_no_real_hw_surface() {
        let _ = ffmpeg_next::init();
        let mut frame = ffmpeg_next::frame::Video::empty();
        // SAFETY: test-only fabrication of a frame that reports the CUDA hw pixel format via the
        // plain `format: c_int` field (same field `is_hw_frame`/`frame_to_rgba` read elsewhere in
        // this crate) without ever attaching a real `hw_frames_ctx` — `frame.as_mut_ptr()` is
        // valid for any frame obtained from `Video::empty()`, and this write doesn't touch any
        // pointer/buffer fields, only the plain integer format tag.
        unsafe {
            (*frame.as_mut_ptr()).format = HwVendor::Cuda.hw_pix_fmt() as i32;
        }

        assert!(
            is_hw_frame(&frame, HwVendor::Cuda),
            "fabricated frame must report itself as a CUDA hw-surface frame"
        );

        let result = transfer_to_software(&frame);
        assert!(
            result.is_err(),
            "transfer must fail: the frame has no real hw_frames_ctx attached, exactly like a \
             genuine mid-stream hw decode failure would look from this function's perspective"
        );
    }
}
