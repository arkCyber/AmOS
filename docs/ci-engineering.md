# CI 环境漂移修复 — 工程化改动说明 (CI engineering: killing environment drift)

**日期**: 2026-09-09（该轮工作已并入 `main`）
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

  第 5 步（容器构建）的 Docker 探测是**有界的**（`AMOS_DOCKER_PROBE_SECS`，默认 20s）：
  此前 `docker info` 在 Docker Desktop 启动中/卡住时会**无限挂起**，把整条门禁一起拖住
  （REQ-A193 实测挂 5 分钟以上）；现在超时即打印 `docker daemon did not answer within Ns;
  skipping build`，`--docker` 仍可强制尝试。

Makefile 新增 `make ci-local` / `make deploy` / `make doctor` 便于入口统一；另有
`make verify` = **一条命令跑完所有"不需要设备"的验证目标**（lint/test/check/cov/ci-local/
smoke/sup-smoke/timesync-smoke/honesty-smoke/hot-loop/e2e-local/gated-check/android-* 等），
即 CI 各 job 的本地串行等价物（REQ-A193）。

## 5. 建议验收

1. `bash scripts/ci-local-gate.sh`（shell 语法 + workflow YAML + 版本钉一致性）。
2. 任一真实变更前 `./deploy.sh lint`（本地 == CI clippy）。
3. 推分支后看 4 个 job；确认 host fallback（默认）绿。
4. 想启用容器隔离：`./deploy.sh docker`（或 dispatch container-image.yml）推送镜像，
   再设 `CI_ANDROID_IMAGE` 变量后重跑。

---

## 6. 第二轮（2026-09-15）：把"漂移源"从**人工修一遍**变成**门禁修不了就红**

第 1 节的改动是**手动**把当时的漂移点钉住的；它没有留下任何"下次不许再浮动"的东西。
第一轮漏掉了两个**与已修项同类**的漂移源，而且它们恰好覆盖"本地 vs runner"这条主战场：

| 仍在漂移的东西 | 证据（修前实跑） | 为什么它是**根因级**的 |
|---|---|---|
| **Rust 工具链**：`rust-toolchain.toml: channel = "stable"`，CI 4 处 `dtolnay/rust-toolchain@stable` | 本地 `rustc 1.98.0`；runner 每天取当时最新 stable | `rustfmt` 与 `clippy` 的**行为**随版本变化，所以"本地绿、CI 红"是**结构性**的。更糟的是 `dtolnay/rust-toolchain@stable` **覆盖** `rust-toolchain.toml` —— CI 与本地**必然**是两个工具链。历史里的 `style: cargo fmt — make lint's fmt check was failing` 正是这一类，不是偶发。 |
| **runner 镜像**：`license.yml` / `stale.yml` 仍是 `ubuntu-latest` | `grep runs-on:` 实测 | 与第 1 节修掉的是**同一个** 22.04→24.04 事故；一个 workflow 钉 24.04、另一个浮动，等于没修。 |
| **Cargo.lock 无新鲜度检查** | `make lint`/`make test` 均无 `--locked` | 改了 `Cargo.toml` 忘了刷 lock 时，CI 会**静默重解析**出一套依赖，于是"CI 绿"与"提交里锁住的那套"无关——正是"复现不了一致环境"的另一种形态。 |

### 6.1 单一事实源：`rust-toolchain.toml` → 所有 job

- `rust-toolchain.toml` 钉到具体版本（当前 `1.98.0`），并写明 bump 流程。
- 新增 **`.github/scripts/read-rust-pin.sh`**：唯一一处"CI 怎么得知用哪个工具链"的实现。
  它读 `rust-toolchain.toml` 的 `channel`，写进 `$GITHUB_OUTPUT`，**缺失或没有 `channel`
  就非零退出**（默默回落 `stable` 正是要防的事）。本地可直接跑，输出即当前钉版。
- `ci.yml`（3 处）、`release.yml`、`.github/actions/prep-android`（1 处）改为
  `dtolnay/rust-toolchain@master` + `toolchain: ${{ steps.rust-pin.outputs.channel }}`。
- `.github/docker/ci-android/Dockerfile` 的 `ARG RUST_CHANNEL` **镜像**该钉版（不是第二个源）。

### 6.2 新门禁：`scripts/ci-drift-scan.mjs`（零依赖 + `--selftest` + 无理由不可豁免）

| 规则 | 内容 |
|---|---|
| R1 | `rust-toolchain.toml` 的 channel 必须是 `X.Y.Z`（`stable`/`beta`/`nightly-*` 都是浮动） |
| R2 | 任何 job 不得用 `*-latest` runner；`runs-on: ${{ matrix.runner }}` 的**每一条腿**都要钉 |
| R3 | `dtolnay/rust-toolchain@…` 只允许 `@master` **且** `toolchain:` 必须来自读了 `rust-toolchain.toml` 的步骤输出（杜绝第二个源） |
| R4 | Dockerfile 的 `RUST_CHANNEL` 必须等于 R1 的钉版，且真的传给 rustup |

豁免写在 `scripts/ci-drift-allowlist.json`：**必须给理由**，且**失效的豁免会被报为 stale**（一条
活过其成因的豁免，会掩盖同类的下一次回归）。接入 `make lint`（CI 的 `lint-and-test` 就跑它）
与 `scripts/ci-local-gate.sh`（§4c）。

`make lint` 同时新增 `cargo metadata --locked --format-version 1 > /dev/null`：lock 与
manifest 不一致时立刻失败（离线、秒级），CI 不再可能"在旧 lock 上静默重解析"。

### 6.3 实测证据（负控 → 修复 → 复核）

1. **修前**：`node scripts/ci-drift-scan.mjs` → **FAIL 8 处**，逐条命中上表
   （`rust-toolchain.toml:1`、`ci.yml:29/64/109`、`release.yml:44`、`prep-android:24`、
   `license.yml:13`、`stale.yml:14`）。
2. **自测**：`--selftest` 24 例（含**必失败**例）；它上线即抓到**规则自身的两个缺陷**——
   ① `toolchain:` 提取缺多行标志（把合规写法误报成不合规）；② 按"更深缩进"取 `with:` 块，
   而 GitHub YAML 里 `uses:`/`with:` 是**同缩进兄弟键**（导致所有真实 workflow 都被判为"没有
   toolchain 输入"）。两条都已修正，否则这就是一个"永远在乱报"的假门。
3. **修后**：`ci-drift-scan` **OK**；`ci-local-gate.sh` 全绿（含 YAML 解析——`name:` 里带
   `: ` 的裸标量非法，本轮也因此修掉 5 处引用）；`bash .github/scripts/read-rust-pin.sh` →
   `Rust toolchain pinned by rust-toolchain.toml: 1.98.0`。

### 6.4 诚实边界

- 门禁是**行/正则**级解析（与 `scripts/*.mjs` 其余门禁同一纪律），不是 YAML AST：极端写法
  （多文档 YAML、锚点）看不到；但它只管几行固定键，且**有任何豁免都要写理由**。
- **钉版不会自动升级**：想升级必须改 `rust-toolchain.toml`（+ Dockerfile 镜像），这是刻意的
  ——升级工具链应当是一次**有意的提交**，而不是某天 runner 自己动了。
- `read-rust-pin.sh` 只解决"用哪个工具链"；**依赖解析**的可复现仍靠 `--locked` 与
  `Cargo.lock` 提交纪律（见 `docs/release-artifacts.md` 的边界说明）。
- 本次未做：runner 镜像的 **digest 级**（`ubuntu-24.04` 仍会随 GitHub 的镜像更新而变，只是
  不再跨大版本）；如需更强一致性请启用第 2 节的容器模式。
