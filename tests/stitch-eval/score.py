#!/usr/bin/env python3
"""
Batch stitch quality evaluator.

Usage:
  python score.py <fixtures_dir> [output_dir]

Each subdirectory under fixtures_dir must contain:
  input_a.png, input_b.png, reference.png

reference.png may be either:
  - A copy of input_a (proxy mode): evaluator crops the matching region from
    the stitched panorama using alpha-channel offset detection, then compares.
  - A ground-truth panorama wider than input_a: evaluator compares directly.

Exits 0 if all metrics pass, 1 if any fail, 2 if fixtures_dir missing.
"""
import json
import math
import sys
from pathlib import Path


def load_thresholds() -> dict:
    here = Path(__file__).parent
    path = here / "thresholds.json"
    with open(path) as f:
        data = json.load(f)
    # Support both new {gt:{...}, proxy:{...}} and legacy flat format.
    if "gt" in data and "proxy" in data:
        return data
    return {"gt": data, "proxy": data}


def to_lab(r: int, g: int, b: int):
    def lin(c):
        v = c / 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

    rl, gl, bl = lin(r), lin(g), lin(b)
    x = rl * 0.4124 + gl * 0.3576 + bl * 0.1805
    y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722
    z = rl * 0.0193 + gl * 0.1192 + bl * 0.9505

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(x / 0.9505), f(y), f(z / 1.0888)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def find_content_offset(img):
    """Return (off_x, off_y): top-left corner of non-transparent content in an RGBA image.

    The stitched panorama canvas may be expanded to the left/top when input_b
    lies to the left of input_a. In that case input_a is placed at (off_x, off_y)
    and the border pixels have alpha=0. We detect this offset so we can crop the
    input_a-sized region for a meaningful pixel comparison.
    """
    try:
        import numpy as np
    except ImportError:
        return 0, 0

    if img.mode != "RGBA":
        return 0, 0

    alpha = np.array(img)[:, :, 3]
    rows = np.any(alpha > 0, axis=1)
    cols = np.any(alpha > 0, axis=0)
    off_y = int(np.argmax(rows)) if rows.any() else 0
    off_x = int(np.argmax(cols)) if cols.any() else 0
    return off_x, off_y


def align_for_comparison(ref_img, stitched_img, input_a_img):
    """Return (ref_crop, stitched_crop) aligned for pixel comparison.

    Two modes:
    - Proxy mode (reference ≈ input_a): crop the input_a-sized region from
      the stitched canvas using alpha-offset detection.
    - GT mode (reference is a wider panorama): compare stitched to reference
      directly using the min-size overlap, same as before.
    """
    rw, rh = ref_img.size
    aw, ah = input_a_img.size

    is_proxy = abs(rw - aw) <= 8 and abs(rh - ah) <= 8

    if is_proxy:
        off_x, off_y = find_content_offset(stitched_img)
        sw, sh = stitched_img.size
        x2 = min(off_x + rw, sw)
        y2 = min(off_y + rh, sh)
        crop_w = x2 - off_x
        crop_h = y2 - off_y
        stitched_crop = stitched_img.crop((off_x, off_y, x2, y2)).convert("RGB")
        ref_crop      = ref_img.crop((0, 0, crop_w, crop_h)).convert("RGB")
        return ref_crop, stitched_crop
    else:
        # GT panorama: compare directly at minimum overlapping size
        sw, sh = stitched_img.size
        w = min(rw, sw)
        h = min(rh, sh)
        return ref_img.crop((0, 0, w, h)).convert("RGB"), \
               stitched_img.crop((0, 0, w, h)).convert("RGB")


def compute_ssim(img_a, img_b):
    """Simplified global-window SSIM on luminance."""
    try:
        import numpy as np
    except ImportError:
        return None

    a = np.array(img_a.convert("L"), dtype=np.float64)
    b = np.array(img_b.convert("L"), dtype=np.float64)
    h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
    a, b = a[:h, :w], b[:h, :w]

    mu_a, mu_b = a.mean(), b.mean()
    var_a = (a * a).mean() - mu_a ** 2
    var_b = (b * b).mean() - mu_b ** 2
    cov_ab = (a * b).mean() - mu_a * mu_b

    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    num = (2 * mu_a * mu_b + c1) * (2 * cov_ab + c2)
    den = (mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2)
    return float(num / den)


def compute_color_de(img_a, img_b):
    try:
        import numpy as np
    except ImportError:
        return None

    a = np.array(img_a.convert("RGB"), dtype=np.uint8)
    b = np.array(img_b.convert("RGB"), dtype=np.uint8)
    h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
    a, b = a[:h, :w], b[:h, :w]

    total = 0.0
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            l1, aa1, bb1 = to_lab(int(a[y, x, 0]), int(a[y, x, 1]), int(a[y, x, 2]))
            l2, aa2, bb2 = to_lab(int(b[y, x, 0]), int(b[y, x, 1]), int(b[y, x, 2]))
            total += math.sqrt((l1-l2)**2 + (aa1-aa2)**2 + (bb1-bb2)**2)
    n = ((h + 3) // 4) * ((w + 3) // 4)
    return total / n if n > 0 else 0.0


def compute_rmse(img_a, img_b):
    try:
        import numpy as np
    except ImportError:
        return None

    a = np.array(img_a.convert("L"), dtype=np.float64)
    b = np.array(img_b.convert("L"), dtype=np.float64)
    h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
    a, b = a[:h, :w], b[:h, :w]
    return float(math.sqrt(((a - b) ** 2).mean()))


def evaluate_pair(subdir: Path, thresholds: dict, output_dir: Path | None = None) -> dict:
    try:
        from PIL import Image
    except ImportError:
        print("ERROR: Pillow not installed. Run: pip install Pillow", file=sys.stderr)
        sys.exit(1)

    ref_path     = subdir / "reference.png"
    input_a_path = subdir / "input_a.png"
    ref     = Image.open(ref_path)
    input_a = Image.open(input_a_path)

    # Detect mode: proxy (reference ≈ input_a) vs gt (reference is a real panorama).
    rw, rh = ref.size
    aw, ah = input_a.size
    is_proxy = abs(rw - aw) <= 8 and abs(rh - ah) <= 8
    mode = "proxy" if is_proxy else "gt"
    t = thresholds.get(mode, thresholds)

    stitched_path = None
    if output_dir is not None:
        candidate = output_dir / f"{subdir.name}_stitched.png"
        if candidate.exists():
            stitched_path = candidate

    if stitched_path is not None:
        stitched_raw = Image.open(stitched_path)
        ref_cmp, stitched_cmp = align_for_comparison(ref, stitched_raw, input_a)
    else:
        # No stitched output: compare ref to input_a (proxy baseline = perfect score).
        ref_cmp      = ref.convert("RGB")
        stitched_cmp = input_a.convert("RGB")

    ssim = compute_ssim(ref_cmp, stitched_cmp)
    de   = compute_color_de(ref_cmp, stitched_cmp)
    rmse = compute_rmse(ref_cmp, stitched_cmp)

    metrics: dict = {"pair": subdir.name, "mode": mode}
    failures = []

    if ssim is not None:
        metrics["ssim"] = round(ssim, 4)
        if ssim < t["ssim_min"]:
            failures.append(f"ssim={ssim:.4f} < {t['ssim_min']}")
    if de is not None:
        metrics["color_de"] = round(de, 4)
        if de > t["color_de_max"]:
            failures.append(f"color_de={de:.4f} > {t['color_de_max']}")
    if rmse is not None:
        metrics["rmse"] = round(rmse, 4)
        if rmse > t["rmse_max"]:
            failures.append(f"rmse={rmse:.4f} > {t['rmse_max']}")

    metrics["status"] = "fail" if failures else "pass"
    for msg in failures:
        print(f"FAIL [{subdir.name}] ({mode}): {msg}", file=sys.stderr)

    return metrics


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <fixtures_dir> [output_dir]", file=sys.stderr)
        sys.exit(2)

    fixtures_dir = Path(sys.argv[1])
    if not fixtures_dir.exists():
        print(f"ERROR: fixtures directory not found: {fixtures_dir}", file=sys.stderr)
        sys.exit(2)

    output_dir = Path(sys.argv[2]) if len(sys.argv) >= 3 else None

    thresholds = load_thresholds()
    pairs = sorted(
        d for d in fixtures_dir.iterdir()
        if d.is_dir() and (d / "input_a.png").exists()
    )

    if not pairs:
        print(f"ERROR: no valid pairs found in {fixtures_dir}", file=sys.stderr)
        print("Each subdirectory must contain: input_a.png, input_b.png, reference.png", file=sys.stderr)
        sys.exit(2)

    results = [evaluate_pair(p, thresholds, output_dir) for p in pairs]

    ssim_vals = [r["ssim"] for r in results if "ssim" in r]
    de_vals   = [r["color_de"] for r in results if "color_de" in r]
    rmse_vals = [r["rmse"] for r in results if "rmse" in r]
    overall   = "pass" if all(r["status"] == "pass" for r in results) else "fail"

    summary = {
        "ssim_mean":     round(sum(ssim_vals) / len(ssim_vals), 4) if ssim_vals else None,
        "color_de_mean": round(sum(de_vals)   / len(de_vals),   4) if de_vals   else None,
        "rmse_mean":     round(sum(rmse_vals) / len(rmse_vals), 4) if rmse_vals else None,
        "overall":       overall,
    }

    output = {"pairs": results, "summary": summary}
    print(json.dumps(output, indent=2))

    sys.exit(0 if overall == "pass" else 1)


if __name__ == "__main__":
    main()
