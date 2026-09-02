# 同传 App —— GUI 冒烟走查

在**带显示器的机器**上跑通 System UI 同传 App 的完整界面。脚本：

```bash
scripts/gui-smoke.sh            # 一键：build + 起 mock daemon + 启动 GUI
scripts/gui-smoke.sh --check    # 只验证前置（显示环境 + 可构建）
```

> 无显示器环境（CI/headless）可用 `GUI_SMOKE_FORCE=1 scripts/gui-smoke.sh --check`
> 仅验证可构建；或跑无头全链路冒烟 `cargo test -p amos-translate --test full_chain`。

## 前置

- 有显示（X11 / Wayland / macOS）。
- Rust 工具链 + cmake/cc（本项目构建需要；Tauri 原生依赖见下）。

## 步骤

```bash
cd /Users/arksong/AmOS
scripts/gui-smoke.sh
```

脚本会：
1. `cargo build -p amos-translate -p amos-tauri`
2. 以 mock 启动 `amos-translate` daemon（socket `/tmp/amos-translate.sock`，provider/ASR 均为 mock）
3. 启动 Tauri System UI（`target/debug/amos-tauri`）
4. 打印操作指引，`Ctrl-C` 退出并清理

## 界面走查

1. **打开 App**：Dock / 主屏找到 「🌐 同传」，点击。
   - 顶部状态应显示「就绪 — 点击「开始」后即可说话/输入」。
2. **选择语言**：源（默认 自动检测）、目标（默认 中文）。
3. **▶ 开始**：状态变为「会话已启动 (auto → zh)」；开始/暂停/结束/说话按钮点亮。
4. **说话**：按住/点击「🎤 说话」→ 授权麦克风 → 说一句话 → 松开/再点停止。
   - 麦克风 PCM 降采样 16k mono → `AmosInterp.audio` 流式喂入。
5. **观察流式转写**：录音中会看到斜体 partial（`…你` → `…你好` → `…你好，Amos`）。
6. **译文**：松开后 `EndOfSpeech` → 识别文本经 daemon 翻译 → 生成「译文」段落（含 🔊 朗读按钮）。
7. **🔊 朗读 / 自动朗读**：点段落按钮播放；或勾选「🔊 自动朗读译文」让每段译文自动朗读。
8. **输入文本**：也可在下框输入文字回车 → 直接翻译。
9. **⏸ 暂停 / ⏹ 结束**：控制会话。

> 会话是可复用的：结束后可 `.restart`（CLI）或再次「▶ 开始」（App 会新建会话）。

## 预期输出（mock）

```
[partial] 你        （流式）
[partial] 你好
[partial] 你好，Amos
[译](auto->zh)你好，Amos   （译文段落）
🔊 朗读 → 播放（mock TTS）
```

## 排错

| 现象 | 处理 |
|------|------|
| 状态「非 Tauri 环境」 | 用 `target/debug/amos-tauri`（或 `cargo tauri dev`）启动，别用纯浏览器打开前端 |
| 「启动失败：translate daemon unavailable」 | 确认 `amos-translate` daemon 在跑：`ls -l /tmp/amos-translate.sock`；看 `/tmp/amos-gui-daemon.log` |
| 麦克风权限被拒 | 系统设置授予权限；或改用「输入文本」路径 |
| 无声音（TTS） | 当前为 mock TTS；启用 Piper（`--features piper` + 模型）后为真实语音 |

## 相关

- 无头全链路冒烟：`crates/amos-translate/tests/full_chain.rs`
- 架构与路线：`docs/interpretation-architecture.md`
