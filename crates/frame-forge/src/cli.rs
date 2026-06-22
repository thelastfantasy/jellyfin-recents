// frame-forge CLI — stitch & animate without ffmpeg/opencv deps.
// Usage:
//   forge stitch --input img1.webp img2.webp ... --output result.png
//   forge stitch-landscape --input a.png b.png --output result.png   (requires opencv feature)
//   forge stitch-liveaction --input a.png b.png --output result.png  (requires opencv feature)
//   forge animate --input img1.webp img2.webp ... --output result.webp --height 200 --fps 5

mod animate;
mod scene_classifier;
mod stitch_anime;
#[cfg(feature = "opencv")]
mod dl_match;
#[cfg(feature = "opencv")]
mod generation_log;
#[cfg(feature = "opencv")]
mod gpu_compat;
#[cfg(feature = "opencv")]
mod stitch_landscape;
#[cfg(feature = "opencv")]
mod stitch_liveaction;
#[cfg(feature = "opencv")]
mod upscale;
#[cfg(feature = "opencv")]
mod face_restore;
#[cfg(test)]
mod test_metrics;

use anyhow::Context;
use image::DynamicImage;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("forge=info,frame_forge=info"),
    ).init();
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("stitch") => cmd_stitch(&args[2..]),
        Some("stitch-landscape") => cmd_stitch_opencv(&args[2..], "landscape"),
        Some("stitch-liveaction") => cmd_stitch_opencv(&args[2..], "liveaction"),
        Some("animate") => cmd_animate(&args[2..]),
        #[cfg(feature = "opencv")]
        Some("gpu-test") => cmd_gpu_test(&args[2..]),
        Some("upscale") => cmd_upscale(&args[2..]),
        _ => {
            log::info!("Usage:");
            log::info!("  forge stitch --input file1.png file2.png ... --output out.png [--model auto|lightglue|efficient-loftr|disabled] [--no-model] [--device cuda:0|directml:0|cpu:0] (opencv feature required for --device)");
            log::info!("  forge stitch-landscape --input a.png b.png --output out.png  (opencv feature required)");
            log::info!("  forge stitch-liveaction --input a.png b.png --output out.png (opencv feature required)");
            log::info!("  forge animate --json frames.json");
            log::info!("  forge animate --input f1.webp f2.webp ... --output out.gif --height 200 [--fps 5] [--timestamps ms1 ms2 ...]");
            log::info!("  forge gpu-test --device cuda:0|directml:0|cpu:0 --model models/<name>.onnx [--timeout-secs 60] (opencv feature required)");
            log::info!("  forge upscale --input in.png --output out.png --model models/<realesrgan>.onnx --device cuda:0|directml:0|cpu:0 [--face-restore-model models/<gfpgan>.onnx] (opencv feature required)");
            Ok(())
        }
    }
}

fn parse_kv(args: &[String]) -> Vec<(&str, Vec<&str>)> {
    let mut result = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i].starts_with("--") {
            let key = &args[i][2..];
            let mut vals = Vec::new();
            i += 1;
            while i < args.len() && !args[i].starts_with("--") {
                vals.push(args[i].as_str());
                i += 1;
            }
            result.push((key, vals));
        } else {
            i += 1;
        }
    }
    result
}

fn load_images(paths: &[&str]) -> anyhow::Result<Vec<DynamicImage>> {
    paths.iter().map(|p| {
        log::info!("  Loading: {p}");
        image::open(p).with_context(|| format!("failed to open {p}"))
    }).collect()
}

// Ops diagnostic for verifying ORT EP selection against real GPU hardware. Runs
// build_ep_session + a real inference call on a worker thread with a hard timeout
// so a CUDA EP hang (observed once on a Blackwell GPU with ORT 1.26.0) doesn't block
// forever. Session creation succeeding is NOT sufficient proof of GPU execution —
// some ORT/driver combos silently fall back to CPU per-node while still reporting
// the CUDA EP as registered — so this always runs a real `session.run()` and reports
// elapsed time for both phases; cross-check against `nvidia-smi` utilization during
// the run to confirm actual GPU compute happened.
// Usage: forge gpu-test --device cuda:0 --model models/eloftr_640x480.onnx [--timeout-secs 15]
#[cfg(feature = "opencv")]
fn cmd_gpu_test(args: &[String]) -> anyhow::Result<()> {
    let kv = parse_kv(args);
    let device = kv.iter().find(|(k, _)| *k == "device").and_then(|(_, v)| v.first()).copied().unwrap_or("cpu:0").to_string();
    let model = kv.iter().find(|(k, _)| *k == "model").and_then(|(_, v)| v.first()).copied().unwrap_or("models/eloftr_640x480.onnx").to_string();
    let timeout_secs: u64 = kv.iter().find(|(k, _)| *k == "timeout-secs").and_then(|(_, v)| v.first()).and_then(|s| s.parse().ok()).unwrap_or(15);
    log::info!("[gpu-test] device={device} model={model} timeout={timeout_secs}s pid={}", std::process::id());

    let (tx, rx) = std::sync::mpsc::channel();
    let is_eloftr = model.contains("eloftr");
    // Synthetic 480x640 zero-tensor below stands in for "one frame" — there's no real input
    // image in this diagnostic, so frame_count=1 and that tensor's own resolution are the only
    // honest numbers available to size the arena with.
    let memory_limit_bytes = dl_match::cuda_memory_limit_bytes(&device, 1, (480 * 640) as f64 / 1_000_000.0);
    std::thread::spawn(move || {
        let build_start = std::time::Instant::now();
        let send = |msg: String| { let _ = tx.send(msg); };
        let (mut session, fallbacks) = match dl_match::build_ep_session(std::path::Path::new(&model), &device, memory_limit_bytes) {
            Ok(v) => v,
            Err(e) => { send(format!("FAILED to build session: {e:#}")); return; }
        };
        send(format!(
            "session built in {:.2}s, fallback_events={fallbacks:?}, inputs={:?}",
            build_start.elapsed().as_secs_f64(),
            session.inputs().iter().map(|i| i.name().to_string()).collect::<Vec<_>>(),
        ));

        let run_start = std::time::Instant::now();
        let outputs = if is_eloftr {
            let img0 = ndarray::Array4::<f32>::zeros((1, 1, 480, 640));
            let img1 = ndarray::Array4::<f32>::zeros((1, 1, 480, 640));
            let t0 = match ort::value::TensorRef::from_array_view(img0.view()) { Ok(t) => t, Err(e) => { send(format!("FAILED to build tensor: {e}")); return; } };
            let t1 = match ort::value::TensorRef::from_array_view(img1.view()) { Ok(t) => t, Err(e) => { send(format!("FAILED to build tensor: {e}")); return; } };
            session.run(ort::inputs!["image0" => t0, "image1" => t1])
        } else {
            let images = ndarray::Array4::<f32>::zeros((2, 1, 480, 640));
            let t = match ort::value::TensorRef::from_array_view(images.view()) { Ok(t) => t, Err(e) => { send(format!("FAILED to build tensor: {e}")); return; } };
            session.run(ort::inputs!["images" => t])
        };
        match outputs {
            Ok(o) => send(format!("inference OK in {:.2}s, {} output(s)", run_start.elapsed().as_secs_f64(), o.len())),
            Err(e) => send(format!("inference FAILED: {e}")),
        }
    });

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(msg) => log::info!("[gpu-test] {msg}"),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                log::info!("[gpu-test] TIMED OUT after {timeout_secs}s — worker thread leaked (process will exit anyway)");
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

// Standalone upscale entrypoint for the `forge` CLI — exercises the same
// `dl_match::build_ep_session` + `upscale::upscale_image` + `face_restore::restore_faces`
// path that server.rs's `handle_upscale` uses in production, but against a single static
// image file rather than the daemon's animated-frame round-trip, for quick local testing.
fn cmd_upscale(args: &[String]) -> anyhow::Result<()> {
    #[cfg(not(feature = "opencv"))]
    {
        let _ = args;
        anyhow::bail!("upscale requires --features opencv (not compiled into this binary)");
    }
    #[cfg(feature = "opencv")]
    {
        let kv = parse_kv(args);
        let input = kv.iter().find(|(k, _)| *k == "input").and_then(|(_, v)| v.first()).copied()
            .ok_or_else(|| anyhow::anyhow!("--input is required"))?;
        let output = kv.iter().find(|(k, _)| *k == "output").and_then(|(_, v)| v.first()).copied().unwrap_or("upscaled.png");
        let model = kv.iter().find(|(k, _)| *k == "model").and_then(|(_, v)| v.first()).copied()
            .ok_or_else(|| anyhow::anyhow!("--model is required"))?;
        let device = kv.iter().find(|(k, _)| *k == "device").and_then(|(_, v)| v.first()).copied().unwrap_or("cpu:0");
        let face_restore_model = kv.iter().find(|(k, _)| *k == "face-restore-model").and_then(|(_, v)| v.first()).copied();
        // Debug-only: re-run upscale_image N times against the same already-built session,
        // to separate one-time CUDA-context/cuDNN-algo-search cold-start cost (paid once, here
        // and in the long-running daemon alike) from steady-state per-call latency (what the
        // daemon's tile/frame loop actually experiences across many calls in one process).
        let repeat: u32 = kv.iter().find(|(k, _)| *k == "repeat").and_then(|(_, v)| v.first()?.parse().ok()).unwrap_or(1);

        const TILE: u32 = 256;
        const OVERLAP: u32 = 32;

        log::info!("[jellyfin-suite-forge] upscale device={device} model={model} face_restore_model={face_restore_model:?} repeat={repeat}");
        let img = image::open(input).with_context(|| format!("failed to open {input}"))?;

        // No job-cancellation concept for the one-shot CLI — always-false flag is a no-op.
        let no_cancel = std::sync::atomic::AtomicBool::new(false);
        let memory_limit_bytes = dl_match::cuda_memory_limit_bytes_upscale(device);
        let (mut session, fallbacks) = dl_match::build_ep_session(std::path::Path::new(model), device, memory_limit_bytes)?;
        log::info!("[jellyfin-suite-forge] fallback_events={fallbacks:?}");

        let mut result = None;
        for i in 0..repeat.max(1) {
            let t0 = std::time::Instant::now();
            result = Some(upscale::upscale_image(&mut session, &img, TILE, OVERLAP, &no_cancel)?);
            log::info!("[jellyfin-suite-forge] upscale_image call #{i} took {:.2}s", t0.elapsed().as_secs_f64());
        }
        let mut result = result.expect("repeat.max(1) >= 1 guarantees at least one iteration");

        if std::env::var("FRAME_FORGE_ORT_VERBOSE").as_deref() == Ok("1") {
            if let Ok(path) = session.end_profiling() {
                log::info!("[jellyfin-suite-forge] ORT profile written to {path}");
            }
        }

        if let Some(fr_model) = face_restore_model {
            let (mut fr_session, fr_fallbacks) = dl_match::build_ep_session(std::path::Path::new(fr_model), device, memory_limit_bytes)?;
            log::info!("[jellyfin-suite-forge] face_restore fallback_events={fr_fallbacks:?}");
            let (restored, face_count) = face_restore::restore_faces(&mut fr_session, &result, &no_cancel)?;
            log::info!("[jellyfin-suite-forge] face_restore faces_found={face_count}");
            result = restored;
        }

        result.save(output)?;
        log::info!("Saved: {output} ({}x{})", result.width(), result.height());
        Ok(())
    }
}

fn cmd_stitch(args: &[String]) -> anyhow::Result<()> {
    let kv = parse_kv(args);
    let input: Vec<&str> = kv.iter().find(|(k,_)| *k == "input").map(|(_,v)| v.as_slice()).unwrap_or(&[]).to_vec();
    let output = kv.iter().find(|(k,_)| *k == "output").and_then(|(_,v)| v.first()).map(|s| *s).unwrap_or("stitched.png");
    let device = kv.iter().find(|(k, _)| *k == "device").and_then(|(_, v)| v.first()).copied().unwrap_or("cpu:0");

    // --model <name> (preferred) or --matcher <name> (compat) or --no-model.
    // --no-model and --model are mutually exclusive; --model wins if both supplied.
    // The matcher is loaded via the EP-aware per-request path (same as production server.rs)
    // rather than the env-var-driven global singleton, so --device actually selects the EP
    // and any GPU→CPU fallback is reported explicitly instead of happening silently.
    let images = load_images(&input)?;

    #[cfg(feature = "opencv")]
    let per_req_matcher = {
        use dl_match::ModelChoice;
        let choice = if args.iter().any(|a| a == "--no-model") {
            ModelChoice::Disabled
        } else if let Some(m) = kv.iter()
            .find(|(k, _)| *k == "model" || *k == "matcher")
            .and_then(|(_, v)| v.first())
        {
            ModelChoice::from_str(m)
        } else {
            ModelChoice::Auto
        };
        let resolution_mp = images.first()
            .map(|img| (img.width() as f64 * img.height() as f64) / 1_000_000.0)
            .unwrap_or(0.0);
        let (matcher, fallbacks) = dl_match::load_matcher_for_request(device, choice, images.len(), resolution_mp);
        log::info!("[jellyfin-suite-forge] device={device} model={choice:?} fallback_events={fallbacks:?}");
        matcher
    };

    log::info!("Classifying scene...");
    let class = scene_classifier::classify(&images);
    log::info!("Scene: {:?}  Edge: {:.3}  Entropy: {:.1}",
        class.category, class.edge_density, class.color_entropy);

    #[cfg(feature = "opencv")]
    let result = stitch_routed(&class, &images, per_req_matcher)?;
    #[cfg(not(feature = "opencv"))]
    let result = stitch_routed(&class, &images)?;
    result.save(output)?;
    log::info!("Saved: {output} ({}x{})", result.width(), result.height());
    Ok(())
}

#[cfg(feature = "opencv")]
fn stitch_routed(
    class: &scene_classifier::SceneClass,
    images: &[DynamicImage],
    per_req_matcher: Option<dl_match::AnyMatcher>,
) -> anyhow::Result<DynamicImage> {
    use scene_classifier::SceneCategory;
    match class.category {
        SceneCategory::LiveAction => {
            log::info!("Auto-routing: liveaction (OpenCV Stitcher)");
            stitch_liveaction::stitch_liveaction(images, per_req_matcher)
        }
        SceneCategory::Landscape => {
            log::info!("Auto-routing: landscape (SIFT + Laplacian)");
            stitch_landscape::stitch_landscape(images, per_req_matcher)
        }
        SceneCategory::Anime => {
            log::info!("Auto-routing: anime (Phase Correlation)");
            stitch_anime::stitch_anime(images)
        }
    }
}

#[cfg(not(feature = "opencv"))]
fn stitch_routed(_class: &scene_classifier::SceneClass, images: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    log::info!("Auto-routing: Phase Correlation (opencv unavailable)");
    stitch_anime::stitch_anime(images)
}

fn cmd_animate(args: &[String]) -> anyhow::Result<()> {
    let kv = parse_kv(args);

    if let Some(manifest_path) = kv.iter().find(|(k,_)| *k == "json").and_then(|(_,v)| v.first()) {
        // JSON manifest — all-in-one
        let json = std::fs::read_to_string(manifest_path)?;
        let m: Manifest = serde_json::from_str(&json)?;
        let paths: Vec<&str> = m.frames.iter().map(|f| f.path.as_str()).collect();
        // Accumulate durations into timestamps for internal use
        let mut ts = 0u64;
        let timestamps: Vec<u64> = m.frames.iter().map(|f| { ts += f.duration_ms; ts }).collect();
        let output = m.output.as_deref().unwrap_or("output.webp");
        let height = m.height.unwrap_or(200);
        let fps = m.fps.unwrap_or(5);
        log::info!("Loading {} frames from manifest...", paths.len());
        let images = load_images(&paths)?;
        encode_and_save(&images, &timestamps, output, height, fps)
    } else {
        // CLI mode — --input + optional --timestamps / --fps / --height / --output
        let input: Vec<&str> = kv.iter().find(|(k,_)| *k == "input").map(|(_,v)| v.as_slice()).unwrap_or(&[]).to_vec();
        let output = kv.iter().find(|(k,_)| *k == "output").and_then(|(_,v)| v.first()).map(|s| s.to_string()).unwrap_or_else(|| "output.webp".into());
        let height: u32 = kv.iter().find(|(k,_)| *k == "height").and_then(|(_,v)| v.first()?.parse().ok()).unwrap_or(200);
        let fps: u16 = kv.iter().find(|(k,_)| *k == "fps").and_then(|(_,v)| v.first()?.parse().ok()).unwrap_or(5);
        let timestamps: Vec<u64> = kv.iter().find(|(k,_)| *k == "timestamps")
            .map(|(_,v)| v.iter().filter_map(|s| s.parse().ok()).collect())
            .unwrap_or_default();
        let images = load_images(&input)?;
        encode_and_save(&images, &timestamps, &output, height, fps)
    }
}

fn encode_and_save(images: &[DynamicImage], timestamps: &[u64], output: &str, height: u32, fps: u16) -> anyhow::Result<()> {
    log::info!("Scaling to {height}px height...");
    let scaled: Vec<DynamicImage> = images.iter().map(|img| {
        let ratio = height as f64 / img.height() as f64;
        let w = (img.width() as f64 * ratio).max(1.0) as u32;
        img.resize_exact(w, height, image::imageops::FilterType::Lanczos3)
    }).collect();

    let uniform_delay_ms = (1000u32 / fps.max(1) as u32).max(10);
    let uniform_delays: Vec<u32> = vec![uniform_delay_ms; scaled.len()];

    let encoded = if output.ends_with(".gif") {
        if !timestamps.is_empty() {
            animate::encode_gif_timed(&scaled, timestamps, 0)?
        } else {
            animate::encode_gif(&scaled, &uniform_delays, 0)?
        }
    } else {
        if !timestamps.is_empty() {
            animate::encode_webp_timed(&scaled, timestamps, 0)?
        } else {
            animate::encode_webp_anim(&scaled, &uniform_delays, 0)?
        }
    };
    std::fs::write(output, &encoded)?;
    log::info!("Saved: {output} ({} bytes)", encoded.len());
    Ok(())
}

fn cmd_stitch_opencv(args: &[String], mode: &str) -> anyhow::Result<()> {
    #[cfg(not(feature = "opencv"))]
    {
        anyhow::bail!("stitch-{mode} requires --features opencv (not compiled into this binary)");
    }
    #[cfg(feature = "opencv")]
    {
        let kv = parse_kv(args);
        let input: Vec<&str> = kv.iter().find(|(k,_)| *k == "input").map(|(_,v)| v.as_slice()).unwrap_or(&[]).to_vec();
        let output = kv.iter().find(|(k,_)| *k == "output").and_then(|(_,v)| v.first()).map(|s| *s).unwrap_or("stitched.png");
        if input.len() < 2 {
            anyhow::bail!("stitch-{mode} requires at least 2 --input images");
        }
        let images = load_images(&input)?;
        log::info!("Stitching {} frames with {mode} algorithm...", images.len());
        let result = match mode {
            "liveaction" => stitch_liveaction::stitch_liveaction(&images, None)?,
            _ => stitch_landscape::stitch_landscape(&images, None)?,
        };
        result.save(output)?;
        log::info!("Saved: {output} ({}x{})", result.width(), result.height());
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct ManifestFrame {
    path: String,
    /// Per-frame display duration in ms (user-facing), accumulated into timestamps internally
    duration_ms: u64,
}

#[derive(serde::Deserialize)]
struct Manifest {
    frames: Vec<ManifestFrame>,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    fps: Option<u16>,
}
