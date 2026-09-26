# AmOS 桌面 OS 代码分析 — 还缺什么（2026-09-20）

> **方法**：只读审计。每条结论后面都跟着**可自查的证据**（文件:行 / 一条 `grep`）。
> 口径分三类：`已实现`（本次读到真实实现 + 生产调用点）/ `半成品`（有内核无消费者，
> 台账已登记）/ `缺失`（本次 grep 无生产实现）。
> 本页**不复述**历史叙事，也不把「设备才能闭环」写成「已完成」。它与
> `docs/FEATURE_GAP_AUDIT_2026_SEP20.md`（按「App / 平台 / 传输」分域）互补，本页按
> **桌面壳**分域。

---

> ## ⚠️ 部分条目已过时 —— 先读 `docs/DESKTOP_AUDIT_2026_SEP21.md`
>
> 本页写于 2026-09-20。到 2026-09-21 的 HEAD 上，**四条已经被后续轮次修掉了**。
> 过期的原因比没有原因更糟：它会把读者支去寻找一个**已经存在**的功能。
>
> | 条目 | 本页原说法 | 2026-09-21 现状 |
> |---|---|---|
> | **A1** | ⌘M 是「隐藏」非「最小化」；Dock 过滤 Hidden | **已修**。`wm_minimize`（`wm.rs:3138`）存在；Dock **不再**过滤 `Hidden`（`Dock.svelte:252-253` 逐字记录了更正理由） |
> | **A4** | 没有系统级截图 | **已修**。`screenshot::screenshot_capture` 已注册（`lib.rs:571`），`screenshot.rs` 277 行 |
> | **A11** | 窗口列表靠 5 s 轮询 | **已修**。`WM_WINDOWS_POLL_MS = 30000`（`wmWindowsPoll.ts:29`），延迟由 `wm-changed` **推送**（REQ-A717）承担，轮询降级为慢速对账 |
> | **A13** | ⌘A 在 macOS 上按不动 | **已修**。`lib/editKeys.ts`（REQ-A439）在真机上用 AX 量过，并由外壳自己实现该手势 |
>
> 另外 **A5「没有 Quick Look」需要更精确的措辞**：预览**渲染**是存在的
> （`files.rs:593` 的 `files_preview_bytes` → `preview_core`，分类 MIME、解码文本、
> 路由图片/音频/视频），缺的是「任意窗口按空格浮层预览」这个**手势**。
>
> **仍然成立的**：A2（无每应用菜单模型）、A3（无打印管线）、A6（无托盘）、A7、A8、A9、
> A10、A12、B1–B6、C1–C4、D1–D3。逐条复核见 `docs/DESKTOP_AUDIT_2026_SEP21.md` §2/§4。

---

## 0. 一句话结论

桌面壳层（多窗口 / 多显示器 / 吸附 / Spaces / Mission Control / App Exposé /
Launchpad / Dock / Spotlight / 原生 Aqua 菜单 / 窗口几何持久化）**已经远超**
`docs/DESKTOP_ALIGNMENT_COMPLETE_AUDIT.md`（2026-09-16）描述的完成度 —— 那份报告里
「缺 Spaces / Exposé / Drag & Drop」的判断在今天的 HEAD 上**不成立**。

真正还缺的在四个方向：

1. **窗口生命周期的语义**（最小化 ≠ 隐藏、没有缩略图、没有 per-app 菜单）；
2. **系统服务**（打印 / 截图录屏 / 原生通知桥 / 自动更新 / 多用户 / 系统级 IME）；
3. **跨设备与生态传输**（云同步 / 远端推送 / 第三方 bundle 的沙箱授权）；
4. **非 macOS 桌面**（原生菜单、打包、CI 覆盖）。

---

## 1. 先确认「不是缺口」的部分（本次实测）

| 能力 | 证据 |
|---|---|
| 真实多窗口（真 OS `WebviewWindow`） | `crates/amos-tauri/src/wm.rs` 的 26 条 `wm_*` 命令（`wm_open`/`wm_new_window`/`wm_focus`/`wm_hide`/`wm_close`/`wm_zoom`/`wm_maximize`/`wm_fullscreen`/`wm_cycle_app`/`wm_windows`/`wm_snap`/`wm_split*`/`wm_slide_over_rect`/`wm_pane_rects`/`wm_displays`/`wm_layout_snapshot`…），全在 `generate_handler!` 里 |
| 一个应用多扇窗（身份模型） | `crates/amos-wm/src/identity.rs`（`WindowIdentity{app,instance}`、`next_window_label`、`cycle_target`）；前端唯一解析器 `lib/windowRoute.ts::splitWindowLabel` |
| 窗口吸附（九区） | 领域 `crates/amos-wm/src/snap.rs`；命令 `wm_snap`（`wm.rs:2802`）；弦表 `lib/snapZones.ts` |
| 多显示器 | 领域 `crates/amos-wm/src/display.rs`；宿主 `wm_displays`（`wm.rs:2821`）+ `snap_work_area`；前门 `settings/WindowPage.svelte` 的「显示器（调试）」卡（REQ-A690） |
| 分屏 / Slide Over | `crates/amos-wm/src/split.rs`、`slide.rs`；`wm_split*`/`wm_split_demo`/`wm_slide_over_rect` |
| Spaces（虚拟桌面） | `crates/amos-tauri/src/spaces.rs` + `spaces_commands.rs`（`spaces_list/create/rename/delete/switch/move_window/unfile_window/active`）+ `svelte/SpacesPanel.svelte` |
| Mission Control / App Exposé | `svelte/MissionControl.svelte`（按 `wm_windows` 过滤 `kind==="App"` 且非 Hidden，`:89`）、`svelte/AppExpose.svelte`、`svelte/RecentsPanel.svelte` |
| Spotlight（含计算 + 文件） | `lib/spotlightSearch.ts`：`SpotlightKind = "calc" \| "app" \| "file"`（`:18`），计算排第一（`:62`） |
| Dock：磁吸放大 / 自动隐藏 / 位置 / 角标 / 右键菜单 / 溢出 | `lib/dockPrefs.ts`（`autoHide`/`magnification`/`position`/`iconSize`）、`lib/dockConfig.ts`、`svelte/Dock.svelte`、`modules/DockContextMenu.svelte`、`lib/dockBadge.ts` |
| 顶栏 Apple 菜单 + 主菜单（真动作行） | `modules/TopbarAppleMenu.svelte`、`modules/TopbarMainMenu.svelte`（File→New/Close、Edit→Copy/Paste/Select All、View→壁纸/图标/舞台模块/全屏、Window→最小化/缩放） |
| 原生 Aqua 菜单（macOS）+ i18n + 快捷键同步 | `crates/amos-tauri/src/menu.rs`；`menu_set_locale` / `menu_set_shortcuts` |
| 桌面图标：橡皮筋多选 / ⌘-click / ⇧-click union / 拖动改序 / 右键菜单 | `svelte/DesktopStage.svelte:110-270`、`551-553` |
| 窗口几何跨启动持久化 | `crates/amos-tauri/src/window_state.rs`，接线在 `lib.rs:202/212/850/1190` |
| 热角 / 控制中心 / 通知中心 / 焦点模式 | `lib/hotCorners.ts`、`svelte/ControlCenter.svelte`、`svelte/DesktopNotificationCenter.svelte`、`settings/FocusPage.svelte` |
| 键位重绑（系统和弦可配置） | `lib/desktopKeys.ts`、`lib/desktopSystemKeys.ts`、`settings/KeyboardPage.svelte` |
| 桌面侧原生程序（Wine / XDG） | `src/{desktop_entry,wine,linux_apps}.rs` + `svelte/NativeAppsApp.svelte`（`docs/desktop-native-apps.md`） |

---

## 2. 缺口 A — 桌面壳层的窗口语义

| # | 缺口 | 现状（实测） | 证据 |
|---|---|---|---|
| **A1** | **「最小化」其实是「隐藏」，且 Dock 上找不到它** | `⌘M` 走 `wm_hide`（`DesktopShell.svelte:679`），宿主的 `wm_hide` 落成 `window.hide()`（`wm.rs:1801`）。Dock 的「运行中」白点**过滤掉 Hidden**（`Dock.svelte:258`），Mission Control 也过滤（`MissionControl.svelte:89`）⇒ 被最小化的应用在 Dock 上看起来**没在运行**，也没有 macOS 那种**最小化缩略图**区；恢复只能靠再点一次 Dock 图标（`wmOpen`，`Dock.svelte:556`）或右键「打开」。macOS 的语义是：最小化后**仍在运行**，Dock 里出现可区分的窗口缩略图 | 左列 |
| **A2** | **per-app 菜单模型缺失**（F-SH-001 那一族） | 顶栏与原生菜单里这些行是**灰项**：`File ▸ 打印…`、`Window ▸ 前置全部窗口`、`Help ▸ 搜索 / 应用帮助`、`Edit ▸ 撤销`（`TopbarMainMenu.svelte:183/248/292/304-310`）；`menu.rs` 的 Help 是空子菜单 | `docs/mac-menu.md` §5.1 |
| **A3** | **没有打印管线** | 宿主无 PrintService / 打印面板；`amos-pdf-parser` 只做解析 | `TopbarMainMenu.svelte:183`、`FEATURE_GAP_AUDIT_2026_SEP20.md` §3 |
| **A4** | **没有系统级截图 / 录屏** | `grep -ri 'screencapture\|screenshot' crates/amos-tauri/src crates/amos-tauri/frontend-ts/src` → 只命中**注释**与 Photos 的一个目录名（`PhotosApp.svelte:104`）；没有任何对应 `#[tauri::command]` | 同左 grep |
| **A5** | **没有 Quick Look（空格预览）** | `grep -rn -i quicklook crates/` → 0；Files 自己有预览面（`lib/filesPreview.ts`），但没有系统级「选中即预览」 | 同左 grep |
| **A6** | **没有 menu bar extras / 状态项** | `grep -rn 'TrayIcon' crates/amos-tauri/src` → 0；顶栏右侧全是**内置挂件**（`svelte/shellModules.ts`），第三方/系统应用无法放状态项 | 同左 grep |
| **A7** | **没有 Stage Manager / 窗口组 / PiP** | `stageManager`、`picture_in_picture\|pictureInPicture` 各 0 命中 | 同左 grep |
| **A8** | **吸附只能用键盘** | 吸附入口是 `⌃⌥` 弦族（`lib/snapZones.ts`）；没有「把窗口拖到屏幕边缘自动平铺」的指针路径 | `snapZones.ts`、`docs/multi-window.md` §6.8 |
| **A9** | **桌面不是文件面** | 桌面栅格只放**应用图标**（`DesktopStage` 的图标来自 home layout），右键「新建文件夹」是**灰行**（`DesktopStage.svelte:551`）；没有文件图标、没有拖文件到桌面、没有从桌面拖进应用 | `DesktopStage.svelte:551` |
| **A10** | **Dock 无文件夹堆栈（stacks）、Launchpad 无文件夹分组** | `grep -i stack` 在 `dockConfig.ts`/`dockPrefs.ts`/`dock_badge.rs` → 0 命中；Launchpad 是扁平静态网格 | 同左 grep |
| **A11** | **窗口列表靠 5 s 轮询，不是宿主推送** | `lib/wmWindowsPoll.ts:13` `WM_WINDOWS_POLL_MS = 5000`（虽已收成**一次**共享心跳，仍是轮询） | `wmWindowsPoll.ts:13` |
| **A12** | **全屏应用不会成为独立 Space** | `spaces.rs` 是「窗口集合」管理器，与 fullscreen 无耦合（`grep -n fullscreen crates/amos-tauri/src/spaces.rs crates/amos-tauri/frontend-ts/src/lib/spaces.ts` → 0）；macOS 里全屏应用各占一个 Space | 同左 grep |
| **A13** | **⌘A 在 macOS 上按不动（平台缺口，已登记未修）** | 四种改法实测均无效，点击路径正常 | `docs/mac-menu.md` 已知不符清单 |

---

## 3. 缺口 B — 系统服务

| # | 缺口 | 现状（实测） |
|---|---|---|
| **B1** | **无原生通知桥** | 通知只走壳内 banner（`svelte/DesktopNotificationBanner.svelte`）；`UNUserNotificationCenter` / `notify-rust` 0 命中 ⇒ 应用关掉窗口后用户收不到系统级提醒 |
| **B2** | **无自动更新 / OTA** | `grep -rn 'updater' Cargo.toml crates/*/Cargo.toml` → 0；`crates/amos-tauri/tauri.conf.json` 的 `bundle.targets` 只有 `["app","dmg"]`，**无 updater 配置、无签名**；`scripts/release-artifacts.sh` 只交付无头二进制 tarball |
| **B3** | **无多用户 / 快速用户切换** | `multi-user` / `multiuser` 0 命中；`svelte/LockScreen.svelte` 是 in-app 锁屏，不是会话级登录 |
| **B4** | **无系统级 IME** | 拼音引擎（`crates/amos-ime`）很完整，但只是 **in-app** 输入法：容器里的 Android 应用、宿主上别的应用都用不到（`docs/input-method.md` 自述；全仓 `InputMethodService` 0 命中） |
| **B5** | **无跨设备剪贴板** | `clipboard*.rs`（含 guest/link）打通的是**容器**通路，不是设备间 |
| **B6** | **无系统级分享面板** | 现为剪贴板占位（`docs/ios-parity-audit-status.md`） |

---

## 4. 缺口 C — 跨设备与生态传输（半成品，台账已登记）

| # | 半成品 | 有的一半 | 缺的一半 | 台账 |
|---|---|---|---|---|
| **C1** | 云同步 | `lib/cloudSync.ts`：完整调度器（间隔 / Wi-Fi·电量门控 / 退避 / 冲突解决 / 指标） | **传输不存在**（`proto/` 无 sync RPC，宿主无通道） | `frontend-ts/scripts/unwired-allowlist.json` 第 1 条 |
| **C2** | 远端推送 | `crates/amos-tauri/src/push_notifications.rs`（APNs 载荷建模 + token 台账 + 12 条命令） | **投递不存在**（只有 `push_simulate_receive`） | `docs/FEATURE_GAP_AUDIT_2026_SEP20.md` §2 A4 |
| **C3** | 第三方 bundle 的沙箱授权 | `lib/sandboxBridge.ts`（deny-by-default 决策）+ 宿主半边 `svelte/ExtAppHost.svelte` + `amos-app://` | ~~**postMessage 监听器 + daemon `perm_authorize` 卡点**~~ ⇒ **已接线（REQ-A721，2026-09-20）**：监听器 `lib/sandboxCapabilityHost.ts` 与 daemon `perm_authorize` 卡点均已存在；今天每个 frame 恒 deny 是**尚无授予策略**所致，不再是"监听器不存在"。**仍缺**：真实第三方消费者（生态）与真机验证 | 见 `docs/FEATURE_GAP_AUDIT_2026_SEP20.md` §2 A5 |
| **C4** | 蜂窝信号 / GNSS 前端出口 | 前端 `svelte/cellularRadio.ts`、`lib/gps.ts`、`lib/cellularHost.ts` | ~~**宿主命令不存在**~~ ⇒ **已接线（2026-09-25）**：蜂窝宿主命令 `cellular_signal`（`crates/amos-tauri/src/cellular.rs`）已存在，`installCellularSignal` 在通知中心挂载时安装（"从未问过"与"已答：无 modem"是两个状态）；GNSS 的 `readGnss` 已由真实屏幕消费。**仍缺**：真机验证（桌面路径按 `supported:false` 走） | FEATURE_GAP §2 A6/A10 |

> 纪律提醒：这四条**不要**用「本地重快照 / 模拟接收」去点亮 —— 那会让
> `totalBytesSynced` 报一次没发生的传输（本仓反复登记的「一个会撒谎的数字」）。

---

## 5. 缺口 D — 非 macOS 桌面

| # | 缺口 | 证据 |
|---|---|---|
| **D1** | **原生菜单只服务 macOS** | `menu::install` 在非 macOS 上是 **no-op**（`docs/mac-menu.md` §5）；Windows/Linux 上顶栏 in-app 菜单是唯一菜单面 |
| **D2** | **打包与 CI 覆盖** | `bundle.targets = ["app","dmg"]`（macOS），`linux.deb.depends` 只是被配置过；`.github/workflows/*.yml` 的 `runs-on` 全部是 `ubuntu-24.04`（含 `ci.yml`）⇒ **桌面壳没有 macOS/Windows 的 CI 构建** |
| **D3** | **真机 / GUI 复核仍在清单上** | `docs/gui-verify.md`、`docs/multi-window.md` 各节的「诚实边界」（多屏吸附、⌘\`/⌘N 观感、红绿灯交互等）都写明**未做真机截图验收** |

---

## 6. 建议推进顺序

**P0（纯 host 可闭环，收益立刻可见）**

1. **A1 最小化语义**：要么把 `⌘M` 落成「平台最小化 + Dock 缩略图区」，要么把 Hidden 的
   运行白点改成**可区分状态**（并明确「隐藏 ≠ 关闭」）。今天的行为是「用户以为关掉了」。
2. **A4 截图**：宿主一条 `screenshot_capture`（macOS `screencapture` / Android `MediaProjection`），
   落到 `Pictures/Screenshots`（`lib/media.ts::canonicalPath` 已有该目录），Photos 已经会显示它。
3. **A11 事件驱动**：把 `wm_windows` 的 5 s 轮询换成宿主 push（`store-updated` 先例已在）。
4. **A2/A3 灰行政策**：要么给 per-app 菜单一个最小模型（当前应用 → 自己的行），要么把
   这些行按 F-SH-001 的规则保持「列出 + 灰 + 命名原因」并写进 FMEA 的新行。
5. **A13 ⌘A**：已实测四次无果，建议在 issue 里留平台结论，或改用壳自己的 Edit 行作为唯一入口。

**P1（需要一点设计）**

6. **A5 Quick Look**（空格预览：Files/Dock/桌面共用同一个预览面）、**A6 menu bar extras**、
   **A8 拖拽贴边吸附**（复用 `snap_bounds`，只加指针路径）、**A9 桌面文件面**（文件图标 +
   拖放 + 废纸篓；`docs/files-trash.md` 的台账已经在）、**A12 全屏 = 独立 Space**。
7. **B1 原生通知桥**、**B2 Tauri updater + 签名**（桌面端先做，见 FEATURE_GAP §6 第 10 条）。

**P2（产品 / 外部依赖）**

8. B3 多用户、B4 系统级 IME（独立 `InputMethodService` APK）、B5 跨设备剪贴板、B6 分享面板。
9. C1/C2 先定协议再动手；C3 是第三方 bundle 生态的**准入条件**。
10. D1/D2：Windows/Linux 菜单与打包 —— 需要一次「我们是否发布非 macOS 桌面」的明确决定。

**不建议做**：HAL / 驱动 / RIL / PMIC / 协议栈（平台已提供，见 `docs/no-ui-android.md`）；
重写已成熟的领域内核（radio / telephony / sensor / audio / appstore…）。

---

## 7. 复现（本页每条结论对应的命令）

```bash
# A1 最小化 = 隐藏 + Dock 过滤 Hidden
grep -n 'wmHide' crates/amos-tauri/frontend-ts/src/svelte/DesktopShell.svelte
grep -n 'state !== "Hidden"' crates/amos-tauri/frontend-ts/src/svelte/{Dock,MissionControl}.svelte
grep -n '\.hide()' crates/amos-tauri/src/wm.rs

# A2/A3 灰行（per-app 菜单 / 打印 / 前置全部窗口 / 撤销）
grep -n 'Unavailable\|file.print\|bringAllToFront' \
  crates/amos-tauri/frontend-ts/src/svelte/modules/TopbarMainMenu.svelte

# A4/A5/A6/A7/A10 没有的几处
grep -rn -i 'screencapture\|screenshot' crates/amos-tauri/src crates/amos-tauri/frontend-ts/src
grep -rn -i 'quicklook' crates/
grep -rn 'TrayIcon' crates/amos-tauri/src
grep -rn -i 'stageManager\|pictureInPicture' crates/amos-tauri/frontend-ts/src
grep -rn -i 'stack' crates/amos-tauri/frontend-ts/src/lib/dockPrefs.ts

# A11 轮询周期
sed -n '13p' crates/amos-tauri/frontend-ts/src/lib/wmWindowsPoll.ts

# A12 全屏 vs Spaces
grep -n 'fullscreen' crates/amos-tauri/src/spaces.rs \
  crates/amos-tauri/frontend-ts/src/lib/spaces.ts

# B2 无 updater / 打包范围 / CI 目标
grep -rn 'updater' Cargo.toml crates/*/Cargo.toml
grep -n 'targets' crates/amos-tauri/tauri.conf.json
grep -rn 'runs-on' .github/workflows/*.yml

# C1/C3 半成品台账
cat crates/amos-tauri/frontend-ts/scripts/unwired-allowlist.json
cat scripts/tauri-command-allowlist.json
```

---

**审计人**：Cline（本次会话 · 只读 + 报告）
**实测时间**：2026-09-20
**未做**：未修改任何生产代码；未做真机 / GUI 验证（本机只有 macOS 桌面会话，无 Android 设备）。
本页不重复 `docs/FEATURE_GAP_AUDIT_2026_SEP20.md` 的「消费级 App 空缺」与「底层 OS 职能」两节，二者互补。
