# AmOS — 显式状态机索引

> 状态机是安全关键系统的核心。**任何"if state == ..."**的内联判断都应被视为潜在缺陷 —
> 必须有显式状态机 + 转移函数 + 类型化错误。
>
> 本表登记所有已显式建模的状态机,作工程纪律的可追溯依据。
>
> 状态:**已审计**(2026-09-15)

---

## 形式化要求

任何安全关键状态机应满足:

1. **显式枚举**:`pub enum XxxState { ... }`,禁止用 `u8`/字符串做状态
2. **类型化错误**:非法转移返回 `enum XxxError { IllegalState { from, event }, ... }`
3. **守卫函数**:每个 `pub fn event(&mut self) -> Result<()>` 都检查前置状态
4. **终态不可逆**:`Terminal` 状态的所有转移都返回错误
5. **不变量测试**:至少一个**全转移矩阵**单测 + 终态闭锁测试

---

## 已建模状态机清单

### 1. `CallSession` — 电话会话

**位置**:`crates/amos-telephony/src/session.rs`

**状态**:
```
        ┌──────┐
        │ Idle │ (parity only; never observed in a real call)
        └──┬───┘
           │ start_outgoing(id, peer, emergency)
           ▼
        ┌────────┐         start_incoming(id, peer)
        │ Dialing│ ◀────┌────────────────────┐
        └──┬─────┘      │                    │
           │ connect()  │     Ringing        │
           ▼            │                    │
        ┌───────────────┴─────────┐          │
        │       Active            │ ◀────────┘
        │                         │   answer()
        └─────┬───────────┬───────┘
              │           │
   end(Local) │           │ end(Failed/Emergency)
              ▼           ▼
           ┌─────────────────┐
           │      Ended      │ (terminal — 所有转移都拒绝)
           └─────────────────┘
```

**事件转移矩阵**:

| from \ event | connect | answer | end | start_recording | stop_recording |
|---|---|---|---|---|---|
| Idle | ❌ IllegalState | ❌ IllegalState | ❌ IllegalState | ❌ IllegalState | ❌ IllegalState |
| Dialing | ✅ → Active | ❌ IllegalState | ✅ → Ended(Local) | ❌ IllegalState | ❌ RecordingForbidden |
| Ringing | ✅ → Active | ✅ → Active | ✅ → Ended(Local) | ❌ IllegalState | ❌ RecordingForbidden |
| Active | ❌ IllegalState | ❌ IllegalState | ✅ → Ended | ✅ → recording=On¹ | ✅ → recording=Off |
| Ended | ❌ IllegalState | ❌ IllegalState | ❌ IllegalState | ❌ IllegalState | ❌ RecordingForbidden |

¹ 仅当 `!emergency`

**录音子状态机**(嵌套):
```
Off ── start_recording ──▶ On
On ── stop_recording ──▶ Off
On ── provider error ──▶ Failed
Failed ── start_recording ──▶ On (retry)
```

**不变量**:
- `Ended` 终态不可逆
- 录音在 `Ended` 时**强制为 `Off`**(防止录音活过通话)
- 紧急号码(110/112/911)录音**硬拒绝**(`RecordingForbidden`)
- `EndedReason::Emergency` 仅可由紧急通话结束产生

**测试**:`amos-telephony/src/session.rs` 含**全转移矩阵 + 终态闭锁 + 紧急号拒绝录音**

---

### 2. `ActivityState` — Android 应用生命周期

**位置**:`crates/amos-android/src/lmk.rs`

**状态**:`Foreground` / `Background` / `Cached` / `Frozen` / `Tombstone` (5 态)

**事件**:`Touch` / `Background` / `MemoryPressure` / `LMKDecision` / `HostAction` ...

**不变量**:
- `Tombstone` 终态不可逆
- `LMKDecision::ForceStop` 必须经过 governor(防越权)
- `Frozen` → 显式 `Thaw` 才能回到 `Foreground`

---

### 3. `ScreenState` — 屏幕开关

**位置**:`crates/amos-display/src/spec.rs`

**状态**:`On` / `Off` (2 态)

**不变量**:
- 写入必须经 `scree_state_set` (有审计)
- 读取必须经 `screen_state_get`(可被多消费者读)
- `On → Off` 触发 `IdlePolicy` 计时

---

### 4. `IdlePolicy` — 自动息屏

**位置**:`crates/amos-display/src/idle.rs`

**状态**:`ScreenOn` / `Idle` / `SleepPending` / `Sleeping` (4 态)

**事件**:`UserActivity` / `TimeoutReached` / `ChargingStarted` / `CallStarted` ...

**不变量**:
- 充电时延长超时(`IdlePolicy::timeout_for(charging=true)`)
- 通话时**保持唤醒**(直到挂断)
- `Sleeping` 终态需 `UserActivity` 唤醒

---

### 5. `LinkHealth` — 机器人中间件健康

**位置**:`crates/amos-link/src/service.rs`

**状态**:`Unknown` / `Healthy` / `Degraded(reasons)` (3 态)

**不变量**:
- `Unknown` 是诚实未观测,**不等于** `Healthy`
- `Degraded(reasons)` 携带**具体原因**(可枚举)
- 由 `published/delivered/dropped/blocked/decode_errors` 派生

---

### 6. `GenerationPool` 许可状态

**位置**:`crates/amos-ai/src/pool.rs`

**状态**:`Available(capacity)` / `Saturated` / `WaitTimeout` (3 态)

**不变量**:
- 容量 `NonZeroUsize`(0 槽位**不可表示**)
- RAII `PoolPermit` 任何路径**恰好归还一次**(tokio `OwnedSemaphorePermit`)
- `in_flight() + available() == capacity()` 由结构保证

---

### 7. `ResponseCache` 状态

**位置**:`crates/amos-ai/src/cache.rs`

**状态**:`Disabled` / `Enabled(entries, hits, misses)` (2 态)

**不变量**:
- `hits + misses == lookups`(锁定不变量)
- 超限**拒绝**而非截断
- 上游错误**绝不缓存**

---

### 8. `BreakerState` — 熔断器

**位置**:`crates/amos-ai/src/breaker.rs`

**状态**:`Closed` / `Open(cooldown_remaining)` / `HalfOpen(probing)` (3 态)

**不变量**:
- 失败阈值 `AMOS_BREAKER_FAILS` 触发 `Closed → Open`
- 冷却 `AMOS_BREAKER_COOLDOWN_SECS` 后 `Open → HalfOpen`
- 探测占用时**不编造**时间(用 `now` 显式参数)

---

### 9. `RadioState` — 飞行模式

**位置**:`crates/amos-radio/src/lib.rs`

**状态**:`Normal` / `BluetoothOnly` / `Airplane` / `WifiOnly` (4 态)

**不变量**:
- `Airplane` 级联:Wi-Fi + BT + Cellular 一并断
- `Airplane` 退出按反向顺序恢复
- 状态广播上 wire(`get_status.radio_state`)

---

### 10. `RecorderStatus` — 录音状态

**位置**:`crates/amos-telephony/src/session.rs`(嵌套)

**状态**:`Off` / `On` / `Failed` (3 态)

**不变量**:
- 仅 `CallState::Active && !emergency` 时才能转 `On`
- `Failed` 可重试 → `On`
- `On` 必须由 `Off` 或 `Failed` 转入

---

### 11. `AppState` — 前端应用生命周期

**位置**:`crates/amos-tauri/frontend-ts/src/svelte/Shell.svelte` (Svelte)

**状态**:`Hidden` / `Background` / `Foreground` / `Recents` (4 态)

**事件**:`open` / `close` / `background` / `foreground`

**不变量**:
- `Hidden` 后台进程不被回收
- `Background` 可被 LMK 回收(内存压力)
- `Recents` 列表只显示过去 24h

---

### 12. `RagIndexState` — RAG 索引状态

**位置**:`crates/amos-vector-db/src/index.rs`

**状态**:`Uninitialized` / `Building` / `Ready(segments, dim)` / `Stale` (4 态)

**不变量**:
- `Ready` 后只允许 `Stale → Building → Ready`(增量)
- 嵌入器变化触发 `Stale`
- `Uninitialized` 不接受检索

---

## 待建模(已识别为状态机但内联)

| 模块 | 当前状态 | 建议 |
|---|---|---|
| 前端 `InterpApp` 同传会话 | 用 `running`/`ended` 布尔 | 建议:显式 `enum` |
| 前端 `NotesApp` 编辑器 | 已有(REQ-A65) | ✅ |
| 前端 `AlarmClock` | 已有 `alarmsReducer` | ✅ |
| 前端 `Timer` | 已有 `timerReducer` | ✅ |
| 前端 `Stopwatch` | 已有 `stopwatchReducer` | ✅ |

---

## 测试覆盖

每个状态机至少有:
1. **全转移矩阵**:每个 `(state, event)` 组合被断言
2. **终态闭锁**:每个终态 + 任意事件 ⇒ 错误
3. **不变量测试**:如 `in_flight + available == capacity` / `hits + misses == lookups`

---

## 残余风险

- **跨进程状态同步**:`CallSession`(System UI ↔ daemon)通过 `Watch` 事件流同步,可能丢失更新
- **重启恢复**:`SessionManager` 持久化历史,但活跃会话不持久化 ⇒ 重启即丢失"通话中"状态
- **时钟漂移**:`TimeoutReached` 用 `Instant`,不挂钟对齐 ⇒ 跨时区设备时钟跳变可能误触发

---

## 自动校验

```bash
$ cargo test -p amos-telephony --lib session::tests
# (含转移矩阵)

$ cargo test -p amos-android --lib lmk::tests
# (含 ActivityState 全转移)

$ cargo test -p amos-display --lib
# (ScreenState + IdlePolicy)

$ cargo test -p amos-ai --lib -- pool::tests cache::tests breaker::tests
# (GenerationPool / ResponseCache / BreakerState)
```
