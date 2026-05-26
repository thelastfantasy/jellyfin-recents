# Implementation Plan: Frame Export & Stitch

**Branch**: `feature/009-frame-forge-stitch` | **Date**: 2026-05-26 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/009-frame-forge-stitch/spec.md`

## Summary

�?player-enhancer 播放�?OSD 中新�?帧导�?按钮，点击后弹出 @alivecss/aliveui 驱动的多页面 Modal（网格页/进度�?成果页）。用户浏览并勾选关键帧缩略图，配置导出参数（格式、分辨率约束、帧率、循环次数），通过 SSE 实时接收后端生成进度，最终下�?GIF/WebP 动画或全景拼接图�?
后端新增 Rust `frame-forge` daemon（扩�?seek-preview 架构），负责：ffmpeg-next 帧解码、帧质量检测（亮度/Laplacian 方差/pHash）、GIF/WebP 动画编码、三场景全景拼接（动漫→Phase Correlation + rustfft / 风景→AKAZE + OpenCV / 真人→帧差掩�?+ AKAZE）。C# 端新�?FrameExportController 提供帧缩略图 API、异步生成任务管理、SSE 进度推送、结果文件下�?删除�?
## Technical Context

**Language/Version**: Rust 1.88 (frame-forge daemon) + TypeScript 5.x (player-enhancer) + C# .NET 8 (plugin 端点)
**Primary Dependencies**:
- Rust: `tokio`（async runtime）、`ffmpeg-next`（内存帧解码）、`image` + `imageproc`（图像处理）、`opencv`（AKAZE/BFMatcher/RANSAC，场�?B/C）、`rustfft`（Phase Correlation，场�?A）、`gif`（GIF 编码）、`webp`（WebP 编码）、`lru`（缓存）、`anyhow`
- C#: .NET 8 内置（UnixDomainSocket, SSE, SemaphoreSlim）；`System.Text.Json` 序列�?- TypeScript: **@alivecss/aliveui** CSS 框架（新�?npm 依赖，替�?`styles.ts` 全量 CSS）；`EventSource` API（SSE 客户端，内置�?
**Storage**: Rust LruCache�?00 条原始帧）；C# 任务内存字典（ConcurrentDictionary）；服务端临时文件目�?`{DataPath}/temp/frame-forge/{taskId}/`（定�?5min 清理�?**Testing**: `make test` �?`cargo test`（frame-export�? TypeScript 编译 + C# 编译；手动端到端验证
**Target Platform**: Jellyfin Docker 容器（Linux x64）；前端桌面 + 移动�?Chrome/Safari；GPU 加速可选（OpenCL，需 Docker 透传 `/dev/dri` + `intel-compute-runtime`�?**Project Type**: Monorepo �?Rust daemon + C# plugin + TypeScript frontend module
**Performance Goals**: 缩略�?11 帧加�?�?2s；动画导�?10帧�?80p �?8s；全景拼�?5帧�?20p �?15s；SSE 推送延�?< 500ms
**Constraints**: 不阻碍视频播放（FR-042 资源动态调度）；不引入临时磁盘文件用于解码（全内存路径）；Linux-only Rust 二进制（Windows 降级�?**Scale/Scope**: 新增 `src/frame-forge/` crate + C# 5 个新文件 + TypeScript 8 个新/修改文件 + 构建基础设施更新

## Constitution Check

constitution.md 为空模板，无具体 gates。遵循项目现有约定：
- 不破�?Jellyfin 原生播放器功�?�?- TypeScript / C# / Rust 编译无错 �?- 所有用户可见文字三语支持（zh/ja/en）✅
- 复用现有架构模式（Unix socket、mpsc channel、SSE）✅
- Linux-only Rust 二进制，�?Linux 静默降级 �?- 新增 npm 依赖（AliveUI）属必要 �?
## Project Structure

### Documentation (this feature)

```text
specs/009-frame-forge-stitch/
├── spec.md
├── plan.md              �?本文�?├── research.md          �?Phase 0 输出
├── data-model.md        �?Phase 1 输出
├── quickstart.md        �?Phase 1 输出
├── contracts/
�?  └── api.md           �?Phase 1 输出
└── tasks.md             �?Phase 2 (speckit-tasks)
```

### Source Code �?New Files

```text
src/frame-forge/
├── Cargo.toml
└── src/
    ├── main.rs              # daemon 入口：tokio runtime + Unix socket
    ├── protocol.rs           # 二进制协议帧 R/W（扩�?seek-preview 协议�?    ├── server.rs             # 连接处理 + 任务分发 + 进度 channel
    ├── decoder.rs            # ffmpeg-next 帧解�?+ 缩放
    ├── quality.rs            # 帧质量检测（亮度方差/Laplacian/pHash�?    ├── scene_classifier.rs   # 场景分类器（动漫/风景/真人�?    ├── stitch_anime.rs       # Phase Correlation 拼接（rustfft�?    ├── stitch_landscape.rs   # AKAZE + Phase Corr 兜底（opencv crate�?    ├── stitch_liveaction.rs  # 帧差掩码 + AKAZE（opencv crate�?    ├── blender.rs            # Laplacian 金字塔多频带混合
    ├── animate.rs            # GIF/WebP 动画编码
    └── resources.rs          # CPU/内存资源监控（FR-042 动态调度）

src/JellyfinSuite.Plugin/
├── Services/
�?  ├── FrameExportService.cs       # 进程管理 + Unix socket 连接 + 任务调度
�?  └── FrameExportTaskManager.cs   # 任务生命周期 + 进度 channel �?SSE 桥接 + 临时文件清理
├── Controllers/
�?  └── FrameExportController.cs    # HTTP 端点�? �?endpoint�?└── Models/
    └── FrameExportDto.cs           # 请求/响应 DTO

src/player-enhancer/src/
├── frame-forge.ts          # Modal 主入�?+ 多页面路�?├── frame-selector.ts        # 网格页：缩略图加�?checkbox/扩展/垃圾帧标�?├── frame-params.ts          # 参数面板：格�?分辨率约�?帧率/循环次数 + localStorage
├── frame-progress.ts        # 进度页：SSE 连接/进度�?步骤文字
├── frame-result.ts          # 成果页：预览/下载/删除/返回
├── icons.ts                 # 修改：新增帧导出按钮 SVG 图标
├── injector.ts              # 修改：注入帧导出按钮�?OSD
└── styles.ts                # 重写：全量迁移到 @alivecss/aliveui
```

### Source Code �?Modified Files

```text
Makefile                              # 新增 build-frame-forge target；test-rust/update 追加
.github/workflows/build.yml           # opencv dev libs + frame-forge cargo test
.github/workflows/release.yml         # frame-forge Linux 二进制构�?+ zip 打包
src/player-enhancer/package.json      # 新增 @alivecss/aliveui 依赖
src/player-enhancer/vite.config.ts    # 可能需调整（若 @alivecss/aliveui 需要特�?CSS 处理�?```

---

## Architecture

### 整体数据�?
```
┌─────────────────────────────────────────────────────────────────────�?�?前端 (player-enhancer)                                              �?�?                                                                    �?�? OSD 按钮 �?Modal 打开                                              �?�?    �?                                                              �?�?    ├─ 网格页：GET /JellyfinSuite/FrameExport/{id}?positionMs=N    �?�?    �?        &width=320 �?JPEG 缩略�?×11                          �?�?    �?        (宽度�?20=压缩缩略图；w=0=原图，生成阶段用)            �?�?    �?                                                              �?�?    ├─ 参数面板：格�?宽高约束/预设/帧率/循环次数                     �?�?    �?         �?localStorage 自动读写                               �?�?    �?                                                              �?�?    ├─ 生成提交：POST /JellyfinSuite/FrameExport/Generate           �?�?    �?         �?返回 { taskId }                                    �?�?    �?                                                              �?�?    ├─ 进度页：GET /JellyfinSuite/FrameExport/Progress?taskId=     �?�?    �?        SSE 长连�?�?phase/percent/progress 事件               �?�?    �?                                                              �?�?    └─ 成果页：status:complete �?GET Result/{taskId}/output.{ext}  �?�?            展示预览 + 下载/删除/返回                                  �?└─────────────────────────────────────────────────────────────────────�?                              �?                              �?┌─────────────────────────────────────────────────────────────────────�?�?C# FrameExportController + FrameExportService                       �?�?                                                                    �?�? FrameExportController (8 endpoints):                               �?�?   GET  /FrameExport/{itemId}?positionMs=N&width=W                  �?�?   POST /FrameExport/Generate  �?{ taskId }                         �?�?   GET  /FrameExport/Progress?taskId= �?SSE                         �?�?   GET  /FrameExport/Result/{taskId}/{filename}                     �?�?   DELETE /FrameExport/Result/{taskId}                              �?�?   POST /FrameExport/Cancel/{taskId}                                �?�?                                                                    �?�? FrameExportService:                                                �?�?   - 启动/保活 frame-forge daemon 进程                              �?�?   - Unix socket 连接�?                                            �?�?   - �?task 分配独立 mpsc channel �?SSE 桥接                       �?�?   - 并发任务�?Semaphore(动态资源阈�? 控制                          �?�?   - 取消 �?kill 子进�?�?rm -rf {taskDir}                           �?�?                                                                    �?�? FrameExportTaskManager:                                            �?�?   - 5min 定时器扫描过期任务目录并清理                                �?�?   - 服务启动时清理残留孤儿临时目�?                                  �?└─────────────────────────────────────────────────────────────────────�?                              �?                              �?┌─────────────────────────────────────────────────────────────────────�?�?Rust frame-forge daemon (tokio + Unix socket)                      �?�?                                                                    �?�? main.rs �?UnixListener �?每连�?spawn task                         �?�?                                                                    �?�? 请求类型�?                                                         �?�?   0x10 = SINGLE_FRAME (单帧解码 + 质量检�?                         �?�?   0x11 = ANIMATE (多帧 �?GIF/WebP 编码)                             �?�?   0x12 = STITCH (多帧 �?场景分类 �?拼接 �?混合)                      �?�?                                                                    �?�? SINGLE_FRAME 流程�?                                                �?�?   解码(width=0→原�?/ >0→压�? �?质量检�?�?返回 JPEG + q_meta     �?�?                                                                    �?�? ANIMATE 流程�?                                                     �?�?   逐帧解码原图 �?按参数缩�?�?GIF/WebP 编码 �?字节返回               �?�?   (每帧完成推�?progress event)                                     �?�?                                                                    �?�? STITCH 流程�?                                                      �?�?   场景分类�?�?路由到三个算法路径之一�?                             �?�?     A) Anime: FFT �?PhaseCorr �?平移拼接 �?Blender                 �?�?     B) Landscape: AKAZE + PhaseCorr 兜底 �?Homography �?Blender     �?�?     C) LiveAction: 帧差掩码 �?AKAZE �?多帧聚合 Homography �?Blender �?�?   (每阶段完成推�?progress event)                                   �?�?                                                                    �?�? 资源监控（FR-042）：                                                �?�?   tokio::spawn 定时采集 /proc/stat + /proc/meminfo                  �?�?   �?计算 CPU 使用�?�?可用内存百分�?                               �?�?   �?超过阈值时 Semaphore::acquire 阻塞新任�?                       �?�?   �?优先保障 seek-preview daemon 响应延迟 < 50ms                   �?└─────────────────────────────────────────────────────────────────────�?```

### 二进制协议（Unix socket �?扩展 seek-preview�?
```
已有帧类型（复用）：
  [1 byte]  priority: 0x01=FETCH, 0x02=PREFETCH
  [4 bytes] request_id (u32 LE)
  [8 bytes] pos_ms (i64 LE)
  [4 bytes] width (i32 LE)
  [4 bytes] path_len (u32 LE)
  [N bytes] file path (UTF-8)

新增帧类型（�?feature）：
  0x10 = SINGLE_FRAME
  [1 byte]  msg_type: 0x10
  [4 bytes] request_id
  [8 bytes] pos_ms
  [4 bytes] width (0=原图)
  [4 bytes] path_len
  [N bytes] path

  响应：同 FETCH 格式（JPEG bytes�? [2 bytes] q_flags (bit0=black, bit1=white, bit2=blur)

  0x11 = ANIMATE
  [1 byte]  msg_type: 0x11
  [4 bytes] task_id_len
  [N bytes] task_id (UTF-8)
  [4 bytes] frame_count
  [repeat frame_count]: [8 bytes pos_ms + 4 bytes path_len + N bytes path]
  [2 bytes] format: 0x01=GIF, 0x02=WebP
  [2 bytes] resize_mode: 0x01=width, 0x02=height
  [4 bytes] target_px (自定义像素�?
  [2 bytes] fps
  [2 bytes] loop_count (0=infinite)

  响应：每个进度事�?`[4 bytes status_code (0=ok/1=error/2=done), N bytes json]`
        最�?`status_code=2` 后跟输出文件字节

  0x12 = STITCH
  [1 byte]  msg_type: 0x12
  [4 bytes] task_id_len
  [N bytes] task_id (UTF-8)
  [4 bytes] frame_count
  [repeat frame_count]: [8 bytes pos_ms + 4 bytes path_len + N bytes path]
  [2 bytes] format: 0x01=PNG, 0x02=WebP-lossless
  [2 bytes] resize_mode  (0=原始)
  [4 bytes] target_px

  响应：同 ANIMATE（progress events + final output bytes�?```

### C# 并发控制

| 组件 | 并发策略 |
|------|----------|
| Unix socket �?| `SemaphoreSlim(1,1)`（同 seek-preview�?|
| 任务提交 | `ConcurrentDictionary<taskId, TaskState>` 无锁查重 |
| 任务执行 | 动态资源感�?Semaphore（初�?permits = cpu_cores/2，根�?CPU 使用率动态调整） |
| SSE 推�?| �?task 独立 `Channel<TaskProgress>`，C# �?`ChannelReader.ReadAllAsync` �?SSE |
| 临时文件清理 | 单例 `Timer`�?min 间隔），锁保护目录枚�?|

---

## Dependencies & Execution Order

```
Phase 1: Setup（crate 骨架 + 构建�?  �?Phase 2: Foundational（Rust 核心 �?解码 + 质量检�?+ 协议�?  �?Phase 3: 动画导出（GIF/WebP 编码 �?可并�?Phase 4�?  �?Phase 4: 全景拼接（场景分�?+ 三条算法路径 + Blender�?  �?Phase 5: C# 端点（FrameExportController + Service + TaskManager�? �?可与 Phase 6 并行
  �?Phase 6: 前端（Modal 多页�?+ @alivecss/aliveui 迁移 + 参数/SSE/成果�?  �?Phase 7: 集成与部署验�?```

---

## Phase 0: Research

详见 [research.md](research.md)。关键决策摘要：

| 决策 | 结论 |
|------|------|
| 帧提取方�?| ffmpeg-next crate（复�?seek-preview 基础设施，无临时文件�?|
| 全景拼接（动漫） | Phase Correlation (`rustfft` crate)，不依赖 OpenCV |
| 全景拼接（风�?真人�?| `opencv` crate（AKAZE + BFMatcher + RANSAC），Docker 通过 `apt install libopencv-dev` 引入 |
| GPU 加�?| 可�?OpenCL，启动时检测；未配置时静默 CPU fallback |
| 场景分类 | �?Rust 启发式规则（颜色�?+ 边缘密度 + 帧差），计算量极�?|
| 近重复帧检�?| �?Rust pHash 实现，自动标记冗余帧 |
| 动画编码 | `gif` crate + `webp` crate，内存编�?|
| IPC | Unix domain socket（复�?seek-preview 二进制协议帧格式�?|
| 取消机制 | 强制 kill 子进�?+ 清理临时目录（无需优雅取消�?|
| CSS 框架 | @alivecss/aliveui 全量迁移 player-enhancer（替�?styles.ts�?|

## Phase 1: Design

### 1. data-model.md

详见 [data-model.md](data-model.md)。核心实体：

- **FrameExportTask**：任务实体（taskId, itemId, type, params, status, progress channel, output path�?- **FrameQualityMeta**：帧质量元数据（brightness_var, laplacian_var, frame_diff, is_junk�?- **ExportParams**：导出参数（format, resizeMode, customWidth/customHeight, resolutionPreset, fps, loopCount�?- **SceneClassification**：场景分类结果（category, confidence, motion_type�?
### 2. API Contracts

详见 [contracts/api.md](contracts/api.md)。共 8 个端点：

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/FrameExport/{itemId}` | 获取单帧 JPEG（缩略图或原图） |
| POST | `/FrameExport/Generate` | 提交异步生成任务 |
| GET | `/FrameExport/Progress` | SSE 进度事件�?|
| GET | `/FrameExport/Result/{taskId}/{filename}` | 下载生成结果文件 |
| DELETE | `/FrameExport/Result/{taskId}` | 删除结果 + 清理临时文件 |
| POST | `/FrameExport/Cancel/{taskId}` | 取消任务（kill 子进程） |
| GET | `/FrameExport/FrameMeta/{itemId}` | 批量帧质量元数据（可选优化） |
| GET | `/FrameExport/Health` | 服务健康检查（daemon 是否存活�?|
