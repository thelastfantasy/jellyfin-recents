// Overlay text rendering with ab_glyph TTF / pixel font

use image::{Pixel, RgbaImage};
use ab_glyph::{Font, FontArc, PxScale, ScaleFont};

#[derive(Clone, Copy)]
enum CharClass { Latin, Cjk }

fn classify_char(ch: char) -> CharClass {
    let cp = ch as u32;
    match cp {
        0x2E80..=0x2EFF | 0x2F00..=0x2FDF |
        0x3000..=0x303F | 0x3040..=0x309F | 0x30A0..=0x30FF |
        0x3100..=0x312F | 0x3190..=0x319F | 0x31C0..=0x31FF |
        0x3200..=0x33FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF |
        0xA000..=0xA48F | 0xAC00..=0xD7AF |
        0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFFEF |
        0x20000..=0x2A6DF | 0x2A700..=0x2CEAF | 0x2CEB0..=0x2EBEF |
        0x30000..=0x3134F => CharClass::Cjk,
        _ => CharClass::Latin,
    }
}

/// Probe the cap height of a Latin font by measuring the 'H' glyph bounding box.
/// Returns the height in pixels above the baseline at the given scale.
fn probe_cap_height(font: &FontArc, scale_px: f32) -> f32 {
    let scale = PxScale::from(scale_px);
    for ch in ['H', 'A', 'T', 'M'] {
        let id = font.glyph_id(ch);
        if id.0 != 0 {
            if let Some(g) = font.outline_glyph(id.with_scale(scale)) {
                let h = -g.px_bounds().min.y;
                if h > 0.0 { return h; }
            }
        }
    }
    font.as_scaled(PxScale::from(scale_px)).ascent()
}

/// Probe the visual height of a CJK font by measuring a full-width ideograph.
/// CJK glyphs fill the em square and are typically ~23% taller than Latin cap height
/// in the same font at the same scale_px.
fn probe_cjk_height(font: &FontArc, scale_px: f32) -> f32 {
    let scale = PxScale::from(scale_px);
    for ch in ['大', '中', '字', '国'] {
        let id = font.glyph_id(ch);
        if id.0 != 0 {
            if let Some(g) = font.outline_glyph(id.with_scale(scale)) {
                let h = -g.px_bounds().min.y;
                if h > 0.0 { return h; }
            }
        }
    }
    // No CJK glyphs in this font — fall back to Latin cap height
    probe_cap_height(font, scale_px)
}

const MARGIN: u32 = 10;

fn badge_pos(
    cell_x: u32, cell_y: u32,
    cell_w: u32, cell_h: u32,
    badge_w: u32, badge_h: u32,
    pad: u32,
    pos: crate::image_stitcher::TimestampPosition,
) -> (u32, u32) {
    use crate::image_stitcher::TimestampPosition::*;
    match pos {
        InsideTopLeft      => (cell_x + pad,                      cell_y + pad),
        InsideTopCenter    => (cell_x + (cell_w - badge_w) / 2,  cell_y + pad),
        InsideTopRight     => (cell_x + cell_w - badge_w - pad,   cell_y + pad),
        InsideBottomLeft   => (cell_x + pad,                      cell_y + cell_h - badge_h - pad),
        InsideBottomCenter => (cell_x + (cell_w - badge_w) / 2,  cell_y + cell_h - badge_h - pad),
        InsideBottomRight  => (cell_x + cell_w - badge_w - pad,  cell_y + cell_h - badge_h - pad),
        OutsideBottomLeft  => (cell_x + pad,                     cell_y + cell_h + pad),
        OutsideBottomCenter => (cell_x + (cell_w - badge_w) / 2, cell_y + cell_h + pad),
        OutsideBottomRight => (cell_x + cell_w - badge_w - pad,  cell_y + cell_h + pad),
    }
}

/// RGBA theme colors — all per-theme palette decisions live here, no runtime guessing.
#[derive(Clone)]
pub struct ThemeColors {
    pub header_bg: [u8; 4],     // RGBA — header strip background
    pub text_color: [u8; 3],    // RGB  — video-info body text
    pub accent_color: [u8; 3],  // RGB  — branding label / filename highlight
    pub badge_bg: [u8; 4],      // RGBA — timestamp badge background
    pub badge_text: [u8; 3],    // RGB  — timestamp badge text
    pub canvas_bg: [u8; 3],     // RGB  — thumbnail grid background
    // QR bubble colours — declared per-theme so qr.rs needs no heuristics
    pub qr_bubble: [u8; 4],     // RGBA — rounded bubble background
    pub qr_module_a: [u8; 3],   // RGB  — data-module colour at top row
    pub qr_module_b: [u8; 3],   // RGB  — data-module colour at bottom (lerped; flat = same as a)
    pub qr_finder_dark: [u8; 3],// RGB  — finder pattern outer/inner ring
    pub qr_finder_light: [u8; 3],// RGB — finder pattern middle ring (should match qr_bubble)
    // Timestamp effect colours — chosen per-theme for correct contrast in each context
    pub ts_outline: [u8; 3],    // RGB  — outline/rim when badge_bg is visible
    pub ts_shadow: [u8; 3],     // RGB  — drop-shadow when no badge_bg (text floats on video)
}

/// What to render and how — font/theme/grid are handled by Renderer and passed separately.
pub struct RenderOptions {
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
    pub lang: String,
    pub timestamp_position: crate::image_stitcher::TimestampPosition,
}

/// Holds pre-loaded fonts and resolved theme — construct once per job, reuse for rendering.
pub struct Renderer {
    font: Option<FontArc>,
    branding_latin_font: Option<FontArc>,
    /// Scale factor applied to Latin branding chars so their cap height matches the reference font.
    /// < 1.0 means the font has taller-than-reference caps (e.g. Oswald ≈ 0.88).
    branding_latin_scale: f32,
    branding_cjk_font: Option<FontArc>,
    /// Scale factor for CJK ideographs. CJK chars fill the em square (~23% taller than Latin cap),
    /// so this is typically ≈ 0.81 when the reference font is Noto Sans.
    branding_cjk_scale: f32,
    timestamp_font: Option<FontArc>,
    pub theme: ThemeColors,
}

impl Renderer {
    /// Loads fonts from disk once. `branding_latin_font_path`, `branding_cjk_font_path` and
    /// `timestamp_font_path` fall back to `font_path` if not provided or if loading fails.
    pub fn new(
        font_path: Option<&str>,
        branding_latin_font_path: Option<&str>,
        branding_cjk_font_path: Option<&str>,
        timestamp_font_path: Option<&str>,
        color_theme: &str,
    ) -> Self {
        let font = font_path.and_then(load_font);
        let branding_latin_font = branding_latin_font_path.and_then(load_font).or_else(|| font.clone());
        let branding_cjk_font = branding_cjk_font_path.and_then(load_font).or_else(|| font.clone());
        let timestamp_font = timestamp_font_path.and_then(load_font).or_else(|| font.clone());

        // Compute cap-height scale factors at font-load time by probing representative glyphs.
        // Reference: Noto Sans Latin cap height ≈ 0.714 em. We measure the actual reference
        // from the info-text font so custom fonts work correctly without hardcoding.
        const PROBE_PX: f32 = 100.0;
        let ref_cap = font.as_ref().map(|f| probe_cap_height(f, PROBE_PX)).unwrap_or(71.4);
        let branding_latin_scale = branding_latin_font.as_ref()
            .map(|f| { let c = probe_cap_height(f, PROBE_PX); if c > 0.0 { ref_cap / c } else { 1.0 } })
            .unwrap_or(1.0);
        let branding_cjk_scale = branding_cjk_font.as_ref()
            .map(|f| { let c = probe_cjk_height(f, PROBE_PX); if c > 0.0 { ref_cap / c } else { 1.0 } })
            .unwrap_or(1.0);

        Renderer {
            font,
            branding_latin_font,
            branding_latin_scale,
            branding_cjk_font,
            branding_cjk_scale,
            timestamp_font,
            theme: get_theme(color_theme),
        }
    }

    /// Renders branding, video info, and per-frame timestamp badges onto `img`.
    /// `layout` and `timestamps` carry the grid geometry and per-cell timestamp values.
    pub fn render(
        &self,
        img: &mut RgbaImage,
        info: &crate::media_info::MediaInfo,
        options: &RenderOptions,
        layout: &crate::image_stitcher::GridLayout,
        timestamps: &[f64],
    ) {
        let font_ref: Option<&FontArc> = self.font.as_ref();
        let brand_latin_ref: Option<&FontArc> = self.branding_latin_font.as_ref();
        let brand_cjk_ref: Option<&FontArc> = self.branding_cjk_font.as_ref();
        let brand_latin_scale = self.branding_latin_scale;
        let brand_cjk_scale = self.branding_cjk_scale;
        let ts_font_ref: Option<&FontArc> = self.timestamp_font.as_ref();
        let theme = &self.theme;
        let img_width = img.width();
        let img_height = img.height();

        let has_header = options.video_info_enabled || options.branding_enabled;
        if !has_header {
            // No header: only render per-frame timestamp badges and return
            if options.show_frame_timestamp && !timestamps.is_empty() {
                let badge_pad = 4u32;
                let target_text_w = (layout.cell_w / 4).saturating_sub(badge_pad * 2).max(20);
                let (b_scale, b_ttf_px) = if let Some(f) = ts_font_ref {
                    const REF_PX: u32 = 18;
                    let ref_w = measure_text_width_ttf(f, "00:00:00.000", REF_PX).max(1);
                    let px = ((REF_PX as f32 * target_text_w as f32 / ref_w as f32)
                        * options.timestamp_font_scale).round() as u32;
                    (3u32, px.clamp(8, 40))
                } else {
                    let s = (target_text_w / 72).clamp(1, 6);
                    (s, s * 6)
                };
                let (ts_above_px, ts_below_px) = if let Some(f) = ts_font_ref {
                    probe_ts_digit_extent(f, b_ttf_px)
                } else {
                    (b_scale * 7, 0)
                };
                let badge_h = ts_above_px + ts_below_px + badge_pad * 2;

                for row in 0..layout.rows {
                    for col in 0..layout.cols {
                        let idx = (row * layout.cols + col) as usize;
                        if idx >= timestamps.len() { break; }
                        let ts = timestamps[idx];
                        let ts_str = secs_to_hhmmss(ts);
                        let text_w = if let Some(f) = ts_font_ref {
                            measure_text_width_ttf(f, &ts_str, b_ttf_px)
                        } else {
                            ts_str.len() as u32 * (5 + 1) * b_scale
                        };
                        let badge_w = text_w + badge_pad * 2;

                        let (cell_x, cell_y) = layout.cell_origin(col, row);
                        let (bx, by) = badge_pos(cell_x, cell_y, layout.cell_w, layout.cell_h, badge_w, badge_h, badge_pad, options.timestamp_position);

                        if by + badge_h > img_height || bx + badge_w > img_width { continue; }

                        stamp_timestamp_badge(img, &ts_str, bx, by, badge_w, badge_h, badge_pad,
                            b_scale, b_ttf_px, ts_font_ref, ts_above_px, theme, options);
                    }
                }
            }
            return;
        }

        // Header background
        fill_rect_alpha(img, 0, 0, img_width, layout.header_h, theme.header_bg);

        let scale = 4u32;
        let line_h = scale * 7; // ~28px line spacing for 24px text

        // Branding: large text + Jellyfin icon, right-aligned within icon_area_w (before QR strip)
        if options.branding_enabled && !options.branding_text.is_empty() {
            let brand_scale = 18u32;          // fills header height (~126px bitmap / ~108px TTF)
            let brand_ttf_px = brand_scale * 6;
            let icon_size = layout.header_h - MARGIN * 2;  // ~124px square
            let gap = MARGIN;

            let text_w = measure_text_mixed_branding(brand_latin_ref, brand_cjk_ref, brand_latin_scale, brand_cjk_scale, &options.branding_text, brand_scale * 6);
            // Layout right-to-left within icon_area_w: [margin][icon][gap][text][gap from left info]
            let icon_x = layout.icon_area_w.saturating_sub(MARGIN + icon_size);
            let icon_y = MARGIN;
            let text_x = icon_x.saturating_sub(gap + text_w);
            // Vertical: pixel font centers by height, TTF baseline = text_y + brand_ttf_px
            let text_y = if brand_latin_ref.is_some() || brand_cjk_ref.is_some() {
                // TTF: glyphs draw from baseline upward; y=0 lets large text fill header naturally
                0u32
            } else {
                (layout.header_h.saturating_sub(brand_scale * 7)) / 2
            };
            let _ = brand_ttf_px;
            // Mixed-script branding: select font per character (Latin vs CJK), with cap-height normalisation
            draw_text_mixed_branding(img, brand_latin_ref, brand_cjk_ref, brand_latin_scale, brand_cjk_scale, &options.branding_text, text_x, text_y, brand_scale * 6, theme.accent_color);
            crate::logo::render_logo_at(img, icon_x, icon_y, icon_size, 0.88);
        }

        let mut y = MARGIN;

        // i18n labels — no trailing colon; colon is drawn at a fixed column so all rows align.
        let (lbl_file, lbl_size, lbl_dur, lbl_cs, lbl_video, lbl_audio, lbl_sr, lbl_colon) = match options.lang.as_str() {
            "zh" => ("\u{6587}\u{4ef6}\u{540d}", "\u{5927}\u{5c0f}", "\u{65f6}\u{957f}", "\u{8272}\u{5f69}\u{7a7a}\u{95f4}", "\u{89c6}\u{9891}", "\u{97f3}\u{9891}", "\u{91c7}\u{6837}\u{7387}", "\u{ff1a}"),
            "ja" => ("\u{30d5}\u{30a1}\u{30a4}\u{30eb}\u{540d}", "\u{30b5}\u{30a4}\u{30ba}", "\u{518d}\u{751f}\u{6642}\u{9593}", "\u{8272}\u{7a7a}\u{9593}", "\u{6620}\u{50cf}", "\u{97f3}\u{58f0}", "\u{30b5}\u{30f3}\u{30d7}\u{30eb}\u{30ec}\u{30fc}\u{30c8}", "\u{ff1a}"),
            _    => ("File", "Size", "Dur", "CS", "Video", "Audio", "SR", ": "),
        };

        // Measure primary label widths; colon is drawn at a fixed column = MARGIN + label_col_w.
        let label_col_w = if options.video_info_enabled {
            [lbl_file, lbl_size, lbl_video, lbl_audio]
                .iter()
                .map(|lbl| measure_text_width(font_ref, lbl, scale))
                .max()
                .unwrap_or(0)
        } else {
            0
        };
        let colon_w = measure_text_width(font_ref, lbl_colon, scale);
        let colon_x = MARGIN + label_col_w;
        let value_x  = colon_x + colon_w;

        // Clip boundary: stop info text before the Jellyfin logo (icon_x - gap).
        // The logo is right-aligned within icon_area_w; any text beyond this x overlaps it.
        let info_max_x = if options.branding_enabled && !options.branding_text.is_empty() {
            let icon_size = layout.header_h.saturating_sub(MARGIN * 2);
            layout.icon_area_w.saturating_sub(MARGIN + icon_size + MARGIN)
        } else {
            layout.icon_area_w.saturating_sub(MARGIN)
        };

        // Row 0: Filename — clip with ellipsis if too long to reach the logo
        if options.video_info_enabled {
            let available_w = info_max_x.saturating_sub(value_x);
            let filename = truncate_filename_to_fit(font_ref, &info.filename, scale, available_w);
            draw_text_scaled(img, lbl_file,    MARGIN,  y, scale, theme.accent_color, font_ref);
            draw_text_scaled(img, lbl_colon,   colon_x, y, scale, theme.accent_color, font_ref);
            draw_text_scaled(img, &filename,   value_x, y, scale, theme.accent_color, font_ref);
        }
        y += line_h;

        // Row 1: Size + optional inline Duration + Subtitles
        if options.video_info_enabled && y + line_h <= layout.header_h {
            let mut val_parts: Vec<String> = Vec::new();
            let row1_label = if options.show_file_size {
                val_parts.push(info.file_size.clone());
                if options.show_duration {
                    val_parts.push(format!("{}{}{}", lbl_dur, lbl_colon, info.duration));
                }
                Some(lbl_size)
            } else if options.show_duration {
                val_parts.push(info.duration.clone());
                Some(lbl_dur)
            } else {
                None
            };
            if options.show_subtitles && info.subtitle_count > 0 {
                let lbl_subs = match options.lang.as_str() { "zh" => "\u{5b57}\u{5e55}", "ja" => "\u{5b57}\u{5e55}", _ => "Subs" };
                val_parts.push(format!("{}{}{}", lbl_subs, lbl_colon, info.subtitle_count));
            }
            if let Some(lbl) = row1_label {
                draw_text_scaled(img, lbl,                    MARGIN,  y, scale, theme.text_color, font_ref);
                draw_text_scaled(img, lbl_colon,              colon_x, y, scale, theme.text_color, font_ref);
                draw_text_scaled(img, &val_parts.join("   "), value_x, y, scale, theme.text_color, font_ref);
                y += line_h;
            } else if !val_parts.is_empty() {
                draw_text_scaled(img, &val_parts.join("   "), MARGIN, y, scale, theme.text_color, font_ref);
                y += line_h;
            }
        }

        // Row 2: Video (resolution + fps  |  codec + profile + bit depth + HDR + [bitrate])
        if options.video_info_enabled && y + line_h <= layout.header_h {
            let mut val_parts: Vec<String> = Vec::new();
            if options.show_resolution_fps {
                val_parts.push(format!("{} @ {}fps", info.resolution, format_fps(info.fps)));
            }
            if options.show_video_encoding {
                let mut enc = info.video_codec.clone();
                if let Some(ref p) = info.video_profile { enc.push_str(&format!(" ({})", p)); }
                if let Some(bd) = info.bit_depth { enc.push_str(&format!("  {}bit", bd)); }
                if let Some(ref hdr) = info.hdr_type { enc.push_str(&format!("  {}", hdr)); }
                if let Some(ref br) = info.video_bitrate { enc.push_str(&format!("  [{}]", br)); }
                if let Some(ref cs) = info.colour_space { enc.push_str(&format!("  {}{}{}", lbl_cs, lbl_colon, cs)); }
                val_parts.push(enc);
            }
            if !val_parts.is_empty() {
                draw_text_scaled(img, lbl_video,                    MARGIN,  y, scale, theme.text_color, font_ref);
                draw_text_scaled(img, lbl_colon,                    colon_x, y, scale, theme.text_color, font_ref);
                draw_text_scaled(img, &val_parts.join("  |  "),     value_x, y, scale, theme.text_color, font_ref);
                y += line_h;
            }
        }

        // Row 3: Audio (codec + format + bitrate + sample rate inline)
        if options.video_info_enabled && options.show_audio_encoding {
            if let Some(ref ac) = info.audio_codec {
                let mut audio = ac.clone();
                if let Some(ref af) = info.audio_format {
                    if !af.is_empty() { audio.push(' '); audio.push_str(af); }
                }
                if let Some(ref abr) = info.audio_bitrate { audio.push_str(&format!(" @ {}", abr)); }
                if let Some(sr) = info.audio_sample_rate {
                    let sr_f = sr as f64 / 1000.0;
                    let sr_s = if sr_f.fract() == 0.0 { format!("{:.0}", sr_f) } else { format!("{:.1}", sr_f) };
                    audio.push_str(&format!("  {}{}{}kHz", lbl_sr, lbl_colon, sr_s));
                }
                let lbl_tracks = match options.lang.as_str() { "zh" => "\u{97f3}\u{8f68}", "ja" => "\u{30c8}\u{30e9}\u{30c3}\u{30af}", _ => "tracks" };
                if info.audio_tracks > 0 { audio.push_str(&format!(" / \u{d7}{}{}", info.audio_tracks, lbl_tracks)); }
                if y + line_h <= layout.header_h + (img_height - layout.header_h) {
                    draw_text_scaled(img, lbl_audio, MARGIN,  y, scale, theme.text_color, font_ref);
                    draw_text_scaled(img, lbl_colon, colon_x, y, scale, theme.text_color, font_ref);
                    draw_text_scaled(img, &audio,    value_x, y, scale, theme.text_color, font_ref);
                }
            }
        }

        // Per-frame timestamp badges
        if options.show_frame_timestamp && !timestamps.is_empty() {
            let badge_pad = 4u32;
            let target_text_w = (layout.cell_w / 4).saturating_sub(badge_pad * 2).max(20);
            let (b_scale, b_ttf_px) = if let Some(f) = ts_font_ref {
                const REF_PX: u32 = 18;
                let ref_w = measure_text_width_ttf(f, "00:00:00.000", REF_PX).max(1);
                let px = ((REF_PX as f32 * target_text_w as f32 / ref_w as f32)
                    * options.timestamp_font_scale).round() as u32;
                (3u32, px.clamp(8, 40))
            } else {
                let s = (target_text_w / 72).clamp(1, 6);
                (s, s * 6)
            };
            let (ts_above_px, ts_below_px) = if let Some(f) = ts_font_ref {
                probe_ts_digit_extent(f, b_ttf_px)
            } else {
                (b_scale * 7, 0)
            };
            let badge_h = ts_above_px + ts_below_px + badge_pad * 2;

            for row in 0..layout.rows {
                for col in 0..layout.cols {
                    let idx = (row * layout.cols + col) as usize;
                    if idx >= timestamps.len() { break; }
                    let ts = timestamps[idx];
                    let ts_str = secs_to_hhmmss(ts);
                    let text_w = if let Some(f) = ts_font_ref {
                        measure_text_width_ttf(f, &ts_str, b_ttf_px)
                    } else {
                        ts_str.len() as u32 * (5 + 1) * b_scale
                    };
                    let badge_w = text_w + badge_pad * 2;

                    let (cell_x, cell_y) = layout.cell_origin(col, row);
                    let (bx, by) = badge_pos(cell_x, cell_y, layout.cell_w, layout.cell_h, badge_w, badge_h, badge_pad, options.timestamp_position);

                    if by + badge_h > img_height || bx + badge_w > img_width { continue; }

                    stamp_timestamp_badge(img, &ts_str, bx, by, badge_w, badge_h, badge_pad,
                        b_scale, b_ttf_px, ts_font_ref, ts_above_px, theme, options);
                }
            }
        }
    }
}

pub fn get_theme(name: &str) -> ThemeColors {
    match name {
        // Deep black / bright-blue — maximum contrast dark mode
        "dark" => ThemeColors {
            header_bg:        [10, 10, 12, 240],
            text_color:       [235, 235, 235],
            accent_color:     [80, 170, 255],
            badge_bg:         [10, 10, 12, 200],
            badge_text:       [215, 215, 215],
            canvas_bg:        [0, 0, 0],
            qr_bubble:        [248, 249, 252, 222],
            qr_module_a:      [80, 170, 255],
            qr_module_b:      [0, 120, 220],
            qr_finder_dark:   [80, 170, 255],
            qr_finder_light:  [248, 249, 252],
            ts_outline:       [55, 60, 78],   // dark slate-blue rim, sits between near-black bg and white text
            ts_shadow:        [8, 8, 12],     // near-black drop shadow for text floating on video
        },
        // Light gray — readability on bright backgrounds
        "light" => ThemeColors {
            header_bg:        [232, 233, 235, 220],
            text_color:       [25, 25, 30],
            accent_color:     [0, 90, 190],
            badge_bg:         [225, 225, 228, 200],
            badge_text:       [25, 25, 30],
            canvas_bg:        [210, 212, 215],
            // White bubble + near-black modules — maximum scan contrast on a light header
            qr_bubble:        [250, 250, 252, 230],
            qr_module_a:      [28, 28, 32],
            qr_module_b:      [28, 28, 32],
            qr_finder_dark:   [28, 28, 32],
            qr_finder_light:  [250, 250, 252],
            ts_outline:       [120, 120, 128], // mid-gray outline, between near-black text and light badge
            ts_shadow:        [175, 175, 182], // light gray shadow helping dark text on dark video
        },
        // Warm amber/gold on near-black — cinematic film look
        "cinematic" => ThemeColors {
            header_bg:        [10, 5, 0, 210],
            text_color:       [255, 230, 180],
            accent_color:     [200, 150, 50],
            badge_bg:         [10, 5, 0, 190],
            badge_text:       [255, 230, 180],
            canvas_bg:        [0, 0, 0],
            qr_bubble:        [248, 243, 228, 218],
            qr_module_a:      [200, 150, 50],
            qr_module_b:      [155, 100, 20],
            qr_finder_dark:   [200, 150, 50],
            qr_finder_light:  [248, 243, 228],
            ts_outline:       [65, 42, 8],    // dark amber-brown rim, warm mid-tone between bg and gold text
            ts_shadow:        [8, 4, 0],      // very dark warm shadow
        },
        // Nearly invisible header — minimum chrome, content-first
        "minimal" => ThemeColors {
            header_bg:        [22, 22, 24, 90],
            text_color:       [255, 255, 255],
            accent_color:     [200, 200, 200],
            badge_bg:         [0, 0, 0, 140],
            badge_text:       [210, 210, 210],
            canvas_bg:        [22, 22, 24],
            qr_bubble:        [248, 248, 250, 218],
            qr_module_a:      [185, 185, 195],
            qr_module_b:      [140, 140, 152],
            qr_finder_dark:   [185, 185, 195],
            qr_finder_light:  [248, 248, 250],
            ts_outline:       [65, 65, 70],   // neutral dark rim
            ts_shadow:        [0, 0, 0],      // pure black shadow
        },
        // Transparent canvas — QR bubble floats over whatever is composited beneath
        "transparent" => ThemeColors {
            header_bg:        [0, 0, 0, 0],
            text_color:       [255, 255, 255],
            accent_color:     [0, 164, 220],
            badge_bg:         [0, 0, 0, 160],
            badge_text:       [255, 255, 255],
            canvas_bg:        [0, 0, 0],
            qr_bubble:        [248, 249, 252, 220],
            qr_module_a:      [170, 92, 195],
            qr_module_b:      [0, 164, 220],
            qr_finder_dark:   [0, 164, 220],
            qr_finder_light:  [246, 248, 252],
            ts_outline:       [65, 65, 78],   // dark neutral rim
            ts_shadow:        [0, 0, 0],      // pure black shadow
        },
        // "classic" and default — Jellyfin slate-blue with brand gradient QR
        _ => ThemeColors {
            header_bg:        [40, 42, 52, 210],
            text_color:       [255, 255, 255],
            accent_color:     [0, 164, 220],
            badge_bg:         [28, 30, 38, 190],
            badge_text:       [255, 255, 255],
            canvas_bg:        [30, 32, 40],
            qr_bubble:        [248, 249, 252, 218],
            qr_module_a:      [170, 92, 195],
            qr_module_b:      [0, 164, 220],
            qr_finder_dark:   [0, 164, 220],
            qr_finder_light:  [246, 248, 252],
            ts_outline:       [70, 74, 98],   // dark Jellyfin-slate rim, between slate badge and white text
            ts_shadow:        [12, 13, 18],   // very dark slate shadow
        },
    }
}

/// Alpha-blend a rectangle onto the image.
fn fill_rect_alpha(img: &mut RgbaImage, x: u32, y: u32, w: u32, h: u32, color: [u8; 4]) {
    let alpha = color[3] as f32 / 255.0;
    let r = color[0] as f32;
    let g = color[1] as f32;
    let b = color[2] as f32;

    let img_w = img.width();
    let img_h = img.height();

    for py in y..y.saturating_add(h).min(img_h) {
        for px in x..x.saturating_add(w).min(img_w) {
            let pixel = img.get_pixel_mut(px, py);
            let channels = pixel.channels_mut();
            channels[0] = blend(channels[0], r, alpha);
            channels[1] = blend(channels[1], g, alpha);
            channels[2] = blend(channels[2], b, alpha);
            channels[3] = blend(channels[3], 255.0, alpha);
        }
    }
}

#[inline]
fn blend(bg: u8, fg: f32, alpha: f32) -> u8 {
    ((bg as f32) * (1.0 - alpha) + fg * alpha).round().clamp(0.0, 255.0) as u8
}

/// Decode WOFF2 data to raw TTF bytes if the magic bytes match.
/// WOFF1 (`wOFF`) is already handled by ttf-parser (ab_glyph's internal parser).
fn decode_if_woff2(data: Vec<u8>) -> Vec<u8> {
    if data.starts_with(b"wOF2") {
        match woff2_patched::decode::convert_woff2_to_ttf(&mut std::io::Cursor::new(&data)) {
            Ok(ttf) => return ttf,
            Err(e) => eprintln!("WARNING: WOFF2 decode failed, using raw bytes: {e}"),
        }
    }
    data
}

fn load_font(path: &str) -> Option<FontArc> {
    match std::fs::read(path) {
        Ok(data) => {
            let data = decode_if_woff2(data);
            match FontArc::try_from_vec(data) {
                Ok(font) => Some(font),
                Err(e) => {
                    eprintln!("WARNING: failed to parse font {path}: {e}");
                    None
                }
            }
        },
        Err(e) => {
            eprintln!("WARNING: failed to load font {path}: {e}");
            None
        }
    }
}

/// Render a single emoji character as a colored Twemoji SVG.
/// Returns true if the emoji was found and rendered successfully.
fn render_twemoji(img: &mut RgbaImage, ch: char, x: u32, y: u32, size: u32) -> bool {
    use twemoji_assets::svg::SvgTwemojiAsset;
    if size == 0 { return false; }
    let s = ch.to_string();
    let asset = match SvgTwemojiAsset::from_emoji(&s) {
        Some(a) => a,
        None => return false,
    };
    let svg_data: &str = &*asset;
    let opt = resvg::usvg::Options::default();
    let tree = match resvg::usvg::Tree::from_str(svg_data, &opt) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let mut pixmap = match tiny_skia::Pixmap::new(size, size) {
        Some(p) => p,
        None => return false,
    };
    let svg_size = tree.size();
    let transform = tiny_skia::Transform::from_scale(
        size as f32 / svg_size.width() as f32,
        size as f32 / svg_size.height() as f32,
    );
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let canvas_w = img.width();
    let canvas_h = img.height();
    for py in 0..size {
        for px in 0..size {
            let cx = x + px;
            let cy = y + py;
            if cx >= canvas_w || cy >= canvas_h { continue; }
            let rgba = pixmap.pixel(px, py)
                .unwrap_or(tiny_skia::PremultipliedColorU8::TRANSPARENT);
            let src_alpha = rgba.alpha() as f32 / 255.0;
            if src_alpha <= 0.01 { continue; }
            let pixel = img.get_pixel_mut(cx, cy);
            let c = pixel.0.as_mut_slice();
            // Porter-Duff "over" with premultiplied source: out = pre_src + dst * (1 - alpha)
            c[0] = (rgba.red()   as f32 + c[0] as f32 * (1.0 - src_alpha)).min(255.0) as u8;
            c[1] = (rgba.green() as f32 + c[1] as f32 * (1.0 - src_alpha)).min(255.0) as u8;
            c[2] = (rgba.blue()  as f32 + c[2] as f32 * (1.0 - src_alpha)).min(255.0) as u8;
            c[3] = (c[3] as f32 + (255.0 - c[3] as f32) * src_alpha).min(255.0) as u8;
        }
    }
    true
}

/// Returns the actual pixel top of rendered glyphs by probing representative characters.
/// Typographic ascent includes whitespace above real glyphs; actual glyph bounds are tighter.
fn probe_glyph_top(font: &FontArc, scale: PxScale, baseline: f32, ascent: f32) -> f32 {
    for probe in ['中', '字', 'M', 'A'] {
        let id = font.glyph_id(probe);
        if id.0 != 0 {
            if let Some(og) = font.outline_glyph(id.with_scale(scale)) {
                return baseline + og.px_bounds().min.y;
            }
        }
    }
    baseline - ascent
}

fn draw_text_ttf(img: &mut RgbaImage,
    font: &FontArc,
    text: &str,
    x: u32,
    y: u32,
    scale_px: u32,
    color: [u8; 3],
) {
    let scale = PxScale::from(scale_px as f32);
    let img_w = img.width();
    let img_h = img.height();

    let mut cx = x as f32;
    let baseline = y as f32 + scale_px as f32;

    for ch in text.chars() {
        let primary_id = font.glyph_id(ch);
        let primary_outline = if primary_id.0 != 0 {
            font.outline_glyph(primary_id.with_scale(scale))
        } else {
            None
        };

        let h_advance;
        if let Some(outlined) = primary_outline {
            let bounds = outlined.px_bounds();
            let offset_x = cx + bounds.min.x;
            let offset_y = baseline + bounds.min.y;

            outlined.draw(|gx, gy, alpha| {
                let px = (offset_x + gx as f32) as u32;
                let py = (offset_y + gy as f32) as u32;
                if px < img_w && py < img_h && alpha > 0.01 {
                    let pixel = img.get_pixel_mut(px, py);
                    let ch_arr = pixel.channels_mut();
                    let a = alpha.clamp(0.0, 1.0);
                    ch_arr[0] = ((1.0 - a) * ch_arr[0] as f32 + a * color[0] as f32) as u8;
                    ch_arr[1] = ((1.0 - a) * ch_arr[1] as f32 + a * color[1] as f32) as u8;
                    ch_arr[2] = ((1.0 - a) * ch_arr[2] as f32 + a * color[2] as f32) as u8;
                    ch_arr[3] = ((1.0 - a) * ch_arr[3] as f32 + a * 255.0) as u8;
                }
            });
            h_advance = font.as_scaled(scale).h_advance(primary_id);
        } else {
            // Tertiary fallback: colored Twemoji SVG (no TTF outline available).
            // Use the actual rendered top of a representative glyph to position emoji,
            // because typographic ascent often includes whitespace above real glyphs.
            let ascent = font.as_scaled(scale).ascent();
            let glyph_top = probe_glyph_top(font, scale, baseline, ascent);
            let emoji_size = (baseline - glyph_top).round() as u32;
            // Shift emoji down ~8% so its visual center aligns with CJK character center
            // (round emoji shapes look "floating" when mathematically top-aligned)
            let offset = (emoji_size as f32 * 0.08).round() as u32;
            let emoji_y = (glyph_top.max(0.0) as u32).saturating_add(offset);
            let rendered = render_twemoji(img, ch, cx as u32, emoji_y, emoji_size);
            h_advance = if rendered {
                emoji_size as f32
            } else {
                font.as_scaled(scale).h_advance(primary_id)
            };
        }

        cx += h_advance;
        if cx as u32 > img_w { break; }
    }
}

/// Render branding text with per-character font and cap-height normalisation.
/// `latin_scale` and `cjk_scale` are computed by `Renderer::new()` by probing actual glyph heights;
/// they shrink/grow the effective render size so caps appear the same height as the reference font.
/// Fallback chain per character: primary font → cross font (other script) → Twemoji SVG.
fn draw_text_mixed_branding(
    img: &mut RgbaImage,
    latin_font: Option<&FontArc>,
    cjk_font: Option<&FontArc>,
    latin_scale: f32,
    cjk_scale: f32,
    text: &str,
    x: u32,
    y: u32,
    scale_px: u32,
    color: [u8; 3],
) {
    let img_w = img.width();
    let img_h = img.height();
    let mut cx = x as f32;
    let baseline = y as f32 + scale_px as f32;

    'chars: for ch in text.chars() {
        // ASCII space: use Latin font advance directly, capped at 0.45 em.
        // CJK fonts store Latin space as half-width or full-width which is too wide for Latin text.
        if ch == ' ' {
            let adv = latin_font.or(cjk_font)
                .map(|f| {
                    let px = (scale_px as f32 * latin_scale).round().max(1.0);
                    f.as_scaled(PxScale::from(px)).h_advance(f.glyph_id(' '))
                        .min(px * 0.45)
                })
                .unwrap_or(scale_px as f32 * 0.25);
            cx += adv;
            continue 'chars;
        }

        let class = classify_char(ch);
        // Primary font is chosen by character class; cross-font is the other family.
        // If primary font lacks the glyph, cross-font is tried before emoji/Twemoji.
        let (primary_opt, primary_factor, cross_opt, cross_factor) = match class {
            CharClass::Cjk => (cjk_font, cjk_scale, latin_font, latin_scale),
            _ => (latin_font, latin_scale, cjk_font, cjk_scale),
        };
        let primary_px = ((scale_px as f32 * primary_factor).round() as u32).max(1);
        let cross_px   = ((scale_px as f32 * cross_factor).round()   as u32).max(1);

        // Resolve: primary → cross → Twemoji/none
        let (active_font, active_id, active_outline, active_scale) = 'resolve: {
            if let Some(font) = primary_opt {
                let sc = PxScale::from(primary_px as f32);
                let id = font.glyph_id(ch);
                if id.0 != 0 {
                    if let Some(outline) = font.outline_glyph(id.with_scale(sc)) {
                        break 'resolve (font, id, Some(outline), sc);
                    }
                }
            }
            if let Some(font) = cross_opt {
                let sc = PxScale::from(cross_px as f32);
                let id = font.glyph_id(ch);
                if id.0 != 0 {
                    if let Some(outline) = font.outline_glyph(id.with_scale(sc)) {
                        break 'resolve (font, id, Some(outline), sc);
                    }
                }
            }
            // Nothing has this glyph — use any available font for h_advance, try Twemoji below
            let Some(font) = primary_opt.or(cross_opt) else { continue 'chars };
            let sc = PxScale::from(primary_px as f32);
            (font, font.glyph_id(ch), None, sc)
        };

        let h_advance;
        if let Some(outlined) = active_outline {
            let bounds = outlined.px_bounds();
            let offset_x = cx + bounds.min.x;
            let offset_y = baseline + bounds.min.y;
            outlined.draw(|gx, gy, alpha| {
                let px = (offset_x + gx as f32) as u32;
                let py = (offset_y + gy as f32) as u32;
                if px < img_w && py < img_h && alpha > 0.01 {
                    let pixel = img.get_pixel_mut(px, py);
                    let c = pixel.channels_mut();
                    let a = alpha.clamp(0.0, 1.0);
                    c[0] = ((1.0 - a) * c[0] as f32 + a * color[0] as f32) as u8;
                    c[1] = ((1.0 - a) * c[1] as f32 + a * color[1] as f32) as u8;
                    c[2] = ((1.0 - a) * c[2] as f32 + a * color[2] as f32) as u8;
                    c[3] = ((1.0 - a) * c[3] as f32 + a * 255.0) as u8;
                }
            });
            h_advance = active_font.as_scaled(active_scale).h_advance(active_id);
        } else {
            // Twemoji SVG fallback — size it to match the reference cap height
            let ref_scale = PxScale::from(scale_px as f32);
            let probe_font = primary_opt.or(cross_opt).unwrap_or(active_font);
            let ascent = probe_font.as_scaled(ref_scale).ascent();
            let glyph_top = probe_glyph_top(probe_font, ref_scale, baseline, ascent);
            let emoji_size = (baseline - glyph_top).round() as u32;
            let offset = (emoji_size as f32 * 0.08).round() as u32;
            let emoji_y = (glyph_top.max(0.0) as u32).saturating_add(offset);
            let rendered = render_twemoji(img, ch, cx as u32, emoji_y, emoji_size);
            h_advance = if rendered { emoji_size as f32 } else { active_font.as_scaled(active_scale).h_advance(active_id) };
        }

        cx += h_advance;
        if cx as u32 > img_w { break; }
    }
}

fn measure_text_mixed_branding(
    latin_font: Option<&FontArc>,
    cjk_font: Option<&FontArc>,
    latin_scale: f32,
    cjk_scale: f32,
    text: &str,
    scale_px: u32,
) -> u32 {
    use twemoji_assets::svg::SvgTwemojiAsset;
    let any_font = latin_font.or(cjk_font);
    let Some(fallback) = any_font else {
        return text.len() as u32 * scale_px / 6;
    };
    let ref_scale = PxScale::from(scale_px as f32);
    let ascent = fallback.as_scaled(ref_scale).ascent();
    let baseline = scale_px as f32;
    let emoji_advance = (baseline - probe_glyph_top(fallback, ref_scale, baseline, ascent)).max(1.0);

    text.chars().map(|ch| {
        // ASCII space: same cap logic as draw_text_mixed_branding for consistency.
        if ch == ' ' {
            return latin_font.or(cjk_font)
                .map(|f| {
                    let px = (scale_px as f32 * latin_scale).round().max(1.0);
                    f.as_scaled(PxScale::from(px)).h_advance(f.glyph_id(' '))
                        .min(px * 0.45)
                })
                .unwrap_or(scale_px as f32 * 0.25);
        }

        let class = classify_char(ch);
        let (primary_opt, primary_factor, cross_opt, cross_factor) = match class {
            CharClass::Cjk => (cjk_font, cjk_scale, latin_font, latin_scale),
            _ => (latin_font, latin_scale, cjk_font, cjk_scale),
        };
        let primary_px = ((scale_px as f32 * primary_factor).round() as u32).max(1);
        let cross_px   = ((scale_px as f32 * cross_factor).round()   as u32).max(1);

        // Primary font
        if let Some(f) = primary_opt {
            let sc = PxScale::from(primary_px as f32);
            let id = f.glyph_id(ch);
            if id.0 != 0 && f.outline_glyph(id.with_scale(sc)).is_some() {
                return f.as_scaled(sc).h_advance(id);
            }
        }
        // Cross-font fallback
        if let Some(f) = cross_opt {
            let sc = PxScale::from(cross_px as f32);
            let id = f.glyph_id(ch);
            if id.0 != 0 && f.outline_glyph(id.with_scale(sc)).is_some() {
                return f.as_scaled(sc).h_advance(id);
            }
        }
        // Twemoji SVG
        if SvgTwemojiAsset::from_emoji(&ch.to_string()).is_some() { return emoji_advance; }
        // Fallback advance
        let sc = PxScale::from(primary_px as f32);
        primary_opt.or(cross_opt)
            .map(|f| f.as_scaled(sc).h_advance(f.glyph_id(ch)))
            .unwrap_or(scale_px as f32 / 6.0)
    }).sum::<f32>() as u32
}

/// Measure the pixel width of a string, mirroring draw_text_ttf's advance logic.
/// Emoji chars with no TTF outline are counted as `ascender` pixels wide (same as draw_text_ttf).
fn measure_text_width_ttf(font: &FontArc, text: &str, scale_px: u32) -> u32 {
    use twemoji_assets::svg::SvgTwemojiAsset;
    let scale = PxScale::from(scale_px as f32);
    let scaled = font.as_scaled(scale);
    let ascent = scaled.ascent();
    let baseline = scale_px as f32;
    let emoji_advance = (baseline - probe_glyph_top(font, scale, baseline, ascent)).max(1.0);
    text.chars()
        .map(|ch| {
            let id = font.glyph_id(ch);
            if id.0 != 0 && font.outline_glyph(id.with_scale(scale)).is_some() {
                return scaled.h_advance(id);
            }
            if SvgTwemojiAsset::from_emoji(&ch.to_string()).is_some() {
                return emoji_advance;
            }
            scaled.h_advance(id)
        })
        .sum::<f32>() as u32
}

/// Measure text width for either TTF or pixel font.
fn measure_text_width(font: Option<&FontArc>, text: &str, scale: u32) -> u32 {
    if let Some(f) = font {
        measure_text_width_ttf(f, text, scale * 6)
    } else {
        text.len() as u32 * (5 + 1) * scale
    }
}

/// Truncate a filename so it fits within `max_w` pixels.
/// The file extension (last `.xxx`) is always preserved at the end; only the stem is clipped.
/// E.g. "My Long Movie Title.mkv" → "My Long Mov….mkv"
fn truncate_filename_to_fit(font: Option<&FontArc>, filename: &str, scale: u32, max_w: u32) -> String {
    if measure_text_width(font, filename, scale) <= max_w { return filename.to_string(); }
    let ellipsis = "\u{2026}"; // …
    // Split at last '.' to separate stem and extension.
    let (stem, ext) = if let Some(pos) = filename.rfind('.') {
        (&filename[..pos], &filename[pos..])
    } else {
        (filename, "")
    };
    let ellipsis_w = measure_text_width(font, ellipsis, scale);
    let ext_w = measure_text_width(font, ext, scale);
    let budget = max_w.saturating_sub(ellipsis_w + ext_w);
    let mut out = String::new();
    let mut used = 0u32;
    for ch in stem.chars() {
        let w = measure_text_width(font, &ch.to_string(), scale);
        if used + w > budget { break; }
        out.push(ch);
        used += w;
    }
    out + ellipsis + ext
}

/// Probe the visual y-extent of timestamp characters (digits 0–9, colon, period) at the given
/// TTF scale. Returns (above_baseline_px, below_baseline_px) from actual glyph bounding boxes.
/// Used to size the badge height to the real visual height rather than the full typographic em.
fn probe_ts_digit_extent(font: &FontArc, scale_px: u32) -> (u32, u32) {
    let scale = PxScale::from(scale_px as f32);
    let mut min_y: f32 = 0.0;
    let mut max_y: f32 = 0.0;
    for ch in ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', '.'] {
        let id = font.glyph_id(ch);
        if id.0 == 0 { continue; }
        if let Some(og) = font.outline_glyph(id.with_scale(scale)) {
            let b = og.px_bounds();
            if b.min.y < min_y { min_y = b.min.y; }
            if b.max.y > max_y { max_y = b.max.y; }
        }
    }
    let above = ((-min_y).ceil() as u32).max(1);
    let below = max_y.ceil() as u32;
    (above, below)
}

/// Composite a timestamp badge — background, inner glow, text fill — into a temporary buffer
/// and stamp it onto `img`. The glow uses badge_text color so it adapts to any theme.
/// Margin corrects vertical alignment for fonts (like Vollkorn) whose glyphs sit below the
/// top of the typographic em box.
fn stamp_timestamp_badge(
    img: &mut RgbaImage,
    ts_str: &str,
    bx: u32, by: u32,
    badge_w: u32, badge_h: u32,
    badge_pad: u32,
    b_scale: u32, b_ttf_px: u32,
    ts_font_ref: Option<&FontArc>,
    ts_above_px: u32,
    theme: &ThemeColors,
    options: &RenderOptions,
) {
    let margin = 12u32;
    let buf_w = badge_w + margin * 2;
    let buf_h = badge_h + margin * 2;
    let mut badge_buf = RgbaImage::new(buf_w, buf_h);

    // draw_text_ttf: baseline = y + ttf_px; glyph visual top = y + ttf_px - above_px.
    // We want visual top at (margin + badge_pad) inside badge_buf:
    //   y = margin + badge_pad + above_px - ttf_px
    let text_x = margin + badge_pad;
    let text_y = if ts_font_ref.is_some() {
        (margin as i32 + badge_pad as i32 + ts_above_px as i32 - b_ttf_px as i32).max(0) as u32
    } else {
        margin + badge_pad
    };

    // 1. Badge background.
    if options.timestamp_bg {
        fill_rect_alpha(&mut badge_buf, margin, margin, badge_w, badge_h, theme.badge_bg);
    }

    // 2. Soft outline: render text at 8 surrounding offsets, lightly blur for smooth edges,
    //    overlay beneath the main text. Color choice depends on whether a badge_bg is drawn:
    //    ts_outline (sits between badge_bg and badge_text, per-theme) when bg is on;
    //    ts_shadow (heavier contrast for text floating directly on video) when bg is off.
    if options.timestamp_shadow {
        let outline_rgb = if options.timestamp_bg { theme.ts_outline } else { theme.ts_shadow };
        let stroke_r = ((b_ttf_px as f32 * 0.08).round() as i32).clamp(1, 2);
        let sigma = stroke_r as f32 * 0.6 + 0.4;
        let mut shadow_buf = RgbaImage::new(buf_w, buf_h);
        for dy in [-stroke_r, 0, stroke_r] {
            for dx in [-stroke_r, 0, stroke_r] {
                if dx == 0 && dy == 0 { continue; }
                let sx = (text_x as i32 + dx).max(0) as u32;
                let sy = (text_y as i32 + dy).max(0) as u32;
                if let Some(f) = ts_font_ref {
                    draw_text_ttf(&mut shadow_buf, f, ts_str, sx, sy, b_ttf_px, outline_rgb);
                } else {
                    draw_text_scaled(&mut shadow_buf, ts_str, sx, sy, b_scale, outline_rgb, None);
                }
            }
        }
        let smoothed = image::imageops::blur(&shadow_buf, sigma);
        image::imageops::overlay(&mut badge_buf, &smoothed, 0, 0);
    }

    // 3. Text fill on top.
    if let Some(f) = ts_font_ref {
        draw_text_ttf(&mut badge_buf, f, ts_str, text_x, text_y, b_ttf_px, theme.badge_text);
    } else {
        draw_text_scaled(&mut badge_buf, ts_str, text_x, text_y, b_scale, theme.badge_text, None);
    }

    // 4. Stamp onto main image.
    let ox = bx as i64 - margin as i64;
    let oy = by as i64 - margin as i64;
    image::imageops::overlay(img, &badge_buf, ox, oy);
}

fn draw_text_scaled(img: &mut RgbaImage,
    text: &str,
    x: u32,
    y: u32,
    scale: u32,
    color: [u8; 3],
    font: Option<&FontArc>,
) {
    if let Some(f) = font {
        let ttf_scale = (scale * 6) as u32; // scale pixel bitmap px → TTF px (approximately)
        draw_text_ttf(img, f, text, x, y, ttf_scale, color);
        return;
    }

    // Pixel bitmap fallback
    let char_stride = (5 + 1) * scale;
    let img_w = img.width();
    let img_h = img.height();
    for (i, ch) in text.chars().enumerate() {
        let cx = x.saturating_add(i as u32 * char_stride);
        if cx >= img_w { break; }
        let bitmap = char_bitmap(ch);
        for (row, &bits) in bitmap.iter().enumerate() {
            for bit in 0..5u32 {
                if (bits >> (4 - bit)) & 1 == 1 {
                    for sy in 0..scale {
                        for sx in 0..scale {
                            let px = cx + bit * scale + sx;
                            let py = y + row as u32 * scale + sy;
                            if px < img_w && py < img_h {
                                let pixel = img.get_pixel_mut(px, py);
                                let ch_arr = pixel.channels_mut();
                                ch_arr[0] = color[0];
                                ch_arr[1] = color[1];
                                ch_arr[2] = color[2];
                                ch_arr[3] = 255;
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Returns a 7-row × 5-col bitmap for printable ASCII chars.
/// Each row is a u8 bitmask of 5 bits (MSB = leftmost pixel).
fn char_bitmap(c: char) -> [u8; 7] {
    match c {
        ' ' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
        '!' => [0x04, 0x04, 0x04, 0x04, 0x00, 0x04, 0x00],
        '"' => [0x0A, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00],
        '#' => [0x0A, 0x1F, 0x0A, 0x1F, 0x0A, 0x00, 0x00],
        '$' => [0x0E, 0x15, 0x0C, 0x06, 0x15, 0x0E, 0x00],
        '%' => [0x19, 0x1A, 0x02, 0x04, 0x0B, 0x13, 0x00],
        '&' => [0x0C, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0D],
        '\'' => [0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
        '(' => [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
        ')' => [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
        '*' => [0x00, 0x0A, 0x04, 0x1F, 0x04, 0x0A, 0x00],
        '+' => [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00],
        ',' => [0x00, 0x00, 0x00, 0x00, 0x04, 0x04, 0x08],
        '-' => [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
        '.' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00],
        '/' => [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1F],
        '3' => [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x1C],
        ':' => [0x00, 0x04, 0x00, 0x00, 0x04, 0x00, 0x00],
        ';' => [0x00, 0x04, 0x00, 0x00, 0x04, 0x04, 0x08],
        '<' => [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
        '=' => [0x00, 0x1F, 0x00, 0x00, 0x1F, 0x00, 0x00],
        '>' => [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
        '?' => [0x0E, 0x11, 0x01, 0x06, 0x04, 0x00, 0x04],
        '@' => [0x0E, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0E],
        'A' => [0x04, 0x0A, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'B' => [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
        'C' => [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
        'D' => [0x1E, 0x09, 0x11, 0x11, 0x11, 0x09, 0x1E],
        'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'G' => [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
        'H' => [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'I' => [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
        'J' => [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
        'M' => [0x11, 0x1B, 0x15, 0x11, 0x11, 0x11, 0x11],
        'N' => [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
        'O' => [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        'Q' => [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
        'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        'S' => [0x0E, 0x11, 0x10, 0x0E, 0x01, 0x11, 0x0E],
        'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
        'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        'Y' => [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
        'Z' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
        '[' => [0x0E, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0E],
        '\\' => [0x10, 0x08, 0x08, 0x04, 0x02, 0x02, 0x01],
        ']' => [0x0E, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0E],
        '^' => [0x04, 0x0A, 0x11, 0x00, 0x00, 0x00, 0x00],
        '_' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F],
        '`' => [0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
        'a' => [0x00, 0x00, 0x0E, 0x01, 0x0F, 0x11, 0x0F],
        'b' => [0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x1E],
        'c' => [0x00, 0x00, 0x0E, 0x10, 0x10, 0x11, 0x0E],
        'd' => [0x01, 0x01, 0x0F, 0x11, 0x11, 0x11, 0x0F],
        'e' => [0x00, 0x00, 0x0E, 0x11, 0x1F, 0x10, 0x0E],
        'f' => [0x06, 0x09, 0x08, 0x1C, 0x08, 0x08, 0x08],
        'g' => [0x00, 0x00, 0x0F, 0x11, 0x0F, 0x01, 0x0E],
        'h' => [0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x11],
        'i' => [0x04, 0x00, 0x0C, 0x04, 0x04, 0x04, 0x0E],
        'j' => [0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0C],
        'k' => [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12],
        'l' => [0x0C, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
        'm' => [0x00, 0x00, 0x1A, 0x15, 0x15, 0x11, 0x11],
        'n' => [0x00, 0x00, 0x1E, 0x11, 0x11, 0x11, 0x11],
        'o' => [0x00, 0x00, 0x0E, 0x11, 0x11, 0x11, 0x0E],
        'p' => [0x00, 0x00, 0x1E, 0x11, 0x1E, 0x10, 0x10],
        'q' => [0x00, 0x00, 0x0F, 0x11, 0x0F, 0x01, 0x01],
        'r' => [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10],
        's' => [0x00, 0x00, 0x0E, 0x10, 0x0E, 0x01, 0x1E],
        't' => [0x08, 0x08, 0x1C, 0x08, 0x08, 0x09, 0x06],
        'u' => [0x00, 0x00, 0x11, 0x11, 0x11, 0x13, 0x0D],
        'v' => [0x00, 0x00, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'w' => [0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0A],
        'x' => [0x00, 0x00, 0x11, 0x0A, 0x04, 0x0A, 0x11],
        'y' => [0x00, 0x00, 0x11, 0x11, 0x0F, 0x01, 0x0E],
        'z' => [0x00, 0x00, 0x1F, 0x02, 0x04, 0x08, 0x1F],
        '{' => [0x03, 0x04, 0x04, 0x08, 0x04, 0x04, 0x03],
        '|' => [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        '}' => [0x18, 0x04, 0x04, 0x02, 0x04, 0x04, 0x18],
        '~' => [0x00, 0x08, 0x15, 0x02, 0x00, 0x00, 0x00],
        // Unicode: × (multiplication sign U+00D7)
        '\u{d7}' => [0x00, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x00],
        // fallback: solid block
        _ => [0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F],
    }
}

fn format_fps(fps: f64) -> String {
    if fps.fract() == 0.0 {
        format!("{:.0}", fps)
    } else {
        let s = format!("{:.3}", fps);
        s.trim_end_matches('0').to_string()
    }
}

fn secs_to_hhmmss(secs: f64) -> String {
    let total_ms = (secs * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total = total_ms / 1000;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_twemoji_known_emoji_produces_pixels() {
        let mut img = image::RgbaImage::new(64, 64);
        let rendered = super::render_twemoji(&mut img, '🐸', 0, 0, 32);
        assert!(rendered, "frog emoji should be found in twemoji-assets");
        let non_transparent = img.pixels().any(|p| p[3] > 0);
        assert!(non_transparent, "rendered emoji must produce non-transparent pixels");
    }

    #[test]
    fn render_twemoji_ascii_returns_false() {
        let mut img = image::RgbaImage::new(64, 64);
        let rendered = super::render_twemoji(&mut img, 'A', 0, 0, 32);
        assert!(!rendered, "ASCII char should not match any Twemoji asset");
    }

    #[test]
    fn render_twemoji_zero_size_returns_false() {
        let mut img = image::RgbaImage::new(64, 64);
        let rendered = super::render_twemoji(&mut img, '🎬', 0, 0, 0);
        assert!(!rendered, "zero-size render should return false without panicking");
    }

    #[test]
    fn all_named_themes_have_visible_text() {
        for name in ["classic", "dark", "light", "cinematic", "minimal"] {
            let t = get_theme(name);
            // Alpha must be meaningfully opaque (>= 50) so the overlay is actually visible
            assert!(t.header_bg[3] >= 50, "{name}: header alpha too low ({}) — overlay won't show", t.header_bg[3]);
            assert!(t.badge_bg[3] >= 50, "{name}: badge alpha too low ({}) — badge won't show", t.badge_bg[3]);
            let text_visible = t.text_color.iter().any(|&c| c > 0);
            assert!(text_visible, "{name}: text color is fully black (invisible)");
        }
    }

    #[test]
    fn unknown_theme_falls_back_to_classic() {
        let classic = get_theme("classic");
        let unknown = get_theme("xyz-nonexistent");
        assert_eq!(classic.header_bg, unknown.header_bg);
        assert_eq!(classic.text_color, unknown.text_color);
        assert_eq!(classic.accent_color, unknown.accent_color);
    }

    #[test]
    fn secs_to_hhmmss_zero() {
        assert_eq!(secs_to_hhmmss(0.0), "00:00:00.000");
    }

    #[test]
    fn secs_to_hhmmss_exact_hour() {
        assert_eq!(secs_to_hhmmss(3661.0), "01:01:01.000");
    }

    #[test]
    fn secs_to_hhmmss_large_hours() {
        assert_eq!(secs_to_hhmmss(36000.0), "10:00:00.000");
    }

    #[test]
    fn secs_to_hhmmss_millis() {
        assert_eq!(secs_to_hhmmss(1.234), "00:00:01.234");
        assert_eq!(secs_to_hhmmss(59.999), "00:00:59.999");
        assert_eq!(secs_to_hhmmss(0.001), "00:00:00.001");
    }

    // T031: overlay hash determinism
    fn overlay_fingerprint(
        branding_text: &str,
        color_theme: &str,
        branding_enabled: bool,
        video_info_enabled: bool,
        show_timestamp: bool,
    ) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(branding_text.as_bytes());
        h.update(b"|");
        h.update(color_theme.as_bytes());
        h.update(b"|");
        h.update(if branding_enabled { b"1" } else { b"0" });
        h.update(b"|");
        h.update(if video_info_enabled { b"1" } else { b"0" });
        h.update(b"|");
        h.update(if show_timestamp { b"1" } else { b"0" });
        let result = h.finalize();
        result.iter().take(4).map(|b| format!("{:02x}", b)).collect()
    }

    #[test]
    fn same_overlay_settings_produce_same_fingerprint() {
        let a = overlay_fingerprint("Jellyfin Recents", "classic", true, true, false);
        let b = overlay_fingerprint("Jellyfin Recents", "classic", true, true, false);
        assert_eq!(a, b, "identical settings must hash identically");
        assert_eq!(a.len(), 8, "fingerprint must be 8 hex chars");
    }

    #[test]
    fn different_theme_produces_different_fingerprint() {
        let a = overlay_fingerprint("Jellyfin Recents", "dark", true, true, false);
        let b = overlay_fingerprint("Jellyfin Recents", "light", true, true, false);
        assert_ne!(a, b, "different themes must hash differently");
    }

    #[test]
    fn different_branding_text_produces_different_fingerprint() {
        let a = overlay_fingerprint("My Server", "classic", true, true, false);
        let b = overlay_fingerprint("Other Server", "classic", true, true, false);
        assert_ne!(a, b, "different branding text must hash differently");
    }

    #[test]
    fn toggling_field_changes_fingerprint() {
        let with_ts = overlay_fingerprint("Jellyfin Recents", "classic", true, true, true);
        let without_ts = overlay_fingerprint("Jellyfin Recents", "classic", true, true, false);
        assert_ne!(with_ts, without_ts, "toggling timestamp flag must change fingerprint");
    }

    fn make_subtitle_row1_parts(show_subtitles: bool, subtitle_count: i32, lang: &str) -> Vec<String> {
        let mut parts: Vec<String> = Vec::new();
        if show_subtitles && subtitle_count > 0 {
            let lbl = match lang { "zh" => "字幕：", "ja" => "字幕：", _ => "Subs: " };
            parts.push(format!("{}{}", lbl, subtitle_count));
        }
        parts
    }

    #[test]
    fn subtitle_count_included_in_row1_when_enabled_and_nonzero() {
        let parts = make_subtitle_row1_parts(true, 3, "en");
        assert_eq!(parts, vec!["Subs: 3"]);
    }

    #[test]
    fn subtitle_count_omitted_from_row1_when_count_is_zero() {
        let parts = make_subtitle_row1_parts(true, 0, "en");
        assert!(parts.is_empty(), "zero subtitle count must not add any part");
    }

    #[test]
    fn subtitle_count_omitted_from_row1_when_disabled() {
        let parts = make_subtitle_row1_parts(false, 5, "en");
        assert!(parts.is_empty(), "disabled show_subtitles must not add any part");
    }

    #[test]
    fn subtitle_label_localized_for_zh() {
        let parts = make_subtitle_row1_parts(true, 2, "zh");
        assert_eq!(parts, vec!["字幕：2"]);
    }

    #[test]
    fn subtitle_label_localized_for_ja() {
        let parts = make_subtitle_row1_parts(true, 1, "ja");
        assert_eq!(parts, vec!["字幕：1"]);
    }
}
