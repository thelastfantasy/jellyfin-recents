<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at specs/009-frame-export-stitch/plan.md
<!-- SPECKIT END -->

## 部署工作流程（必须遵守）

**先测试，再部署，部署前必须征得用户同意。**

```
1. mise run test      ← 运行全套测试（Rust + TypeScript + C#）
2. mise run update    ← 部署到 jellyfin-dev 容器（会重启容器）
```

- 运行测试时**必须**用 `mise run test`，不得直接调用 cargo/vitest/dotnet 替代
- 所有 make 目标均可通过 `mise run <task>` 调用；`.mise.toml` 中的任务可**自由添加**（特别是 make 目标的封装），无需征得用户同意
- 绝不在用户未运行测试(C#),或check（rust）或lint（TypeScript）的情况下执行 `mise run update`
- 绝不在用户未确认的情况下直接部署到 jellyfin-dev 容器
- `mise run update` 会重启容器，是破坏性操作
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
  生成的文件：`src/player-enhancer/src/jellyfin-api.ts`、`src/frontend/src/jellyfin-api.ts`
- 前端从 `jellyfin-api.ts` 中的 `components['schemas']['XxxDto']` 取类型，不手写接口
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

- `src/frame-forge` 含 `#[cfg(feature = "opencv")]` 代码，Windows 本地无 OpenCV，必须在 Docker 中 check：
  ```
  mise run check-frame-forge
  ```
- 其他纯 Rust crate（`poster-gen`、`seek-preview`）可在本地直接 `cargo check`
- 只有 `check` 全部通过（0 errors）才允许触发完整 build（`mise run build-frame-forge` / `mise run update`）
- 每次修改后先跑 check，根据错误修复后再跑 check，确认 clean 再 build，**不得以 full build 做试错工具**

## Shell 规范

- **所有 CLI 操作（npm、cargo、dotnet、make 等）一律用 bash**，不得使用 PowerShell skill
- **speckit skill 内的脚本调用也必须用 bash**，包括 `setup-tasks.ps1`、`setup-plan.ps1` 等均用 bash 工具执行（`bash .specify/scripts/...`），严禁使用 PowerShell skill
- 文件操作（Read/Write/Edit）使用 Windows 路径格式：`D:\Dev\...`
- bash 内路径使用 Unix 格式：`/d/Dev/...`
