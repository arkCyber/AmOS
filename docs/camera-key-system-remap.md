# 相机键 → AmOS AI 助手：系统层重映射步骤（S5 · FreemeOS/MediaTek）

**日期**: 2026-09-08　**设备**: YY000286（product:S5, FreemeOS/MediaTek）
**目标**: 按下相机键（`KEYCODE_CAMERA`）打开 AmOS 的 AI 助手，而不是系统相机
`com.freeme.camera`。

## 为什么需要系统层

AmOS 侧已经完整实现并实测送达：AI 助手由**和弦**触发——`MainActivity.onKeyDown` 在
音量+ 与相机键同时按住时 `assistantQuiet()` → Rust `buttons::AiAssistant` → 前端
`open("ai")`。但实测这台 FreemeOS/MediaTek ROM 在 AmOS 获焦并 consume 相机键后，仍**同时拉起系统相机并抢走前台**
（`topResumedActivity` 变成 `com.freeme.camera`）。即相机键是 ROM 的**全局相机快捷键**，
在 framework/ActivityManager 层处理，普通应用无法用 `onKeyDown` 绕开。
本清单从 OS 层消除这个抢占，让 AmOS 的按键处理成为唯一生效路径。

## 前置：真机需可 root

实测当前 **不是 root**（`adbd cannot run as root in production builds`，且无 `su`）。
需要先 root（Magisk / 已 root 的工程构建）。先验证：

```bash
adb -s YY000286 shell 'su -c id'    # 期望 uid=0(root)
```

## 步骤 1（首选 · 可逆）：停用系统相机 App，让快捷键失去目标

```bash
adb -s YY000286 shell su -c 'pm disable-user --user 0 com.freeme.camera'
```

验证（期望 AmOS 保持前台 = AI 助手已开，不再跳系统相机）：

```bash
adb -s YY000286 shell am start -n com.amos.ai/.MainActivity   # 先把 AmOS 拉回前台
sleep 2
adb -s YY000286 logcat -c
adb -s YY000286 shell input keyevent 27                         # 相机键
sleep 3
adb -s YY000286 logcat -d | grep -i 'AmosMainActivity'          # 期望 "camera key -> AmOS AI assistant"
adb -s YY000286 shell dumpsys activity activities | grep -i topResumedActivity
# 期望 topResumedActivity = com.amos.ai/.MainActivity（不再是 com.freeme.camera）
```

回滚：`adb -s YY000286 shell su -c 'pm enable com.freeme.camera'`

## 步骤 2：若停用相机后仍被拉起（ROM 仍按包名/别名启动）

- 清掉相机默认/缓存，防止"别名启动"复活：
  ```bash
  adb -s YY000286 shell su -c 'pm clear com.freeme.camera'
  ```
- 查有没有第二个相机入口/预置别名：
  ```bash
  adb -s YY000286 shell pm list packages | grep -iE 'camera|mediatek|freeme'
  adb -s YY000286 shell dumpsys activity | grep -iE 'camera|KEYCODE_CAMERA|keyHandler' | head
  ```
- 若命中的是 framework 层的默认按键处理（`PhoneWindowManager` 对 `KEYCODE_CAMERA`
  的相机启动），那需要改 ROM/framework（编译层），普通 shell 无法改；此时走步骤 3。

## 步骤 3：kiosk/系统级兜底

- 若纯 root 方案不足，用 Device Owner（DPC）把设备锁进 kiosk：`setLockTaskPackages`
  锁定到 `com.amos.ai`，并隐藏状态栏/导航，减少 ROM 快捷键抢占面。
- 或在 ROM 编译层移除相机键的全局启动（framework 按键策略 / SystemUI 的 camera
  quick-launch），这是工程机方案。

## 说明与边界

- 稳定送达 AmOS 的物理键是**音量键**（实测 `onKeyDown keyCode=24/25` 送达）。
- **电源键不可被普通应用拦截**（系统电源管理保留）。AmOS 作默认 HOME + 常亮
  （`FLAG_KEEP_SCREEN_ON`）+ `wakeHome` 后，唤醒即回 AmOS 显示，无需重映射电源键。
- 相机键若只是通过 `adb input keyevent 27` 注入触发，ROM 按"相机快捷键"处理属预期；
  真实物理相机键若存在，行为通常一致——以上方案对两者都适用。
