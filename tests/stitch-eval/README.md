# Stitch Quality Evaluation

Automated quality scoring for frame-forge stitch outputs.

## Structure

```
tests/stitch-eval/
  thresholds.json        # shared thresholds (Rust tests + score.py)
  gen_synthetic.sh       # generate synthetic scene_a fixtures via FFmpeg
  score.py               # batch evaluator (Pillow + numpy)
  fixtures/
    scene_a/             # Phase Correlation (anime) path
      input_a.png
      input_b.png
      reference.png
    seagull/             # Landscape (feature-matching) path
      input_a.png
      input_b.png
      reference.png
    walking_tour/        # Live-action (motion-masked AKAZE) path
      input_a.png
      input_b.png
      reference.png
```

## Thresholds

| Metric            | Direction | Value |
|-------------------|-----------|-------|
| `ssim_min`        | ≥         | 0.80  |
| `seam_grad_max`   | ≤         | 25.0  |
| `color_de_max`    | ≤         | 10.0  |
| `ransac_inlier_min` | ≥       | 0.40  |
| `rmse_max`        | ≤         | 5.0   |

## Generating scene_a fixtures (synthetic, no external data)

```bash
# Requires: FFmpeg in PATH, a reference image
./tests/stitch-eval/gen_synthetic.sh 100 path/to/reference.png
# Output: tests/stitch-eval/fixtures/scene_a/{frame_0..3,input_a,input_b,reference}.png
```

The script crops 4 horizontally-offset sub-images from the reference (default offset 100 px)
and writes `input_a.png` (offset 0), `input_b.png` (offset 100), `reference.png` (full crop).

## Acquiring SEAGULL / Walking Tour fixtures

These are optional and used only by `#[ignore]`-marked Rust tests.
They are **not** included in the repo (large binary files).

**SEAGULL dataset** (landscape stitching):
- Source: ICCV 2021 — "SEAGULL: Seam-guided Local Alignment for Parallax-tolerant Image Stitching"
- Download a representative overlapping image pair and save as:
  - `fixtures/seagull/input_a.png`, `input_b.png`, `reference.png`
- The reference is the expected stitch output (can be produced by the reference implementation).

**Walking Tour dataset** (live-action stitching):
- Any short walking-tour video with foreground/background parallax.
- Extract two consecutive frames as PNG and a manually composited reference.
- Save to `fixtures/walking_tour/`.

## Running score.py

```bash
# Prerequisites
pip install Pillow numpy

# Score a single scene
python tests/stitch-eval/score.py tests/stitch-eval/fixtures/scene_a

# Score all scenes
python tests/stitch-eval/score.py tests/stitch-eval/fixtures

# Output (JSON to stdout):
# {
#   "pairs": [{ "pair": "scene_a", "ssim": 0.92, "color_de": 3.1, "rmse": 2.4, "status": "pass" }],
#   "summary": { "ssim_mean": 0.92, "color_de_mean": 3.1, "rmse_mean": 2.4, "overall": "pass" }
# }
```

Exit codes: `0` = all pass, `1` = one or more metrics failed, `2` = fixtures_dir missing.

## Running Rust quality tests

```bash
# Inside the Docker build environment (frame-forge is Linux-only):
cargo test -p frame-forge --features opencv -- quality_tests

# GPU-dependent tests (requires FRAME_FORGE_TEST_GPU=1 + /dev/dri passthrough):
FRAME_FORGE_TEST_GPU=1 cargo test -p frame-forge --features opencv -- --ignored test_opencl_detected
```
