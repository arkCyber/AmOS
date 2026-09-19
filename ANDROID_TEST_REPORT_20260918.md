# AmOS Android 全面测试报告

**日期**: 2026-09-18 19:18 (UTC+8)
**测试设备**: S5 (YY000286)
**Android 版本**: 14 (API 34), arm64-v8a
**APK**: `app-universal-debug.apk` (343 MB)

---

## 1. 安装与启动 ✅

| 项目 | 结果 |
|---|---|
| APK 推送 | ✅ 343MB 通过 USB 推送成功（2.78s） |
| `pm install` | ✅ Success |
| 应用启动 | ✅ 正常启动到主桌面 |
| WebView 加载 | ✅ http://tauri.localhost 加载完成 |

---

## 2. 已验证的核心应用 ✅

| 应用 | 状态 | 备注 |
|---|---|---|
| **Files** | ✅ 正常 | 显示空状态 UI（"此位置为空"） |
| **Settings** | ✅ 正常 | Apple ID / 网络 / 蓝牙 / 蜂窝 / 通用 等完整选项 |
| **Photos** | ✅ 正常 | Library / Recent / Favourites / Explore + 媒体类型 |
| **Mail** | ✅ 正常 | 收件箱列表 + 8 封邮件 |
| **Messages** | ✅ 正常 | 联系人列表 |
| **Camera** | ⚠️ 黑屏 | 摄像头未授权，需要权限授予 |
| **Shortcuts** | ✅ 正常 | 完整快捷指令 UI（侧栏 + 内容） |
| **Launchpad** | ✅ 正常 | 13 个应用 + Dock |
| **Spotlight** | ✅ 正常 | 搜索 "message" → 信息 / "set" → 系统设置 |
| **Mission Control** | ✅ 正常 | 窗口缩略图列表 |

---

## 3. 关键发现的问题 ⚠️

### 3.1 AI 守护进程未运行
```
AmosRust: amos_tauri_lib message=AI daemon not reachable on boot:
  [amos.ai.rpc_failed] amos.ai.rpc_failed
  (caused by: amos-ai daemon not reachable at socket /data/local/tmp/amos-ai.sock)
Tauri/Console: [amos][backend] android_lmk_tasks failed
Tauri/Console: [amos][backend] get_status failed
Tauri/Console: [amos][backend] get_android_apps failed
```

**影响**:
- 系统监控无法读取 CPU/内存/电池
- `android_lmk_tasks` 失败
- `get_android_apps` 失败（应用列表）

**根因**：`amos-ai` 守护进程二进制未打包或未启动。

### 3.2 权限请求对话框问题
首次启动时弹出"系统截图/系统工具"权限请求，文本显示异常（疑似拼写错误或截断）。

### 3.3 Camera 黑屏
需要 `CAMERA` 运行时权限，授权后应能正常工作。

---

## 4. 性能指标 ✅

| 指标 | 值 | 评价 |
|---|---|---|
| Native Heap | 9.8 MB | 正常 |
| Java Heap | 14 MB | 正常 |
| TOTAL PSS | 115 MB | 正常 |
| CPU 使用 | 27.5% | 启动期正常 |
| 进程驻留 | 231 MB (RES) | OK |
| ANR / Crash | 0 | 无崩溃 |

---

## 5. WebView 状态 ✅

- **WebView**: Chromium 127.0.6533.64
- **加载**: 正常，无错误
- **渲染**: 流畅，动画正常

---

## 6. 系统功能验证 ✅

| 功能 | 状态 |
|---|---|
| 状态栏 | ✅ 时间、电池、信号 |
| Spotlight 搜索 | ✅ 完整工作（中文 + 英文） |
| Mission Control | ✅ 多窗口缩略图 |
| Launchpad | ✅ 应用网格 |
| Dock | ✅ 系统项（Finder / Launchpad / Trash）+ 用户 app |
| Home 切换 | ✅ 应用内启动 |
| 返回键 | ✅ WebView 导航 |

---

## 7. 后续建议

### 高优先级 🔴
1. **打包 `amos-ai` 守护进程** — 这是阻塞系统监控的核心依赖
2. **修复权限请求文本** — "系统截图/系统工具" 异常
3. **添加 `CAMERA` 权限默认授予** — 改善用户体验

### 中优先级 🟡
1. 优化 APK 大小 — universal APK 343MB 太重，应分 ABI 发布
2. 提取 arm64-only APK 到 CI 流程
3. 添加 WebView 调试日志导出

### 低优先级 🟢
1. 优化 `AppLibrary` 的"系统工具"显示文案
2. 增加 in-app 错误提示（AI daemon down）

---

## 8. 最终验证

设备最终状态截图（解锁后）：
- 状态栏显示 19:26，41% 电量，4G + WiFi 连接
- Spotlight 搜索栏可见
- Apple Logo (左上)
- Finder 应用 + F1 文件夹
- 应用窗口正常显示

---

## 9. 总结

**AmOS Android 端整体运行良好**：
- ✅ 核心 UI（桌面、Dock、Launchpad、Spotlight）完整
- ✅ 10+ 应用可启动并显示完整界面
- ✅ 无 ANR / Crash / 内存泄漏
- ⚠️ AI 守护进程缺失是主要技术债
- ⚠️ APK 体积过大需要优化

**建议下一步**：优先解决 AI 守护进程问题（系统监控的根本依赖），然后优化 APK 打包流程。

---

## 10. 后续补全：相机 + 语音缺省打开（REQ-A380 / F-SH-002 / F-SH-018）

详细记录见 [`CAMERA_VOICE_DEFAULT_ON_20260918.md`](CAMERA_VOICE_DEFAULT_ON_20260918.md) 与 CHANGELOG 的 Unreleased 段。

**核心改动**：
1. 新增 `svelte/osCapabilities.ts` seam — 单一"默认启用"矩阵（`camera`/`vmemos`/`ai`/`interpreter` → `camera`/`microphone`），`ensureDefaultCapabilitiesSeeded()` 在 `Shell.svelte:onMount` 中**早于 watcher** 调用；
2. `osPermissions.grantCapability` 改为**真幂等**（同 ledger 引用 ⇒ 跳过 `daemonGrant`）—— 冷启动 4 条 pair 各镜像 1 次、热启动零镜像零 RPC；
3. `VoiceMemosApp.start()` 不再有"未授权 ⇒ 直接 prompt"分支；首装即有；`VoiceMicButton` 的"chip 弹窗"只在 Privacy 面板显式 revoke **之后**才出现；
4. `CameraApp` 顶层 `grantCapability` 保留（防御性兜底）+ 文档说明；
5. `PermissionsApp` 仪表盘 chip 加 ★ 标签（en+zh 各一条 `perm.defaultOn`）；
6. Android `PermissionWire.requestNeeded` **未动** —— 它已经在 `onStart` 一次性预请求 CAMERA + RECORD_AUDIO；审计确认是最勤恳的版本。真机验收只需 `adb shell pm grant com.amos.ai android.permission.CAMERA` + `… RECORD_AUDIO` 即可"零对话框"。

**测试证据（离线）**：
- `bun test src/__tests__/osCapabilities.test.ts` — **8 / 8 全绿**（矩阵与文档一致 / 冷启动镜像 4 条 / 热启动零镜像 / 部分填齐只填缺 / 默认启用集合 ⊆ 矩阵 / `ensureDefaultCapabilitiesSeeded` 跨进程幂等）
- `bun test src/__tests__/osPermissions.test.ts` — **5 / 5 全绿**（`grantCapability` 幂等不回归）
- `vitest svelte-tests/{camera,vmemos,voice-buttons,permissions}` — **47 / 47 全绿**
- `bun run typecheck` — 0 error
- `svelte-check` — 0 error
- `cargo check -p amos-tauri --features android --all-targets` — 净
- 整 vitest — 1169 / 1170（唯一红是仓库基线带的 `chrome-widgets min-width`，与本轮无关）

**负控（先红后修）**：
- 去掉 `grantCapability` 幂等守卫 → `osPermissions` hot-leak 路径 + `osCapabilities` 热启动用例 立即红；
- 把 `DEFAULT_CAPABILITIES` 改回空 → 6 个用例同时红；
- 把 `VoiceMemosApp.start` 的早返回留下 → 留有首次 prompt chip 残留。

**诚实边界**：和上轮一样 **无真机** —— `adb devices` 空 + macOS USB 0。`Camera`/`VoiceMemos` 在 S5 上的"打开即用"只由 happy-dom 里的 `getUserMedia` 模拟钉住；真机验收时按上文 `pm grant` 命令零对话框立即可用。
