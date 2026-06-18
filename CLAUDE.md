<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at specs/012-ort-gpu-model-ui/plan.md
<!-- SPECKIT END -->

## 部署工作流程（必须遵守）

**先测试，再部署，部署前必须征得用户同意。**

```
1. mise run test            ← 运行全套测试（Rust + TypeScript + C#）
2. mise run update          ← 完整部署（含 Rust 构建，会重启容器）
   mise run update-quick    ← 快速部署（跳过 Rust，仅前端 + C#，会重启容器）
   mise run deploy-enhancer ← 极速部署（仅 player-enhancer JS，无需重启）
```

**根据改动范围选择部署命令：**
- 改动含 Rust 代码（`crates/`）→ `mise run update`
- 改动仅限前端（`apps/frontend/`、`packages/`）或 C#（`packages/JellyfinSuite.Plugin/`）→ `mise run update-quick`
- 改动仅限 player-enhancer（`apps/player-enhancer/`）→ `mise run deploy-enhancer`

- 运行测试时**必须**用 `mise run test`，不得直接调用 cargo/vitest/dotnet 替代
- 所有 make 目标均可通过 `mise run <task>` 调用；`.mise.toml` 中的任务可**自由添加**（特别是 make 目标的封装），无需征得用户同意
- 绝不在用户未运行测试(C#),或check（rust）或eslint（TypeScript）的情况下执行部署命令
- 绝不在用户未确认的情况下直接部署到 jellyfin-dev 容器
- `mise run update` 和 `mise run update-quick` 都会重启容器，是破坏性操作
- 各命令详情见 agents.md 中的测试命令章节

## PR 合并前检查清单（必须遵守）

**合并任何 PR 之前，必须依次确认以下两项，缺一不可：**

1. **README 检查**：对比本次 PR 的功能改动，判断 `README.md` 和 `README.zh-CN.md` 是否需要同步更新（新特性、行为变更、配置项变化等）。
2. **Workflow 检查**：检查 `.github/workflows/` 下的 CI/CD 文件是否需要随本次改动调整（新产物、新步骤、版本号、触发条件等）。

**如果需要更新但尚未更新 → 立即中断合并流程**，先完成更新并 commit + push，再执行合并。不得跳过直接合并。

详见 agents.md 的「PR 合并前检查」章节。

## Speckit 分支规范（强制覆盖）

**speckit 要求的 `00x-xxx` 格式分支命名必须无视。** speckit 的 git-feature hook（`/speckit-git-feature`）绝对不执行，规格文档（spec/plan/tasks）只在当前工作分支上提交，不得为 spec 工作单独创建新分支。

## JSON 大小写规范（必须遵守）

### 插件自有 API：强制 camelCase，双边同步

**本插件所有 C# DTO 属性必须加 `[JsonPropertyName("camelCase")]` 属性**，以 TypeScript/JS 标准为准。理由：插件控制器默认输出 PascalCase，而 TypeScript 标准是 camelCase；SSE 端点更是完全绕过 ASP.NET Core 中间件直接用 `System.Text.Json.JsonSerializer.Serialize()`，必须靠属性标注才能输出 camelCase。

```csharp
using System.Text.Json.Serialization;

public sealed class MyDto
{
    [JsonPropertyName("taskId")]   public string TaskId  { get; set; } = "";
    [JsonPropertyName("percent")]  public double Percent { get; set; }
    [JsonPropertyName("resultUrl")] public string? ResultUrl { get; set; }
}
```

**规则**：
- 新增任何 DTO 类 → 所有属性加 `[JsonPropertyName]`，不得遗漏
- C# DTO 变更后**必须**重新生成 TypeScript 类型：
  ```
   mise run gen-types   ← 需要 jellyfin-dev 容器正在运行（spec: http://localhost:8600/api-docs/openapi.json）
   ```
   生成的文件：`packages/api-types/src/jellyfin-api.ts`
- 前端从 `jellyfin-api.ts` 中的 `components['schemas']['XxxDto']` 取类型，通过 `@jfs/api-types` 包引用
- 前端直接读 camelCase key，不得使用 `d.foo ?? d.Foo` 兜底写法

### Jellyfin 原生 API：适应 PascalCase

Jellyfin 核心 API（`/Items/...`, `/Users/...` 等）返回 PascalCase（如 `MediaStreams`, `Name`, `Id`）。这个行为无法修改，前端必须适应：

```typescript
// 正确：读 Jellyfin 原生 API 用 PascalCase
const vid = data.MediaStreams?.find(s => s.Type === 'Video')
const fps = vid?.RealFrameRate ?? vid?.AverageFrameRate ?? 24
```

## Rust 修改规范（必须遵守）

**修改 Rust 代码后，必须先通过 `cargo check` 再执行 build，不得跳过直接构建。**

- `crates/frame-forge` 含 `#[cfg(feature = "opencv")]` 代码，Windows 本地无 OpenCV，必须在 Docker 中 check：
  ```
  mise run check-frame-forge
  ```
- 其他纯 Rust crate（`poster-gen`、`seek-preview`）可在本地直接 `cargo check -p <crate>`
- 只有 `check` 全部通过（0 errors）才允许触发完整 build（`mise run build-frame-forge` / `mise run update`）
- 每次修改后先跑 check，根据错误修复后再跑 check，确认 clean 再 build，**不得以 full build 做试错工具**

## Rust 代码规范（必须遵守）

### Trait / Enum / Struct 使用原则

- **Trait**：跨类型共享行为必须用 trait 抽象，不得用大型 `match` 代替多态。  
  示例：`AnyMatcher` 的 `match_images` 应提取为 `trait Matcher`，让调用方依赖 trait 而非具体类型。
- **Enum**：有限状态集用 `enum`，不得用魔法字符串（如 `"cuda"` 分支判断）。  
  `#[non_exhaustive]` 适用于跨 crate 暴露的 enum（防止下游 exhaustive match 因新变体编译报错）。  
  所有 `match` 必须穷举；只有真正的"不关心"才用 `_`，不得用 `_` 掩盖未处理的变体。
- **Struct**：三个或以上字段的返回值/数据包必须用 struct，不得用裸 tuple。  
  derive 顺序遵循 `#[derive(Debug, Clone, PartialEq, Default)]`；Default 在字段均有默认值时 derive，否则手动实现。  
  字段排布：较大字段（指针/Vec/String）在前，bool/u8 在后，可减少内存对齐 padding（热路径 struct 需确认）。

### 内存对齐规范

- **FFI struct** 必须标注 `#[repr(C)]`，否则 Rust 可自由重排字段。
- **非 FFI struct** 不得随意加 `#[repr(align(N))]`，除非 profile 证明 cache line 争用。
- **协议层**（socket wire）：永远用显式字节序写入（`BinaryPrimitives::WriteUInt32LittleEndian`），绝不用 `transmute` 或直接转型 struct 指针。

### 平台条件编译

- 用 **`#[cfg(target_os = "linux")]`** / **`#[cfg(target_os = "windows")]`** 做编译期平台分支，不得用运行时 `std::env::consts::OS` 字符串匹配。
- `target_family = "unix"` 覆盖 Linux/macOS 等所有 POSIX 平台；比 `target_os = "linux"` 更宽泛，按需选择。
- **`#[cfg(feature = "...")]` 只用于依赖特性开关**，不得用 frame-forge 自己的 feature 来模拟其他 crate 的 feature 状态。  
  反例（已踩坑）：frame-forge 代码中写 `#[cfg(feature = "cuda")]` 意图检查 ort crate 是否编译了 CUDA EP，但这是 ort 的 feature，不是 frame-forge 的 feature，该 cfg 永远为 false。  
  正解：直接使用 `ort::execution_providers::CUDAExecutionProvider`（已通过 Cargo.toml `features = ["cuda"]` 的 ort 编译时就存在），让 EP 失败通过运行时 `.ok()` 捕获而非编译期排除。

### 错误处理

- 应用层用 `anyhow::Result`，库层用 `thiserror`。
- `?` 要求 Error 类型实现 `Send + Sync + 'static`。  
  **ORT `Error<SessionBuilder>` 不是 `Send + Sync`**（含原始指针字段）；在 async 上下文或 `?` 到 anyhow 前，必须先用 `.map_err(|e| anyhow::anyhow!("{e}"))` 显式转换。
- 生产路径禁止 `.unwrap()`；可用 `.unwrap_or_default()`、`if let`、`?` 替代。

### unsafe 规范

- 每个 `unsafe { }` 块必须有 `// SAFETY:` 注释，解释为何不违反安全不变量。
- `unsafe { std::env::set_var(...) }` 只可在确保单线程且无并发读取的场合使用；多线程已启动后调用有 UB 风险。

### 单例与并发

- 静态单例优先用 `OnceLock<T>` + `Mutex<T>`，不得用 `lazy_static!`（已被 `OnceLock` 取代）。
- `spawn_blocking` 内部代码不得捕获非 `Send` 的引用；若需要，在进入 spawn 前克隆/提取所需数据。

## Shell 规范

- **所有 CLI 操作（npm、cargo、dotnet、make 等）一律用 bash**，不得使用 PowerShell skill
- **speckit skill 内的脚本调用也必须用 bash**，包括 `setup-tasks.ps1`、`setup-plan.ps1` 等均用 bash 工具执行（`bash .specify/scripts/...`），严禁使用 PowerShell skill
- 文件操作（Read/Write/Edit）使用 Windows 路径格式：`D:\Dev\...`
- bash 内路径使用 Unix 格式：`/d/Dev/...`
