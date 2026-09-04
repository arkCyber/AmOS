# AmOS 应用生命周期领域内核（前台/后台/墓碑/回收）

**日期**: 2026-09-04 · **范围**: `crates/amos-applife`（领域内核）
**关联**: `docs/bottom-layer-os-audit.md` §3.P2 #8；`FUNCTIONAL_GAP_ANALYSIS.md` §二.22（"无应用生命周期管理"）。

> 本文回答审计最大的一块空白之一：AmOS 前端"App"目前**共用一个 WebView 进程**，没有一个 per-app 的**前台/后台/墓碑/冻结/进程回收**模型。`amos-applife` 就是那个**平台/传输无关的领域内核**——纯 `std` 状态机 + 注册表 + **LMK-proxy 回收选择器**，把"进程模型"真正立起来，运行时（真 per-app 进程宿主 / 内存压力 feed）是调用方 seam。

---

## 1. 设计意图与定位

AmOS 需要一个跟真实移动 OS 同构的"每 App 一个进程 + 前台优先级 + 低内存回收"的抽象，而不是把一切塞进一个 WebView。这层**内核**与 `amos-wm`（窗口 z 序）互补但不重复：`amos-wm` 管**窗口/焦点**，`amos-applife` 管**进程生命周期与可被杀性（oom 语义）**。

照 AmOS 惯例，先落**纯 `std` 领域内核 + 测试**；真正把它接到"每 App 进程/线程"或 Android `lmkd`/AMS 的接线留 seam。

```text
        launch              用户离开(失焦)         省电/内存压力         回收
  Stopped ────────▶ Foreground ───────▶ Background ───────▶ Cached ────────▶ (kill/Stopped)
     ▲                │   ▲                  │  ▲ (wake/relaunch)
     └──── cheap resume┘   └── Visible ───────┘
        (保存态)              └── ForegroundService（播放/音频，保护态，不可回收）
```

## 2. Crate 结构

| 模块 | 内容 |
|---|---|
| `spec` | `AppId`（newtype）、`AppState` 六态 + 重要性 `rank()`（越小越重要）+ 稳定 `key()` |
| `manager` | `AppLifecycle` 注册表：`launch/go_foreground/go_background/freeze(→Cached)/thaw(→Background)/start_service/stop_service/stop(保留态)/kill(丢弃)`，LRU 序号，`counts()`，`reclaim_candidates(budget)` |
| `error` | `LifecycleError::Unknown` / `InvalidTransition` |

纯 `std`、无 I/O、无墙钟，离线确定性。`cargo test -p amos-applife` 无需设备/HAL。

### `AppState` 状态阶梯（importance ladder）
| 状态 | rank | 可否回收 | 含义 |
|---|---|---|---|
| `Foreground` | 0 | 否 | 用户正交互（顶层、聚焦） |
| `Visible` | 1 | 否 | surface 仍可见（分屏/暂停浮层）但失焦 |
| `ForegroundService` | 2 | 否 | 用户可感知后台服务（播放媒体/音频/通话） |
| `Background` | 3 | **可** | 运行但不可见，可被冻结 |
| `Cached`（墓碑） | 4 | **可** | 冻结、状态已存、无任务；**回收首选** |
| `Stopped` | 5 | — | 已杀但保留保存态（廉价重开） |

- `is_protected()` = rank < Background（Foreground/Visible/ForegroundService）——**永不回收**。
- `is_reclaimable()` = Background | Cached。

## 3. LRU 排序 + 回收（LMK-proxy）

每次状态变更都 bump 一个单调 `seq`（`move_to`），记录 `last_active`。`reclaim_candidates(budget)` 在**可回收态**中选：**先 Cached 后 Background**（rank 大的先杀），同档内**最久未用（seq 最小）先杀**；绝不碰保护态，`Stopped` 非运行不计。确定性、纯由记录决定，调用方拿回 victims 再 `kill`。

```text
[内存/省电压力]
    │  reclaim_candidates(budget)
    ▼
 Cached(最旧) → Cached → Background(最旧) → Background    （绝不：Foreground/Visible/ForegroundService）
```

## 4. 验证

```bash
cargo test -p amos-applife                  # 9 lib + 3 集成
cargo clippy -p amos-applife --all-targets -- -D warnings
cargo fmt -p amos-applife --check
```

集成测试 `tests/lifecycle.rs`：多进程场景 A/C 冻结、B 后台 → 回收顺序 `[A, C, B]`（Cached 旧→新 再到 Background）；保护态从不被回收；stop 保留态可廉价 relaunch。

## 5. 下一步（调用方 seam）

- **运行时宿主**：把每个 System-UI App / 旧 APK 映射成一个 `AppId`，真正独立进程/独立 WebView 时驱动状态迁移；用户切 App / 熄屏/回前台时调 `go_background/go_foreground`。
- **压力 feed**：由 `amos-power` 决策或系统 `lmkd` 信号触发 `reclaim_candidates` → 对 victims 做 `freeze`(省电)/`kill`(内存)。
- **Doze/唤醒对齐联动**：Cached=墓碑期间不调度后台任务（与后台任务调度器/唤醒对齐共同落地，见 `bottom-layer-os-audit.md` §3.P2 #8/#10）。
