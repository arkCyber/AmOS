# 开发与运维（devops）

> 本页是 `crates/amos-notifier`（**§3 告警**）与 `crates/amos-config`（**§4 配置**）的运行手册。
> 这两个 crate 的 `Cargo.toml` 与 README 从写下那天起就引用本页的 §3 / §4，而本节在此之前
> **并不存在**（`docs-link-scan` 报的就是这个）—— 现在把它补上。
>
> **纪律**：只写**代码里真的存在**的东西；每个开关都给出它的读取点，凡是"计划中 / 未实现"的
> 一律进 §6。一条被文档承诺、而代码里没有对应的开关，比一个没写进文档的开关更坏 ——
> 运维改了它、没有任何反应，然后判定"这个功能是坏的"（`scripts/env-doc-scan.mjs` 的存在理由）。

---

## 1. 范围

| 覆盖 | 不覆盖 |
|---|---|
| 告警分发（`crates/amos-notifier`） | Android 设备侧的 bring-up（见 [`device-bringup-checklist.md`](./device-bringup-checklist.md)） |
| 分层配置 / 热重载 / 运行时 feature flag（`crates/amos-config`） | CI 流水线（见 [`.github/workflows/`](../.github/workflows/)） |
| 用现有脚本起停守护进程与查健康（§2） | 发布打包（见 [`release-artifacts.md`](./release-artifacts.md)） |

---

## 2. 运行守护进程

本仓的做法是**脚本即接口**（每个 Make 目标都只是脚本的薄包装）：

| 命令 | 脚本 | 做什么 |
|---|---|---|
| `make run-backends` | `scripts/run-backends.sh` | 前台起后端集合 |
| `make supervise` | `scripts/supervise-backends.sh` | 带重启预算的监督循环（`crates/amos-supervisor`） |
| `make health` | `scripts/health-backends.sh` | 打一次健康探针并打印读数 |
| `make sup-smoke` | `scripts/supervisor-smoke.sh` | 监督链路的冒烟（离线） |

---

## 3. 告警（`amos-notifier`）

### 3.1 等级与节流

| 等级 | 语义 | 抑制窗口 | 限速 |
|---|---|---|---|
| **P0** | 立即有人响应（关键服务宕机） | 30 s | **不限速** |
| **P1** | 当班响应（部分功能退化） | 5 min | 1 条/秒/通道 |
| **P2** | 营业时间响应（预警） | 1 h | 1 条/10 秒/通道 |

窗口内的重复告警**合并计数**，不是丢弃：运维看到的是"这 5 分钟触发了 23 次"，
而不是 23 条 spam（`src/throttle.rs` 的状态机 + `src/metrics.rs` 的 per-channel 计数）。

### 3.2 通道与失败语义

三个 `Channel` 实现，全部**纯 std**：`WebhookChannel`（HTTP/1.1 POST JSON）、
`SmtpChannel`（RFC 5321 子集：EHLO/MAIL/RCPT/DATA/QUIT）、`StdoutChannel`（stderr）。

- **一次发送失败永不 panic**：记 `failed` 计数、让下一个通道继续试，
  由 `DispatcherBuilder::with_stderr_fallback(true)` 保证"所有通道都失败时还有一行 stderr"
  —— 系统日志是运维**永远读得到**的兜底。
- 读数经 `Dispatcher::metrics()` 取（`sent` / `dropped` / `failed`）。

### 3.3 开关注入点

| 环境变量 | 取值 | 读取点 |
|---|---|---|
| `AMOS_NOTIFIER` | `1` / `true` / `yes` / `on`（大小写无关）⇒ 装 notifier sink；**任何其它值不 arm**（含 `tru` / `2`） | `crates/amos-ai/src/notifier_sink.rs`（`notifier_sink_from_env`） |
| `AMOS_NOTIFIER_WEBHOOK` | 逗号分隔的 URL 列表；空项与全空白项被 trim 掉 | 同上 |

### 3.4 边界（读这段可以省下一次排障）

- **`https://` 在构造期被拒绝**：纯 std 没有 TLS，`WebhookChannel::try_new` 明确返回 `Err`
  而不是静默降级。
- **`WebhookChannel::new` 对非法 URL 会 `panic!`** —— 那是**启动期误配置**的有意契约
  （带 `#[allow(clippy::panic)]`，见 crate 根注释）。要可恢复的路径请用 `try_new`
  （从 `amos-config` 读出来的动态值就该用它）。
- `set_read_timeout` / `set_write_timeout` 失败时**上报并继续发送**，不静默：没有超时的
  `read()` 可能无界等待，而拒绝发送等于丢掉唯一的告警通路；两种代价都写在那里。

---

## 4. 配置（`amos-config`）

### 4.1 四层与优先级

`Layer` 枚举的四个变体，**后者覆盖前者**：

| 顺序 | 变体 | 默认位置 | 覆盖它的开关 |
|---|---|---|---|
| 1（最低） | `Layer::SystemFile` | `/etc/amos/config.json`（macOS 为 `/Library/Application Support/amos/config.json`，Windows 为 `%ProgramData%\amos\config.json`） | `AMOS_CONFIG_SYSTEM` |
| 2 | `Layer::UserFile` | `~/.amos/config.json` | `AMOS_CONFIG_USER` |
| 3 | `Layer::Env` | 进程环境 | —— |
| 4（最高） | `Layer::Remote` | 由嵌入方提供 fetcher | —— |

键的归一化是双向的：`amos.ai.port` 与 `AMOS_AI_PORT` 是同一次查找
（`.` ↔ `_`，`amos.` 命名空间是 `AMOS_` 的环境拼法）。

> **边界（写下来免得当成 bug）**：归一化**不是双射**。`_` 同时被用作"段分隔符"，
> 所以**段内带 `_` 的键**（例如 `amos.flags.new_checkout`）与它的环境拼法
> **必然**都归一到同一个键，没有任何规则能把它们分开。需要往返恒等时，键的**段内不要用
> `_`**（`amos.hotcorners` 可以，`amos.flags.new_checkout` 不行）。

### 4.2 拒绝而不是透传

`ResolverBuilder::schema(key, Schema)` 注册后，**违反 schema 的值被拒绝**（`Err`），
不会悄悄传给下游 —— 这一条有负控单测（`schema_violation_is_refused_not_silently_passthroughs`）。

### 4.3 可解释性与审计

- `Resolver::explain(key)` 打印**每一层**对同一个键的贡献，回答"这个值为什么是这个值"。
- `AuditLogger::open(path)` 是 append-only 变更日志；**路径由嵌入方给**
  （工作区约定 `~/.amos/config-audit.jsonl`）。目录创建失败会**点名目录**地告警，
  而不是等后面报成一句"写文件失败"。

### 4.4 热重载

- `reload::Worker::spawn(interval)` 起后台线程，每次只调 `tick()`；
  `Worker::new(resolver)` 是 opt-in —— `Resolver::standard()` **不会**自动起线程。
- 间隔从 `reload::interval_from_env()` 取：读 `AMOS_CONFIG_RELOAD_SECS`，
  **默认 60 秒**；非法值 / 负数 / `0` 一律被拒并回报，**不会**变成零间隔的忙循环。

### 4.5 运行时 feature flag

- **fail-closed**：未知键一律 `false` —— 调用方打错字不会意外开门。
- 本地文件：`FeatureFlagSet::from_local()` —— `AMOS_FEATURE_FLAGS_FILE` 非空则用它，
  否则 `~/.amos/feature-flags.json`；文件缺失 / 损坏一律**空集**。
- 进程环境：`AMOS_FLAG_<UPPER_SNAKE>`（小写化并把 `_` 换成 `.`）。
- 两个**故意划下的**命名边界：① `Resolver::feature_flags()` 只认 `amos.flags.` 前缀，
  `amos.ai.port` 这类普通配置键**永远**不会变成旗标；② 远端规则**覆盖**本地规则
  （中心可以把一个被本地误开的旗标关掉）。

---

## 5. 健康与验证

```bash
cargo test -p amos-notifier -p amos-config            # 两个 crate 的单测 + 集成
cargo clippy -p amos-notifier -p amos-config --all-targets -- -D warnings
node scripts/rust-panic-scan.mjs                      # P0-1：每个 crate 根都要 deny 三条 lint
node scripts/rust-discard-scan.mjs                    # Power of 10 #7：静默丢弃（棘轮）
node scripts/rust-unwired-scan.mjs                    # 文档化能力零调用者（棘轮）
node scripts/env-doc-scan.mjs                         # 文档里的每个 AMOS_* 都必须有读取点
node scripts/docs-link-scan.mjs                       # 本页所引用的相对链接必须存在
```

---

## 6. 本页**故意不写**的东西

以下是"计划中 / 未实现"，写进运维手册就等于承诺一个不存在的开关：

- **日志聚合的 HTTP shipper**：无 `AMOS_LOG_SHIPPER` 读取点（历史缺口表 `DEV_OPS_INVENTORY_20260918.md` 里把它写成可选能力，那是**当时的目标**，不是今天的接口）。
- **会话级配置层**：`Layer` 枚举里只有四个变体，没有"会话级"这一层。
- **远端 feature flag 的 HTTP 拉取**：`Worker::with_remote_fetcher` 收的是一个**闭包**，
  本仓不含 HTTP 客户端实现 —— 取远端是嵌入方的活。
- **容器编排 / 声明式部署**：见 `DEV_OPS_INVENTORY_20260918.md` 的 ❌ 段。

---

## 相关

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) —— crate 全景与依赖方向
- [`ENV_VARIABLES.md`](./ENV_VARIABLES.md) —— 环境变量的机器可读清单
- `crates/amos-notifier/README.md` · `crates/amos-config/README.md`
