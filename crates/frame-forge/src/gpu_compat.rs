//! GPU/ORT-asset compatibility denylist (T040-T041, research.md §7a).
//!
//! Protects against known-bad {vendor, computeCapability, ortAssetKey} combinations that
//! hang or silently run on CPU instead of GPU — e.g. NVIDIA Blackwell (`sm_120`) against
//! ORT's standard `gpu` (CUDA12) asset, which has no CUDA12 SASS/PTX kernels for `sm_120`.
//! The real fix is `OrtVersionService` (T042) picking `gpu_cuda13` up front; this denylist
//! is defense-in-depth for any future ORT version pin that regresses that asset-selection
//! logic, checked before paying even the T037-bounded EP-init timeout.

use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize)]
struct DenylistEntry {
    vendor: String,
    #[serde(rename = "computeCapability")]
    compute_capability: String,
    #[serde(rename = "ortAssetKey")]
    ort_asset_key: String,
    reason: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Denylist {
    denylist: Vec<DenylistEntry>,
}

static DENYLIST: OnceLock<Vec<DenylistEntry>> = OnceLock::new();

fn denylist() -> &'static [DenylistEntry] {
    DENYLIST
        .get_or_init(|| {
            const RAW: &str = include_str!("../gpu-compat.json");
            match serde_json::from_str::<Denylist>(RAW) {
                Ok(parsed) => parsed.denylist,
                Err(e) => {
                    log::error!("[gpu_compat] failed to parse gpu-compat.json: {e}");
                    Vec::new()
                }
            }
        })
        .as_slice()
}

/// Returns `Some(reason)` if `(vendor, compute_capability, ort_asset_key)` matches a known-bad
/// combination. `ort_asset_key` is normally the `FRAME_FORGE_ORT_ASSET_KEY` value set by
/// `OrtVersionService` (T042) when it activates a managed ORT version — see
/// [`active_ort_asset_key`] for what it defaults to when no version has been installed.
pub fn check(vendor: &str, compute_capability: &str, ort_asset_key: &str) -> Option<String> {
    if ort_asset_key.is_empty() {
        return None;
    }
    denylist()
        .iter()
        .find(|e| {
            e.vendor.eq_ignore_ascii_case(vendor)
                && e.compute_capability == compute_capability
                && e.ort_asset_key == ort_asset_key
        })
        .map(|e| e.reason.clone())
}

/// Shells out to `nvidia-smi --query-gpu=compute_cap --format=csv,noheader -i <index>`
/// (NVML-based, independent of the ORT/CUDA init path — mirrors the C#-side detection in
/// `DeviceEnumerationService.GetNvidiaComputeCapabilities`, kept independent so the Rust
/// daemon's safety check does not depend on the plugin process having run first). Returns
/// `None` if `nvidia-smi` is missing, fails, or the index is out of range.
pub fn detect_compute_capability(gpu_index: u32) -> Option<String> {
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=compute_cap",
            "--format=csv,noheader",
            "-i",
            &gpu_index.to_string(),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

/// Shells out to `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits -i <index>`
/// to get the GPU's total VRAM in MiB — used by `dl_match::cuda_memory_limit_bytes` to size the
/// CUDA EP's arena as a percentage of actual hardware capacity rather than a single hardcoded
/// constant. Same independence rationale as `detect_compute_capability`. Returns `None` if
/// `nvidia-smi` is missing, fails, or the output isn't a parseable integer.
pub fn detect_total_memory_mb(gpu_index: u32) -> Option<u64> {
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=memory.total",
            "--format=csv,noheader,nounits",
            "-i",
            &gpu_index.to_string(),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// Same shell-out as `detect_total_memory_mb` but for `memory.free` — the VRAM actually
/// unallocated *right now*, including whatever other processes (the host desktop compositor,
/// another concurrent job) currently hold. Used by `dl_match::cuda_memory_limit_bytes_upscale`:
/// upscale already gates on `resource_pressure()` before requesting a session, so sizing its
/// arena off live headroom rather than total capacity means a transient memory squeeze shows up
/// as a smaller (but still correct) limit instead of a fixed percentage that's blind to it.
pub fn detect_free_memory_mb(gpu_index: u32) -> Option<u64> {
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=memory.free",
            "--format=csv,noheader,nounits",
            "-i",
            &gpu_index.to_string(),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// Reads the ORT asset key set by `OrtVersionService` (T042) at daemon launch, e.g.
/// `"linux-x64-gpu"` or `"linux-x64-gpu_cuda13"`.
///
/// When `OrtVersionService` hasn't installed any managed version yet (e.g. the model-catalog
/// fetch is failing), the env var is unset — but the daemon doesn't go without ORT in that
/// case: the `ort` crate's own `download-binaries` default feature (Cargo.toml does not set
/// `default-features = false`) fetches and loads a standard CUDA12 build on its own, equivalent
/// to the `linux-x64-gpu` asset. Defaulting to that key here (rather than treating "unset" as
/// "no signal") keeps the denylist effective against e.g. Blackwell GPUs even before any
/// managed ORT version has ever been installed.
pub fn active_ort_asset_key() -> String {
    let v = std::env::var("FRAME_FORGE_ORT_ASSET_KEY").unwrap_or_default();
    if v.is_empty() { "linux-x64-gpu".to_string() } else { v }
}
