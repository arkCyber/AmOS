# AmOS 推理性能 & 功耗 Profiling（领域内核）

**日期**: 2026-09-04 · **范围**: `crates/amos-profiling`（领域内核）

> 路线图点名 *Performance profiling and optimization* 尚未开展；本地端侧跑大模型对手机**电池与发热
> 是极大考验**。本轮按「领域内核 + seam」落地 `amos-profiling`（纯 domain core、离线可测）；真正的
> **PowerSource（Android 电量/功耗 HAL）、metric 导出（monitoring/status/wire）与 `amos-ai` 引擎
> 的 profiler 装配**留 seam，后续轮次接。

## 1. 现状与定位（改动前）

`amos-ai` 有监控健康（`monitoring.rs`，2026-09-03）但**没有 per-run 的性能/功耗数字**：模型团队拿不到
prompt-eval / decode 的吞吐、TTFT、每 token 延迟或一次推理消耗的电量。对端侧 LLM，这些恰恰是决定
「能不能持续用」的指标（发热→降频→tps 崩）。本 crate 提供可测、无 NaN 的度量内核，供 daemon 以后
装配。

## 2. 范围边界

- ✅ **领域内核**：phase 记账（prompt eval / decode）、tokens-per-second、TTFT、每 token 延迟、
  `PowerSource` seam + Mock、功耗×时间能量、人类可读/可导出 report + 单测。
- ✅ **daemon 装配（2026-09-04）**：`amos-ai/src/profiler.rs` 的 `ProfileStore`（`Arc` 共享：
  `ProfileTracker` + TTFT 原子计数）在 `server.rs` 的 **`stream_chat` 与 bidi `Chat`（文本/语音成句
  转 prompt）两条文本解码路径**都按 turn 记录**流式 token 数 + 墙钟**（端到端，含后端/网络）与
  **time-to-first-token**；被 `Cancel` 打断的 turn 不记（避免半截样本）。`get_status` 经
  `StatusReply.profile`（`ProfileMetrics`，proto 字段 12）暴露；`serve()` 另以与健康心跳相同周期
  `ProfileStore::spawn_periodic_log` 输出 profile 行（`amos-ai inference profile`），无需 RPC。
- ✅ **真机功耗骨架（`feature android`，2026-09-04）**：`amos-profiling/src/android.rs`
  `AndroidBatteryPowerSource`（仿其它 `android.rs` seam）——`BatteryManager#getLongProperty(
  CURRENT_NOW)`（µA）真实读取 × 电压（构造参数，默认 3700 mV；真机应传 `EXTRA_VOLTAGE`）→ mW；
  读不到即 `0.0`（诚实 "不可用"）。`cargo check -p amos-profiling --features android` 可编译（已入
  `make gated-check`）。
- ⏳ **真机电压接线**：在 System UI 接 `ACTION_BATTERY_CHANGED` 粘性广播取实时 `EXTRA_VOLTAGE`
  （mV）传入 `with_voltage_mv`，把 `est_energy_j` 一并报进 profile（需设备 bring-up）。

> 诚实说明：daemon 无 tokenizer，**不**计 prompt tokens，也不把 mock/远端 `tokens/s` 冒充为芯片
> 推理吞吐。`ProfileMetrics` 只报可端到端量到的数字（decode_tokens_per_sec 是「流到客户端的生成
> token/s」、ttft_ms 是请求→首 token 墙钟）；`decode_runs == 0` 表示尚无数据。

## 3. 领域内核 `crates/amos-profiling`（纯 std、离线可测）

两个 knob 驱动端侧体验：**prompt eval（prefill）**——整体吃一遍 prompt，其墙钟主导 TTFT，吞吐按
prompt tokens/s；**decode**——逐 token 自回归，decode tokens/s 及其倒数（每 token ms）就是用户感到
的流式速度。

| 模块 | 内容 |
|---|---|
| `types` | `Phase`（PromptEval/Decode）、`Record`（phase+tokens+wall） |
| `tracker` | `ProfileTracker`：无损累加；`prompt/decode_tokens_per_second`、`decode_ms_per_token`、`ttft_ms`、`merge`；除零守卫（空→`None`，绝不 NaN/inf）|
| `power` | `PowerSource` seam + 确定性 `MockPowerSource`；`energy_joules = (mW/1000)×秒` |
| `measure` | `time`/`time_and`：用 `Instant` 包一次模型调用，产出墙钟 `Duration` |
| `report` | 拥有式 `ProfileReport`（可从 tracker+可选功耗快照计算），`Display` 输出稳定 `key: value` 行 |

```text
[ 模型调用 ] ── time()/Instant ─▶ Phase + tokens + wall
      │                                │
      ▼                                ▼
[ PowerSource seam ]         [ ProfileTracker ]（纯累加，除零守卫）
  Mock（今天）· Android           │
  power HAL（未来）               ▼
                        [ ProfileReport ] ──▶ 日志 / monitoring / wire
```

**设计要点**：`PowerSource` 同传感器 provider 一样「笨」——只回答「上一窗口平均功耗 mW」；把功耗×墙钟
算能量放 `energy_joules` 纯函数；除法一律走 `safe_div`（空数据给 `None`/`n/a`，不让 NaN 渗进 report）。

## 4. 验证

```bash
cargo test -p amos-profiling                     # 15 项（types/tracker/power/measure/report）
cargo clippy -p amos-profiling --all-targets -- -D warnings
cargo fmt -p amos-profiling
# daemon 装配（stream_chat + bidi Chat 都记录；get_status 暴露）：
cargo test -p amos-ai --lib                          # profiler.rs 单测
cargo test -p amos-ai --test rpc_test sensor_service_mounted_and_profile_exposed
cargo test -p amos-ai --test chat_test bidi_chat_prompt_turn_is_profiled
# headless 验收示例（需一个在跑的 daemon socket，如 /tmp/amos-ai.sock）：
cargo run -p amos-ai --example profile_once -- /tmp/amos-ai.sock hello
```

## 5. 下一步（超出本次）

- **System UI 深度接线**：profile 已渲染进 Settings 的 engine-truth/诊断区（`aiEngine.ts` 的
  `describeEngine` 现解析 `StatusReply.profile`，`apps.tsx` 在 AI 段显示 decode tok/s / TTFT / 累计
  token）；**设备传感器 tile 已落地**（`components/SensorPanel.tsx`：能量档切换 + 相机/定位/惯性
  读数，走 `sensor_*` 桥 + `lib/sensors.ts`，桌面 mock daemon 即可用）。**仍待（设备）**：把真功耗
  读数 `AndroidBatteryPowerSource::read_mw` 接到 profiler 的 `ProfileReport`（`est_energy_j`）。
- **联动 `amos-sensor`**：跑本地 LLM / 视频预览时切 `SensorMode::PowerSave` 采样档并记录热/电；
  达成路线图「性能分析与功耗优化」的可量化闭环。
