# AmOS 电源 / DVFS bring-up 手册

**日期**: 2026-09-05 · **范围**: `amos-profiling` + `amos-power` + `amos-ai`（能源-Governor → CPU/NPU 频率闭环）
**关联**: `docs/power-policy.md` / `docs/profiling.md` / `docs/device-bring-up.md`

> 这套「功耗模型 → 决策 → 采样门控 + 频率写限/恢复」在 host 侧已全部实现并单测/集成覆盖；本页是**真机（Linux/Android cpufreq）落地与验收**的执行手册。所有 host 已绿的命令都列在 `docs/power-policy.md` §5。

---

## 1. 运行时开关（daemon，`amos-ai`）

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `AMOS_CPUFREQ_ROOT` | 指向 cpufreq sysfs 根（如 `/sys/devices/system/cpu`）。设了才启用常驻 DVFS beat（`governor::DvfsDriver`），否则 inert。 | 不设 = 关闭 |
| `AMOS_GOVERNOR_CPU_KINDS` | 覆写 kind 启发式：逗号分隔 `cpu:kind`（`little/big/prime`，大小写不敏感），如 `"0:Little,4:Big"`。坏值跳过。 | 无 = 用启发式 |
| `AMOS_CPUFREQ_NPU_MAX_KHZ` | 可选 NPU 硬件上限（kHz）。设了 `freq_plan` 才会按档（Balanced ~85% / PowerSave 更低）**算得出** NPU 上限。 | 无 = 不对 NPU 限频 |
| `AMOS_CPUFREQ_NPU_NODES` | 逗号分隔的 devfreq `max_freq` 节点（真写盘 NPU 上限/恢复），如 `/sys/class/devfreq/1d84000.npu/max_freq`。 | 无 = 只算不写 |

其余输入来自仓库已有 seam：
- 电池/温度/功耗 `Telemetry`：`crate::energy::telemetry_from_env()`（daemon beat）。
- 实时功耗源：`amos_profiling::android::AndroidBatteryPowerSource`（真 `CURRENT_NOW` × `EXTRA_VOLTAGE`），经 `snapshot_with_power` 折进 `Telemetry.power_mw`（System UI 进程）。

## 2. 架构速览（host 已验证）

```text
真机电池(CURRENT_NOW×EXTRA_VOLTAGE)
  │  BatterySample → mean_power_mw / ProfileReport::compute_sampled → est_energy_j
  ▼
Telemetry{ battery, power_mw, usage }
  │  EnergyGovernor / ResourceGovernor（迟滞决策）
  ▼
SensorMode  →  Decision.apply_to(SensorManager)   采样门控（PowerSave 拒 30FPS）
  │            ComposedGovernor 一行同时驱动“采样+频率”
  ▼
freq::plan / FrequencyGovernor(去抖)  →  FreqPlan{各 cluster 上限, npu 上限}
  │
  ▼
LinuxFreqGovernor::discover(cpufreq_root)  读 cpuinfo_max_freq + related_cpus → DiscoveredDomain
  │  DvfsDriver（amos-ai beat）apply_if_changed —— Some=写 scaling_max_freq / None=恢复 cpuinfo_max_freq
  ▼
/sys/.../cpu{rep}/cpufreq/scaling_max_freq（+ NPU devfreq 节点）
```

## 3. host 验证（无需设备，先在桌面跑绿）

```bash
cargo test -p amos-profiling                        # 23 项（含 mean_power_mw / compute_sampled）
cargo test -p amos-power                            # 33 lib + 2 集成
cargo test -p amos-power --features linux           # 42 lib + 2 closed_loop + 2 集成（含 discover→ComposedGovernor→sysfs）
cargo test -p amos-ai --lib                          # 123（含 governor::DvfsDriver 与 server::governor_metrics 测试）
cargo run -p amos-power --example live_governor      # 完整 host 演示（不写盘）
```

## 4. 真机 bring-up 步骤与验收判据

1. **权限**：写 `scaling_max_freq` 需 root / 有写权限的特权服务；确认 `cat /sys/devices/system/cpu/cpu0/cpufreq/{cpuinfo_max_freq,related_cpus}` 可读。
2. **拓扑核对**：临时设 `AMOS_CPUFREQ_ROOT=/sys/devices/system/cpu` 启动 daemon，看启动日志 `amos-ai enabling resident DVFS beat`；用 `AMOS_GOVERNOR_CPU_KINDS` 把每个域标成真实 kind（可用 `cpupower frequency-info` / 厂商表对出 little/big/prime）。
3. **功能判定**：
   - 手动低电（mock 或真机）→ `get_status.governor.sensor_mode=="power_save"`，且 `cpu*/cpufreq/scaling_max_freq` 降到小核 80% / 大核 50%（按 kind 对应）；
   - 充电恢复 → `Performance`，`scaling_max_freq` **恢复**到 `cpuinfo_max_freq`；
   - `get_status.governor.dvfs_applied` 随每次档位变化递增、去抖的重复 tick 不增；写失败时 `dvfs_failed` 递增且日志有 `amos-ai dvfs partial`。
4. **稳性**：无 `scaling_max_freq` 反复振荡（`FrequencyGovernor` 去抖保证同档不重复写）；把 `PowerSave` 保持数分钟再恢复，确认无「限死无法解除」。
5. **NPU（按 SoC）**：给 daemon 设 `AMOS_CPUFREQ_NPU_MAX_KHZ`（硬件上限）+ `AMOS_CPUFREQ_NPU_NODES`（devfreq `max_freq` 节点）；`freq_plan` 会按档算 NPU 上限、`LinuxFreqGovernor` 写盘，uncapped 计划恢复到该上限。不同厂商 devfreq 节点名不同，需按平台填入。

## 5. 诚实边界 / 已知限制

- kind 启发式（≥最快域 90% = Big，否则 Little）只是默认；**必须**用 `AMOS_GOVERNOR_CPU_KINDS` 按真机覆写。
- daemon 常驻 DVFS beat 的 NPU 现可通过 `AMOS_CPUFREQ_NPU_MAX_KHZ` + `AMOS_CPUFREQ_NPU_NODES` 开启；未设节点时若计划含 NPU 上限，`apply` 会如实报 `no npu_max_paths`（不静默）。真实 devfreq 节点名/单位（kHz vs Hz）需按 SoC 核对。
- host 上因未设 `AMOS_CPUFREQ_ROOT` 而 inert，逻辑由 tempdir 单测覆盖；真机行为需按 §4 目视/读数验收。
