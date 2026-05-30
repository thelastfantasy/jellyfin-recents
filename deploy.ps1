#!/usr/bin/env pwsh
# 完整部署到 jellyfin-dev（PowerShell 入口）
# 用法: .\deploy.ps1            # 完整部署（含 Rust 重建）
#        .\deploy.ps1 -Quick    # 快速部署（跳过 Rust）

param([switch]$Quick)

$target = if ($Quick) { "update-quick" } else { "deploy" }
bash -c "make $target"
