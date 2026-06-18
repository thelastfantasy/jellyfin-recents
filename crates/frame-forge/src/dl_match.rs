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

    pub fn load_with_ep(path: &Path, device_id: &str) -> anyhow::Result<(Self, Vec<crate::generation_log::FallbackEvent>)> {
        let (session, fallbacks) = build_ep_session(path, device_id)?;
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

    pub fn load_with_ep(path: &Path, device_id: &str) -> anyhow::Result<(Self, Vec<crate::generation_log::FallbackEvent>)> {
        let (session, fallbacks) = build_ep_session(path, device_id)?;
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

    pub fn load_with_ep(path: &Path, device_id: &str) -> anyhow::Result<(Self, Vec<crate::generation_log::FallbackEvent>)> {
        let (session, fallbacks) = build_ep_session(path, device_id)?;
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
    pub fn match_images(
        &mut self,
        img0: &core::Mat,
        img1: &core::Mat,
    ) -> anyhow::Result<Vec<[f32; 4]>> {
        match self {
            AnyMatcher::EfficientLoFTR(m) => m.match_images(img0, img1),
            AnyMatcher::LightGlue(m)      => m.match_images(img0, img1),
            AnyMatcher::LightGlueV2(m)    => m.match_images(img0, img1),
        }
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

/// Build an ORT session for `path` using the EP indicated by `device_id`.
/// On GPU EP failure, falls back to CPU and records a FallbackEvent.
///
/// `with_execution_providers` returns `ort::Error<SessionBuilder>` which is not `Send+Sync`,
/// so we use `.ok()` (discarding the error) for the GPU try-path and `map_err` for CPU.
pub fn build_ep_session(
    path: &Path,
    device_id: &str,
) -> anyhow::Result<(Session, Vec<crate::generation_log::FallbackEvent>)> {
    let (platform, _dev_idx) = parse_device_id(device_id);

    // CPU: omit explicit EP; ort defaults to CPU execution.
    let make_cpu = |p: &Path| -> anyhow::Result<Session> {
        Session::builder()
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .commit_from_file(p)
            .map_err(|e| anyhow::anyhow!("{e}"))
    };

    match platform {
        "cuda" => {
            use ort::execution_providers::CUDAExecutionProvider;
            let gpu = Session::builder().ok()
                .and_then(|b| b.with_execution_providers([CUDAExecutionProvider::default().build()]).ok())
                .and_then(|mut b| b.commit_from_file(path).ok());
            match gpu {
                Some(s) => Ok((s, vec![])),
                None => {
                    log::warn!("[dl_match] CUDA EP unavailable for {device_id}, falling back to CPU");
                    Ok((make_cpu(path)?, vec![crate::generation_log::FallbackEvent {
                        event_type: "GPU→CPU".to_string(),
                        reason: "CUDA EP init failed".to_string(),
                        timestamp: crate::generation_log::now_timestamp(),
                    }]))
                }
            }
        }
        "directml" => {
            use ort::execution_providers::DirectMLExecutionProvider;
            let gpu = Session::builder().ok()
                .and_then(|b| b.with_execution_providers([DirectMLExecutionProvider::default().build()]).ok())
                .and_then(|mut b| b.commit_from_file(path).ok());
            match gpu {
                Some(s) => Ok((s, vec![])),
                None => {
                    log::warn!("[dl_match] DirectML EP unavailable for {device_id}, falling back to CPU");
                    Ok((make_cpu(path)?, vec![crate::generation_log::FallbackEvent {
                        event_type: "GPU→CPU".to_string(),
                        reason: "DirectML EP init failed".to_string(),
                        timestamp: crate::generation_log::now_timestamp(),
                    }]))
                }
            }
        }
        _ => make_cpu(path).map(|s| (s, vec![])),
    }
}

/// Load a fresh per-request matcher (bypasses global singleton) using the EP
/// indicated by `device_id`. Returns (matcher, fallback_events).
pub fn load_matcher_for_request(
    device_id: &str,
    model_choice: ModelChoice,
) -> (Option<AnyMatcher>, Vec<crate::generation_log::FallbackEvent>) {
    if matches!(model_choice, ModelChoice::Disabled) {
        return (None, vec![]);
    }

    // Determine which model file to load
    let load_result = match model_choice {
        ModelChoice::LightGlue => load_lightglue_with_ep(device_id),
        ModelChoice::EfficientLoFTR => load_loftr_with_ep(device_id),
        ModelChoice::Auto | ModelChoice::Disabled => {
            // Same precedence as load_lightglue / load_loftr
            load_lightglue_with_ep(device_id)
                .or_else(|| load_loftr_with_ep(device_id))
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

fn load_lightglue_with_ep(device_id: &str) -> Option<(AnyMatcher, Vec<crate::generation_log::FallbackEvent>)> {
    if let Some(p) = find_model("superpoint_lightglue_pipeline.onnx") {
        if let Ok((m, fb)) = LGlueV2::load_with_ep(&p, device_id)
            .map_err(|e| log::warn!("[dl_match] LightGlue v2 EP load failed: {e}"))
        {
            return Some((AnyMatcher::LightGlueV2(m), fb));
        }
    }
    if let Some(p) = find_model("superpoint_lightglue.onnx") {
        if let Ok((m, fb)) = LGlue::load_with_ep(&p, device_id)
            .map_err(|e| log::warn!("[dl_match] LightGlue v1 EP load failed: {e}"))
        {
            return Some((AnyMatcher::LightGlue(m), fb));
        }
    }
    None
}

fn load_loftr_with_ep(device_id: &str) -> Option<(AnyMatcher, Vec<crate::generation_log::FallbackEvent>)> {
    let path = find_model("eloftr_640x480.onnx")
        .or_else(|| find_model("efficient_loftr.onnx"))?;
    ELoFTR::load_with_ep(&path, device_id)
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
        0.001_f32, 4, 4, features2d::KAZE_DiffusivityType::DIFF_PM_G2,
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
