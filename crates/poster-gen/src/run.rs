use crate::cli::{GenerateArgs, PreviewArgs};
use crate::sampling::{apply_skip, even_timestamps, jittered_timestamps, parse_skip_segments};
use rayon::prelude::*;
use std::sync::{Arc, Mutex};

pub fn run_generate(args: GenerateArgs) -> Result<(), String> {
    let input = args
        .input
        .as_deref()
        .ok_or("--input is required for generate")?
        .to_string();
    let output = args
        .output
        .as_deref()
        .ok_or("--output is required for generate")?
        .to_string();

    let rows = args.rows.clamp(1, 20);
    let cols = args.cols.clamp(1, 12);

    let media_info = crate::media_info::extract_media_info(&args.ffmpeg_path, &input)
        .map_err(|e| format!("Media info extraction failed: {e}"))?;

    let duration = media_info.duration_secs;
    if duration <= 0.0 {
        return Err("Could not determine video duration".to_string());
    }

    let thumb_width = if media_info.source_width > 0 {
        args.thumb_width.min(media_info.source_width)
    } else {
        args.thumb_width
    };

    let has_header = !args.no_branding || !args.no_video_info;
    let is_portrait = media_info.source_height > media_info.source_width;
    let cols = if is_portrait && has_header { cols.max(3) } else { cols };

    let total = (rows * cols) as usize;
    let timestamps = if args.mode == "random" {
        jittered_timestamps(duration, total, args.seed.as_deref().unwrap_or(""))
    } else {
        even_timestamps(duration, total)
    };
    let skip = parse_skip_segments(&args.skip_segment);
    let timestamps = apply_skip(timestamps, duration, &skip);

    let num_threads = if thumb_width >= 1920 { 2 } else if thumb_width >= 1280 { 3 } else { 4 };
    let _ = rayon::ThreadPoolBuilder::new().num_threads(num_threads).build_global();

    let counter = Arc::new(Mutex::new(0usize));
    let total_frames = total;

    let frame_results: Vec<(usize, Result<image::DynamicImage, String>)> = timestamps
        .par_iter()
        .enumerate()
        .map(|(idx, &ts)| {
            let result = crate::frame_extractor::extract_frame(
                &args.ffmpeg_path,
                &input,
                ts,
                thumb_width,
            );
            let n = {
                let mut c = counter.lock().unwrap();
                *c += 1;
                *c
            };
            println!("PROGRESS {n}/{total_frames}");
            (idx, result)
        })
        .collect();

    let mut frames: Vec<(image::DynamicImage, f64)> = Vec::with_capacity(total);
    {
        let mut sorted = frame_results;
        sorted.sort_by_key(|(idx, _)| *idx);
        for (idx, result) in sorted {
            match result {
                Ok(img) => frames.push((img, timestamps[idx])),
                Err(e) => {
                    eprintln!("WARNING: frame {idx} failed: {e}");
                    let blank = image::DynamicImage::ImageRgba8(image::RgbaImage::new(
                        thumb_width,
                        thumb_width * 9 / 16,
                    ));
                    frames.push((blank, timestamps[idx]));
                }
            }
        }
    }

    let info_json = serde_json::to_string(&media_info)
        .map_err(|e| format!("Failed to serialize media info: {e}"))?;
    println!("MEDIA_INFO {info_json}");

    let renderer = crate::text_renderer::Renderer::new(
        args.font_path.as_deref(),
        args.branding_latin_font_path.as_deref(),
        args.branding_cjk_font_path.as_deref(),
        args.timestamp_font_path.as_deref(),
        &args.color_theme,
    );
    let options = crate::text_renderer::RenderOptions {
        branding_enabled: !args.no_branding,
        branding_text: args.branding_text.clone(),
        video_info_enabled: !args.no_video_info,
        show_file_size: !args.no_file_size,
        show_resolution_fps: !args.no_resolution_fps,
        show_video_encoding: !args.no_video_encoding,
        show_audio_encoding: !args.no_audio_encoding,
        show_duration: !args.no_duration,
        show_subtitles: !args.no_subtitles,
        show_frame_timestamp: args.show_timestamp,
        timestamp_bg: !args.no_timestamp_bg,
        timestamp_shadow: args.timestamp_shadow,
        timestamp_font_scale: args.timestamp_font_scale,
        lang: args.lang.clone(),
        timestamp_position: args.timestamp_position.clone(),
    };

    crate::image_stitcher::stitch_grid(
        frames,
        thumb_width,
        rows,
        cols,
        &output,
        &options,
        &renderer,
        &media_info,
        &timestamps,
    )
    .map_err(|e| format!("Stitching failed: {e}"))?;

    let abs_output = std::fs::canonicalize(&output)
        .unwrap_or_else(|_| std::path::PathBuf::from(&output));
    println!("DONE {}", abs_output.display());

    Ok(())
}

pub fn run_preview_cmd(args: PreviewArgs) -> Result<(), String> {
    let preview_args = crate::preview::PreviewArgs {
        output: args.output,
        color_theme: args.color_theme,
        font_path: args.font_path,
        branding_latin_font_path: args.branding_latin_font_path,
        branding_cjk_font_path: args.branding_cjk_font_path,
        timestamp_font_path: args.timestamp_font_path,
        branding_enabled: !args.no_branding,
        branding_text: args.branding_text,
        video_info_enabled: !args.no_video_info,
        show_file_size: !args.no_file_size,
        show_resolution_fps: !args.no_resolution_fps,
        show_video_encoding: !args.no_video_encoding,
        show_audio_encoding: !args.no_audio_encoding,
        show_duration: !args.no_duration,
        show_subtitles: !args.no_subtitles,
        show_frame_timestamp: args.show_timestamp,
        timestamp_bg: !args.no_timestamp_bg,
        timestamp_shadow: args.timestamp_shadow,
        timestamp_font_scale: args.timestamp_font_scale,
        thumb_width: args.thumb_width,
        rows: args.rows,
        cols: args.cols,
        lang: args.lang,
        timestamp_position: args.timestamp_position,
    };

    crate::preview::run_preview(preview_args)
}
