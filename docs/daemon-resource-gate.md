# 守护进程资源门：生成准入池 + 响应缓存 + 后端熔断（REQ-A43 / REQ-A44 / REQ-A131）

> 状态：已实现并有测试锁定
> 日期：2026-09-11（2026-09-12 增补 REQ-A131 熔断器）
> 关联：`docs/AEROSPACE_SOFTWARE_AUDIT.md`（Power of 10 #2/#7）、`docs/FUNCTIONAL_GAP_ANALYSIS.md` §35、`docs/TRACEABILITY_MATRIX.md` REQ-A43/A44/A131、`CODE_AUDIT_REPORT.md`（"实现断路器模式"）

## 1. 动机（审计发现）

对 amos-ai 守护进程按航宇级标准复审时发现两处真实缺口：

1. **`AMOS_MAX_SESSIONS` 已写未接线**：`config.rs`（**注：该文件已于 REQ-A97 整体删除**——它是无人构造的死代码，
   旋钮当时并无实现点；真正的配置面是各模块 `from_env` + `cli.rs` USAGE）声明并校验 `max_concurrent_sessions`
   （env `AMOS_MAX_SESSIONS`，默认 16），但 `server.rs` 从未读取——守护进程级**并发生成无上限**
   （`active_sessions` 只是无界计数器）。`RateLimiter` 只限每客户端请求速率与小时 token 配额，
   不限制同时执行的生成数。N 个客户端可并发启动无上限的 NPU/GPU 生成，在电池设备上是
   资源耗尽失效模式（Power of 10 #2「所有循环/资源静态有界」）。
2. **相同推理请求从不复用**（`cache.rs`/`pool.rs` 两份审计文档点名缺失）：相同的
   `(model, prompt, context, max_tokens)` 每次都付全价推理能量。

## 2. 生成准入池（`crates/amos-ai/src/pool.rs`，REQ-A43）

- **容量类型编码**：`NonZeroUsize`——"零槽位池"不可表示；`try_new(0)` 硬错，绝不静默钳位。
- **fail-fast 为默认**：饱和时立刻拒绝（`PoolError::Saturated`，确定性）；可选有界等待
  `AMOS_GEN_POOL_WAIT_MS`（`WaitTimeout { waited }`），两种拒绝在计数与审计里**可区分**。
- **RAII 许可**：`PoolPermit` 包 tokio `OwnedSemaphorePermit`（'static，可移入流任务），
  任何退出路径（卡片路径、客户端断开、推理错误、正常完成）**恰好归还一次**。
- **诚实可观测**：`(acquired, rejected_saturated, rejected_timeout)` 单调计数；
  `in_flight()` 永不超过 `capacity()`（测试以 12 任务并发锁死）。
  `GenerationPool::snapshot()` **单次** `available_permits()` 读取给出 `(in_flight, available)`，
  故 `in_flight + available == capacity` 恒成立——两次独立读可能跨过一次并发 acquire/release
  而报出不可能的拆分（并发采样测试锁定）。
  `get_status.generation_pool` 现把 `capacity / in_flight / available / acquired_total /
  rejected_saturated / rejected_timeout / wait_ms` 上报到 wire（`available + in_flight ==
  capacity` 由池结构保证），Tauri `DaemonStatus.generation_pool` 与前端
  `EngineView.pool` 逐字段镜像。
- **接线**：`stream_chat` 在安全门之后、**任何会话/簿记之前**获取（被拒请求不分配资源）；
  许可移入流任务全程持有。bidi `chat` 在每条 Prompt 生成前获取，饱和时回错误 chunk +
  审计 `Rejected`，连接保持可用（用户可重试）。
- 拒绝经审计 logger 记 `Rejected`，细节含诚实原因（"generation pool saturated (all
  generation slots busy)" / "stayed saturated for Nms"），gRPC 侧映射
  `ResourceExhausted`。

## 3. 响应缓存（`crates/amos-ai/src/cache.rs`，REQ-A44，默认关闭）

- **`ResponseCache`**：有界 LRU + TTL（默认 32 条 / 300 s / 单条 256 KiB），注入式时钟
  （确定性测试），过期/逐出/超限全部可计数（`hits+misses == lookups` 不变量有测试锁定）。
  超限条目**拒绝而非截断**——截断的重放等于对用户撒谎。
- **键 = 后端可见的全部输入**：`(model, max_tokens, prompt, 排序后的每个 context 键值对)`。
  **绝不静默排除**可能影响输出的字段——会话谱系键参与键构造，不同会话的相同 prompt
  是不同键（诚实：响应绝不在可能已分叉的会话间错误共享）。
- **`CachingBackend` 装饰器**：命中→按原 token 序列重放（流式契约不变）；未命中→透传并
  记录；**上游错误（infer 失败或流中途失败）绝不缓存**（绝不缓存部分答案）。
  metadata 名诚实追加 `+cache`，`get_status` 可见（`get_status.response_cache` 另上报
  `enabled / capacity / ttl_seconds / entries / hits / misses / stores / evicted /
  expired / oversized`；关闭时 `enabled=false` 且全部计数为零——绝不伪造成「有一个缓存」）。
- **默认关闭**（`AMOS_RESPONSE_CACHE=1` 开启）：缓存改变可观测延迟（命中近零 TTFT），
  必须是运营者的明确选择。`BackendStats` 纯透传——装饰器不伪造任何遥测（P0-3 纪律）。

## 4. 验证

- `pool::tests` 8 例、`cache::tests` 17 例（含并发计数一致性）、server 集成 4 例
  （饱和拒绝不分配会话 + 释放后可复用 + 审计；缓存命中重放逐 token 一致；
  `get_status` 池指标诚实/`enabled=false` 诚实；缓存启用后 hit/miss/store 计数上 wire）、
  UDS 端到端 `rpc_test::get_status_exposes_live_monitoring_metrics` 断言两块指标随
  `StatusReply` 过线。
- `cargo test -p amos-ai` **247 例** lib + 全部集成测试；`cargo test --workspace`
  **134 个测试二进制全绿（EXIT=0）**；`clippy --all-targets -D warnings`、`fmt --check` 干净。
- 前端：`ai-engine.test.ts` **13 例**（池/缓存解析、缺失=unknown 不伪造、`available` 推导）、
  `tsc --noEmit` 与 `svelte-check` 0 错 0 警。

## 5. 后端熔断器（`crates/amos-ai/src/breaker.rs`，REQ-A131）

`CODE_AUDIT_REPORT.md` §「健康检查和监控」列的 `[ ] 实现断路器模式` 是本仓库**唯一**确认缺失的该项：全仓
grep 无任何 breaker/circuit 实现。动机不是"永不挂死"——每个后端调用**早已**有超时（API 60s / Ollama 10s /
health 5s）——而是**量**：后端下线期间每个请求仍要走满超时，与准入池叠加时**槽位被注定失败的调用占住**。

- **纯状态机 + 显式 `now`**：`CircuitBreaker::{decide, on_success, on_failure, retry_after, snapshot}`。
  无时钟、无 I/O ⇒ 三态（Closed → Open → HalfOpen）策略可离线单测（与 `pool.rs` 同一取向）。
- **装饰器 `BreakerBackend`**：`metadata().name` 加诚实后缀 `+breaker`；`get_stats()` 原样透传（不伪造遥测）。
- **组合顺序（重要）**：`Cache(Breaker(inner))` —— 熔断在缓存**内层**，因此后端断开期间**缓存命中仍可服务**，
  只有真正需要后端的（未命中）生成才被门控。写反了就会把可用的缓存命中一起拒掉。
- **拒绝＝有理由**：`Verdict::Reject { reason, retry_after }`，错误串形如
  `inference backend skipped: circuit breaker open (retry in 30s)`；探测占用中则是
  `probe_in_flight` 且**不编造**剩余时间（`retry_after = None`）。运维能区分"被有意跳过"与"后端报错"。
- **不重试**：只快速失败，不隐藏重发、不产生重复生成；恢复是**一次一个探测**。
- **流结果也计入**：`BreakerStream` 让"流中途出错"记失败、"流正常结束"记成功——半开探测因此才能真的闭合。
- **`health_check()` 不计**：探针是存活信息，不是生成结果（活由池/存活探针负责）。
- **默认开启**：`AMOS_BREAKER=0|false|off|no` 关闭；`AMOS_BREAKER_FAILS`（默认 3）为连续失败阈值；
  `AMOS_BREAKER_COOLDOWN_SECS`（默认 30）为熔断时长。**关闭 = 不在服务路径中**（`get_status.breaker.enabled=false`
  且 `state` 为空串，"我们没在观测"）。
- **可观测**：`get_status.breaker` 上报 `enabled/state/fail_threshold/cooldown_seconds/consecutive_failures/
  openings/rejections/failures/successes`；Tauri `DaemonStatus.breaker` 与前端 `EngineView.breaker` 逐字段镜像，
  AI 设置页显示**状态**与**已被跳过的调用数**（"跳过"与"丢失"必须能区分）。
- **消费端诚实修复（本轮连带发现）**：`+breaker` 让 `engine` 变成 `mock+breaker`，而前端
  `isRealEngine()` 当时比较的是**原始名字**——它会把一个**装饰过的 mock 当成真实引擎**在 UI 上宣称。
  已改为比较**去掉装饰符的 `kind`**（`EngineView.kind`），并加测试锁定：`mock+breaker` **不是**真实引擎，
  `ollama+breaker+cache` **是**。

## 6. 阈值告警（`crates/amos-ai/src/alerts.rs`，REQ-A133）

`CODE_AUDIT_REPORT.md` §「健康检查和监控」列的 `[ ] 添加警告和告警机制`。动机不是"再加一块仪表"，而是**没人该去
读八个块才知道哪里出问题**：熔断状态、池拒绝计数、日志丢字节、降级标志、节流标志、DVFS 失败——每一项**都早已上报**，
缺的只是**一处汇总**。因此告警**全部由已有计数派生**，不引入新埋点。

**规则（6 条，每条点名它读的计数）**

| id | 级别 | 触发条件 | 读的计数 |
|---|---|---|---|
| `breaker_open` | error | 熔断器处于 `open` | `get_status.breaker.state` |
| `log_trail_incomplete` | error | 丢字节 > 0 或写失败 > 0 | `log_sink.lost_bytes` / `write_failures` |
| `engine_degraded` | warn | 请求了真实引擎但模拟引擎在服务 | `degraded` |
| `generations_rejected` | warn | 准入池拒绝数 > 0（含饱和与等待超时） | `generation_pool.rejected_*` |
| `power_throttled` | warn | 电源治理器正在节流 | `energy.cap_inference` / `throttle_background` |
| `dvfs_write_failures` | warn | DVFS 写入失败 > 0 | `governor.dvfs_failed` |

**诚实性规则**

- **健康即空**：规则都不触发时 `alerts` 是**空数组**，UI **不渲染任何东西**——不摆一个"一切正常"的横幅（那会被
  误当成"我们做过体检"）。
- **`active_for` 是"本进程首次看到"**，**不是**"问题存在了多久"：重启即归零，UI 与文档都不得暗示更长的历史。
- **自动清除**：每次 `get_status` 重新求值，恢复的条件**立即消失**（不留过期警报）；再次复发时计时**从零重来**。
- **有理由才有内容**：`detail` 带**具体数字**（如"12 generation(s) were rejected…"），不是"池子有问题"。
- **没有投递**：不邮件、不推送、不打电话。告警只经 `get_status.alerts` 上报，并在**新出现时**记一条 WARN/ERROR
  日志（持续为真的条件**不会**每轮刷屏）——这是报告，不是通知渠道。
- **顺序确定**：error 在前、同级别按 id 排序（`Severity::rank`；**刻意不 derive `Ord`**——派生会按声明顺序把
  warn 排到 error 前面，第 71 轮的端到端测试正是这样抓到的）。
- **未知规则不隐藏**：UI 对不认识的 id **原样显示 id**（连同 daemon 给的 detail），不套一个"未知问题"的模糊标签。

## 7. Unix socket 对端凭据（`crates/amos-ai/src/peercred.rs`，REQ-A141）

socket 文件是 `0700`，但那是**文件系统属性、不是认证**：路径被复制/替换、父目录共享、父目录属 root 时它都拦不住，
也**分不清"我们的 UI"与同一用户下的任意进程**。因此 accept 循环里向**内核**要答案：

- **Linux/Android**：`getsockopt(SOL_SOCKET, SO_PEERCRED)`；**macOS/BSD/iOS**：`getpeereid`。两者都由内核填写，
  对端**无法伪造**。（`std` 的 `UnixStream::peer_cred()` 仍是 unstable，故用 `libc`——它本就在依赖图里。）
- **判定**：同用户 ⇒ 放行；**不同用户 ⇒ 拒绝**（连接**根本不进 tonic**，socket 随 drop 关闭）；问不到 ⇒ 看策略。
- **策略 `AMOS_UDS_PEER`**：`enforce`（默认，拒绝异用户、放行"问不到"）/ `warn`（只记日志，诊断用）/
  `require`（**连"问不到"也拒绝**）；未知取值**记 warn 并用默认**，不偷偷换级别。
- **绝不静默**：启动时打印生效策略与自身 uid；每次拒绝记 warn；"未能校验"也记 warn。

**边界（gap #28 仅部分关闭）**：这是**对端用户认证**，**不是**授权（无按客户端能力校验）、**不是**加密
（UDS 明文）、**不校验 pid**（pid 有竞态且对用户判定无必要）。

## 8. 诚实边界

- 缓存为**进程内、非持久化**：守护进程重启即空（文档与代码一致，无跨重启承诺）。
- 池是守护进程级准入，不取代 `RateLimiter` 的每客户端配额——两者互补（速率 vs 并发）。
- `get_status` 现同时经 backend 名（`+cache`）与 `response_cache` 计数块暴露缓存；池经
  `generation_pool` 块暴露。旧版守护进程缺这两块 ⇒ 消费端（Tauri/前端）报告 `null`
  （unknown），绝不回退成伪造的零值读数。
- **熔断器边界**：不区分错误类别（任何 `infer` 失败都计），故一阵客户端错误（如 HTTP 400）也会熔断；
  阈值与冷却可调、可整体关闭。计数只在**本进程**内（不跨重启持久化，重启即从 Closed 起）。
  它**不重试**、不做指数退避、不区分后端种类。
- **告警边界**：6 条规则是**当前**关心的全部——阈值是硬编码的（没有"每条规则可配阈值"的旋钮，避免一个没人
  实现的可配置性承诺）；`active_for` 重启归零；**没有投递通道**（上表之外没人会被告知）；规则集合被测试锁定
  （`alerts.rs` 的 6 个 id 与顺序都有断言），加规则必须同时加测试与文档。
