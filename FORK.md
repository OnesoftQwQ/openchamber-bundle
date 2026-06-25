# OpenChamber Bundled Fork

基于 [openchamber/openchamber](https://github.com/openchamber/openchamber) v1.13.2 的 fork。

## 与上游的差异

### 架构改动

| 改动 | 上游 | 本 fork |
|------|------|---------|
| opencode 集成方式 | spawn 外部 `opencode serve` 子进程 | 构建时下载 binary，bundled 在 Electron extraResources 中 |
| opencode 生命周期管理 | PATH 搜索 → shell 探测 → wrapper 检测 → spawn → 健康检查轮询 → lsof 清理 | 直接 spawn 已知路径的 bundled binary，启动后做一次 readiness check |
| 子进程健康监控 | 15 秒间隔 + 20 次连续失败阈值 + busy session 保护 | 无（bundled binary 启动后不做周期性健康检查） |
| UI 加载方式 | `openchamber-ui://` 自定义协议（packaged 模式） | 始终走 HTTP（`http://127.0.0.1:PORT`） |
| 密码管理 | `ensureLocalOpenCodeServerPassword` 已存在 | 沿用，修复了 lifecycle 不同步的问题 |

### Linux 适配

| 功能 | 状态 |
|------|------|
| 窗口最小化/最大化/关闭按钮 | frameless + 自定义按钮，同 Windows |
| "打开方式"应用自动扫描 | `/usr/share/applications/.desktop` + `$PATH` 检测 |
| 打开项目/文件 | CLI 工具 + `xdg-open` |
| 应用图标 | 读取 `.desktop` 文件的 `Icon=`，搜索 hicolor 主题 |
| RPM 构建 | linux target（rpm + tar.gz） |
| autoUpdater | 禁用（fork 无对应 GitHub release） |

### 删除/简化的模块

| 文件 | 上游行数 | 本 fork 行数 | 说明 |
|------|---------|-------------|------|
| `lifecycle.js` | 946 | ~200 | 去掉 PATH 搜索、shell 探测、wrapper 检测、健康检查、lsof 清理 |
| `env-runtime.js` | 1088 | ~60 | 去掉 shell 快照、WSL 检测、node/bun 二进制查找、shebang 读取，只留 git 解析 |
| `shutdown-runtime.js` | 147 | ~80 | 去掉 `killProcessOnPort`、`waitForPortRelease` |

### 新增文件

- `scripts/download-opencode-binary.mjs` — 构建时从 GitHub releases 下载 opencode CLI
- `FORK.md` — 本文件

## 同步策略

上游更新时不要直接 `git merge`，用 cherry-pick。

```bash
git remote add upstream https://github.com/openchamber/openchamber.git
git fetch upstream
git log --oneline base..upstream/main   # 查看上游新 commit
git cherry-pick -x <commit-hash>        # 选择性拿
```

容易 cherry-pick 的文件：`packages/ui/src/`、`packages/web/server/lib/`（非 opencode/ 目录）、`packages/electron/preload.mjs`、`packages/vscode/`。

需要手动移植的文件：`lifecycle.js`、`env-runtime.js`、`shutdown-runtime.js`（和上游完全不同）。

## 构建

```bash
bun install                              # 安装依赖
cd packages/electron
bun run package --linux rpm              # 构建 RPM
```

构建产物在 `packages/electron/dist/` 目录。

## 基准版本

| 基准 | 对应上游版本 | 说明 |
|------|-------------|------|
| 初始 fork | v1.13.2 | 首次 fork |
