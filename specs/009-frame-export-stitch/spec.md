# Feature Specification: Frame Export & Stitch

**Feature Branch**: `feature/009-frame-forge-stitch`  
**Created**: 2026-05-26  
**Status**: Draft  
**Input**: User description: "�?player-enhancer 中添加帧导出与拼接功能——从播放进度读取关键帧缩略图，用户选定帧后合并�?GIF/WebP 动画或全景图。需 Rust 后端工具支持，需调研全景拼接算法�?

## Clarifications

### Session 2026-05-26

- Q: 多个用户同时触发生成任务时，服务器如何控制并发生成任务数�?�?A: 基于可用资源动态调节（CPU/内存使用率阈值），优先保障视频播放流畅度（seek-preview daemon 及流媒体传输不受影响）；当资源紧张时自动降速或排队，不设硬编码并发上限
- Q: 用户点击"取消"后，Rust daemon 中的解码/编码操作如何处理�?�?A: 强制终止子进程（直接 kill Rust 处理进程），立即清理该任务的临时文件目录；不实现优雅取消逻辑，靠进程隔离保证资源释放
- Q: 全景图输出格式是否也提供多选（类似动画�?GIF/WebP）？ �?A: 提供 PNG �?WebP（无损）两个选项，默�?PNG；WebP 无损模式可保持画质同时减小文件体�?- Q: 帧数是否需要硬上限（仅保留 50 帧警告）�?�?A: 不设硬上限，仅保�?>50 帧时的用户警告；若资源紧张则�?FR-042 的动态资源调度降�?排队兜底
- Q: @alivecss/aliveui CSS 框架的使用范围是�?Modal 还是整个 player-enhancer�?�?A: 全量迁移——整�?player-enhancer 前端（OSD 按钮、亮�?音量指示器、速度 OSD、截�?UI、帧选择�?Modal 等所有组件）统一使用 @alivecss/aliveui 样式体系，替�?`styles.ts` 中的自定�?CSS
- Q: 类似 QQ �?IM 软件按高度限制动图尺寸的需求如何满足？ �?A: 参数面板提供"按宽�?�?按高�?两个互斥的分辨率约束模式；用户设置一个值时另一输入框自动计算（保持原始宽高比）并置灰不可编辑；默认模式�?按宽�?
- Q: 动漫/风景/真人三场景分类能否覆盖全场景？GPU（如 Intel Arc A310）对拼接任务是否有加速价值？ �?A: 三场�?+ Phase Correlation 兜底覆盖�?95% 场景（屏幕录�?CGI 均可归入现有路径，极暗场�?鱼眼镜头不在 v1 范围）；GPU 策略�?默认�?CPU，可�?OpenCL 加�?——若 Docker 容器检测到 OpenCL 可用则自动启�?GPU 路径处理 Warp/Blending，未透传 GPU 时静�?CPU fallback；不强制要求 GPU 依赖

## Research

### 全景拼接算法调研

全景拼接（Image Stitching / Panorama）核心流程：

1. **场景分类**（本项目扩展步骤）：识别动漫 / 风景 / 真人场景，选择对应算法路径
2. **关键点检测与特征提取**：根据场景类型选用 Phase Correlation（动漫）�?AKAZE（风�?真人�?3. **特征匹配与外点剔�?*：BFMatcher（汉明距离）+ RANSAC，动态场景叠加帧差运动掩�?4. **Homography 估计与投影变�?*：以基准帧为参照变换其余帧；宽景场景使用柱面投影
5. **曝光补偿与混合（Blending�?*：增益补偿消除帧间色差；Laplacian 金字塔多频带混合消除拼缝

#### 经典文献

| 资源 | 说明 |
|------|------|
| [Brown & Lowe (2007) - Automatic Panoramic Image Stitching](http://matthewalunbrown.com/papers/ijcv2007.pdf) | 经典全景拼接框架，OpenCV Stitcher 基于此文 |
| [Semantic Aware Stitching for Panorama (Sensors 2024)](https://www.mdpi.com/1424-8220/24/11/3512) | 超像素局部单�?+ 自适应非线性变换，场景自适应拼接正确思路 |
| [Deep Homography Estimation for Dynamic Scenes (arXiv 2020)](https://arxiv.org/pdf/2004.02132) | Mask Predictor 动态前景掩码，真人场景内点过滤的工程化参�?|
| [低纹理场�?CNN 迭代优化拼接 (Sensors 2019)](https://www.mdpi.com/1424-8220/19/23/5310) | 天空/水面低纹理场景的深度学习+迭代优化方案 |
| [近均匀场景有效特征检�?(ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0923596522001515) | 针对天空/海洋/海岸等近均匀场景的特征检测改�?|
| [Overmix - 动漫截图拼接开源项目](https://github.com/spillerrec/Overmix) | 唯一专为动漫截图设计的拼接工具，使用相位相关法，可参考算法决�?|
| [Phase Correlation 亚像素扩展论文](https://www.cs.ucf.edu/~foroosh/subreg.pdf) | Phase Correlation 扩展到亚像素精度的方�?|
| [UDIS++ 视差容忍无监督拼�?(ICCV 2023)](https://arxiv.org/abs/2302.08207) | 当前最强深度学习拼接方案，CPU 推理过慢，暂不引入，作为未来参�?|
| [StabStitch++ 在线视频拼接 (2025)](https://arxiv.org/html/2505.05001v1) | 2025 年最新时空双�?warp 视频拼接 |

### 场景类型识别与算法路�?
#### 场景分类器（轻量启发式，无需 DL�?
基于已有的帧质量检测信号组合判断，在拼接前执行�?
| 分类信号 | 动漫 | 风景/低纹�?| 真人影视 |
|---------|------|------------|---------|
| 颜色直方图熵 | 低（大面积纯色） | 中（渐变色） | 高（复杂纹理�?|
| Canny 边缘密度 | 高（线条密集�?| 低（平滑区域多） | �?�?|
| 帧间差分运动区域 | �?| �?| �?�?|
| 饱和度均匀分布 | 是（鲜艳+均匀�?| �?| �?|

三类场景映射到三条算法路径（详见下节）。拼接方向（水平/垂直）默认由宽高比推断，但向用户暴露手动选项�?
#### 镜头运动类型预检

在场景分类后，用前两帧估算主导运动：

- **平移主导（Pan�?*：适合全景拼接，正常执�?- **缩放主导（Zoom�?*：Homography 无意义，通过 SSE �?`status: "warn"` 提示用户
- **旋转主导**：偏好柱面投影而非平面 Homography

#### 近重复帧剔除（拼接前预处理）

与垃圾帧检测分开执行，专用于全景拼接场景�?
- 计算相邻选中帧的**感知哈希（pHash/dHash�?*相似�?- 相似�?> 阈值（默认 90%）时标记为冗余帧，在 UI 上提�?与第 N 帧高度重�?并自动取消勾�?- 对选中帧估算相邻重叠率，重�?> 95% 视为无拼接价值的冗余�?
### 三场景拼接算�?
#### 场景 A：动�?动画内容

**主算法：相位相关法（Phase Correlation�?*

ORB/SIFT 在动漫场景失效的根本原因：SIFT �?DoG 金字塔在大面积纯色区域无法产生稳定响应，线条边缘虽是高对比度结构但无尺度变化。Phase Correlation 不依赖纹理特征点，对纯色和线条天然有效�?
```
灰度�?+ 汉明窗加权（抑制边界效应�?    �?FFT 2D（rustfft crate�?    �?归一化互功率谱：R = F1·conj(F2) / |F1·conj(F2)|
    �?IFFT �?峰值定位（亚像素细化：抛物线插值，可达 1/10px 精度�?    �?平移�?(Δx, Δy) �?直接 warp 拼接
```

如需估计帧间轻微旋转：对数极坐标变换后再做一�?Phase Correlation�?
- **Rust 实现**：`rustfft` crate（成熟），无需 OpenCV
- **参考实�?*：[Overmix](https://github.com/spillerrec/Overmix) 的算法思路
- **局�?*：仅适用于近平移场景，但视频连续帧天然满足此条件
- **适用�?*：高 | **实现难度**：中�?
#### 场景 B：自然风景（低纹理区域）

**主算法：分区�?AKAZE + Phase Correlation 兜底**

天空、水面等低纹理区域会导致 ORB/SIFT 关键点极度稀疏。策略：只在高纹�?ROI（树木、建筑、岩石边缘）做特征匹配，低纹理区域退化为 Phase Correlation�?
```
梯度幅值图 �?提取高纹�?ROI 掩码（梯�?> 阈值的区域�?    �?仅在 ROI 内做 AKAZE 特征检测（AKAZE �?ORB 对边缘线条更稳定，Apache 2.0 协议�?    �?BFMatcher（汉明距离）+ RANSAC �?Homography 估计
    �?若内点数 < 最小阈�?�?降级�?Phase Correlation
    �?Warp + Laplacian 金字塔多频带混合（消除天空区域拼缝）
```

宽幅风景（帧�?> 5）使用柱面投影代替平�?Homography，减少端帧畸变�?
- **Rust 实现**：`opencv` crate（AKAZE + BFMatcher + RANSAC + findHomography�?- **参考论�?*：[近均匀场景特征检测改进](https://www.sciencedirect.com/science/article/abs/pii/S0923596522001515)
- **适用�?*：高 | **实现难度**：中�?
#### 场景 C：真人影视（前景人物运动�?
**主算法：帧差运动掩码 + AKAZE + 多帧 Homography 聚合**

前景人物运动会给 RANSAC 引入大量外点，使 Homography 估计偏向前景运动方向。三重防护：帧差掩码排除运动区域、RANSAC 内点过滤、多帧中值聚合�?
```
帧间差分 + 形态学膨胀 �?前景运动掩码
    �?AKAZE 特征检测（全图）→ 过滤掉落在运动掩码内的关键点
    �?对剩余静态背景关键点�?RANSAC Homography 估计
    �?对连�?N 帧（N�?）的 Homography 取分量中值（鲁棒聚合，平滑偶发干扰）
    �?背景区域 warp + 前景区域双线性插值填�?```

- **Rust 实现**：`opencv` crate
- **参考论�?*：[Deep Homography for Dynamic Scenes](https://arxiv.org/pdf/2004.02132)（DL mask 思路的工程化简化版�?- **适用�?*：高 | **实现难度**：中等偏�?
### 视频帧全景图特有挑战

| 挑战 | 分析 | 应对策略 |
|------|------|----------|
| **场景运动（前景人物）** | 人物走动导致帧间不一�?| 帧差运动掩码 + RANSAC 内点过滤双重保险（场�?C 路径�?|
| **动漫低纹�?* | 纯色区域 ORB/SIFT 失效 | 相位相关法（Phase Correlation），不依赖纹理特征点（场�?A 路径�?|
| **风景低纹理（天空/水面�?* | 关键点稀疏，RANSAC 不稳�?| 高纹�?ROI 掩码 + Phase Correlation 兜底（场�?B 路径�?|
| **近重复帧** | 选中帧视角几乎相同，拼接产生重影 | pHash 相似度检测，自动标记冗余帧（拼接前预处理�?|
| **镜头缩放（Zoom�?* | Homography 无意�?| 主导运动预检，检测到 Zoom �?SSE �?`warn` 提示用户 |
| **宽画幅（>5帧）漂移** | 累积误差导致端帧严重歪斜 | 柱面投影代替平面 Homography；增量拼接限制相邻帧对范�?|
| **转场/闪白/黑帧** | 无有效重叠区�?| 亮度方差 + 帧间差异预检，自动过滤（垃圾帧检测层�?|
| **曝光颜色不一�?* | 帧间色差产生明显拼缝 | 增益补偿 + Laplacian 金字塔多频带混合 |
| **视差（Parallax�?* | 摄像机运动不同深度平面错�?| v1 限定静态镜头；未来版本引入 UDIS++/APAP 网格变形 |
| **拼接方向** | 宽幅视频也可能需要垂直拼�?| 默认由宽高比推断，但提供手动选项 |

### 动画生成调研

GIF/WebP 动画生成相对简单，核心为：

| 方案 | 优点 | 缺点 |
|------|------|------|
| **ffmpeg** (`-i frame_%d.png -vf palettegen + paletteuse`) | 色彩质量好，单命令即�?| 需先生成临时帧文件 |
| **Rust `image` + `gif` crate** | �?Rust 实现，内存操�?| GIF 色彩量化需自定义调色板 |
| **Rust `image` + WebP（libwebp�?* | 支持有损/无损、透明�?| 需系统库或 C 绑定 |

**推荐方案**: �?Rust `ffmpeg-next` crate 内存解码原始�?�?Rust 侧调�?`libwebp`/`gif` crate 编码，避免临时文件。与现有 seek-preview daemon 复用 ffmpeg-next 基础设施�?
### 垃圾�?干扰帧检测策�?
| 方法 | 适用场景 | 实现难度 |
|------|----------|----------|
| **亮度直方图方差阈�?* | 检测黑帧（转场）、白帧（闪白�?| �?�?直接计算像素亮度方差 |
| **帧间像素差异** | 检测场景切换（相邻帧差�?>90%�?| �?�?`image` crate 逐像�?diff |
| **拉普拉斯方差 (Laplacian Variance)** | 检测模糊帧（运动模糊、失焦） | �?�?手动实现 3×3 Laplacian 核卷�?|
| **SSIM (Structural Similarity)** | 通用质量评分 | �?�?可依�?`image` crate 手动实现 |
| **Canny 边缘密度** | 动漫场景线条检测：边缘像素占比评估场景信息�?| �?�?Sobel/Canny 边缘检测后统计非零像素比例 |
| **颜色直方图熵** | 检测单调场景（如大面积纯色�?| �?�?计算颜色直方图的信息�?|

**v1 推荐策略**: 结合亮度方差 + 帧间差异 + 拉普拉斯方差三重检测，阈值可配置�?
### 技术选型总结

| 组件 | 技术选择 | 理由 |
|------|----------|------|
| 帧解�?| `ffmpeg-next` crate (Rust) | 复用 seek-preview 基础设施，内存解码无临时文件 |
| 场景分类�?| �?Rust（`image` / `imageproc`）启发式规则 | 颜色�?+ 边缘密度 + 帧差，无需 DL，计算量极低 |
| 全景拼接（动漫） | `rustfft` crate 实现 Phase Correlation | 不依�?OpenCV；对纯色/线条场景天然有效；参�?Overmix 实现 |
| 全景拼接（风�?真人�?| `opencv` crate：AKAZE + BFMatcher + RANSAC + findHomography | 避免手写 SVD �?RANSAC（工作量 3-6 个月）；OpenCV Apache 2.0 协议；Docker 中通过系统包安�?|
| GPU 加速（可选） | `opencv` crate �?OpenCL 后端 | 用于 Warp/Blending 阶段加速；需 Docker 透传 `/dev/dri` + `intel-compute-runtime`；未检测到 OpenCL 时静�?CPU fallback |
| 近重复帧检�?| �?Rust 实现 pHash（感知哈希） | 轻量；`image` crate 即可实现；无需外部依赖 |
| 图像混合 | �?Rust 实现 Laplacian 金字塔多频带混合 | `imageproc` 有高斯模糊基础，可在此基础上构�?|
| 动画编码 | `gif` crate + `webp` crate | �?Rust �?C 绑定 |
| 帧质量评�?| �?Rust：亮度方�?+ 帧间差异 + Laplacian 方差 + pHash | 轻量，无外部依赖 |
| IPC | Unix domain socket（复�?seek-preview 协议�?| 与现�?seek-preview 架构一�?|
| DL 拼接（暂不引入） | UDIS++、StabStitch++ �?| CPU 推理 >500ms/帧，视频帧实时场景不实际；作为未�?v2 选项 |

**关于引入 `opencv` crate 的决�?*：自实现 ORB/AKAZE + RANSAC Homography + SVD �?Rust 中约需 3-6 个月，且可靠性远低于 OpenCV 工业级实现。`opencv` crate（[twistedfall/opencv-rust](https://github.com/twistedfall/opencv-rust)）已成熟，Apache 2.0 协议，Docker 镜像中通过 `apt install libopencv-dev` 即可引入，构建复杂度可接受。动漫路径的 Phase Correlation �?`rustfft` 实现，不依赖 OpenCV，两条路径可并行开发�?
---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 打开帧选择�?(Priority: P1)

用户正在播放视频，点击播放器 OSD 控制栏中新增�?帧导�?按钮，弹出帧选择�?Modal，以�?列网格形式展示当前播放进度前后的关键帧缩略图�?
**Why this priority**: 帧选择器是所有后续操作（动画导出、全景拼接）的入口界面，是功能的 MVP 基础�?
**Independent Test**: 播放任意视频，点�?帧导�?按钮，Modal 弹出并显示缩略图网格，即可独立验证�?
**Acceptance Scenarios**:

1. **Given** 用户正在播放视频�?*When** 点击 OSD 控制栏中新增�?帧导�?按钮�?*Then** 弹出 Modal/面板，显示当前播放进度前后各 5 帧（�?11 帧）的关键帧缩略�?2. **Given** 帧选择器已打开�?*When** 用户点击 Modal 外部遮罩区域或关闭按钮，**Then** Modal 关闭，返回播放器
3. **Given** 当前进度在视频开头（< 5s），**When** 打开帧选择器，**Then** 只显示从 0s 开始可用的帧，不报�?4. **Given** 当前进度在视频末尾（距离结束 < 5s），**When** 打开帧选择器，**Then** 只显示到结束为止可用的帧，不报错
5. **Given** 视频文件不存在或无法解码�?*When** 打开帧选择器，**Then** 显示错误提示，不崩溃

---

### User Story 2 - 扩展获取更多关键�?(Priority: P1)

在帧选择器界面中，用户可以通过两个扩展按钮（前�?后向）进一步获取更多关键帧，扩展帧选择范围�?
**Why this priority**: 不扩展则固定只能看到 11 帧，无法满足长视频场景下跨场景选择的需求�?
**Independent Test**: 在帧选择器中点击"前向扩展"按钮，界面追加对应方向的关键帧缩略图；点�?后向扩展"同理�?
**Acceptance Scenarios**:

1. **Given** 帧选择器已打开并显示初�?11 帧，**When** 用户点击"向前"扩展按钮�?*Then** 在当前帧范围前方追加 10 帧缩略图，滚动到新增位置
2. **Given** 帧选择器已打开�?*When** 用户点击"向后"扩展按钮�?*Then** 在当前帧范围后方追加 10 帧缩略图
3. **Given** 已扩展到视频开头边界，**When** 用户再次点击"向前"扩展�?*Then** 按钮显示为禁用状态或提示"已到达视频开�?
4. **Given** 扩展操作进行中，**When** 后端仍在解码帧，**Then** 按钮显示加载状态（旋转图标或禁用），防止重复点�?
---

### User Story 3 - 帧选择与预�?(Priority: P1)

在帧选择器中，每帧缩略图上有 checkbox（默认全部勾选），用户可取消不需要的帧（垃圾帧、转场帧、重复帧）。Modal 底部显示已选帧数�?
**Why this priority**: 帧选择是用户控制输出内容的核心交互，配合自动帧质量检测（灰化垃圾帧）提升体验�?
**Independent Test**: 打开帧选择器，取消部分帧的勾选，观察底部计数变化�?UI 反馈；再次勾选恢复�?
**Acceptance Scenarios**:

1. **Given** 帧选择器已打开�?*When** 加载完成�?*Then** 所有帧 checkbox 默认勾选，底部显示"已�?X/总数 Y �?
2. **Given** 帧选择器已打开�?*When** 用户点击某帧�?checkbox 取消勾选，**Then** 该帧样式变灰/降低透明度，底部计数更新
3. **Given** 后端检测到某帧为疑似垃圾帧（黑�?闪白/模糊），**When** 帧加载后�?*Then** 该帧自动取消勾选并带有视觉标识（如红色边框 + 标签"可能为垃圾帧"�?4. **Given** 帧选择器已显示�?*When** 用户点击某帧缩略图（�?checkbox 区域），**Then** 该帧放大预览（Lightbox �?Modal 内嵌大图），显示帧时间戳

---

### User Story 4 - 导出动画 (GIF/WebP) (Priority: P2)

用户选中多个帧后，在 Modal 底部工具栏通过下拉菜单选择输出格式（GIF/WebP），调整输出参数（分辨率、帧率、循环次数），点�?生成"按钮。系统通过 SSE 实时报告生成进度，完成后�?Modal 内展示成果预览，用户可选择下载、删除或返回缩略图网格页�?
**Why this priority**: 动画导出是价值最高的输出能力之一——影视截图分享、社交媒体表情包制作、影片片段预览等。技术复杂度较低，可独立交付�?
**Independent Test**: 选中 3 帧，选择 GIF 格式、保持默认参数，点击生成；SSE 报告进度�?Modal 展示动画预览，点击下载获�?GIF 文件�?
**Acceptance Scenarios**:

1. **Given** 用户已选中至少 2 帧，**When** 在底部工具栏右侧下拉菜单中选择"GIF"格式，调整帧率为 10fps，点�?生成"按钮�?*Then** 界面切换到进度视图，通过 SSE 实时显示处理百分比和当前步骤（解码中/编码�?完成�?2. **Given** 同上条件�?*When** 选择 WebP 格式�?*Then** 以相同流程生�?WebP 文件
3. **Given** 生成完成�?*When** SSE 报告 `status: "complete"`�?*Then** Modal 切换到成果预览页——展示动画循环播放预览，下方显示文件大小，提�?下载"�?删除"两个操作按钮
4. **Given** 用户在成果预览页�?*When** 点击"下载"�?*Then** 浏览器触发下载，文件名格式为 `{视频标题}_anim_{timestamp}.{ext}`
5. **Given** 用户在成果预览页�?*When** 点击"删除"�?*Then** 服务端清理临时文件，前端返回网格选择页，保留之前的帧选择状�?6. **Given** 用户在成果预览页�?*When** 点击顶部"返回"按钮（← 箭头），**Then** 返回缩略图网格页，保留之前的帧选择状态，服务端清理临时生成文�?7. **Given** 生成过程中出错（服务端解码失败等），**When** SSE 报告 `status: "error"`�?*Then** 展示错误提示，提供重试和取消选项
8. **Given** 用户只选中 1 帧，**When** 点击"生成"�?*Then** 生成按钮区域显示提示"至少需要选择 2 �?，按钮不响应
9. **Given** 选中超过 50 帧，**When** 点击"生成"�?*Then** 显示警告"帧数过多可能导致文件较大，建议减少选择"，用户确认后继续
10. **Given** 用户调整参数（帧率、分辨率、循环次数）�?*When** 参数变更�?*Then** 参数自动保存�?`localStorage`，下次打开时恢复上次设�?
---

### User Story 5 - 导出全景�?(Priority: P3)

用户选中多个帧后，在 Modal 底部工具栏点�?导出全景�?按钮。系统通过 SSE 实时报告拼接进度（特征检�?�?匹配 �?拼接 �?混合），完成后在 Modal 内展示全景图预览，用户可选择下载、删除或返回。参数（输出分辨率上限、拼接方向）可配置，保存�?localStorage�?
**Why this priority**: 全景拼接是差异化高级功能——动漫场景拼接、宽幅风景图、长截图等场景有强需求但算法复杂度高。作�?P3 可在动画导出稳定后再迭代�?
**Independent Test**: 选中同一场景�?3 帧不同视角的帧，点击"导出全景�?；SSE 报告进度�?Modal 展示拼接成果，点击下载获得全�?PNG�?
**Acceptance Scenarios**:

1. **Given** 用户已选中至少 2 帧（来自同一场景、有足够重叠区域），**When** 点击"导出全景�?�?*Then** 界面切换到进度视图，SSE 逐步报告当前阶段�?特征检测中..." �?"匹配对应�?.." �?"拼接合成�?.." �?"混合优化�?.." �?完成），完成后展示全景图预览
2. **Given** 拼接失败（Homography 估计失败），**When** SSE 报告 `status: "fallback"`�?*Then** 展示"特征匹配失败，已使用简单并排拼接模�?提示及结果预览（用户可选择接受或返回重选帧�?3. **Given** 选中帧来自不同场景（无共同特征）�?*When** 回退拼接也无法生成，**Then** 显示提示"无法拼接：帧之间共同区域不足，请选择同一场景的帧"
4. **Given** 拼接完成�?*When** 用户查看成果预览�?*Then** 提供"下载 PNG"�?删除"�?返回"按钮，行为同动画成果�?5. **Given** 全景拼接输出尺寸超过配置上限�?*When** 生成中，**Then** 服务端自动等比缩放到上限（分辨率约束模式对全景图同样适用，默认按宽度限制），SSE 中提�?输出尺寸已缩小至 X×Y"

---

### User Story 6 - 导出参数配置与持久化 (Priority: P2)

用户在点击生成前可通过参数面板调整输出规格：动画格式（GIF/WebP）、输出分辨率、帧率（fps）、循环次数。所有参数均有默认推荐值，修改后自动保存至 localStorage，下次使用恢复�?
**Why this priority**: 参数配置直接决定输出质量与文件大小，无此功能用户只能使用硬编码默认值，无法满足不同场景需求�?
**Independent Test**: 打开帧选择器，修改帧率�?15fps、分辨率�?720p，关�?Modal 后再打开，参数恢复为上次设定值�?
**Acceptance Scenarios**:

1. **Given** 帧选择�?Modal 底部工具栏，**When** 用户查看"生成"按钮右侧�?*Then** 可见格式下拉菜单：动画模式下默认选中 GIF（可�?WebP），全景图模式下默认选中 PNG（可�?WebP 无损），点击展开显示对应选项
2. **Given** 同上�?*When** 用户展开"参数"折叠面板�?*Then** 显示分辨率约束模式切换（"按宽�?/"按高�?，默认按宽度）、分辨率预设下拉（原�?1080p/720p/480p/360p）、自定义像素输入框（一个可编辑，另一个自动计算并置灰）、帧率滑块（1-30fps，默�?5fps，仅动画导出时可见）、循环次数输入（0=无限循环�?=播放 1 次，默认 0，仅动画导出时可见）
2b. **Given** 用户�?按高�?模式下输入高�?400px�?*When** 原始帧为 1920×1080�?*Then** 宽度自动计算�?711px 并置灰不可编�?2c. **Given** 用户切换为预设档位（�?720p），**When** 选择后，**Then** 约束模式自动切换�?按宽�?，自定义输入框恢复为预设�?3. **Given** 用户修改任意参数�?*When** 参数值变更，**Then** 自动写入 `localStorage`（key: `jfs-frameexport-settings`），�?`{ animateFormat, stitchFormat, resizeMode, customWidth, customHeight, resolutionPreset, fps, loopCount }`
4. **Given** 用户下次打开帧选择器，**When** 初始化时�?*Then** �?`localStorage` 读取上次参数并应用到 UI 控件
5. **Given** localStorage 中无保存值（首次使用），**When** 初始化时�?*Then** 使用推荐默认值：GIF、原始分辨率�?fps、无限循�?
---

### User Story 7 - SSE 进度与生成成果管�?(Priority: P2)

导出操作（动画或全景图）进行中，前端通过 SSE 连接实时接收后端进度事件，Modal 展示进度条和状态文字。完成后自动展示成果预览（动画循环播�?/ 全景图可拖动查看），成果页面提供下载、删除、返回操作�?
**Why this priority**: SSE 反馈避免用户在长时间生成中焦虑（全景拼接可能 >10s）；成果预览让用户确认效果后再决定下载�?
**Independent Test**: 点击生成后，Modal 展示进度条逐步增长，SSE log 显示各阶段事件，完成后自动跳转成果预览页�?
**Acceptance Scenarios**:

1. **Given** 用户点击"生成"按钮�?*When** 生成任务已提交，**Then** Modal 切换到进度视图：顶部进度�?+ 百分比文�?+ 当前步骤描述（如"解码�?3/10 �?.."），SSE EventSource 连接 `GET /JellyfinSuite/FrameExport/Progress?taskId={uuid}`
2. **Given** SSE 持续报告进度�?*When** 后端分阶段推�?`{ phase, current, total, percent }`�?*Then** 前端更新进度条和文字
3. **Given** 生成完成（SSE `status: "complete"`），**When** 收到最终结�?`{ resultUrl, fileSize, format }`�?*Then** Modal 平滑切换到成果预览页：动画自动循环播�?/ 全景图以适配容器显示
4. **Given** 生成出错（SSE `status: "error"`），**When** 收到 `{ error: "message" }`�?*Then** 展示错误消息 + "重试"按钮 + "返回"按钮
5. **Given** 成果预览页可见，**When** 用户点击"下载"�?*Then** 浏览器下载文件（URL �?resultUrl 提供，文件在服务端临时目录）
6. **Given** 成果预览页可见，**When** 用户点击"删除"�?*Then** 调用 `DELETE /JellyfinSuite/FrameExport/Result/{taskId}` 清理服务端临时文件，前端返回网格�?7. **Given** 成果预览页可见，**When** 用户点击"返回"（← 顶部导航），**Then** 清理临时文件 + 返回网格�?
---

### User Story 8 - 多页�?Modal 导航 (Priority: P3)

帧选择�?Modal 内部为多页面 SPA 结构：网格页（帧选择）→ 进度页（生成中）�?成果页（预览与操作）。页面通过顶部导航栏的返回按钮进行切换，各页面状态独立管理�?
**Why this priority**: �?Modal 内三阶段流程形式化为多页面架构，改善代码组织和用户体验一致性�?
**Independent Test**: 从网格页点击生成 �?进入进度�?�?完成后自动到成果�?�?点击返回回到网格页�?
**Acceptance Scenarios**:

1. **Given** Modal 打开�?*When** 初始化，**Then** 显示网格页，顶部标题栏显�?帧导�?和关闭按�?2. **Given** 用户在网格页�?*When** 点击生成�?*Then** 顶部标题栏变�?生成�? + 取消按钮（取消会终止生成并返回网格页�?3. **Given** 用户在进度页�?*When** 生成完成�?*Then** 顶部标题栏变�?预览" + 返回按钮（←�? 关闭按钮
4. **Given** 用户在成果页�?*When** Modal 关闭（点�?X 或遮罩）�?*Then** 服务端清理该任务临时文件，返回播放器

---

### User Story 9 - 自动化拼接质量评分 (Priority: P4)

开发者运行测试套件时，Rust `#[cfg(test)]` 模块和 Python 评估脚本自动对拼接输出计算质量指标（SSIM、接缝梯度跳变、色差 ΔE Lab、RANSAC 内点率、RMSE），生成带通过/失败阈值的数值评分卡，无需人工目测拼接结果。

**Why this priority**: 拼接算法复杂，三条路径（动漫/风景/真人）均需可重复的客观基准，以便在修改算法时快速判断是否回归；P4 因为不影响用户功能，但对算法迭代至关重要。

**Independent Test**: 运行 `cargo test -p frame-forge stitch_quality` 以及 `python tests/stitch-eval/score.py`，两者均输出评分卡且所有指标通过阈值即为成功。

**Acceptance Scenarios**:

1. **Given** Rust 测试套件运行（`cargo test -p frame-forge`），**When** 拼接质量测试模块执行，**Then** 对每个测试用例输出包含 SSIM（≥0.80）、接缝梯度跳变（≤25.0）、色差 ΔE（≤10.0）、RANSAC 内点率（≥0.40，仅场景 B/C）的评分卡，所有指标通过则测试通过
2. **Given** Python 评估脚本 `tests/stitch-eval/score.py` 执行，**When** 传入测试图像对目录（SEAGULL 场景 B 或 FFmpeg 生成的合成序列），**Then** 输出 JSON 格式评分卡，含 SSIM、ΔE、RMSE、接缝梯度每项的平均值和通过/失败状态
3. **Given** 评分卡生成完成，**When** 某项指标低于阈值，**Then** 对应项标记为 FAIL 并在 stderr 输出具体数值（如 `SSIM=0.72 < threshold 0.80`），退出码为 1，允许 CI 捕获
4. **Given** 测试数据集目录不存在，**When** 运行评估脚本，**Then** 脚本输出明确提示（如"测试数据集未找到，请参考 research.md 的数据集准备指南"）并以退出码 2 退出，不崩溃
5. **Given** 合成测试序列生成（FFmpeg 裁切真实视频），**When** 对生成序列运行评分，**Then** 场景 A（动漫）Phase Correlation 路径在合成平移序列上 SSIM ≥ 0.90

---

### Edge Cases

- 视频无关键帧信息（如直播流、IPTV 流）�?帧选择器按钮禁用或隐藏
- 视频文件在服务器上被删除/移动 �?返回友好错误提示，无 crash
- 用户快速连续点击扩展按�?�?请求合并（debounce 300ms），避免 DDOS 后端
- 浏览器内存不足时加载过多帧缩略图�?100 帧）�?实施虚拟滚动或分页加�?- 全景拼接结果过大�? 20,000 x 10,000 px）→ 限制输出分辨率上限，超出时等比缩�?- DRM 保护内容 �?帧导出按钮禁用（�?screenshot 行为�?- SSE 连接中断（网络波动）�?前端自动重连（最�?3 次），重连后服务端推送当前最新状�?- 用户关闭 Modal 或离开页面时生成任务仍在运�?�?服务端继续完成后保留结果 5 分钟，超时自动清理临时文�?- 临时文件目录磁盘空间不足 �?生成失败，SSE 报告 `status: "error"`，提�?服务器存储空间不�?
- 取消生成时强�?kill Rust 子进�?�?子进程可能残留孤儿临时帧文件 �?kill 后立即执�?`rm -rf {taskId}` 目录强制清理

---

## Requirements *(mandatory)*

### Functional Requirements

**帧选择�?UI**

- **FR-001**: 播放�?OSD 控制�?MUST 新增"帧导�?按钮，使用与现有按钮一致的 `jfs-enhancer-btn` 样式
- **FR-002**: 点击"帧导�?按钮�?MUST 弹出帧选择�?Modal，覆盖在播放器上方（视频暂停或继续播放由用户决定�?- **FR-003**: 帧选择�?MUST 以网格形式展示当前播放进度前后各 N 帧关键帧**缩略�?*（默�?N=5，前后共 11 帧，N 可配置）；缩略图使用压缩 JPEG（宽 �?320px），用于列表快速预览与选择
- **FR-004**: 每帧缩略�?MUST 附带 checkbox（默认勾选），并显示该帧的时间戳
- **FR-005**: Modal 底部工具�?MUST 显示已选帧数统�?+ 格式选择下拉菜单 + 参数配置入口 + 生成按钮

**Modal 多页面架�?*

- **FR-006**: Modal 内部 MUST 实现三个页面栈：网格页（帧选择）→ 进度页（生成中）�?成果页（预览与操作）
- **FR-007**: 网格页顶�?MUST 显示"帧导�?标题 + 关闭按钮；进度页顶部 MUST 显示"生成�? + 取消按钮；成果页顶部 MUST 显示"预览" + 返回按钮（←�? 关闭按钮
- **FR-008**: 成果�?MUST 展示生成结果预览——动画自动循环播放（`<img>` �?`<video>` 元素）、全景图以适配容器显示（支持拖�?缩放�?- **FR-009**: 成果�?MUST 提供"下载"�?删除"两个操作按钮；删除操�?MUST 清理服务端临时文件后返回网格�?- **FR-010**: 成果�?返回"按钮 MUST 清理服务端临时文�?+ 返回网格页，保留之前的帧选择状�?
**扩展获取**

- **FR-011**: 帧选择�?MUST 提供"向前"�?向后"两个扩展按钮，每次各追加 M 帧（默认 M=10，M 可配置）
- **FR-012**: 扩展操作进行�?MUST 禁用按钮并显示加载状态；到达视频边界时按�?MUST 变为禁用状�?- **FR-013**: 所有缩略图请求 MUST 通过 HTTP 端点（`GET /JellyfinSuite/FrameExport/{itemId}?positionMs=N&width=320`）获取压�?JPEG；生成阶段则请求原图（不�?width 或传 0�?
**帧质量检�?*

- **FR-014**: 帧加载后 MUST 自动执行质量预检：检测黑帧（亮度 < 阈值）、白帧（亮度 > 阈值）、模糊帧（Laplacian 方差 < 阈值）
- **FR-015**: 疑似垃圾�?MUST 自动取消勾选并�?UI 上带有视觉标识（如红色边�?+ 文字标签�?- **FR-016**: 质量检测阈�?MUST 可配置（�?C# 插件设置中暴露），允许管理员调整敏感�?
**导出参数配置与持久化**

- **FR-017**: 生成按钮右侧 MUST 提供格式下拉菜单，动画模式下显示 GIF / WebP，全景图模式下显�?PNG / WebP（无损）；默认值从 localStorage 读取（无保存值则动画默认 GIF、全景图默认 PNG�?- **FR-018**: MUST 提供参数面板（折叠式），包含以下可调参数及默认推荐值：
  - **分辨率约束模�?*：两个互斥选项 "按宽�?（默认）/ "按高�?，用户设置其中一个像素值，另一个自动按原始宽高比计算并置灰不可编辑；当选择预设档位（原�?1080p/720p/480p/360p）时自动切换�?按宽�?模式
  - 输出分辨率预设：原始 / 1080p / 720p / 480p / 360p（默认：原始�?  - 帧率（fps）：滑块 1�?0，默�?5fps
  - 循环次数�?=无限循环�?�?9 指定次数（仅动画导出，默�?0=无限�?- **FR-019**: 所有参数变更后 MUST 自动保存�?`localStorage`（key: `jfs-frameexport-settings`），包含 `{ animateFormat, stitchFormat, resizeMode: "width"|"height", customWidth, customHeight, resolutionPreset, fps, loopCount }`；再次打开 Modal 时自动恢�?
**SSE 进度推�?*

- **FR-020**: 生成任务提交后，前端 MUST 建立 SSE 连接（`GET /JellyfinSuite/FrameExport/Progress?taskId={uuid}`）接收进度事�?- **FR-021**: 进度�?MUST 展示：顶部进度条 + 百分�?+ 当前步骤描述文字（如"解码�?3/10 �?�?特征匹配�?等）
- **FR-022**: SSE 事件协议 MUST 包含标准字段：`{ taskId, status: "running"|"complete"|"error"|"fallback", phase, current, total, percent, resultUrl?, fileSize?, error? }`
- **FR-023**: `status: "complete"` �?MUST 携带 `resultUrl` �?`fileSize`，前端自动跳转到成果页并加载预览
- **FR-024**: SSE 连接中断时前�?MUST 自动重连（最�?3 次，间隔 1s），重连成功后服务端 MUST 推送当前最新状�?
**动画导出**

- **FR-025**: 用户选择至少 2 帧时，MUST 可点�?生成"按钮触发动图生成；只�?1 帧时按钮不响应并提示；超�?50 帧时 MUST 显示警告但允许继续，不设硬上限（资源兜底�?FR-042 动态调度保障）
- **FR-026**: 动画 MUST 按时间戳顺序排列帧，帧间间隔由用户配置的帧率参数决定
- **FR-027**: 动画生成 MUST 使用原始分辨率帧（非缩略图），在服务�?Rust daemon 中完成解码、缩放（按用户选择的分辨率预设或自定义�?高约束，保持原始宽高比）、编�?
**全景拼接**

- **FR-028**: 用户选择至少 2 帧时，MUST 可点�?导出全景�?按钮触发拼接；只�?1 帧时按钮不响应并提示；超�?50 帧时 MUST 显示警告但允许继�?- **FR-029**: 全景拼接 MUST 使用原始分辨率帧，优先尝�?Homography-based 拼接；若特征匹配失败（内点数 < 4），MUST 回退到简单并排堆叠模�?- **FR-030**: 回退模式 MUST 通过 SSE `status: "fallback"` 通知前端，成果页展示提示说明
- **FR-031**: 拼接失败�?MUST 通过 SSE `status: "error"` 返回明确错误信息（不静默失败�?- **FR-032**: 全景拼接输出 MUST 在使�?Homography 模式时包含多频带混合（Multi-band Blending）以减少拼缝；输出格式支�?PNG �?WebP 无损模式，由用户在下拉菜单选择

**图像与临时文件管�?*

- **FR-033**: 所有生成过程使用的中间帧文件和最终产�?MUST 存储在服务端专用临时目录（如 `{DataPath}/temp/frame-forge/{taskId}/`�?- **FR-034**: 临时文件 MUST 在以下条件之一触发时清理：�?）用户点�?删除"�?返回"�?）Modal 关闭�?）任务完成超�?5 分钟后的定期清理（由 C# 后台定时任务执行�?- **FR-035**: 生成结果文件 MUST 在清理时效内可通过 `GET /JellyfinSuite/FrameExport/Result/{taskId}/{filename}` 访问

**后端 (Rust Daemon)**

- **FR-036**: MUST 新增 Rust `frame-forge` crate（或扩展 seek-preview daemon），通过 Unix domain socket 接收帧请求、质量检测、动画编码、全景拼接请求；启动时自动检�?OpenCL 可用性，若可用则�?Warp/Blending 阶段启用 GPU 加速，不可用时静默回退�?CPU 路径
- **FR-037**: Rust �?MUST 实现内存解码（ffmpeg-next）→ 质量检测（亮度方差、帧间差异、Laplacian 方差）→ 帧返回流水线
- **FR-038**: Rust �?MUST 实现 GIF �?WebP 动画编码（使�?`gif` crate �?`webp` crate），支持按用户指定的宽度或高度约束等比缩放（保持原始宽高比）、帧率、循环次�?- **FR-039**: Rust �?MUST 实现全景拼接：ORB 特征检�?+ Brute-Force 匹配 + RANSAC Homography + Warp + Multi-band Blending；输出支�?PNG 编码�?WebP 无损编码
- **FR-040**: Rust �?MUST 通过 mpsc channel �?C# 端推送进度事件（每个生成任务一�?channel），C# 端转�?SSE 事件输出
- **FR-041**: Rust �?MUST 缓存已解码原始帧（LRU Cache，上�?100 帧），避免重复解码；缩略图路径使用独立的压缩解码缓存
- **FR-042**: 生成任务调度 MUST 基于可用资源动态调节：监控 CPU 使用率和可用内存，当资源紧张时自动限制并发任务数或降速处理，优先保障视频播放流畅度（seek-preview daemon 及流媒体传输不受影响）；不设硬编码并发上�?
**C# 端点**

- **FR-043**: MUST 新增 `FrameExportController`（`GET /JellyfinSuite/FrameExport/{itemId}?positionMs=N&width=W`）：width �?320 返回压缩缩略�?JPEG；width=0 或不传返回原始质�?JPEG
- **FR-044**: MUST 新增 `POST /JellyfinSuite/FrameExport/Generate` 接收 `{ itemId, frames: [{positionMs, ...}], type: "animate"|"stitch", params: {format, resizeMode, customWidth, customHeight, resolutionPreset, fps, loopCount} }` �?返回 `{ taskId }` 启动异步生成
- **FR-045**: MUST 新增 SSE 端点 `GET /JellyfinSuite/FrameExport/Progress?taskId={uuid}`，长连接推送进度事�?- **FR-046**: MUST 新增 `GET /JellyfinSuite/FrameExport/Result/{taskId}/{filename}` 提供生成结果文件访问
- **FR-047**: MUST 新增 `DELETE /JellyfinSuite/FrameExport/Result/{taskId}` 清理临时文件
- **FR-048**: MUST 新增 `POST /JellyfinSuite/FrameExport/Cancel/{taskId}` 取消进行中的生成任务（强�?kill 对应 Rust 子进�?+ 清理临时文件�?
**通用**

- **FR-049**: 所有新�?UI 文字 MUST 支持中文、日语、英语三�?- **FR-050**: 帧导出功�?MUST 不破�?Jellyfin 原有播放器的任何现有功能
- **FR-051**: DRM 内容 MUST 禁用帧导出按�?- **FR-052**: 整个 player-enhancer 前端 MUST 使用 **@alivecss/aliveui** CSS 框架（`aliveui`）进行样式开发，替换 `styles.ts` 中所有自定义 CSS（OSD 按钮、亮�?音量指示器、速度 OSD、seek OSD、截�?UI、帧选择�?Modal 等全部组件统一使用 @alivecss/aliveui 语义类名和内联工具类�?
**自动化拼接质量评分**

- **FR-053**: Rust `crates/frame-forge/src/stitch/` 各拼接模块 MUST 在 `#[cfg(test)]` 块内实现质量评分函数，计算以下指标：SSIM（结构相似度，≥0.80 为通过）、接缝像素梯度跳变均值（≤25.0 为通过）、色差 ΔE（CIELAB L*a*b* 欧氏距离，≤10.0 为通过）
- **FR-054**: 场景 B/C 拼接模块（`stitch_landscape.rs`、`stitch_liveaction.rs`）MUST 在测试中额外输出 RANSAC 内点率（内点数/总匹配数，≥0.40 为通过）和 RMSE（对应点重投影误差，≤5.0px 为通过）
- **FR-055**: `tests/stitch-eval/score.py` Python 脚本 MUST 接收测试图像对目录（含输入帧和对应参考拼接结果），批量计算上述指标，以 JSON 格式输出评分卡（每对图像一条记录 + 整体汇总），任一指标低于阈值时退出码为 1
- **FR-056**: 合成测试序列 MUST 可通过 `tests/stitch-eval/gen_synthetic.sh` 生成：对真实视频裁切水平平移子图（模拟 Pan 镜头），用于场景 A Phase Correlation 路径验证；SEAGULL / UDIS-D 数据集图像对用于场景 B/C 路径验证（数据集准备方法详见 research.md）
- **FR-057**: 评分指标阈值 MUST 在 `tests/stitch-eval/thresholds.json` 中统一配置（不硬编码），Rust 测试和 Python 脚本均从此文件读取


### Key Entities

- **帧选择�?Modal**: 多页�?SPA 前端组件（网格页 / 进度�?/ 成果页），管理帧选择、参数配置、SSE 进度监听、成果预览全流程
- **导出参数设置 (localStorage)**: `{ animateFormat, stitchFormat, resizeMode, customWidth, customHeight, resolutionPreset, fps, loopCount }` 对象；`resizeMode` �?"width"（按宽度约束）或 "height"（按高度约束），用户设置一个维度后另一个自动计算并锁定
- **生成任务 (Task)**: 后端异步任务实体，包�?`taskId` (UUID)、类�?(animate/stitch)、帧列表、参数、状�?(pending/running/complete/error/cancelled)、进�?channel、结果文件路�?- **FrameExport 端点 (C#)**: HTTP 端点集，负责帧缩略图获取、生成任务提�?取消、SSE 进度推送、结果文件下�?删除、定时文件清�?- **frame-forge Daemon (Rust 进程)**: 服务端长驻进程，负责视频帧解码（ffmpeg-next）、帧质量检测、动画编码（gif/webp crate）、全景拼接（自实�?Homography pipeline）；通过 Unix socket + mpsc channel �?C# 通信
- **帧质量评�?*: 每帧携带的质量元数据（亮度方差、Laplacian 方差、帧间差异），供前端自动标记垃圾�?- **临时文件目录**: `{DataPath}/temp/frame-forge/{taskId}/`，存放生成中间帧和最终产物，受定时清理策略管�?
---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 用户可在播放界面 4 次交互内（点击按�?�?调整参数 �?点击生成 �?下载成果）完成动画导�?- **SC-002**: 帧选择器初始加�?11 帧缩略图�?2 秒内完成（含网络请求 + 解码�?- **SC-003**: 动画导出�?0 �?× 480p）在 8 秒内完成（含解码 + 编码�?- **SC-004**: 全景拼接�? �?× 720p）在 15 秒内完成（含特征匹配 + Homography + Blending�?- **SC-005**: 帧质量检测准确率：黑�?白帧检测率 >95%，模糊帧检测率 >85%
- **SC-006**: 全景拼接成功率（有足够重叠区域的同场景帧）：>80% 产出一张视觉可接受的全景图（允许局部拼缝）
- **SC-007**: SSE 进度推送延�?< 500ms（从后端状态变更到前端 UI 更新�?- **SC-008**: 参数自动持久化：100% 的参数变更在下一次打开 Modal 时正确恢�?- **SC-009**: 新增功能不导致播放器原有功能（帧步进、截图、手势等）的任何回归

---

## Assumptions

- 目标 Jellyfin 版本�?10.10.x，Docker 部署环境�?ffmpeg libs；GPU 加速为可选：Docker 需 `--device /dev/dri` 透传 + 容器内安�?`intel-compute-runtime`（或 NVIDIA 对应驱动），未配置时自动 CPU fallback
- 视频文件存在�?Jellyfin 服务器本地文件系统（远程 URL / IPTV 流不支持帧导出）
- Rust daemon 部署�?Linux 二进制（�?seek-preview），�?Linux 环境功能静默降级
- 全景拼接 v1 仅支持静态镜头场景（摄像机无明显运动），水平拼接受限
- GIF 输出色彩使用调色板量化（最�?256 色），WebP 支持全色�?- 全景拼接 Homography 退化时回退为简单堆叠（并排拼接），不做全局优化（如 Bundle Adjustment�?- 本功能与 seek-preview 共享 ffmpeg-next 框架�?LRU 缓存设计模式，可在同一 Rust binary 中实�?- 前端 Modal 及整�?player-enhancer 样式体系统一迁移�?@alivecss/aliveui CSS 框架（安装为 npm 依赖）；`styles.ts` 中现有自定义 CSS 全部替换�?@alivecss/aliveui 语义类名和工具类，仅保留 CSS 注入入口函数
- poster-gen 已有�?SSE 进度模式、成果下�?删除 UI 模式可作为参考直接复�?- 临时文件目录 `{DataPath}/temp/frame-forge/` 在服务启动时自动创建，由 C# 后台定时器每 5 分钟扫描清理过期任务
- 生成任务为服务端异步执行（不阻塞 HTTP 请求），C# 通过 mpsc channel 接收 Rust 进度事件并桥接到 SSE

