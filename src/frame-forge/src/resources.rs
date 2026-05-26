/// CPU and memory resource monitoring for dynamic task scheduling (FR-042).
/// Reads /proc/stat and /proc/meminfo on Linux systems.

use std::fs;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct ResourceMonitor {
    last_cpu: Instant,
    last_idle: u64,
    last_total: u64,
}

impl ResourceMonitor {
    pub fn new() -> Self {
        Self {
            last_cpu: Instant::now(),
            last_idle: 0,
            last_total: 0,
        }
    }

    /// Returns a pressure value 0.0 (idle) to 1.0 (saturated).
    /// Threshold: CPU > 80% or free memory < 512 MB → pressure > 0.8.
    pub fn pressure(&mut self) -> f64 {
        let cpu = self.cpu_usage();
        let mem = self.mem_pressure();
        cpu.max(mem)
    }

    fn cpu_usage(&mut self) -> f64 {
        if let Ok(stat) = fs::read_to_string("/proc/stat") {
            let line = stat.lines().find(|l| l.starts_with("cpu "));
            if let Some(line) = line {
                let parts: Vec<u64> = line
                    .split_whitespace()
                    .skip(1)
                    .filter_map(|s| s.parse().ok())
                    .collect();
                if parts.len() >= 4 {
                    let idle = parts[3];
                    let total: u64 = parts.iter().sum();
                    let now = Instant::now();
                    let dt = (now - self.last_cpu).as_secs_f64().max(0.1);
                    let usage = if self.last_total > 0 {
                        let d_idle = idle.saturating_sub(self.last_idle) as f64;
                        let d_total = total.saturating_sub(self.last_total) as f64;
                        1.0 - (d_idle / d_total.max(1.0))
                    } else {
                        0.0
                    };
                    self.last_idle = idle;
                    self.last_total = total;
                    self.last_cpu = now;
                    return (usage / 0.8).min(1.0); // normalize: >80% → pressure >1.0
                }
            }
        }
        0.0
    }

    fn mem_pressure(&mut self) -> f64 {
        if let Ok(meminfo) = fs::read_to_string("/proc/meminfo") {
            let mut total = 0u64;
            let mut available = 0u64;
            for line in meminfo.lines() {
                if line.starts_with("MemTotal:") {
                    total = parse_kb(line);
                } else if line.starts_with("MemAvailable:") {
                    available = parse_kb(line);
                }
            }
            if total > 0 {
                let free_mb = available / 1024;
                // >512MB free → pressure 0; <512MB → rising pressure
                return if free_mb > 512 {
                    0.0
                } else {
                    (1.0 - free_mb as f64 / 512.0).max(0.0).min(1.0)
                };
            }
        }
        0.0
    }
}

fn parse_kb(line: &str) -> u64 {
    line.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}
