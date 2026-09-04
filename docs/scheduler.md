# AmOS 后台任务调度 + 唤醒对齐领域内核（Alarms/Doze 合规）

**日期**: 2026-09-04 · **范围**: `crates/amos-scheduler`（领域内核）
**关联**: `docs/bottom-layer-os-audit.md` §3.P2 #10/#12；`FUNCTIONAL_GAP_ANALYSIS.md` §二.25（"无后台任务调度器"）。

> 本文回答审计最后一块大空白：AmOS 有了节能决策（`amos-power`）和进程模型（`amos-applife`），却**没有一个地方回答"这段后台活现在能不能跑、下次啥时候唤醒"**。`amos-scheduler` 就是那个 **纯 `std`、平台无关的后台任务调度 + 唤醒对齐内核**：注册 AlarmExact / Deferred 作业、按 [earliest,latest] 窗口、**Doze/充电/维护窗门控**、**批量合并（对齐）**与 **next_wake 答案**。绑到真 `AlarmManager`/`JobScheduler` 是调用方 seam。

---

## 1. 设计意图

真实移动 OS 的核心省电手段之一是**把"可延后的后台活"尽量推迟并对齐**，而不是每件小事都唤醒设备。这需要两层：
1. 判断"现在能不能跑"（Doze/充电/维护窗门控）；
2. 决定"何时必须唤醒一次跑精确闹钟"（对齐后减少唤醒次数）。

内核以**确定性纯函数**建模（caller 提供 `now` 的单调 tick + `PowerState`），无墙钟、无 I/O，离线可测。

```text
  caller 注册作业           OS 时钟 / doze 状态        caller 触发
  register(AlarmExact|Deferred) ─▶ Scheduler ──due(now, power)──▶ Vec<JobId>
      earliest/latest 窗口           │                          然后 complete(id)
                                    ▼
                           next_wake(now) → 睡到哪个 tick
```

## 2. 作业类型（Android alarm 分类法）

| 类型 | 语义 | 何时跑 | 是否给 next_wake |
|---|---|---|---|
| `AlarmExact` | 用户可见闹钟/提醒 | `now >= earliest`（idle 期是否放行由 caller 定，Android 对 alarm app 仍有节奏） | ✅ 返回下一次需唤醒的 tick |
| `Deferred` | 后台同步/清理/非紧急推理 | `earliest<=now<=latest` **且** `PowerState.deferred_runnable()` | ❌ 不给保证唤醒 |

## 3. 门控 `PowerState`

```text
deferred_runnable():
    charging        → true          （有充电器，后台活便宜）
    否则 dozing?  → maintenance_open → true    （维护窗内合并跑）
                    → false          （idle 无窗 → 压住，Doze 合规）
    否则（非 doze） → true
```

`dozing/maintenance_open/charging` 由 OS / `amos-power` 的 `throttle_background` 喂进来。

## 4. 对齐与唤醒

- `due(now, power)`：AlarmExact 先返回（用户可见优先），随后把**窗口覆盖 now 且被门控放行**的 Deferred **一次性批量**返回——所有可延后活在一个维护窗里一起跑 = 合并对齐、少唤醒。
- `next_wake(now)`：返回下一个 `earliest > now` 的 **AlarmExact**（仅精确闹钟给保证唤醒；Deferred 不保证），caller 可据此 `setExactAndAllowWhileIdle` / 睡到该 tick。
- `register/cancel/complete/counts`。

## 5. Crate 结构

| 模块 | 内容 |
|---|---|
| `spec` | `JobId`、`JobType`（AlarmExact/Deferred + key）、`PowerState` + `deferred_runnable()` |
| `scheduler` | `ScheduledJob`（`alarm/deferred/new` 校验窗口）+ `Scheduler`（register/due/next_wake/cancel/complete/counts） |
| `error` | `SchedulerError::InvalidWindow` |

纯 `std`，无依赖。`cargo test -p amos-scheduler`（7 lib + 1 集成）。

## 6. 验证

```bash
cargo test -p amos-scheduler
cargo clippy -p amos-scheduler --all-targets -- -D warnings
cargo fmt -p amos-scheduler --check
```

集成测试 `tests/doze_cycle.rs`：idle 期精确闹钟在 t=300 触发（`next_wake=300`），两个 Deferred 被压住，维护窗打开后一次批量跑掉。

## 7. 下一步（调用方 seam）

- **已提供的装配（daemon 侧，2026-09-04）**：`amos_ai::governor::ResourceGovernor` 已把本内核与 `amos-power`（节能决策）+ `amos-applife`（冻结/回收）合成一个**离线可测的闭环**：低电 → PowerSave → 冻结后台 App + 压住 Deferred；恢复/充电 + 维护窗 → 解冻 + 跑合并批。System-UI / per-app 宿主可直接挂它（`register_app`/`background_app`/`schedule` + 周期 `observe`）。
- **真机/daemon 接线**：把 `Scheduler` 挂进 System UI / `amos-ai`，用 `PowerState`（来自 Doze 广播 + `amos-power` 的 `throttle_background`）驱动 `due`；Deferred 结果喂后台任务（同传/ASR/模型刷新），`next_wake` 喂 Android `AlarmManager`（exact）与 `JobScheduler`（deferred 维护窗）。
- **与 `amos-applife` 联动**：`Cached`(墓碑) 进程的后台作业应标记 Deferred、且其进程被回收时不注册精确闹钟（#10/#12 的"调度 + 生命周期"闭环，`ResourceGovernor` 已体现该编排）。
