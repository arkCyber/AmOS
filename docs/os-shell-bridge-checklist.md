# 纯 Svelte 壳：系统层（自动息屏 / 来电 / 系统桥）清单与真机验收

> 目标：把 React `App.tsx` 宿主承担的“系统层”能力迁进纯 Svelte `Shell.svelte`（React→Svelte 迁移 P1）。凡能在仓库内 React-free 且可无头测试的，先落地并测；依赖运行态/真机的，给验收清单。

## 已落地的 React-free 系统层（挂 `Shell.svelte`）
- **OS 到时提醒**（闹钟/提醒/计时器）：`svelte/os{Alarm,Reminder,Timer}Watcher.ts`（React-free）已由 Shell `onMount` 启动、`onDestroy` 停止；宿主侧不再用 React hook。
- **自动息屏**：`svelte/osAutoOff.ts`（React-free）——读 `amos.displayAutoOffSec`，按活动/空闲到点调用 `onSleep`；Shell 里 `onSleep = lock()`。纯逻辑 `osAutoOffDecision/osAutoOffTimeout` 有 bun 测试（2）。

## 来电订阅（说明与清单）
- 来电 UI 为 **Svelte `IncomingCall.svelte`**，由 `Shell.svelte` 常驻渲染（`.svelte` 自身订阅 telephony）。只要 `Shell.svelte` 成为宿主，来电覆盖即由 Svelte 承载。
- 生产目前仍是 React `App.tsx` 宿主并用自己的 React 覆盖层；真正的“迁进 Shell”= P2 切 `index.html → Svelte 入口`。当前在仓库内做到：Svelte 覆盖层 + 清单。

## 系统桥（硬件键/事件）计划
- `lib/systemButtons.ts`（React-free）已提供 `HardwareAction`（GoHome/VoiceInput/OpenAiAssistant）。
- 待接线：Shell 监听 `hardware-button`/`keydown` → `goHome()`（Home）、`open("ai")`（AI）；来电 `telephony-event` 由已挂 `IncomingCall.svelte` 消费。纯映射与清单见 React 移除计划 P1。

## 真机验收（S5 / Android 14，`adb -s YY000286`）
1. 自动息屏：**出厂默认已改为「关」(0)** —— `amos.displayAutoOffSec` 缺省时永不自动 `lock()`（常驻/永远显示）。要验收自动息屏本身：先在 Settings→General「自动息屏」选 30，再静止 30s → Shell 应 `lock()` 回锁屏。
2. 来电：从别机拨号（或模拟 `telephony-simulate-incoming`）→ 覆盖层振铃（MP3）+ 应答/挂断。
3. 硬件 Home：按设备 Home → `goHome()` 回 dock。
4. OS 到时：设 1 分钟闹钟 → 灭屏 → 到点唤醒并到前台响铃（需 `AlarmGlue`/`AlarmReceiver` 与权限，见 `native-alarm-bridge.md`）。
- 回贴：`adb logcat -s AlarmGlue AlarmReceiver`、`adb shell dumpsys alarm | grep -i amos`。

## 验证（仓库内，全绿）
- `osAutoOff.test`（2）、`os{Alarm,Reminder,Timer}Watcher.test`（各 3）、shell.svelte（18）。
- vitest 全绿、`tsc` 0、`svelte-check` 0、bun `[bun-iso] OK`。
