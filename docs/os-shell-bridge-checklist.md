# 纯 Svelte 壳：系统层（自动息屏 / 来电 / 系统桥）清单与真机验收

> 目标：把 React `App.tsx` 宿主承担的“系统层”能力迁进纯 Svelte `Shell.svelte`（React→Svelte 迁移 P1）。凡能在仓库内 React-free 且可无头测试的，先落地并测；依赖运行态/真机的，给验收清单。

## 已落地的 React-free 系统层（挂 `Shell.svelte`）
- **OS 到时提醒**（闹钟/提醒/计时器）：`svelte/os{Alarm,Reminder,Timer}Watcher.ts`（React-free）已由 Shell `onMount` 启动、`onDestroy` 停止；宿主侧不再用 React hook。
- **自动息屏**：`svelte/osAutoOff.ts`（React-free）——读 `amos.displayAutoOffSec`，按活动/空闲到点调用 `onSleep`；Shell 里 `onSleep = lock()`。**尊重 keep-awake 理由总线**：`screenHeld()` 为真时视作活动、不息屏，并订阅 `onHoldChange` 在 hold 变动时重置空闲窗口。纯逻辑 `osAutoOffDecision/osAutoOffTimeout/osAutoOffDecisionHeld` 有 bun 测试（4）。
- **保持唤醒（来电/视频）**：`svelte/osTelephonyHold.ts`（React-free）把 `telephony-event` 经 `holdSet` 折叠成 `"call"` hold（重叠通话各自 End）；`PlayerApp.svelte` 播视频时 `"video"` hold（音乐刻意不保持）。`Shell.svelte` 随其它 watcher 启停。
- **唤醒后回主屏**：`svelte/osWakeHome.ts`（React-free）观察 `visibilitychange`/`blur`/`focus`，真唤醒（离开 ≥ 1s）且偏好开启（`amos.wakeHome`，默认开）时 `goHome()`；纯门控 `makeWakeHomeGate` 在 `lib/display`，可无头测试。
- **边缘手势**：`Shell.svelte` 以裸 `pointer*` 监听（`lib/edgeSwipe` 纯决策）——顶边下拉开**通知中心**、底边上滑开**最近使用**、主屏本体下拉开 Spotlight；只有**从薄边带起手**且越过阈值的拖动才算（不抢 App 滚动 / dock），锁屏抑制；每手势至多触发一次。
- **开机共享 store 水合**：`shell-entry.ts` 在 mount 前 `await hydrateFromSystemStore()`（best-effort），把 Rust `SharedStore` 里的设置/通知/布局灌进 localStorage，**先于**任何 runes store 读取；无 Tauri / 快照缺失即 no-op，绝不阻塞启动。
- **剪贴板 Announce 横幅**：`svelte/ClipboardAnnounce.svelte`（React-free）订阅 Rust 广播的 `clipboard-changed`，弹一条**仅元数据**的瞬时提示（`{seq,timestamp_ms,source}`，**绝不显示内容**）；容器侧/后台复制也能让用户看到，自动 3.2s 消失或点 ✕ 关闭。

## 来电订阅（说明与清单）
- 来电 UI 为 **Svelte `IncomingCall.svelte`**，由 `Shell.svelte` 常驻渲染（`.svelte` 自身订阅 telephony）。只要 `Shell.svelte` 成为宿主，来电覆盖即由 Svelte 承载。
- React 宿主已**彻底移除**（`docs/react-removal-plan.md`）：生产入口 = `index.html → src/shell-entry.ts → mount(Shell.svelte)`，不再有 React 覆盖层；本条清单列出的系统层能力全部由纯 Svelte Shell 承载。

## 系统桥（硬件键/事件）计划
- `lib/systemButtons.ts`（React-free）已提供 `HardwareAction`（GoHome/VoiceInput/OpenAiAssistant）。
- 已接线：`svelte/osInputBridge.ts` 的 `startOsInputBridge`（`hardware-button` 事件 + `keydown` H/V/A）与 `startOsHardwarePoll`（轮询 `take_pending_hardware_button`，真机更可靠）由 Shell 启动 → `goHome()`（Home）、`open("ai")`（AI/语音）；来电 `telephony-event` 由常驻 `IncomingCall.svelte` 消费。纯映射 `mapHardwareAction`/`mapKeyAction` 有 bun 测试。

## 真机验收（S5 / Android 14，`adb -s YY000286`）
1. 自动息屏：**出厂默认已改为「关」(0)** —— `amos.displayAutoOffSec` 缺省时永不自动 `lock()`（常驻/永远显示）。要验收自动息屏本身：先在 Settings→General「自动息屏」选 30，再静止 30s → Shell 应 `lock()` 回锁屏。
2. 来电：从别机拨号（或模拟 `telephony-simulate-incoming`）→ 覆盖层振铃（MP3）+ 应答/挂断。
3. 硬件 Home：按设备 Home → `goHome()` 回 dock。
4. OS 到时：设 1 分钟闹钟 → 灭屏 → 到点唤醒并到前台响铃（需 `AlarmGlue`/`AlarmReceiver` 与权限，见 `native-alarm-bridge.md`）。
- 回贴：`adb logcat -s AlarmGlue AlarmReceiver`、`adb shell dumpsys alarm | grep -i amos`。

## 验证（仓库内，全绿）
- `osAutoOff.test`（4）、`osTelephonyHold.test`（4）、`keepAwakeCore.test`（5）、`display.test`（17，含 `makeWakeHomeGate` 5）、`amosStore.test`（12，含 `hydrateFromSystemStore` 3）、`clipboard-announce.svelte.test`（2）、`shell.svelte.test`（含边缘手势 5 + 剪贴板横幅挂载 1）、`os{Alarm,Reminder,Timer}Watcher.test`（各 3）。
- vitest 全绿、`tsc` 0、`svelte-check` 0、bun `[bun-iso] OK`。
