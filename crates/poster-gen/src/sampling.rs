pub fn even_timestamps(duration: f64, total: usize) -> Vec<f64> {
    let spacing = duration / total as f64;
    (0..total)
        .map(|i| spacing / 2.0 + i as f64 * spacing)
        .collect()
}

pub fn jittered_timestamps(duration: f64, total: usize, seed_hex: &str) -> Vec<f64> {
    let even = even_timestamps(duration, total);
    let spacing = duration / total as f64;
    let max_jitter = (spacing / 4.0).min((spacing - 2.0) / 2.0).max(0.0);
    if max_jitter == 0.0 {
        return even;
    }
    let seed = parse_seed_u64(seed_hex);
    even.iter()
        .enumerate()
        .map(|(i, &t)| {
            let r = xorshift64_at(seed, i as u64);
            let normalized = (r >> 11) as f64 / (1u64 << 53) as f64;
            let jitter = (normalized - 0.5) * 2.0 * max_jitter;
            t + jitter
        })
        .collect()
}

pub fn parse_skip_segments(segs: &[String]) -> Vec<(f64, f64)> {
    segs.iter()
        .filter_map(|s| {
            let mut parts = s.splitn(2, ':');
            let start: f64 = parts.next()?.parse().ok()?;
            let end: f64 = parts.next()?.parse().ok()?;
            if end > start { Some((start / 1000.0, end / 1000.0)) } else { None }
        })
        .collect()
}

pub fn apply_skip(timestamps: Vec<f64>, duration: f64, skip: &[(f64, f64)]) -> Vec<f64> {
    if skip.is_empty() {
        return timestamps;
    }
    let intervals = available_intervals(duration, skip);
    let avail: f64 = intervals.iter().map(|(s, e)| e - s).sum();
    if avail <= 0.0 {
        return timestamps;
    }
    timestamps
        .iter()
        .map(|&t| {
            let compressed = (t / duration * avail).min(avail - f64::EPSILON);
            let mut acc = 0.0;
            for &(s, e) in &intervals {
                let len = e - s;
                if compressed < acc + len {
                    return s + (compressed - acc);
                }
                acc += len;
            }
            intervals.last().map(|&(_, e)| e).unwrap_or(t)
        })
        .collect()
}

fn available_intervals(duration: f64, skip: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut sorted = skip.to_vec();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut result = Vec::new();
    let mut cursor = 0.0f64;
    for (s, e) in &sorted {
        let s = s.clamp(0.0, duration);
        let e = e.clamp(0.0, duration);
        if s > cursor {
            result.push((cursor, s));
        }
        if e > cursor {
            cursor = e;
        }
    }
    if cursor < duration {
        result.push((cursor, duration));
    }
    result
}

fn parse_seed_u64(s: &str) -> u64 {
    let hex = s
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(16)
        .collect::<String>();
    u64::from_str_radix(&hex, 16).unwrap_or(0xdeadbeef_cafebabe)
}

fn xorshift64_at(seed: u64, idx: u64) -> u64 {
    let mut state = seed
        ^ idx
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    state
}

#[cfg(test)]
mod tests {
    use super::{even_timestamps, jittered_timestamps};

    const EPS: f64 = 1e-9;

    #[test]
    fn even_spacing_count() {
        let ts = even_timestamps(3600.0, 48);
        assert_eq!(ts.len(), 48);
    }

    #[test]
    fn even_spacing_interval() {
        let ts = even_timestamps(3600.0, 48);
        let spacing = 3600.0 / 48.0;
        assert!((ts[0] - spacing / 2.0).abs() < EPS);
        for i in 1..ts.len() {
            assert!((ts[i] - ts[i - 1] - spacing).abs() < EPS);
        }
    }

    #[test]
    fn even_spacing_first_last() {
        let ts = even_timestamps(3600.0, 48);
        let spacing = 3600.0 / 48.0;
        assert!((ts[0] - spacing / 2.0).abs() < EPS);
        assert!((ts[47] - (3600.0 - spacing / 2.0)).abs() < EPS);
    }

    #[test]
    fn min_spacing_two_seconds() {
        let duration = 60.0;
        let total = 30;
        let ts = even_timestamps(duration, total);
        for i in 1..ts.len() {
            assert!(ts[i] - ts[i - 1] >= 2.0 - EPS);
        }
    }

    #[test]
    fn single_frame() {
        let ts = even_timestamps(120.0, 1);
        assert_eq!(ts.len(), 1);
        assert!((ts[0] - 60.0).abs() < EPS);
    }

    #[test]
    fn all_timestamps_within_duration() {
        let duration = 3600.0;
        let ts = even_timestamps(duration, 48);
        for t in &ts {
            assert!(*t > 0.0, "timestamp must be positive, got {t}");
            assert!(*t < duration, "timestamp must be < duration, got {t}");
        }
    }

    #[test]
    fn two_frames_short_video() {
        let ts = even_timestamps(10.0, 2);
        assert_eq!(ts.len(), 2);
        assert!((ts[0] - 2.5).abs() < EPS);
        assert!((ts[1] - 7.5).abs() < EPS);
    }

    #[test]
    fn large_grid_48_frames() {
        let ts = even_timestamps(5400.0, 48);
        assert_eq!(ts.len(), 48);
        let spacing = 5400.0 / 48.0;
        for i in 1..ts.len() {
            assert!(
                (ts[i] - ts[i - 1] - spacing).abs() < EPS,
                "frame {i} spacing off"
            );
        }
    }

    #[test]
    fn jitter_stays_within_bounds() {
        let ts = jittered_timestamps(1000.0, 10, "abc123");
        for t in &ts {
            assert!(*t > 0.0 && *t < 1000.0, "timestamp out of duration: {t}");
        }
        for w in ts.windows(2) {
            assert!(w[1] - w[0] >= 2.0 - EPS, "adjacent gap < 2s: {} {}", w[0], w[1]);
        }
    }

    #[test]
    fn jitter_differs_from_even() {
        let even = even_timestamps(1000.0, 10);
        let jittered = jittered_timestamps(1000.0, 10, "deadbeef");
        let any_diff = even.iter().zip(&jittered).any(|(a, b)| (a - b).abs() > 0.1);
        assert!(any_diff, "jittered timestamps should differ from even");
    }

    #[test]
    fn jitter_min_spacing_degrades_to_even() {
        let even = even_timestamps(20.0, 10);
        let jittered = jittered_timestamps(20.0, 10, "someseeed");
        for (a, b) in even.iter().zip(&jittered) {
            assert!((a - b).abs() < EPS, "should be even when spacing=2s");
        }
    }

    #[test]
    fn same_seed_deterministic() {
        let a = jittered_timestamps(3600.0, 48, "cafebabe12345678");
        let b = jittered_timestamps(3600.0, 48, "cafebabe12345678");
        for (x, y) in a.iter().zip(&b) {
            assert!((x - y).abs() < EPS, "same seed must produce same timestamps");
        }
    }

    #[test]
    fn different_seeds_produce_different_results() {
        let a = jittered_timestamps(3600.0, 48, "aaaa0000");
        let b = jittered_timestamps(3600.0, 48, "bbbb1111");
        let any_diff = a.iter().zip(&b).any(|(x, y)| (x - y).abs() > 0.1);
        assert!(any_diff, "different seeds should produce different timestamps");
    }
}
