<!--
Sync Impact Report
==================
Version change: (template) → 1.0.0 → 1.0.1 (PATCH: scope clarification added)
Added principles: I through VII (initial ratification, all new)
Added sections: Quality Gates, Amendment Procedure
Removed sections: none (template placeholders replaced)
Templates updated:
  ✅ .specify/memory/constitution.md (this file)
  ⚠ .specify/templates/plan-template.md — Constitution Check section should reference these principles
  ⚠ .specify/templates/spec-template.md — no immediate changes required
  ⚠ .specify/templates/tasks-template.md — no immediate changes required
Deferred: none
-->

# Jellyfin Suite Constitution

> **适用范围**：本 Constitution 专用于**重构与迁移类工作**（目录结构调整、依赖体系改造、包拆分合并等）。
> 它不是通用编码规范，不约束日常功能开发中的实现风格、命名约定或架构决策。

## Core Principles

### I. No Functionality Loss

Any restructuring, refactor, or migration MUST NOT remove, disable, or silently alter existing
user-facing behaviour. This includes:
- All plugin API endpoints and their response shapes
- All UI features (seek preview, frame export, OSD controls, trickplay)
- All background daemon behaviours (seek-preview, frame-forge)
- C# binary names (`seek-preview-linux-x64`, `frame-forge-linux-x64`, `poster-gen-linux-x64`)

**Rationale**: Restructuring work is invisible to users; any regression destroys trust without
delivering value.

### II. Structural Invariance

Order-sensitive elements MUST preserve their relative ordering across any refactor:
- CSS rules and `@import` sequences (later rules override earlier; wrong order silently breaks styles)
- JavaScript/TypeScript module import sequences where side-effect order matters
- Preact render tree structure (component hierarchy must not change without explicit intent)
- HTTP middleware registration order in C# (auth, routing, etc.)

**Rationale**: Reordering often produces no compile error but breaks runtime behaviour in ways
that are hard to detect through automated tests.

### III. Test Gate (NON-NEGOTIABLE)

`mise run test` MUST pass at the end of every Stage before proceeding to the next.
No exceptions. Failing tests block progress regardless of apparent cause.

Covered by `mise run test`:
- Rust: `cargo test -p seek-preview && cargo test -p frame-forge`
- TypeScript: bun test (frontend)
- C#: dotnet test

**Rationale**: A Stage that "almost works" is not done. Accumulated deferred failures compound
into unresolvable states.

### IV. Build Gate (NON-NEGOTIABLE)

Both of the following MUST pass before any Stage is marked complete:
1. **Local deployment**: `mise run update` (builds all artifacts, deploys to `jellyfin-dev` container,
   container restarts successfully)
2. **CI pipeline**: `.github/workflows/` — all workflow jobs pass (build + test + artifact upload)

Path changes in Makefile, `.mise.toml`, and workflow YAML MUST be updated atomically with the
directory moves that cause them.

**Rationale**: A build that passes locally but breaks CI (or vice versa) is not shippable.

### V. Incremental Verification

Each Stage MUST be independently verified before the next Stage begins. The verification command
for each Stage MUST be defined in the plan before implementation starts.

Allowed remediation within a Stage: fix and re-verify within the same Stage.
Not allowed: "I'll fix this in Stage N+1."

**Rationale**: Deferred fixes accumulate and become entangled with subsequent changes, making
rollback and root-cause analysis exponentially harder.

### VI. Git History Preservation

File and directory moves MUST use `git mv`, never delete-then-create. This preserves:
- `git blame` attribution
- `git log --follow` rename tracking
- PR diff readability (rename vs. full rewrite)

Bulk renames MUST be committed separately from content edits. A commit that moves a file AND
edits its content MUST be split into two commits: move first, then edit.

**Rationale**: Lost history is permanently lost. It cannot be recovered after the fact, and it
makes future debugging significantly harder.

### VII. Structure and Logic Separation

Structural changes (directory moves, package renames, import path updates) MUST NOT be mixed
with business logic changes in the same commit.

Permitted in the same commit:
- Moving a file AND updating import paths in files that reference it (pure mechanical consequence)

Not permitted in the same commit:
- Moving a file AND changing the logic inside it
- Renaming a package AND fixing a bug in that package

**Rationale**: Mixed commits make code review impossible, bisect unreliable, and rollback risky.

## Quality Gates

Each Stage in any restructuring plan MUST define and execute a verification command before
the Stage is considered complete. Typical gates per domain:

| Domain | Gate command |
|--------|-------------|
| Rust | `cargo check -p <crate>` (per crate, not workspace-wide) |
| TypeScript | `tsc --noEmit` + `pnpm -r build` |
| C# | `dotnet build packages/JellyfinSuite.Plugin/` |
| Full stack | `mise run test` |
| Deployment | `mise run update` |
| CI | `.github/workflows/` pass (verified via `mise run workflow-test` using `act`) |

Gates are sequential and non-optional. A failed gate MUST be resolved before moving forward.

## Amendment Procedure

1. Propose amendment in a spec or conversation context with explicit rationale.
2. Identify version bump type (MAJOR / MINOR / PATCH) per semantic rules below.
3. Update this file; increment `CONSTITUTION_VERSION`; set `LAST_AMENDED_DATE` to today.
4. Verify no principle contradicts another; remove any now-superseded guidance.
5. Update `.specify/templates/plan-template.md` Constitution Check section if affected.

**Version bump rules**:
- MAJOR: Removing a principle, or redefining a NON-NEGOTIABLE principle in a weaker form
- MINOR: Adding a new principle or a new Quality Gate row
- PATCH: Wording clarification, example addition, typo fix

## Governance

This constitution supersedes all other project conventions when conflicts arise.
All implementation plans MUST include a "Constitution Check" section verifying compliance
before any work begins. Any plan that violates a principle requires explicit documented
justification and a temporary exception recorded here.

`mise run test` and `mise run update` are the canonical compliance verification commands.
CI pipeline pass is mandatory before any PR merge.

**Version**: 1.0.1 | **Ratified**: 2026-05-31 | **Last Amended**: 2026-05-31
