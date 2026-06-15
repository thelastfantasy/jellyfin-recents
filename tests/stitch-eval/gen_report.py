#!/usr/bin/env python3
"""
Auto-generate stitch quality report HTML.

Usage (called from run_demo.sh):
  python3 gen_report.py <fixtures_dir> <rust_output_dir> <python_output_dir> <report_html>

Calls score.py internally to collect metrics, then writes a self-contained HTML report.
"""
import json
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
.badge.ref  { background: #2a4a2a; color: #4caf50; }
.badge.rust { background: #4a3010; color: #ff9800; }
.badge.py   { background: #102a4a; color: #4fc3f7; }

.scene { background: #181818; border: 1px solid #2a2a2a; border-radius: 10px; padding: 20px; margin-bottom: 28px; }
.scene-title { font-size: 1.05rem; font-weight: 700; color: #fff; margin-bottom: 6px; }
.scene-mode { display: inline-block; background: #2a3a4a; color: #7ac4f5; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; margin-bottom: 12px; }
.img-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.img-card { background: #111; border: 1px solid #2a2a2a; border-radius: 6px; overflow: hidden; }
.img-card img { width: 100%; height: auto; display: block; }
.img-card .caption { padding: 8px 10px; font-size: 0.8rem; color: #999; }
.img-card .caption strong { color: #ccc; }
.img-card .caption .path { font-family: monospace; font-size: 0.75rem; color: #556; word-break: break-all; }
.img-card.reference { border-color: #3a4a3a; }
.img-card.rust      { border-color: #4a3a2a; }
.img-card.python    { border-color: #2a3a4a; }
.img-card.input     { border-color: #2a2a3a; }
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
    <tr><td>Rust 算法</td><td><code>SIFT</code> (OpenCV 4.6, 5-param) + CrossCheck BFMatcher + 位移一致性过滤 + RANSAC(3.0px) + inlier≥10 + 几何合理性检验 + 曝光补偿 + <strong>Laplacian Pyramid 4级多频段融合</strong></td></tr>
    <tr><td>Python 参考</td><td><code>AKAZE + RANSAC + canvas expand + multi-band blend</code> (stitch_py.py)</td></tr>
    <tr><td>位移一致性过滤</td><td>CrossCheck 后取中位数 (dx,dy)，保留偏差 &lt;15% img_w 的点 — 去除重复纹理假匹配</td></tr>
    <tr><td>几何合理性检验</td><td>scale∈[0.5,2.0], rotation&lt;45°, perspective&lt;5e-4, translation&lt;2×dims</td></tr>
    <tr><td>曝光补偿</td><td>overlap 区域 A/B 各通道亮度比 → 对 B 施加全局增益 (clamp 0.6–1.6)</td></tr>
    <tr><td>Laplacian Pyramid 融合</td><td>4级：L[k]=G[k]-up(G[k+1])，各级 Gaussian mask 加权后 collapse；低频大范围平滑，高频局部精确</td></tr>
    <tr><td>warp 方向</td><td>M = T_off · H_inv（<code>warpPerspective</code> 逆映射，非 H·T⁻¹）</td></tr>
    <tr><td>构建</td><td><code>cargo clean -p frame-forge &amp;&amp; cargo build -p frame-forge --features "cli,opencv" --release</code> (Ubuntu 24.04 Docker)</td></tr>
    <tr><td>评分</td><td><code>score.py</code> 对比 stitched.png vs reference.png (SSIM / ΔE / RMSE)；仅 synthetic_landscape 有 ground truth</td></tr>
  </table>
</div>
"""


def run_score(fixtures_dir: Path, output_dir: Path) -> dict:
    """Run score.py and return parsed JSON."""
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


def build_score_table(rust_data: dict, py_data: dict) -> str:
    rust_by_name = {r["pair"]: r for r in rust_data.get("pairs", [])}
    py_by_name   = {r["pair"]: r for r in py_data.get("pairs", [])}
    all_scenes   = sorted(set(list(rust_by_name.keys()) + list(py_by_name.keys())))

    rows = ""
    for scene in all_scenes:
        r = rust_by_name.get(scene, {})
        p = py_by_name.get(scene, {})
        meta = SCENE_META.get(scene, {"mode": "landscape", "desc": scene})
        # skip seagull trivial scene from visual table? keep it for completeness
        rs = r.get("ssim"); ps = p.get("ssim")
        delta = ""
        if rs is not None and ps is not None:
            if rs > ps:
                delta = f' <span class="delta-win">▲ 胜 Python</span>'

        rows += f"""
    <tr>
      <td rowspan="2"><strong>{scene}</strong><br><small style="color:#666">{meta['desc']}</small></td>
      <td><span class="badge rust">Rust</span></td>
      <td class="{status_class(r.get('status','fail'))}">
        <span class="{ssim_class(rs)}">{fmt(rs)}</span>{delta}
      </td>
      <td class="{de_class(r.get('color_de'))}">
        <span class="{de_class(r.get('color_de'))}">{fmt(r.get('color_de'),2)}</span>
      </td>
      <td class="{rmse_class(r.get('rmse'))}">
        <span class="{rmse_class(r.get('rmse'))}">{fmt(r.get('rmse'),2)}</span>
      </td>
      <td class="{status_class(r.get('status','fail'))}">{r.get('status','—').upper()}</td>
    </tr>
    <tr>
      <td><span class="badge py">Python</span></td>
      <td class="{status_class(p.get('status','fail'))}">
        <span class="{ssim_class(ps)}">{fmt(ps)}</span>
      </td>
      <td class="{de_class(p.get('color_de'))}">
        <span class="{de_class(p.get('color_de'))}">{fmt(p.get('color_de'),2)}</span>
      </td>
      <td class="{rmse_class(p.get('rmse'))}">
        <span class="{rmse_class(p.get('rmse'))}">{fmt(p.get('rmse'),2)}</span>
      </td>
      <td class="{status_class(p.get('status','fail'))}">{p.get('status','—').upper()}</td>
    </tr>"""

    rs = rust_data.get("summary", {})
    ps = py_data.get("summary", {})
    summary_row = f"""
    <tr class="summary-row">
      <td colspan="2"><strong>Mean (全部场景)</strong></td>
      <td>Rust: {fmt(rs.get('ssim_mean'),4)}<br>Python: {fmt(ps.get('ssim_mean'),4)}</td>
      <td>Rust: {fmt(rs.get('color_de_mean'),2)}<br>Python: {fmt(ps.get('color_de_mean'),2)}</td>
      <td>Rust: {fmt(rs.get('rmse_mean'),2)}<br>Python: {fmt(ps.get('rmse_mean'),2)}</td>
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


def build_scene_section(scene: str, fixtures_dir: Path, rust_dir: Path, py_dir: Path,
                        rust_r: dict, py_r: dict) -> str:
    meta = SCENE_META.get(scene, {"mode": "landscape", "desc": scene})
    fix = fixtures_dir / scene
    ra = fix / "input_a.png"
    rb = fix / "input_b.png"
    rr = fix / "reference.png"
    ro = rust_dir / f"{scene}_stitched.png"
    po = py_dir   / f"{scene}_stitched.png"

    def rel(p: Path) -> str:
        try:
            return str(p.relative_to(SCRIPT_DIR)).replace("\\", "/")
        except ValueError:
            return str(p)

    # input cards (only if files exist)
    cards = ""
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
    if rr.exists():
        is_gt = scene == "synthetic_landscape"
        gt_label = '<small style="color:#4caf50">真实 ground truth</small>' if is_gt else '<small style="color:#666">= input_a (proxy)</small>'
        cards += f"""
    <div class="img-card reference">
      <img src="{rel(rr)}" loading="lazy">
      <div class="caption"><strong>Reference</strong> <span class="badge ref">{'ground truth' if is_gt else 'ref'}</span><br><span class="path">{rel(rr)}</span><br>{gt_label}</div>
    </div>"""

    # Rust output
    rs = rust_r.get("ssim"); rd = rust_r.get("color_de"); rm = rust_r.get("rmse")
    win_tag = ' <span class="delta-win">▲ 胜 Python</span>' if (
        rs is not None and py_r.get("ssim") is not None and rs > py_r.get("ssim")
    ) else ""
    if ro.exists():
        cards += f"""
    <div class="img-card rust">
      <img src="{rel(ro)}" loading="lazy">
      <div class="caption"><strong>Rust ({meta['mode']})</strong> <span class="badge rust">Rust</span><br><span class="path">{rel(ro)}</span>
        <div class="metric-inline">
          SSIM <span class="v {ssim_class(rs)}">{fmt(rs)}</span> ·
          ΔE <span class="v {de_class(rd)}">{fmt(rd,2)}</span> ·
          RMSE <span class="v {rmse_class(rm)}">{fmt(rm,2)}</span>
          {win_tag}
        </div>
      </div>
    </div>"""

    # Python output
    ps = py_r.get("ssim"); pd = py_r.get("color_de"); pm = py_r.get("rmse")
    if po.exists():
        cards += f"""
    <div class="img-card python">
      <img src="{rel(po)}" loading="lazy">
      <div class="caption"><strong>Python AKAZE</strong> <span class="badge py">Python</span><br><span class="path">{rel(po)}</span>
        <div class="metric-inline">
          SSIM <span class="v {ssim_class(ps)}">{fmt(ps)}</span> ·
          ΔE <span class="v {de_class(pd)}">{fmt(pd,2)}</span> ·
          RMSE <span class="v {rmse_class(pm)}">{fmt(pm,2)}</span>
        </div>
      </div>
    </div>"""

    return f"""
<div class="scene">
  <div class="scene-title">Scene: {scene}</div>
  <div class="scene-mode">mode: {meta['mode']} · {meta['desc']}</div>
  <div class="img-row">{cards}
  </div>
</div>"""


def generate(fixtures_dir: Path, rust_dir: Path, py_dir: Path, out_html: Path):
    print("[gen_report] Scoring Rust output ...", file=sys.stderr)
    rust_data = run_score(fixtures_dir, rust_dir)
    print("[gen_report] Scoring Python output ...", file=sys.stderr)
    py_data   = run_score(fixtures_dir, py_dir)

    rust_by_name = {r["pair"]: r for r in rust_data.get("pairs", [])}
    py_by_name   = {r["pair"]: r for r in py_data.get("pairs",   [])}

    all_scenes = sorted(set(list(rust_by_name.keys()) + list(py_by_name.keys())))

    score_table = build_score_table(rust_data, py_data)

    scene_sections = "".join(
        build_scene_section(
            s, fixtures_dir, rust_dir, py_dir,
            rust_by_name.get(s, {}), py_by_name.get(s, {}),
        )
        for s in all_scenes
        if s != "seagull"   # seagull is trivial (reference=input_a), skip from visual section
    )

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
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
  frame-forge — SIFT + CrossCheck + Displacement Filter + Laplacian Pyramid Blend vs Python AKAZE 参考<br>
  Generated: {now} &nbsp;|&nbsp; Branch: feature/009-frame-export-stitch
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
    if len(sys.argv) < 5:
        print(f"Usage: {sys.argv[0]} <fixtures_dir> <rust_output_dir> <python_output_dir> <report_html>",
              file=sys.stderr)
        sys.exit(2)
    generate(
        fixtures_dir=Path(sys.argv[1]),
        rust_dir=Path(sys.argv[2]),
        py_dir=Path(sys.argv[3]),
        out_html=Path(sys.argv[4]),
    )


if __name__ == "__main__":
    main()
