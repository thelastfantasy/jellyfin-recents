//! Face detection (YuNet) + GFPGAN face-restoration pass.
//!
//! Face detection here uses OpenCV's `cv::FaceDetectorYN` (YuNet), not the project's ONNX
//! model catalog (spec.md Assumptions) — only the GFPGAN restoration model itself is
//! catalog-managed. The small YuNet detector weights are expected to be placed alongside
//! the other DL model files and are located via `dl_match::find_model`, the same search
//! path already used for LightGlue/EfficientLoFTR.

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Context as _;
use image::{DynamicImage, RgbImage, RgbaImage};
use ndarray::Array4;
use opencv::core::{Mat, Size};
use opencv::prelude::*;
use opencv::objdetect;
use ort::session::Session;
use ort::value::TensorRef;

const YUNET_MODEL_FILE: &str = "face_detection_yunet_2023mar.onnx";
const YUNET_SCORE_THRESHOLD: f32 = 0.7;
const YUNET_NMS_THRESHOLD: f32 = 0.3;
const YUNET_TOP_K: i32 = 50;
const GFPGAN_INPUT_SIZE: u32 = 512;
/// Extra context around each detected box before cropping, as a fraction of the box's own
/// width/height (GFPGAN expects some surrounding context, not a tight crop).
const CROP_MARGIN: f32 = 0.4;
/// Width of the feather ramp at the patch edges, as a fraction of the patch's own size.
const FEATHER_FRACTION: f32 = 0.15;

struct FaceBox {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// Detect faces in `img` via YuNet and run each through the GFPGAN `session`, blending the
/// restored faces back into a copy of `img`. Returns `img` unchanged (no error) when the
/// YuNet weights are missing or zero faces are detected (FR-025, Edge Cases), alongside the
/// number of faces actually restored (0 in both of those skip cases) — callers use this count
/// to report `faceRestoreSkippedNoFace` back to the C# side.
pub fn restore_faces(session: &mut Session, img: &DynamicImage, cancel: &AtomicBool) -> anyhow::Result<(DynamicImage, usize)> {
    let model_path = match crate::dl_match::find_model(YUNET_MODEL_FILE) {
        Some(p) => p,
        None => {
            log::warn!("[face_restore] {YUNET_MODEL_FILE} not found, skipping face restoration");
            return Ok((img.clone(), 0));
        }
    };

    let mut canvas = img.to_rgba8();
    let (w, h) = canvas.dimensions();
    let bgr = rgba_to_bgr_mat(&canvas)?;

    let mut detector = objdetect::FaceDetectorYN::create(
        &model_path.to_string_lossy(),
        "",
        Size::new(w as i32, h as i32),
        YUNET_SCORE_THRESHOLD,
        YUNET_NMS_THRESHOLD,
        YUNET_TOP_K,
        0,
        0,
    )?;

    let mut faces_mat = Mat::default();
    detector.detect(&bgr, &mut faces_mat)?;

    let n = faces_mat.rows();
    if n <= 0 {
        return Ok((img.clone(), 0));
    }

    let mut boxes = Vec::with_capacity(n as usize);
    for i in 0..n {
        let x = *faces_mat.at_2d::<f32>(i, 0)?;
        let y = *faces_mat.at_2d::<f32>(i, 1)?;
        let bw = *faces_mat.at_2d::<f32>(i, 2)?;
        let bh = *faces_mat.at_2d::<f32>(i, 3)?;
        boxes.push(expand_box(x, y, bw, bh, w, h));
    }

    let input_name = session.inputs().first().context("face restore model has no inputs")?.name().to_string();

    for fb in &boxes {
        anyhow::ensure!(!cancel.load(Ordering::Relaxed), "upscale cancelled");
        let crop = image::imageops::crop_imm(&canvas, fb.x as u32, fb.y as u32, fb.w as u32, fb.h as u32).to_image();
        let crop_rgb = DynamicImage::ImageRgba8(crop).to_rgb8();
        let (in_w, in_h) = crop_rgb.dimensions();
        let resized = image::imageops::resize(&crop_rgb, GFPGAN_INPUT_SIZE, GFPGAN_INPUT_SIZE, image::imageops::FilterType::Lanczos3);

        let input = face_to_array(&resized);
        let t = TensorRef::from_array_view(input.view())?;
        let outputs = session
            .run(vec![(input_name.as_str(), t)])
            .map_err(|e| anyhow::anyhow!("face restore session.run failed: {e}"))?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>()?;
        anyhow::ensure!(shape.len() == 4 && shape[1] == 3, "unexpected face-restore output shape {shape:?}");
        let out_w = shape[3] as u32;
        let out_h = shape[2] as u32;

        let restored = array_to_image(data, out_w, out_h);
        let restored_back = image::imageops::resize(&restored, in_w, in_h, image::imageops::FilterType::Lanczos3);
        feather_blend(&mut canvas, &restored_back, fb.x, fb.y);
    }

    Ok((DynamicImage::ImageRgba8(canvas), boxes.len()))
}

/// Expand a detected box by `CROP_MARGIN` on each side and clamp to image bounds.
fn expand_box(x: f32, y: f32, bw: f32, bh: f32, img_w: u32, img_h: u32) -> FaceBox {
    let mx = bw * CROP_MARGIN;
    let my = bh * CROP_MARGIN;
    let x0 = (x - mx).max(0.0);
    let y0 = (y - my).max(0.0);
    let x1 = (x + bw + mx).min(img_w as f32);
    let y1 = (y + bh + my).min(img_h as f32);
    FaceBox {
        x: x0 as i32,
        y: y0 as i32,
        w: (x1 - x0).max(1.0) as i32,
        h: (y1 - y0).max(1.0) as i32,
    }
}

/// RGB u8 → NCHW float32 [-1,1] tensor, matching GFPGAN's standard ONNX input normalization.
fn face_to_array(img: &RgbImage) -> Array4<f32> {
    let (w, h) = img.dimensions();
    let raw = img.as_raw();
    let w_usize = w as usize;
    Array4::from_shape_fn([1, 3, h as usize, w_usize], |(_, c, y, x)| {
        let v = raw[(y * w_usize + x) * 3 + c] as f32 / 255.0;
        (v - 0.5) / 0.5
    })
}

/// NCHW float32 [-1,1] planar data → RGB u8 image.
fn array_to_image(data: &[f32], w: u32, h: u32) -> RgbImage {
    let plane = (w * h) as usize;
    let mut out = RgbImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let px = [0usize, plane, plane * 2].map(|off| {
                ((data[off + idx] * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0) as u8
            });
            out.put_pixel(x, y, image::Rgb(px));
        }
    }
    out
}

/// Alpha-blend `patch` into `canvas` at `(ox, oy)`, ramping alpha to 0 within
/// `FEATHER_FRACTION` of the patch's edges so the restored face fades into the
/// surrounding (untouched) upscaled image instead of producing a visible seam.
fn feather_blend(canvas: &mut RgbaImage, patch: &RgbImage, ox: i32, oy: i32) {
    let (pw, ph) = patch.dimensions();
    let (cw, ch) = canvas.dimensions();
    let margin_x = (pw as f32 * FEATHER_FRACTION).max(1.0);
    let margin_y = (ph as f32 * FEATHER_FRACTION).max(1.0);

    for dy in 0..ph {
        let cy = oy + dy as i32;
        if cy < 0 || cy >= ch as i32 { continue; }
        let wy = edge_feather(dy, ph, margin_y);
        for dx in 0..pw {
            let cx = ox + dx as i32;
            if cx < 0 || cx >= cw as i32 { continue; }
            let wx = edge_feather(dx, pw, margin_x);
            let alpha = wx * wy;
            if alpha <= 0.0 { continue; }
            let src = patch.get_pixel(dx, dy);
            let dst = canvas.get_pixel_mut(cx as u32, cy as u32);
            for c in 0..3 {
                dst[c] = (src[c] as f32 * alpha + dst[c] as f32 * (1.0 - alpha)) as u8;
            }
        }
    }
}

fn edge_feather(pos: u32, len: u32, margin: f32) -> f32 {
    let pos = pos as f32;
    let len = len as f32;
    let from_start = pos / margin;
    let from_end = (len - 1.0 - pos) / margin;
    from_start.min(from_end).min(1.0).max(0.0)
}

fn rgba_to_bgr_mat(rgba: &RgbaImage) -> anyhow::Result<Mat> {
    let (w, h) = rgba.dimensions();
    let raw = rgba.as_raw();
    let mut mat = Mat::new_rows_cols_with_default(h as i32, w as i32, opencv::core::CV_8UC3, opencv::core::Scalar::default())?;
    let bytes = mat.data_bytes_mut()?;
    for i in 0..(w as usize * h as usize) {
        bytes[i * 3] = raw[i * 4 + 2];
        bytes[i * 3 + 1] = raw[i * 4 + 1];
        bytes[i * 3 + 2] = raw[i * 4];
    }
    Ok(mat)
}
