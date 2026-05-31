// Grid assembly and WebP encoding

use image::{DynamicImage, ImageEncoder, RgbaImage, imageops};
use std::io::BufWriter;

pub const CELL_GAP: u32 = 4;
pub const GRID_PADDING: u32 = 8;
pub const HEADER_H: u32 = 144;

/// Where the per-frame timestamp badge is placed relative to each thumbnail cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum TimestampPosition {
    #[value(name = "inside-top-left")]
    InsideTopLeft,
    #[value(name = "inside-top-center")]
    InsideTopCenter,
    #[value(name = "inside-top-right")]
    InsideTopRight,
    #[default]
    #[value(name = "inside-bottom-left")]
    InsideBottomLeft,
    #[value(name = "inside-bottom-center")]
    InsideBottomCenter,
    #[value(name = "inside-bottom-right")]
    InsideBottomRight,
    #[value(name = "outside-bottom-left")]
    OutsideBottomLeft,
    #[value(name = "outside-bottom-center")]
    OutsideBottomCenter,
    #[value(name = "outside-bottom-right")]
    OutsideBottomRight,
}

impl std::fmt::Display for TimestampPosition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::InsideTopLeft      => "inside-top-left",
            Self::InsideTopCenter    => "inside-top-center",
            Self::InsideTopRight     => "inside-top-right",
            Self::InsideBottomLeft   => "inside-bottom-left",
            Self::InsideBottomCenter => "inside-bottom-center",
            Self::InsideBottomRight  => "inside-bottom-right",
            Self::OutsideBottomLeft  => "outside-bottom-left",
            Self::OutsideBottomCenter => "outside-bottom-center",
            Self::OutsideBottomRight => "outside-bottom-right",
        };
        f.write_str(s)
    }
}

impl TimestampPosition {
    pub fn is_outside(self) -> bool {
        matches!(
            self,
            Self::OutsideBottomLeft | Self::OutsideBottomCenter | Self::OutsideBottomRight
        )
    }
}

/// Single source of truth for all grid geometry.
/// Constructed once and shared between the stitcher and the overlay renderer
/// so both always use identical row_gap, header_h and cell positions.
pub struct GridLayout {
    pub header_h: u32,
    pub row_gap: u32,
    pub col_gap: u32,
    pub pad: u32,
    pub cell_w: u32,
    pub cell_h: u32,
    pub rows: u32,
    pub cols: u32,
    pub is_outside_ts: bool,
    /// Width of the QR strip appended to the right of the grid (0 = no QR).
    pub qr_strip_w: u32,
    /// X boundary where the QR strip begins (= original canvas width before QR).
    /// Used to keep the Jellyfin icon and brand text within the non-QR area.
    pub icon_area_w: u32,
}

impl GridLayout {
    /// `qr_strip_w` — pass `crate::qr::qr_strip_width()` when QR is shown, else 0.
    /// `icon_area_w` — the original canvas width (without QR); determines icon placement.
    pub fn compute(
        rows: u32, cols: u32, cell_w: u32, cell_h: u32,
        header_h: u32, timestamp_pos: TimestampPosition,
        qr_strip_w: u32, icon_area_w: u32,
    ) -> Self {
        let is_outside = timestamp_pos.is_outside();
        GridLayout {
            header_h,
            row_gap: if is_outside { 36 } else { CELL_GAP },
            col_gap: CELL_GAP,
            pad: GRID_PADDING,
            cell_w, cell_h, rows, cols,
            is_outside_ts: is_outside,
            qr_strip_w, icon_area_w,
        }
    }

    pub fn cell_origin(&self, col: u32, row: u32) -> (u32, u32) {
        (
            self.pad + col * (self.cell_w + self.col_gap),
            self.header_h + self.pad + row * (self.cell_h + self.row_gap),
        )
    }

    /// Total canvas width including the QR strip.
    pub fn canvas_w(&self) -> u32 {
        self.icon_area_w + self.qr_strip_w
    }

    pub fn canvas_h(&self, show_frame_timestamp: bool) -> u32 {
        let last_row_extra = if self.is_outside_ts && show_frame_timestamp { self.row_gap } else { 0 };
        self.header_h + self.pad * 2 + self.rows * self.cell_h
            + (self.rows - 1) * self.row_gap + last_row_extra
    }
}

pub fn stitch_grid(
    frames: Vec<(DynamicImage, f64)>,
    cell_width: u32,
    rows: u32,
    cols: u32,
    output_path: &str,
    options: &crate::text_renderer::RenderOptions,
    renderer: &crate::text_renderer::Renderer,
    info: &crate::media_info::MediaInfo,
    timestamps: &[f64],
) -> Result<(), String> {
    if frames.is_empty() {
        return Err("No frames to stitch".to_string());
    }

    let first_rgba = frames[0].0.to_rgba8();
    let actual_h = first_rgba.height();
    let actual_w = first_rgba.width();


    let has_header = options.video_info_enabled || options.branding_enabled;
    let header_h = if has_header { HEADER_H } else { 0 };

    // Fill background: transparent for "transparent" theme, black otherwise
    let is_transparent = renderer.theme.header_bg[3] == 0;
    let has_qr = has_header && options.branding_enabled;
    let qr_strip_w = if has_qr { crate::qr::qr_strip_width() } else { 0 };

    // Original canvas width is the icon placement boundary (where QR strip begins).
    let icon_area_w = GRID_PADDING * 2 + cols * cell_width + (cols - 1) * CELL_GAP;
    let total_canvas_w = icon_area_w + qr_strip_w;

    // Widen cells to fill the full canvas (maintaining aspect ratio) so body rows
    // have no black gap next to the QR strip area.
    let effective_cell_w = if qr_strip_w > 0 && cols > 0 {
        (total_canvas_w - GRID_PADDING * 2 - (cols - 1) * CELL_GAP) / cols
    } else {
        cell_width
    };
    let effective_cell_h = if actual_w > 0 {
        (effective_cell_w as f64 * actual_h as f64 / actual_w as f64).round() as u32
    } else {
        effective_cell_w * 9 / 16
    };
    let effective_cell_h = effective_cell_h.max(1);

    let layout = GridLayout::compute(
        rows, cols, effective_cell_w, effective_cell_h,
        header_h, options.timestamp_position,
        qr_strip_w, icon_area_w,
    );

    let grid_w = layout.canvas_w();
    let grid_h = layout.canvas_h(options.show_frame_timestamp);

    let mut grid = RgbaImage::new(grid_w, grid_h);

    if !is_transparent {
        let [cr, cg, cb] = renderer.theme.canvas_bg;
        for pixel in grid.pixels_mut() {
            *pixel = image::Rgba([cr, cg, cb, 255]);
        }
    }

    // Logo watermark confined to the non-QR area (icon_area_w width).
    if !is_transparent {
        crate::logo::render_logo(&mut grid, icon_area_w, grid_h);
    }

    // Place each frame into the grid using effective (wider) cell dimensions.
    for (idx, (frame, _ts)) in frames.iter().enumerate() {
        let row = (idx as u32) / cols;
        let col = (idx as u32) % cols;

        if row >= rows {
            break;
        }

        let (cx, cy) = layout.cell_origin(col, row);

        let resized = frame.resize_exact(
            effective_cell_w,
            effective_cell_h,
            imageops::FilterType::Lanczos3,
        );
        let rgba_frame = resized.to_rgba8();

        imageops::overlay(&mut grid, &rgba_frame, cx as i64, cy as i64);
    }

    // Render overlay (branding, info, per-frame badges) — top layer
    renderer.render(&mut grid, info, options, &layout, timestamps);

    // Render QR into the pre-allocated strip (no canvas expansion needed).
    if has_qr {
        crate::qr::render_qr_in_strip(&mut grid, icon_area_w, qr_strip_w, header_h, &renderer.theme);
    }

    // WebP encode
    let final_w = grid.width();
    let final_h = grid.height();
    let file = std::fs::File::create(output_path)
        .map_err(|e| format!("Cannot create output file '{output_path}': {e}"))?;
    let writer = BufWriter::new(file);
    let encoder = image::codecs::webp::WebPEncoder::new_lossless(writer);
    encoder
        .write_image(grid.as_raw(), final_w, final_h, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("WebP encoding failed: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::DynamicImage;

    fn tmp_path(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    fn blank_frame(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgba8(image::RgbaImage::new(w, h))
    }

    fn dummy_media_info() -> crate::media_info::MediaInfo {
        crate::media_info::MediaInfo {
            filename: "test.mkv".to_string(),
            file_size: "1 GB".to_string(),
            file_size_bytes: 1_073_741_824,
            resolution: "1280\u{d7}720".to_string(),
            source_width: 1280,
            source_height: 720,
            fps: 24.0,
            video_codec: "H.264".to_string(),
            video_profile: Some("High".to_string()),
            video_bitrate: None,
            bit_depth: None,
            hdr_type: None,
            colour_space: None,
            audio_codec: Some("AAC".to_string()),
            audio_format: Some("stereo".to_string()),
            audio_bitrate: Some("128 kbps".to_string()),
            audio_sample_rate: Some(48000),
            audio_tracks: 1,
            duration: "00:30:00".to_string(),
            duration_secs: 1800.0,
            subtitle_count: 0,
        }
    }

    fn dummy_options(enabled: bool) -> crate::text_renderer::RenderOptions {
        crate::text_renderer::RenderOptions {
            branding_enabled: enabled,
            branding_text: "Test".to_string(),
            video_info_enabled: enabled,
            show_file_size: false,
            show_resolution_fps: false,
            show_video_encoding: false,
            show_audio_encoding: false,
            show_duration: false,
            show_subtitles: false,
            show_frame_timestamp: false,
            timestamp_bg: true,
            timestamp_shadow: false,
            timestamp_font_scale: 1.0,
            lang: "en".to_string(),
            timestamp_position: crate::image_stitcher::TimestampPosition::InsideBottomLeft,
        }
    }

    fn dummy_renderer() -> crate::text_renderer::Renderer {
        crate::text_renderer::Renderer::new(None, None, None, None, "classic")
    }

    #[test]
    fn stitch_produces_valid_webp() {
        let out = tmp_path("jfs_test_stitch_valid.webp");
        let (cell_w, cell_h, rows, cols) = (320u32, 180u32, 2u32, 3u32);
        let frames: Vec<(DynamicImage, f64)> = (0..rows * cols)
            .map(|i| (blank_frame(cell_w, cell_h), i as f64 * 10.0))
            .collect();
        let timestamps: Vec<f64> = (0..rows * cols).map(|i| i as f64 * 10.0).collect();

        stitch_grid(
            frames,
            cell_w, rows, cols,
            &out,
            &dummy_options(true),
            &dummy_renderer(),
            &dummy_media_info(),
            &timestamps,
        )
        .expect("stitch should succeed");

        let bytes = std::fs::read(&out).expect("output file should exist");
        assert_eq!(&bytes[..4], b"RIFF", "output must be valid WebP");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn stitch_correct_dimensions_with_header() {
        let out = tmp_path("jfs_test_stitch_dims.webp");
        let (cell_w, cell_h, rows, cols) = (320u32, 180u32, 2u32, 3u32);
        let frames: Vec<(DynamicImage, f64)> = (0..rows * cols)
            .map(|i| (blank_frame(cell_w, cell_h), i as f64))
            .collect();
        let timestamps: Vec<f64> = (0..rows * cols).map(|i| i as f64).collect();

        stitch_grid(
            frames,
            cell_w, rows, cols,
            &out,
            &dummy_options(true),
            &dummy_renderer(),
            &dummy_media_info(),
            &timestamps,
        )
        .expect("stitch should succeed");

        let img = image::open(&out).expect("should decode");
        let qr_w = crate::qr::qr_strip_width();
        let icon_area_w = 16u32 + cols * cell_w + (cols - 1) * 4;
        let total_w = icon_area_w + qr_w;
        let eff_cell_w = (total_w - 16 - (cols - 1) * 4) / cols;
        let eff_cell_h = (eff_cell_w as f64 * cell_h as f64 / cell_w as f64).round() as u32;
        assert_eq!(img.width(), 984 + qr_w, "width includes padding, gaps, and QR strip");
        let expected_h = HEADER_H + 16 + rows * eff_cell_h + (rows - 1) * 4;
        assert_eq!(img.height(), expected_h, "height includes header, padding and gaps");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn stitch_no_overlay_no_header() {
        let out = tmp_path("jfs_test_stitch_nooverlay.webp");
        let (cell_w, cell_h, rows, cols) = (320u32, 180u32, 2u32, 2u32);
        let frames: Vec<(DynamicImage, f64)> = (0..rows * cols)
            .map(|i| (blank_frame(cell_w, cell_h), i as f64))
            .collect();
        let timestamps: Vec<f64> = (0..rows * cols).map(|i| i as f64).collect();

        stitch_grid(
            frames,
            cell_w, rows, cols,
            &out,
            &dummy_options(false),
            &dummy_renderer(),
            &dummy_media_info(),
            &timestamps,
        )
        .expect("stitch without overlay should succeed");

        let img = image::open(&out).expect("should decode");
        assert_eq!(img.height(), 16 + rows * cell_h + (rows - 1) * 4, "no header, with padding and gaps");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn stitch_empty_frames_returns_error() {
        let out = tmp_path("jfs_test_stitch_empty.webp");
        let result = stitch_grid(
            vec![],
            320, 2, 3,
            &out,
            &dummy_options(false),
            &dummy_renderer(),
            &dummy_media_info(),
            &[],
        );
        assert!(result.is_err(), "empty frame list should return Err");
    }

    #[test]
    fn stitch_single_frame_1x1() {
        let out = tmp_path("jfs_test_stitch_1x1.webp");
        let (cell_w, cell_h) = (320u32, 180u32);
        let frames = vec![(blank_frame(cell_w, cell_h), 0.0)];
        let timestamps: Vec<f64> = vec![0.0];

        stitch_grid(
            frames,
            cell_w, 1, 1,
            &out,
            &dummy_options(false),
            &dummy_renderer(),
            &dummy_media_info(),
            &timestamps,
        )
        .expect("1×1 stitch should succeed");

        let img = image::open(&out).expect("should decode");
        let expected_w = 16 + cell_w;
        assert_eq!(img.width(), expected_w);
        let expected_h = 16 + cell_h;
        assert_eq!(img.height(), expected_h);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn stitch_transparent_no_bg_fill() {
        let out = tmp_path("jfs_test_stitch_transp.webp");
        let (cell_w, cell_h, rows, cols) = (320u32, 180u32, 2u32, 2u32);
        let frames: Vec<(DynamicImage, f64)> = (0..rows * cols)
            .map(|i| (blank_frame(cell_w, cell_h), i as f64))
            .collect();
        let timestamps: Vec<f64> = (0..rows * cols).map(|i| i as f64).collect();

        let options = crate::text_renderer::RenderOptions {
            branding_enabled: false,
            branding_text: "Test".to_string(),
            video_info_enabled: false,
            show_file_size: false,
            show_resolution_fps: false,
            show_video_encoding: false,
            show_audio_encoding: false,
            show_duration: false,
            show_subtitles: false,
            show_frame_timestamp: false,
            timestamp_bg: true,
            timestamp_shadow: false,
            timestamp_font_scale: 1.0,
            lang: "en".to_string(),
            timestamp_position: crate::image_stitcher::TimestampPosition::InsideBottomLeft,
        };
        let renderer = crate::text_renderer::Renderer::new(None, None, None, None, "transparent");

        stitch_grid(
            frames,
            cell_w, rows, cols,
            &out,
            &options,
            &renderer,
            &dummy_media_info(),
            &timestamps,
        )
        .expect("stitch transparent should succeed");

        let img = image::open(&out).expect("should decode");
        assert_eq!(img.width(), 16 + cols * cell_w + (cols - 1) * 4);
        let _ = std::fs::remove_file(&out);
    }
}
