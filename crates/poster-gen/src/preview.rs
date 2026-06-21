// Preview subcommand: placeholder grid + theme rendering

use image::{ImageEncoder, RgbaImage};
use std::io::BufWriter;

use crate::media_info::MediaInfo;
use crate::text_renderer::{self, RenderOptions, Renderer};
use crate::image_stitcher::GridLayout;

pub struct PreviewArgs {
    pub output: String,
    pub color_theme: String,
    pub font_path: Option<String>,
    pub branding_latin_font_path: Option<String>,
    pub branding_cjk_font_path: Option<String>,
    pub timestamp_font_path: Option<String>,
    pub branding_enabled: bool,
    pub branding_text: String,
    pub video_info_enabled: bool,
    pub show_file_size: bool,
    pub show_resolution_fps: bool,
    pub show_video_encoding: bool,
    pub show_audio_encoding: bool,
    pub show_duration: bool,
    pub show_subtitles: bool,
    pub show_frame_timestamp: bool,
    pub timestamp_bg: bool,
    pub timestamp_shadow: bool,
    pub timestamp_font_scale: f32,
    pub thumb_width: u32,
    pub rows: u32,
    pub cols: u32,
    pub lang: String,
    pub timestamp_position: crate::image_stitcher::TimestampPosition,
}

/// Sample hardcoded MediaInfo for preview mode.
fn sample_media_info() -> MediaInfo {
    MediaInfo {
        filename: "My Anime 🎬 S01E01 【字幕付き】.mkv".to_string(),
        file_size: "4.2 GB".to_string(),
        file_size_bytes: 4_509_715_660,
        resolution: "1920\u{d7}1080".to_string(),
        source_width: 1920,
        source_height: 1080,
        fps: 23.976,
        video_codec: "H.265".to_string(),
        video_profile: Some("Main 10".to_string()),
        video_bitrate: Some("8500 kbps".to_string()),
        bit_depth: Some(10),
        hdr_type: None,
        colour_space: Some("bt709".to_string()),
        audio_codec: Some("AAC".to_string()),
        audio_format: Some("stereo".to_string()),
        audio_bitrate: Some("192 kbps".to_string()),
        audio_sample_rate: Some(48000),
        audio_tracks: 1,
        subtitle_count: 3,
        duration: "01:23:45".to_string(),
        duration_secs: 5025.0,
    }
}

pub fn run_preview(args: PreviewArgs) -> Result<(), String> {
    let cols: u32 = args.cols;
    let rows: u32 = args.rows;
    let orig_cell_w: u32 = args.thumb_width.clamp(80, 800);
    let orig_cell_h: u32 = orig_cell_w * 9 / 16;
    let header_h: u32 = if args.video_info_enabled || args.branding_enabled {
        crate::image_stitcher::HEADER_H
    } else {
        0
    };

    let renderer = Renderer::new(
        args.font_path.as_deref(),
        args.branding_latin_font_path.as_deref(),
        args.branding_cjk_font_path.as_deref(),
        args.timestamp_font_path.as_deref(),
        &args.color_theme,
    );
    let options = RenderOptions {
        branding_enabled: args.branding_enabled,
        branding_text: args.branding_text.clone(),
        video_info_enabled: args.video_info_enabled,
        show_file_size: args.show_file_size,
        show_resolution_fps: args.show_resolution_fps,
        show_video_encoding: args.show_video_encoding,
        show_audio_encoding: args.show_audio_encoding,
        show_duration: args.show_duration,
        show_subtitles: args.show_subtitles,
        show_frame_timestamp: args.show_frame_timestamp,
        timestamp_bg: args.timestamp_bg,
        timestamp_shadow: args.timestamp_shadow,
        timestamp_font_scale: args.timestamp_font_scale,
        lang: args.lang.clone(),
        timestamp_position: args.timestamp_position,
    };

    let is_transparent = renderer.theme.header_bg[3] == 0;
    let has_qr = header_h > 0 && args.branding_enabled;
    let qr_strip_w = if has_qr { crate::qr::qr_strip_width() } else { 0 };

    // Original canvas width (icon/text boundary); widen cells to fill total canvas.
    let icon_area_w = crate::image_stitcher::GRID_PADDING * 2
        + cols * orig_cell_w
        + (cols - 1) * crate::image_stitcher::CELL_GAP;
    let total_canvas_w = icon_area_w + qr_strip_w;
    let cell_w = if qr_strip_w > 0 && cols > 0 {
        (total_canvas_w
            - crate::image_stitcher::GRID_PADDING * 2
            - (cols - 1) * crate::image_stitcher::CELL_GAP)
            / cols
    } else {
        orig_cell_w
    };
    let cell_h = if orig_cell_w > 0 {
        (cell_w as f64 * orig_cell_h as f64 / orig_cell_w as f64).round() as u32
    } else {
        orig_cell_h
    };
    let cell_h = cell_h.max(1);

    let layout = GridLayout::compute(rows, cols, cell_w, cell_h, header_h, args.timestamp_position,
        qr_strip_w, icon_area_w);
    let grid_w = layout.canvas_w();
    let grid_h = layout.canvas_h(args.show_frame_timestamp);

    let mut grid = RgbaImage::new(grid_w, grid_h);

    let theme = text_renderer::get_theme(&args.color_theme);

    if !is_transparent {
        let [cr, cg, cb] = renderer.theme.canvas_bg;
        for pixel in grid.pixels_mut() {
            *pixel = image::Rgba([cr, cg, cb, 255]);
        }
    }
    if !is_transparent {
        crate::logo::render_logo(&mut grid, icon_area_w, grid_h);
    }

    // Derive placeholder stripe colors from the theme canvas background.
    // For light themes the stripes are darker; for dark themes they are lighter.
    let [br, bg_c, bb] = theme.canvas_bg;
    let luma = br as u32 + bg_c as u32 + bb as u32;
    let is_light_theme = luma > 380;
    let (stripe_a, stripe_b): ([u8; 3], [u8; 3]) = if is_light_theme {
        (
            [br.saturating_sub(30), bg_c.saturating_sub(28), bb.saturating_sub(25)],
            [br.saturating_sub(15), bg_c.saturating_sub(13), bb.saturating_sub(10)],
        )
    } else {
        (
            [br.saturating_add(18), bg_c.saturating_add(18), bb.saturating_add(22)],
            [br.saturating_add(30), bg_c.saturating_add(30), bb.saturating_add(36)],
        )
    };

    for row in 0..rows {
        for col in 0..cols {
            let (cx, cy) = layout.cell_origin(col, row);

            for py in cy..cy + cell_h {
                for px in cx..cx + cell_w {
                    let is_border = px == cx || px == cx + cell_w - 1 || py == cy || py == cy + cell_h - 1;
                    let color = if is_border {
                        image::Rgba([
                            (theme.accent_color[0] as u32 / 4) as u8,
                            (theme.accent_color[1] as u32 / 4) as u8,
                            (theme.accent_color[2] as u32 / 4) as u8,
                            255,
                        ])
                    } else {
                        let stripe = ((px - cx + py - cy) / 24) % 2 == 0;
                        let [r, g, b] = if stripe { stripe_a } else { stripe_b };
                        image::Rgba([r, g, b, 255])
                    };
                    grid.put_pixel(px, py, color);
                }
            }
        }
    }

    // Build sample timestamps (evenly spaced across sample duration)
    let duration_secs = 5025.0_f64;
    let total_frames = (rows * cols) as usize;
    let spacing = duration_secs / total_frames as f64;
    let frame_timestamps: Vec<f64> = (0..total_frames)
        .map(|i| spacing / 2.0 + i as f64 * spacing)
        .collect();

    let info = sample_media_info();
    renderer.render(&mut grid, &info, &options, &layout, &frame_timestamps);

    // Render QR into the pre-allocated strip.
    if has_qr {
        crate::qr::render_qr_in_strip(&mut grid, icon_area_w, qr_strip_w, header_h, &renderer.theme);
    }

    // WebP encode
    let final_w = grid.width();
    let final_h = grid.height();
    let file = std::fs::File::create(&args.output)
        .map_err(|e| format!("Cannot create output file '{}': {e}", args.output))?;
    let writer = BufWriter::new(file);
    let encoder = image::codecs::webp::WebPEncoder::new_lossless(writer);
    encoder
        .write_image(
            grid.as_raw(),
            final_w,
            final_h,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("WebP encoding failed: {e}"))?;

    let abs_path = std::fs::canonicalize(&args.output)
        .unwrap_or_else(|_| std::path::PathBuf::from(&args.output));
    println!("DONE {}", abs_path.display());

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    fn default_args(output: String) -> PreviewArgs {
        PreviewArgs {
            output,
            color_theme: "classic".to_string(),
            font_path: None,
            branding_latin_font_path: None,
            branding_cjk_font_path: None,
            timestamp_font_path: None,
            branding_enabled: true,
            branding_text: "Test Branding".to_string(),
            video_info_enabled: true,
            show_file_size: true,
            show_resolution_fps: true,
            show_video_encoding: true,
            show_audio_encoding: true,
            show_duration: true,
            show_subtitles: true,
            show_frame_timestamp: false,
            timestamp_bg: true,
            timestamp_shadow: false,
            timestamp_font_scale: 1.0,
            thumb_width: 400,
            rows: 2,
            cols: 3,
            lang: "en".to_string(),
            timestamp_position: crate::image_stitcher::TimestampPosition::InsideBottomLeft,
        }
    }

    #[test]
    fn preview_creates_valid_webp() {
        let out = tmp_path("jfs_test_preview_valid.webp");
        run_preview(default_args(out.clone())).expect("preview should succeed");

        let bytes = std::fs::read(&out).expect("output file should exist");
        // WebP magic bytes: RIFF
        assert_eq!(&bytes[..4], b"RIFF", "output must be a valid WebP");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn preview_correct_dimensions_with_header() {
        let out = tmp_path("jfs_test_preview_dims.webp");
        run_preview(default_args(out.clone())).expect("preview should succeed");

        let img = image::open(&out).expect("should open as image");
        let qr_w = crate::qr::qr_strip_width();
        // icon_area_w = pad*2 + 3*(1200/3) + 2*gap = 16 + 1200 + 8 = 1224
        let orig_cell_w = 1200u32 / 3;
        let orig_cell_h = orig_cell_w * 9 / 16;
        let icon_area_w = crate::image_stitcher::GRID_PADDING * 2
            + 3 * orig_cell_w + 2 * crate::image_stitcher::CELL_GAP;
        let total_canvas_w = icon_area_w + qr_w;
        let eff_cw = (total_canvas_w - crate::image_stitcher::GRID_PADDING * 2 - 2 * crate::image_stitcher::CELL_GAP) / 3;
        let eff_ch = (eff_cw as f64 * orig_cell_h as f64 / orig_cell_w as f64).round() as u32;
        assert_eq!(img.width(), icon_area_w + qr_w, "width should include gaps, padding, and QR strip");
        let expected_h = crate::image_stitcher::HEADER_H + 16 + 2 * eff_ch + 4;
        assert_eq!(img.height(), expected_h, "height should include header, gaps and padding");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn preview_no_overlay_omits_header() {
        let out = tmp_path("jfs_test_preview_nooverlay.webp");
        run_preview(PreviewArgs {
            branding_latin_font_path: None,
            branding_cjk_font_path: None,
            timestamp_font_path: None,
            output: out.clone(),
            color_theme: "dark".to_string(),
            font_path: None,
            branding_enabled: false,
            branding_text: String::new(),
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
            thumb_width: 400,
            rows: 2,
            cols: 3,
            lang: "en".to_string(),
            timestamp_position: crate::image_stitcher::TimestampPosition::InsideBottomLeft,
        })
        .expect("preview should succeed without overlay");

        let img = image::open(&out).expect("should open as image");
        // No header: pad*2 + 2 rows*225 + (2-1)*4 gap = 16 + 450 + 4 = 470
        assert_eq!(img.height(), 470, "height should include padding and gaps (no header)");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn preview_all_themes_produce_valid_webp() {
        for theme in ["classic", "dark", "light", "cinematic", "minimal"] {
            let out = tmp_path(&format!("jfs_test_preview_{theme}.webp"));
            let mut args = default_args(out.clone());
            args.color_theme = theme.to_string();
            args.show_frame_timestamp = true;

            run_preview(args).unwrap_or_else(|e| panic!("preview theme={theme} failed: {e}"));

            let bytes = std::fs::read(&out).expect("file should exist");
            assert_eq!(&bytes[..4], b"RIFF", "theme={theme}: not a WebP");
            assert!(bytes.len() > 1024, "theme={theme}: file suspiciously small");
            let _ = std::fs::remove_file(&out);
        }
    }

    #[test]
    fn preview_output_file_is_nonempty() {
        let out = tmp_path("jfs_test_preview_size.webp");
        run_preview(default_args(out.clone())).expect("preview should succeed");

        let meta = std::fs::metadata(&out).expect("file should exist");
        assert!(meta.len() > 4096, "JPEG should be at least 4 KB");
        let _ = std::fs::remove_file(&out);
    }
}
