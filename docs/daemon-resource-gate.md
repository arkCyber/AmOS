# 守护进程资源门：生成准入池 + 响应缓存（REQ-A43 / REQ-A44）

> 状态：已实现并有测试锁定
> 日期：2026-09-11
> 关联：`docs/AEROSPACE_SOFTWARE_AUDIT.md`（Power of 10 #2/#7）、`docs/FUNCTIONAL_GAP_ANALYSIS.md` §35、`docs/TRACEABILITY_MATRIX.md` REQ-A43/A44

## 1. 动机（审计发现）

对 amos-ai 守护进程按航宇级标准复审时发现两处真实缺口：

1. **`AMOS_MAX_SESSIONS` 已写未接线**：`config.rs` 声明并校验 `max_concurrent_sessions`
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
  metadata 名诚实追加 `+cache`，`get_status` 可见。
- **默认关闭**（`AMOS_RESPONSE_CACHE=1` 开启）：缓存改变可观测延迟（命中近零 TTFT），
  必须是运营者的明确选择。`BackendStats` 纯透传——装饰器不伪造任何遥测（P0-3 纪律）。

## 4. 验证

- `pool::tests` 8 例、`cache::tests` 17 例（含并发计数一致性）、server 集成 2 例
  （饱和拒绝不分配会话 + 释放后可复用 + 审计；缓存命中重放逐 token 一致）。
- `cargo test -p amos-ai` **245 例** lib + 全部集成测试；`cargo test --workspace`
  **134 个测试二进制全绿（EXIT=0）**；`clippy --all-targets -D warnings`、`fmt --check` 干净。

## 5. 诚实边界

- 缓存为**进程内、非持久化**：守护进程重启即空（文档与代码一致，无跨重启承诺）。
- 池是守护进程级准入，不取代 `RateLimiter` 的每客户端配额——两者互补（速率 vs 并发）。
- `get_status` 目前经 backend 名（`+cache`）暴露缓存存在；池/缓存的计数进 wire proto
  属后续增量（本轮不动 proto，避免波及全部下游）。
