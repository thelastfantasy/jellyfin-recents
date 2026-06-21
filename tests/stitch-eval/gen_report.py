#!/usr/bin/env python3
"""
Auto-generate stitch quality report HTML.

Usage (called from run_demo.sh / run_demo_gpu.sh):
  python3 gen_report.py <fixtures_dir> <rust_output_dir> <legacy_rust_dir> <loftr_output_dir> <python_output_dir> <report_html> [<gpu_output_dir>]

  rust_output_dir   — LightGlue / DL-enabled Rust output
  legacy_rust_dir   — AKAZE-only (--model disabled) Rust output
  loftr_output_dir  — EfficientLoFTR (--model efficient-loftr) Rust output
  gpu_output_dir    — optional: --device cuda:0 output from run_demo_gpu.sh, with
                       gpu_verification_manifest.json (ep_used + fallback_events per
                       scene); when given, adds a GPU column with explicit proof that
                       each scene actually ran on the GPU EP rather than CPU

Calls score.py internally to collect metrics, then writes a self-contained HTML report.
"""
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent

# Scene metadata: mode and short description
SCENE_META = {
    "landscape_cmu":      {"mode": "landscape",  "desc": "CMU0 frames 14+15 · 连续帧实景全景 · 重复纹理（建筑窗格）"},
    "synthetic_landscape":{"mode": "landscape",  "desc": "CMU0 frame0 左右裁剪60% · 合成重叠（有 ground truth）★ 最可靠质量指标"},
    "walking_tour":        {"mode": "liveaction", "desc": "myself frames 05+06 · 实景运动场景"},
    "flower_landscape":    {"mode": "landscape",  "desc": "flower landscape · 自然场景"},
    "cmu1":                {"mode": "landscape",  "desc": "CMU campus · 实景全景"},
    "uav":                 {"mode": "landscape",  "desc": "UAV aerial · 航拍场景"},
    "zijing":              {"mode": "landscape",  "desc": "紫荆 · 校园场景"},
    "seagull":             {"mode": "landscape",  "desc": "seagull · 内部校验"},
}

CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', system-ui, sans-serif; background: #111; color: #e0e0e0; padding: 24px; }
h1 { font-size: 1.6rem; margin-bottom: 4px; color: #fff; }
.subtitle { color: #888; font-size: 0.9rem; margin-bottom: 32px; }
h2 { font-size: 1.2rem; color: #aad4ff; margin: 32px 0 12px; border-bottom: 1px solid #333; padding-bottom: 6px; }

.params { background: #1a1a2e; border: 1px solid #333; border-radius: 8px; padding: 16px 20px; margin-bottom: 32px; font-size: 0.85rem; line-height: 1.8; }
.params code { background: #252540; padding: 1px 6px; border-radius: 3px; font-family: 'Cascadia Code', monospace; color: #adf; }
.params table { border-collapse: collapse; width: 100%; margin-top: 10px; }
.params td { padding: 3px 12px 3px 0; vertical-align: top; }
.params td:first-child { color: #888; white-space: nowrap; }

.score-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 0.9rem; }
.score-table th { background: #1e2a3a; color: #aad4ff; padding: 8px 14px; text-align: left; font-weight: 600; }
.score-table td { padding: 8px 14px; border-bottom: 1px solid #222; }
.score-table tr:hover td { background: #1a1a1a; }
.pass { color: #4caf50; font-weight: 600; }
.fail { color: #f44336; font-weight: 600; }
.warn { color: #ff9800; font-weight: 600; }

.summary-row td { background: #1e2a1e; font-weight: 600; border-top: 2px solid #333; }

.badge { display: inline-block; font-size: 0.7rem; padding: 1px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle; }
.badge.ref    { background: #2a4a2a; color: #4caf50; }
.badge.rust   { background: #4a3010; color: #ff9800; }
.badge.legacy { background: #3a2a4a; color: #ce93d8; }
.badge.loftr  { background: #1a3a2a; color: #80cbc4; }
.badge.py     { background: #102a4a; color: #4fc3f7; }
.badge.gpu    { background: #1a4a1a; color: #69f0ae; }

.scene { background: #181818; border: 1px solid #2a2a2a; border-radius: 10px; padding: 20px; margin-bottom: 28px; }
.scene-title { font-size: 1.05rem; font-weight: 700; color: #fff; margin-bottom: 6px; }
.scene-mode { display: inline-block; background: #2a3a4a; color: #7ac4f5; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; margin-bottom: 12px; }
.img-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.img-card { background: #111; border: 1px solid #2a2a2a; border-radius: 6px; overflow: hidden; }
.img-card img { width: 100%; height: auto; display: block; }
.img-card .caption { padding: 8px 10px; font-size: 0.8rem; color: #999; }
.img-card .caption strong { color: #ccc; }
.img-card .caption .path { font-family: monospace; font-size: 0.75rem; color: #556; word-break: break-all; }
.img-card .caption .algo-tag { font-family: monospace; font-size: 0.72rem; color: #9c7; margin-top: 3px; display: block; }
.img-card.reference { border-color: #3a4a3a; }
.img-card.rust      { border-color: #4a3a2a; }
.img-card.legacy    { border-color: #3a2a4a; }
.img-card.loftr     { border-color: #1a3a2a; }
.img-card.python    { border-color: #2a3a4a; }
.img-card.gpu       { border-color: #1a4a2a; }
.img-card.input     { border-color: #2a2a3a; }
.ep-proof { font-family: monospace; font-size: 0.72rem; margin-top: 3px; display: block; }
.ep-proof.ok   { color: #69f0ae; }
.ep-proof.bad  { color: #f44336; }
.metric-inline { font-size: 0.78rem; margin-top: 4px; color: #aaa; }
.metric-inline .v { font-weight: 700; }
.metric-inline .good { color: #4caf50; }
.metric-inline .bad  { color: #f44336; }
.metric-inline .mid  { color: #ff9800; }
.delta-win { color: #69f0ae; font-size: 0.75rem; }
"""

ALGO_PARAMS_HTML = """
<div class="params">
  <table>
    <tr><td>Pass 2: LightGlue v2</td><td>LightGlue v2 ONNX → USAC-MAGSAC → 几何合理性校验 → warp_expand_blend；不通过则 fallback OpenCV Stitcher</td></tr>
    <tr><td>Pass 3: EfficientLoFTR</td><td>EfficientLoFTR ONNX（640×480 固定输入，<code>eloftr_640x480.onnx</code>，zahilaty 公开模型）→ 同上流程</td></tr>
    <tr><td>Pass 1: Legacy AKAZE</td><td><code>AKAZE + USAC-MAGSAC</code> → 几何合理性校验 → warp_expand_blend；不通过则 fallback OpenCV Stitcher（无深度学习模型）</td></tr>
    <tr><td>Pass 4: GPU (cuda:0)</td><td>同 Pass 2 LightGlue v2 流程，但 ONNX Runtime 使用 <code>CUDAExecutionProvider</code>（<code>onnxruntime-linux-x64-gpu_cuda13</code>，驱动 595.71 / RTX 5060 Blackwell sm_120）；每个场景记录 <code>ep_used</code> 与 <code>fallback_events</code>，证明真实跑在 GPU 上而非静默退回 CPU——详见 specs/012-ort-gpu-model-ui/research.md §7</td></tr>
    <tr><td>Python 参考</td><td><code>AKAZE + RANSAC + canvas expand + multi-band blend</code> (stitch_py.py)</td></tr>
    <tr><td>场景分类器</td><td>Phase correlation coherence 检测全景平移（高峰值→Landscape）vs 动态场景（低峰值→LiveAction）；Landscape 直接走 feature-match + warp，绕过 Motion mask</td></tr>
    <tr><td>几何合理性校验</td><td>DL / AKAZE 计算的单应矩阵需满足：scale ∈ [0.82, 1.22]、旋转 &lt; 10°、透视系数 &lt; 5e-4；否则 fallback OpenCV Stitcher；防止重复纹理（窗格、建筑网格）产生错误匹配</td></tr>
    <tr><td>评分</td><td><code>score.py</code> 对比 stitched.png vs reference.png (SSIM / ΔE / RMSE)；<span style="color:#4caf50">GT</span> 模式（synthetic_landscape）有真实 panorama 参照，严格阈值；<span style="color:#aaa">proxy</span> 模式 reference≈input_a，视角投影导致低 SSIM 为正常现象，使用宽松阈值</td></tr>
  </table>
</div>
"""


def load_algo_manifest(dir: Path) -> dict:
    """Load rust_algo_manifest.json → {scene: algo_name} or {}."""
    p = dir / "rust_algo_manifest.json"
    try:
        with open(p) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def run_score(fixtures_dir: Path, output_dir: Path) -> dict:
    """Return score data: read cached scores.json if present, else run score.py live."""
    cache = output_dir / "scores.json"
    if cache.exists():
        try:
            with open(cache) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    score_py = SCRIPT_DIR / "score.py"
    result = subprocess.run(
        ["python3", str(score_py), str(fixtures_dir), str(output_dir)],
        capture_output=True, text=True,
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"pairs": [], "summary": {}}


def ssim_class(v):
    if v is None: return "warn"
    if v >= 0.8: return "good"
    if v >= 0.6: return "mid"
    return "bad"

def de_class(v):
    if v is None: return "warn"
    if v <= 10: return "good"
    if v <= 20: return "mid"
    return "bad"

def rmse_class(v):
    if v is None: return "warn"
    if v <= 5: return "good"
    if v <= 30: return "mid"
    return "bad"

def status_class(s):
    return {"pass": "pass", "fail": "fail"}.get(s, "warn")

def fmt(v, digits=4):
    return f"{v:.{digits}f}" if v is not None else "—"


def build_score_table(legacy_data: dict, rust_data: dict, loftr_data: dict, py_data: dict, gpu_data: dict | None = None, gpu_manifest: dict | None = None) -> str:
    gpu_data = gpu_data or {}
    gpu_manifest = gpu_manifest or {}
    legacy_by_name = {r["pair"]: r for r in legacy_data.get("pairs", [])}
    rust_by_name   = {r["pair"]: r for r in rust_data.get("pairs", [])}
    loftr_by_name  = {r["pair"]: r for r in loftr_data.get("pairs", [])}
    py_by_name     = {r["pair"]: r for r in py_data.get("pairs", [])}
    gpu_by_name    = {r["pair"]: r for r in gpu_data.get("pairs", [])}
    all_scenes     = sorted(set(
        list(legacy_by_name.keys()) + list(rust_by_name.keys()) +
        list(loftr_by_name.keys()) + list(py_by_name.keys()) + list(gpu_by_name.keys())
    ))

    rows = ""
    for scene in all_scenes:
        leg  = legacy_by_name.get(scene, {})
        r    = rust_by_name.get(scene, {})
        loft = loftr_by_name.get(scene, {})
        p    = py_by_name.get(scene, {})
        g    = gpu_by_name.get(scene, {})
        meta = SCENE_META.get(scene, {"mode": "landscape", "desc": scene})

        rs = r.get("ssim"); ls = leg.get("ssim"); lts = loft.get("ssim"); ps = p.get("ssim"); gs = g.get("ssim")
        dl_win = ' <span class="delta-win">▲ 胜 Legacy</span>' if (
            rs is not None and ls is not None and rs > ls
        ) else ""
        loftr_win = ' <span class="delta-win">▲ 胜 Legacy</span>' if (
            lts is not None and ls is not None and lts > ls
        ) else ""
        gpu_win = ' <span class="delta-win">▲ 胜 Legacy</span>' if (
            gs is not None and ls is not None and gs > ls
        ) else ""

        score_mode = r.get("mode") or loft.get("mode") or leg.get("mode", "proxy")
        mode_badge = (
            '<span style="background:#4caf50;color:#000;font-size:0.65rem;padding:1px 5px;border-radius:3px;margin-left:4px">GT</span>'
            if score_mode == "gt" else
            '<span style="background:#555;color:#ccc;font-size:0.65rem;padding:1px 5px;border-radius:3px;margin-left:4px">proxy</span>'
        )
        gpu_entry = gpu_manifest.get(scene)
        rowspan = 5 if gpu_entry is not None else 4
        gpu_row = ""
        if gpu_entry is not None:
            fb = gpu_entry.get("fallback_events", [])
            ep_used = gpu_entry.get("ep_used", "?")
            elapsed = gpu_entry.get("elapsed_ms")
            ep_proof = (
                f'<span class="ep-proof ok">ep={ep_used} fallback=[] ({elapsed}ms)</span>'
                if not fb else
                f'<span class="ep-proof bad">ep={ep_used} fallback={fb}</span>'
            )
            gpu_row = f"""
    <tr>
      <td><span class="badge gpu">GPU cuda:0</span></td>
      <td class="{status_class(g.get('status','fail'))}">
        <span class="{ssim_class(gs)}">{fmt(gs)}</span>{gpu_win}
        {ep_proof}
      </td>
      <td><span class="{de_class(g.get('color_de'))}">{fmt(g.get('color_de'),2)}</span></td>
      <td><span class="{rmse_class(g.get('rmse'))}">{fmt(g.get('rmse'),2)}</span></td>
      <td class="{status_class(g.get('status','fail'))}">{g.get('status','—').upper()}</td>
    </tr>"""
        rows += f"""
    <tr>
      <td rowspan="{rowspan}"><strong>{scene}</strong>{mode_badge}<br><small style="color:#666">{meta['desc']}</small></td>
      <td><span class="badge legacy">Legacy</span></td>
      <td class="{status_class(leg.get('status','fail'))}">
        <span class="{ssim_class(ls)}">{fmt(ls)}</span>
      </td>
      <td><span class="{de_class(leg.get('color_de'))}">{fmt(leg.get('color_de'),2)}</span></td>
      <td><span class="{rmse_class(leg.get('rmse'))}">{fmt(leg.get('rmse'),2)}</span></td>
      <td class="{status_class(leg.get('status','fail'))}">{leg.get('status','—').upper()}</td>
    </tr>
    <tr>
      <td><span class="badge rust">LightGlue</span></td>
      <td class="{status_class(r.get('status','fail'))}">
        <span class="{ssim_class(rs)}">{fmt(rs)}</span>{dl_win}
      </td>
      <td><span class="{de_class(r.get('color_de'))}">{fmt(r.get('color_de'),2)}</span></td>
      <td><span class="{rmse_class(r.get('rmse'))}">{fmt(r.get('rmse'),2)}</span></td>
      <td class="{status_class(r.get('status','fail'))}">{r.get('status','—').upper()}</td>
    </tr>
    <tr>
      <td><span class="badge loftr">LoFTR</span></td>
      <td class="{status_class(loft.get('status','fail'))}">
        <span class="{ssim_class(lts)}">{fmt(lts)}</span>{loftr_win}
      </td>
      <td><span class="{de_class(loft.get('color_de'))}">{fmt(loft.get('color_de'),2)}</span></td>
      <td><span class="{rmse_class(loft.get('rmse'))}">{fmt(loft.get('rmse'),2)}</span></td>
      <td class="{status_class(loft.get('status','fail'))}">{loft.get('status','—').upper()}</td>
    </tr>
    <tr>
      <td><span class="badge py">Python</span></td>
      <td class="{status_class(p.get('status','fail'))}">
        <span class="{ssim_class(ps)}">{fmt(ps)}</span>
      </td>
      <td><span class="{de_class(p.get('color_de'))}">{fmt(p.get('color_de'),2)}</span></td>
      <td><span class="{rmse_class(p.get('rmse'))}">{fmt(p.get('rmse'),2)}</span></td>
      <td class="{status_class(p.get('status','fail'))}">{p.get('status','—').upper()}</td>
    </tr>{gpu_row}"""

    ls_sum   = legacy_data.get("summary", {})
    rs_sum   = rust_data.get("summary", {})
    lts_sum  = loftr_data.get("summary", {})
    ps_sum   = py_data.get("summary", {})
    gs_sum   = gpu_data.get("summary", {})
    gpu_line = f"<br>GPU cuda:0: {fmt(gs_sum.get('ssim_mean'),4)}" if gpu_manifest else ""
    gpu_de_line = f"<br>GPU cuda:0: {fmt(gs_sum.get('color_de_mean'),2)}" if gpu_manifest else ""
    gpu_rmse_line = f"<br>GPU cuda:0: {fmt(gs_sum.get('rmse_mean'),2)}" if gpu_manifest else ""
    summary_row = f"""
    <tr class="summary-row">
      <td colspan="2"><strong>Mean (全部场景)</strong></td>
      <td>Legacy: {fmt(ls_sum.get('ssim_mean'),4)}<br>LightGlue: {fmt(rs_sum.get('ssim_mean'),4)}<br>LoFTR: {fmt(lts_sum.get('ssim_mean'),4)}<br>Python: {fmt(ps_sum.get('ssim_mean'),4)}{gpu_line}</td>
      <td>Legacy: {fmt(ls_sum.get('color_de_mean'),2)}<br>LightGlue: {fmt(rs_sum.get('color_de_mean'),2)}<br>LoFTR: {fmt(lts_sum.get('color_de_mean'),2)}<br>Python: {fmt(ps_sum.get('color_de_mean'),2)}{gpu_de_line}</td>
      <td>Legacy: {fmt(ls_sum.get('rmse_mean'),2)}<br>LightGlue: {fmt(rs_sum.get('rmse_mean'),2)}<br>LoFTR: {fmt(lts_sum.get('rmse_mean'),2)}<br>Python: {fmt(ps_sum.get('rmse_mean'),2)}{gpu_rmse_line}</td>
      <td></td>
    </tr>"""

    return f"""
<table class="score-table">
  <thead>
    <tr>
      <th>Scene</th><th>Engine</th>
      <th>SSIM ↑ (≥0.8)</th><th>ΔE ↓ (≤10)</th><th>RMSE ↓ (≤5)</th><th>Status</th>
    </tr>
  </thead>
  <tbody>{rows}{summary_row}
  </tbody>
</table>
<p style="color:#888;font-size:0.85rem;margin-top:-16px;margin-bottom:28px;">
  注：<strong>seagull</strong> 为内部校验（reference=input_a，SSIM=1.0 是平凡结果）。<br>
  <strong>synthetic_landscape</strong> 有真实 ground truth，是唯一可靠的拼接质量测试。<br>
  其余场景 reference=input_a，SSIM 仅反映"输出与输入A的相似度"，非绝对拼接质量。
</p>"""


def build_scene_section(
    scene: str,
    fixtures_dir: Path,
    rust_dir: Path,
    legacy_dir: Path,
    loftr_dir: Path,
    py_dir: Path,
    rust_r: dict,
    legacy_r: dict,
    loftr_r: dict,
    py_r: dict,
    algo_map_new: dict,
    algo_map_legacy: dict,
    algo_map_loftr: dict,
    gpu_dir: Path | None = None,
    gpu_r: dict | None = None,
    gpu_manifest_entry: dict | None = None,
) -> str:
    meta = SCENE_META.get(scene, {"mode": "landscape", "desc": scene})
    fix = fixtures_dir / scene
    ra = fix / "input_a.png"
    rb = fix / "input_b.png"
    rr = fix / "reference.png"
    ro_new    = rust_dir   / f"{scene}_stitched.png"
    ro_legacy = legacy_dir / f"{scene}_stitched.png"
    ro_loftr  = loftr_dir  / f"{scene}_stitched.png"
    po        = py_dir     / f"{scene}_stitched.png"
    ro_gpu    = (gpu_dir / f"{scene}_stitched.png") if gpu_dir is not None else None

    def rel(p: Path) -> str:
        try:
            return str(p.resolve().relative_to(SCRIPT_DIR)).replace("\\", "/")
        except ValueError:
            return str(p).replace("\\", "/")

    def file_gen_time(p: Path) -> str:
        try:
            ts = os.path.getmtime(p)
            return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
        except OSError:
            return "—"

    cards = ""

    # ── Input images ────────────────────────────────────────────────────────────
    if ra.exists():
        cards += f"""
    <div class="img-card input">
      <img src="{rel(ra)}" loading="lazy">
      <div class="caption"><strong>Input A</strong><br><span class="path">{rel(ra)}</span></div>
    </div>"""
    if rb.exists():
        cards += f"""
    <div class="img-card input">
      <img src="{rel(rb)}" loading="lazy">
      <div class="caption"><strong>Input B</strong><br><span class="path">{rel(rb)}</span></div>
    </div>"""

    # ── Legacy Rust (AKAZE / OpenCV, no DL) ─────────────────────────────────────
    leg_algo = algo_map_legacy.get(scene, "AKAZE + USAC-MAGSAC")
    ls = legacy_r.get("ssim"); ld = legacy_r.get("color_de"); lm = legacy_r.get("rmse")
    if ro_legacy.exists():
        cards += f"""
    <div class="img-card legacy">
      <img src="{rel(ro_legacy)}" loading="lazy">
      <div class="caption"><strong>Rust Legacy</strong> <span class="badge legacy">Legacy</span><br>
        <span class="algo-tag">algo: {leg_algo}</span>
        <span class="path">{rel(ro_legacy)}</span>
        <div class="metric-inline">
          SSIM <span class="v {ssim_class(ls)}">{fmt(ls)}</span> ·
          ΔE <span class="v {de_class(ld)}">{fmt(ld,2)}</span> ·
          RMSE <span class="v {rmse_class(lm)}">{fmt(lm,2)}</span>
        </div>
        <div class="metric-inline" style="color:#666">生成时间：{file_gen_time(ro_legacy)}</div>
      </div>
    </div>"""

    # ── New Rust (LightGlue + fallback cascade) ──────────────────────────────────
    new_algo = algo_map_new.get(scene, "LightGlue v2")
    rs = rust_r.get("ssim"); rd = rust_r.get("color_de"); rm = rust_r.get("rmse")
    win_tag = ' <span class="delta-win">▲ 胜 Legacy</span>' if (
        rs is not None and ls is not None and rs > ls
    ) else ""
    if ro_new.exists():
        cards += f"""
    <div class="img-card rust">
      <img src="{rel(ro_new)}" loading="lazy">
      <div class="caption"><strong>Rust LightGlue</strong> <span class="badge rust">LightGlue</span><br>
        <span class="algo-tag">algo: {new_algo}</span>
        <span class="path">{rel(ro_new)}</span>
        <div class="metric-inline">
          SSIM <span class="v {ssim_class(rs)}">{fmt(rs)}</span> ·
          ΔE <span class="v {de_class(rd)}">{fmt(rd,2)}</span> ·
          RMSE <span class="v {rmse_class(rm)}">{fmt(rm,2)}</span>
          {win_tag}
        </div>
        <div class="metric-inline" style="color:#666">生成时间：{file_gen_time(ro_new)}</div>
      </div>
    </div>"""

    # ── EfficientLoFTR ───────────────────────────────────────────────────────────
    loftr_algo = algo_map_loftr.get(scene, "EfficientLoFTR")
    lts = loftr_r.get("ssim"); ltd = loftr_r.get("color_de"); ltm = loftr_r.get("rmse")
    loftr_win = ' <span class="delta-win">▲ 胜 Legacy</span>' if (
        lts is not None and ls is not None and lts > ls
    ) else ""
    if ro_loftr.exists():
        cards += f"""
    <div class="img-card loftr">
      <img src="{rel(ro_loftr)}" loading="lazy">
      <div class="caption"><strong>Rust LoFTR</strong> <span class="badge loftr">LoFTR</span><br>
        <span class="algo-tag">algo: {loftr_algo}</span>
        <span class="path">{rel(ro_loftr)}</span>
        <div class="metric-inline">
          SSIM <span class="v {ssim_class(lts)}">{fmt(lts)}</span> ·
          ΔE <span class="v {de_class(ltd)}">{fmt(ltd,2)}</span> ·
          RMSE <span class="v {rmse_class(ltm)}">{fmt(ltm,2)}</span>
          {loftr_win}
        </div>
        <div class="metric-inline" style="color:#666">生成时间：{file_gen_time(ro_loftr)}</div>
      </div>
    </div>"""

    # ── Python reference ─────────────────────────────────────────────────────────
    ps = py_r.get("ssim"); pd = py_r.get("color_de"); pm = py_r.get("rmse")
    if po.exists():
        cards += f"""
    <div class="img-card python">
      <img src="{rel(po)}" loading="lazy">
      <div class="caption"><strong>Python AKAZE</strong> <span class="badge py">Python</span><br>
        <span class="algo-tag">algo: AKAZE + RANSAC + multi-band blend</span>
        <span class="path">{rel(po)}</span>
        <div class="metric-inline">
          SSIM <span class="v {ssim_class(ps)}">{fmt(ps)}</span> ·
          ΔE <span class="v {de_class(pd)}">{fmt(pd,2)}</span> ·
          RMSE <span class="v {rmse_class(pm)}">{fmt(pm,2)}</span>
        </div>
        <div class="metric-inline" style="color:#666">生成时间：{file_gen_time(po)}</div>
      </div>
    </div>"""

    # ── GPU (cuda:0) — DL matching actually run on the CUDA EP, not CPU ──────────
    if ro_gpu is not None and ro_gpu.exists():
        gpu_r = gpu_r or {}
        gss = gpu_r.get("ssim"); gde = gpu_r.get("color_de"); grm = gpu_r.get("rmse")
        entry = gpu_manifest_entry or {}
        fb = entry.get("fallback_events", [])
        ep_used = entry.get("ep_used", "?")
        elapsed = entry.get("elapsed_ms")
        ep_proof = (
            f'<span class="ep-proof ok">ep={ep_used} fallback_events=[] elapsed={elapsed}ms — 真实跑在 GPU 上，非静默 CPU fallback</span>'
            if not fb else
            f'<span class="ep-proof bad">ep={ep_used} fallback_events={fb} — 本场景退回了 CPU</span>'
        )
        cards += f"""
    <div class="img-card gpu">
      <img src="{rel(ro_gpu)}" loading="lazy">
      <div class="caption"><strong>GPU (cuda:0)</strong> <span class="badge gpu">GPU</span><br>
        <span class="algo-tag">algo: LightGlue v2 (CUDAExecutionProvider)</span>
        <span class="path">{rel(ro_gpu)}</span>
        <div class="metric-inline">
          SSIM <span class="v {ssim_class(gss)}">{fmt(gss)}</span> ·
          ΔE <span class="v {de_class(gde)}">{fmt(gde,2)}</span> ·
          RMSE <span class="v {rmse_class(grm)}">{fmt(grm,2)}</span>
        </div>
        {ep_proof}
        <div class="metric-inline" style="color:#666">生成时间：{file_gen_time(ro_gpu)}</div>
      </div>
    </div>"""

    # ── Reference ────────────────────────────────────────────────────────────────
    if rr.exists():
        is_gt = scene == "synthetic_landscape"
        gt_label = '<small style="color:#4caf50">真实 ground truth</small>' if is_gt else '<small style="color:#666">= input_a (proxy)</small>'
        cards += f"""
    <div class="img-card reference">
      <img src="{rel(rr)}" loading="lazy">
      <div class="caption"><strong>Reference</strong> <span class="badge ref">{'ground truth' if is_gt else 'ref'}</span><br>
        <span class="path">{rel(rr)}</span><br>{gt_label}
      </div>
    </div>"""

    return f"""
<div class="scene">
  <div class="scene-title">Scene: {scene}</div>
  <div class="scene-mode">mode: {meta['mode']} · {meta['desc']}</div>
  <div class="img-row">{cards}
  </div>
</div>"""


def load_gpu_manifest(dir: Path) -> dict:
    """Load gpu_verification_manifest.json → {scene: {ep_used, fallback_events, elapsed_ms}} or {}."""
    p = dir / "gpu_verification_manifest.json"
    try:
        with open(p) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def generate(fixtures_dir: Path, rust_dir: Path, legacy_dir: Path, loftr_dir: Path, py_dir: Path, out_html: Path, gpu_dir: Path | None = None):
    # Resolve to absolute so rel() can compute correct relative paths regardless
    # of whether callers pass relative or absolute paths.
    fixtures_dir = fixtures_dir.resolve()
    rust_dir     = rust_dir.resolve()
    legacy_dir   = legacy_dir.resolve()
    loftr_dir    = loftr_dir.resolve()
    py_dir       = py_dir.resolve()
    out_html     = out_html.resolve()
    gpu_dir      = gpu_dir.resolve() if gpu_dir is not None and gpu_dir.is_dir() else None

    print("[gen_report] Scoring Legacy Rust output ...", file=sys.stderr)
    legacy_data = run_score(fixtures_dir, legacy_dir)
    print("[gen_report] Scoring LightGlue Rust output ...", file=sys.stderr)
    rust_data   = run_score(fixtures_dir, rust_dir)
    print("[gen_report] Scoring EfficientLoFTR Rust output ...", file=sys.stderr)
    loftr_data  = run_score(fixtures_dir, loftr_dir)
    print("[gen_report] Scoring Python output ...", file=sys.stderr)
    py_data     = run_score(fixtures_dir, py_dir)
    gpu_data    = {}
    gpu_manifest = {}
    if gpu_dir is not None:
        print("[gen_report] Scoring GPU (cuda:0) output ...", file=sys.stderr)
        gpu_data     = run_score(fixtures_dir, gpu_dir)
        gpu_manifest = load_gpu_manifest(gpu_dir)

    algo_map_new    = load_algo_manifest(rust_dir)
    algo_map_legacy = load_algo_manifest(legacy_dir)
    algo_map_loftr  = load_algo_manifest(loftr_dir)

    legacy_by_name = {r["pair"]: r for r in legacy_data.get("pairs", [])}
    rust_by_name   = {r["pair"]: r for r in rust_data.get("pairs", [])}
    loftr_by_name  = {r["pair"]: r for r in loftr_data.get("pairs", [])}
    py_by_name     = {r["pair"]: r for r in py_data.get("pairs", [])}
    gpu_by_name    = {r["pair"]: r for r in gpu_data.get("pairs", [])}

    all_scenes = sorted(set(
        list(legacy_by_name.keys()) + list(rust_by_name.keys()) +
        list(loftr_by_name.keys()) + list(py_by_name.keys()) + list(gpu_by_name.keys())
    ))

    score_table = build_score_table(legacy_data, rust_data, loftr_data, py_data, gpu_data, gpu_manifest)

    scene_sections = "".join(
        build_scene_section(
            s, fixtures_dir, rust_dir, legacy_dir, loftr_dir, py_dir,
            rust_by_name.get(s, {}),
            legacy_by_name.get(s, {}),
            loftr_by_name.get(s, {}),
            py_by_name.get(s, {}),
            algo_map_new,
            algo_map_legacy,
            algo_map_loftr,
            gpu_dir,
            gpu_by_name.get(s, {}),
            gpu_manifest.get(s),
        )
        for s in all_scenes
        if s != "seagull"
    )

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    engines_line = "Legacy AKAZE · LightGlue v2 · EfficientLoFTR · Python AKAZE"
    if gpu_dir is not None:
        engines_line += " · GPU cuda:0"
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stitch Quality Report — frame-forge</title>
<style>{CSS}</style>
</head>
<body>

<h1>Stitch Quality Report</h1>
<div class="subtitle">
  frame-forge — LightGlue v2（新）vs Legacy AKAZE（旧）vs Python AKAZE 参考<br>
  Generated: {now} &nbsp;|&nbsp; Branch: feature/009-frame-export-stitch &nbsp;|&nbsp; Engines: {engines_line}
</div>

<h2>算法参数</h2>
{ALGO_PARAMS_HTML}

<h2>评分汇总</h2>
{score_table}

<h2>场景详情</h2>
{scene_sections}

</body>
</html>"""

    out_html.write_text(html, encoding="utf-8")
    print(f"[gen_report] Report written → {out_html}", file=sys.stderr)


def main():
    if len(sys.argv) < 7:
        print(
            f"Usage: {sys.argv[0]} <fixtures_dir> <rust_output_dir> <legacy_rust_dir> <loftr_output_dir> <python_output_dir> <report_html> [<gpu_output_dir>]",
            file=sys.stderr,
        )
        sys.exit(2)
    generate(
        fixtures_dir=Path(sys.argv[1]),
        rust_dir=Path(sys.argv[2]),
        legacy_dir=Path(sys.argv[3]),
        loftr_dir=Path(sys.argv[4]),
        py_dir=Path(sys.argv[5]),
        out_html=Path(sys.argv[6]),
        gpu_dir=Path(sys.argv[7]) if len(sys.argv) > 7 else None,
    )


if __name__ == "__main__":
    main()
