# AmOS 硬件按钮（Home / 语音 / AI 助手）

物理手机上的 3 个硬件按钮，通过 `amos-tauri` 的 `buttons` 模块接入 System UI。

## 数据流

```
[ 物理按钮 GPIO/evdev/Android 按键 ]
        │  平台驱动调用 HardwareButtons::press(button)
        ▼
[ amos-tauri buttons.rs ]
        │  emit "hardware-button" 事件
        ▼
[ 前端 main.js → window.AmosButtons.handle(button) ]
        ├─ home  → systemHome()
        ├─ voice → openApp("ai")  (AI app 内可经 AmosVoice.transcribe 接 ASR)
        └─ ai    → openApp("ai")
```

## 代码结构

| 位置 | 职责 |
|------|------|
| `crates/amos-tauri/src/buttons.rs` | `HardwareButton` 枚举 + `ButtonAction` 映射 + `HardwareButtons` 状态 + `simulate_button` 命令 |
| `crates/amos-tauri/src/lib.rs` | 注册 state + 命令 |
| `frontend/js/core.js` | `window.AmosButtons`（`handle`/`press`） |
| `frontend/js/main.js` | 监听 `hardware-button` 事件 + 桌面键盘快捷键 H/V/A |

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
- **桌面开发/测试**：`simulate_button` 命令 + 前端 `window.AmosButtons.press(name)` +
  键盘快捷键（H/V/A）走完全相同的路径。

## 测试

- Rust 单测：`from_name` 解析、`ButtonAction::from` 映射、state 记录。
- 前端：`hardware buttons: home/voice/ai route to actions`（无 Tauri 时回退 handle、
  home 回主屏）、`press goes through the Tauri command when available`。

## 语音按钮 → ASR

Voice 按钮打开 AI 应用；AI/翻译应用内可调用 `window.AmosVoice.transcribe(audioBytes)`
把麦克风音频发到 `amos-translate` 的 `Transcribe` RPC（`SpeechRecognizer` 转写），
实现"语音 → 转写 → 文本/意图"。详见 `docs/translate-daemon.md`。
