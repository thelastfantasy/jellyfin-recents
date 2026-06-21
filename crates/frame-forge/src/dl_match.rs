//! Deep-learning feature matching for panorama stitching.
//!
//! Matcher selection (`FRAME_FORGE_MATCHER` env var):
//!   "lightglue"       → LightGlue-ONNX (SuperPoint + LightGlue)
//!   "efficient-loftr" → EfficientLoFTR (CVPR 2024)
//!   (default)         → LightGlue v2 → LightGlue v1 → EfficientLoFTR → AKAZE
//!
//! Tier 1a — LightGlue v2 pipeline (fabio-sim/LightGlue-ONNX v2.0):
//!   File:   superpoint_lightglue_pipeline.onnx
//!   Input:  images  (2,1,H,W) float32 [0,1] — interleaved [left, right]
//!   Output: keypoints (2,N,2), matches (M,3) i64 [batch,kp0,kp1], mscores (M,) f32
//!
//! Tier 1b — LightGlue v1 fused (fabio-sim/LightGlue-ONNX v1.0.0, legacy):
//!   File:   superpoint_lightglue.onnx
//!   Input:  image0/image1  (1,1,H,W) float32 [0,1] — native resolution
//!   Output: keypoints0 (1,N,2), keypoints1 (1,M,2),
//!           matches0 (1,N) i64 (index into kp1 or -1), mscores0 (1,N) f32
//!
//! Tier 2 — EfficientLoFTR ONNX (zahilaty/EfficientLoFTR-ONNX, public):
//!   File:   eloftr_640x480.onnx  (also accepts efficient_loftr.onnx legacy name)
//!   Input:  image0/image1  (1,1,480,640) float32 [0,1] — fixed resize
//!   Output: mkpts0_f (N,2) f32, mkpts1_f (N,2) f32, mconf (N,) f32
//!
//! Tier 3 — AKAZE + KNN Lowe-ratio + USAC-MAGSAC (no model file needed).
//!
//! Model search order (first hit wins):
//!   $FRAME_FORGE_DL_MODELS/<name>
//!   <binary_dir>/models/<name>
//!   /config/plugins/JellyfinSuite/models/<name>   (Jellyfin production)
//!   /workspace/models/<name>                       (demo container)

use anyhow::Context as _;
use ndarray::{Array4, Axis, concatenate};
use opencv::{calib3d, core, features2d, imgproc, prelude::*};
use ort::session::Session;
use ort::value::TensorRef;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

// ── Constants ────────────────────────────────────────────────────────────────

/// EfficientLoFTR canonical input size (must be multiples of 8).
const LOFTR_H: usize = 480;
const LOFTR_W: usize = 640;

/// Minimum match confidence for EfficientLoFTR.
const LOFTR_CONF_THRESHOLD: f32 = 0.2;

/// Minimum match confidence for LightGlue.
const LIGHTGLUE_CONF_THRESHOLD: f32 = 0.5;

/// Minimum inliers for a homography to be accepted.
pub const MIN_INLIERS: usize = 8;

/// USAC-MAGSAC reprojection threshold (pixels).
const USAC_THRESH: f64 = 4.0;

// ── Model discovery ──────────────────────────────────────────────────────────

/// Return the path to a DL model file, searching known locations in order.
pub fn find_model(name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("FRAME_FORGE_DL_MODELS") {
        candidates.push(PathBuf::from(dir).join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("models").join(name));
        }
    }
    candidates.push(PathBuf::from("/config/plugins/JellyfinSuite/models").join(name));
    candidates.push(PathBuf::from("/workspace/models").join(name));
    candidates.into_iter().find(|p| p.exists())
}

// ── EfficientLoFTR (ONNX Runtime) ────────────────────────────────────────────

pub struct ELoFTR {
    session: Session,
    pub model_file_name: String,
}

impl ELoFTR {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let session = Session::builder()?
            .commit_from_file(path)
            .with_context(|| format!("EfficientLoFTR ONNX load failed: {}", path.display()))?;
        log::info!("[dl_match] EfficientLoFTR loaded: {}", path.display());
        let model_file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(Self { session, model_file_name })
    }

    pub fn load_with_ep(path: &Path, device_id: &str, memory_limit_bytes: usize) -> anyhow::Result<(Self, Vec<crate::generation_log::FallbackEvent>)> {
        let (session, fallbacks) = build_ep_session(path, device_id, memory_limit_bytes)?;
        log::info!("[dl_match] EfficientLoFTR loaded (ep={device_id}): {}", path.display());
        let model_file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok((Self { session, model_file_name }, fallbacks))
    }

    /// Match two images. Returns `(x_a, y_a, x_b, y_b)` in original pixel coords.
    pub fn match_images(
        &mut self,
        img0: &core::Mat,
        img1: &core::Mat,
    ) -> anyhow::Result<Vec<[f32; 4]>> {
        let sx0 = img0.cols() as f32 / LOFTR_W as f32;
        let sy0 = img0.rows() as f32 / LOFTR_H as f32;
        let sx1 = img1.cols() as f32 / LOFTR_W as f32;
        let sy1 = img1.rows() as f32 / LOFTR_H as f32;

        let arr0 = mat_to_loftr_array(img0)?;
        let arr1 = mat_to_loftr_array(img1)?;
        let t0 = TensorRef::from_array_view(arr0.view())?;
        let t1 = TensorRef::from_array_view(arr1.view())?;

        let outputs = self.session.run(ort::inputs![
            "image0" => t0,
            "image1" => t1,
        ])?;

        let (_, kp0_s)  = outputs["mkpts0_f"].try_extract_tensor::<f32>()?;
        let (_, kp1_s)  = outputs["mkpts1_f"].try_extract_tensor::<f32>()?;
        let (_, conf_s) = outputs["mconf"].try_extract_tensor::<f32>()?;

        let n = conf_s.len();
        if kp0_s.len() < n * 2 || kp1_s.len() < n * 2 {
            anyhow::bail!("ELoFTR keypoint tensor size mismatch (n={n} kp0={} kp1={})", kp0_s.len(), kp1_s.len());
        }

        let mut matches = Vec::with_capacity(n);
        for i in 0..n {
            if conf_s[i] < LOFTR_CONF_THRESHOLD { continue; }
            matches.push([
                kp0_s[i * 2]     * sx0,
                kp0_s[i * 2 + 1] * sy0,
                kp1_s[i * 2]     * sx1,
                kp1_s[i * 2 + 1] * sy1,
            ]);
        }
        log::debug!("[dl_match] ELoFTR: {}/{n} matches (conf≥{LOFTR_CONF_THRESHOLD})", matches.len());
        Ok(matches)
    }
}

/// Grayscale → resize to LOFTR_H×LOFTR_W → Array4<f32> (1,1,H,W) [0,1].
fn mat_to_loftr_array(img: &core::Mat) -> anyhow::Result<Array4<f32>> {
    let mut gray = core::Mat::default();
    let ch = img.channels();
    match ch {
        4 => imgproc::cvt_color(img, &mut gray, imgproc::COLOR_RGBA2GRAY, 0)?,
        3 => imgproc::cvt_color(img, &mut gray, imgproc::COLOR_RGB2GRAY, 0)?,
        1 => gray = img.clone(),
        _ => anyhow::bail!("unsupported channels: {ch}"),
    }
    let mut resized = core::Mat::default();
    imgproc::resize(
        &gray, &mut resized,
        core::Size::new(LOFTR_W as i32, LOFTR_H as i32),
        0.0, 0.0, imgproc::INTER_LANCZOS4,
    )?;
    let raw = resized.data_bytes().context("failed to get Mat bytes")?;
    Ok(Array4::from_shape_fn([1, 1, LOFTR_H, LOFTR_W], |(_, _, h, w)| {
        raw[h * LOFTR_W + w] as f32 / 255.0
    }))
}

// ── LightGlue (ONNX Runtime) ─────────────────────────────────────────────────

pub struct LGlue {
    session: Session,
    pub model_file_name: String,
}

impl LGlue {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let session = Session::builder()?
            .commit_from_file(path)
            .with_context(|| format!("LightGlue ONNX load failed: {}", path.display()))?;
        log::info!("[dl_match] LightGlue loaded: {}", path.display());
        let model_file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(Self { session, model_file_name })
    }

    pub fn load_with_ep(path: &Path, device_id: &str, memory_limit_bytes: usize) -> anyhow::Result<(Self, Vec<crate::generation_log::FallbackEvent>)> {
        let (session, fallbacks) = build_ep_session(path, device_id, memory_limit_bytes)?;
        log::info!("[dl_match] LightGlue loaded (ep={device_id}): {}", path.display());
        let model_file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok((Self { session, model_file_name }, fallbacks))
    }

    /// Match two images at native resolution. Returns `(x_a, y_a, x_b, y_b)` pairs.
    pub fn match_images(
        &mut self,
        img0: &core::Mat,
        img1: &core::Mat,
    ) -> anyhow::Result<Vec<[f32; 4]>> {
        let arr0 = mat_to_gray_array(img0)?;
        let arr1 = mat_to_gray_array(img1)?;
        let t0 = TensorRef::from_array_view(arr0.view())?;
        let t1 = TensorRef::from_array_view(arr1.view())?;

        let outputs = self.session.run(ort::inputs![
            "image0" => t0,
            "image1" => t1,
        ])?;

        let (_, kp0_s) = outputs["keypoints0"].try_extract_tensor::<f32>()?;
        let (_, kp1_s) = outputs["keypoints1"].try_extract_tensor::<f32>()?;
        let (_, m0_s)  = outputs["matches0"].try_extract_tensor::<i64>()?;
        let (_, sc_s)  = outputs["mscores0"].try_extract_tensor::<f32>()?;

        // shapes: kp0 (1,N,2), kp1 (1,M,2), m0 (1,N), sc (1,N)
        // flat indexing into batch-first C-order arrays:
        //   kp0_s[i*2], kp0_s[i*2+1]  =  (x, y) of keypoint i in img0
        //   m0_s[i]                     =  index j into kp1, or -1 if unmatched
        let n = m0_s.len();
        let mut result = Vec::with_capacity(n);
        for i in 0..n {
            let j = m0_s[i];
            if j < 0 { continue; }
            if sc_s.get(i).copied().unwrap_or(0.0) < LIGHTGLUE_CONF_THRESHOLD { continue; }
            let j = j as usize;
            if i * 2 + 1 >= kp0_s.len() || j * 2 + 1 >= kp1_s.len() { continue; }
            result.push([kp0_s[i * 2], kp0_s[i * 2 + 1], kp1_s[j * 2], kp1_s[j * 2 + 1]]);
        }
        log::debug!("[dl_match] LightGlue: {}/{n} matches accepted", result.len());
        Ok(result)
    }
}

// ── LightGlue v2 pipeline (ONNX Runtime) ─────────────────────────────────────

pub struct LGlueV2 {
    session: Session,
    pub model_file_name: String,
}

impl LGlueV2 {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let session = Session::builder()?
            .commit_from_file(path)
            .with_context(|| format!("LightGlue v2 ONNX load failed: {}", path.display()))?;
        log::info!("[dl_match] LightGlue v2 (pipeline) loaded: {}", path.display());
        let model_file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(Self { session, model_file_name })
    }

    pub fn load_with_ep(path: &Path, device_id: &str, memory_limit_bytes: usize) -> anyhow::Result<(Self, Vec<crate::generation_log::FallbackEvent>)> {
        let (session, fallbacks) = build_ep_session(path, device_id, memory_limit_bytes)?;
        log::info!("[dl_match] LightGlue v2 loaded (ep={device_id}): {}", path.display());
        let model_file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok((Self { session, model_file_name }, fallbacks))
    }

    /// Match two images. Returns `(x_a, y_a, x_b, y_b)` in original pixel coords.
    pub fn match_images(
        &mut self,
        img0: &core::Mat,
        img1: &core::Mat,
    ) -> anyhow::Result<Vec<[f32; 4]>> {
        let arr0 = mat_to_gray_array(img0)?;
        // v2 requires both images to have the same H×W in the batched tensor.
        let arr1 = if img1.rows() == img0.rows() && img1.cols() == img0.cols() {
            mat_to_gray_array(img1)?
        } else {
            mat_to_gray_array_resized(img1, img0.rows(), img0.cols())?
        };

        // Stack as (2, 1, H, W): interleaved [img0, img1] batch.
        let combined = concatenate(Axis(0), &[arr0.view(), arr1.view()])
            .context("concatenate images for LightGlue v2")?;
        let t = TensorRef::from_array_view(combined.view())?;

        let outputs = self.session.run(ort::inputs!["images" => t])?;

        // keypoints: (2, N, 2) i64 — integer pixel coords [img0 kps, img1 kps] flattened
        // matches:   (M, 3)   i64 — [batch_idx, kp0_idx, kp1_idx] per match
        // mscores:   (M,)    f32  — confidence scores
        let (kp_shape, kp_s) = outputs["keypoints"].try_extract_tensor::<i64>()?;
        let (_m_shape, m_s)  = outputs["matches"].try_extract_tensor::<i64>()?;
        let (_, sc_s)        = outputs["mscores"].try_extract_tensor::<f32>()?;

        let n_kp = kp_shape[1] as usize;  // keypoints per image
        let n_matches = sc_s.len();

        let mut result = Vec::with_capacity(n_matches);
        for i in 0..n_matches {
            if sc_s[i] < LIGHTGLUE_CONF_THRESHOLD { continue; }
            let batch_idx = m_s[i * 3];
            let j0 = m_s[i * 3 + 1] as usize;
            let j1 = m_s[i * 3 + 2] as usize;
            if batch_idx != 0 || j0 >= n_kp || j1 >= n_kp { continue; }
            result.push([
                kp_s[j0 * 2] as f32,              kp_s[j0 * 2 + 1] as f32,
                kp_s[n_kp * 2 + j1 * 2] as f32,  kp_s[n_kp * 2 + j1 * 2 + 1] as f32,
            ]);
        }
        log::debug!("[dl_match] LightGlue v2: {}/{n_matches} matches accepted", result.len());
        Ok(result)
    }
}

/// OpenCV Mat → grayscale float Array4<f32> (1,1,H,W) [0,1] at native resolution.
fn mat_to_gray_array(img: &core::Mat) -> anyhow::Result<Array4<f32>> {
    let mut gray = core::Mat::default();
    let ch = img.channels();
    match ch {
        4 => imgproc::cvt_color(img, &mut gray, imgproc::COLOR_RGBA2GRAY, 0)?,
        3 => imgproc::cvt_color(img, &mut gray, imgproc::COLOR_RGB2GRAY, 0)?,
        1 => gray = img.clone(),
        _ => anyhow::bail!("unsupported channels: {ch}"),
    }
    let h = gray.rows() as usize;
    let w = gray.cols() as usize;
    let raw = gray.data_bytes().context("failed to get Mat bytes")?;
    Ok(Array4::from_shape_fn([1, 1, h, w], |(_, _, r, c)| {
        raw[r * w + c] as f32 / 255.0
    }))
}

/// Grayscale Array4 resized to `(rows, cols)`. Used by LGlueV2 when images differ in size.
fn mat_to_gray_array_resized(img: &core::Mat, rows: i32, cols: i32) -> anyhow::Result<Array4<f32>> {
    let mut gray = core::Mat::default();
    let ch = img.channels();
    match ch {
        4 => imgproc::cvt_color(img, &mut gray, imgproc::COLOR_RGBA2GRAY, 0)?,
        3 => imgproc::cvt_color(img, &mut gray, imgproc::COLOR_RGB2GRAY, 0)?,
        1 => gray = img.clone(),
        _ => anyhow::bail!("unsupported channels: {ch}"),
    }
    let mut resized = core::Mat::default();
    imgproc::resize(
        &gray, &mut resized,
        core::Size::new(cols, rows),
        0.0, 0.0, imgproc::INTER_LANCZOS4,
    )?;
    let h = resized.rows() as usize;
    let w = resized.cols() as usize;
    let raw = resized.data_bytes().context("failed to get Mat bytes")?;
    Ok(Array4::from_shape_fn([1, 1, h, w], |(_, _, r, c)| {
        raw[r * w + c] as f32 / 255.0
    }))
}

// ── ModelChoice enum ─────────────────────────────────────────────────────────

/// User-facing model selection (from `--model` / `--no-model` CLI flags).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ModelChoice {
    #[default]
    Auto,           // LightGlue v2 → v1 → EfficientLoFTR → AKAZE
    LightGlue,      // --model lightglue
    EfficientLoFTR, // --model efficient-loftr
    Disabled,       // --no-model
}

impl ModelChoice {
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "lightglue" | "lg" => Self::LightGlue,
            "efficient-loftr" | "loftr" | "eloftr" => Self::EfficientLoFTR,
            "none" | "disabled" | "off" | "akaze" => Self::Disabled,
            _ => Self::Auto,
        }
    }

    pub fn as_env_str(self) -> Option<&'static str> {
        match self {
            Self::Auto           => None,
            Self::LightGlue      => Some("lightglue"),
            Self::EfficientLoFTR => Some("efficient-loftr"),
            Self::Disabled       => Some("disabled"),
        }
    }
}

// ── AnyMatcher enum ───────────────────────────────────────────────────────────

/// Unified DL feature matcher: LightGlue v2, LightGlue v1, or EfficientLoFTR.
pub enum AnyMatcher {
    EfficientLoFTR(ELoFTR),
    LightGlue(LGlue),
    LightGlueV2(LGlueV2),
}

impl AnyMatcher {
    /// Match two images. Returns `(x_a, y_a, x_b, y_b)` in original pixel coords.
    ///
    /// Times the underlying `session.run()` call and accumulates
    /// (match_count, inference_ms) into a thread-local so the caller's outer stitch
    /// function (which may call this once per frame pair) doesn't need its own
    /// plumbing — see `reset_match_stats`/`take_match_stats`. Safe across
    /// `tokio::task::spawn_blocking` because that closure runs start-to-finish on one
    /// OS thread; the caller resets before and reads after within the same closure.
    pub fn match_images(
        &mut self,
        img0: &core::Mat,
        img1: &core::Mat,
    ) -> anyhow::Result<Vec<[f32; 4]>> {
        let t0 = std::time::Instant::now();
        let result = match self {
            AnyMatcher::EfficientLoFTR(m) => m.match_images(img0, img1),
            AnyMatcher::LightGlue(m)      => m.match_images(img0, img1),
            AnyMatcher::LightGlueV2(m)    => m.match_images(img0, img1),
        };
        let elapsed_ms = t0.elapsed().as_millis() as u64;
        if let Ok(pts) = &result {
            record_match_stats(pts.len() as u32, elapsed_ms);
        }
        result
    }

    pub fn model_file_name(&self) -> &str {
        match self {
            AnyMatcher::EfficientLoFTR(m) => &m.model_file_name,
            AnyMatcher::LightGlue(m)      => &m.model_file_name,
            AnyMatcher::LightGlueV2(m)    => &m.model_file_name,
        }
    }

    pub fn algorithm_name(&self) -> &str {
        match self {
            AnyMatcher::EfficientLoFTR(_) => "EfficientLoFTR → USAC-MAGSAC",
            AnyMatcher::LightGlue(_)      => "LightGlue v1 → USAC-MAGSAC",
            AnyMatcher::LightGlueV2(_)    => "LightGlue v2 → USAC-MAGSAC",
        }
    }
}

thread_local! {
    /// (total keypoint matches found, total time spent inside session.run()) across
    /// every `match_images` call made by the current request's stitch — a stitch with
    /// N>2 frames calls this once per adjacent pair, so these are sums, not single-pair
    /// values. Reset at the start of a request's blocking stitch closure, read at the end.
    static MATCH_STATS: std::cell::Cell<(u32, u64)> = std::cell::Cell::new((0, 0));
}

fn record_match_stats(match_count: u32, inference_ms: u64) {
    MATCH_STATS.with(|s| {
        let (c, ms) = s.get();
        s.set((c + match_count, ms + inference_ms));
    });
}

/// Call before starting a request's stitch to discard any stats left over from a
/// previous stitch that happened to run on this same blocking-pool thread.
pub fn reset_match_stats() {
    MATCH_STATS.with(|s| s.set((0, 0)));
}

/// Call immediately after a request's stitch completes (same thread, same blocking
/// closure) to retrieve (total keypoint matches, total inference ms) for GenerationLog.
pub fn take_match_stats() -> (u32, u64) {
    MATCH_STATS.with(|s| s.replace((0, 0)))
}

// ── Global singleton ─────────────────────────────────────────────────────────

static GLOBAL_MATCHER: OnceLock<Mutex<Option<AnyMatcher>>> = OnceLock::new();

/// Return a MutexGuard to the global AnyMatcher singleton (loaded on first call).
/// Returns `None` inside the guard when no model file is found.
pub fn matcher_guard() -> MutexGuard<'static, Option<AnyMatcher>> {
    let mtx = GLOBAL_MATCHER.get_or_init(|| {
        let m = load_matcher();
        if m.is_none() {
            log::info!("[dl_match] No ONNX model found — will use AKAZE fallback");
        }
        Mutex::new(m)
    });
    mtx.lock().unwrap_or_else(|e| e.into_inner())
}

/// Backward-compatible alias — callers that already use `loftr_guard()` continue to work.
pub fn loftr_guard() -> MutexGuard<'static, Option<AnyMatcher>> {
    matcher_guard()
}

fn load_matcher() -> Option<AnyMatcher> {
    let pref = std::env::var("FRAME_FORGE_MATCHER").unwrap_or_default();
    let result = match pref.trim() {
        "none" | "disabled" | "akaze" => {
            eprintln!("[dl_match] matcher=disabled (AKAZE only)");
            None
        }
        "lightglue" => load_lightglue().or_else(|| {
            eprintln!("[dl_match] FRAME_FORGE_MATCHER=lightglue but model not found");
            None
        }),
        "efficient-loftr" | "loftr" => load_loftr().or_else(|| {
            eprintln!("[dl_match] FRAME_FORGE_MATCHER=efficient-loftr but model not found");
            None
        }),
        _ => load_lightglue().or_else(|| load_loftr()),
    };
    match &result {
        Some(AnyMatcher::LightGlue(_))     => eprintln!("[dl_match] loaded: LightGlue v1"),
        Some(AnyMatcher::LightGlueV2(_))   => eprintln!("[dl_match] loaded: LightGlue v2"),
        Some(AnyMatcher::EfficientLoFTR(_))=> eprintln!("[dl_match] loaded: EfficientLoFTR"),
        None => eprintln!("[dl_match] no model loaded — AKAZE only"),
    }
    result
}

fn load_lightglue() -> Option<AnyMatcher> {
    // Prefer v2.0 pipeline model; fall back to v1.0.0 fused (legacy).
    if let Some(p) = find_model("superpoint_lightglue_pipeline.onnx") {
        if let Ok(m) = LGlueV2::load(&p)
            .map_err(|e| log::warn!("[dl_match] LightGlue v2 load failed: {e}"))
        {
            return Some(AnyMatcher::LightGlueV2(m));
        }
    }
    find_model("superpoint_lightglue.onnx").and_then(|p| {
        LGlue::load(&p)
            .map_err(|e| log::warn!("[dl_match] LightGlue v1 load failed: {e}"))
            .ok()
    }).map(AnyMatcher::LightGlue)
}

fn load_loftr() -> Option<AnyMatcher> {
    // Try zahilaty's public export first, then fall back to legacy filename.
    let path = find_model("eloftr_640x480.onnx")
        .or_else(|| find_model("efficient_loftr.onnx"))?;
    ELoFTR::load(&path)
        .map_err(|e| log::warn!("[dl_match] ELoFTR load failed: {e}"))
        .ok()
        .map(AnyMatcher::EfficientLoFTR)
}

// ── EP-aware session builder ─────────────────────────────────────────────────

/// Parse "cuda:0", "directml:1", "cpu:0" → (platform, device_index).
fn parse_device_id(device_id: &str) -> (&str, u32) {
    match device_id.split_once(':') {
        Some((platform, idx)) => (platform, idx.parse().unwrap_or(0)),
        None if device_id.is_empty() => ("cpu", 0),
        None => (device_id, 0),
    }
}

/// Explicit CPUExecutionProvider registration is required, not optional: GPU-flavored
/// onnxruntime.so builds (e.g. onnxruntime-linux-x64-gpu_cuda13) hang indefinitely in
/// `commit_from_file` when no EP is explicitly registered (verified on RTX 5060 / driver
/// 595.71 / ORT 1.26.0 gpu_cuda13 build — 0% CPU, stuck in futex_do_wait). Registering
/// CPUExecutionProvider explicitly takes a different internal code path and avoids the hang.
fn make_cpu_session(p: &Path) -> anyhow::Result<Session> {
    use ort::execution_providers::CPUExecutionProvider;
    Session::builder()
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .with_execution_providers([CPUExecutionProvider::default().build()])
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .commit_from_file(p)
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// Run `f` on a worker thread with a bounded wait. On timeout, aborts the whole process
/// immediately rather than returning — research.md §7b found that an abandoned worker
/// thread can hold an ORT-internal mutex that `libonnxruntime.so`'s `atexit`/`__cxa_finalize`
/// static destructors then block on during a normal process exit. `std::process::exit`
/// still runs those atexit handlers (it maps to libc `exit()`), so it doesn't actually avoid
/// the deadlock; `std::process::abort` raises SIGABRT and skips atexit entirely, which is
/// the only way this is actually safe once an EP init has hung.
fn run_with_ep_timeout<T, F>(timeout_secs: u64, label: &str, f: F) -> T
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(result) => result,
        Err(_) => {
            log::error!(
                "[dl_match] EP init ({label}) exceeded {timeout_secs}s timeout \
                 (env FRAME_FORGE_EP_INIT_TIMEOUT_SECS) — aborting process immediately to avoid \
                 a hung worker thread deadlocking process exit"
            );
            std::process::abort();
        }
    }
}

fn ep_init_timeout_secs() -> u64 {
    std::env::var("FRAME_FORGE_EP_INIT_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(15)
}

/// Default fallback when actual VRAM can't be queried (non-NVIDIA device, `nvidia-smi`
/// missing, etc.) — same constant the fixed limit used before this became job-size-aware.
const DEFAULT_CUDA_MEMORY_LIMIT_BYTES: usize = 1 << 30;

/// Percentage of total VRAM to grant the CUDA EP's arena, scaled by both how many frames a job
/// processes and how large each frame is. Neither factor changes one model call's own working
/// set (ORT allocates fresh per `session.run()` regardless of how many calls follow), but both
/// are real proxies for how long/how risky the job is to share the GPU with other consumers
/// (ffmpeg hwaccel, a concurrent upscale job): a many-frame stitch keeps the session alive longer,
/// and a single very-high-resolution frame (4K+ source) inflates ORT's internal intermediate
/// tensors well beyond what a small thumbnail needs even though it's still "one frame". Bounded
/// at both ends: floor stays generous for the smallest jobs, ceiling avoids one job's arena
/// reservation starving a concurrent GPU consumer on the host. Takes `device_id` (not a raw GPU
/// index) so every call site can go straight from what it already has to a final byte count
/// without duplicating `parse_device_id`.
pub fn cuda_memory_limit_bytes(device_id: &str, frame_count: usize, resolution_mp: f64) -> usize {
    const BASE_PERCENT: f64 = 0.10;
    const PER_FRAME_PERCENT: f64 = 0.02;
    const PER_MEGAPIXEL_PERCENT: f64 = 0.01;
    const MAX_PERCENT: f64 = 0.40;

    let (_, gpu_index) = parse_device_id(device_id);
    let Some(total_mb) = crate::gpu_compat::detect_total_memory_mb(gpu_index) else {
        return DEFAULT_CUDA_MEMORY_LIMIT_BYTES;
    };
    let percent = (BASE_PERCENT
        + PER_FRAME_PERCENT * frame_count as f64
        + PER_MEGAPIXEL_PERCENT * resolution_mp)
        .min(MAX_PERCENT);
    let bytes = (total_mb as f64 * 1024.0 * 1024.0 * percent) as usize;
    bytes.max(256 * 1024 * 1024) // floor: never request a degenerately tiny arena
}

/// Memory limit for "提升画质" (Real-ESRGAN / GFPGAN) CUDA EP sessions. Deliberately *not*
/// `cuda_memory_limit_bytes` scaled by frame count: that formula was tuned for the stitch
/// matcher (LightGlue/EfficientLoFTR), where frame_count is a real proxy for job size (tens of
/// frames). Upscale's non-animation frame_count is always 1, which collapsed the same formula to
/// ~10-15% of VRAM — far less than a deep super-resolution CNN's per-call intermediate tensors
/// need (observed in production: a single Conv layer requesting 512MB inside a ~1.1GB arena,
/// repeatably).
///
/// Sized off *currently free* VRAM rather than total capacity: total-based percentages are blind
/// to whatever else is holding memory at this exact moment (the host desktop compositor, a
/// leftover allocation from a prior job) — which is exactly what total-based sizing got wrong in
/// production (a healthy 8GB card, but the arena still landed too small to fit one Conv layer).
/// Free-based sizing self-corrects: less headroom right now means a smaller (but still
/// proportionally correct) request instead of a fixed-percentage number that doesn't know.
pub fn cuda_memory_limit_bytes_upscale(device_id: &str) -> usize {
    const PERCENT_OF_FREE: f64 = 0.80;

    let (_, gpu_index) = parse_device_id(device_id);
    let Some(free_mb) = crate::gpu_compat::detect_free_memory_mb(gpu_index) else {
        return DEFAULT_CUDA_MEMORY_LIMIT_BYTES;
    };
    let bytes = (free_mb as f64 * 1024.0 * 1024.0 * PERCENT_OF_FREE) as usize;
    bytes.max(256 * 1024 * 1024)
}

/// Build an ORT session for `path` using the EP indicated by `device_id`.
/// On GPU EP failure, falls back to CPU and records a FallbackEvent. Every EP
/// construction attempt (GPU or CPU) runs under `run_with_ep_timeout` (T037).
///
/// `with_execution_providers` returns `ort::Error<SessionBuilder>` which is not `Send+Sync`,
/// so we use `.ok()` (discarding the error) for the GPU try-path and `map_err` for CPU.
pub fn build_ep_session(
    path: &Path,
    device_id: &str,
    memory_limit_bytes: usize,
) -> anyhow::Result<(Session, Vec<crate::generation_log::FallbackEvent>)> {
    let (platform, dev_idx) = parse_device_id(device_id);
    let timeout_secs = ep_init_timeout_secs();

    match platform {
        "cuda" => {
            // T041: check the gpu-compat denylist before paying even the T037-bounded EP-init
            // timeout for hardware known in advance to hang/silently-CPU-fallback (research.md
            // §7a — NVIDIA Blackwell against ORT's standard `gpu` CUDA12 asset).
            if let Some(cc) = crate::gpu_compat::detect_compute_capability(dev_idx) {
                let asset_key = crate::gpu_compat::active_ort_asset_key();
                if let Some(reason) = crate::gpu_compat::check("NVIDIA", &cc, &asset_key) {
                    log::warn!(
                        "[dl_match] {device_id} denylisted (compute_cap={cc}, ort_asset={asset_key}): {reason} — skipping straight to CPU"
                    );
                    let path_buf = path.to_path_buf();
                    let cpu = run_with_ep_timeout(timeout_secs, "cpu-denylisted", move || make_cpu_session(&path_buf));
                    return Ok((cpu?, vec![crate::generation_log::FallbackEvent {
                        event_type: "GPU→CPU".to_string(),
                        reason: format!("denylisted: {reason}"),
                        timestamp: crate::generation_log::now_timestamp(),
                    }]));
                }
            }

            let path_buf = path.to_path_buf();
            let gpu = run_with_ep_timeout(timeout_secs, "cuda", move || -> Option<Session> {
                use ort::execution_providers::{ArenaExtendStrategy, CUDAExecutionProvider};
                // FRAME_FORGE_ORT_VERBOSE=1: ORT_LOGGING_LEVEL_VERBOSE makes ORT print its
                // per-node EP placement decisions (which nodes actually run on CUDA vs silently
                // fall back to CPU despite the EP registering successfully) — session creation
                // succeeding is not proof the model's nodes execute on the GPU; this is the only
                // way to see that placement decision directly instead of inferring it from timing.
                // FRAME_FORGE_ORT_VERBOSE=1: eprintln the underlying ort::Error instead of
                // discarding it via .ok() (see fn doc comment on why .ok() is otherwise needed —
                // the error type isn't Send+Sync, but printing it here, before it crosses the
                // run_with_ep_timeout thread boundary, doesn't have that constraint).
                let verbose = std::env::var("FRAME_FORGE_ORT_VERBOSE").as_deref() == Ok("1");
                let builder = match Session::builder() {
                    Ok(b) => b,
                    Err(e) => { if verbose { eprintln!("[dl_match] Session::builder() failed: {e}"); } return None; }
                };
                // Without these, ORT's CUDA EP defaults to an unbounded arena with
                // kNextPowerOfTwo extension — every time the arena needs more memory it rounds
                // UP to the next power of two (asking for 1.1GB reserves 2GB) and never releases
                // it for the life of the session, observed in production reserving multiple GB of
                // GPU memory (and correlated host-side RSS) for a feature-matching model whose
                // actual working set for a single frame pair is a tiny fraction of that.
                // SameAsRequested allocates exactly what's asked for; memory_limit_bytes is
                // computed by the caller (see cuda_memory_limit_bytes) as a percentage of actual
                // VRAM that scales modestly with frame count, instead of one fixed constant for
                // every stitch regardless of how many frames/pairs it has to process.
                let cuda_ep = CUDAExecutionProvider::default()
                    .with_arena_extend_strategy(ArenaExtendStrategy::SameAsRequested)
                    .with_memory_limit(memory_limit_bytes);
                let builder = match builder.with_execution_providers([cuda_ep.build()]) {
                    Ok(b) => b,
                    Err(e) => { if verbose { eprintln!("[dl_match] with_execution_providers(CUDA) failed: {e}"); } return None; }
                };
                let builder = if verbose {
                    match builder.with_log_level(ort::logging::LogLevel::Verbose) {
                        Ok(b) => b,
                        Err(e) => { eprintln!("[dl_match] with_log_level failed: {e}"); return None; }
                    }
                } else { builder };
                // ORT's chrome-trace profiler records the actual EP each op executed on — more
                // reliable than log severity, which produced no output even at VERBOSE (this
                // release build may not compile in verbose node-placement logging). Diagnostic-
                // only; caller must call session.end_profiling() to flush the JSON file.
                let builder = if verbose {
                    match builder.with_profiling("/tmp/ort_profile") {
                        Ok(b) => b,
                        Err(e) => { eprintln!("[dl_match] with_profiling failed: {e}"); return None; }
                    }
                } else { builder };
                // FRAME_FORGE_ORT_NO_OPT=1: diagnostic-only — ORT defaults to GraphOptimizationLevel::Level3
                // (ORT_ENABLE_LAYOUT), which includes CPU/MLAS-specific NCHWc layout-transform fusions.
                // Added to test whether disabling graph optimization changes CUDA EP node assignment
                // (i.e. whether the model graph gets fused into CPU-only ops before EP partitioning).
                // Inconclusive in practice — disabling optimization made commit_from_file hang/abort
                // under the EP-init timeout regardless of EP. The actual root cause of CUDA EP
                // claiming zero nodes turned out to be unrelated: a missing transitive .so dependency
                // of libonnxruntime_providers_cuda.so (libcurand/libcufft — see
                // CudaRuntimeAcquisitionService's class doc comment for the full story). Left in
                // place as a diagnostic knob, not because the Level3 theory was confirmed.
                let builder = if std::env::var("FRAME_FORGE_ORT_NO_OPT").as_deref() == Ok("1") {
                    match builder.with_optimization_level(ort::session::builder::GraphOptimizationLevel::Disable) {
                        Ok(b) => b,
                        Err(e) => { if verbose { eprintln!("[dl_match] with_optimization_level failed: {e}"); } return None; }
                    }
                } else { builder };
                let mut builder = builder;
                match builder.commit_from_file(&path_buf) {
                    Ok(s) => Some(s),
                    Err(e) => { if verbose { eprintln!("[dl_match] commit_from_file (CUDA) failed: {e}"); } None }
                }
            });
            match gpu {
                Some(s) => Ok((s, vec![])),
                None => {
                    log::warn!("[dl_match] CUDA EP unavailable for {device_id}, falling back to CPU");
                    let path_buf = path.to_path_buf();
                    let cpu = run_with_ep_timeout(timeout_secs, "cpu-fallback", move || make_cpu_session(&path_buf));
                    Ok((cpu?, vec![crate::generation_log::FallbackEvent {
                        event_type: "GPU→CPU".to_string(),
                        reason: "CUDA EP init failed".to_string(),
                        timestamp: crate::generation_log::now_timestamp(),
                    }]))
                }
            }
        }
        "directml" => {
            let path_buf = path.to_path_buf();
            let gpu = run_with_ep_timeout(timeout_secs, "directml", move || -> Option<Session> {
                use ort::execution_providers::DirectMLExecutionProvider;
                Session::builder().ok()
                    .and_then(|b| b.with_execution_providers([DirectMLExecutionProvider::default().build()]).ok())
                    .and_then(|mut b| b.commit_from_file(&path_buf).ok())
            });
            match gpu {
                Some(s) => Ok((s, vec![])),
                None => {
                    log::warn!("[dl_match] DirectML EP unavailable for {device_id}, falling back to CPU");
                    let path_buf = path.to_path_buf();
                    let cpu = run_with_ep_timeout(timeout_secs, "cpu-fallback", move || make_cpu_session(&path_buf));
                    Ok((cpu?, vec![crate::generation_log::FallbackEvent {
                        event_type: "GPU→CPU".to_string(),
                        reason: "DirectML EP init failed".to_string(),
                        timestamp: crate::generation_log::now_timestamp(),
                    }]))
                }
            }
        }
        // Intel CPU/GPU/NPU (e.g. Arc A-series). UNTESTED against real Intel GPU hardware —
        // written symmetrically to the cuda/directml branches above, but only verified to
        // compile; no Arc/NPU device was available to confirm `OpenVINOExecutionProvider`
        // actually engages the GPU rather than its own internal CPU fallback. Before this
        // arm existed, device_id="openvino:*" silently fell through to the `_` branch below
        // (CPU, with an *empty* fallback_events — no warning at all, worse than this arm's
        // explicit FallbackEvent on failure).
        "openvino" => {
            let path_buf = path.to_path_buf();
            let gpu = run_with_ep_timeout(timeout_secs, "openvino", move || -> Option<Session> {
                use ort::execution_providers::OpenVINOExecutionProvider;
                Session::builder().ok()
                    .and_then(|b| b.with_execution_providers([OpenVINOExecutionProvider::default().with_device_type("GPU").build()]).ok())
                    .and_then(|mut b| b.commit_from_file(&path_buf).ok())
            });
            match gpu {
                Some(s) => Ok((s, vec![])),
                None => {
                    log::warn!("[dl_match] OpenVINO EP unavailable for {device_id}, falling back to CPU");
                    let path_buf = path.to_path_buf();
                    let cpu = run_with_ep_timeout(timeout_secs, "cpu-fallback", move || make_cpu_session(&path_buf));
                    Ok((cpu?, vec![crate::generation_log::FallbackEvent {
                        event_type: "GPU→CPU".to_string(),
                        reason: "OpenVINO EP init failed".to_string(),
                        timestamp: crate::generation_log::now_timestamp(),
                    }]))
                }
            }
        }
        _ => {
            let path_buf = path.to_path_buf();
            let cpu = run_with_ep_timeout(timeout_secs, "cpu", move || make_cpu_session(&path_buf));
            cpu.map(|s| (s, vec![]))
        }
    }
}

/// Derive a human-readable `(device_type, device_name)` pair for a `GenerationLog`/
/// `UpscaleLog`, given what was *requested* (`device_id`) and whether `build_ep_session`
/// actually had to fall back to CPU (`ep_fallbacks_empty`). Must reflect what actually ran,
/// not just what was requested: if the GPU EP failed, reporting "GPU" here would directly
/// contradict the fallbacks[] array in the same log.
pub fn infer_device_label(device_id: &str, ep_fallbacks_empty: bool) -> (String, String) {
    let requested_gpu_kind = if device_id.starts_with("cuda") {
        Some("CUDA")
    } else if device_id.starts_with("directml") {
        Some("DirectML")
    } else if device_id.starts_with("openvino") {
        Some("OpenVINO")
    } else {
        None
    };
    match requested_gpu_kind {
        Some(kind) if ep_fallbacks_empty => ("GPU".to_string(), format!("{kind} device ({device_id})")),
        _ => ("CPU".to_string(), "CPU".to_string()),
    }
}

/// Load a fresh per-request matcher (bypasses global singleton) using the EP
/// indicated by `device_id`. Returns (matcher, fallback_events).
pub fn load_matcher_for_request(
    device_id: &str,
    model_choice: ModelChoice,
    frame_count: usize,
    resolution_mp: f64,
) -> (Option<AnyMatcher>, Vec<crate::generation_log::FallbackEvent>) {
    if matches!(model_choice, ModelChoice::Disabled) {
        return (None, vec![]);
    }

    let memory_limit_bytes = cuda_memory_limit_bytes(device_id, frame_count, resolution_mp);

    // Determine which model file to load
    let load_result = match model_choice {
        ModelChoice::LightGlue => load_lightglue_with_ep(device_id, memory_limit_bytes),
        ModelChoice::EfficientLoFTR => load_loftr_with_ep(device_id, memory_limit_bytes),
        ModelChoice::Auto | ModelChoice::Disabled => {
            // Same precedence as load_lightglue / load_loftr
            load_lightglue_with_ep(device_id, memory_limit_bytes)
                .or_else(|| load_loftr_with_ep(device_id, memory_limit_bytes))
        }
    };

    match load_result {
        Some((matcher, fallbacks)) => (Some(matcher), fallbacks),
        None => {
            log::info!("[dl_match] No ONNX model for per-request matcher — AKAZE only");
            (None, vec![])
        }
    }
}

/// Load a matcher honouring an explicit user selection (spec 012 US3): a "disabled" flag
/// (FR-006, AKAZE-only), an optional family hint, and an optional explicit absolute model
/// path resolved server-side by `ModelCatalogService.GetInstalledModelPath` (the catalog
/// stores each version under its own file name, so the canonical-filename lookup in
/// `find_model`/`load_matcher_for_request` cannot address a *specific* version — only an
/// explicit path can). When `explicit_path` is `None` (Advanced section never opened, or a
/// "Latest" selection that resolves to the canonical file), falls back to the existing
/// `find_model`-based auto-detection so behaviour for users who never touch the Advanced
/// panel is unchanged (FR-013).
pub fn load_matcher_with_selection(
    device_id: &str,
    disabled: bool,
    family: &str,
    explicit_path: Option<&Path>,
    frame_count: usize,
    resolution_mp: f64,
) -> (Option<AnyMatcher>, Vec<crate::generation_log::FallbackEvent>) {
    if disabled {
        return (None, vec![]);
    }

    if let Some(path) = explicit_path {
        let memory_limit_bytes = cuda_memory_limit_bytes(device_id, frame_count, resolution_mp);
        let loaded = if family == "efficient-loftr" {
            ELoFTR::load_with_ep(path, device_id, memory_limit_bytes)
                .map_err(|e| log::warn!("[dl_match] explicit EfficientLoFTR load failed for {path:?}: {e}"))
                .ok()
                .map(|(m, fb)| (AnyMatcher::EfficientLoFTR(m), fb))
        } else {
            LGlueV2::load_with_ep(path, device_id, memory_limit_bytes)
                .map_err(|e| log::warn!("[dl_match] explicit LightGlue v2 load failed for {path:?}: {e}"))
                .ok()
                .map(|(m, fb)| (AnyMatcher::LightGlueV2(m), fb))
                .or_else(|| LGlue::load_with_ep(path, device_id, memory_limit_bytes)
                    .map_err(|e| log::warn!("[dl_match] explicit LightGlue v1 load failed for {path:?}: {e}"))
                    .ok()
                    .map(|(m, fb)| (AnyMatcher::LightGlue(m), fb)))
        };
        return match loaded {
            Some((matcher, fallbacks)) => (Some(matcher), fallbacks),
            None => {
                log::warn!("[dl_match] explicit model path {path:?} (family={family}) failed to load — falling back to AKAZE");
                (None, vec![])
            }
        };
    }

    let choice = match family {
        "lightglue" => ModelChoice::LightGlue,
        "efficient-loftr" => ModelChoice::EfficientLoFTR,
        _ => ModelChoice::Auto,
    };
    load_matcher_for_request(device_id, choice, frame_count, resolution_mp)
}

fn load_lightglue_with_ep(device_id: &str, memory_limit_bytes: usize) -> Option<(AnyMatcher, Vec<crate::generation_log::FallbackEvent>)> {
    if let Some(p) = find_model("superpoint_lightglue_pipeline.onnx") {
        if let Ok((m, fb)) = LGlueV2::load_with_ep(&p, device_id, memory_limit_bytes)
            .map_err(|e| log::warn!("[dl_match] LightGlue v2 EP load failed: {e}"))
        {
            return Some((AnyMatcher::LightGlueV2(m), fb));
        }
    }
    if let Some(p) = find_model("superpoint_lightglue.onnx") {
        if let Ok((m, fb)) = LGlue::load_with_ep(&p, device_id, memory_limit_bytes)
            .map_err(|e| log::warn!("[dl_match] LightGlue v1 EP load failed: {e}"))
        {
            return Some((AnyMatcher::LightGlue(m), fb));
        }
    }
    None
}

fn load_loftr_with_ep(device_id: &str, memory_limit_bytes: usize) -> Option<(AnyMatcher, Vec<crate::generation_log::FallbackEvent>)> {
    let path = find_model("eloftr_640x480.onnx")
        .or_else(|| find_model("efficient_loftr.onnx"))?;
    ELoFTR::load_with_ep(&path, device_id, memory_limit_bytes)
        .map_err(|e| log::warn!("[dl_match] ELoFTR EP load failed: {e}"))
        .ok()
        .map(|(m, fb)| (AnyMatcher::EfficientLoFTR(m), fb))
}

// ── USAC-MAGSAC homography ────────────────────────────────────────────────────

/// Estimate homography from `(x0,y0,x1,y1)` match list using USAC-MAGSAC.
pub fn homography_usac(matches: &[[f32; 4]]) -> anyhow::Result<core::Mat> {
    let n = matches.len() as i32;
    let mut src = core::Mat::new_rows_cols_with_default(n, 1, core::CV_32FC2, core::Scalar::default())?;
    let mut dst = core::Mat::new_rows_cols_with_default(n, 1, core::CV_32FC2, core::Scalar::default())?;

    for (i, &[x0, y0, x1, y1]) in matches.iter().enumerate() {
        *src.at_2d_mut::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([x0, y0]);
        *dst.at_2d_mut::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([x1, y1]);
    }

    let mut mask = core::Mat::default();
    let h = calib3d::find_homography(&src, &dst, &mut mask, calib3d::USAC_MAGSAC, USAC_THRESH)?;

    if h.empty() || h.rows() != 3 {
        anyhow::bail!("USAC-MAGSAC produced empty homography");
    }

    let inliers = (0..n)
        .filter(|&i| mask.at_2d::<u8>(i, 0).ok().copied().unwrap_or(0) > 0)
        .count();
    log::debug!("[dl_match] USAC-MAGSAC: {inliers}/{n} inliers");

    if inliers < MIN_INLIERS {
        anyhow::bail!("too few USAC inliers: {inliers}/{n}");
    }
    Ok(h)
}

// ── AKAZE fallback ────────────────────────────────────────────────────────────

/// AKAZE keypoint matching with KNN Lowe-ratio test + USAC-MAGSAC.
/// Model-free fallback when no DL model is available.
pub fn estimate_homography_akaze(
    img0: &core::Mat,
    img1: &core::Mat,
) -> anyhow::Result<core::Mat> {
    let mut g0 = core::Mat::default();
    let mut g1 = core::Mat::default();
    let code0 = if img0.channels() == 4 { imgproc::COLOR_RGBA2GRAY } else { imgproc::COLOR_RGB2GRAY };
    let code1 = if img1.channels() == 4 { imgproc::COLOR_RGBA2GRAY } else { imgproc::COLOR_RGB2GRAY };
    imgproc::cvt_color(img0, &mut g0, code0, 0)?;
    imgproc::cvt_color(img1, &mut g1, code1, 0)?;

    let mut akaze = features2d::AKAZE::create(
        features2d::AKAZE_DescriptorType::DESCRIPTOR_MLDB, 0, 3,
        0.001_f32, 4, 4, features2d::KAZE_DiffusivityType::DIFF_PM_G2, -1,
    )?;

    let mut kp0 = core::Vector::<core::KeyPoint>::new();
    let mut kp1 = core::Vector::<core::KeyPoint>::new();
    let mut d0 = core::Mat::default();
    let mut d1 = core::Mat::default();
    akaze.detect_and_compute(&g0, &core::no_array(), &mut kp0, &mut d0, false)?;
    akaze.detect_and_compute(&g1, &core::no_array(), &mut kp1, &mut d1, false)?;

    log::debug!("[akaze] kp0={} kp1={}", kp0.len(), kp1.len());

    if kp0.len() < MIN_INLIERS || kp1.len() < MIN_INLIERS {
        anyhow::bail!("AKAZE: too few keypoints ({}/{})", kp0.len(), kp1.len());
    }
    if d0.empty() || d1.empty() {
        anyhow::bail!("AKAZE: empty descriptors");
    }

    let mut matcher = features2d::BFMatcher::create(core::NORM_HAMMING, false)?;
    let mut train_mats: core::Vector<core::Mat> = core::Vector::new();
    train_mats.push(d1.try_clone()?);
    matcher.add(&train_mats)?;

    let mut knn: core::Vector<core::Vector<core::DMatch>> = core::Vector::new();
    matcher.knn_match_def(&d0, &mut knn, 2)?;

    let good: Vec<[f32; 4]> = knn.iter().filter_map(|m| {
        if m.len() < 2 { return None; }
        let a = m.get(0).ok()?;
        let b = m.get(1).ok()?;
        if a.distance >= 0.8 * b.distance { return None; }
        let p0 = kp0.get(a.query_idx as usize).ok()?.pt();
        let p1 = kp1.get(a.train_idx as usize).ok()?.pt();
        Some([p0.x, p0.y, p1.x, p1.y])
    }).collect();

    log::debug!("[akaze] {}/{} matches after ratio test", good.len(), knn.len());

    if good.len() < MIN_INLIERS {
        anyhow::bail!("AKAZE: too few good matches: {}", good.len());
    }
    homography_usac(&good)
}

// ── Unified entry point ───────────────────────────────────────────────────────

/// Estimate homography: DL matcher → AKAZE fallback.
///
/// `matcher` is `Some` when a model is loaded; `None` skips straight to AKAZE.
pub fn estimate_homography(
    img0: &core::Mat,
    img1: &core::Mat,
    matcher: Option<&mut AnyMatcher>,
) -> anyhow::Result<core::Mat> {
    if let Some(m) = matcher {
        match m.match_images(img0, img1).and_then(|pts| {
            let n = pts.len();
            eprintln!("[dl_match] {} raw matches (need ≥{})", n, MIN_INLIERS);
            if n >= MIN_INLIERS {
                homography_usac(&pts)
            } else {
                anyhow::bail!("too few DL matches: {n}")
            }
        }) {
            Ok(h) => {
                eprintln!("[dl_match] DL homography OK");
                return Ok(h);
            }
            Err(e) => {
                eprintln!("[dl_match] DL failed ({e}), falling back to AKAZE");
            }
        }
    }
    estimate_homography_akaze(img0, img1)
}
