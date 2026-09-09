# Delivery Notes — Android LMK-proxy：per-Activity 生命周期契约（2026-09-09）

> 本文沉淀「amos-android 生命周期权威（LMK-proxy）」这一线的增量。它把原「每包一
> top-Activity 任务」的简化，推进到**带 activity 身份、存活性与 importance 解耦**的可离线
> 测试契约；真容器 ActivityManager 观察者只差设备侧 binder/`dumpsys` 钩子接线（见诚实边界）。

## 改动清单

1. **`proto/android_compat.proto`**
   - `ActivityEventRequest` 增 `activity_id`(3)：空 = 旧 whole-task；非空 = 该事件出自哪个活动身份。
   - `ActivityEvent` 增 `STARTED`(5)：活动进入存活任务（onStart），登记存活、不贬低现顶层。

2. **`amos-android/src/lmk.rs`（proxy，语义解耦）**
   - `Record` 增 `live: BTreeSet<String>`（存活活动身份）+ `top: Option<String>`（当前驱动 importance 的顶层）。
   - **存活性与 importance 解耦**：
     - `STARTED/Resume/Pause/Stop(id)` 登记该活动存活（任务成员）；
     - 只有 `Resume` 把活动升为顶层驱动 importance；**`Stop/Pause` 仅作用于当前顶层**（非顶层 stopped 兄弟不改包 tier）；
     - `Destroy(id)` → `destroy_last`：`live` 空才拆任务；否则任务/表面存活（若拆的是顶层则降为可见占位，绝不误杀仍有兄弟的任务）。
   - 移除旧的 `mark_alive`；新增 `open_task/resume_activity/start_activity/pause_activity/stop_activity`。

3. **`amos-android/src/service.rs`**
   - `dispatch_activity` 按 `activity_id` 分流：空 → `dispatch_whole_task`（legacy 自愈）；非空 → per-activity 折叠。
   - `on_activity`：`Destroy` 仅在任务确已不存在（最后存活活动结束）才发 `WatchLmk` `Destroyed`/拆 `legacy` 表面。
   - 12 处 `ActivityEventRequest` 构造补 `activity_id`（含 amos-ai 2 测试、amos-android e2e）。

4. **`amos-android/src/activity_observer.rs`（新，真容器观察者的离线核心）**
   - `activity_id(component, instance)` → 稳定 `"{component}#{instance}"`（`activity_id_parts` 可拆回）。
   - `FoldingObserver`（每包）：onStart→`STARTED`；顶层 Resume/Pause/Stop；onDestroy→`Destroy`；非顶层 Stop/Pause 不转发（双保险：observer 保守 + proxy 门控）。

5. **`crates/amos-android` 其余（同会话，旁支）**
   - `manager.rs`：图标缓存由伪 FIFO 修正为**真 LRU**（命中刷新 recency、逐出最近未用）+ capacity 0 不缓存。
   - `amos-tauri`：`watch_backoff` 共享退避（telephony / android_lmk / telemetry_spy 三处长连 watch 统一“连上回落 base、失败封顶翻倍”）；`AndroidApp` 生命周期徽标 + recents 状态点 + “已在运行不重复启动 + lmk-surface 实时刷新”。
   - `Shell.svelte`：LMK watcher + 周期对账 parity。
   - 这些 UI/桥改动在 README 功能索引可见，本文以 amos-android 内核为主线。

## 验证
- `cargo test -p amos-android` → **71 单测 + 1 真 UDS e2e**（含 activity_observer **6**、per-Activity 折叠 2、adopt/self-heal、stopped-sibling 关键用例）

> **审计补全（同会话 2026-09-09）**：修正 `FoldingObserver` 一处语义漏洞——**顶层自身 `onStop` 曾因
> `top()` 在活动置为 `Stopped` 后返回 `None` 而被丢弃**（`observe` 只在 `top()==id` 时转发），导致
> 单个前台 Activity 退到后台时包永远停在 `Pause→Visible`（受保护）、无法降到 `Background` 被 LMK
> 回收。现改为：捕获更新前的 `was_top`，**顶层 Stop 无论其后再无可见活动都照发 `Stop`**，同时保留
> 「非顶层 stopped 兄弟不降级仍在顶层的活动」的抑制。新增 2 单测
> （`stopping_the_foreground_top_backgrounds_the_task` / `top_stop_while_a_sibling_is_still_resumed_is_suppressed`）。
- `cargo fmt --check`、`cargo clippy -p amos-android --all-targets -D warnings` 干净
- `cargo check -p amos-ai --tests`、`cargo check -p amos-tauri --lib`（对重生成 proto 含 `STARTED`）通过
- 文档：`docs/lmk-proxy.md` §7/§8 同步

## 诚实边界 / 遗留
- **proxy 语义与折叠器已离线锁定，但真机喂入仍是 seam**：真正把 ActivityManager 活动回调
  （binder / `dumpsys activity`、`topResumedActivity`/task 归属、实例计数）喂进
  `activity_observer::FoldingObserver` 的读取层未接线，需真机 bring-up 端到端验收。
- 顶层销毁后剩 stopped 兄弟时 proxy 降为**可见占位**（宁保护不误杀）；若兄弟纯后台，属偏保守方向，已注明。
- no-UI Android 基座 `SurfaceControl` teardown、host thaw→容器真实 surface 唤醒、真机像素层合成仍属后续。
- 未触碰他人未提交的 audio/CI CHANGELOG 条目。
