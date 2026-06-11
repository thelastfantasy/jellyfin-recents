# Research: Frame Export & Stitch

**Feature**: 009-frame-forge-stitch  
**Date**: 2026-05-26

---

## Decision 1: 帧解码方�?
**Decision**: 使用 `ffmpeg-next` crate 内存解码，复�?seek-preview �?`decoder.rs` 核心逻辑�?
**Rationale**:
- seek-preview daemon 已验�?ffmpeg-next �?Docker 容器中正常工�?- 内存解码避免临时文件 I/O�?0 帧全分辨率解码在 seek-preview 已证�?�?50ms/�?- slice threading 配置�?seek-preview 保持一致（`thread_count = num_cpus.min(4)`�?- 缩略图请求传 `width=320` 走压缩路径，生成请求�?`width=0` 走原图路�?
**Alternatives considered**: ffmpeg CLI 子进程（需临时文件 + I/O 开销），Rust `image` crate 直接解码（不支持视频容器格式）�?
---

## Decision 2: 全景拼接 �?场景分类与算法路�?
**Decision**: 轻量启发式分类器（颜色熵 + Canny 边缘密度 + 帧间差分）将场景分为三类，分别走三条算法路径�?
**Rationale**:
- 单一算法无法覆盖所有场景：ORB/SIFT 在动漫纯色区域失效，Phase Correlation 在真人前景运动场景精度不�?- 分类器仅需 3 个信号的阈值判断，计算量极低（< 1ms），�?Rust `image` crate 中即可实�?- 三类覆盖�?95% 常见视频内容

**场景 A（动�?动画）→ Phase Correlation + rustfft**:
- 不依赖特征点，天然适合大面积纯�?+ 线条密集场景
- `rustfft` crate 成熟可靠，无需 OpenCV 依赖
- 亚像素精度通过抛物线插值实现（1/10 px�?- 实现复杂度：中等

**场景 B（风�?低纹理）�?AKAZE + Phase Correlation 兜底**:
- 高纹�?ROI 掩码（梯度幅值阈值）限定特征检测区�?- AKAZE 对边缘线条比 ORB 更稳定，Apache 2.0 协议
- 内点数不足时自动降级�?Phase Correlation
- 宽画幅（>5 帧）使用柱面投影
- 实现复杂度：中等（需 opencv crate�?
**场景 C（真�?前景运动）→ 帧差掩码 + AKAZE + 多帧聚合**:
- 帧差掩码排除前景运动区域的关键点
- RANSAC 仅对静态背景特征点估计 Homography
- 多帧 Homography 取分量中值（鲁棒聚合，平滑偶发干扰）
- 实现复杂度：中偏难（需 opencv crate�?
**Alternatives considered**: 
- 纯深度学习方案（UDIS++、StabStitch++）：CPU 推理 > 500ms/帧，不实�?- �?OpenCV 一条路径：动漫场景准确率低

---

## Decision 3: OpenCV Rust crate 引入

**Decision**: 使用 `opencv` crate（twistedfall/opencv-rust），Docker 中通过 `apt install libopencv-dev` 引入。仅用于场景 B/C �?AKAZE + BFMatcher + RANSAC + findHomography。场�?A �?Phase Correlation �?`rustfft`，不依赖 OpenCV�?
**Rationale**:
- 自实�?AKAZE/RANSAC/SVD �?Rust 中约需 3-6 个月
- `opencv` crate 已成熟（1k+ GitHub stars），Apache 2.0 协议
- Docker 镜像�?`libopencv-dev` �?50MB 额外体积（可接受�?- �?compile 时链接，不增大运行时内存

**Alternatives considered**: 自实现所有算法（工作量不可行），调用 Python 脚本（IPC 开销 + 额外进程管理）�?
---

## Decision 4: GPU 加速策�?
**Decision**: 默认�?CPU。启动时通过 `opencv::core::ocl::haveOpenCL()` 检�?OpenCL 可用性；若可用且显存 > 1GB，对 Warp/Blending 阶段启用 OpenCL 加速。不可用时静�?CPU fallback�?
**Rationale**:
- 加速比有限�?.5-2x），主要瓶颈 AKAZE 特征提取不受益于 GPU
- Intel Arc A310 �?4GB 显存，高分辨率全景图可能溢出（CPU 无此限制�?- Docker 透传 GPU 需额外配置（`--device /dev/dri` + `intel-compute-runtime`），不应强制
- 静默 fallback 避免用户在未配置 GPU 时收到错�?
**Alternatives considered**: 强制要求 GPU（Docker 部署复杂度不可接受），完全不考虑 GPU（浪费已有硬件）�?
---

## Decision 5: 动画编码

**Decision**: GIF �?`gif` crate（纯 Rust），WebP �?`webp` crate（C 绑定 `libwebp`）。均在内存中完成编码，不写临时文件�?
**Rationale**:
- `gif` crate 支持调色板量化（256 色），适合简单动�?- `webp` crate 支持有损/无损/透明，Docker �?`libwebp-dev` 已存在（ffmpeg 依赖链）
- 编码耗时小（< 1s for 10 frames @480p），不成为瓶�?- 分辨率缩放通过 `image` crate �?`resize`（Lanczos3）在编码前完�?
**Alternatives considered**: ffmpeg CLI（需临时文件），imagequant 优化调色板（复杂度过高，v1 先用 `gif` crate 默认量化）�?
---

## Decision 6: 帧质量检�?
**Decision**: 三重检测——亮度直方图方差（黑/白帧）�?×3 Laplacian 方差（模糊帧）、帧间像素差异（转场检测）。全部在 Rust `image` crate 中实现。pHash 用于近重复帧检测（全景拼接预处理专用）�?
**Rationale**:
- 全部计算量极低（< 5ms/�?@1080p），无外部依�?- 三重覆盖了最常见的垃圾帧类型
- pHash 与帧质量检测解耦——垃圾帧检测用于所有场景，pHash 仅用于全景拼接的冗余帧剔�?
**Alternatives considered**: SSIM（计算量过大），深度学习质量模型（推理耗时不可接受）�?
---

## Decision 7: IPC 协议

**Decision**: 复用 seek-preview �?Unix domain socket + 二进制帧协议，扩展三种新消息类型�?x10 SINGLE_FRAME, 0x11 ANIMATE, 0x12 STITCH）�?
**Rationale**:
- seek-preview 已验证二进制协议帧解析的高效性和可靠�?- 共享 Unix socket 文件路径（`{DataPath}/jfs-frame-forge.sock`，独立于 seek-preview �?`jfs-seek-preview.sock`�?- 每任务通过 mpsc channel �?C# 推送进度事件，C# 桥接�?SSE

**Alternatives considered**: HTTP REST 内部通信（延迟高，不适合流式进度推送），gRPC（额外依�?+ protobuf 编译步骤）�?
---

## Decision 8: 前端 CSS 框架

**Decision**: 使用 AliveUI（`aliveui` npm package）全量替�?player-enhancer �?`styles.ts` 自定�?CSS。所有组件（OSD 按钮、亮�?音量指示器、速度 OSD、seek OSD、截�?UI、帧选择�?Modal）统一使用 @alivecss/aliveui 语义类名和内联工具类�?
**Rationale**:
- 统一样式体系降低维护成本（无需同时维护两套 CSS 范式�?- @alivecss/aliveui 提供响应式网格、Modal、表单控件、进度条等开箱即用组�?- �?Preact 兼容（AliveUI 是纯 CSS 框架，无 JS 运行时依赖）

**Alternatives considered**: �?Modal 使用 AliveUI（风格不一致，两套 CSS 混用增加认知负担），继续手写 CSS（需处理大量新组件样式，工作量更大）�?
---

---

## 测试素材与数据集（场景 B 风景 / 场景 C 真人）

> 动漫（场景 A）已通过内部测试；以下专门针对场景 B/C 的 OpenCV 路径补充可复现的测试素材来源。

---

### 类型一：学术标准数据集（首选，可量化对比）

#### Brown's Autostitch Dataset（UBC）

- **地址**: `http://cs.bath.ac.uk/brown/autostitch/autostitch.html`（页面含 dataset 链接）
- **内容**: 户外风景（山脊、建筑群）+ 带有零散行人的广场序列
- **测试场景 B 要点**:
  - 天空大面积低纹理区 → 验证 AKAZE 是否会在天空边界产生错误匹配
  - 镜头暗角渐变 → 验证曝光补偿（`equalizeHist` 或手动增益）是否消除明显亮度接缝
- **测试场景 C 要点**:
  - 行人穿越重叠区 → 验证帧差掩码是否正确排除人体区域
  - 检查输出是否有明显鬼影（Ghosting）

#### Adobe Panorama Dataset

- **地址**: 搜索 `site:github.com adobe panorama dataset` 或直接访问 Adobe Research 主页
- **内容**: 高分辨率城市风光 + 自然风光，含远近景复合构图
- **测试重点**: Multi-band Blending 接缝质量；对比开启/关闭 `BLENDER_MULTIBAND` 的输出

#### SEAGULL Dataset（用于有监督误差评估）

- **论文**: *SEAGULL: Seam-guided Local Alignment for Parallax-tolerant Image Stitching* (ECCV 2024)
- **GitHub**: `github.com/PRIS-CV/SEAGULL`
- **获取**:
  ```bash
  gh api repos/PRIS-CV/SEAGULL/releases --jq '.[0].assets[].browser_download_url'
  # 或直接 clone，数据集在 data/ 目录
  git clone https://github.com/PRIS-CV/SEAGULL --depth 1
  ```
- **价值**: 提供 Ground Truth homography，可定量计算拼接误差（RMSE），直接对应 Decision 2 场景 B/C

#### UDIS-D（Unsupervised Deep Image Stitching Dataset）

- **论文**: *Parallax-Tolerant Unsupervised Deep Image Stitching* (ICCV 2021)
- **GitHub**: `github.com/nie-lang/UnsupervisedDeepImageStitching`
- **获取**:
  ```bash
  # 数据集在 Google Drive，README 中有链接
  gh api repos/nie-lang/UnsupervisedDeepImageStitching/readme --jq '.content' | base64 -d | grep -i drive
  ```
- **内容**: 448 对户外图像对（风景为主，部分含人物），已划分 train/test
- **价值**: 测试场景 B 低纹理路径；同时可作为与深度学习基线对比的基准

---

### 类型二：真人/行人专项素材

#### Street View Walking Tour 视频切帧（最实用）

从 YouTube/Bilibili 下载 4K 步行城市视频，用 FFmpeg 每隔 N 帧截一张：

```bash
# 下载（需 yt-dlp）
yt-dlp -f "bestvideo[height<=2160][ext=mp4]" "<URL>" -o input.mp4

# 每 0.5 秒截一帧（适合慢速旋转镜头）
ffmpeg -i input.mp4 -vf "fps=2,scale=1920:-1" -q:v 2 frames/frame_%04d.jpg

# 仅截取特定时间段（如第 30-60 秒有行人的片段）
ffmpeg -ss 30 -to 60 -i input.mp4 -vf "fps=2" -q:v 2 frames/frame_%04d.jpg
```

推荐视频类型（搜索关键词）：
- `"Tokyo Shibuya crossing 4K walking tour"` — 密集行人，适合场景 C 压力测试
- `"New York Times Square slow pan 4K"` — 广角城市场景，适合场景 B/C 混合测试
- `"landscape slow pan drone 4K"` — 纯风景宽景，适合场景 B 天空接缝测试

#### PTGui 官方示例序列

- **地址**: `ptgui.com/tutorials.html` → 下载 "Sample Images"
- **内容**: 室内合影（近景真人 + 强烈视差）、舞台高光场景
- **测试重点**: 近距离真人视差下 Homography 是否仍然合理；皮肤纹理（特征点稀少区域）的 AKAZE 匹配质量

---

### 类型三：合成可控序列（用于算法调参）

当需要控制变量测试单一因素时，用 OpenCV 从已知图像合成重叠序列：

```python
# 生成带已知旋转的测试序列（Python 脚本，在 Docker 内运行）
import cv2, numpy as np

img = cv2.imread("landscape.jpg")  # 单张全景底图
h, w = img.shape[:2]
cx, cy = w // 2, h // 2

for i, angle in enumerate(range(-30, 31, 6)):   # -30° 到 +30°，步长 6°
    M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
    rotated = cv2.warpAffine(img, M, (w, h))
    # 裁剪出重叠 ~60% 的子图
    crop_w = int(w * 0.55)
    offset = int((i / 10) * (w - crop_w))
    frame = rotated[:, offset:offset + crop_w]
    cv2.imwrite(f"synthetic/frame_{i:02d}.jpg", frame)
```

**优势**: Ground Truth 已知（旋转角精确），可直接计算拼接误差；控制重叠度（40%–70%）测试算法鲁棒性下界。

---

### 测试检查清单（场景 B / C 验收标准）

**场景 B（风景）必测项**：
- [ ] 天空接缝不可见（无色差条纹）
- [ ] 镜头暗角在拼接处不产生暗带（增益补偿生效）
- [ ] 远景地平线对齐误差 < 2px（1080p 输出）
- [ ] 宽景（> 5 帧）时柱面投影激活，水平线无明显弧形弯曲

**场景 C（真人）必测项**：
- [ ] 行人身体无明显鬼影（帧差掩码有效）
- [ ] 人体未被缝合线切断（Seam 绕开人体区域）
- [ ] 静态背景（建筑/地面）对齐误差 < 3px
- [ ] 多帧 Homography 中值聚合有效（单帧异常不影响整体）

---

## Decision 9: @alivecss/aliveui 初步调研

**信息�?*: `@alivecss/@alivecss/aliveui` npm 包，GitHub repo [swlkr/@alivecss/aliveui](https://github.com/swlkr/@alivecss/aliveui)

**初步评估**:
- �?CSS 框架（无 JS 运行时），文件大�?< 50KB（gzip），适合嵌入式场�?- 提供 utility classes + 语义组件（card, modal, progress, form controls�?- 基于自定义属性（CSS custom properties）的主题系统，暗色模式开箱即�?- TypeScript/Preact 项目通过 `npm install @alivecss/aliveui` 引入
- �?Vite 特殊配置要求（标�?CSS import 即可�?
**风险**: 框架较新，社区生态小，可能需要自定义扩展部分组件（如视频播放�?OSD 特定样式）�?