# AmOS 硬件按钮（Home / 语音 / AI 助手）

物理手机上的 3 个硬件按钮，通过 `amos-tauri` 的 `buttons` 模块接入 System UI。

## 数据流

```
[ 物理按钮 GPIO/evdev/Android 按键 ]
        │  平台驱动调用 HardwareButtons::press(button)
        ▼
[ amos-tauri buttons.rs ]
        │  emit "hardware-button" 事件 (+ 记入 take_pending_hardware_button)
        ▼
[ 前端 svelte/osInputBridge.ts (React-free) ]
        │  startOsInputBridge: window "hardware-button" 事件 + keydown(H/V/A)
        │  startOsHardwarePoll: 轮询 take_pending_hardware_button (真机更可靠)
        ├─ home  → shellState.home()        (回 dock)
        ├─ voice → shellState.open("ai")
        └─ ai    → shellState.open("ai")
```

> 说明：真机实测（本页末尾）表明 Rust→JS **事件**在移动 WebView 上不保证送达，
> 因此 Shell 同时启动 `startOsHardwarePoll`（经普通 `invoke` 拉取待处理按键），
> 两条路径都归结到 `mapHardwareAction` 的同一映射。

## 代码结构

| 位置 | 职责 |
|------|------|
| `crates/amos-tauri/src/buttons.rs` | `HardwareButton` 枚举 + `ButtonAction` 映射 + `HardwareButtons` 状态 + `simulate_button` 命令 |
| `crates/amos-tauri/src/lib.rs` | 注册 state + 命令 |
| `frontend-ts/src/svelte/osInputBridge.ts` | Shell 级接线：`hardware-button` 事件 / `keydown` / 轮询 → Home/AI 导航（React-free） |
| `frontend-ts/src/lib/systemButtons.ts` | 解析 payload + 桌面键盘快捷键 H/V/A（纯映射，供上面复用） |

## 真实驱动接入（平台侧）

`buttons.rs` 已暴露 `HardwareButtons::press(&AppHandle, button)`。真实平台驱动只需
在检测到物理按键时调用它（需持有 `AppHandle`）：

```rust
// 例：evdev / GPIO / Android 按键回调里
fn on_button(app: &tauri::AppHandle, buttons: &tauri::State<HardwareButtons>, name: &str) {
    if let Some(b) = HardwareButton::from_name(name) {
        buttons.press(app, b);
    }
}
```

- **Android**：在 Activity/Service 的 `onKeyDown` 里把 `KEYCODE_HOME`（及自定义键）
  映射为 `HardwareButton`，调用 `press`（经 Tauri `app_handle`）。
- **Linux/板载**：用 `evdev` 读输入设备，或 GPIO 轮询，命中后调 `press`。
- **桌面开发/测试**：`simulate_button` 命令 +
  键盘快捷键（H/V/A）走完全相同的路径。

### 真机实测（S5 · FreemeOS/MediaTek，2026-09-08）——相机键被 ROM 抢占

AI 助手改为**双击音量+**：`MainActivity.onKeyDown` 在 450 ms 内**双击音量+
(`VOLUME_UP`)** 时 `assistantQuiet()` → Rust `AiAssistant` → 前端 `open("ai")`；单击
音量+ 仍正常调音量（不 consume）。相机键只被 consume、不再触发 AI（此前"相机键+音量+
和弦"在真机不可靠，且相机键在 ROM 层被全局抢用）。实测按键仅在 AmOS 真正获焦时送达
（`mCurrentFocus` 为 AmOS 窗口），这台 FreemeOS/MediaTek ROM 对相机键会**同时拉起系统
相机 `com.freeme.camera` 并抢走前台**（`topResumedActivity` 变为相机），普通应用无法把
相机键重映射成其它动作。

- 会稳定送达 AmOS `onKeyDown` 的物理键：**音量键**（`KEYCODE_VOLUME_UP/DOWN`）。
- **电源键不可被普通应用拦截**（系统电源管理保留）；AmOS 作为默认 HOME + 常亮
  （`FLAG_KEEP_SCREEN_ON`）+ `wakeHome`，唤醒后即回主屏/显示 UI。
- 若必须用"相机键 → AI"，需 ROM/系统层方案（root 后移除相机键全局快捷键、或以
  kiosk 态禁系统相机），普通 APK 侧无法绕开。

## 测试

- Rust 单测：`from_name` 解析、`ButtonAction::from` 映射、state 记录。
- 前端：`hardware buttons: home/voice/ai route to actions`（无 Tauri 时回退 handle、
  home 回主屏）、`press goes through the Tauri command when available`。

## 语音按钮 → ASR

Voice 按钮打开 AI 应用；AI 应用内可经 `backend.ts` 的 `transcribeAudio`
（+ `svelte/VoiceMicButton.svelte` / `svelte/DeviceMicButton.svelte`）把麦克风音频发到 `amos-translate` 的 `Transcribe` RPC（`SpeechRecognizer` 转写），
实现"语音 → 转写 → 文本/意图"。详见 `docs/translate-daemon.md`。
