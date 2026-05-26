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

**Decision**: 使用 AliveUI（`aliveui` npm package）全量替�?player-enhancer �?`styles.ts` 自定�?CSS。所有组件（OSD 按钮、亮�?音量指示器、速度 OSD、seek OSD、截�?UI、帧选择�?Modal）统一使用 AliveUI 语义类名和内联工具类�?
**Rationale**:
- 统一样式体系降低维护成本（无需同时维护两套 CSS 范式�?- AliveUI 提供响应式网格、Modal、表单控件、进度条等开箱即用组�?- �?Preact 兼容（AliveUI 是纯 CSS 框架，无 JS 运行时依赖）

**Alternatives considered**: �?Modal 使用 AliveUI（风格不一致，两套 CSS 混用增加认知负担），继续手写 CSS（需处理大量新组件样式，工作量更大）�?
---

## Decision 9: AliveUI 初步调研

**信息�?*: `aliveui` npm 包，GitHub repo [swlkr/aliveui](https://github.com/swlkr/aliveui)

**初步评估**:
- �?CSS 框架（无 JS 运行时），文件大�?< 50KB（gzip），适合嵌入式场�?- 提供 utility classes + 语义组件（card, modal, progress, form controls�?- 基于自定义属性（CSS custom properties）的主题系统，暗色模式开箱即�?- TypeScript/Preact 项目通过 `npm install aliveui` 引入
- �?Vite 特殊配置要求（标�?CSS import 即可�?
**风险**: 框架较新，社区生态小，可能需要自定义扩展部分组件（如视频播放�?OSD 特定样式）�?