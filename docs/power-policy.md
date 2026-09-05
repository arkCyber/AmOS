# AmOS 节能策略调度器 / Energy Governor（电池 · 热 · 前后台联动）

**日期**: 2026-09-04 · **范围**: `crates/amos-power`（领域决策内核）
**关联**: `docs/bottom-layer-os-audit.md` §3.P2 #11 / §2.B；`FUNCTIONAL_GAP_ANALYSIS.md` §二.21/§六（"零散 knob 无闭环调度"）；上游 `amos-sensor`（采样档）+ `amos-profiling`（功耗）。

> 本文回答审计留下的那个空白：AmOS 已有**省电/功耗的能力点**（`SensorManager` 按 `SensorMode` 门控连续采样、`SensorMode` 三档可切、`PowerSource` 计量功耗），但没有一层把这些 **fold 成一个决策**。`amos-power` 就是那层纯 `std` 的**决策内核**：每 tick 读「电量 / 充电 / 温度 / 实时功耗 / 前后台使用」，产出一个 `SensorMode` + 是否 `cap_inference` + 是否 `throttle_background` 的 `Decision`，再推给 `SensorManager` 落地门控。

---

## 1. 为什么做成"纯决策内核 + caller 侧 ticker"

与 `amos-sensor`/`amos-profiling` 一脉相承的 AmOS 惯例：**领域内核传输/平台无关、离线可测**；周期性驱动（tokio task）与真实功耗 HAL 留在调用方。

```text
  battery level / charger / temperature        live board power (PowerSource)
          │                                              │
          └──────────────┬───────────────────────────────┘
                         ▼
          ┌──────────────────────────┐
          │   Telemetry (per tick)   │   + foreground/background usage
          └────────────┬─────────────┘
                       ▼
          ┌──────────────────────────┐
          │  EnergyGovernor::observe │   stateful: 记住上轮 Decision → 迟滞
          │        = decide(...)     │   纯函数规则，确定性、无墙钟
          └────────────┬─────────────┘
                       ▼
          Decision { sensor_mode, cap_inference, throttle_background, reason }
                       │  Decision::apply_to(&SensorManager)
                       ▼
                 amos-sensor 门控落地
```

- **输入是数据不是 trait**：`Telemetry`（`BatteryState` + `power_mw` + `Usage`）→ 决策是**快照的纯函数**，测试直接构造任意状态。
- **迟滞放进规则而非定时器**：低电档用 `power_save_on_level_pct`(进入) / `power_save_off_level_pct`(退出) 的**带宽迟滞**，热档用退出缓冲(`thermal_exit_hysteresis_c`)——`decide(policy, telemetry, current)` 的 `current` 只用于迟滞，值在边界抖动不会让模式来回跳。
- **复用上游类型而非重造**：决策输出是 `amos_sensor::SensorMode`（可直接喂 `SensorManager`），功耗来自 `amos_profiling::PowerSource`（`Telemetry::with_power_from`）。不复制第三个 `mode` 枚举。

## 2. Crate 结构

| 模块 | 内容 |
|---|---|
| `types` | `BatteryState{level_pct, charging, temperature_c}`、`Usage{screen_on, foreground_heavy, inference_active}`、`Telemetry`；`Telemetry::with_power_from(&dyn PowerSource)`（非有限读数→`None`，不采信） |
| `policy` | `Policy`（阈值 + 链式 `with_*` + `normalized` 保序）、`Reason`（封闭枚举，稳定 key）、`Decision{mode, cap_inference, throttle_background, reason}`（`apply_to(&SensorManager)` 推档）、纯规则 `decide` |
| `governor` | `EnergyGovernor`：`new(policy)`/`Default`，`observe(&Telemetry) -> Decision`（携带上轮用于迟滞），`last_decision()`/`mode()` |
| `freq` | CPU/NPU 频率域（纯 std）：`ClusterKind{Little,Big,Prime}`、`Cluster`/`FreqCap`/`FreqPlan`；`cpu_percent`/`npu_percent`（整数百分比）、`plan`/`plan_from_decision`（`Decision.sensor_mode` → 各 cluster+NPU 频率上限）、`cap_khz`。`FreqCap.max_khz: None` = 不设上限（applier 侧=恢复到硬件最高频）。Balanced 不设小核上限以保 UI/电话响应，PowerSave 优先限 Prime→Big→NPU。`FrequencyGovernor`（有状态 DVFS ticker）：`observe(&Telemetry) -> Option<FreqPlan>`，仅当档位真的变化才返回 plan，避免每 poll 重复写 sysfs。`ComposedGovernor`：把 `SensorMode` 每 tick 推进到真实 `SensorManager`（采样门控）并同时返回去抖后的 `FreqPlan`，一行驱动"决策→采样+频率"闭环 |
| `linux`（`feature linux`）| `LinuxFreqGovernor`：把 `FreqPlan` 写到 `/sys/.../cpu{cpu}/cpufreq/scaling_max_freq`（`Some`=设上限，`None`=读 `cpuinfo_max_freq` 恢复上限，避免 PowerSave 限死后无法解除）+ NPU devfreq 节点；tempdir 可测、失败如实回报（`FreqApplyReport`），不 panic |

纯 `std`，依赖仅 `amos-sensor`、`amos-profiling` 领域类型。`cargo test -p amos-power` 无需设备/HAL/网络。

## 3. 默认策略 `Policy::default()`（手机友好档）

| 阈值 | 默认 | 含义 |
|---|---|---|
| `critical_level_pct` | 10% | ≤ 则硬 PowerSave（cap 全部） |
| `power_save_on_level_pct` | 20% | ≤ 则进入 PowerSave（低电） |
| `power_save_off_level_pct` | 30% | ≥ 才退出（迟滞带） |
| `high_power_mw` | 4000 mW | 电池 + 重负载 + 实耗 ≥ 则降到 Balanced |
| `high_temp_c` / `critical_temp_c` | 38°C / 45°C | ≥ 高 → 至多 Balanced；≥ 临界 → PowerSave |
| `thermal_exit_hysteresis_c` | 2°C | 热档退出缓冲 |

`normalized()` 保证 `critical ≤ save_on ≤ save_off`、`critical_temp > high_temp` 恒成立（矛盾输入折叠成有序安全档，不 panic）。

## 4. 决策优先级（最强压力优先，见 `policy::decide`）

1. 临界热 → PowerSave，cap 全部（迟滞退出：需降温 < 临界-缓冲）
2. 临界电量（电池）→ PowerSave
3. 低电（电池）→ PowerSave（进入 ≤ on，退出 ≥ off）
4. 高热（非临界）→ 至多 Balanced，永不 Performance（迟滞退出）
5. 高实耗 + 重负载（电池）→ Balanced
6. 充电 + 凉 → Performance
7. 其余（电池、健康）→ Balanced（前台视窗；后台推理在**熄屏**时标 `throttle_background`）

> `sensor_mode` 权威（落 `SensorManager`）；`cap_inference`/`throttle_background` 是**建议**，供调度方去门控在跑的引擎/后台任务。

## 5. 验证

```bash
cargo test -p amos-power                     # 31 lib + 2 集成
cargo clippy -p amos-power --all-targets -- -D warnings
cargo fmt -p amos-power --check
# CPU/NPU 频率 seam（`feature linux`，tempdir 全流程，含 governor→freq→sysfs 端到端）：
cargo test -p amos-power --features linux
cargo check -p amos-power --features linux
# host 闭环（功耗读数→决策→频率→sysfs，无需设备）：
cargo test -p amos-power --features linux --test closed_loop_linux
# headless 演示（仅打印、不写盘）：
cargo run -p amos-power --example governor_freq
cargo run -p amos-power --example ticker
# 完整 host 演示：功耗模型 + ComposedGovernor（SensorManager 门控 + 去抖 FreqPlan）：
cargo run -p amos-power --example live_governor
```

集成测试 `tests/integration.rs` 用真 `MockSensorProvider` + `SensorManager`：低电 → 决策 `PowerSave` → `apply_to` 后同一 30 FPS 相机被拒（`PowerSaveRate`）；插充电器 → `Performance` 恢复可采。证明决策**真的门控**了 `SensorManager`，不是悬空。`linux::tests::governor_decision_drives_sysfs_frequency_caps_end_to_end` 证明**决策→FreqPlan→`scaling_max_freq` 落地**贯通的：PowerSave 先限小核80%/大核50%/Prime40%/NPU50%，转 `Performance`（uncapped）再按 `cpuinfo_max_freq` **恢复**上限（不会限死后无法解除）。`tests/closed_loop_linux.rs` 再走完整 host 闭环：`BatterySample`(µA×mV)→功耗 mW→`Telemetry`→`EnergyGovernor`→`FrequencyGovernor`→`LinuxFreqGovernor` 写 tempdir。

## 6. 下一步（超出本轮，留给调用方 / 后续）

- **daemon / System UI ticker**：`amos-ai` 或 System UI 起一个周期任务，采样电池/温度/功耗 → `EnergyGovernor::observe` → `Decision::apply_to` + 据此 gate 引擎/后台任务；把 `Decision` 打到 `StatusReply`/日志。
- **真实输入 seam（✅ 已落骨架，宿主可 `cargo check -p amos-power --features android`）**：`amos-power::android::AndroidBatteryTelemetry` 读真机 `BatteryManager` 粘性 `ACTION_BATTERY_CHANGED`（`level/scale/status/temperature` → `BatteryState`），喂给 energy/governor 的 `Telemetry`；实时功耗用 `snapshot_with_power(&amos_profiling::android::AndroidBatteryPowerSource)`（真实 `CURRENT_NOW` × `EXTRA_VOLTAGE`）折进 `Telemetry.power_mw`，驱动 `PowerDraw` 降档分支。真机接线（System UI 喂 `JavaVM`+`Context`）仍需设备验证。
- **CPU/NPU 频率落地（✅ 域 + Linux seam 已落 2026-09-05）**：`EnergyGovernor` 出的 `Decision.sensor_mode` 经 `amos-power::freq::plan/plan_from_decision` 映射成 `FreqPlan`（各 CPU cluster + NPU 频率上限，Balanced 不设小核上限保 UI/电话响应），由 `linux` feature 的 `LinuxFreqGovernor` 写 `scaling_max_freq`/NPU devfreq 落地。拓扑注入已给发现助手：`LinuxFreqGovernor::discover(cpufreq_root, cpu_max)` 读各 `cpu{cpu}/cpufreq` 的 `cpuinfo_max_freq` + `related_cpus`，按共享策略分组、以组内最小 cpu 为域代表去重，产出 `DiscoveredDomain{rep_cpu, cpus, max_khz}`，再 `cluster(kind)` 标定 little/big/prime（kind 需平台提供，sysfs 读不出）。组合层桥：`amos-ai::ResourceGovernor::freq_plan(&clusters, npu_max)` 用上一 tick 的 `sensor_mode` 出计划；需按变化去抖 apply 的调用方持有 `FrequencyGovernor` 再喂 `LinuxFreqGovernor`。设备上需对应写权限——属 bring-up 工作。

- **daemon 常驻 DVFS beat（✅ 已接 2026-09-05，真机待验）**：`amos-ai` 已启用 `amos-power/linux`；新 `amos-ai::governor::DvfsDriver` 开机一次经 `LinuxFreqGovernor::discover` 从 `AMOS_CPUFREQ_ROOT`（默认宿主不设→inert）发现 CPU 域并以启发式标定 kind（≥最快域 90% = Big，否则 Little），`server.rs` 的 governor beat 每拍用 `ResourceGovernor::freq_plan` 拿计划、**仅当变化**时经 `DvfsDriver::apply_if_changed` 真写 `scaling_max_freq` 并 log（干净/部分失败分开记）。host/CI 因未设 env 无操作；真机需 root/特权 + 真实拓扑覆写；`DvfsDriver` 单测覆盖 discover→PowerSave 写限→同档不重写→Balanced 恢复（tempdir）。kind 启发式可用 `AMOS_GOVERNOR_CPU_KINDS="0:Little,4:Big"`（逗号 `cpu:kind`，kind 大小写不敏感，坏值跳过）在 daemon 启动时覆写为真实拓扑。`DvfsDriver` 另累计 `applied_total`/`failed_total`（去抖跳过不计数），供观测 beat 长期写失败率。

- **闭环**：`cap_inference` → 推理解码降档 / 后台同传/ASR 推迟；`throttle_background` → 接后台任务队列/唤醒对齐。
