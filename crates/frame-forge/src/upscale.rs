//! Tile-based Real-ESRGAN super-resolution inference.
//!
//! Real-ESRGAN ONNX exports are commit_from_file'd with a fixed (or impractically large
//! VRAM-hungry) spatial input shape, so large images cannot be fed through the session in
//! one pass. This module splits the source image into overlapping `tile`x`tile` patches,
//! runs each through `session`, and reassembles the upscaled patches into one image using
//! weighted-overlap blending (the weight ramps down near interior tile seams so neighbouring
//! tiles' predictions fade into each other instead of producing visible seam lines).
//!
//! Scale (×2/×4) and style (photo/anime) are not parameters here — they are entirely a
//! function of which model file the caller has loaded into `session` (FR-024); this module
//! discovers the scale factor at runtime from the first tile's output shape.

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Context as _;
use image::{DynamicImage, RgbImage};
use ndarray::Array4;
use ort::session::Session;
use ort::value::TensorRef;

/// Upscale `img` by running it through `session` tile-by-tile.
///
/// `tile` is the model's expected square input size (e.g. 128, 256); `overlap` is the
/// margin (px, in *input* tile coordinates) shared between adjacent tiles to blend across
/// seams. Requires `tile > overlap * 2`.
///
/// `cancel` is checked before every tile's `session.run` — the finest granularity available,
/// since each call is itself a single blocking FFI invocation that can't be interrupted mid-flight
/// (see server.rs's handle_upscale for why this matters: a stuck/slow job otherwise has no way
/// to stop early short of aborting the whole daemon process).
pub fn upscale_image(
    session: &mut Session,
    img: &DynamicImage,
    tile: u32,
    overlap: u32,
    cancel: &AtomicBool,
) -> anyhow::Result<DynamicImage> {
    anyhow::ensure!(tile > overlap * 2, "tile ({tile}) must exceed 2x overlap ({overlap})");
    let rgb = img.to_rgb8();
    let (src_w, src_h) = rgb.dimensions();
    anyhow::ensure!(src_w > 0 && src_h > 0, "empty input image");

    let step = tile - overlap;
    let xs = tile_origins(src_w, tile, step);
    let ys = tile_origins(src_h, tile, step);
    let input_name = session.inputs().first().context("upscale model has no inputs")?.name().to_string();

    let mut scale: u32 = 0;
    let mut acc: Vec<f32> = Vec::new();
    let mut wsum: Vec<f32> = Vec::new();
    let mut out_w = 0u32;
    let mut out_h = 0u32;

    for &y0 in &ys {
        for &x0 in &xs {
            anyhow::ensure!(!cancel.load(Ordering::Relaxed), "upscale cancelled");
            let tile_img = extract_tile(&rgb, x0, y0, tile);
            let input = tile_to_array(&tile_img);
            let t = TensorRef::from_array_view(input.view())?;
            let outputs = session
                .run(vec![(input_name.as_str(), t)])
                .map_err(|e| anyhow::anyhow!("upscale session.run failed: {e}"))?;
            let (shape, data) = outputs[0].try_extract_tensor::<f32>()?;
            anyhow::ensure!(shape.len() == 4 && shape[1] == 3, "unexpected upscale output shape {shape:?}");
            let tile_out_h = shape[2] as u32;
            let tile_out_w = shape[3] as u32;

            if scale == 0 {
                anyhow::ensure!(
                    tile_out_w % tile == 0 && tile_out_h == tile_out_w,
                    "upscale model output {tile_out_w}x{tile_out_h} is not a square multiple of tile size {tile}"
                );
                scale = tile_out_w / tile;
                out_w = src_w * scale;
                out_h = src_h * scale;
                acc = vec![0.0; (out_w as usize) * (out_h as usize) * 3];
                wsum = vec![0.0; (out_w as usize) * (out_h as usize)];
            }

            let touches_left = x0 == 0;
            let touches_right = x0 + tile >= src_w;
            let touches_top = y0 == 0;
            let touches_bottom = y0 + tile >= src_h;
            let plane = (tile_out_w * tile_out_h) as usize;
            let ov_out = overlap * scale;

            for dy in 0..tile_out_h {
                let wy = edge_ramp(dy, tile_out_h, ov_out, touches_top, touches_bottom);
                let oy = y0 * scale + dy;
                if oy >= out_h { continue; }
                for dx in 0..tile_out_w {
                    let wx = edge_ramp(dx, tile_out_w, ov_out, touches_left, touches_right);
                    let ox = x0 * scale + dx;
                    if ox >= out_w { continue; }
                    let w = wx * wy;
                    let src_idx = (dy * tile_out_w + dx) as usize;
                    let dst_pix = (oy as usize * out_w as usize + ox as usize) * 3;
                    let dst_w = oy as usize * out_w as usize + ox as usize;
                    acc[dst_pix]     += data[src_idx] * w;
                    acc[dst_pix + 1] += data[plane + src_idx] * w;
                    acc[dst_pix + 2] += data[plane * 2 + src_idx] * w;
                    wsum[dst_w] += w;
                }
            }
        }
    }

    anyhow::ensure!(scale > 0, "upscale produced no tiles (empty image?)");
    let mut out = RgbImage::new(out_w, out_h);
    for y in 0..out_h {
        for x in 0..out_w {
            let pix_idx = (y as usize * out_w as usize + x as usize) * 3;
            let w = wsum[y as usize * out_w as usize + x as usize].max(1e-6);
            out.put_pixel(x, y, image::Rgb([
                ((acc[pix_idx] / w).clamp(0.0, 1.0) * 255.0) as u8,
                ((acc[pix_idx + 1] / w).clamp(0.0, 1.0) * 255.0) as u8,
                ((acc[pix_idx + 2] / w).clamp(0.0, 1.0) * 255.0) as u8,
            ]));
        }
    }
    Ok(DynamicImage::ImageRgb8(out))
}

/// Tile origins along one axis: 0, step, 2*step, ... with the final origin clamped so the
/// last tile's far edge lands exactly on `len` (no out-of-bounds tile, no short final tile).
/// When `len <= tile`, returns a single origin at 0 (the tile extraction pads via edge-clamp).
fn tile_origins(len: u32, tile: u32, step: u32) -> Vec<u32> {
    if len <= tile {
        return vec![0];
    }
    let mut origins = Vec::new();
    let mut x = 0u32;
    loop {
        origins.push(x);
        if x + tile >= len { break; }
        x = (x + step).min(len - tile);
    }
    origins
}

/// Extract a `tile`x`tile` patch at `(x0, y0)`, clamping out-of-bounds reads to the nearest
/// edge pixel (only engages when the source image itself is smaller than `tile`, since
/// `tile_origins` otherwise keeps every tile fully in-bounds).
fn extract_tile(rgb: &RgbImage, x0: u32, y0: u32, tile: u32) -> RgbImage {
    let (src_w, src_h) = rgb.dimensions();
    let mut out = RgbImage::new(tile, tile);
    for dy in 0..tile {
        let sy = (y0 + dy).min(src_h - 1);
        for dx in 0..tile {
            let sx = (x0 + dx).min(src_w - 1);
            out.put_pixel(dx, dy, *rgb.get_pixel(sx, sy));
        }
    }
    out
}

/// Blend weight for position `pos` along an axis of length `len`: ramps linearly from
/// ~0 to 1 across the first/last `overlap` px, but only on sides that border another tile
/// (a side touching the image's true edge has no neighbour to blend with, so stays at 1).
fn edge_ramp(pos: u32, len: u32, overlap: u32, touches_start: bool, touches_end: bool) -> f32 {
    if overlap == 0 { return 1.0; }
    let mut w = 1.0f32;
    if !touches_start && pos < overlap {
        w *= (pos as f32 + 1.0) / (overlap as f32 + 1.0);
    }
    if !touches_end && pos + overlap >= len {
        let from_end = len - 1 - pos;
        w *= (from_end as f32 + 1.0) / (overlap as f32 + 1.0);
    }
    w.max(1e-3)
}

/// RGB u8 tile → NCHW float32 [0,1] tensor, matching Real-ESRGAN's standard ONNX input layout.
fn tile_to_array(tile_img: &RgbImage) -> Array4<f32> {
    let (w, h) = tile_img.dimensions();
    let raw = tile_img.as_raw();
    let w_usize = w as usize;
    Array4::from_shape_fn([1, 3, h as usize, w_usize], |(_, c, y, x)| {
        raw[(y * w_usize + x) * 3 + c] as f32 / 255.0
    })
}
