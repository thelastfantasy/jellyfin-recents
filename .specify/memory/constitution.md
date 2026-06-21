<!--
Sync Impact Report
==================
Version change: 1.1.0 → 1.1.1 → 1.1.2 (PATCH: translated entire document to Chinese; fixed stale
  "Preact" reference in Principle II to "React", reflecting the completed Preact→React migration)
Added principles: none
Modified: full-document translation (English → Chinese); Principle II frontend example updated
  from Preact to React (no normative/semantic change to the principle itself)
Added sections: none
Removed sections: none
Templates updated:
  ✅ .specify/memory/constitution.md (this file)
  ⚠ .specify/templates/plan-template.md — Constitution Check section should reference these principles
  ⚠ .specify/templates/spec-template.md — no immediate changes required
  ⚠ .specify/templates/tasks-template.md — no immediate changes required
Deferred: none
-->

# Jellyfin Suite 宪章

> **适用范围**：原则 I（功能无损）、II（结构不变性）、VI（Git 历史保留）、VII（结构与逻辑分离）
> 专用于**重构与迁移类工作**（目录结构调整、依赖体系改造、包拆分合并等），不约束日常功能开发中的
> 实现风格、命名约定或架构决策。
>
> 原则 III（Test Gate）、IV（Build Gate）、V（增量验证）是**通用质量门槛**，适用于**所有开发
> 工作**，包括新功能开发——不论是否为重构类工作，任何 Stage/Phase 在标记完成前都必须满足这三项门槛。

## 核心原则

### I. 功能无损

任何重构、refactor 或迁移 MUST NOT 移除、停用或悄悄改变既有的用户可见行为，包括：
- 所有插件 API 端点及其响应结构
- 所有 UI 功能（seek preview、frame export、OSD 控件、trickplay）
- 所有后台 daemon 行为（seek-preview、frame-forge）
- C# 二进制文件名（`seek-preview-linux-x64`、`frame-forge-linux-x64`、`poster-gen-linux-x64`）

**理由**：重构工作对用户是不可见的；任何回归都会在没有带来价值的情况下破坏用户信任。

### II. 结构不变性

顺序敏感的元素 MUST 在任何 refactor 中保持其相对顺序：
- CSS 规则与 `@import` 顺序（后面的规则会覆盖前面的；顺序错误会悄悄破坏样式）
- JavaScript/TypeScript 模块导入顺序（当副作用顺序有影响时）
- React 渲染树结构（组件层级不得在没有明确意图的情况下改变）
- C# 中 HTTP 中间件的注册顺序（鉴权、路由等）

**理由**：重新排序通常不会产生编译错误，但会以难以通过自动化测试检测的方式破坏运行时行为。

### III. Test Gate（不可妥协）

每个 Stage 结束、进入下一个 Stage 之前，`mise run test` MUST 通过。
没有例外。测试失败会阻塞进度，不论表面原因是什么。

`mise run test` 覆盖范围：
- Rust：`cargo test -p seek-preview && cargo test -p frame-forge`
- TypeScript：bun test（前端）
- C#：dotnet test

**理由**："差不多能用"的 Stage 不算完成。被延后的失败会不断累积，最终演变成无法收拾的状态。

### IV. Build Gate（不可妥协）

在任何 Stage 被标记为完成之前，以下两项 MUST 都通过：
1. **本地部署**：Windows 开发机用 `mise run update`，原生 Linux 开发机用 `mise run update-linux`
   （普通的 `update`/`build` target 会调用 `cygpath`，这在 Linux 上不存在，会直接报错）——构建全部
   产物、部署到 `jellyfin-dev` 容器、容器成功重启
2. **CI 流水线**：`.github/workflows/`——所有 workflow job 通过（构建 + 测试 + 产物上传）

Makefile、`.mise.toml` 和 workflow YAML 中的路径变更 MUST 与引发该变更的目录移动同一时间提交。

**理由**：本地能过但 CI 挂掉（或反之）的构建不具备可发布性。

### V. 增量验证

每个 Stage MUST 在下一个 Stage 开始之前独立完成验证。每个 Stage 的验证命令 MUST 在开始实现之前
就在 plan 中定义好。

Stage 内允许的补救方式：在同一个 Stage 内修复并重新验证。
不允许的方式："这个我留到 Stage N+1 再修。"

**理由**：被延后的修复会不断累积，并与后续改动相互纠缠，使回滚和根因排查的难度呈指数级上升。

### VI. Git 历史保留

文件与目录的移动 MUST 使用 `git mv`，绝不能先删除再新建。这样才能保留：
- `git blame` 的归属信息
- `git log --follow` 的重命名追踪
- PR diff 的可读性（重命名 diff 而非整体重写 diff）

批量重命名 MUST 与内容编辑分开提交。一个既移动文件又编辑其内容的 commit MUST 拆成两个：先移动，
再编辑。

**理由**：丢失的历史是永久丢失的，事后无法恢复，并且会让未来的调试明显更困难。

### VII. 结构与逻辑分离

结构性改动（目录移动、包重命名、import 路径更新）MUST NOT 与业务逻辑改动混在同一个 commit 里。

同一个 commit 中允许的情况：
- 移动文件并更新引用该文件的 import 路径（纯粹的机械性连带改动）

同一个 commit 中不允许的情况：
- 移动文件同时改动其内部逻辑
- 重命名包的同时修复该包里的 bug

**理由**：混杂的 commit 会让 code review 无法进行，让 bisect 变得不可靠，也让回滚变得有风险。

## 质量关卡（Quality Gates）

任何重构计划中的每个 Stage MUST 在被认为完成之前，定义并执行一条验证命令。各领域的典型关卡：

| 领域       | 关卡命令                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| Rust       | `cargo check -p <crate>`（按 crate 单独检查，不要整个 workspace 一起检查）      |
| TypeScript | `tsc --noEmit` + `pnpm -r build` + eslint check                               |
| C#         | `dotnet build packages/JellyfinSuite.Plugin/`                                 |
| 全栈       | `mise run test`                                                               |
| 部署       | `mise run update`（Windows）/ `mise run update-linux`（Linux）                |
| CI         | `.github/workflows/` 全部通过（通过 `mise run workflow-test` 用 `act` 验证）    |

各关卡按顺序执行，且不可省略。未通过的关卡 MUST 在继续推进之前解决。

## 修订流程

1. 在 spec 或对话上下文中提出修订建议，并附明确理由。
2. 按下方语义化规则确定版本号递增类型（MAJOR / MINOR / PATCH）。
3. 更新本文件；递增 `CONSTITUTION_VERSION`；将 `LAST_AMENDED_DATE` 设为今天。
4. 确认没有原则相互矛盾；移除任何已被取代的旧指引。
5. 如有影响，更新 `.specify/templates/plan-template.md` 中的 Constitution Check 部分。

**版本号递增规则**：
- MAJOR：移除某条原则，或将某条不可妥协的原则改成更弱的形式
- MINOR：新增一条原则，或新增一行 Quality Gate
- PATCH：文字澄清、补充示例、修正笔误

## 治理

本宪章在与其他项目约定冲突时具有最高优先级。
所有实现计划 MUST 包含一个"Constitution Check"部分，在任何工作开始之前验证是否符合本宪章。
任何违反某条原则的计划，都需要明确写出书面理由，并在此记录一个临时例外。

`mise run test` 与 `mise run update`（原生 Linux 开发机上为 `mise run update-linux`）是规范的合规
验证命令。CI 流水线通过是合并任何 PR 的前提条件。

**版本**：1.1.2 | **批准日期**：2026-05-31 | **最近修订**：2026-06-19
