# 开发/运维工具现状摸底（2026-09-18）

> 给用户那张「工具/状态」表配上依据。**每行都带可跑命令或文件路径**，状态分四级：
> `❌ 完全缺失` / `基础（仅本地/手跑）` / `框架（有钩子但缺远端）` / `完整（生产就绪）`

## 0. 总览（用户原表）

| 工具 | 用户标 | 本表标 | 主要证据 |
|------|--------|--------|----------|
| CI/CD 流水线 | 基础 | 基础（fmt/clippy/test/release 五件齐） | `.github/workflows/{ci,release,container-image,stale,license}.yml` + `Makefile verify`（60+ 目标） |
| 监控告警 | 框架 | 框架（采样+UI 完；规则+通道缺） | `crates/amos-monitor` + `crates/amos-power` + `docs/monitor-dock-verify.md`；**无 alertmanager/webhook** |
| 日志聚合 | ❌ | ❌（本地自轮转文件 sink 已有；**结构化/远端 shipper 为 0**）| `crates/amos-ai/src/logfile.rs`（已 OK）+ `crates/amos-tauri/src/host_log.rs`（stderr/logcat 已有）；**无 JSON/OTLP** |
| 配置管理 | 框架 | 框架（env 双向同步 + feature gate；**分层/热重载/schema/flag-server 缺**）| `docs/ENV_VARIABLES.md` + `scripts/env-doc-gen.mjs` + `scripts/env-doc-scan.mjs` |
| 容器编排 | ❌ | ❌（CI 单镜像；**零 docker-compose/K8s**）| `.github/docker/ci-android/Dockerfile`（CI 工具链）+ `deploy/{daemons.json,android/amos.rc}`（init.rc，**不是容器**） |

---

## 1. CI/CD 流水线（基础）

**现有资产**

- `.github/workflows/ci.yml` — 4 个 job：`lint-and-test` / `smoke` / `gated-native-backends`（host↔container 双模）/ `android-audio-seams`
- `.github/workflows/release.yml` — 仅 tag 触发；ubuntu-24.04 + macos-14 矩阵；`scripts/release-artifacts.sh` 单点；SHA256SUMS 校验
- `.github/workflows/container-image.yml` — `ghcr.io/<owner>/amos-ci-android` 镜像发布
- `.github/workflows/{stale,license}.yml` — 周边维护
- `.github/actions/prep-android` — 共享 NDK 准备
- `.github/scripts/read-rust-pin.sh` — `rust-toolchain.toml` 单点 pin

**Makefile 关键目标**（60+ 选 10）

| 目标 | 用途 |
|------|------|
| `verify` | 一键 22 个离线门禁串联（lint + test + cov + ci-local + smoke + gated-check + 8 个 android 检查）|
| `lint` | fmt + clippy `-D warnings` + 30+ 个 `*-scan.mjs` |
| `test` | workspace + 8 个 feature gate 单独跑（REQ-A188 的盲点防御）|
| `gated-check` | sherpa/Piper/NTP 真实下载 + 编译 + 运行 |
| `android-{audio,ai-sherpa,app}-check` | 三层 NDK 守门 |
| `cov` | TS core-lib 行覆盖（默认 90%）|
| `ci-local` | shell 语法 + workflow YAML + 容器构建 |

**最该补的 1-2 件**

1. **SCA**（依赖漏洞扫描）：零依赖漏洞扫描 → 加 `cargo audit` 到 CI（GitHub Action `taiki-e/install-action` 或 `rustsec/audit-check`），失败阻断
2. **SBOM**（软件物料清单）：零 SBOM 生成 → 加 `cargo cyclonedx --format json` 到 release，产物上载到 GitHub Release
3. **性能门**：零 perf 门 → 加 `cargo bench` + `scripts/bench-compare.sh`（与基线对比，回归 > 5% 阻断）

**能跑通的最小命令**

```bash
make verify   # 22 个离线门禁（无 NDK 时跳 android-*）
```

---

## 2. 监控告警（框架）

**现有资产**

- `crates/amos-monitor/`
  - `monitor.rs`（聚合器）/ `sampler.rs`（采样器接口）/ `linux.rs`（真 `/proc` 读）/ `android.rs`（HAL stub）/ `spec.rs`（数据模型）
  - `examples/sample_health.rs` — 打印一次采样
  - `tests/` 通过 `make test` 跑
- `crates/amos-power/`（电源 + DVFS）
  - `freq.rs`（频率）/ `governor.rs`（DVFS 调控）/ `policy.rs`（策略）/ `linux.rs`（sysfs）/ `android.rs`（HAL）
  - `tests/integration.rs` + `tests/closed_loop_linux.rs`（REQ-A243 守门）
- `crates/amos-sensor/`（传感器）
  - `service.rs`（gRPC）/ `manager.rs`/`provider.rs`/`stream.rs`（数据流）
  - `tests/sensor_rpc_e2e.rs`
- `crates/amos-ai/src/monitoring.rs` — 把 monitor + energy + sensor 装进 daemon 的 `get_status`
- `docs/monitor-dock-verify.md` — dock「系统监控」App 真机验收表（A1–A10）
- `crates/amos-ai/src/alerts.rs` — **阈值告警在 daemon 内部**，但**没有飞出去的通道**

**最该补的 1-2 件**

1. **告警通道**：`crates/amos-ai/src/notifier.rs` —— SMTP + Webhook 双通道（纯 std + `ureq`，无新重依赖），失败降级到本地 stderr + 计数
2. **分级与静默窗口**：在 `alerts.rs` 上加 P0/P1/P2 级别 + 抑制窗口（同一规则 5 分钟内不重发）+ 维护窗口（`AMOS_GOVERNOR_MAINTENANCE`）

**能跑通的最小命令**

```bash
cargo test -p amos-monitor --features linux --lib
cargo test -p amos-power --features linux
```

---

## 3. 日志聚合（❌）

**已有（不重做）**

- `crates/amos-ai/src/logfile.rs`（REQ-A81/REQ-A87）—— 本地有界自轮转文件 sink，纯 std，**完整可测**
- `crates/amos-tauri/src/host_log.rs`（REQ-A229）—— 桌面 stderr + Android logcat 双 sink
- `crates/amos-mdm/src/main.rs:25` —— 独立 `tracing_subscriber::FmtSubscriber` 初始化

**完全缺失**

1. **结构化 JSON 输出**：所有 sink 都是 human-readable 文本；ELK/Loki 不可直接消费
2. **trace_id 串联**：多服务调用无关联 ID（前端 invoke → 后端命令 → 守护进程事件）
3. **远端 shipper**：无 OTLP/HTTP/loki-push；日志只在本地
4. **检索接口**：无 query API（`grep`-only）

**最该补的 1-2 件**

1. `crates/amos-ai/src/jsonlog.rs` —— **纯 std** 的 JSON 行格式化器（事件→一行 JSON），与 `logfile.rs` 共用 `RotatingFile`（独立路径 `amos-ai.jsonl`）
2. `crates/amos-ai/src/shipper.rs` —— **可选 HTTP shipper**（loki-push / otlp-http 兼容），带 backoff + 循环缓冲（**默认关闭**，env `AMOS_LOG_SHIPPER` 启用）
3. trace_id：前端 `backend.ts` 每次 invoke 自动生成 `request_id`（UUID），Rust `tracing::Span` 接 `request_id` 字段

**能跑通的最小命令**

```bash
AMOS_LOG_DIR=~/.amos/logs cargo run -p amos-ai
# ls ~/.amos/logs/   → amos-ai.log + amos-ai.jsonl
```

---

## 4. 配置管理（框架）

**已有**

- `docs/ENV_VARIABLES.md`（**机读自动生成**，17 节，47 个 env）—— `scripts/env-doc-gen.mjs` 双向同步门禁（`make lint` 跑）
- `scripts/env-doc-scan.mjs` —— 反向：文档里提到的 env 必须真有 read-site
- 全仓 `AMOS_*` env 经 `env::var` / `env!` / `read_env` / `env_flag` 等 helper 读取（统一入口）
- `crates/amos-tauri/src/lib/settings.ts` —— 前端用户设置（localStorage + amosStore 镜像）
- 全仓 `feature` gate 守门（`scripts/feature-test-scan.mjs` + `feature-surface-scan.mjs`）
- `crates/amos-tauri/Cargo.toml` `amos-pkcs11` —— 敏感字段加密

**完全缺失**

1. **分层覆盖**：当前只有「进程 env」一层，缺系统级（`/etc/amos/config.toml`）+ 用户级（`~/.amos/config.toml`）+ 会话级（`AMOS_SESSION_*`）+ 远端（feature flag service）
2. **热重载**：env 改了必须重启 daemon；前端的 `settings.ts` 已经写盘但无 file watcher
3. **schema 校验**：env 字符串裸读，没有 `Config { … }` 结构体 + JSON schema 约束
4. **feature flag 服务端能力**：所有 flag 是编译期 `#[cfg(feature)]`，没有运行时 server-side flag
5. **密钥处理**：env 直传，缺 KMS / sealed secret / `AMOS_CRED_FILE` 自动 0600 校验

**最该补的 1-2 件**

1. `crates/amos-config/` —— 新 crate，**分层覆盖** + JSON schema 校验 + 热重载（notify crate 可选 feature），与现有 `AMOS_*` env 完全后向兼容
2. `crates/amos-config/feature-flag/` —— 运行时 flag 框架（local JSON + 远端 HTTP poll）

**能跑通的最小命令**

```bash
make lint   # 含 env-doc-gen 与 env-doc-scan
```

---

## 5. 容器编排（❌）

**已有（但不是编排）**

- `.github/docker/ci-android/Dockerfile` —— **CI 工具链镜像**（NDK 26.1 / protoc 28.3 / cargo-ndk 4.1.2 / Rust 1.98，单镜像 70 行 + apt 80 行 + Android SDK 安装 30 行），由 `.github/workflows/container-image.yml` 发布到 GHCR
- `deploy/daemons.json` —— **supervisor 规格**（两个 daemon：amos-ai + amos-translate；不是容器）
- `deploy/android/amos.rc` —— **Android init.rc**（不是容器，是系统服务）
- `deploy/android/.cargo/config.toml` —— linker 模板

**完全缺失**

1. **多服务编排**：开发/演示用 `docker-compose.yml`（amos-ai + amos-translate + System UI + Loki + Grafana）
2. **生产编排**：K8s manifest（Deployment/Service/ConfigMap/Secret/HPA）
3. **健康探针**：daemon 无 `/healthz` HTTP endpoint（只有 gRPC UDS）
4. **资源限制**：compose/K8s 的 `mem_limit`/`cpu_quota`
5. **日志 sidecar**：与第 3 项配对
6. **CI/CD 拉起的 staging 环境**：CI job 一键起 compose stack

**最该补的 1-2 件**

1. `deploy/docker-compose.yml` —— 5 个服务：amos-ai / amos-translate / amos-tauri (System UI) / loki (log) / grafana (查询)
2. `deploy/k8s/{namespace,amos-ai,amos-translate,amos-tauri,loki}.yaml` —— 最小可跑 manifest

**能跑通的最小命令**

```bash
docker build -f .github/docker/ci-android/Dockerfile -t amos-ci-android:dev .
```

---

## 6. 总结表

| 工具 | 用户标 | 本表补完后状态 | 关键新增文件 |
|------|--------|----------------|------------|
| CI/CD 基础 → 完整 | 加 SCA + SBOM + perf 门 | `scripts/{sca,bench-compare}.mjs` + `.github/workflows/sca.yml` |
| 监控告警 框架 → 框架+通道 | `amos-ai/src/notifier.rs`（SMTP+webhook + 静默窗口）| `crates/amos-ai/src/notifier.rs` |
| 日志聚合 ❌ → 框架 | `jsonlog.rs` + `shipper.rs` + trace_id | `crates/amos-ai/src/{jsonlog,shipper}.rs` |
| 配置管理 框架 → 框架+分层/热重载 | `amos-config` crate + feature-flag | `crates/amos-config/`（新）|
| 容器编排 ❌ → 基础 | compose + K8s manifest + `/healthz` | `deploy/{docker-compose.yml,k8s/}` + `amos-ai/src/health.rs` |
