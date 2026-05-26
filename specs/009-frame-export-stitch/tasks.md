# Tasks: Frame Export & Stitch

**Input**: Design documents from `specs/009-frame-forge-stitch/`
**Prerequisites**: plan.md ?, spec.md ?, research.md ?, data-model.md ?, contracts/api.md ?, quickstart.md ?

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup — crate 骨架 + 构建 + AliveUI 引入

**Purpose**: 建立 frame-forge Rust crate、C# 服务骨架、AliveUI npm 依赖、Makefile/CI 更新。

- [ ] T001 创建 `src/frame-forge/Cargo.toml`：package `frame-forge` edition 2021；依赖 tokio(full)、ffmpeg-next(codec+format+software-scaling)、image、imageproc、lru、anyhow、gif、webp、serde、serde_json、opencv、rustfft
- [ ] T002 创建 `src/frame-forge/src/main.rs` 占位骨架（空 `tokio::main`，`cargo check` 通过）
- [ ] T003 [P] 创建 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 占位骨架：类声明 + IDisposable + Unix socket 路径常量 + StartAsync/StopAsync stub
- [ ] T004 [P] 创建 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 占位骨架：ApiController + Route("JellyfinSuite/FrameExport") + AllowAnonymous + 构造函数 DI
- [ ] T005 [P] 创建 `src/JellyfinSuite.Plugin/Models/FrameExportDto.cs`：定义 GenerateRequest、GenerateResponse、TaskProgress、FrameQualityMeta 等 DTO 类
- [ ] T006 [P] 安装 AliveUI：`cd src/player-enhancer && npm install aliveui`，确认 `package.json` 有依赖记录
- [ ] T007 更新 `Makefile`：新增 build-frame-forge target（Docker ubuntu:24.04 + libopencv-dev + ffmpeg dev libs + cargo build --release → cp 到 Plugin 目录）、build 依赖加 build-frame-forge、update 追加 docker cp、test-rust 追加 cd src/frame-forge && cargo test
- [ ] T008 [P] 更新 `.github/workflows/build.yml`：Cache Rust build workspaces 加 src/frame-forge、新增 apt install libopencv-dev libavcodec-dev... 步骤、test-rust 由 Makefile 自动覆盖
- [ ] T009 [P] 更新 `.github/workflows/release.yml`：Cache Rust build workspaces 加 src/frame-forge、新增 apt install libopencv-dev、新增 Build frame-forge (Linux x64) 步骤（cargo build --release）、Copy binaries 步骤加 frame-forge-linux-x64、zip 打包加 frame-forge-linux-x64
- [ ] T010 在 `src/JellyfinSuite.Plugin/PluginServiceRegistrator.cs` 注册 FrameExportService 为单例

**Checkpoint**: `make build-frame-forge` 产出二进制；CI build.yml 绿；release.yml zip 含 frame-forge-linux-x64

---

## Phase 2: Foundational — Rust daemon 核心 + C# 通信层 + 前端入口

**Purpose**: 实现 Rust daemon 的 Unix socket 服务、协议帧解析、单帧解码+质量检测流水线；C# 进程管理与 socket 连接；前端 injector 注入帧导出按钮到 OSD。

**?? CRITICAL**: 所有 User Story 依赖此 Phase 完成。

### Rust — Socket + 协议 + 单帧解码

- [ ] T011 在 `src/frame-forge/src/main.rs` 实现 Unix socket 服务端（`tokio::net::UnixListener`）；socket 路径由命令行参数传入；启动时调用 `opencv::core::ocl::haveOpenCL()` 检测 GPU 可用性并设置全局 flag（用于后续 Warp/Blending 阶段决策）
- [ ] T011b [P] 在 `src/frame-forge/src/main.rs` 实现 `FrameCache` 结构体：`LruCache<(PathBuf, i64), Arc<DynamicImage>>`（100 条上限），key=(canonical_path, pos_ms/500*500)；暴露 `fn get_or_insert(path, pos_ms) -> Arc<DynamicImage>`，内部锁保护，供 handle_animate/handle_stitch 共享使用
- [ ] T012 [P] 在 `src/frame-forge/src/protocol.rs` 实现二进制协议帧读写函数：`read_msg_type`、`read_single_frame_req`、`read_animate_req`、`read_stitch_req`、`write_jpeg_response`、`write_progress_event`（参考 seek-preview `protocol.rs` 模式）
- [ ] T013 [P] 在 `src/frame-forge/src/decoder.rs` 从 seek-preview 的 `decoder.rs` 复制/适配核心逻辑：ffmpeg-next 打开文件 + 定位关键帧 + 解码为 RGB + width=0 返回原图 / width>0 用 Lanczos3 缩放 + JPEG 编码
- [ ] T014 [P] 在 `src/frame-forge/src/quality.rs` 实现帧质量检测：亮度直方图方差（黑/白帧）、3x3 Laplacian 方差（模糊帧）、帧间像素差异比（转场检测）；返回 `QualityFlags` bitmask + 文字标签
- [ ] T015 在 `src/frame-forge/src/main.rs` 实现 `handle_single_frame` 请求处理：解码(原图或缩略图) → 质量检测 → 返回 JPEG + quality_flags
- [ ] T016 [P] 在 `src/frame-forge/src/resources.rs` 实现 CPU/内存监控：读取 `/proc/stat` + `/proc/meminfo` → 计算 CPU 使用率和可用内存百分比；暴露 `fn resource_pressure() -> f64` (0=空闲, 1=饱和)

### C# — 进程管理 + Socket 连接

- [ ] T017 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现进程管理：$env:SPECIFY_FEATURE = "009-frame-forge-stitch" ; StartAsync 启动 frame-forge-linux-x64 子进程（Process.Start + Unix socket 路径参数）、StopAsync 优雅关闭、进程退出时 3s 后自动重连
- [ ] T018 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现 Unix socket 连接：`Socket(AddressFamily.Unix)` + `SemaphoreSlim(1,1)` 保护写入 + `ReceiveBytesAsync` 精确读取响应
- [ ] T019 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现 `GetFrameAsync(string filePath, long posMs, int width, Guid itemId, CancellationToken ct)` → 发送 0x10 SINGLE_FRAME 请求 → 返回 `(byte[] jpeg, QualityFlags flags)`

### 前端 — OSD 按钮注入

- [ ] T020 在 `src/player-enhancer/src/icons.ts` 新增帧导出按钮 SVG 图标 `ICON_FRAME_EXPORT`（建议用胶片格或网格图标）
- [ ] T021 修改 `src/player-enhancer/src/injector.ts`：在 `injectPlayerButtons` 中新增帧导出按钮（附在截图按钮后方），绑定 click → 打开帧导出 Modal（预留 `openFrameExportModal()` stub，具体实现在 US1 任务）
- [ ] T022 修改 `src/player-enhancer/src/styles.ts`：全量迁移到 AliveUI CSS 框架——删除所有自定义 CSS，改为 `import 'aliveui/css'` + 引入 AliveUI 主题变量；保留 CSS 注入入口函数 `injectStyles()`

**Checkpoint**: `GET /JellyfinSuite/FrameExport/{itemId}?positionMs=5000&width=320` 返回 JPEG 缩略图；OSD 栏出现新按钮；`styles.ts` 使用 AliveUI

---

## Phase 3: User Story 1 — 打开帧选择器 (Priority: P1) ?? MVP

**Goal**: 用户点击"帧导出"按钮后弹出 Modal，以网格形式展示当前播放进度前后 11 帧缩略图。

**Independent Test**: 播放任意视频，点击"帧导出"按钮，Modal 弹出并显示缩略图网格，点击遮罩关闭。

### Implementation

- [ ] T023 [P] [US1] 在 `src/player-enhancer/src/frame-forge.ts` 创建 Modal 容器壳：body-level 固定定位 + 遮罩 + AliveUI modal 样式 + 打开/关闭函数 `openFrameExportModal()` / `closeFrameExportModal()` + 关闭时暂停视频（可切换为不暂停）
- [ ] T024 [P] [US1] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现单帧缩略图端点：`GET /FrameExport/{itemId}?positionMs=N&width=320` → 调 `_service.GetFrameAsync()` → `File(jpeg, "image/jpeg")` + `Response.Headers["X-Frame-Quality"]` 返回质量元数据 JSON
- [ ] T025 [US1] 在 `src/player-enhancer/src/frame-forge.ts` 实现初始帧加载：计算当前播放进度前后 5 帧的时间戳列表 → Promise.all fetch 缩略图 → 渲染网格
- [ ] T026 [P] [US1] 在 `src/player-enhancer/src/frame-forge.ts` 实现网格渲染函数：活用 AliveUI grid 类 (`grid grid-cols-4 gap-2` 等) + 每格内含 `<img>` + 时间戳标签文字
- [ ] T027 [US1] 在 `src/player-enhancer/src/injector.ts` 的帧导出按钮 click handler 调用 `openFrameExportModal()`：传入 videoEl、getItemId()、getServerAddress()、getRawToken()
- [ ] T028 [US1] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现边界处理：itemId 不存在/无本地文件 → 404；daemon 不可用 → 503
- [ ] T029 [US1] 修改 `src/player-enhancer/src/i18n.ts`：新增 US1 相关 i18n key（zh/ja/en）：`frameExport.title`、`frameExport.close`、`frameExport.loading`

**Checkpoint**: 帧选择器 Modal 可打开、加载 11 帧缩略图、可关闭；端点 404/503 正确处理

---

## Phase 4: User Story 2 — 扩展获取更多关键帧 (Priority: P1)

**Goal**: 帧选择器中"向前"和"向后"按钮可追加更多帧缩略图。

**Independent Test**: 在帧选择器中点击"向前扩展"按钮，界面追加 10 帧缩略图；点击"向后扩展"同理；到达边界时按钮禁用。

### Implementation

- [ ] T030 [P] [US2] 在 `src/player-enhancer/src/frame-forge.ts` 实现"向前"/"向后"两个扩展按钮（AliveUI btn 样式 + 箭头图标），加载中显示 spinner + disabled
- [ ] T031 [US2] 在 `src/player-enhancer/src/frame-forge.ts` 实现扩展逻辑：维护当前显示帧范围 `[minPosMs, maxPosMs]` → 点击扩展时计算新范围（偏移 N×M 帧间隔）→ fetch 新帧 → append 到网格头部或尾部 + 滚动到新增位置
- [ ] T032 [US2] 实现请求合并（debounce 300ms）：快速连续点击扩展时只发送最后一次请求，避免 DDOS 后端
- [ ] T033 [US2] 实现边界检测：videoTime=0 时禁用"向前"按钮；videoTime≥duration 时禁用"向后"按钮；按钮文字变灰 + 提示文字（如"已到达视频开头"）

**Checkpoint**: 可自由前后浏览视频关键帧，边界处理正确

---

## Phase 5: User Story 3 — 帧选择与预览 (Priority: P1)

**Goal**: 每帧缩略图有 checkbox（默认勾选），垃圾帧自动取消勾选并标记，底部显示已选帧数。

**Independent Test**: 取消部分帧勾选，底部计数更新，勾选恢复；点击缩略图放大预览。

### Implementation

- [ ] T034 [P] [US3] 在 `src/player-enhancer/src/frame-forge.ts` 为每帧添加 checkbox（默认 checked）→ onChange 更新选中状态 + 底部工具栏计数 `"已选 X/总数 Y 帧"`
- [ ] T035 [P] [US3] 实现帧点击放大预览：点击缩略图（非 checkbox 区域）→ 在原位或 lightbox 中展示大图（调 GET 端点 width=0 获取原图）+ 显示时间戳
- [ ] T036 [US3] 解析 `X-Frame-Quality` 响应头：`isJunk=true` 的帧自动取消勾选 → UI 添加红色边框 + 标签文字（如 "黑帧"/"模糊帧"）→ 透明度降低
- [ ] T037 [US3] 实现全选/全不选快捷操作：底部工具栏添加"全选"/"取消全选"链接按钮

**Checkpoint**: 帧选择器 MVP 可交互——浏览、选择、预览帧

---

## Phase 6: User Story 4 — 导出动画 GIF/WebP (Priority: P2)

**Goal**: 用户配置参数后点击"生成"，后端生成 GIF/WebP 动画文件，通过 SSE 报告进度，成果展示在 Modal。

**Independent Test**: 选 3 帧，默认参数，点击生成 → SSE 进度 → Modal 展示动画预览 → 下载文件。

### Rust — 动画编码

- [ ] T038 [P] [US4] 在 `src/frame-forge/src/animate.rs` 实现 GIF 编码函数 `encode_gif(frames: Vec<DynamicImage>, fps: u16, loop_count: u16) -> Vec<u8>`：使用 `gif` crate 编码，调色板量化为 256 色
- [ ] T039 [P] [US4] 在 `src/frame-forge/src/animate.rs` 实现 WebP 编码函数 `encode_webp_anim(frames: Vec<DynamicImage>, fps: u16, loop_count: u16) -> Vec<u8>`：使用 `webp` crate 动画编码
- [ ] T040 [US4] 在 `src/frame-forge/src/animate.rs` 实现缩放逻辑：根据 `resizeMode`("width"/"height") + `customWidth/customHeight` 或 `resolutionPreset` → `image::imageops::resize`(Lanczos3) 等比缩放每帧
- [ ] T041 [US4] 在 `src/frame-forge/src/main.rs` 实现 `handle_animate` 请求：逐帧解码原图(width=0) → 质量检测(跳过,仅记录) → 缩放 → push 帧缓冲 → 调用 encode_xxx → 每帧完成推送 progress event → 最终返回编码字节

### C# — 任务管理 + 生成端点

- [ ] T042 [P] [US4] 在 `src/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs` 实现任务字典：`ConcurrentDictionary<taskId, TaskState>` + 任务状态枚举 (pending→running→complete/error/cancelled) + 每任务持有 `Channel<TaskProgress>` 用于 SSE 桥接
- [ ] T043 [US4] 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现 `SubmitAnimateTask(GenerateRequest req) -> taskId`：生成 UUID → 创建 TaskState → 写入 `{tempDir}/{taskId}/` → 遍历 frames 调 Rust GetFrameAsync 缓存原始帧到磁盘 → 调 Rust handle_animate → 写 output 文件 → 设 status=complete
- [ ] T044 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `POST /FrameExport/Generate` 端点：验证 params（fps 1-30, 至少 2 帧）→ `_service.SubmitAnimateTask()` → 202 { taskId }
- [ ] T045 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `GET /FrameExport/Result/{taskId}/{filename}` 端点：文件存在且 status=complete → File(bytes, content-type) + Content-Disposition 下载头
- [ ] T046 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `DELETE /FrameExport/Result/{taskId}` 端点：`Directory.Delete(tempDir, recursive)` + 移除字典记录 → 200
- [ ] T047 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `POST /FrameExport/Cancel/{taskId}` 端点：调 Process.Kill() + WaitForExit(3000) + `rm -rf tempDir` + status=cancelled → 200
- [ ] T048 [P] [US4] 在 `src/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs` 实现 5 分钟定时清理：`Timer` → 遍历字典 → createdAt+5min 过期 → `Directory.Delete(tempDir, recursive)` + 移除记录
- [ ] T049 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `GET /FrameExport/Health` 端点：返回 daemon 可用状态 + 活跃任务数 + CPU/内存使用率

**Checkpoint**: cURL 测试 Generate → Progress(SSE) → Result download 全流程通过

---

## Phase 7: User Story 7 — SSE 进度与成果管理 (Priority: P2)

**Goal**: 前端通过 SSE 接收进度事件，展示进度条和步骤文字；完成后自动展示成果预览（动画循环播放），成果页提供下载/删除/返回操作。

**Independent Test**: 点击生成 → 进度条逐步增长 → 完成后自动跳成果预览 → 点击下载获得正确文件。

### 前端 — SSE + 进度页 + 成果页

- [ ] T050 [P] [US7] 在 `src/player-enhancer/src/frame-progress.ts` 实现 SSE 进度连接：`new EventSource(url)` → `onmessage` 解析 JSON → 更新进度状态；`onerror` 自动重连(最多3次, 间隔1s)
- [ ] T051 [US7] 在 `src/player-enhancer/src/frame-progress.ts` 实现进度 UI：顶部进度条(AliveUI progress) + 百分比文字 + 当前步骤描述文字(phase→i18n 映射："decoding"→"解码中"、"encoding"→"编码中"、"matching"→"特征匹配中"等)
- [ ] T052 [P] [US7] 在 `src/player-enhancer/src/frame-result.ts` 实现成果预览页：动画 `<img>` 元素加载 resultUrl 循环播放；全景图 `<img>` 适配容器 + 拖动/缩放；显示 fileSize（格式化为 KB/MB）
- [ ] T053 [P] [US7] 在 `src/player-enhancer/src/frame-result.ts` 实现"下载"按钮：`window.open(resultUrl)` 触发浏览器下载；"删除"按钮：`DELETE /FrameExport/Result/{taskId}` → 清理成功 → 返回网格页；"返回"按钮：调 delete + 返回网格页
- [ ] T054 [US7] 在 `src/player-enhancer/src/frame-forge.ts` 实现页面切换逻辑：网格页 → 提交 Generate → 切换到进度页(T050+T051) → status=complete → 切换到成果页(T052+T053)
- [ ] T055 [US7] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 SSE 端点：`GET /FrameExport/Progress?taskId={uuid}` → `Response.ContentType = "text/event-stream"` → `ChannelReader.ReadAllAsync` → `"data: {json}\n\n"` → channel 关闭时断开连接

**Checkpoint**: 端到端 SSE 流程——提交任务 → 实时进度 → 成果预览 → 下载/删除/返回

---

## Phase 8: User Story 6 — 导出参数配置与持久化 (Priority: P2)

**Goal**: 格式下拉菜单、分辨率约束（宽/高互斥+预设档位）、帧率滑块、循环次数输入。所有参数自动 localStorage 持久化。

**Independent Test**: 修改帧率 15fps、分辨率 720p → 关闭 Modal → 再打开 → 参数恢复。

### Implementation

- [ ] T056 [P] [US6] 在 `src/player-enhancer/src/frame-params.ts` 实现 `LocalExportSettings` 类型 + `loadSettings(): LocalExportSettings` / `saveSettings(s: LocalExportSettings)` 函数（localStorage key: `jfs-frameexport-settings`，默认值：GIF/PNG、width、original、5fps、infinite loop）
- [ ] T057 [US6] 在 `src/player-enhancer/src/frame-forge.ts` 底部工具栏实现格式下拉菜单（AliveUI dropdown）：动画模式下 GIF/WebP 选项、全景图模式下 PNG/WebP-lossless 选项；默认值从 localStorage 读取
- [ ] T058 [P] [US6] 在 `src/player-enhancer/src/frame-params.ts` 实现参数面板组件（折叠式 AliveUI details/summary）：分辨率约束模式切换（"按宽度"/"按高度" radio）+ 自定义像素输入（一个可编辑，另一个自动计算并置灰）+ 预设档位下拉（选择后自动切回"按宽度"）+ 帧率滑块(1-30) + 循环次数输入(0-99)
- [ ] T059 [US6] 实现参数联动逻辑：`resizeMode` 切换 → 另一输入框自动计算(保持宽高比) + 置灰 disabled；预设档位选择 → 自动切 resizeMode="width" + 填预设值；动画模式下隐藏帧率/循环次数外的拼接相关参数
- [ ] T060 [US6] 实现参数变更 → 自动 `saveSettings()` + `Generate` 请求 body 读取当前 params

**Checkpoint**: 所有参数可调节、自动持久化、宽高互斥联动正确

---

## Phase 9: User Story 8 — 多页面 Modal 导航 (Priority: P3)

**Goal**: Modal 内三页面栈结构（网格页 → 进度页 → 成果页），顶部导航栏随页面切换变化。

**Independent Test**: 网格页 → 点击生成 → 进度页 → 完成 → 成果页 → 返回 → 网格页。

### Implementation

- [ ] T061 [P] [US8] 在 `src/player-enhancer/src/frame-forge.ts` 实现页面栈管理：`currentPage: "grid" | "progress" | "result"` + `navigateTo(page, ...)` 函数 + 页面切换时显示/隐藏对应 DOM 容器
- [ ] T062 [P] [US8] 实现顶部导航栏渲染函数：网格页 → 标题"帧导出" + X 关闭按钮；进度页 → 标题"生成中" + 取消按钮；成果页 → 标题"预览" + 返回按钮(←) + X 关闭按钮
- [ ] T063 [US8] 实现取消按钮逻辑：调 `POST /FrameExport/Cancel/{taskId}` → 导航回网格页
- [ ] T064 [US8] 实现 Modal 关闭时清理：调 `DELETE /FrameExport/Result/{taskId}`（如有活跃任务）→ 移除 Modal DOM

**Checkpoint**: 三页面导航流畅；取消、返回、关闭按钮均正确清理资源

---

## Phase 10: User Story 5 — 导出全景图 (Priority: P3)

**Goal**: 用户选帧后点击"导出全景图"，Rust 端按场景分类走对应算法路径，SSE 报告进度，完成后展示全景预览。

**Independent Test**: 选 3 帧同场景帧 → 点击导出全景图 → SSE 进度 → Modal 展示全景 → 下载 PNG。

### Rust — 场景分类器

- [ ] T065 [P] [US5] 在 `src/frame-forge/src/scene_classifier.rs` 实现场景分类器：输入多帧 → 计算颜色熵(`imageproc::stats::histogram` → entropy)、Canny 边缘密度(`imageproc::edges::canny` → count_nonzero/total_pixels)、帧间差分运动区域占比 → 分类为 anime/landscape/liveaction
- [ ] T066 [P] [US5] 在 `src/frame-forge/src/scene_classifier.rs` 实现镜头运动类型预检：前两帧间估算主导运动(pan/zoom/rotation/static) + 拼接方向(horizontal/vertical)

### Rust — 场景 A: 动漫 Phase Correlation

- [ ] T067 [P] [US5] 在 `src/frame-forge/src/stitch_anime.rs` 实现 Phase Correlation 拼接：灰度化 + 汉明窗加权 → 2D FFT(rustfft) → 归一化互功率谱 → IFFT → 峰值定位(抛物线插值亚像素) → (dx, dy) 平移 → 直接 warp 拼接
- [ ] T068 [US5] 在 `src/frame-forge/src/stitch_anime.rs` 实现多帧增量拼接：基准帧(首帧) → 相邻帧逐对计算 PhaseCorr → 累积平移偏移 → 拼接 + 更新基准

### Rust — 场景 B: 风景 AKAZE + Phase Correlation 兜底

- [ ] T069 [P] [US5] 在 `src/frame-forge/src/stitch_landscape.rs` 实现高纹理 ROI 掩码提取：梯度幅值图(`imageproc::gradients`) → 阈值分割 → ROI 掩码
- [ ] T070 [US5] 在 `src/frame-forge/src/stitch_landscape.rs` 实现 AKAZE + RANSAC Homography（opencv crate）：仅在 ROI 内做 AKAZE 检测 → BFMatcher(Hamming) → findHomography(RANSAC, threshold=3.0) → 若内点数<4 → 降级到 Phase Correlation
- [ ] T071 [P] [US5] 在 `src/frame-forge/src/stitch_landscape.rs` 实现宽画幅(FrameCount>5)柱面投影：用 opencv warp 柱面变换代替平面 Homography

### Rust — 场景 C: 真人 帧差掩码 + AKAZE

- [ ] T072 [P] [US5] 在 `src/frame-forge/src/stitch_liveaction.rs` 实现帧差运动掩码：相邻帧差分 → 形态学膨胀(3x3 kernel, 2 iterations) → 运动区域掩码
- [ ] T073 [US5] 在 `src/frame-forge/src/stitch_liveaction.rs` 实现掩码过滤 AKAZE + RANSAC：全图 AKAZE 检测 → 过滤掉落入运动掩码的关键点 → 对剩余静态背景点做 RANSAC Homography → 连续 N 帧 Homography 取分量中值(鲁棒聚合)
- [ ] T074 [P] [US5] 在 `src/frame-forge/src/stitch_liveaction.rs` 实现背景区域 warp + 前景区域双线性插值填充

### Rust — 混合 + 主流程

- [ ] T075 [P] [US5] 在 `src/frame-forge/src/blender.rs` 实现增益补偿：计算重叠区域平均亮度比 → 全局增益调整消除帧间色差
- [ ] T076 [US5] 在 `src/frame-forge/src/blender.rs` 实现 Laplacian 金字塔多频带混合：构建 4 层高斯金字塔 + Laplacian 金字塔 → 每层加权平均(权重=距帧边界的距离) → 重建合成图像
- [ ] T077 [US5] 在 `src/frame-forge/src/main.rs` 实现 `handle_stitch` 请求：解码原图 → 近重复帧剔除(pHash 相似度检测，标记冗余帧) → 场景分类器 → route 到 stitch_anime/stitch_landscape/stitch_liveaction → 增益补偿 + Blender → 按 format(PNG/WebP-lossless)编码 → 每阶段推送 progress event → 最终返回输出字节
- [ ] T078 [P] [US5] 在 `src/frame-forge/src/main.rs` 实现近重复帧检测(pHash)：`image::imageops::resize(8x8)` → 灰度化 → DCT → 比较汉明距离 → similarity>90% 标记冗余

### C# — 全景任务提交

- [ ] T079 [US5] 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现 `SubmitStitchTask(GenerateRequest req) -> taskId`：同 SubmitAnimateTask 模式，调 Rust handle_stitch 路径
- [ ] T080 [US5] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 的 `POST /FrameExport/Generate` 端点增加 `type: "stitch"` 路径分发

### 前端 — 全景导出 UI

- [ ] T081 [US5] 在 `src/player-enhancer/src/frame-forge.ts` 底部工具栏添加"导出全景图"按钮（与"导出动画"并列或在模式下切换）
- [ ] T082 [US5] 在 `src/player-enhancer/src/frame-result.ts` 全景图成果展示：`<img>` 大图适配容器 + `object-fit: contain` + 可拖动/缩放（如果 AliveUI 不提供，用简单的 CSS `overflow: auto` 容器）

**Checkpoint**: 全景拼接端到端——动漫走 PhaseCorr、风景走 AKAZE+PhaseCorr 兜底、真人走帧差+AKAZE；SSE 报告各阶段进度

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: 三语 i18n 补齐、错误处理完善、资源调度集成、DRM 检查、README 更新、端到端验证。

- [ ] T083 [P] 补全 `src/player-enhancer/src/i18n.ts` 所有新增 UI 文字的三语翻译（zh/ja/en）：frameExport 下所有页面的标题、按钮、状态文字；质量标签("黑帧"/"模糊帧")；进度阶段文字
- [ ] T084 [P] 前端错误处理完善：网络超时提示、SSE 重连次数耗尽提示、生成错误 retry 逻辑
- [ ] T085 在 `src/frame-forge/src/resources.rs` 集成资源感知调度到 `handle_animate` / `handle_stitch`：`resource_pressure() > 0.8`（即 CPU>80% 或 可用内存 <512MB 时的输出值）时 Semaphore 阻塞新任务，优先保障 seek-preview 延迟<50ms
- [ ] T086 [P] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 所有端点添加 DRM 检查（同 seek-preview 和 screenshot 模式）：item.MediaStreams 含 IsEncrypted → 403
- [ ] T087 [P] 在 `src/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs` 实现 EntryPoint 中孤儿目录清理：服务启动时 `Directory.Delete("temp/frame-forge", recursive)` → `Directory.CreateDirectory`
- [ ] T088 [P] 运行 `make test`：确认 Rust + TypeScript + C# 全套测试通过
- [ ] T089 `make update` 部署到 jellyfin-dev 容器，手动端到端验证：
  - 打开视频 → 点击帧导出 → 浏览/选择帧
  - 动画导出：配置参数 → 生成 → SSE 进度 → 预览 → 下载 GIF/WebP 正确
  - 全景拼接：选同场景帧 → 导出全景图 → SSE 阶段进度 → 预览 → 下载 PNG/WebP-lossless 正确
  - 取消任务 → 子进程被杀 + 临时文件清理
  - 关闭 Modal → 临时文件清理
  - 无本地路径视频 → 按钮禁用/404
  - CSS 验证：所有 UI 使用 AliveUI 类，无自定义 CSS 残留
- [ ] T090 [P] 检查 `README.md` / `README.zh-CN.md` 是否需要更新（新功能：帧导出与全景拼接）
- [ ] T091 [P] 更新 `src/player-enhancer/package.json` 的 `dependencies`（aliveui 版本固定）并检查无多余依赖
- [ ] T091b [P] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 暴露质量检测阈值配置端点：`GET /FrameExport/QualityThresholds` 返回当前阈值 JSON、`PUT /FrameExport/QualityThresholds` 接收 `{ blackBrightnessVarMin, whiteBrightnessVarMax, blurLaplacianVarMin }` → 存于 C# 静态字段（服务重启恢复默认值）；阈值传递到 Rust 端每次 SINGLE_FRAME 请求时作为 header 参数
- [ ] T091c 手动性能达标验证：缩略图 11 帧 ≤2s(SC-002)、动画 10f×480p ≤8s(SC-003)、全景 5f×720p ≤15s(SC-004)、黑/白帧检测率 >95% + 模糊帧检测率 >85%(SC-005)、拼接成功率 >80%(SC-006)、SSE 延迟 <500ms(SC-007)、参数持久化恢复 100%(SC-008)；记录对比数据写入 `specs/009-frame-forge-stitch/perf-validation.md`

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (T001–T010): Setup — 无依赖
  ↓
Phase 2 (T011–T022): Foundational — 依赖 Phase 1 完成
  ↓
Phase 3 (T023–T029): US1 帧选择器 — 依赖 Phase 2
  ↓
Phase 4 (T030–T033): US2 扩展获取 — 依赖 Phase 3 (网格页已存在)
  ↓
Phase 5 (T034–T037): US3 帧选择 — 依赖 Phase 3
  ↓
Phase 6 (T038–T049): US4 动画导出 — 依赖 Phase 2 (Rust daemon + C# 通信层)
  ↓
Phase 7 (T050–T055): US7 SSE+成果管理 — 依赖 Phase 6 (C# 任务管理已存在)
  ↓
Phase 8 (T056–T060): US6 参数配置 — 依赖 Phase 3 (工具栏已存在)
  ↓
Phase 9 (T061–T064): US8 多页面模态 — 依赖 Phase 3+5+7 (三页均已存在)
  ↓
Phase 10 (T065–T082): US5 全景拼接 — 依赖 Phase 2+7 (Rust daemon + SSE 框架)
  ↓
Phase 11 (T083–T091c): Polish — 依赖所有 story
```

### User Story Dependencies

| Story | 可开始时机 | 依赖故事 |
|-------|----------|---------|
| US1 (P1) | Phase 2 完成后 | 无 |
| US2 (P1) | US1 完成后 | US1 (网格页) |
| US3 (P1) | US1 完成后 | US1 (网格页) |
| US4 (P2) | Phase 2 完成后 | 无（纯后端+C#，可并行 US1-3） |
| US6 (P2) | US1 完成后 | US1 (工具栏) |
| US7 (P2) | US4 完成后 | US4 (C# 任务管理+端点) |
| US5 (P3) | US4+US7 完成后 | US4, US7 (SSE 框架) |
| US8 (P3) | US1+US3+US7 完成后 | US1, US3, US7 (三页面) |

### Parallel Opportunities

```
Phase 1 内部: T003‖T004‖T005‖T006‖T008‖T009 (全部不同文件)
Phase 2 内部: T011b‖T012‖T013‖T014‖T016 (Rust 各模块独立，T011b 缓存结构与 T011 socket 可并行)
              T022 (前端) 可与 Rust 并行
Phase 3+4+5 可与 Phase 6 并行（前端网格 vs 后端动画编码）
Phase 10 内部: T065‖T066‖T067‖T069‖T071‖T072‖T074‖T075‖T078 (Rust 各算法模块独立)
```

---

## Parallel Example: Phase 10 (Rust 全景拼接)

```bash
# 所有场景算法模块可并行开发（不同文件）：
Task: "T065 [P] [US5] 场景分类器 src/frame-forge/src/scene_classifier.rs"
Task: "T066 [P] [US5] 镜头运动预检 src/frame-forge/src/scene_classifier.rs"
Task: "T067 [P] [US5] Phase Correlation 拼接 src/frame-forge/src/stitch_anime.rs"
Task: "T069 [P] [US5] 高纹理 ROI 掩码 src/frame-forge/src/stitch_landscape.rs"
Task: "T071 [P] [US5] 柱面投影 src/frame-forge/src/stitch_landscape.rs"
Task: "T072 [P] [US5] 帧差运动掩码 src/frame-forge/src/stitch_liveaction.rs"
Task: "T074 [P] [US5] 前景填充 src/frame-forge/src/stitch_liveaction.rs"
Task: "T075 [P] [US5] 增益补偿 src/frame-forge/src/blender.rs"
Task: "T078 [P] [US5] pHash 近重复帧 src/frame-forge/src/main.rs"
```

---

## Implementation Strategy

### MVP First (User Stories 1-3: Frame Selector)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL)
3. Complete Phase 3: US1 (Modal + Grid)
4. Complete Phase 4: US2 (Expand)
5. Complete Phase 5: US3 (Selection)
6. **STOP and VALIDATE**: Frame selector works end-to-end
7. Deploy/demo: Users can browse video keyframes in a modal

### Incremental Delivery

1. Setup + Foundational → Base infra ready
2. US1–3 → Frame Selector Grid (MVP! Browse & select frames)
3. US4 + US7 + US6 → Animation Export (Generate GIF/WebP with SSE progress)
4. US8 → Multi-page Modal Navigation (Polish UX)
5. US5 → Panorama Stitching (Advanced feature)
6. Each increment adds value without breaking prior

### Suggested MVP Scope

**Minimum**: US1 (Open frame selector) — user can see 11 keyframe thumbnails in a modal.
**Recommended MVP**: US1 + US2 + US3 — user can browse, expand, select frames. At this point users get value (visual preview of video frames) even without export.
**Full MVP**: + US4 + US7 + US6 — user can select frames and export as animated GIF/WebP.
