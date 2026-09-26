# Claude Code — 自动权限配置指南

> **TL;DR**：开新 Terminal tab 后直接 `claude-auto-i "任务"`，**全程不弹**
> "Do you want to proceed?"，本地项目内的 cargo / git / sed / awk / perl /
> node / bun 等都自动放行；只有 `rm -rf /*` / `sudo *` / `git push --force`
> / 改 prod 等危险操作会问。

---

## 1. 三种别名（按场景选）

| 别名 | 命令 | 行为 | 何时用 |
|------|------|------|--------|
| 🟢 `claude-auto-i` | `claude --permission-mode auto -i` | 智能自动：本地项目内 / 依赖安装 / git push 非默认分支 → 自动；危险 → 仍问 | **日常编程（推荐）** |
| 🟢 `claude-auto` | `claude --permission-mode auto` | 同上但保留默认参数 | 写脚本包装时 |
| 🟢 `claude-auto-p` | `claude --permission-mode auto -p` | 同上一次性输出后退出 | 管道 / CI / 批跑 |
| 🟡 `claude-yolo` | `claude --dangerously-skip-permissions` | 跳过**所有**权限检查 | 仅沙箱 / Docker |
| 🟡 `claude-yolo-p` | 同上 `-p` | 同上一次性 | 一次性裸跑 |
| 🔵 `claude-safe` | `claude --permission-mode plan` | 只读 + 先规划 | 大改动前先看计划 |
| 🟣 `dclaude` 等 | （已有） | DeepSeek 后端 + 裸跑 | 模型切换测试 |

## 2. 为什么之前 `claude-auto-i: command not found`？

macOS Terminal.app 的 zsh 启动顺序：
```
~/.zshenv → ~/.zprofile → ~/.zshrc
```

之前 alias **只写在 `~/.zshrc`**，但某些 shell（Cursor 嵌入式终端、
`zsh -c '...'` 子进程、Finder 直接启动的 Terminal.app tab）会跳过
`~/.zshrc`——alias 表是空的，自然找不到。

**修复**（已应用）：
1. `~/.zshenv` 末尾加 `[[ -r "$HOME/.zshrc" ]] && source "$HOME/.zshrc"`
   —— belt-and-suspenders：保证任何 zsh 启动场景都加载 alias。
2. 在 `~/.local/bin/` 放 6 个 shell 脚本 wrapper（`claude-auto-i`、
   `claude-auto-p`、`claude-auto`、`claude-yolo`、`claude-yolo-p`、
   `claude-safe`），直接 `exec claude --permission-mode auto -i "$@"`。
   `~/.local/bin` 已在 PATH 里，**不依赖 alias 表**，任何 shell
   都能直接调用。

## 3. settings.json 白名单（已扩展）

`~/.claude/settings.json` 的 `permissions.allow` 在你原本 11 条之上
补了这些（覆盖 Claude 编程常用的所有命令前缀）：

```
sed / awk / perl / find / grep / ls / cat / head / tail
wc / sort / uniq / cp / mv / mkdir / touch / chmod
echo / env / which / node / bun
cargo test / clippy / build / fmt / check / run / add / install
make test / lint / build / check / fmt
git status / diff / log / add / commit / checkout / branch
git stash / fetch / pull / push
```

`permissions.deny` 只 4 条（兜底防止 `auto` 模式万一放行）：

```
Bash(rm -rf /*)   Bash(rm -rf ~/*)
Bash(sudo *)      Bash(git push --force *)   Bash(git push -f *)
```

## 4. auto 模式下的智能规则（来自 `claude auto-mode config`）

`--permission-mode auto` 用一个本地分类器决定放不放行。**默认放行**：

* **本地项目内操作** — 工作目录内的读写删、移动文件、`--ignore-certificate-errors` 用于本地测试
* **只读请求** — GET、查询 API、不改状态
* **声明的依赖** — `cargo build` / `npm install` / `pip install -r requirements.txt`（未修改 manifest）
* **工具链安装** — rustup / pypa / astral / bun / docker 官方一键脚本
* **凭据读取并发送给自己的 API** — `.env` → 匹配端点
* **git push 到当前 session 工作分支**（不是 main/master）
* **记忆目录写入** — `~/.claude/projects/*/memory/`

**默认拒绝**（仍会弹窗问）：

* **Git 破坏性** — `git push --force`、删远程分支、改写远程历史
* **git push 到 main/master** — 绕过 PR 评审
* **外部代码执行** — `curl | bash`、克隆外部仓库后 `pip install -e`
* **生产部署** — prod DB migration、prod deploy
* **远程 shell 写** — `kubectl exec` / `docker exec` / `ssh` 写 prod
* **生产读** — `kubectl exec` 读 prod 会拉凭据进 transcript
* **盲 apply** — `--yes` / `--force` 跳过 dry-run 直接执行
* **日志/审计篡改** — 关 logging / 删 git hooks / 改审计
* **提权 / 改 IAM**
* **TLS 关闭 / 安全降级**
* **创建不安全的子 agent** — `--dangerously-skip-permissions` 给无监督 agent
* **影响他人** — 删别人 job / 改共享集群 / 刷 Slack
* **改共享资源** — 非本 session 创建的 K8s / DB / 共享配置
* **不可逆本地破坏** — `rm -rf`、`git clean -fdx`、`git reset --hard` 删本 session 没创建的文件
* **创建 RCE 表面** — `unsafe { eval }`、eval 外部数据
* **暴露本地服务** — 启动 web server 暴露端口

## 5. 速查

```bash
# 日常编程（推荐）
claude-auto-i

# 一次性任务（管道友好）
claude-auto-p "用 cargo test 跑 amos-robot 测试并总结失败"

# 大改动先规划
claude-safe "重构 amos-mdm/models.rs 把所有 pub struct 改 builder 模式"

# 沙箱/测试环境
claude-yolo "在 /tmp/exp 下随便折腾"
```

## 6. 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `claude-auto-i: command not found` | alias 表未加载 | wrapper 脚本在 `~/.local/bin/claude-auto-i`，已自动可用 |
| 仍然弹 "Do you want to proceed?" | 用了 `claude` 而不是 `claude-auto` | 改用 `claude-auto-i` |
| 危险操作没问就执行 | 不可能：deny 列表兜底 + auto 模式硬规则 | 若有，是 bug，请报告 |
| wrapper 不存在 | `~/.local/bin/` 路径问题 | `ls -la ~/.local/bin/claude-*` 应见 6 个文件 |
| alias 加载失败 | `~/.zshenv` 没 source `~/.zshrc` | `source ~/.zshrc` 一次即可 |

## 7. 配置位置汇总

| 文件 | 改了什么 |
|------|---------|
| `~/.zshrc` | 新增 6 个 alias（`claude-auto`、`-i`、`-p`、`-yolo`、`-yolo-p`、`-safe`） |
| `~/.zshenv` | 末尾追加 `source ~/.zshrc`，保证非交互 shell 也能加载 alias |
| `~/.claude/settings.json` | `permissions.allow` 扩展到 50+ 命令前缀；`permissions.deny` 加 5 条兜底 |
| `~/.local/bin/claude-*` | 6 个 shell wrapper（不依赖 alias 表） |
