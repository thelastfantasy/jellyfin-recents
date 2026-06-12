// CPU and memory load estimation from /proc (Linux only).
// On non-Linux platforms resource_pressure() always returns 0.0.

/// Returns normalized resource pressure in [0.0, 1.0].
/// Values above 0.8 indicate heavy load (CPU saturated or < 512 MB RAM free).
/// Falls back to 0.0 on read errors or non-Linux platforms.
pub fn resource_pressure() -> f64 {
    #[cfg(target_os = "linux")]
    return cpu_load().max(memory_pressure());
    #[cfg(not(target_os = "linux"))]
    return 0.0;
}

#[cfg(target_os = "linux")]
fn cpu_load() -> f64 {
    let raw = match std::fs::read_to_string("/proc/loadavg") {
        Ok(r) => r,
        Err(_) => return 0.0,
    };
    let load1: f64 = match raw.split_whitespace().next().and_then(|s| s.parse().ok()) {
        Some(v) => v,
        None => return 0.0,
    };
    let ncpus = cpu_count().max(1) as f64;
    (load1 / ncpus).min(1.0)
}

#[cfg(target_os = "linux")]
fn memory_pressure() -> f64 {
    let raw = match std::fs::read_to_string("/proc/meminfo") {
        Ok(r) => r,
        Err(_) => return 0.0,
    };
    let mut total_kb = 0u64;
    let mut avail_kb = 0u64;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total_kb = parse_kb(rest);
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            avail_kb = parse_kb(rest);
        }
    }
    if total_kb == 0 {
        return 0.0;
    }
    if avail_kb < 512 * 1024 {
        return 1.0; // < 512 MB available
    }
    1.0 - (avail_kb as f64 / total_kb as f64)
}

#[cfg(target_os = "linux")]
fn parse_kb(s: &str) -> u64 {
    s.split_whitespace()
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn cpu_count() -> usize {
    std::fs::read_to_string("/proc/cpuinfo")
        .unwrap_or_default()
        .lines()
        .filter(|l| l.starts_with("processor"))
        .count()
        .max(1)
}
