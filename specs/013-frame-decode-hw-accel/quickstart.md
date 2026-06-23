# Quickstart: 帧解码硬件加速 验证指南

## 前置条件

- `jellyfin-dev` 容器正在运行（见 memory `project_jellyfin_dev_container.md`：root/123456，用 LAN IP 访问，不是 localhost）
- 本机开发机硬件：NVIDIA RTX 5060（验证 NVDEC/CUDA 路径）+ AMD Raphael 核显（验证 AMD VAAPI 路径）；Intel Arc A380 仅存在于生产 NAS，本机无法验证（见 spec Assumptions）
- 已执行 `mise run check-frame-forge-opencv-linux` 确认 Rust 侧改动 `cargo check` 全绿
- 已执行 `mise run test` 确认全套 Rust + C# + TypeScript 测试通过
- 部署前已征得用户同意（CLAUDE.md 部署工作流程强制要求）

## 场景 1：硬解默认开启，整体提速可观测（US1 / SC-001）

1. `mise run update-linux` 部署到 `jellyfin-dev`
2. 在播放器增强 modal 打开一个尚未缓存过帧的视频，进入工坊缩略图浏览
3. 记录从打开到首批缩略图全部加载完成的总耗时（可用浏览器 Network 面板或现有的"是否能肉眼看到多个同时加载"判断法，参考此前并发解码 bug 排查时用过的方法）
4. 在 `AdvancedPanel.tsx` 新增的开关里关闭"硬件解码"，清掉该视频的帧缓存（避免读缓存掩盖耗时差异），重复步骤2-3
5. **预期**：开启状态总耗时比关闭状态至少快 30%（SC-001）；两种状态下生成的缩略图人工肉眼对比无可感知差异（SC-003）

## 场景 2：手动关闭硬解，设置持久化（US2 / SC-002 / SC-004）

1. 在播放器增强 modal 取消勾选"硬件解码"
2. 关闭并重新打开 modal → **预期**：开关仍显示关闭状态（FR-007）
3. `docker restart jellyfin-dev`，等待健康检查通过 → 再次打开 modal → **预期**：开关仍显示关闭状态（FR-007，重启存活）
4. 关闭状态下做一次新的帧提取操作 → 检查对应任务的 `generation-log.json`（`GET /FrameExport/Result/{taskId}/generation-log.json`）→ **预期**：`fallbacks` 字段为空或不含任何 `hwdecode_*` 事件（FR-008，完全没尝试硬解路径）
5. **任务进行中切换开关**（spec Edge Cases 约定项）：开启硬件解码，对一个尚未缓存、帧数较多的视频发起全景图拼接（耗时操作）；任务进行中（未完成前）在 modal 里关闭硬件解码开关；**预期**：当前这个任务从头到尾仍按"开启"时的行为跑完（不被动态打断切换到软解半路），任务的 `generation-log.json` 里硬解相关行为应与"开启"状态一致；任务结束后发起的下一次操作才按新设置（关闭）执行

## 场景 3：无受支持设备时开关禁用（US2 场景3 / SC-005）

本机有 NVIDIA/AMD 设备，无法直接造出"完全没有硬解设备"的环境。验证方式：

1. 调用 `GET /FrameExport/HwDecodeSettings`，检查响应体的 `supported`/`multiDeviceAvailable` 字段语义是否符合 contracts/rest-api.md 定义
2. 单元测试层面（`packages/JellyfinSuite.Plugin.Tests` 或 frame-forge 的 Rust 测试）mock `MSG_HW_DECODE_CAPS` 返回 `supported: false`，断言前端/Controller 对应渲染禁用态 + 提示文案

## 场景 4：硬解失败优雅降级（US3 / SC-002）

1. 故意让 VAAPI 初始化失败的方式：临时移除容器内 `/dev/dri` 访问权限，或针对一个不受支持的编码格式视频发起帧提取
2. **预期**：帧提取操作仍正常完成，输出与纯软解一致；该任务的 `generation-log.json` 的 `fallbacks` 字段含一条 `hwdecode_init_failed` 事件（FR-003/FR-011）；用户侧（前端 UI）不可见任何错误提示（FR-003 验收场景1）

## 场景 5：多设备策略选择（US1 场景3/4/5）

本机同时有 NVIDIA 独显 + AMD Raphael 核显，满足"多设备"条件：

1. `GET /FrameExport/HwDecodeSettings` → **预期** `multiDeviceAvailable: true`，`AdvancedPanel.tsx` 展示策略选择器
2. 策略设为"性能优先"，发起一次帧提取 → 检查 `DeviceSelectionResult`（若落地为日志/调试输出）→ **预期**选用 NVIDIA 独显
3. 策略设为"优先使用闲置资源"，本机独显空闲（未跑游戏/转码）→ **预期**仍选用独显（data-model.md `DeviceSelectionResult`，独显空闲时不强制切核显）
4. 人工跑一个占满独显的负载（如本机跑一个 3D 应用或 `nvidia-smi` 观察到独显利用率明显升高的场景），重复步骤3 → **预期**自动切到 AMD 核显解码

## 场景 6：诊断日志可远程核实（FR-011，A380 生产验证前置条件）

本机验证日志格式是否符合预期，为后续 A380 生产部署后远程核实做准备：

1. 任意一次正常硬解成功的帧提取 → 检查日志/`generation-log.json` 是否记录了"硬解初始化成功，使用了哪个 vendor"的信息
2. 任意一次场景4的失败回退 → 确认 `hwdecode_init_failed`/`hwdecode_runtime_fallback` 事件的 `reason` 字段包含足够定位问题的信息（不是空字符串或泛泛的"failed"）

## 已知限制：AV1 + AMD VAAPI 在本机核显上比软解更慢

**测试方式**：`crates/jfs-common/src/decoder.rs` 的 `hw_vs_sw_decode_only_speed`（`hw_integration_tests` 模块），纯解码对比（不含 WebP 编码），通过环境变量传入真实视频文件路径：

```sh
FRAME_FORGE_TEST_HW_VIDEO=<path> FRAME_FORGE_TEST_HW_VENDOR=cuda|vaapi \
FRAME_FORGE_TEST_HW_DEVICE=<path，仅 vaapi 需要> FRAME_FORGE_TEST_HW_FRAMES=900 \
cargo test -p jfs-common --release hw_vs_sw_decode_only_speed -- --ignored --nocapture
```

**实测结果**（`demo/Turn A Gundam/Turn A Gundam_S01E31 [AV1-10bit Opus].mkv`，1440x1080 AV1 10bit，900 帧）：

| 设备 | 软解 | 硬解 | 结果 |
|---|---|---|---|
| NVIDIA RTX 5060（CUDA） | 1.71ms/帧 | 1.21ms/帧 | 硬解快 ~29% |
| AMD Raphael 核显（VAAPI） | 1.70ms/帧 | 3.34ms/帧 | **硬解反而慢 ~2 倍** |

两组结果均用 `/sys/class/drm/cardN/device/gpu_busy_percent`（AMD）/`nvidia-smi dmon`（NVIDIA）核实过 GPU 确实在跑（AMD 侧观测到峰值 95% 占用），不是静默回退到软解。AMD VAAPI 解码 H.264 单独验证过没有问题（`ffmpeg -hwaccel vaapi` CLI 直测，0 解码错误），说明不是 frame-forge 代码或 VAAPI 路径本身的 bug，而是这颗核显的 VCN 多媒体引擎处理 AV1 10-bit 这类内容本身就比现代 CPU 上的 `dav1d` 软解慢——硬件能力局限，记录为已知限制，不视为需要修复的缺陷。

**设计决定："优先使用闲置资源"策略不把 CPU 软解纳入候选**。该策略的语义停留在"硬解已开启时，多个硬解设备里选负载更低的那个"，不会动态判断"软解是否比硬解更快"——按 codec/分辨率/设备型号实时判断哪种解码方式更快需要维护一张实测基准表，复杂度远超本 spec 范围，且容易在新硬件上失准。用户若发现自己的硬件对某类内容硬解更慢，可直接关闭"硬件解码"父开关切回纯软解；这是该开关存在的目的之一。

## 完成判定

以上 6 个场景全部按预期通过、`mise run test` 全绿、`mise run update-linux` 成功部署且容器健康检查通过，即视为本功能本机可验证范围内完成。Intel Arc A380 路径按 spec Assumptions 约定，依赖部署后用户在生产 NAS 上参照场景4/6 的方法远程核实。
