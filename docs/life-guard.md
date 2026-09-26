# LMK Self-Protection Guard（`amos-ai::life_guard`）

> **定位**：base A（no-UI Android 基座）下，`amos-ai` 守护进程"不被 LMK 回收"这条安全属性，在 `deploy/android/amos.rc` 里**只被 init 静态写一次**（`user root` + `oom_score_adj -1000`）。现树此前**没有任何运行时验证 / 上报 / 自愈**：若写入未生效、被改动、或启动参数漂移，会"静默失败"——而这正是该设计本想防住的故障（内存压力下 AI 核心被回收，Tauri 变瞎子）却无任何可观测信号。
> 本模块补齐**缺失的运行时半边**：读 `/proc/self/oom_score_adj`、判定保护态、特权时**自愈并回读验证**、失败安全。纯逻辑 + 可注入 procfs seam，全分支离线可测，无 root / Android / `/proc` 也能 CI 全绿。

## 1. 设计（对照 `amos-monitor` 惯用法）

| 部件 | 职责 |
|---|---|
| `ProcFs`（seam） | 读 / 写当前进程 `oom_score_adj`。`supported()` 区分"有无 oom 控制的宿主" |
| `LifeGuard::check()` | 无副作用读一次 → `Protection`（`Protected / Unprotected{observed} / Unverifiable / Unsupported`） |
| `LifeGuard::ensure()` | 需要时**写目标值并回读确认** → `Verdict`（`Protected / Healed{from,to} / NotApplicable`）或 `EnsureError` |
| `LifeGuard::spawn_periodic()` | 周期自检 + 按状态定日志级别；首 tick 立即触发（启动即验证） |
| `PlatformProcFs` | 真实现：Linux/Android 读 `/proc/self/oom_score_adj`；其余宿主诚实 `Unsupported`。平台判定走纯函数 `oom_control_supported(os)`（`linux` \| `android`）——**含 Android 是本模块存在的理由**，详见 §3 与 REQ-A537 |

`LifeGuard` 对同一 [`ProcFs`] 输入**确定性**：同态必得同判，故可安全周期 tick、可穷举测试。

## 2. 接线

`amos-ai/src/server.rs::serve()` 在每个 daemon 周期的 beat 中新增一条 `life_beat`（与既有的 heartbeat / energy / system 同 cadence、同 shutdown abort 流程）。首 tick 立即执行 → **启动即验证 + 自愈**；此后持续保证。

## 3. 诚实边界（不造假）

- `oom_score_adj == -1000` 只意味着 **LMK 不按 OOM 分级回收本进程**，**不是绝对存活**：显式 `am force-stop`、用户"强行停止"、或绕过 OOM 分级框架动作仍可终止进程。守卫**绝不宣称绝对不死**。
- 只有**特权进程**（root，即 base A 的 `user root` 服务）能上调自身 `oom_score_adj`；非特权会得 `EnsureError::Unprivileged`，**从不伪造"已治愈"**。
- 无 oom 控制的宿主（桌面 dev / 零售非 root）→ `Verdict::NotApplicable`，安静 trace，不假报。
- 失败安全：读不到值 → `Unverifiable`；写完回读对不上 → `RecheckFailed`，绝无静默假设。
- 桌面（macOS）默认构建下 `PlatformProcFs.supported()==false`，`serve()` 每 tick 只是 trace no-op，不影响开发日志。
- **平台判定含 Android（REQ-A537，2026-09-20）**：`PlatformProcFs::proc_supported` 原为 `#[cfg(target_os = "linux")]`，而 Android 的 `target_os` 是 `"android"` —— 于是在**唯一**该被保护的 tier（base A）上 `supported()` 恒为 `false`、`ensure()` 恒为 `NotApplicable`、周期守卫恒为 trace no-op：这条安全属性在设备上**从未被验证过一次**，且失败是无声的（还被报成"本宿主无 oom 控制"这个**确定但错误**的结论）。改为等价于 `peercred.rs` 的 `any(target_os = "linux", target_os = "android")`，但抽成纯谓词 `oom_control_supported(os: &str)` 以便**在无 Android 工具链的宿主上单测**该分类。副作用（如实）：Android 上非 root 构建的写会被拒 → 每 tick 一行 `Unprivileged` WARN；这与既有 Linux 桌面路径的行为一致（base A 的 daemon 本就是 `user root`）。

## 4. 验证

- `cargo test -p amos-ai --lib life_guard` → **14 passed**（保护态/无副作用、异值自愈、零值自愈、无特权诚实报错、写失败、写后回读不符、读失败不 panic、不支持宿主 not-applicable、key 稳定、错误文案、默认路径、Linux 真读形态，**＋平台分类含 Android（`oom_control_supported_includes_linux_and_android`）与真实现与谓词一致（`the_platform_impl_agrees_with_the_classifier_on_this_host`）**）。**负控（实测）**：把谓词改回仅 `"linux"` ⇒ 恰好 1 条变红（`oom_control_supported_includes_linux_and_android`），逐字节还原后复绿。
- `cargo test -p amos-ai --lib` → **330 passed**（实测；本行为旧值 162 的历史记录，随代码增长重测更正）。
- `cargo clippy -p amos-ai --all-targets -- -D warnings`、`cargo fmt --all -- --check` 干净。
- 模块 `#![forbid(unsafe_code)]`；生产代码无 `unwrap/expect/panic`（P0-1 gate）。

## 5. 设备验收（base A）

镜像并入 `amos.rc` 重启后，daemon 日志应出现首 tick 的 `amos-ai oom_score_adj self-healed to -1000`（若未被保护）或 `verified protected`（trace 级，需开 `AMOS_LOG=...trace`），且宿主 `cat /proc/<amos-ai-pid>/oom_score_adj` 实为 `-1000`。手动把该值改成 `0`，下一 tick 应自愈回 `-1000` 并 `info` 记一行。
