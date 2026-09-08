# CI 环境漂移修复 — 工程化改动说明 (CI engineering: killing environment drift)

**日期**: 2026-09-09 · **分支目标**: `feature/system-monitor-and-power`
**范围**: `gated-native-backends` / `android-audio-seams` / `lint-and-test` 三流水线反复
红的问题——根因不是“x86 vs arm64”本身，而是**本地 Mac 与 Ubuntu runner 之间交叉编译
链不一致**导致的漂移（NDK 版本、api 级、`libappindicator3-dev` 在 24.04 被移除、
`cargo-ndk`/clippy 严格度不统一）。

> 诚实前置（与 `docs/external-analysis-review.md` §3.1 一致）：外部“CI 持续红”的证据
> 来自 mail 链接而非本仓库真实 run，无法 100% 复现。故本改动**默认不改变 CI 绿路径行为**，
> 只把漂移源固定成单一事实源，并提供容器化隔离作为可选强一致模式。请以真实 `make lint` /
> `make test` / CI run 日志为最终判据。

---

## 1. 直接修掉的真实漂移源（默认即生效）

| 问题 | 改动 |
|---|---|
| runner 镜像随 `ubuntu-latest` 漂移（22.04→24.04） | 所有 job 钉死 `runs-on: ubuntu-24.04` |
| 24.04 移除了 `libappindicator3-dev`，安装步骤静默失败 → Tauri 依赖装不上 | 换成 24.04 的 `libayatana-appindicator3-dev`（`lint-and-test` / `gated-native-backends` / 容器镜像内） |
| `cargo-ndk` 每次装最新，随上游漂移 | 新增复合 action `prep-android`，钉死 `cargo-ndk 4.1.2` + NDK `26.1.10909125` |
| 中间提交排队、白跑 | 顶层 `concurrency.cancel-in-progress` |
| 网络拉预编译库偶发失败（sherpa/Piper） | 原生 gated job 增加 `CARGO_NET_RETRY=3` / `CARGO_HTTP_TIMEOUT=120` |

## 2. 新增：专用原生工具链 Docker 镜像（可选容器化）

- `docker/ci-android/Dockerfile`：Ubuntu 24.04 上预装**固定版本**的
  Rust stable(+rustfmt+clippy)、4 个 Android target、`cargo-ndk 4.1.2`、NDK `26.1.10909125`、
  固定 `protoc 28.3`、Tauri Linux 依赖。
- `workflows/container-image.yml`：构建并推送该镜像到 GHCR（手动 dispatch，或 main 上改动
  Dockerfile 时自动；PR 无 packages 写权限，需手动 dispatch）。

**接入容器模式（可选，默认不启用）**：在仓库 Settings → Secrets and variables → Actions 里设
变量
`CI_ANDROID_IMAGE = ghcr.io/arkCyber/amos-ci-android:latest`
随后 `gated-native-backends` 与 `android-audio-seams` 会改为在容器内跑 `make gated-check` /
`make android-audio-check && make android-ai-sherpa-check`；变量未设时走 host fallback（即
当前绿路径，只是钉了版本）。

## 3. 单一事实源：镜像 与 host fallback 必须同钉

`Dockerfile` 的 `ARG NDK_VERSION` / `ARG CARGO_NDK_VERSION` 与
`.github/actions/prep-android/action.yml` 的 input 默认值**必须一致**。
`scripts/ci-local-gate.sh` 会校验二者是否漂移。

## 4. 本地 Mac 对齐：deploy.sh

根因之一：`.cargo/config.toml`（git-ignored）把 NDK 23 的绝对路径、api 级、`darwin-x86_64`
clang 写死，与 CI 的 NDK 26 / api 26 语义不一致。

`deploy.sh`（统一本地入口）：
- **不再写死路径**：从 `ANDROID_NDK_HOME` → `$ANDROID_HOME/ndk/*` → brew
  `android-commandlinetools/ndk/*` 发现 NDK，按最高可用 api 生成 `.cargo/config.toml` +
  导出 `CC/AR/CARGO_TARGET_*_LINKER` env 到 `.cargo/amos-deploy-env.sh`。
- `./deploy.sh lint`：执行与 CI `make lint` **完全相同**的
  `cargo fmt --all --check` + `cargo clippy --workspace --all-targets -- -D warnings`，
  本地一条 warning 必然在 CI 也红。
- `./deploy.sh android [voice]` / `android-build`：先对齐 env 再跑与 CI 相同的 seam 门禁。
- `./deploy.sh ci-local`：跑本地校验脚本；`./deploy.sh docker` 本地构建镜像；
  `./deploy.sh doctor` 打印当前工具链版本。

Makefile 新增 `make ci-local` / `make deploy` / `make doctor` 便于入口统一。

## 5. 建议验收

1. `bash scripts/ci-local-gate.sh`（shell 语法 + workflow YAML + 版本钉一致性）。
2. 任一真实变更前 `./deploy.sh lint`（本地 == CI clippy）。
3. 推分支后看 4 个 job；确认 host fallback（默认）绿。
4. 想启用容器隔离：`./deploy.sh docker`（或 dispatch container-image.yml）推送镜像，
   再设 `CI_ANDROID_IMAGE` 变量后重跑。
