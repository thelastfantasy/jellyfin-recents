# AI 协作规范（agents.md）

本文件约束 Claude Code 等 AI 助手在此项目中的行为。

## 核心原则

- **先测试，再部署，部署须确认。**
- **修改代码前，先同步 spec.md 和 tasks.md。**
- 修改代码后一定要运行语法检查，比如cargo check和eslint，cargo check要通过mise task运行。
- 所有与开发者的交流使用中文。
- commit要在动作确认无误后才能执行，禁止改完代码就直接 commit。
- 修改代码后不能马上部署，必须等开发者反映没有其他问题了才部署。
- deploy只要不报错就必须一直等待，禁止在部署途中尝试加速如直接复制文件等。
- 所有找到的问题只要知道解决方法，必须立刻修复，禁止推迟到下次迭代。

## 部署工作流程

```
1. make test        — 运行全套测试（Rust + TypeScript + C#）
2. 报告测试结果     — 等待用户明确确认
3. mise run deploy — 完整构建并部署到 jellyfin-dev（全量，禁止部分部署）
```

**部署规则**：
- **始终用 `mise run deploy`**，禁止部分部署（如单独 `docker cp` 个别文件）
- **每次部署完成后必须自检**，通过 DevTools MCP：
  - 控制台无 error
  - Network 面板无 404
  - DOM 结构与预期一致，页面功能正常
- **禁止将验证责任转嫁给用户**（如"你去试试"、"刷新看看"）

## 代码变更工作流程

```
1. 更新 spec.md（功能需求）
2. 更新 tasks.md（任务列表，标记完成项）
3. 写/改代码
4. 运行 make test
5. 等用户确认后 make update
```

## PR 合并前检查（必须遵守）

**执行 `gh pr merge` 之前，必须完成以下两项检查，任何一项未通过即中断合并。**

### 1. README 检查

对比本次 PR 的功能改动（`git diff main...HEAD`），判断是否有面向用户的新特性、行为变更、新配置项：
- **有** → 更新 `README.md` 和 `README.zh-CN.md`，commit + push 后再合并
- **无** → 继续

### 2. Workflow 检查

检查 `.github/workflows/` 下的 CI/CD 文件是否需要随本次改动调整：
- 新的构建产物或目标平台
- 新的部署步骤或依赖脚本
- 版本号、触发条件变化
- **需要** → 更新对应 workflow 文件，commit + push 后再合并
- **不需要** → 继续

### 操作模板

```bash
# 先检查哪些文件已改动
git diff main...HEAD -- README.md README.zh-CN.md .github/workflows/

# 如需补充更新，完成后：
git add README.md README.zh-CN.md  # 或 .github/workflows/xxx.yml
git commit -m "docs: update README / workflow for <feature>"
git push

# 再合并
gh pr merge --squash --delete-branch
```

## 测试命令

**测试应通过 Makefile 运行**（在用户的终端里）：

| 命令                         | 说明                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `make test`                  | 运行全套测试（**推荐**）                                                                                         |
| `make test-rust`             | Rust 单元测试（poster-gen）                                                                                      |
| `make test-frontend`         | TypeScript/Vitest 测试                                                                                           |
| `make test-csharp`           | C# xUnit 测试                                                                                                    |
| `make workflow-test`         | 本地运行 build workflow（需要 Docker，用 `act`）                                                                 |
| `make workflow-test-release` | 本地运行 release workflow（构建/打包步骤可测；GitHub Release 和 Pages deploy 步骤因需真实 token 会失败，属正常） |

若系统没有 `make`，可用 `mise run test` / `mise make test` 代替（mise 会通过 conda 安装 make）。

Claude 需要运行测试时，**优先调用 `make test`**（或具体套件的 `make test-rust` 等），而不是直接调用 `cargo test`/`vitest`/`dotnet test`。只有在 make 明确不可用时才退而使用各工具链命令。

`vitest.config.ts` 是专用测试配置（root = 项目根，server.fs.allow 包含 tests/），`vite.config.ts` 是构建配置，两者分开。

## TypeScript / ESLint 零报错要求

前端项目（`apps/player-enhancer`、`apps/frontend`）部署前必须通过：

```bash
cd apps/player-enhancer && npx tsc --noEmit && npx eslint src/
cd apps/frontend      && npx tsc --noEmit && npx eslint src/
```

- **tsc --noEmit**：零 error（warning 不算，但 error 必须清零）
- **eslint**：零 error（warning 可存在，但不建议累积）

此检查应在每次 `mise run deploy` 之前执行，未通过则阻塞部署。

## 开发环境

- Jellyfin 容器：`jellyfin-dev`，访问地址 `http://localhost:8600`
- Docker Desktop 必须以管理员身份运行
- 容器停止时用 `docker start jellyfin-dev` 启动
- 如 config 卷损坏：`docker rm jellyfin-dev && docker volume rm jellyfin-config`

## 项目结构

```
src/
  JellyfinRecents.Plugin/   — C# Jellyfin 插件
  frontend/                 — TypeScript/Preact 前端
  poster-gen/               — Rust 海报生成器 CLI
tests/
  frontend/                 — Vitest 前端测试
  JellyfinRecents.Tests/    — C# xUnit 测试
specs/
  003-poster-sheet-generator/ — 当前功能规格文档
```
