<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at specs/009-frame-export-stitch/plan.md
<!-- SPECKIT END -->

## 部署工作流程（必须遵守）

**先测试，再部署，部署前必须征得用户同意。**

```
1. make test          ← 运行全套测试（Rust + TypeScript + C#）
2. make update        ← 部署到 jellyfin-dev 容器（会重启容器）
```

- 运行测试时**必须**用 `make test`（或 `mise run test`），`make` 是唯一正确的测试入口，不得直接调用 cargo/vitest/dotnet 替代
- 绝不在用户未运行测试并确认的情况下执行 `make build` 或 `make update`
- 绝不在用户未确认的情况下直接部署到 jellyfin-dev 容器
- `make update` 会重启容器，是破坏性操作
- 各命令详情见 agents.md 中的测试命令章节

## PR 合并前检查清单（必须遵守）

**合并任何 PR 之前，必须依次确认以下两项，缺一不可：**

1. **README 检查**：对比本次 PR 的功能改动，判断 `README.md` 和 `README.zh-CN.md` 是否需要同步更新（新特性、行为变更、配置项变化等）。
2. **Workflow 检查**：检查 `.github/workflows/` 下的 CI/CD 文件是否需要随本次改动调整（新产物、新步骤、版本号、触发条件等）。

**如果需要更新但尚未更新 → 立即中断合并流程**，先完成更新并 commit + push，再执行合并。不得跳过直接合并。

详见 agents.md 的「PR 合并前检查」章节。

## Speckit 分支规范（强制覆盖）

**speckit 要求的 `00x-xxx` 格式分支命名必须无视。** speckit 的 git-feature hook（`/speckit-git-feature`）绝对不执行，规格文档（spec/plan/tasks）只在当前工作分支上提交，不得为 spec 工作单独创建新分支。

## C# JSON 序列化规范（必须遵守）

**Jellyfin 插件的 ASP.NET Core 控制器默认使用 PascalCase 序列化 DTO 属性**（如 `SeekSeconds`），而非 camelCase（`seekSeconds`）。凡是新增 DTO 并在前端 JS/TS 读取其字段时，**必须**用以下任一方式保持一致：

1. **推荐**：给 DTO 属性加 `[JsonPropertyName("camelCaseName")]` 特性强制输出 camelCase：
   ```csharp
   using System.Text.Json.Serialization;
   public sealed class GestureConfigDto
   {
       [JsonPropertyName("seekSeconds")]
       public double SeekSeconds { get; set; }
   }
   ```
2. 或在前端同时处理两种大小写（兜底方案，不推荐）。

**不要**直接在前端写 `data.seekSeconds` 就假定返回的是 camelCase，必须先用 DevTools 确认实际 key 名。

## Shell 规范

- **所有 CLI 操作（npm、cargo、dotnet、make 等）一律用 bash**，不得使用 PowerShell skill
- **speckit skill 内的脚本调用也必须用 bash**，包括 `setup-tasks.ps1`、`setup-plan.ps1` 等均用 bash 工具执行（`bash .specify/scripts/...`），严禁使用 PowerShell skill
- 文件操作（Read/Write/Edit）使用 Windows 路径格式：`D:\Dev\...`
- bash 内路径使用 Unix 格式：`/d/Dev/...`
