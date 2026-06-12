# Tasks: Frame Export & Stitch

**Input**: Design documents from `specs/009-frame-forge-stitch/`
**Prerequisites**: plan.md ?, spec.md ?, research.md ?, data-model.md ?, contracts/api.md ?, quickstart.md ?

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup — crate 框架初始化 + 脚手架 + @alivecss/aliveui 安装

**Purpose**: 初始化 frame-forge Rust crate、C# 控制器脚手架、@alivecss/aliveui npm 包安装、Makefile/CI 配置。

- [x] T001 创建 `src/frame-forge/Cargo.toml`，package `frame-forge` edition 2021，依赖：tokio(full)、ffmpeg-next(codec+format+software-scaling)、image、imageproc、lru、anyhow、gif、webp、serde、serde_json、opencv、rustfft
- [x] T002 创建 `src/frame-forge/src/main.rs` 占位脚手架，包含 `tokio::main`，`cargo check` 通过即可
- [x] T003 [P] 创建 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 占位脚手架：命名空间 + IDisposable + Unix socket 路径常量 + StartAsync/StopAsync stub
- [x] T004 [P] 创建 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 占位脚手架：ApiController + Route("JellyfinSuite/FrameExport") + AllowAnonymous + 构造函数 DI
- [x] T005 [P] 创建 `src/JellyfinSuite.Plugin/Models/FrameExportDto.cs`，定义 GenerateRequest、GenerateResponse、TaskProgress、FrameQualityMeta 等 DTO 类
- [x] T006 [P] 安装 @alivecss/aliveui，`cd src/player-enhancer && npm install @alivecss/aliveui`，确认 `package.json` 依赖项已记录
- [x] T007 更新 `Makefile`，添加 build-frame-forge target：Docker ubuntu:24.04 + libopencv-dev + ffmpeg dev libs + cargo build --release 后 cp 到 Plugin 目录；build 依赖添加 build-frame-forge，update 追加 docker cp，test-rust 追加 cd src/frame-forge && cargo test
- [x] T008 [P] 更新 `.github/workflows/build.yml`：Cache Rust build workspaces 至 src/frame-forge，添加 apt install libopencv-dev libavcodec-dev... 步骤、test-rust 由 Makefile 自动调用
- [x] T009 [P] 更新 `.github/workflows/release.yml`：Cache Rust build workspaces 至 src/frame-forge，添加 apt install libopencv-dev 步骤、Build frame-forge (Linux x64) 步骤（cargo build --release）、Copy binaries 输出为 frame-forge-linux-x64、zip 压缩为 frame-forge-linux-x64
- [x] T010 在 `src/JellyfinSuite.Plugin/PluginServiceRegistrator.cs` 注册 FrameExportService 为单例

**Checkpoint**: `make build-frame-forge` 构建成功可执行，CI build.yml 过，release.yml zip 含 frame-forge-linux-x64

---

## Phase 2: Foundational — Rust daemon 实现 + C# 通信层 + 前端注册

**Purpose**: 实现 Rust daemon 的 Unix socket 监听协议、帧缓存、解码器、质量检测+资源监控流水线，C# 进程管理与 socket 连接，前端 injector 注册帧导出按钮到 OSD。

**?? CRITICAL**: 覆盖全部 User Story 所需的 Phase 完成。

### Rust — Socket + 协议 + 帧缓存

- [x] T011 在 `src/frame-forge/src/main.rs` 实现 Unix socket 监听器：`tokio::net::UnixListener`，socket 路径可配置，并发连接无限制；启动时检测 `opencv::core::ocl::haveOpenCL()` 判断 GPU 可用性并记录 flag，在后续 Warp/Blending 阶段用到
- [x] T011b [P] 在 `src/frame-forge/src/main.rs` 实现 `FrameCache` 结构体：`LruCache<(PathBuf, i64), Arc<DynamicImage>>`，上限 100 项，key=(canonical_path, pos_ms/500*500)，暴露 `fn get_or_insert(path, pos_ms) -> Arc<DynamicImage>`，在帧解码后供 handle_animate/handle_stitch 复用使用
- [x] T012 [P] 在 `src/frame-forge/src/protocol.rs` 实现读写协议帧的函数：`read_msg_type`、`read_single_frame_req`、`read_animate_req`、`read_stitch_req`、`write_jpeg_response`、`write_progress_event`，参考 seek-preview `protocol.rs` 模式
- [x] T013 [P] 在 `src/frame-forge/src/decoder.rs` 将 seek-preview 的 `decoder.rs` 复制/改造为解码逻辑：ffmpeg-next 打开文件 + 定位关键帧 + 解码为 RGB + width=0 返回原图 / width>0 用 Lanczos3 缩放 + JPEG 编码
- [x] T014 [P] 在 `src/frame-forge/src/quality.rs` 实现帧质量检测：检测直方图均值/方差（纯黑/纯白帧），3x3 Laplacian 方差模糊，帧间相似度/重复帧检测（转灰度），输出 `QualityFlags` bitmask + 可读标签
- [x] T015 在 `src/frame-forge/src/main.rs` 实现 `handle_single_frame` 函数：读取请求（原图/缩略图）后 调用解码器 后 写入 JPEG + quality_flags
- [x] T016 [P] 在 `src/frame-forge/src/resources.rs` 实现 CPU/内存负载：读取 `/proc/stat` + `/proc/meminfo` 计算 CPU 使用率和可用内存百分比，暴露 `fn resource_pressure() -> f64` (0=空闲, 1=满载)

### C# — 进程管理 + Socket 连接

- [x] T017 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现进程管理：StartAsync 启动 frame-forge-linux-x64 子进程（Process.Start + Unix socket 路径传参），StopAsync 发信关闭，进程退出时 3s 后自动重启
- [x] T018 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现 Unix socket 连接：`Socket(AddressFamily.Unix)` + `SemaphoreSlim(1,1)` 保护读写 + `ReceiveBytesAsync` 确保完整读取响应
- [x] T019 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现 `GetFrameAsync(string filePath, long posMs, int width, Guid itemId, CancellationToken ct)` 以 发送 0x10 SINGLE_FRAME 请求 后 返回 `(byte[] jpeg, QualityFlags flags)`

### 前端 — OSD 按钮注册

- [x] T020 在 `src/player-enhancer/src/icons.ts` 添加帧导出按钮 SVG 图标 `ICON_FRAME_EXPORT`（内容为胶片剪辑类图标）
- [x] T021 修改 `src/player-enhancer/src/injector.ts`，在 `injectPlayerButtons` 添加帧导出按钮（位于截图按钮后方），绑定 click 到 打开帧导出 Modal，预留 `openFrameExportModal()` stub，供后续 US1 实现
- [x] T022 修改 `src/player-enhancer/src/styles.ts`，全量迁移到 @alivecss/aliveui CSS 框架，删除原有自定义 CSS，改为 `import '@alivecss/aliveui/css'` + 保留 @alivecss/aliveui 无法覆盖的 CSS 注入函数 `injectStyles()`

**Checkpoint**: `GET /JellyfinSuite/FrameExport/{itemId}?positionMs=5000&width=320` 返回 JPEG 缩略图，OSD 播放器下方按钮显示，`styles.ts` 使用 @alivecss/aliveui

---

## Phase 3: User Story 1 — 帧选择器 Modal (Priority: P1) ?? MVP

**Goal**: 用户点击"帧导出"按钮后弹出 Modal，以网格形式展示当前播放位置前后 11 帧缩略图。

**Independent Test**: 在播放视频时点击"帧导出"按钮，Modal 弹出并显示缩略图列表，点击关闭可关闭。

### Implementation

- [x] T023 [P] [US1] 在 `src/player-enhancer/src/frame-forge.ts` 创建 Modal 容器结构：body-level 固定定位 + 遮罩 + @alivecss/aliveui modal 样式 + 打开/关闭函数 `openFrameExportModal()` / `closeFrameExportModal()` + 关闭时暂停视频并切换为暂停状态
- [x] T024 [P] [US1] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现单帧缩略图端点：`GET /FrameExport/{itemId}?positionMs=N&width=320` 后 调用 `_service.GetFrameAsync()` 后 `File(jpeg, "image/jpeg")` + `Response.Headers["X-Frame-Quality"]` 含质量元数据 JSON
- [x] T025 [US1] 在 `src/player-enhancer/src/frame-forge.ts` 实现初始帧加载：计算当前播放位置前后 5 帧时间间隔列表 后 Promise.all fetch 缩略图 后 渲染网格
- [x] T026 [P] [US1] 在 `src/player-enhancer/src/frame-forge.ts` 实现网格渲染：使用 @alivecss/aliveui grid 类（`grid grid-cols-4 gap-2` 等）+ 每格包含 `<img>` + 时间戳标签显示
- [x] T027 [US1] 在 `src/player-enhancer/src/injector.ts` 将帧导出按钮 click handler 绑定到 `openFrameExportModal()`，传入 videoEl、getItemId()、getServerAddress()、getRawToken()
- [x] T028 [US1] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现边界处理：itemId 不存在/无权限/文件不存在 返回 404，daemon 不可用 返回 503
- [x] T029 [US1] 修改 `src/player-enhancer/src/i18n.ts`，补充 US1 相关 i18n key（zh/ja/en）：`frameExport.title`、`frameExport.close`、`frameExport.loading`

**Checkpoint**: 帧选择器 Modal 可打开、显示 11 帧缩略图、可关闭，端点 404/503 正确响应

---

## Phase 4: User Story 2 — 扩展获取更多关键帧 (Priority: P1)

**Goal**: 帧选择器内"向前"/"向后"按钮，追加更多帧缩略图。

**Independent Test**: 在帧选择器内点击"向前扩展"按钮，能追加 10 帧缩略图；点击"向后扩展"同理；到达边界时按钮禁用。

### Implementation

- [x] T030 [P] [US2] 在 `src/player-enhancer/src/frame-forge.ts` 实现"向前"/"向后"方向扩展按钮（@alivecss/aliveui btn 样式 + 箭头图标），加载时显示 spinner + disabled
- [x] T031 [US2] 在 `src/player-enhancer/src/frame-forge.ts` 实现扩展逻辑：维护当前显示帧范围 `[minPosMs, maxPosMs]` 后 每次扩展时计算新范围、偏移 N 步/M 帧，批量 fetch 新帧 后 append 到网格头部/尾部 + 更新范围边界位置
- [x] T032 [US2] 实现扩展防抖：debounce 300ms，快速连续点击时只触发最后一次请求，防止 DDOS 风险
- [x] T033 [US2] 实现边界检测：videoTime=0 时禁用"向前"按钮，videoTime≥duration 时禁用"向后"按钮，按钮禁用样式 + 显示提示文字（如"已到达视频头"）

**Checkpoint**: 扩展向前向后均可，边界处理正确

---

## Phase 5: User Story 3 — 帧选择与预览 (Priority: P1)

**Goal**: 每帧缩略图有 checkbox（默认勾选），垃圾帧自动取消勾选，底部显示已选帧数量。

**Independent Test**: 取消勾选某帧、勾选底部计数更新，全选恢复，点击缩略图放大预览。

### Implementation

- [x] T034 [P] [US3] 在 `src/player-enhancer/src/frame-forge.ts` 为每帧添加 checkbox（默认 checked），绑定 onChange 更新选中状态 + 底部实时更新计数 `"已选 X/共计 Y 帧"`
- [x] T035 [P] [US3] 实现帧图片放大预览：点击缩略图（而非 checkbox 区域）后 在原位 lightbox 展示大图（调用 GET 端点 width=0 获取原图）+ 显示时间戳
- [x] T036 [US3] 读取 `X-Frame-Quality` 响应头，`isJunk=true` 的帧自动取消勾选 后 UI 添加红色边框 + 标签文字（如 "黑帧"/"模糊帧"）且 透明度降低
- [x] T037 [US3] 实现全选/全取消按钮（底部工具栏）："全选"/"取消全选"两个按钮

**Checkpoint**: 帧选择器 MVP 完成，支持勾选、预览帧

---

## Phase 6: User Story 4 — 动图导出 GIF/WebP (Priority: P2)

**Goal**: 用户配置参数并点击"导出"，生成 GIF/WebP 动图文件，通过 SSE 获取进度，成功展示在 Modal。

**Independent Test**: 选 3 帧，默认参数配置导出 后 SSE 进度更新 后 Modal 展示动图预览 后 下载文件。

### Rust — 动图编码

- [x] T038 [P] [US4] 在 `src/frame-forge/src/animate.rs` 实现 GIF 编码函数 `encode_gif(frames: Vec<DynamicImage>, fps: u16, loop_count: u16) -> Vec<u8>`，使用 `gif` crate 编码，颜色量化为 256 色
- [x] T039 [P] [US4] 在 `src/frame-forge/src/animate.rs` 实现 WebP 动图编码函数 `encode_webp_anim(frames: Vec<DynamicImage>, fps: u16, loop_count: u16) -> Vec<u8>`，使用 `webp` crate 无损编码
- [x] T040 [US4] 在 `src/frame-forge/src/animate.rs` 实现缩放预处理逻辑：根据 `resizeMode`("width"/"height") + `customWidth/customHeight` 或 `resolutionPreset` 用 `image::imageops::resize`(Lanczos3) 等比缩放每帧
- [x] T041 [US4] 在 `src/frame-forge/src/main.rs` 实现 `handle_animate` 函数：读取帧列表原图(width=0) 后 缩放预处理（记录日志）后 按序 push 帧到数组 后 调用 encode_xxx 后 每帧处理后发送 progress event 后 最终发回结果字节

### C# — 任务管理 + 生成端点

- [x] T042 [P] [US4] 在 `src/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs` 实现任务字典：`ConcurrentDictionary<taskId, TaskState>` + 任务状态枚举 (pending、running、complete/error/cancelled) + 每任务独立 `Channel<TaskProgress>` 供 SSE 消费
- [x] T043 [US4] 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现 `SubmitAnimateTask(GenerateRequest req) -> taskId`：生成 UUID 后 创建 TaskState 后 写入 `{tempDir}/{taskId}/` 后 逐帧 frames 用 Rust GetFrameAsync 获取原始帧数据 后 调用 Rust handle_animate 后 写 output 文件 后 设 status=complete
- [x] T044 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `POST /FrameExport/Generate` 端点：验证 params（fps 1-30，帧数 ≥ 2）后 `_service.SubmitAnimateTask()` 后 202 { taskId }
- [x] T045 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `GET /FrameExport/Result/{taskId}/{filename}` 端点：文件存在且 status=complete 后 File(bytes, content-type) + Content-Disposition 下载头
- [x] T046 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `DELETE /FrameExport/Result/{taskId}` 端点：`Directory.Delete(tempDir, recursive)` + 移除字典记录 后 200
- [x] T047 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `POST /FrameExport/Cancel/{taskId}` 端点：发 Process.Kill() + WaitForExit(3000) + `rm -rf tempDir` + status=cancelled 后 200
- [x] T048 [P] [US4] 在 `src/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs` 实现 5 分钟定时清理：`Timer` 后 遍历字典 后 createdAt+5min 过期 后 `Directory.Delete(tempDir, recursive)` + 移除记录
- [x] T049 [P] [US4] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 `GET /FrameExport/Health` 端点：返回 daemon 运行状态 + 心跳时间戳 + CPU/内存使用率

**Checkpoint**: cURL 测试 Generate → Progress(SSE) → Result download 全流程通过

---

## Phase 7: User Story 7 — SSE 进度与成功页面 (Priority: P2)

**Goal**: 前端通过 SSE 接收进度事件，展示进度条和阶段文字，完成后自动展示成功预览；成功页提供下载/删除/重做操作。

**Independent Test**: 提交导出后 查看进度动画和阶段文字 后 完成后自动展示成功预览 后 下载和关闭按钮响应正确文件。

### 前端 — SSE + 进度页 + 成功页

- [x] T050 [P] [US7] 在 `src/player-enhancer/src/frame-progress.ts` 实现 SSE 连接器：`new EventSource(url)` 后 `onmessage` 解析 JSON 后 更新进度状态，`onerror` 自动重连（最多3次，间隔1s）
- [x] T051 [US7] 在 `src/player-enhancer/src/frame-progress.ts` 实现进度 UI：进度条组件（@alivecss/aliveui progress）+ 百分比数字 + 当前阶段文字描述（phase 与 i18n 映射："decoding"→"解码帧"，"encoding"→"编码动图"，"matching"→"特征匹配中"等）
- [x] T052 [P] [US7] 在 `src/player-enhancer/src/frame-result.ts` 实现成功预览页：包含 `<img>` 元素加载 resultUrl 循环动图，全宽图 `<img>` 铺满容器 + 滚动/缩放，显示 fileSize（格式化为 KB/MB）
- [x] T053 [P] [US7] 在 `src/player-enhancer/src/frame-result.ts` 实现"下载"按钮（`window.open(resultUrl)` 浏览器直接下载），"删除"按钮（`DELETE /FrameExport/Result/{taskId}` 后 成功跳转 后 返回帧选择页），"重做"按钮（先 delete + 返回帧选择页）
- [x] T054 [US7] 在 `src/player-enhancer/src/frame-forge.ts` 实现页面切换逻辑：帧选择页 后 提交 Generate 后 切换到进度页(T050+T051) 后 status=complete 后 切换到成功页(T052+T053)
- [x] T055 [US7] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 实现 SSE 端点：`GET /FrameExport/Progress?taskId={uuid}` 后 `Response.ContentType = "text/event-stream"` 后 `ChannelReader.ReadAllAsync` 后 `"data: {json}

"` 后 channel 关闭时断开连接

**Checkpoint**: 端点级 SSE 测通，提交导出后 实时进度 后 成功预览 后 下载/删除/重做

---

## Phase 8: User Story 6 — 参数面板与持久化 (Priority: P2)

**Goal**: 格式/模式/分辨率及宽高/长边+预设跳位/帧率和质量、循环次数等参数输入。所有参数自动 localStorage 持久化。

**Independent Test**: 修改帧率 15fps，分辨率 720p 后 关闭 Modal 后 再次打开 后 参数恢复。

### Implementation

- [x] T056 [P] [US6] 在 `src/player-enhancer/src/frame-params.ts` 实现 `LocalExportSettings` 结构 + `loadSettings(): LocalExportSettings` / `saveSettings(s: LocalExportSettings)` 函数（localStorage key: `jfs-frameexport-settings`，默认值：GIF/PNG、width、original、5fps、infinite loop）
- [x] T057 [US6] 在 `src/player-enhancer/src/frame-forge.ts` 底部面板实现格式/模式选择器（@alivecss/aliveui dropdown）：动图模式选 GIF/WebP 全帧，全景图模式选 PNG/WebP-lossless；默认值从 localStorage 读取
- [x] T058 [P] [US6] 在 `src/player-enhancer/src/frame-params.ts` 实现参数面板结构（折叠式 @alivecss/aliveui details/summary）：分辨率及比例模式切换（"按宽度"/"按高度" radio）+ 自定义分辨率输入（一格可编辑另一格自动联动）+ 预设跳位（下拉选后自动切换"按宽度"）+ 帧率范围(1-30) + 循环次数范围(0-99)
- [x] T059 [US6] 实现参数联动逻辑：`resizeMode` 切换 后 只有对应维度可编辑（保持宽高比）+ 另一格 disabled，预设跳位选择 后 自动设 resizeMode="width" + 填入预设值，其他模式（纯动图/循环次数等）约束参数
- [x] T060 [US6] 实现参数变更 后 自动 `saveSettings()` + `Generate` 请求 body 取当前 params

**Checkpoint**: 所有参数可调、自动持久化，宽高联动、分辨率均正确

---

## Phase 9: User Story 8 — 多页 Modal 导航 (Priority: P3)

**Goal**: Modal 含页面栈结构：帧选择页 → 进度页 → 成功页，各页面顶栏、操作按钮与页面切换联动。

**Independent Test**: 帧选择页 → 提交导出 → 进度页 → 完成 → 成功页 → 重做 → 帧选择页。

### Implementation

- [x] T061 [P] [US8] 在 `src/player-enhancer/src/frame-forge.ts` 实现页面栈状态机：`currentPage: "grid" | "progress" | "result"` + `navigateTo(page, ...)` 函数 + 页面切换时显示/隐藏对应 DOM 区域
- [x] T062 [P] [US8] 实现多页面顶栏渲染：帧选择页 → 显示"帧导出" + X 关闭按钮，进度页 → 显示"导出中" + 取消按钮，成功页 → 显示"预览" + 返回按钮（可选）+ X 关闭按钮
- [x] T063 [US8] 实现取消按钮逻辑：调用 `POST /FrameExport/Cancel/{taskId}` 后 返回帧选择页
- [x] T064 [US8] 实现 Modal 关闭时资源清理：调用 `DELETE /FrameExport/Result/{taskId}`（若有活跃任务），移除 Modal DOM

**Checkpoint**: 多页导航流畅，取消、下载、关闭按钮均正确释放资源

---

## Phase 10: User Story 5 — 生成全景图 (Priority: P3)

**Goal**: 用户选帧并点击"生成全景图"，Rust 端按场景类型选择算法路径，SSE 传递进度，完成后展示全景预览。

**Independent Test**: 选 3 帧同场景横移帧 后 触发生成全景图 后 SSE 进度 后 Modal 展示全景 后 下载 PNG。

### Rust — 场景分类器

- [x] T065 [P] [US5] 在 `src/frame-forge/src/scene_classifier.rs` 实现场景分类特征提取：各帧 后 提取颜色熵（`imageproc::stats::histogram` 后 entropy），Canny 边缘密度（`imageproc::edges::canny` 后 count_nonzero/total_pixels），帧间平均运动幅度 后 分类为 anime/landscape/liveaction
- [x] T066 [P] [US5] 在 `src/frame-forge/src/scene_classifier.rs` 实现镜头运动分类预判：相邻帧光流估算运动向量（pan/zoom/rotation/static）+ 拼接方向（horizontal/vertical）

### Rust — 路径 A：动漫 Phase Correlation

- [x] T067 [P] [US5] 在 `src/frame-forge/src/stitch_anime.rs` 实现 Phase Correlation 拼接：灰度化 + 窗函数加权 后 2D FFT(rustfft) 后 归一化互功率谱 后 IFFT 后 峰值定位（亚像素插值精化）后 (dx, dy) 平移 后 直接 warp 拼接
- [x] T068 [US5] 在 `src/frame-forge/src/stitch_anime.rs` 实现多帧累积拼接：基准帧（首帧）后 逐帧对与基准 PhaseCorr 后 累积平移偏移 后 拼接 + 更新基准

### Rust — 路径 B：实景 AKAZE + Phase Correlation 混合

- [x] T069 [P] [US5] 在 `src/frame-forge/src/stitch_landscape.rs` 实现前景 ROI 提取：计算梯度分值图（`imageproc::gradients`）后 阈值分割 后 ROI 掩码
- [x] T070 [US5] 在 `src/frame-forge/src/stitch_landscape.rs` 实现 AKAZE + RANSAC Homography（opencv crate）：仅在 ROI 内做 AKAZE 特征 后 BFMatcher(Hamming) 后 findHomography(RANSAC, threshold=3.0) 后 内点数 <4 时回退 Phase Correlation
- [x] T071 [P] [US5] 在 `src/frame-forge/src/stitch_landscape.rs` 实现宽基线（FrameCount>5）累积投影：滑窗累积 Homography

### Rust — 路径 C：实录 帧差运动 + AKAZE

- [x] T072 [P] [US5] 在 `src/frame-forge/src/stitch_liveaction.rs` 实现帧间运动掩码：各相邻帧作差 后 形态学膨胀（3x3 kernel, 2 iterations）后 运动掩码输出
- [x] T073 [US5] 在 `src/frame-forge/src/stitch_liveaction.rs` 实现前景遮挡 AKAZE + RANSAC：全图 AKAZE 特征 后 过滤位于运动掩码内的关键点 后 用剩余静态区域特征做 RANSAC Homography 后 多帧 N 个 Homography 取几何中值（鲁棒聚合）
- [x] T074 [P] [US5] 在 `src/frame-forge/src/stitch_liveaction.rs` 实现背景图层 warp + 前景双线性插值填充

### Rust — 混合 + 融合

- [x] T075 [P] [US5] 在 `src/frame-forge/src/blender.rs` 实现简单线性混合：重叠区域的线性平均，测量优先 后 全量加权以消除接缝颜色差
- [x] T076 [US5] 在 `src/frame-forge/src/blender.rs` 实现 Laplacian 金字塔多频段融合：构建 4 层高斯金字塔 + Laplacian 残差 后 每层加权平均（权重=到帧边界的距离）后 重建合成图像
- [x] T077 [US5] 在 `src/frame-forge/src/main.rs` 实现 `handle_stitch` 函数：读取原图 后 近似重复帧剔除（pHash 相似度检测，保留最不相似帧）后 场景分类 后 route 到 stitch_anime/stitch_landscape/stitch_liveaction 后 混合 + Blender 后 按 format(PNG/WebP-lossless)编码 后 每阶段发送 progress event 后 最终发回结果字节
- [x] T078 [P] [US5] 在 `src/frame-forge/src/main.rs` 实现近似重复帧检测（pHash）：`image::imageops::resize(8x8)` 后 灰度化 后 DCT 后 比较哈希汉明距离 后 similarity>90% 则跳过

### C# — 全景任务提交

- [x] T079 [US5] 在 `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` 实现 `SubmitStitchTask(GenerateRequest req) -> taskId`，同 SubmitAnimateTask 模式，路由 Rust handle_stitch 路径
- [x] T080 [US5] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 将 `POST /FrameExport/Generate` 端点添加 `type: "stitch"` 路由分发

### 前端 — 全景拼接 UI

- [x] T081 [US5] 在 `src/player-enhancer/src/frame-forge.ts` 底部面板添加"生成全景图"按钮，点击"全景模式"切换模式（切换为全景）
- [x] T082 [US5] 在 `src/player-enhancer/src/frame-result.ts` 全景图成功展示：`<img>` 满图容器展示 + `object-fit: contain` + 支持滚动/缩放，优先 @alivecss/aliveui 提供，其次简单 CSS `overflow: auto` 实现

**Checkpoint**: 全景拼接端到端通，动漫用 PhaseCorr，实景用 AKAZE+PhaseCorr 混合，实录用帧差+AKAZE，SSE 传递阶段进度

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: 补全 i18n 条目、错误处理、资源限流、DRM 检测、临时目录清理、测试验证、README 和 workflow 检查。

- [x] T083 [P] 补全 `src/player-enhancer/src/i18n.ts` 所有缺失 UI 文字的多语翻译（zh/ja/en）：frameExport 各页面标题、按钮、状态文字，质量标签("黑帧"/"模糊帧")，各进度阶段描述
- [x] T084 [P] 前端错误处理优化：网络超时显示提示，SSE 断连后的静默重试，错误提示使用 @alivecss/aliveui 组件展示，含 retry 逻辑
- [x] T085 在 `src/frame-forge/src/resources.rs` 添加资源感知优先级到 `handle_animate` / `handle_stitch`：`resource_pressure() > 0.8`（即 CPU>80% 或 可用内存 <512MB）时 限流字典时 Semaphore 等待，优先保证 seek-preview 延迟<50ms
- [x] T086 [P] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 各端点添加 DRM 检查（同 seek-preview 与 screenshot 模式）：item.MediaStreams 中 IsEncrypted 返回 403
- [x] T087 [P] 在 `src/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs` 实现 EntryPoint 泄漏目录清理：服务启动时 `Directory.Delete("temp/frame-forge", recursive)` 后 `Directory.CreateDirectory`
- [x] T088 [P] 运行 `make test`，确认 Rust + TypeScript + C# 全套测试通过
- [ ] T999 `make update` 部署到 jellyfin-dev，手动端到端验证：
  - 播放视频 后 打开帧导出 后 查看/选择帧
  - 配置参数导出动图参数 后 导出 后 SSE 进度 后 预览 后 下载 GIF/WebP 正确
  - 全景拼接：选同场景帧 后 生成全景图 后 SSE 阶段进度 后 预览 后 下载 PNG/WebP-lossless 正确
  - 取消导出 后 子进程被杀 + 临时文件清理
  - 关闭 Modal 后 临时文件清理
  - 无权限路径视频 后 按钮禁用/404
  - CSS 验证：确认 UI 使用 @alivecss/aliveui 类，无自定义 CSS 残留
- [ ] T090 [P] 检查 `README.md` / `README.zh-CN.md` 是否需要更新（新功能：帧导出、全景拼接）
- [x] T091 [P] 锁定 `src/player-enhancer/package.json` 中 `dependencies` @alivecss/aliveui 版本，固定精确版本，无范围通配符
- [x] T091b [P] 在 `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 暴露质量阈值管理端点：`GET /FrameExport/QualityThresholds` 返回当前阈值 JSON，`PUT /FrameExport/QualityThresholds` 接收 `{ blackBrightnessVarMin, whiteBrightnessVarMax, blurLaplacianVarMin }` 后 更新 C# 静态字段（含重置为默认值方法），阈值数据到 Rust 端每次 SINGLE_FRAME 请求时作为 header 传递
- [x] T091c 手动性能验收测试：加载缩略图 11 帧 ≤2s(SC-002)，动图 10f/480p ≤8s(SC-003)，全景 5f/720p ≤15s(SC-004)，黑/纯帧识别率 >95% + 模糊帧识别率 >85%(SC-005)，拼接成功率 >80%(SC-006)，SSE 延迟 <500ms(SC-007)，参数持久化恢复 100%(SC-008)；结果记录并写入 `specs/009-frame-forge-stitch/perf-validation.md`

---

## Phase 12: User Story 9 - 自动化拼接质量评分 (Priority: P4)

**Goal**: 在 Rust 各拼接模块添加 `#[cfg(test)]` 质量评分测试，并提供 Python 批量评估脚本，输出带通过/失败阈值的 JSON 评分卡。

**Independent Test**: `cargo test -p frame-forge stitch_quality` 全部通过，且 `uv run --with opencv-python,scikit-image python tests/stitch-eval/score.py tests/stitch-eval/fixtures/` 输出 JSON 评分卡且所有指标状态为 pass。

### 测试基础设施

- [ ] T092 [P] [US9] 创建 `tests/stitch-eval/thresholds.json`，内容：`{ "ssim_min": 0.80, "seam_grad_max": 25.0, "color_de_max": 10.0, "ransac_inlier_min": 0.40, "rmse_max": 5.0 }`，Rust 测试和 Python 脚本均从此文件读取阈值
- [ ] T093 [P] [US9] 创建 `tests/stitch-eval/gen_synthetic.sh`：用 FFmpeg `crop` 滤镜把单张参考图裁切出 4 个水平偏移子图（每次偏移 N px，默认 N=100），用于场景 A Phase Correlation 路径验证；脚本输出到 `tests/stitch-eval/fixtures/scene_a/`
- [ ] T094 [P] [US9] 在 `src/frame-forge/Cargo.toml` `[dev-dependencies]` 添加：`serde_json = "1"` (读取 thresholds.json)；`image` 已是生产依赖，无需重复添加

### Rust 拼接质量测试模块

- [ ] T095 [P] [US9] 在 `src/frame-forge/src/stitch_anime.rs` 添加 `#[cfg(test)] mod quality_tests`：实现 `ssim(img_a, img_b) -> f32`（基于像素均值/方差/协方差）、`seam_grad_jump(stitched, seam_x) -> f32`（接缝左右各 5px 梯度均值差）、`color_de_mean(img_a, img_b) -> f32`（L*a*b* 欧氏距离均值）；对 gen_synthetic.sh 生成的合成平移序列验证 SSIM ≥ 0.90
- [ ] T096 [P] [US9] 在 `src/frame-forge/src/stitch_landscape.rs` 添加 `#[cfg(test)] mod quality_tests`：复用 T095 的 ssim/seam_grad/color_de 函数；额外实现 `ransac_inlier_rate(matches, inliers) -> f32` 和 `reprojection_rmse(pts_src, pts_dst, h) -> f32`；对 SEAGULL fixtures（若存在）验证 SSIM ≥ 0.80、RANSAC 内点率 ≥ 0.40
- [ ] T097 [P] [US9] 在 `src/frame-forge/src/stitch_liveaction.rs` 添加 `#[cfg(test)] mod quality_tests`：复用上述指标函数；对 Walking Tour fixtures（若存在）验证 SSIM ≥ 0.80、RMSE ≤ 5.0px；测试数据集不存在时用 `#[ignore]` 标记该测试（不阻塞 CI）

### Python 批量评估脚本

- [ ] T098 [US9] 创建 `tests/stitch-eval/score.py`：接收参数 `<fixtures_dir>`，遍历子目录中的 `(input_a.png, input_b.png, reference.png)` 三元组；对每对计算 SSIM、ΔE、RMSE、接缝梯度跳变（可选 RANSAC 内点率）；输出 JSON 到 stdout：`{ "pairs": [{...per-pair metrics...}], "summary": { "ssim_mean": x, ..., "overall": "pass"|"fail" } }`
- [ ] T099 [US9] `score.py` 从 `thresholds.json` 读取阈值（与 Rust 测试共享同一配置文件），任一指标低于阈值时在 stderr 打印 `FAIL: ssim=0.72 < 0.80` 格式，退出码为 1；fixtures 目录不存在时退出码为 2 并打印提示
- [ ] T100 [P] [US9] 创建 `tests/stitch-eval/README.md`（或在 research.md 添加章节）：记录如何用 `gen_synthetic.sh` 生成场景 A fixtures，如何下载 SEAGULL/UDIS-D 数据集图像对，如何运行 `score.py`

**Checkpoint**: `cargo test -p frame-forge` 通过（包含 quality_tests，数据集不存在的用例 `#[ignore]`）；`python tests/stitch-eval/score.py tests/stitch-eval/fixtures/` 在合成 fixtures 上输出 overall=pass

## Phase 13: Arc A310 GPU 透传与 OpenCL 路径验证 (Priority: P4)

**Goal**: 将宿主机 Intel Arc A310 显卡透传进 Docker 容器，安装 `intel-opencl-icd`，并在 frame-forge 测试中验证 GPU 加速路径（Warp/Blending）与 CPU fallback 结果一致。

**Independent Test**: 容器内 `clinfo | grep "Arc A310"` 有输出；`cargo test -p frame-forge gpu_opencl` 通过（含 OpenCL 可用性断言和 GPU/CPU SSIM 对比）。

### 一次性主机配置（手动步骤，非自动化）

- [ ] T101 **[手动]** 在 Windows 宿主机安装 Intel Arc 显卡驱动（≥ 31.0.101.4887，下载自 intel.com/arc-graphics-software）；安装后重启，在 WSL2 终端执行 `ls /dev/dri/`，确认出现 `renderD128`（Arc A310）和 `card0/card1`；若仍无则确认驱动含 WSL2 GPU 支持

### Docker 运行命令更新

- [ ] T102 更新 `CLAUDE.md` 和 `memory/` 中的 Docker 启动命令，添加 GPU 透传参数：
  ```bash
  MSYS_NO_PATHCONV=1 docker run -d --name jellyfin-dev     -p 8600:8096     -v jellyfin-config:/config     -v jellyfin-cache:/cache     -v "d:/Dev/jellyfin-recents/demo:/media/demo"     -e JELLYFIN_WEB_DIR=/jellyfin/jellyfin-web     --device /dev/dri:/dev/dri     --group-add video     --group-add render     jellyfin/jellyfin:latest
  ```
  注意：`--group-add render` 确保容器进程可访问 `/dev/dri/renderD128`（Arc 计算节点）

### 容器内 OpenCL 运行时安装

- [ ] T103 在 `Makefile` 的 `build-frame-forge` Docker build 步骤添加 OpenCL 运行时安装：
  ```makefile
  apt-get install -y intel-opencl-icd clinfo ocl-icd-libopencl1
  ```
  并在 build 步骤末尾执行 `clinfo --list` 验证平台可见（若无 GPU 则输出"no platforms"但不报错，保持 CPU fallback 可用）

- [ ] T104 [P] 在 `.mise.toml` 添加 `check-gpu` task：
  ```toml
  [tasks.check-gpu]
  run = "docker exec jellyfin-dev clinfo 2>&1 | grep -E 'Platform|Device|Arc'"
  description = "Verify Arc A310 OpenCL is visible inside jellyfin-dev container"
  ```

### Rust GPU 路径测试

- [ ] T105 [P] [US9] 在 `src/frame-forge/src/main.rs` daemon 启动日志中添加 OpenCL 可用性检测并输出：
  ```rust
  let has_ocl = opencv::core::ocl::have_open_cl().unwrap_or(false);
  let platforms = opencv::core::ocl::Platform::list().unwrap_or_default();
  tracing::info!("OpenCL available={has_ocl}, platforms={}", platforms.len());
  ```
  这样生产日志中可直接确认 GPU 是否被激活

- [ ] T106 [P] [US9] 在 `src/frame-forge/src/stitch_landscape.rs` `#[cfg(test)] mod quality_tests` 添加 GPU 路径对比测试：
  - 当环境变量 `FRAME_FORGE_TEST_GPU=1` 存在时执行（否则 `#[ignore]`）
  - 用相同输入分别跑 CPU path（`setUseOpenCL(false)`）和 GPU path（`setUseOpenCL(true)`）
  - 断言两者 SSIM ≥ 0.80 且两路结果互相 SSIM ≥ 0.95（GPU 不应产生明显质量差异）
  - 断言 GPU path 耗时 ≤ CPU path × 2.0（允许首次 JIT 编译开销，不要求严格加速）

- [ ] T107 [P] [US9] 在 `src/frame-forge/src/main.rs` `#[cfg(test)]` 添加 `test_opencl_detected`：
  ```rust
  #[test]
  #[cfg_attr(not(env = "FRAME_FORGE_TEST_GPU"), ignore)]
  fn test_opencl_detected() {
      assert!(opencv::core::ocl::have_open_cl().unwrap_or(false),
              "Arc A310 OpenCL not detected — check /dev/dri passthrough and intel-opencl-icd");
  }
  ```

**Checkpoint**: `FRAME_FORGE_TEST_GPU=1 cargo test -p frame-forge gpu opencl` 在配置了 GPU 的容器中全部通过；无 GPU 环境下所有 `#[ignore]` 测试被跳过，CI 不报错

---

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (T001–T010): Setup — 框架初始化
  ↓
Phase 2 (T011–T022): Foundational — 依赖 Phase 1 完成
  ↓
Phase 3 (T023–T029): US1 帧选择器 — 依赖 Phase 2
  ↓
Phase 4 (T030–T033): US2 扩展获取 — 依赖 Phase 3 (帧选择页已存在)
  ↓
Phase 5 (T034–T037): US3 帧选择 — 依赖 Phase 3
  ↓
Phase 6 (T038–T049): US4 动图导出 — 依赖 Phase 2 (Rust daemon + C# 通信层)
  ↓
Phase 7 (T050–T055): US7 SSE+成功页面 — 依赖 Phase 6 (C# 任务管理已存在)
  ↓
Phase 8 (T056–T060): US6 参数面板 — 依赖 Phase 3 (帧选择页已存在)
  ↓
Phase 9 (T061–T064): US8 多页模态 — 依赖 Phase 3+5+7 (多页面已存在)
  ↓
Phase 10 (T065–T082): US5 全景拼接 — 依赖 Phase 2+7 (Rust daemon + SSE 完成)
  ↓
Phase 11 (T083–T091c): Polish — 覆盖所有 story
  ↓
Phase 12 (T092–T100): US9 自动化评分 — 需要 Phase 10 (US5 拼接模块已实现)
```

### User Story Dependencies

| Story | 可开始时间 | 前置依赖 |
|-------|----------|---------|
| US1 (P1) | Phase 2 完成后 | 无 |
| US2 (P1) | US1 完成后 | US1 (帧选择页) |
| US3 (P1) | US1 完成后 | US1 (帧选择页) |
| US4 (P2) | Phase 2 完成后 | 无（守护进程+C#无需 US1-3）|
| US6 (P2) | US1 完成后 | US1 (参数面板) |
| US7 (P2) | US4 完成后 | US4 (C# 任务管理+端点) |
| US5 (P3) | US4+US7 完成后 | US4, US7 (SSE 完成) |
| US8 (P3) | US1+US3+US7 完成后 | US1, US3, US7 (多页面) |
| US9 (P4) | Phase 10 (US5) 同时可开始 | US5 (拼接模块已实现可供测试) |

### Parallel Opportunities

```
Phase 1 内部: T003、T004、T005、T006、T008、T009 (全部不同文件)
Phase 2 内部: T011b、T012、T013、T014、T016 (Rust 各模块并行，T011b 依赖结构体由 T011 socket 可并行)
              T022 (前端) 并行 Rust 开发
Phase 3+4+5 并行 Phase 6 进行（前端网格 vs 后端动图编码）
Phase 10 内部: T065、T066、T067、T069、T071、T072、T074、T075、T078 (Rust 各算法模块并行)
```

---

## Parallel Example: Phase 10 (Rust 全景拼接)

```bash
# 各路算法模块可并行（不同文件，互不依赖）
Task: "T065 [P] [US5] 场景分类器 src/frame-forge/src/scene_classifier.rs"
Task: "T066 [P] [US5] 镜头运动预判 src/frame-forge/src/scene_classifier.rs"
Task: "T067 [P] [US5] Phase Correlation 拼接 src/frame-forge/src/stitch_anime.rs"
Task: "T069 [P] [US5] 前景 ROI 提取 src/frame-forge/src/stitch_landscape.rs"
Task: "T071 [P] [US5] 累积投影 src/frame-forge/src/stitch_landscape.rs"
Task: "T072 [P] [US5] 帧差运动掩码 src/frame-forge/src/stitch_liveaction.rs"
Task: "T074 [P] [US5] 前景填充 src/frame-forge/src/stitch_liveaction.rs"
Task: "T075 [P] [US5] 线性混合 src/frame-forge/src/blender.rs"
Task: "T078 [P] [US5] pHash 近似重帧 src/frame-forge/src/main.rs"
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

1. Setup + Foundational — 基础设施就绪
2. US1–3 — Frame Selector Grid (MVP! Browse & select frames)
3. US4 + US7 + US6 — Animation Export (Generate GIF/WebP with SSE progress)
4. US8 — Multi-page Modal Navigation (Polish UX)
5. US5 — Panorama Stitching (Advanced feature)
6. Each increment adds value without breaking prior

### Suggested MVP Scope

**Minimum**: US1 (Open frame selector) — user can see 11 keyframe thumbnails in a modal.
**Recommended MVP**: US1 + US2 + US3 — user can browse, expand, select frames. At this point users get value (visual preview of video frames) even without export.
**Full MVP**: + US4 + US7 + US6 — user can select frames and export as animated GIF/WebP.
7. US9 自动化拼接质量评分 → Rust `#[cfg(test)]` + Python 评分脚本，可在 US5 后任何时间独立指行
