// frame-forge: video frame decoding, quality analysis, animation, and stitching daemon.
//
// Architecture: tokio-based Unix socket server.
// Three message types:
//   0x10 SINGLE_FRAME — decode + quality check → JPEG + quality flags
//   0x11 ANIMATE      — batch decode → scale → GIF/WebP → progress events → output
//   0x12 STITCH       — batch decode → crop/dedup/classify → stitch → PNG/WebP-lossless
//
// All heavy work runs in spawn_blocking; socket I/O is fully async.

mod animate;
mod blender;
mod protocol;
mod quality;
mod resources;
mod scene_classifier;
mod server;
mod stitch_anime;
#[cfg(feature = "opencv")]
mod stitch_landscape;
#[cfg(feature = "opencv")]
mod stitch_liveaction;
#[cfg(test)]
mod test_metrics;

use anyhow::{Context, Result};
use tokio::net::UnixListener;

fn main() -> Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .max_blocking_threads(16)
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("frame_forge=warn"),
    ).init();

    let args: Vec<String> = std::env::args().collect();
    let sock_path = args.get(1).context("Usage: frame-forge <socket-path>")?;

    jfs_common::init();

    #[cfg(feature = "opencl")]
    {
        let has_ocl = opencv::core::ocl::have_open_cl().unwrap_or(false);
        let n_platforms = opencv::core::ocl::Platform::list()
            .map(|v| v.len()).unwrap_or(0);
        log::info!("[frame-forge] OpenCL available={has_ocl}, platforms={n_platforms}");
    }

    let _ = std::fs::remove_file(sock_path);
    let listener = UnixListener::bind(sock_path)?;
    log::info!("[frame-forge] listening on {sock_path}");

    let state = server::State::new();

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(server::handle_conn(stream, state.clone()));
            }
            Err(e) => log::error!("[frame-forge] accept error: {e}"),
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────
// Tests require Linux (Docker) with ffmpeg + libx264; on other platforms every
// test function returns early so the suite still compiles and passes everywhere.
//
// Four test cases, each exercising a distinct segment of the video:
//   decoder_head_unique      — first 40 frames decode to unique PTS
//   decoder_tail_unique      — last  40 frames decode to unique PTS
//   animate_head_frame_count — first 30 frames → WebP/GIF has exactly 30 frames
//   animate_tail_frame_count — last  30 frames → WebP/GIF has exactly 30 frames
//
// A single synthetic test video is generated once per test run via OnceLock.
// Duration is randomised (10–25 s) so different edge-cases appear over time,
// while remaining short enough that the suite finishes quickly.
#[cfg(all(test, feature = "daemon"))]
mod tests {
    use crate::animate::{encode_gif, encode_webp_anim};
    use jfs_common::decode_and_encode;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    // ── shared video setup ────────────────────────────────────────────────────

    fn find_ffmpeg() -> Option<&'static str> {
        for p in ["/usr/lib/jellyfin-ffmpeg/ffmpeg", "/usr/bin/ffmpeg", "ffmpeg"] {
            if std::process::Command::new(p)
                .arg("-version").output()
                .map(|o| o.status.success()).unwrap_or(false)
            {
                return Some(p);
            }
        }
        None
    }

    // Returns a duration between 10 and 25 seconds, varying by wall-clock time
    // so different runs exercise different video lengths without being truly
    // non-deterministic in a way that hides bugs.
    fn random_duration_secs() -> u64 {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        10 + (seed % 16) // 10..=25 s
    }

    static TEST_VIDEO: OnceLock<Option<PathBuf>> = OnceLock::new();

    // Generates the shared test video exactly once per test run.
    fn get_test_video() -> Option<&'static PathBuf> {
        TEST_VIDEO.get_or_init(|| {
            if !cfg!(target_os = "linux") { return None; }
            let Some(ff) = find_ffmpeg() else { return None; };
            let dur = random_duration_secs();
            let path = PathBuf::from(format!("/tmp/jfs_test_{dur}s.mp4"));
            let dur_filter = format!("testsrc=size=320x240:rate=24:duration={dur}");
            eprintln!("[test] generating {dur}s test video → {}", path.display());
            let ok = std::process::Command::new(ff)
                .args([
                    "-y", "-f", "lavfi", "-i", &dur_filter,
                    "-c:v", "libx264", "-profile:v", "baseline",
                    "-preset", "ultrafast", "-crf", "35",
                    path.to_str().unwrap(),
                ])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if ok { Some(path) } else {
                eprintln!("[test] ffmpeg failed — tests will be skipped");
                None
            }
        }).as_ref()
    }

    // ── frame-index helpers ───────────────────────────────────────────────────

    // Returns all frame PTS values (ms, start-normalised, sorted ascending).
    // Mirrors what /JellyfinSuite/{itemId}/FrameInfo returns: array index = frame number.
    fn demux_pts(path: &PathBuf) -> Vec<i64> {
        use ffmpeg_next::media::Type;
        let mut ctx = ffmpeg_next::format::input(path).expect("open test video");
        let stream = ctx.streams().best(Type::Video).expect("no video stream");
        let si = stream.index();
        let tb = stream.time_base();
        let start_ms = {
            let sp = stream.start_time().max(0);
            if tb.numerator() != 0 && tb.denominator() != 0 {
                (sp as f64 * tb.numerator() as f64 * 1000.0 / tb.denominator() as f64) as i64
            } else { 0 }
        };
        let mut pts = Vec::new();
        for (s, pkt) in ctx.packets() {
            if s.index() != si { continue; }
            let p = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
            let ms = (p as f64 * tb.numerator() as f64 * 1000.0 / tb.denominator() as f64) as i64;
            pts.push((ms - start_ms).max(0));
        }
        pts.sort();
        pts
    }

    // ── encode helpers ────────────────────────────────────────────────────────

    fn count_webp_frames(data: &[u8]) -> usize {
        // Each animation frame in a WebP RIFF file is an ANMF chunk.
        data.windows(4).filter(|w| *w == b"ANMF").count()
    }

    fn count_gif_frames(data: &[u8]) -> usize {
        let mut dec = gif::DecodeOptions::new()
            .read_info(std::io::Cursor::new(data))
            .expect("GIF header invalid");
        let mut n = 0;
        while dec.read_next_frame().unwrap_or(None).is_some() { n += 1; }
        n
    }

    // ── decode-and-encode helper ──────────────────────────────────────────────

    // Decodes `pts_slice`, applies server.rs consecutive-PTS dedup, returns images.
    // Also asserts that no dedup was triggered (regression guard for decoder.rs fix).
    fn decode_segment(video: &PathBuf, pts_slice: &[i64]) -> Vec<image::DynamicImage> {
        let n = pts_slice.len();
        let mut images = Vec::with_capacity(n);
        let mut last_pts: Option<i64> = None;
        for &pos in pts_slice {
            let r = decode_and_encode(video, pos, 160)
                .unwrap_or_else(|e| panic!("decode_and_encode @{pos}ms: {e}"));
            if last_pts == Some(r.pts_ms) { continue; }
            last_pts = Some(r.pts_ms);
            images.push(image::load_from_memory(&r.webp).expect("bad WebP from decoder"));
        }
        assert_eq!(
            images.len(), n,
            "Dedup triggered on segment: {n} input positions → only {} unique frames decoded.\n\
             The decoder is still returning duplicate PTS values.",
            images.len()
        );
        images
    }

    // ── test 1: decoder uniqueness — head ────────────────────────────────────

    /// The FIRST 40 frames of the video must each decode to a distinct physical
    /// frame.  Regression test for the bug in decoder.rs where two consecutive
    /// positions near a keyframe both returned the same frame.
    #[test]
    fn decoder_head_unique() {
        let Some(video) = get_test_video() else { return; };
        let _ = ffmpeg_next::init();
        let all_pts = demux_pts(video);
        let n = all_pts.len().min(40);
        assert!(n >= 2, "video too short for head test");
        let head = &all_pts[..n];

        let mut actual = Vec::with_capacity(n);
        for &pos in head {
            let r = decode_and_encode(video, pos, 160)
                .unwrap_or_else(|e| panic!("decode @{pos}ms: {e}"));
            actual.push(r.pts_ms);
        }
        let unique: HashSet<i64> = actual.iter().cloned().collect();
        assert_eq!(
            unique.len(), actual.len(),
            "[HEAD] Duplicates: {} unique / {} decoded.\nPositions: {:?}\nPTS: {:?}",
            unique.len(), actual.len(), head, &actual,
        );
    }

    // ── test 2: decoder uniqueness — tail ────────────────────────────────────

    /// The LAST 40 frames of the video must each decode to a distinct physical
    /// frame.  Tail frames are often inter-frames far from a keyframe, exercising
    /// the seek-and-decode path differently from the head.
    #[test]
    fn decoder_tail_unique() {
        let Some(video) = get_test_video() else { return; };
        let _ = ffmpeg_next::init();
        let all_pts = demux_pts(video);
        let n = all_pts.len().min(40);
        assert!(n >= 2, "video too short for tail test");
        let tail = &all_pts[all_pts.len() - n..];

        let mut actual = Vec::with_capacity(n);
        for &pos in tail {
            let r = decode_and_encode(video, pos, 160)
                .unwrap_or_else(|e| panic!("decode @{pos}ms: {e}"));
            actual.push(r.pts_ms);
        }
        let unique: HashSet<i64> = actual.iter().cloned().collect();
        assert_eq!(
            unique.len(), actual.len(),
            "[TAIL] Duplicates: {} unique / {} decoded.\nPositions: {:?}\nPTS: {:?}",
            unique.len(), actual.len(), tail, &actual,
        );
    }

    // ── test 3: animate frame count — head ───────────────────────────────────

    /// Encoding the FIRST 30 frames as WebP and GIF must produce output with
    /// exactly 30 animation frames.
    #[test]
    fn animate_head_frame_count() {
        let Some(video) = get_test_video() else { return; };
        let _ = ffmpeg_next::init();
        let all_pts = demux_pts(video);
        let n = all_pts.len().min(30);
        assert!(n >= 2, "video too short for head animate test");
        let head = &all_pts[..n];

        let images = decode_segment(video, head);
        let delays: Vec<u32> = vec![100; n];

        let webp = encode_webp_anim(&images, &delays, 0).expect("encode_webp_anim");
        assert_eq!(count_webp_frames(&webp), n,
            "[HEAD] WebP: expected {n} frames, got {}", count_webp_frames(&webp));

        let gif_data = encode_gif(&images, &delays, 0).expect("encode_gif");
        assert_eq!(count_gif_frames(&gif_data), n,
            "[HEAD] GIF: expected {n} frames, got {}", count_gif_frames(&gif_data));
    }

    // ── test 4: animate frame count — tail ───────────────────────────────────

    /// Encoding the LAST 30 frames as WebP and GIF must produce output with
    /// exactly 30 animation frames.
    #[test]
    fn animate_tail_frame_count() {
        let Some(video) = get_test_video() else { return; };
        let _ = ffmpeg_next::init();
        let all_pts = demux_pts(video);
        let n = all_pts.len().min(30);
        assert!(n >= 2, "video too short for tail animate test");
        let tail = &all_pts[all_pts.len() - n..];

        let images = decode_segment(video, tail);
        let delays: Vec<u32> = vec![100; n];

        let webp = encode_webp_anim(&images, &delays, 0).expect("encode_webp_anim");
        assert_eq!(count_webp_frames(&webp), n,
            "[TAIL] WebP: expected {n} frames, got {}", count_webp_frames(&webp));

        let gif_data = encode_gif(&images, &delays, 0).expect("encode_gif");
        assert_eq!(count_gif_frames(&gif_data), n,
            "[TAIL] GIF: expected {n} frames, got {}", count_gif_frames(&gif_data));
    }

    #[test]
    #[ignore = "requires FRAME_FORGE_TEST_GPU=1 and Arc GPU passthrough + intel-opencl-icd"]
    fn test_opencl_detected() {
        if std::env::var_os("FRAME_FORGE_TEST_GPU").is_none() { return; }
        #[cfg(feature = "opencl")]
        assert!(
            opencv::core::ocl::have_open_cl().unwrap_or(false),
            "Arc A380 OpenCL not detected — check /dev/dri passthrough and intel-opencl-icd"
        );
    }
}
