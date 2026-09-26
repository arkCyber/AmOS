# 桌面操作系统功能审计 — 2026-09-21

**回答的问题：**「桌面操作系统功能完善了吗？」

**一句话回答：** 桌面外壳（窗口管理、Dock、启动台、聚焦搜索、任务控制、控制中心、通知中心、锁定屏幕、多空间、热角、通知、设置）**已经是完整且互相连通的**，305 个宿主命令全部有前端注册点、无悬空命令。它不是「还缺一半」的状态——缺的是 **六类系统性能力**（打印、Quick Look 手势、托盘/菜单栏常驻、真正的多用户、系统级输入法、跨设备剪贴板），以及 **真机 GUI 验证**。本轮审计修掉 3 个真实缺陷，其中 1 个是本轮新发现的、会在 Linux CI 上直接编译失败的问题。

---

## 0. 方法与诚实边界（先读这一节）

这份报告里的每一条断言都附了产生它的**探针**。规则：

1. **以 `git show HEAD` 为准，不以工作树为准。** 工作树里有并发轮次（其他 agent session）正在改的 `deviceMic.ts` / `hostFs.ts` / `wm.rs`。凡是我在 HEAD 上验证不到、只存在于工作树里的现象，一律标注「外来、未处理」，不计入本轮结论。
2. **失败要报，跳过也要报。** 见 §6。
3. **区分「没实现」「实现了但没接上」「实现了、接上了、但没人验证过」。** 这三者对用户是完全不同的东西，本报告分别标注。

**本轮我做不到的事，明确列出：**

- 没有在真机上跑过 GUI（无 Linux/Windows 构建，未启动过 `Amos.app` 做交互验证）。所有「界面行为」结论来自代码 + 自动化测试，不是来自亲眼所见。
- CI 历史未核实：`gh` 未认证，无法查证 GitHub Actions 的实际运行记录。§4 里关于 CI 的结论只基于 `.github/workflows/ci.yml` 的内容本身。
- 并发轮次的改动可能在本文写作期间改变结论；标注为「外来」的部分我未触碰。

---

## 1. 已验证存在的能力（含锚点）

### 1.1 宿主命令层：无悬空命令

| 指标 | 数值 | 探针 |
|---|---|---|
| `#[tauri::command]` 定义数 | **305** | 逐文件解析属性行 + 紧随其后的 `fn` 名（313 个 grep 命中中 8 个是文档注释里的提及） |
| `generate_handler!` 注册数 | **305** | [`src/lib.rs:377`](../crates/amos-tauri/src/lib.rs#L377) 起的花括号块内逗号切分 |
| **定义但未注册** | **0** | 两个集合求差 |

零悬空命令是有意义的结论：它排除了「前端调用一个宿主没注册的命令」这一整类缺陷。注意这只证明**注册**，不证明每个命令都被前端**调用**（那是 `unwired:scan` 的职责，见 §6）。

### 1.2 外壳界面

- `src/svelte/` 下 **87** 个 `.svelte`，`src/svelte/modules/` 下 **27** 个。
- 底座模块清单在 [`src/svelte/shellModules.ts`](../crates/amos-tauri/frontend-ts/src/svelte/shellModules.ts)：**20** 个条目。
- 逐一确认存在的系统界面：`Launchpad.svelte`、`SpotlightOverlay.svelte`、`MissionControl.svelte`、`AppExpose.svelte`、`ControlCenter.svelte`、`NotificationCenter.svelte` / `DesktopNotificationCenter.svelte`、`DesktopStage.svelte`、`LockScreen.svelte`、Spaces 相关代码、`modules/HotCornersListener.svelte` + `lib/hotCorners.ts` + `settings/HotCornersPage.svelte`。

### 1.3 窗口管理

- [`src/wm.rs`](../crates/amos-tauri/src/wm.rs) **5600 行**（Tauri 适配层），纯状态机在 `amos-wm` crate。
- 最小化：`wm_minimize` 在 [`src/wm.rs:3138`](../crates/amos-tauri/src/wm.rs#L3138)，核心 `minimize` / `minimize_target` 在 `wm.rs:1408` / `:1376`。
- 吸附：`amos_wm::snap::{snap_bounds, SnapZone}` 被 [`wm.rs:23`](../crates/amos-tauri/src/wm.rs#L23) 引入，`wm.rs:2553` 调用 `snap_bounds(zone, work_area, core.policy.min_pane)`，`SnapZone::parse` 的 `None` 是拒绝而非猜测。
- 窗口列表推送：`wm-changed`（REQ-A717），见 §4 的 A11。

### 1.4 桌面集成（较新的一层）

`desktop_entry.rs`（524 行，纯 freedesktop `.desktop` 解析器，被 Wine 与 XDG 两处清单共用）、`linux_apps.rs`（365）、`wine.rs`（419）、`terminal.rs`（495，`terminal-pty` feature 门控）。另有 `screenshot.rs`（277 行，命令注册在 [`src/lib.rs:571`](../crates/amos-tauri/src/lib.rs#L571)）、`spaces.rs`、`dock_badge.rs`、`window_background.rs`、`window_state.rs`、`menu.rs`。

### 1.5 测试资产

| 层 | 数量 | 位置 |
|---|---|---|
| 前端单元（`bun:test`） | **174** 个测试文件 | `frontend-ts/src/__tests__/` |
| 前端组件（vitest） | **143** 个测试文件 | `frontend-ts/svelte-tests/` |
| Rust | `cargo test -p amos-tauri`，见 §6 | `crates/amos-tauri/tests/` |

---

## 2. 已验证缺失的能力（含探针）

以下每一项都是**全仓 grep，命中数为 0**——缺失是确凿的，不是「我没找到」：

| 能力 | 探针（在 `crates/amos-tauri/src` + `frontend-ts/src` 下） | 命中 |
|---|---|---|
| Quick Look（空格预览） | `QuickLook` / `quick_look` | 0 / 0 |
| 托盘图标 / 菜单栏常驻 | `TrayIcon` / `tray_icon` / `menuBarExtra` | 0 / 0 / 0 |
| Stage Manager | `StageManager` / `stage_manager` | 0 / 0 |
| 画中画 | `PictureInPicture` / `picture_in_picture` | 0 / 0 |
| 打印管线 | `print_pipeline` / `PrintDialog` | 0 / 0 |

**两处需要说清楚的细微差别**（「缺失」不等于「什么都没有」）：

- **预览渲染已存在，缺失的是系统级手势。** [`src/files.rs:593`](../crates/amos-tauri/src/files.rs#L593) 有 `files_preview_bytes`，其核心 `preview_core`（`files.rs:355`）会分类 MIME、解码文本、路由图片/音频/视频。缺的是「在任意窗口按空格浮层预览」这个**手势**。所以 A5 的准确说法是「无空格键 Quick Look」，不是「无预览」。
- **托盘确实完全没有。** `src/*.rs` 里 `tray` 的命中全是 `stray`（`desktop_features.rs` 的「杂散变量」）造成的假阳性——`stray_vars`、`a stray token`。逐条看过，无一与托盘有关。A6 成立。**（2026-09-21 更新：本条已被 REQ-A864 部分关闭——系统自己的那一半做了，见 §8.6。）**

**同样成立、需要保留的缺口：**

- **桌面不是真正的文件面。** `DesktopStage.svelte` 有图标网格、拖拽、布局持久化、⇧-点选锚点、键盘 listbox 焦点——但它背后**不是**一个真实目录：全仓没有 `desktopItems` / `files_list_dir` 之类的「读桌面目录」路径。图标是应用快捷方式，不是文件（A9 成立）。
- **没有真正的每应用菜单模型。** `menu.rs` 里确有 `sync_window_items`（[`menu.rs:230`](../crates/amos-tauri/src/menu.rs#L230)），但它做的是**窗口类菜单项的启用/禁用同步**（REQ-A433：只有启动台时 `Close Window`/`Minimize`/`Zoom` 该灰掉）——是**一个**应用菜单在跟着焦点变灰，不是「菜单栏换成当前应用的菜单」（A2 成立）。
- **Dock 无叠放（stacks）**：`Dock.svelte` 中 `stack` 命中 0（A10 成立）。

---

## 3. 本轮修复的三个缺陷

三个都记入 FMEA 与变更日志：`F-SH-235` / `F-DEV-095`，需求号 `REQ-A783` / `REQ-A785` / `REQ-A786`。

### 3.1 REQ-A783 — Dock 废纸篓磁贴是个「看着能按、按了没用」的控件

**这是 F-SH-001 家族**（有控件的外观与无障碍语义，行为却是空）。

- **修复前：** 磁贴被**置灰**，理由是「`wm_open(label)` 只带一个标签，所以 Dock 磁贴打不开**另一个窗口的废纸篓面板**」。
- **这个理由对 `wm_open` 成立，对整个外壳不成立。** 跨窗口意图通道（REQ-A458，先例是 `amos.files.reveal`）本来就能通过共享 store 携带「目标窗口**内部**的目的地」。目的地正是废纸篓磁贴唯一需要的东西。
- **修复：** 新增 `amos.files.view` 意图键（[`src/lib/files.ts`](../crates/amos-tauri/frontend-ts/src/lib/files.ts) 的 `FILES_VIEWS` / `FilesView` / `normalizeViewIntent`），`appLinks.ts` 的 `openFilesAt(view)` **先写意图、后开窗**（顺序是必需的：窗口还不存在时，`createStoreValue` 用已存储的值播种），`DockTrashItem.svelte` 改为先 `openFilesAt("trash")` 再 `wmOpen("files")`，`FilesApp.svelte` 订阅并落到对应面板、然后清除意图。
- **三段式纪律**：意图键是**命令不是状态**，被服务后清空；登记为 `derived`，**不**进 `SYNC_STORES`——备份不该重放一个几天前的目的地。
- **写了返回值就得接住**：`openFilesAt` 返回写是否成功，`DockTrashItem` 读它并在失败时打 `🛟 [Dock]` 面包屑，**仍然开窗**（用户要的是一个窗口，窗口就是能给的东西；因为目的地面板没设上就拒绝开窗，会把「部分满足」变成「完全不满足」）。这是 `write:scan` 的强制要求，不是口味问题。

**负控制（证明新测试真的有判别力）：** 违反源码 → 观察红色数 → 逐字节还原 → md5 校验一致。

| 注入的缺陷 | 期待的红色数 | 实测 |
|---|---|---|
| 写错的面板（不是 `trash`） | 1 | 1 ✅ |
| `applyView` 改成空操作 | 3 | 3 ✅ |
| 去掉 nonce 去重守卫 | 1 | 1 ✅ |

### 3.2 REQ-A785 — 非 macOS 平台上 `amos-tauri` 编译失败（`HEAD` 上真实存在）

- **`git show HEAD` 上的真实缺陷：** [`src/lib.rs:311`](../crates/amos-tauri/src/lib.rs#L311) 与 `:513` 无条件引用 `menu::`，但 `menu` 模块的声明在 HEAD 上带 `#[cfg(target_os = "macos")]`（HEAD 的 130–137 行）**且没有孪生声明**。而 `menu.rs` 自己对四个符号提供了 `#[cfg(not(target_os = "macos"))]` 孪生实现（`menu.rs:362` 等）——也就是说**模块本身准备好了跨平台，是模块声明没跟上**。
- **修复：** 去掉三处声明的 `#[cfg]`（`lib.rs:183` `menu`、`:185` `window_background`、`:187` `window_state`），并加注释说明。
- **这件事为什么重要：** CI（[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)）**只在 `ubuntu-24.04` 上跑**（`make lint` / `make test` / `make cov`），而 `crates/amos-tauri` 是 workspace 成员。也就是说：**这个缺陷在 CI 的配置下就会命中**，而 macOS 上的本地开发永远看不到它。
- **诚实边界（重要）：** 我先前量到的「非 macOS 13 个错误」是对**工作树**量的，其中 2 个来自并发轮次在 `wm.rs` 里加的**无条件** `use crate::{window_background, window_state}`（HEAD 上不存在）。所以：**以 HEAD 为根的 11 个错误是真实的（其中 `lib.rs:311`/`:513` 是核心），另外 2 个是外来的**。我没有把外来的 2 个算进这次修复。
- **我没有声称的：** 修完之后 `amos-tauri` 在 Linux 上能**跑起来**。去掉 `#[cfg]` 只解决编译期可达性；Tauri 的 Linux 运行依赖（webkit2gtk 等）是否齐备、运行时行为如何，未在本机验证（无 Linux 环境）。
- **2026-09-21 续篇更正（REQ-A866／F-DEV-117，见 §8.7）：** 这一节的措辞「非 macOS 平台上编译失败」在**当时读起来像「非 macOS 都好了」，而它对 Android 不成立**。上面那次测量是在**宿主**上做的（ubuntu-24.04 是 `desktop`），去掉 `pub mod menu;` 的 `#[cfg]` 对 Linux/Windows 成立，**同时**把 `menu.rs` 变成在 Android 上也编译，于是 `menu.rs:52` 的 `use tauri::menu::{…}`（`tauri::menu` 自身是 `#[cfg(desktop)]`）第一次可达。`make android-app-check`——**恰恰是 F-WM-019 为这个形状立起来的那盏门**——实测 **REAL_EXIT=101**。正确的说法是「修好了 Linux/Windows」，不是「修好了非 macOS」。

### 3.3 REQ-A786 — 孪生测试漂移

`orig-test.test.ts` 与 `desktop-shell.svelte.test.ts` 是同一批断言的两份拷贝。3.1 改变磁贴语义后，两份拷贝里「磁贴必须是禁用的」断言（`trash.disabled === true` + `aria-disabled === "true"`）都过期了，各 3 处 `desktop.trashInFiles` 键也随文案改名（→ `desktop.trash`）失效。两份都已同步，并留注释说明**为什么**语义变了——避免下一轮有人看到「禁用断言没了」而误以为是回归。

---

## 4. 对 `docs/DESKTOP_GAP_ANALYSIS_2026_SEP20.md` 的更正

该文档的部分条目已经被后续轮次修掉了，**原因过期比没有原因更糟**（它会把读者支去寻找一个已经存在的功能）。以下是本轮核实为**已过时**的条目：

| 条目 | SEP20 的说法 | 现状（本轮探针） |
|---|---|---|
| **A1** | ⌘M 是「隐藏」而非「最小化」，且 Dock 过滤掉 Hidden 状态 | **已过时。** `wm_minimize` 存在（`wm.rs:3138`），Dock 已**不再**过滤 `Hidden`——[`Dock.svelte:252-253`](../crates/amos-tauri/frontend-ts/src/svelte/Dock.svelte#L252-L253) 的注释逐字记录了这次更正的理由 |
| **A4** | 没有截图能力 | **已过时。** `screenshot::screenshot_capture` 存在并已注册（[`lib.rs:571`](../crates/amos-tauri/src/lib.rs#L571)） |
| **A11** | Dock 靠 5 秒轮询 | **已过时。** [`lib/wmWindowsPoll.ts:29`](../crates/amos-tauri/frontend-ts/src/lib/wmWindowsPoll.ts#L29) 的 `WM_WINDOWS_POLL_MS = 30000`，且 `wm-changed` **推送**（REQ-A717）才是延迟来源，轮询已降级为「慢速对账」 |
| **A13** | macOS 上 ⌘A 无效 | **已过时。** [`lib/editKeys.ts`](../crates/amos-tauri/frontend-ts/src/lib/editKeys.ts)（REQ-A439）在真机上用 AX 量过（⌘C/X/V/Z 有效、⌘A **无效**，以 TextEdit 为对照），并由外壳自己实现该手势：`input`/`textarea` 选自身值、`contenteditable` 选内容、**其余情况保留按键**（桌面 UI 没有「全选整个页面」的语义，抢占只会造出又一个死键） |
| **A3 / A5** | 无打印 / 无 Quick Look | **仍成立，但措辞需精确**：见 §2 的两处细微差别（预览渲染存在，缺的是手势） |

**其余条目本轮核实后仍然成立**：A2（无每应用菜单模型）、A6（无托盘；**2026-09-21 部分关闭**——见 §8.6）、A7（无 Stage Manager / 画中画）、A8（吸附**只有键盘一条路**——`snap_bounds` 在，但唯一的入口是 [`DesktopShell.svelte:591`](../crates/amos-tauri/frontend-ts/src/svelte/DesktopShell.svelte#L591) 的 `snapZoneFor(e)`，在 keydown 处理里，修饰符 ⌃⌥；没有拖到屏幕边缘的鼠标路径。**2026-09-21 更正为「部分关闭」**：REQ-A816 给九个区域补上了**菜单**这条鼠标前门——见 §8.5；**拖到屏幕边缘仍然没有**，本条的措辞改为「鼠标只能经菜单，手势仍然只有键盘」）、A9（桌面非文件面）、A10（无 Dock 叠放）、A12（全屏未成为独立 Space）、B1–B6、C1–C4、D1–D3。

---

## 5. 剩余缺口，按「对用户的实际影响」排序

1. **打印管线完全没有**（A3）。这是桌面 OS 最显眼的缺失：`grep -n "print\|打印" src/menu.rs` → **0 命中**，`File` 菜单里连一行「打印…」都没有（这比「灰着的一行」更彻底——用户看不到这条路存在），也没有 CUPS/IPP 客户端与打印对话框。**2026-09-22 部分关闭（REQ-A869，见 §8.8）**：宿主侧现在有一条真正的打印命令（`print.rs::print_document`，目标由 `wm.rs::focused_target_label` 解析），壳的两处入口——原生 `File` 菜单的 `ids::PRINT` 与应用内 `file.print` 行——都通向它。**本条原文有两处需精确**（§8.8 里详述）：①那次 `grep` 只覆盖**原生**菜单，而应用内菜单是另一处代码，`file.print` 那一行自 **REQ-A482** 起就存在（§8.6 提到的那一轮的交付物），所以「用户看不到这条路存在」在 §5 落笔之后不再成立；②那一行的实现是 `window.print()`，而它打的是**桌面**。**仍未做**：CUPS/IPP 客户端、打印机选择 / 页边距 / 份数那一层 UI、以及**一次真机打印**（D3）。故本条从「打印管线完全没有」改为「**打印管线只有一层前门**」。
2. **真机 GUI 验证为零**（D3）。这是**本轮最该说的一句实话**：上面所有「界面行为正常」的结论都是代码 + 自动化测试推出来的，没有一次是在真实 `Amos.app` 里用眼睛确认的。自动化测试覆盖不了的，正是真机才会暴露的那一类问题（焦点、层级、平台原生控件的实际观感）。
3. **托盘只有系统自己的**（A6）。影响的是「后台常驻类应用」这一整类软件的可用性。**2026-09-21 部分关闭（REQ-A864，见 §8.6）**：系统自己的那一半做了（状态项 + 「显示桌面」／「退出」，无窗口时壳终于可达）；**第三方的半——商店装的应用自己放一个状态项——仍未做**，故本条从「无托盘 / 菜单栏常驻」改为「**托盘只有系统自己的**」。
4. **无 Quick Look 手势**（A5）。影响文件浏览的手感，但不阻塞任何工作流。**2026-09-22 部分关闭（REQ-A789／F-SH-237，本轮补记）**：Files 应用那一半早已交付——⌘/Ctrl+Y 与每一行的预览按钮都通向真正的预览面板（`aria-keyshortcuts` 也宣告了它），且那一轮**明确不用空格**：Space 已被本界面的 ARIA listbox 选择切换占用（`onToggle` 已向读屏用户宣告「Space = 切换选中」），抢过来要么破坏选择、要么让同一个键的含义取决于用户看不见的 mode。**定位句的更正**：本条的准确定义与 §2 一致——缺的是**系统级的空格浮层**（任意窗口按空格预览），所以「无 Quick Look 手势」应读作「**无系统级 Quick Look 浮层**」。顺带（REQ-A873／F-SH-281）：审计这剩下的一半**脚下的预览读取接缝**时量到三处真缺陷（「读不到」被说成确定答案），见 §8.10。
5. **无每应用菜单模型**（A2）。这是 macOS 体验的核心一环，也是**最大的一块架构级工作**（不是补丁，需要菜单模型重构）。
6. **无多用户、无系统级输入法、无跨设备剪贴板、无分享面板**（B3–B6）。
7. **半成品**（C1–C4）：云同步、远程推送、第三方沙箱授权、蜂窝/GNSS 宿主命令。
8. **打包与 CI 覆盖面**（D2）：CI 只有 Linux 一条腿，而产品的主要形态是 macOS/Windows/Android。§3.2 的缺陷正是这个覆盖缺口的直接产物。

---

## 6. 测试证据与诚实边界

**宿主（Rust）：** `cargo test -p amos-tauri --no-fail-fast` → **exit 0**，**20 个测试套件、814 通过、0 失败、0 忽略**，日志里 `error`/`panicked at` 命中数为 **0**。

> 此前两次运行需要说明：一次 `make test` 在 `load_test.rs` 中途**被截断**（0 失败，但没有跑完——截断的绿不是绿）；一次后台运行退出码 0、无失败，但其日志经过了过滤管道，不足以作为完整计数。上面的数字来自**未过滤**的第三次运行（`/tmp/amos_tauri_full_921.log`）。

**前端（本轮改动直接覆盖的部分）：**

| 运行 | 结果 |
|---|---|
| `npx vitest run svelte-tests/files.svelte.test.ts svelte-tests/dock-widgets.svelte.test.ts` | **2 文件 / 50 测试 通过** |
| `bun test src/__tests__/files.test.ts` | **34 通过 / 0 失败**（含 `normalizeViewIntent` 的 3 条） |
| `node scripts/write-scan.mjs` | **OK** — 150 次写调用、**0 个写了却不接返回值**（本轮修复前 `openFilesAt` 是其中一个） |
| `node scripts/vocab-mirror-scan.mjs` | **OK** — 491 文件、0 处重复词表 |
| `node scripts/fmea-gen.mjs --check` | **[OK]** — 464 条失效模式，缓解措施全部在代码里找到（含 `F-SH-235` / `F-DEV-095`） |
| `node scripts/trace-scan.mjs` | **OK** — id 唯一、状态合法、每行有证据 |
| `node scripts/store-scan.mjs` | **仍红，但只剩 `amos.host_fs.*`**（外来，见下）；`amos.files.view` 的失败已消除 |

**未跑 / 跑不动的：** `make test`（全 workspace）本轮只跑了 `-p amos-tauri`；`make cov`、真机 GUI、Linux/Windows 构建均未执行。**不要把上面 814 个通过的测试读成「桌面 OS 在真机上没问题」**——它们证明的是「代码在它能被测的层面上自洽」。



**本轮发现、但属于并发轮次的一条门禁红灯（附精确诊断）：**

`node scripts/docs-link-scan.mjs` 在当前工作树上 **exit 1**，5 条 FAIL：

```
FAIL — CHANGELOG.md  ->  crate::keyexpr::Channel
FAIL — CHANGELOG.md  ->  Self::index
FAIL — CHANGELOG.md  ->  计划中
FAIL — CHANGELOG.md  ->  path
FAIL — CHANGELOG.md  ->  path
```

这条门是**接线**的（[`Makefile:571`](../Makefile#L571)，`make lint` 里），所以它让 `make lint` 变红。

**但它不是 HEAD 的状态，也不是我的改动：**

1. **HEAD 是绿的。** 把 HEAD 干净导出到临时目录（`git archive HEAD | tar -x`）后跑同一个脚本：`493 markdown file(s), 727 relative link(s) checked` → **`OK — every relative link resolves`**。
2. **我的三条 CHANGELOG 条目里一个 markdown 链接都没有**（`grep -c ']([^)]*)'` = 0）。
3. **把这三条从文档里删掉，反引号「段长奇偶性」不变**（两种情况下都是同一组不配对的反引号段）——即我的改动对这条红灯是**中性**的。

**机制（可复查）：** `stripCode` 用 `` /(`+)([\s\S]*?)\1/g `` 配对反引号——**非贪婪、跨全文**，把长度为 N 的反引号「段」与**下一个同样长度 N 的段**配对。于是文档里只要有**一个**长度不合群的孤立反引号段，配对就会从那里开始整体错位一位，**该段之后**本该被当作行内代码剥掉的文本会重新变成「活文本」。CHANGELOG 里恰好有描述这条门自身语法的散文（`` `[x](path)` ``），错位后它被当成真链接，于是 `path`、`计划中`、`crate::keyexpr::Channel` 一起变红。

**这是一条关于门禁本身的发现**，比那 5 条误报更值得记：**门禁会把「文档引用了一段行内代码」误判成「文档有一个死链」**，而误报的形状与真缺陷完全一样——一个作者看到 `FAIL — CHANGELOG.md -> path` 会去找一个并不存在的 `path` 文件。修法在 CHANGELOG（让反引号段配平）或在 `stripCode`（按行配对，或对孤立段显式报警而不是静默错位）。**我没有改 CHANGELOG.md**：那一行属于另一个正在写这个文件的轮次，改它等于制造丢失更新。诊断在此，交还给它的作者。

**并发轮次造成的其他噪声（必须区分，否则会误判我的改动）：**

- `unwired:scan` 报 `src/lib/deviceMic.ts::IDLE_MIC_BACKEND` 未接线 + 1 条基线已接线。**外来**：`deviceMic.ts` 在工作树被改，且 HEAD 上不存在 `IDLE_MIC_BACKEND`。未触碰。
- `store:scan` 余下 7 条失败全部是 `amos.host_fs.*`，来自另一轮进行中的 `hostFs.ts` 重写。**外来**，与 `amos.files.view` 无关（该键的失败已消除）。

**本轮我自己引入并修掉的三个门禁失败**（记录以免下一轮重复踩）：

- `vocab-mirror-scan`：类型 `FilesView` 与 `as const` 数组 `FILES_VIEWS` 把同一套 4 个字符串字面量写了两遍。改为**由数组派生类型**（`type FilesView = (typeof FILES_VIEWS)[number]`），并在运行时的 `includes` 查找处放宽为 `readonly string[]`。
- `store-scan`：`amos.files.view` 不在 `SYNC_STORES` 也不在允许清单。按 `amos.files.reveal` 的先例登记为 `derived` 并写明 `why`。
- `write-scan`：`openFilesAt()` 的返回值被丢弃。改为读它并打面包屑。

---

## 7. 结论

**「完善了吗？」——外壳层面：是。系统性能力层面：不是。**

- **外壳本身是完整且连通的**：305 个命令零悬空，20 个底座模块，Dock/启动台/聚焦/任务控制/控制中心/通知中心/锁屏/多空间/热角/设置齐备，窗口管理 5600 行状态机 + 纯 crate 化的几何与吸附。这不是「演示品」的完成度。
- **缺的是 6 类系统性能力**（打印、Quick Look 手势、托盘常驻、每应用菜单、多用户/输入法/跨设备剪贴板、分享面板）——它们都是**整块的功能**，不是零散的 bug。缺哪一块对用户是可见的，但不影响「这是一台能用的桌面」。
- **最大的真实风险不是功能缺失，是验证缺失**：本轮所有结论都建立在代码与自动化测试上，没有一次真机 GUI 确认；而 §3.2 那个「只在 Linux CI 上炸」的缺陷恰好说明，**没被跑过的那条路径就是会烂掉的那条**。

**本轮交付：** 3 个缺陷修复（`REQ-A783`/`A785`/`A786`，`F-SH-235`/`F-DEV-095`），全部带负控制证据；4 条过时条目更正（A1/A4/A11/A13）；305/305 命令的注册完整性证明；6 类缺失能力的零命中证明；1 条**门禁自身的**脆弱性诊断（`docs-link-scan` 的反引号配对错位，§6）。

---

## 8. 更新（2026-09-21 晚，同一轮审计的续篇）

§1–§7 写作于当天早些时候，是**当时**的记录，不改写。下面是此后重探得到的三件事——其中两件是**上面那份报告里已经不成立的断言**，一件是本续篇新交付的工作。

### 8.1 §1.1 的宿主命令计数已过期：305 → **306**（零悬空的结论**不变**）

重探（探针与 §1.1 同源，逐项核对而非取总数）：

| 指标 | 数值 | 探针 |
|---|---|---|
| `#[tauri::command]` 属性行 | 315 | `grep -rn '#\[tauri::command\]' crates/amos-tauri/src/` |
| 其中的**文档注释提及** | 9 | 属性行数 − 紧随其后的 `fn` 名数 |
| **命令定义数** | **306** | 属性行后 2 行内的 `fn` 名 |
| **`generate_handler!` 注册数** | **306** | 花括号块内逗号切分：**296** 条裸标识符 + **10** 条 `#[cfg(desktop)]` 门控（`wine::`×3、`linux_apps::`×3、`session::`×3、`menu::shell_about_panel`） |
| **定义但未注册** | **0** | 两个集合求差 |

**+1 的那条是 `menu::shell_about_panel`**，为 REQ-A796／F-SH-241（苹果菜单「关于本机」）所加，同一行注册块里留着它的注释。**这里记一笔方法上的教训**：§1.1 当时用「313 个 grep 命中 − 8 个文档提及」推 305，而这次逐项求差才看清注册块里有 10 条带 `#[cfg(desktop)]` 的条目——**总数相减会掩盖集合的构成**，而正是这 10 条让「注册数」不等于「裸标识符数」。零悬空的结论在两种算法下都成立。

### 8.2 §6 那条「门禁自身的缺陷」**已经修好了**（本节推翻 §6 的结论）

§6 诊断的是 `scripts/docs-link-scan.mjs::stripCode` 的反引号配对：非贪婪、**跨全文档**，孤立的长度不合群的反引号段会让其后的配对整体错位一位，把行内代码重新变成活文本，于是文档里的 `` `[x](path)` `` 变成一条指向不存在的 `path` 的死链。§6 给出的修法是「在 CHANGELOG 里配平，或在 `stripCode` 里按行配对」。

**该修法已经落在 `stripCode` 里**（锚点）：

- [`scripts/docs-link-scan.mjs:157`](../scripts/docs-link-scan.mjs#L157) `stripCode` 现在**按空行分段**（`split(/(\n[ \t]*\n)/)`），每个 **段落内部**调用 `stripInline` —— 配对被限定在一段之内，孤立段不再能错位其后整篇文档。
- [`scripts/docs-link-scan.mjs:117`](../scripts/docs-link-scan.mjs#L117) `stripInline` 改为**精确段长配对**（`runs[c][0].length === len`），且配对后**跳到该 span 之后**（`a = b`）——注释里写明理由：让不同长度的段各自独立配对会**重叠**，重叠的剪切表会让输出把已删除的区域重新吐出来，那正是「代码 span 里的 `[x](y)` 又变回链接」的泄流点。

当前 `node scripts/docs-link-scan.mjs` ⇒ `OK — every relative link resolves`（511 个 markdown 文件、757 条相对链接）。**§6 的结论「门禁会把行内代码误判成死链」对今天的代码不再成立**；它作为一条**历史诊断**仍然有价值（那是这条门当时真实的行为），但不应再被当作现存缺口阅读。

### 8.3 本续篇交付的两个缺陷（REQ-A806／A807）

| ID | 缺陷 | 一句话 |
|---|---|---|
| REQ-A806 / F-SH-247 | 「API 集成」把每一次保存都称作「配置已保存」，包括被存储拒绝的那些；Webhook 模态对着被拒的写入也照样关 | 三条保存入口全返回 `void`，`writeStoreValueChecked` 的布尔被丢弃，拒绝只走到一个零读者的 `console.*` 包装。修法：返回 `boolean` + 按落地与否分别给「已保存」／「**已生效但没存进去**」，Webhook 侧拒绝时不关模态 |
| REQ-A807 / F-SH-249 | 企业功能族的**唯一**日志通道就是那个零读者的 `console.*` 包装，而它播报的是「模板写入被存储拒绝 —— N 个模板重启后会丢失」「审计日志写入被存储拒绝 —— N 条重启后会丢失」「Webhook failed after N attempts」等 36 处 | 这是 REQ-A806 的**根因**：上一个缺陷之所以要给 `api.ts` 手工加**第二个**通道，正是因为 `logger` 结构上到不了屏幕。修法：`enterprise/logger.ts` 重写为 `lib/debugLog::diag` 的**适配器**（`diag` 本就在对应级别 console 输出，账本是纯增量），并撤掉那条手工通道；顺带发现守 `logger.debug` 的 `window.DEBUG_MODE` **全仓无人赋值**、即那个级别由构造不可达 |

两条都带**两轮活负控**（逐字节还原 + `shasum -a 256`）：REQ-A806 的「把屏幕改回无条件报已保存」⇒ DOM 恰 2 红；「在写入前加 `|| true`」⇒ 库侧恰 3 红 + DOM 恰 1 红而 webhook 路径保持绿。REQ-A807 的「只把 `logger.error` 改回 `console.error`」⇒ 新套件恰 3 红 **且 REQ-A806 的库侧恰 1 红**（证明上一轮的测试确实骑在这条信道上）；「把整个文件还原成修复前的 25 行」⇒ 新套件**恰 6 红 / 0 绿**。

全量门禁现状：`bunx tsc --noEmit` exit 0；`bun run typecheck:svelte` **1443 FILES 0 ERRORS 0 WARNINGS**；`bun run test` OK；`bun run test:svelte` **147 files／1696 例全过**；`fmea-gen --check` OK（**484** 条）；`trace-scan`／`docs-link-scan` OK；前端 9 条 `*-scan` 全 OK。**两处既有红与这两轮无关**（已对 `git show HEAD` 核实）：`store-scan` 的七条 `amos.host_fs.*`（另一轮的 `hostFs.ts` 重写）、`unwired-scan` 的 `deviceMic.ts::IDLE_MIC_BACKEND`（另一轮的 `deviceMic.ts`）。

### 8.4 §7 结论的修订

§7 说「最大的真实风险不是功能缺失，是验证缺失」。本续篇要在这句话后面补一句**同源的**：**第二大的风险是「有一句话负责告诉用户某件事，而那句话到不了用户」**。REQ-A806 与 REQ-A807 是同一个缺陷的两半——屏幕对着被拒的写入说「已保存」，而唯一说出真相的信道是一个没有人读的 console。这两半都不是靠真机 GUI 跑一遍能发现的：**界面上没有任何东西看起来不对**。

**§8.3 未做的事，同样列出**：①没有为「这条记录有没有读者」这一整类新增门禁——前端生产代码里仍有约 30 个文件直接调 `console.*`，做全量门禁是一次大迁移，本轮只把**企业功能族**接上了账本；②没有在打包后的 WebView 上实测 DevTools 不可见，§8.3 的前提由结构论证（`console.*` 无读者 + `debugLog` 有渲染点 `settings/AiPage.svelte::diagEntries`）；③`audit.ts`／`templates.ts` 的拒绝路径没有各自写集成用例，三条「重启后会丢失」靠同一条适配器覆盖而非逐句钉住。

### 8.5 后续补关：A8 的鼠标前门（REQ-A816／F-SH-256）

§4 那条「吸附只有键盘一条路」的 A8，本轮**部分**关闭。

| ID | 缺陷 | 一句话 |
|---|---|---|
| REQ-A816 / F-SH-256 | 窗口吸附（贴边摆位）从落地起只有**一条前门**——⌃⌥ 和弦一族：几何（`amos_wm::snap::snap_bounds`）、宿主命令（`wm_snap`）、九个区域全都在，可一个不知道 Rectangle 那套键的人**没有任何办法**让窗口贴到左半边 | 加重情节是 `AMOS_DESKTOP_SHORTCUTS=disabled` 关掉的是「壳接管桌面按键」，而吸附**只**有按键这一条路 ⇒ 那台机器上吸附**整体消失**，而任何只看菜单／界面的复核都看不到这一点 |

**修法只加前门，不动任何既有路径**：`lib/snapZones.ts` 新增 `SNAP_ZONES`（`SNAP_KEYS.map(r => r.zone)`，那张表的**视图而不是第二份清单**）并导出 `snapShortcutLabel(zone)`；`ShellChromeApi` 新增 `snapWindow(zone)`（type-only 引入，不闭环），与和弦共用**同一条** `snapFocused`（同一条 F-SH-008 焦点规则、同一次 REQ-A424 陈旧轮询重读、同一句 `snapRefusal`），且**故意不受** `AMOS_DESKTOP_SHORTCUTS` 管辖（菜单行是按意的点击，相邻的 Zoom／Minimize 行也不受它管）；`TopbarMainMenu.svelte` 的 Window 菜单由 `SNAP_ZONES` **迭代生成**九行（中英各九键，键帽走 `snapShortcutLabel`）。证据：`snapZones.test.ts` **5 pass / 0 fail**、`topbar-main-menu.svelte.test.ts` **17 passed**（九行**逐行**用**字面量**键帽断言，点表两端两行断言到达宿主的正是 `wm_snap { label: "notes", zone }`）、`bunx tsc --noEmit` exit 0、`bun run test:svelte` **147 files／1697 例全过**、`bun run test` `[bun-iso] test OK`；**两轮活负控**（逐字节还原 + `shasum -a 256`）：每行恒传 `"left"` ⇒ 菜单用例**恰 1 红**；`snapShortcutLabel` 恒返回空串 ⇒ **两处共 3 红**。

**这一轮明确没做的**（与 §8.3 的写法一致）：①**没有拖到屏幕边缘**——它需要「指针在边缘释放」这个事件，而标题栏是 `data-tauri-drag-region`，REQ-A440 真机测过拖拽由**平台**跑，页面在拖拽期间拿不到指针流；**没有**用一个没人量过的阈值去近似它，本仓拒绝发运这种数字。故 A8 的措辞从「鼠标完全没有路」改为「**鼠标只能经菜单，手势仍然只有键盘**」。②**未做真机 GUI 复核**（D3 仍然是 §5 的第 2 条）。③**native macOS 的 Window 菜单仍无吸附行**：那里的 Minimize／Zoom 是 AppKit 预定义项，加吸附行要新增自定义 id + 转发 + `desktopKeys.test.ts` 的 REQ-A761 对账，是**独立一轮**。④`MenuRow` 是扁平的，故这九行是**分隔开的一组**而不是 macOS 的 *Move & Resize* 子菜单。

### 8.6 后续补关：A6 的系统托盘（REQ-A864／F-SH-277、F-SH-278）

§5 第 3 条「无托盘/菜单栏常驻」（A6），本轮**部分**关闭。它是 §5 高位项里唯一**零实现、无人接手**的一条（A3 打印轮由 REQ-A482 在写、A5 Quick Look 已有 REQ-A789、A11/A4/A1/A13 均已修），也是 §2 唯一被零命中探针核实过的一条：`grep -rn 'TrayIcon' crates/amos-tauri/src` → **0**。

| ID | 缺陷 | 一句话 |
|---|---|---|
| REQ-A864 / F-SH-277 | 壳在「一个窗口都没有」与「压在用户脸上」之间**没有第三种状态**——没有状态项，于是没有窗口时唯一值得做的两件事（把桌面叫回来、退出）根本没有地方可点 | §5 自己写的后果是「影响的是『后台常驻应用』这一整类软件的可用性」：一个没有窗口的壳，要么在用户面前，要么不存在，中间什么都没有 |
| REQ-A864 / F-SH-278 | `WmState::focus_launcher` 只 `show()` + `set_focus()`，**不先 `reveal_window`** | **在托盘存在之前这个洞够不着**——没有任何调用点会在平台把壳收走**之后**再去要它。托盘恰恰就是那个调用者，所以只做 F-SH-277 会让主路径仍然失败（点了「显示桌面」什么都不发生 = F-SH-001 的形状） |

**修法**：新建 `crates/amos-tauri/src/tray.rs`（状态项 + 菜单「显示桌面」／「退出」），`lib.rs::setup` 在菜单栏之前装一次，左键跑主操作、右键开菜单，图标取 `app.default_window_icon()` 且**不**用 `icon_as_template`（那是给单色状态字形用的，全彩应用图标的 alpha 掩码是一坨实心块，而本仓没有单色状态资产）。`ALL_IDS` 是**值**不是注释，`install` 在图标交给 OS **之前**跑 `compare_rows(&menu_row_ids(&menu))`，两个方向都查——无行的声明 id 是一行**永远不会触发**的行（REQ-A423 的教训），无声明 id 的行会落进 `tray_action` 的 `None` 臂。**为什么把比较拆成纯函数**：真菜单要活的 `Menu<R>`、要真运行时，而 **tauri 的 mock runtime 没有托盘**，写在遍历里的比较就只能靠跑 app 才被执行；拆开后「丢了一行」与「多了一行」这两种**必须被拒绝**的形状才都能交进测试。同一轮补上托盘自己的 **REQ-A437**（托盘按启动时的语言建好，改语言若只重画菜单栏就永远停在启动语言——`menu_set_locale` 现在顺带重建托盘，查不到托盘时**返回理由**而不是静默 no-op；`store::LOCALE_KEY` 提成常量）。

**证据**：`cargo test -p amos-tauri --lib tray::` ⇒ **10 passed / 0 failed**（集合相等而不是计数——`every_declared_id_has_an_action` 拿 `HashSet` 比 `resolvable == declared`，一个 floor 看不见「改名丢了一行、另一行还在」）；`cargo check -p amos-tauri --offline --all-targets` ⇒ **EXIT=0**；**五条负控**（逐字节还原 + `shasum -a 256`，`6db12c2c8651e8ecb980cc09f85b042bae1704a3d989d3c374f1ffe818509298`）：`SHOW_DESKTOP` 映到 `Quit` ⇒ 恰 2 红；`QUIT` 从 `ALL_IDS` 拿掉 ⇒ 恰 3 红；zh 的「显示桌面」写成 en 的 `Show Desktop` ⇒ 恰 1 红；`compare_rows` 改成无条件返回「没问题」⇒ 恰 3 红（**那件仪器非空洞**的证明）；`TrayLocale::parse` 默认改成 `En` ⇒ 恰 1 红。

**这一轮明确没做的**（与 §8.3／§8.5 的写法一致）：①**A6 的第三方半没做**——商店装的应用自己放一个状态项是另一件工作：它需要面向上层的注册 API（`lib/storeApps` 有清单，却**没有任何东西**从清单里消费一个托盘位）、一条「应用退出了，它那个项怎么办」的生命期规则、以及壳渲染一个不是自己写的项的方式。故 A6 从「无托盘」改为「**托盘只有系统自己的**」。②**Linux 上 appindicator 没有主点击通道**——工具包任何点击都开菜单，`show_menu_on_left_click(false)` 被忽略；那是平台的契约，不是我们选的降级。③**未做真机 GUI 复核**（D3 仍然是 §5 的第 2 条）：没有在真实桌面会话里点过这个状态项。④**F-SH-278 没有在本轮做可复现实测**——「平台最小化后 `show()` + `set_focus()` 不足以复原」是 REQ-A441 为**应用窗口**在真机量到的结论，本轮是把它**按同一条规则**应用到 launcher 原语上（`reveal_window` 是同一个函数、对未最小化窗口是 no-op），故记成「按 REQ-A441 的规则补全」而不是「本轮量到」。

### 8.7 新发现的缺口：本仓自己的 Android 交叉编译门是红的（REQ-A866／F-DEV-117）

做 §8.6 的系统托盘时顺手跑了一次 Android 交叉检查——因为 `tray.rs` 的每一处 `tauri::tray` 引用都在 `#[cfg(desktop)]` 后、`tray-icon` feature 也只对桌面目标开启，需要确认它在 Android 上真的被 cfg 掉。结果是 `tray.rs` 一次都没出现在编译日志里（本轮新增的模块在 Android 上编译干净），但**门本身是红的**。

| ID | 缺陷 | 一句话 |
|---|---|---|
| REQ-A866 / F-DEV-117 | `make android-app-check`（Makefile:1233 = `cargo ndk -t arm64-v8a -P 31 check -p amos-tauri --features android`，**在 `make verify` 里**）⇒ **REAL_EXIT=101**，4 个 error | 这盏门恰恰是 **F-WM-019** 为「桌面专属 API 未做 cfg 门 ⇒ 整个 APK 构建中断，而所有门都绿」立起来的仪器；它红着，而且**所有别的门都绿** |

**它从来没有绿过，所以这不是回归**：`HEAD` 上 `lib.rs:311` 无条件引用 `menu::menu_set_locale`，而 `pub mod menu;` 带 `#[cfg(target_os = "macos")]` ⇒ Android 上 E0433。本仓**唯一**验证过 android 特性的是**宿主** target（Cargo.toml 里那句「host `cargo check --features android` still validates that the wiring compiles」），而宿主是 macOS ⇒ `desktop` cfg 为真 ⇒ 整类「桌面专属 API」的错都看不见。

**§3.2 的修法对 Linux/Windows 成立、对 Android 不成立**：去掉 `pub mod menu;` 的 `#[cfg]` 让非 macOS 能编译（§3.2 的 11 个错误确实消失），但它**同时把 `menu.rs` 变成在 Android 上也编译**，于是 `menu.rs:52` 的 `use tauri::menu::{…}`（`tauri::menu` 自身是 `#[cfg(desktop)]`）第一次可达；`wm.rs:1020` 的 `unminimize()` 与 `wm.rs:1413` 的 `minimize()` 是 `tauri::WebviewWindow` 的桌面专属方法，Android 上根本不解析。**四条里有一条不属本条**：`sensor_host.rs:788` 的 `E0308` 来自**并行轮的未提交改动**（`git diff --stat HEAD` ⇒ 384 insertions，该轮自己已在 CHANGELOG 写明「本轮不碰，只如实记下」）——**本轮也不碰它**。

**本轮只登记，不修**，理由三条（不是跳过）：①修它要给 1924 行的 `menu.rs` 把满篇 `#[cfg(not(target_os = "macos"))]` 孪生逐条改为桌面条件并补 `not(desktop)` 桩、再给 `wm.rs` 的 `minimize`／`unminimize` 补门，是一次跨文件的 cfg 手术；②**修了也无法在本轮判绿**——`sensor_host.rs:788` 属并行轮，门仍会红，于是「改对了」与「改错了」在这一轮里**无法区分**，那比不修更糟；③本仓自己的规矩：半吊子判据比已知的盲区更危险。修法方向记在 F-DEV-117 的「当前缓解」里。

**证据**：`cargo ndk -t arm64-v8a -P 31 check -p amos-tauri --features android` ⇒ **REAL_EXIT=101**（`menu.rs:52` E0432、`sensor_host.rs:788` E0308【并行轮】、`wm.rs:1020` 与 `wm.rs:1413` E0599）；同一树的**宿主** target `cargo check -p amos-tauri --offline --all-targets` ⇒ **EXIT=0**——**两侧之差**就是本条的全部证据：门只在被指向真 Android target 时才看得见。


### 8.8 后续补关：A3 的打印管线（REQ-A869／F-SH-279、F-SH-280）

§5 第 1 条「打印管线完全没有」（A3），本轮**部分**关闭——它是 §5 按影响排序的第 1 位，§8.6 也记着它是当时唯一「有轮次在写」的高位项（「A3 打印轮由 REQ-A482 在写」）。**两处更正先写在前面**：

①§5 那句 `grep -n "print\|打印" src/menu.rs` → **0 命中** 测得属实，但它只覆盖**原生**菜单（`menu.rs`）——应用内菜单是另一处代码，而 REQ-A482 已经在 `TopbarMainMenu.svelte` 里加了一行 `file.print`，所以「`File` 菜单里连一行「打印…」都没有」「用户看不到这条路存在」这两句**在 §5 落笔之后就不再成立**（§5 的第 1 条已就地更正，写法与第 3 条一致）。②§8.6 提到的那一轮的**交付物**就是那一行，而它的实现是 `window.print()`——**打的是桌面**。

| ID | 缺陷 | 一句话 |
|---|---|---|
| REQ-A869 / F-SH-279 | `File ▸ 打印…` 的 `run` 里是 `window.print()`（注释写「works in the WebView」），而 `window.print()` 是**对发起它的那份文档**的调用 | 壳里**唯一**的 `menu-event` 订阅者 `DesktopShell.svelte` 只挂在 **launcher** 窗口（`Shell.svelte` 的 `s.kind === "app"` 分支走 `DesktopAppWindow`）⇒ 用户在应用窗口里看一份文档、按「打印…」，打出来的是**桌面**。同一个洞还有第二半：它**什么都报不了**（`window.print()` 无返回值，宿主侧连一条打印命令都没有），于是「这平台没有打印对话框」「没有焦点窗口」「宿主不在」三种**不同**的拒绝对用户和日志都不可分 |
| REQ-A869 / F-SH-280 | Windows/Linux 上壳**没有绑定任何打印和弦** | macOS 的 ⌘P 由**原生菜单**的 `CmdOrCtrl+P` 加速键提供（OS 拥有那个和弦，不经过 WebView）；Windows/Linux 没有原生菜单栏 ⇒ 只剩应用内那行，用户按 Ctrl+P 什么都不会发生。给键表加一条 `print` intent 要同时改宿主 `ACCELERATOR_ITEMS`、键盘设置界面与默认和弦（`desktopKeys.test.ts` 把 intent 集合钉成「恰好等于宿主的表」），是另一件工作 ⇒ **如实登记为残余**，那一行**故意不画 keycap**（F-SH-038 的规矩：不广告一枚本壳并不绑定的键，同 `file.screenshot`） |

**修法**：①宿主新建 `crates/amos-tauri/src/print.rs`（`pub mod print;` **无条件**、`print_document` 注册在**每个** target 上——「不可用」是**运行时事实**而不是 `cfg`，这是本仓对手机/平板壳的一贯写法）；②`print_document` 是**零参数**命令，目标由 `wm.rs::focused_target_label` 解析——那是 ⌘W／⌘M 已经在用的同一规则（`is_screen_window` 把 launcher 排除在外，所以桌面**永远**不是打印目标），WebView 从不命名一个宿主可能不认为是焦点的窗口（§2 D2）；③答**值** `AmosResult<PrintRequest { window, platform }>` 而不是 unit——Tauri 把 unit 序列化成 `null`，而桥把 `null` 读成失败，所以 `void` 命令的成功与失败同形（F-SH-053／REQ-A513）；④壳侧 `src/lib/print.ts::printDocumentWithDiag()` 保留判词，`printRefusalMessage()` 把三条 `amos.print.*` 码各翻成**一句自己的话**（三句**两两不同**是有测试钉的——一句话概括全部拒绝，会让「这平台没有对话框」与「平台调用坏了」在日志里读起来一模一样），`PrintRefusal = Extract<BridgeDiag, {ok:false}>` 把「成功也带 diag」那种形状从类型上排除，于是没有死分支、也没有静默的早返回；⑤两处入口（`DesktopShell.svelte` 的 `case "menu.print"` 与 `TopbarMainMenu.svelte` 的 `file.print` 行）都改走 `api.printDocument()`；⑥`menu.rs` 的 `WINDOW_ITEMS` 加上 `ids::PRINT`，`the_window_menu_items_are_declared_ids` 从 4 改 5 **并补上五个 id 的逐个成员判定**——计数是地板不是钉子（F-SH-277 那一轮的教训）。

**证据**：`cargo test -p amos-tauri --lib` ⇒ **823 passed / 0 failed**（其中 `print::` 与 `menu::` 各 18 例）；前端 `print.test.ts` ⇒ **6 passed / 19 断言**、`topbar-main-menu.svelte.test.ts` ⇒ **19 passed**（含改写的两条，以及本轮**新增**的一条：「a row with no binding draws no keycap, while its neighbour does」——把 `file.print` 与壳那张表能画的每一枚键帽逐一对照 + 断言同一面板里 `file.close` 仍画出 ⌘W）、`desktop-shell.svelte.test.ts` **56** + `topbar-container.svelte.test.ts` **6**；门禁 `tauri-command-scan`（**307** 条命令，`print_document` 可达）、`tauri-args-scan`、`tauri-reply-scan`（**253** 条带类型回复；本轮对这条线缆本身做了**两侧负控**——凭空加一个字段 ⇒ 红并点名，把一个字段的类型改错 ⇒ **绿**，后者是该门写明的边界，已把实测补进它的头部）、`tauri-event-scan`、`i18n:scan`、`void:scan`、`readfold:scan`、`diag:scan`、`typecheck`、`typecheck:svelte`（**0 error 0 warning**）全绿；`rustfmt --check`：本轮改的两个文件（`crates/amos-tauri/src/print.rs`、`crates/amos-tauri/src/wm.rs`）**净**——但这句话是收尾扫描**量出来之后才成立**的：`print.rs` 当初有 13 行格式化偏离、`wm.rs` 的 `focused_app_label` 有一处闭包换行，都是本轮自己写的（`rustfmt` 修掉，改的是同一份代码不是别的轮的）；**整 crate** 的 `cargo fmt -p amos-tauri --check` 仍红，红的是 `tray.rs`／`telephony.rs`／`blocklist.rs`——这三者在 HEAD 上是净的，其偏离属于**并行轮的未提交改动**，本轮不碰。**四条负控**（每条都逐字节还原 + `shasum -a 256` 核对）：`supports_dialog` → `true` ⇒ 恰 1 红；`PrintNoWindow` 的 `else` 换成 `unwrap_or_else(|| "main")` ⇒ 恰 1 红；`focused_target_label` 的**两项对调**（让模型焦点压过平台焦点窗）⇒ 恰 1 红；`actionable` 去掉 launcher 排除（恒 `Some`）⇒ 恰 1 红；给 `file.print` 临时挂上 `desktopShortcutLabel("close-window", …)`（让它「广告一枚本壳并不绑定的键」）⇒ **恰 1 红**，就是新增的那条键帽断言，其余 18 条不变。四条红的都是同一盏本该红的测试（`the_launcher_is_never_printed_and_the_platform_is_never_asked` / `every_platform_answers_whether_it_has_a_dialog` / `the_focused_target_prefers_the_key_window_and_falls_back_to_the_model`），也就是说这盏门对**两个方向**都活着。

**这一轮明确没做的**（与 §8.3／§8.6／§8.7 的写法一致）：①**没有一次真机打印**——没有在真实 `Amos.app` 里点过那个对话框，**D3「真机 GUI 验证为零」完全不受影响**（§5 第 2 条仍是第 2 条）；②**`ok: true` 从不代表「打出来了一页」**——`WebviewWindow::print()` 在**每个**平台都返回 `Ok(())`：macOS 只在视图 `respondsToSelector` 时才真的跑 `printOperationWithPrintInfo:`、Windows 就是 `eval("window.print()")`、Linux 丢掉 `PrintOperation::run_dialog` 的返回值（用户点取消也是 `Ok(())`）。所以这一轮交付的是**前门与判词**，不是「已打印」这句承诺——这句话同时写在 `print.rs`、`lib/print.ts` 与 F-SH-279 里；③**没有 CUPS/IPP 客户端**、没有打印机选择/页边距/份数那一层——本轮做的是「让这条路存在并且会说话」，不是一整套打印子系统；④**Windows/Linux 仍然没有和弦**（F-SH-280），⑤**未做真机复核**：`focused_target_label` 的语义（launcher 被排除）在自动化里被钉住了，但「平台认为哪个窗口是焦点」这一半只有真机能证。

### 8.9 做 §8.8 时顺手量到的：那盏冻结 wire code 的门只在**一个**方向上是活的（REQ-A870／F-DEV-118）

做 §8.8 时 `print.rs` 新增了三个 `ErrorCode` 变体，`wire_codes_are_frozen` 当场报 **89 vs 86**——于是去读那句断言的自述，发现它宣称的那个方向**根本没有被建立**。

| ID | 缺陷 | 一句话 |
|---|---|---|
| REQ-A870 / F-DEV-118 | `error.rs::wire_codes_are_frozen` 的文档与 F-SH-105 的「当前缓解」都写着「断言『枚举里每个 variant 恰好出现一次』（**新增 variant 未登记也红**）」，而这句话**实测是假的** | `seen` 是从**那张冻结表自身**遍历得到的，`assert_eq!(seen.len(), FROZEN_VARIANT_COUNT)` 两边**同源**——表少一条，集合就少一条，计数只要跟着改就永远相等。值改了会红（期望值是**手写**的另一列），而「漏登记」那个方向是**空的** |

**实测**：负控（从冻结表里删掉三个 `Print*` 表项、把 `FROZEN_VARIANT_COUNT` 改回 86）⇒ `cargo test -p amos-tauri --lib error::` **6 passed / 0 failed**，而那三条 code 的 wire 值确实已经不在表里。**修前模型**（把下面那两条新断言逐字删掉、再从 `ALL_VARIANTS` 里去掉一条变体）⇒ **绿**——证明这个洞**当时真的存在**，不是修完才想象的。

**修法**：①把 89 条变体从这个测试模块的两个函数里提出来、合成**模块级** `ALL_VARIANTS`，`codes_are_distinct_stability_keys` 与 `wire_codes_are_frozen` **共用同一份**（两份清单因此不可能互相漂移——F-SH-111 那条「词汇表手写两遍」同族病的修法）；②`wire_codes_are_frozen` 在计数断言之后加**双向差集**：「清单里有、冻结表里没有」与「冻结表里有、清单里没有」都必须为空，失败信息逐条点名；③把 `FROZEN_VARIANT_COUNT` 上方那句**假的自述**改真（原文称「缺一个 variant 会被抓到」，实测为假，现在写明「这一条**不**检查枚举本身」）；④F-SH-105 的「当前缓解」与 `TRACEABILITY_MATRIX` 的 `REQ-A631` 那一行同步更正。

**证据**：**两条负控**——删三个表项 + 计数改回 86 ⇒ 红且点名三条 code；只从 `ALL_VARIANTS` 删掉 `PrintDialogFailed` ⇒ 红且点名该条。`cargo test -p amos-tauri --lib error::` ⇒ **6 passed / 0 failed**（修后）；`cargo test -p amos-tauri --lib` ⇒ **823 passed / 0 failed**；`node scripts/fmea-gen.mjs --check` ⇒ **EXIT=0**（**547** 条）。

**这条正是 F-SH-105 那条缓解措施的自我更正，也是同一族的第 N 例**：**一盏门的绿灯是它自己产物的性质，而不是被检查代码的性质**（F-SH-273 的抽取窗口、F-DEV-114 的台账行、F-DEV-115 的覆盖率语料、F-DEV-104 的剥离器——都是「门把缺失当成了证据」）。

**残余，不粉饰**：枚举 → 手写清单这一跳**仍无自动绑定**——stable Rust 没有 `std::mem::variant_count`（unstable），为一条断言引入 `strum` 被否（新依赖换一条断言，不划算）。所以「加了一个变体、却两处都没登记」这类漂移**仍然只能靠人**；这一轮做到的只是把**漂移的两个落点绑成了一处**（漏登记与改值现在都会红）。


### 8.10 后续补关：A5 剩下那一半**脚下的接缝**——预览的三种「读不到」都被说成确定答案（REQ-A873／F-SH-281）

§5 第 4 条（A5「无 Quick Look 手势」）剩下的那一半是**系统级的空格浮层**；本轮**没有先去做那个手势**，而是先审计它脚下那条**预览读取**接缝——因为浮层要读的正是同一条路。于是在同一段代码里量到三处真缺陷，它们是一件事的三种写法：**「读不到」不是关于这个文件的事实**。

| ID | 缺陷 | 一句话 |
|---|---|---|
| REQ-A873 / F-SH-281 ① | `openExternalPreview`（`FilesApp.svelte`）里 `mediaLoad` 的 `else` 分支渲染成「二进制文件」 | 这个分支**只可能在读失败时到达**：真正 0 字节的文件回的是 `[]`，在 JS 里**为真**，走的是上面的 `if`。所以那一行是**没人做过的断言**——它把「我没读到」说成了「这文件是二进制」 |
| REQ-A873 / F-SH-281 ② | 同一函数**没有 `catch`**，而面板模板 `{:else if previewPlan}` 之后**没有 `{:else}`** | `lib/media.ts` 的私有 `call` 既不 catch 也**不经过 `backend.ts::invoke`**（它自己的注释写着「offline → null；有桥而报错 → rejects」），于是真实的宿主错误从 `void openExternalPreview(…)` **逃逸**；面板则开着、标题在、**正文空白**——一个什么都没说的预览 |
| REQ-A873 / F-SH-281 ③ | `filesPreview.ts::planPreview` 自述 fallback「只在宿主桥**不可用**时」触发，**实测不然** | `invoke` 对**被拒**的调用同样解出 `null`，于是「宿主在、但拒绝」也落到壳自己那份 `planPreviewLocal` 上；那份 fallback 有**自己一套** MIME 表（`audio/mp4` 的注释就是它们漂移过的化石），且**没有**宿主的 `PREVIEW_TEXT_MAX` 上限——`decodeTextSafely` 自己的注释就写着「callers should not rely on this for large inputs」，而 `planPreview` 恰好把宿主拒绝执行的那条保护**连同拒绝一起丢掉了** |

**修法**：①新增 `kind: "unavailable"` 与结构化的 `reason`（`no-bridge`／`refused`／`unreadable`），**只**由 `previewUnavailablePlan()` 一处构造（两个入口因此不可能各说各话——`print.ts` 为它的三条码立过的规矩，这里用在 plan 上）；②三个原因在 en/zh 各给**一句自己的话**（`printRefusalMessage` 的原话：一句话概括全部拒绝，会让三种事实在日志和屏幕上读起来一模一样；F-SH-279 已钉住这条判据）；③读取判词的那条路走 `bridgeDiag("files_preview_bytes")`（`read-fold-scan` 认可的补救 (b)：**真读一次该命令的判词**），且**只有** `not-bridged` 才允许落到 shell 自己的分类器——模块头部那句话因此第一次成为**描述**而非愿望；④媒体那条路按 `media.ts` 自己的契约**就地**判定（`media_*` 根本不进诊断台账，问它一个没人回答过的问题是不诚实的）；⑤`openExternalPreview` 补上 `catch`，面板因此**永不空白**。

**兄弟先例（同一个失败域，早就写对了）**：`PlayerApp.svelte` 的解析路径——`catch` 把任何 bridge / store / blob 失败都归成 `fail(t("player.unavailable"))`，注释写着「**surfaced honestly as unavailable rather than silently rendering an unplayable element**」。本轮做的是让 FilesApp 的预览读取走同一条规矩，不是发明一条新规矩。

**证据**：`bun test src/lib/__tests__/filesPreview.test.ts` ⇒ **22 pass / 0 fail**（原 18 + 4）；`npx vitest run svelte-tests/files.svelte.test.ts` ⇒ **54 passed**（原 50 + 4）。**四条负控**（每条逐字节还原 + `shasum -a 256` 两侧核对，扰动窗口都短）：去掉 `planPreview` 的新守卫 ⇒ **恰 2 红**（该守卫的两个方向）而 svelte 54 全绿；把 `else` 还原成出货的 `kind: "binary"` ⇒ **恰 2 红**而单元 22 全绿、**拒绝那条仍绿**（证明 `catch` 独立承重）；去掉 `catch` ⇒ **恰 1 红**（并证实面板当时**没有正文**）；把三个原因收成一个 ⇒ **恰 1 红**。两条**活控制**在四次扰动中**始终绿**：无桥时壳自己的分类器照旧作答（文档承诺的 fallback 没有被过度纠正）、拿到字节的外部预览仍显示宿主自己的分类。门禁：15 个扫描（`i18n`／`void`／`readfold`／`diag`／`store`／`write`／`a11y`／`vocab`／`perf`／`voidrej`／`svelteignore`／`hover`／`lifetime`／`reactfree`／`testreach`／`idgen`）与 12 个 `*:selftest` 全 **EXIT=0**；`typecheck` 与 `typecheck:svelte` **对本轮文件 0 诊断**；`node scripts/fmea-gen.mjs --check` ⇒ **EXIT=0**（**548** 条）、`trace-scan` ⇒ **EXIT=0**。

**这一轮明确没做的**（与 §8.3／§8.6／§8.8 的写法一致）：①**未改 Rust 一行**——本轮全在前端接缝；②**没有做那个系统级空格浮层**（A5 剩下的那一半仍未做），本轮做的是它脚下接缝的诚实性；③新增的 `unreadable` 原因在 UI 上**走不到**（只有「宿主对回复类型永不为 null 的命令答 `null`」这类 wire 违例与单元测试能到达它），如实登记而不假装可达；④**没有真机**验证过撤销授权 / 宿主崩溃的真实时序（D3「真机 GUI 验证为零」不受影响，§5 第 2 条仍是第 2 条）；⑤`read-fold-scan` 的窗口**没有**为本条加宽：`if (rows) render(rows); else render(empty)` 在视图代码里合法且遍地都是，硬加一条规则会用假阳性铺满全仓——边界与这次实测写进该门头部，断言钉在接缝自己的测试上。

⑥**ID 让位（如实记）**：本条最初登记为 `REQ-A871`；写台账前把**整棵树**过了一遍，发现并行轮已先用 `REQ-A871` 记**另一件缺陷**（F-ALM-004：`try/catch` 围着一个**永不 reject** 的 bridge 包装 ⇒ catch 是死代码；其源码散文 00:54–00:59 已在树里，早于本条写台账的 01:01–01:03），且已烙进 8 个源文件/测试与一面新门 `dead-catch-scan.mjs`。按 id 纪律「散文用法即算占用」，**本条让位**为 `REQ-A873`（`REQ-A872` 已被 `crates/amos-link/tests/service_uds.rs` 占），改动只落在台账与本文，**未触碰并行轮一行**（FMEA 号 `F-SH-281` 与 REQ 号各成序列，不受影响）。**本次的教训**：claim 前只探台账的高水位会漏掉**只以源码散文存在**的占用——这也是本仓缺一面「同一个 REQ 号不许落在两件缺陷上」的门；已记为下一轮的候选。**终值确认**：同案的并行轮随后又两次让位（`A871`→`A873`→**`REQ-A875`**，其间 `REQ-A874` 被 F-SH-282 轮取用——该轮台账原文写着「落笔前重探高水位为 REQ-A873 / F-SH-281，故取 REQ-A874」），即两轮都是在**看到本条 A873** 之后让开的，本条的 `REQ-A873` 因此是终值。

**顺带补账（上一轮那句「门禁全绿」的更正）**：`store:scan` 抓出 REQ-A869 的三条 `amos.print.*` wire code 从未在 `store-allowlist.json` 里分类——它们与 `amos.host_fs.*` 同类（`error.rs::ErrorCode::as_str` 的稳定字串，不是 store 键），本轮补到 `host-error-code` kind 下，并把该 kind 的说明从「`host_fs` bridge 送给 UI」改为「`host_fs` 与 `print` bridge」。**这是 §8.8 的账漏在门外**：上一轮的自述列了 i18n／void／readfold／diag 四个扫描，**没有跑 store:scan**，所以「全绿」当时只对它列出的那些成立。这类「改代码的那一轮忘了改台账」正是 F-SH-273 同族的**账本**面（`unwired-baseline.json`／`store-allowlist.json` 都是手工维护的棘轮），记在这里而不是悄悄补上。

---

### 8.11 做 §8.8／§8.10 时顺手量到的第二件事：那盏「唯一跑该 feature 配置的门禁」根本不存在——它不是缺位，是**没被调用**（REQ-A905／F-DEV-120）

与 §8.9（那盏门的**方向**）同族，但这一次被量的是**一盏根本不存在的门**——它在账本里被写成根因，并且**据此决定了下一个工作项**。

被更正的句子（逐字留档）：REQ-A874／F-SH-282 的「影响」栏写着——

> **为什么全绿**：……本仓唯一跑该 feature 配置的门禁 `rust-discard-scan` **如实拒绝**报一个取不到的计数（`could not measure`），于是「有代码编译不过」只以一句「无法测量」存在，**根因 13 小时无人知道**。

并据「一个 feature 门控的接缝可以在全绿的门禁下**无限期**编译不过」立项：**造一盏新的门**。

| ID | 缺陷 | 一句话 |
|---|---|---|
| REQ-A905 / F-DEV-120 ① | 「本仓**唯一**跑该 feature 配置的门禁是 `rust-discard-scan`」 | `Makefile:22` 就是那条命令，而且自 `84af680d`（2026-09-14）起在 **HEAD** 里——缺陷出现**前 8 天** |
| REQ-A905 / F-DEV-120 ② | 「一个 feature 门控的接缝可以在全绿的门禁下**无限期**编译不过」 | `.github/workflows/ci.yml:56` 的 `make test` **每次推送**都跑那条命令 ⇒ 它不只本地可达，是 **CI 可见** |
| REQ-A905 / F-DEV-120 ③ | 真因 | 改动**未提交**（`git show HEAD:crates/amos-tauri/src/sensor_host.rs` 里没有 `host_gnss` ⇒ CI 从未在它上面跑过）＋那一轮自述的验证清单（`android-permission-scan`、`bun test`、`bunx svelte-check`、`fmea-gen --check`）里**没有** `make test` |

**修法**：**不**新增门禁、**不**改 `rust-discard-scan` 一行（它那句 `could not measure` 是诚实的，错的是「唯一」这个断言以及由它推出的结论）、**不**动 REQ-A874 的任何源码或它自己的句子。本轮的落点只有账本：在 F-SH-282 行尾补 ⑥、在 REQ-A874 行尾补一句就地更正（让读到那一行的人**不必再读账本**）、登记 REQ-A905／F-DEV-120，并把**真正**缺的那一步换成行动项。

**证据（三条反证，全部实测）**：

1. `Makefile:22` = `cargo test -p amos-tauri -p amos-media --features amos-tauri/android,amos-media/android --lib`；`git log -S 'amos-tauri/android,amos-media/android' -- Makefile` 只命中 `84af680d`（2026-09-14）。
2. `.github/workflows/ci.yml:56` 的 `make test` 跑的就是它——CI 覆盖面不是「没有」，是「没被读」。
3. **负控（判别力）**：把 `crates/amos-tauri/src/sensor_host.rs:793` 还原成修复前的 `provider.gnss_fix(),` ⇒ **该步自己**失败：`error[E0308]: mismatched types … --> crates/amos-tauri/src/sensor_host.rs:793:13`、`error: could not compile amos-tauri (lib test)`；`cp` 到 /tmp 后逐字节还原，`shasum -a 256` = `ce026363415db425b26d6ed3ba1c99550f9b4a2f9ddc5b40c5d2bf951b325bad`，与扰动前逐字节相同，该步随即 `Finished … test profile`。

**见证（同一条命令下 android-only lib 测试 12 条，2026-09-22 实测）**：带 feature **910** vs 不带 **898**；`android_glue::tests::imu_store_accepts_and_reads_back`、`android_glue::tests::frame_store_validates_and_round_trips_nv21`、`incall::tests::empty_direction_is_preserved_and_forwarded_as_is` 等只在带 feature 时存在。反向为空——没有哪条测试因该 feature **消失**。另有两盏覆盖同一配置的门本就绿着：`node scripts/feature-surface-scan.mjs` ⇒ **EXIT=0**（49 个非默认 feature 全被 shipped surface 编译）、`node scripts/feature-test-scan.mjs` ⇒ **EXIT=0**（16 个 feature 门控测试模块都被 `cargo test` 步骤跑到）。

**教训**：**跑链**，不是**造门**。覆盖一直在两条腿上都活着（本地 `make test`、CI 每次推送），缺的是那一轮把它**写进自述的验证清单**——于是「13 小时无人知道」的机制被记成了「门禁缺位」，而真正最便宜的那一步（跑 `make test`）从记录里被挤掉了。**错因比没有因更坏**：没有因的读者会去量，拿着错因的读者会去造一盏已经存在两遍的门。这也与 `§4` 与 `§8.9` 一族同形——**门禁的绿灯是它自己语料的性质**，而账本的**因果句**没有任何仪器在读（`fmea-gen --check` 读 id，`claim-scan` 读名字，`trace-scan` 读行形状）。

**仍然真实的缺口（本轮登记的替代行动项）**：**交叉目标**的 `make android-app-check`（`cargo ndk -t arm64-v8a -P 31 check -p amos-tauri --features android`，Makefile:1256）**不在** CI 里——`ci.yml` 只有 `android-audio-seams` job 里的 `android-audio-check`／`android-ai-sherpa-check` 两条 android 腿，两条都是**宿主**构建（Android 镜像只用来取 NDK，不换交叉目标）。要接需要 NDK 与 runner 决策（属 §5-8／D2），故本轮只登记、不顺手做掉。

**这一轮明确没做的**（与 §8.3／§8.6／§8.8／§8.10 的写法一致）：①**未**新增任何门禁；②**未**改 `rust-discard-scan`；③**未**改 REQ-A874 的任何源码文件（只作负控，逐字节还原）；④**未**断言那 13 小时里有没有人真跑过 `make test`——树里没有这个记录，可测的命题只是「**跑一次就会红**」；⑤**默认 feature** 那一族门（`android-permission-scan`、`bun test`、`svelte-check`）的确永远看不见那段代码，这一点 F-SH-282 说得对，本条更正的只是「**唯一**」这个断言及由它推出的「无限期」结论；⑥**未**把它接进 CI。

⑦**ID 与并发（如实记）**：本条最初取 `REQ-A878 / F-DEV-119`——探针（全树 `grep -rl`，排除 `.git`）报两个都零命中，**同一分钟内**一个并行轮（`incall_recording_contract_e2e.rs` 那条缝）把两者同时写进了账本，于是按既有纪律改取**有缓冲**的 `REQ-A905 / F-DEV-120`，并把探针**写进写入脚本作为前置条件**（`assert not holders(...)` 在任何写入之前），所以这类竞争现在只可能**中止写入**、不会写半截。写入前另跑了一次 `DRY=1` 干跑，它当场抓住一个真 bug（`ensure_one_line()` 少传一个实参）——这正是干跑存在的理由。终值：**REQ-A905 / F-DEV-120**。

### 8.12 起点是「继续审计与补全代码」，量到的是一句**只说了两个原因里的一个**的因果句：一条投递链被账本记成「只缺生产者」，而补上生产者之后它**仍然是死的**（REQ-A980／F-DEV-130）

与 §8.11（那条因果句决定了下一个工作项）同族，这次被量的因果句出自 **REQ-A910／F-DEV-121**——它把 webhook 那条链的「死」归因于「**没有任何发射者**」，并**据此**把下一轮的工作项定成「接一个发射者」。

| ID | 缺陷 | 一句话 |
|---|---|---|
| REQ-A980 / F-DEV-130 ① | 「整条投递链缺生产者」 | 实测**还有一个独立原因**：`WebhookManager.initialize()` 的唯一调用者是 `enterprise/index.ts::initializeEnterprise()`，而它在生产里**零调用者**（同一事实 `audit.ts`（REQ-A897）与 `mdm.ts`（REQ-A945）各记过一次）⇒ `startEventProcessor()` 那个 1 秒的间隔**从未存在**，`eventQueue` 只进不出 |
| REQ-A980 / F-DEV-130 ② | 后果（今天在用户眼里长什么样） | 面板让用户为七个事件各配一个 URL，而 `triggerCount` 恒 0、成功率恒显示 0；重启后 `getWebhooks()` 读到**空表**——用户会以为**自己的配置丢了**（同一个功能的两个可见症状、两个独立原因） |
| REQ-A980 / F-DEV-130 ③ | 只补一半会带出的第三个缺陷 | 处理器真跑起来后，「1 秒一拍、一拍一条」就从「无所谓」变成用户看得见的**延迟**（延迟 = 队列深度，而队列是**累积**的）。实测：`enterprise.test.ts::应该能够触发 Webhook` **单独跑就红**（`[4044.99ms]`）——同一个文件里先前的用例各自 `mdmManager.configure()` 一次（每次都发一条没人订阅的 `mdm_policy_change`），那条用例要等自己前面那 7 条被一拍一条地走掉，40×100ms 的窗口到点；而它的 `trigger` 与处理器**都是好用的** |

**修法（两侧都补，一处纪律）**：`webhooks.ts` 新增 `ensureInitialized()`（幂等；`initialized` 在**任何读取/重入之前**置位——顺序反了就是递归）与 `bootstrap()`（「读回配置 + 起处理器」只有这一份），把「我起来了」系在**真正需要它的两个动作**上：入队一次（`trigger`）与读一次（`getWebhooks`）；新增 `emitWebhookEvent()` 与 `WEBHOOK_EVENTS`（七个事件名与面板同源），在**七条生产路径**上各接一次——`shortcut_create`／`shortcut_update`／`shortcut_delete`（`shortcuts.ts`）、`shortcut_run`（`appendExecutionLog`，三条终态共用的**唯一漏斗**，发射放在 try **之外**：一次失败的日志写入不该吞掉 webhook）、`shortcut_share`（`ShortcutsApp.svelte`，**只在开启方向**——撤回分享发成一条「share」是与事实相反的通知）、`template_install`（`installTemplate`）、`mdm_policy_change`（`configure`／`deletePolicy`）；`processEventQueue` 改成**一拍清空当前排队的全部事件**（逐条 await；`processing` 仍是重入闸 ⇒ 没有并发爆炸。**语义不变**：已入队的事件仍会被投递，只是不再「每条各占一秒」）。

**一处纪律**：`executeShortcut()` 每跑一次都会调 `updateShortcut(id, { runCount: +1 })`（本文件两处），照上面直发就会让订阅「指令被修改」的用户在**每次运行**后收到一条 `changed:["runCount"]`——运行这件事已由 `shortcut_run`（带时长、动作数）说过，故过滤掉它（`changed` 为空则连事件都不发）。

**证据（实测）**：`bun test src/lib/__tests__/enterprise-webhooks.test.ts` ⇒ **20 pass / 0 fail**（19 → 20）；`bun test src/lib/__tests__/enterprise.test.ts` ⇒ **27 pass / 0 fail**（修复前 `[4044.99ms]` 到点）；`bunx vitest run svelte-tests/shortcuts-share-sheet.svelte.test.ts` ⇒ **2 pass**；`bun run test`（`bun-iso-test.mjs`：229 pure 文件一个进程 + 31 DOM 各自一个进程）⇒ **EXIT=0**；`tsc --noEmit` 0 错；`bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` ⇒ 1448 文件 / 0 error / 0 warning；`bun run test:svelte` ⇒ 155 文件 / 1804 用例全绿；前端门禁族 22 盏 ⇒ 21 OK（`unwired:scan` 报的 `PUSH_STATUS_FIELDS` 是并行轮 REQ-A912 自己边界里已认的那条）。

**负控（七条，逐条注入 ⇒ 断言变红 ⇒ `cp` 到 /tmp ⇒ 逐字节还原 + `shasum -a 256` 复核）**：

| NC | 扰动 | 结果 |
|---|---|---|
| NC-1 | 去掉 `trigger()` 里的 `ensureInitialized()` | 20 中 **2 红**（`自举·投递` + `一拍清空`） |
| NC-2 | **只**去掉 `getWebhooks()` 里的 | **恰 1 红**（`自举·读回`）——两处自举**各自**都有控制 |
| NC-3 | 两处都去掉 | **3 红** |
| NC-4 | 去掉 `shortcut_delete` 发射 | 1 红 |
| NC-5 | 去掉 `runCount` 过滤 | 1 红 |
| NC-6 | 去掉 `ShortcutsApp.svelte` 里的 `shortcut_share` 发射 | **恰 1 红**（新增那条；同文件 REQ-A703 那条仍绿） |
| NC-7 | 把「一拍清空」退回「一拍一条」 | **2 红**，其中 `enterprise.test.ts::应该能够触发 Webhook` 以 **4044.09ms** 超时——**负控复现的正是修复前线上那个红** |

还原后逐字节相同：`webhooks.ts` = `d8f8a841ae48137a1f2cedadeb2f3e66b03b7211af625f984ea054b79461b71d`、`shortcuts.ts` = `b3cad25b4cab7b6db91b747102cce907118b796d58f484876363c3145a641cd2`（`ShortcutsApp.svelte` 在负控还原时也是 `e866f3de…`；此后一个 a11y 轮在同一文件里加了 `aria-*` 与命中区注释（REQ-A953），故它今天的哈希是 `cdb936ac…`——**那不是我改的**，本轮对它的改动只有第 761 行那一处 `shortcut_share` 发射）。`REQ-A980` 这轮改名只是**字符串替换**，不碰这三个哈希对应的代码形状。

**账本就地更正（三处，都带本轮归属）**：①FMEA **F-DEV-121** 行尾补 ④、它的 TRACE 行 **REQ-A910** 行尾补 ⑥——原因果句只说了两个原因里的一个；②`crates/amos-tauri/frontend-ts/scripts/dead-member-allowlist.json` 里 `getWebhook` 那条理由**第二次订正**（它写着「真正的入队入口 `trigger` 在生产里**同样零调用者**，所以整条投递链缺生产者」，**已不实**：发射侧与自举都补上了，`trigger` → `processEventQueue` → `sendWebhook` 在生产里**会跑**）——而 `getWebhook`（**单条**读取）**仍然零生产调用者**（面板 `APISettings.svelte` 用的是列表 `getWebhooks()`），故条目**保留**、只改口径；③FMEA **F-SH-292** 行与 CHANGELOG 那条里的「A944 也被 `enterprise-webhooks.test.ts` 用掉」**已不实**（那是当时在途轮次的临时占号，`grep -rl A944` 全树零命中）。

**教训**：**错因比没有因更坏**（§8.11 的同一句话，换了载体）。没有因的读者会去量；拿着「只缺生产者」这句的读者会去接发射者，接完看到「有发射者了」就收工——而链仍然是死的，并且下一轮的验收会绿在一个**仍然没跑起来**的链上。这一族（`audit.ts`／`mdm.ts`／`webhooks.ts` 三次）的共同形状是：**一个零调用者的自举函数把几个管理器串在一起**，而账本每一次都只记了它当轮看得见的那一半。本轮的第三个缺陷还说明另一件事：**一个缺陷可以让另一个缺陷变得无所谓**——「一拍一条」在链死着的时候完全无害，所以它不可能在修好之前被测出来。

**这一轮明确没做的**（与 §8.3／§8.6／§8.8／§8.10／§8.11 的写法一致）：①**未**新增任何门禁（沿用 §8.11：**跑链，不是造门**）——「发射点 ↔ 面板事件名」的绑定只有 TypeScript 这一门仪器在读，`APISettings.svelte::availableEvents` 那张事件表没有任何扫描器对照；②`mdm_policy_change` 的第二个发射点（`deletePolicy()`）在生产里**零调用者**、今天**不可达**（`mdm.ts` 自己已记）；③`template_install` 的宿主 `installTemplate` **可达**（`TemplateLibrary.svelte`），但 `syncTemplates` 仍无生产者——`EnterprisePage.svelte` 那句「模板数据源没有生产者」因此**仍然为真**，它说的是同步那一半；④`shortcut_share` 只有**组件级**证据（`svelte-tests/`）；⑤`dead-member-scan` 对 `trigger` 的子串碰撞（`triggerCount`）**未**修；⑥`REQ-A945` 在 TRACE 里**没有行**（`trace-scan` 按信息项报出而不判失败——账本自述是 partial index，本轮不替并行轮补行）；⑦`test:svelte` 整批第一次跑遇到 `src/svelte/theme.svelte.ts:84` 的 200ms 定时器在环境拆掉后触发（vitest 记 1 个 unhandled error ⇒ EXIT=1，而用例 155/1804 全绿），复跑 EXIT=0——与本轮无关、**未**修；⑧**未**做真机验证：**「设备上真的发出去了」这句话本轮没有量过**，量过的是「同一条投递路径在打桩 `fetch` 下收到了它」。

⑨**ID 与并发（如实记）**：本轮**先写源码、后探号**（正是本仓文档里的反模式），于是被并发的取号撞了**三次**——占号链如实记：A944（探针报 A944 的高水位已被并行轮推到 A945）→ A952（写入前探针实测已被并行轮写进 CHANGELOG.md 与 docs/TRACEABILITY_MATRIX.md）→ A960（写入前探针实测已被写进 CHANGELOG.md／TRACE／FMEA.md／scripts/fmea-gen.mjs）→ A970（已被同一个 a11y 族轮次用掉，见记忆索引 REQ-A970／F-SH-306） → 终值 **`REQ-A980`**。**每一次都是探针在写入之前中止的**（`grep -rl` 全树，排除 `.git`／`node_modules`／`target`；正规写入必带），所以这类竞争只可能**中止写入**、没有写半截；迭代时用 `PROBE=0` 跳过探针，正式那一次带探针跑。这一夜被撞三次说明「先写源码后探号」在 id 消耗速度为**分钟级**的并行环境里已不是偶发，本轮的源码因此改了四次号（纯字符串替换，`shasum` 复核过形状未变）。

### 8.13 起点是「继续审计与补全代码」，量到的是一条**把判定写成常量、并在注释里断言「分辨不出」**的接缝 —— 而本仓另一处早就在**同形状**上把判定读出来了（REQ-A1019／F-DEV-134）

**①缺陷（对 HEAD 核实，缺陷先于本轮存在，非并发轮的改动）**

`crates/amos-tauri/frontend-ts/src/lib/privacyBackend.ts` 的两条镜像写命令逐字：

```ts
await invoke<null>("perm_grant", { appId, resource });
return true;               // ← 常量
```

守着它的文档注释原话：「The Rust command returns unit (JSON `null`), so we can't distinguish "confirmed" from "resolved to null": return `true` when we're bridged and the request was submitted」。也就是说：**这个 `true` 不是判定，是「我提交过」的同义反复**，而注释把「分辨不出」写成了语言事实。

**②「分辨不出」是假的（实测反驳，三处同仓证据）**

| # | 实测 | 结果 |
| --- | --- | --- |
| 1 | Rust 两条命令的签名 | `crates/amos-tauri/src/privacy_client.rs` 的 `perm_grant`／`perm_revoke` 是 `Result<(), String>`，**会失败**：`check_privacy_id`、`build_channel().await?`（本机没有守护进程 socket）、`client.grant(...).map_err(...)` |
| 2 | `invoke` 是否留下判定 | 是。`src/lib/backend.ts` 每次调用把结局记进**按命令名分槽**的 `bridgeDiag`：成功 `{ ok: true }`，抛错 `{ ok: false, kind: "command-failed", detail }` |
| 3 | 本仓是否已在同形状上读它 | 是。`src/lib/spaces.ts::unitMutationOk(command)` 逐字 `return bridgeDiag(command).ok;`，服务 `deleteSpace`／`moveWindowToSpace`／`unfileWindow`／`renameSpace` 四个 unit 命令（REQ-A513）；`scripts/void-cmd-scan.mjs` 的头部原话也把 `bridgeDiag("<command>").ok` 点名为 unit 命令**唯一**可读的判定 |

结论：这两条命令的判定**一直在**，只是没被读。

**③后果链（逐条实测，不是推演）**

| # | 环节 | 实测 |
| --- | --- | --- |
| 1 | 被拒绝的写读成成功 | 一次 `perm_grant` 抛错后，`daemonGrant(...)` 仍返回 `true` = 「权威授权」。`bun test src/__tests__/privacy-backend.test.ts` 的新用例在修复前逐字红：`Expected: false / Received: true` |
| 2 | 这个假判定哪儿也到不了 | 唯一的生产调用者是 `src/svelte/osPermissions.ts` 的 `void daemonGrant(appId, cap);` 两处 —— 返回值被 `void` 丢掉，所以连「读到了 `true`」这件事也没有下游 |
| 3 | 唯一的不一致面板恰好在「失败可证」时沉默 | `PermissionsApp.svelte` 的 ⚠ 由 `daemonVerdict` ⇒ `perm_authorize`（一次**读**）驱动；当写失败的原因正是守护进程不可达时，读也失败并答 `null`，而 `null` 在本仓是**有意的**「不作主张」。于是「本机已授权、权威存储里没有」在评审面上是一枚**干净的绿授权** |
| 4 | 门禁的窗口（结构性，非疏漏） | `void-cmd-scan.mjs` 的清单只从 `backend.ts` 建（`Promise<null>`／`Promise<void>` 包 `invoke<null>`），而这两处是 `lib/privacyBackend.ts` 里的**直接** `invoke<null>` 站点，落在窗口之外。这与本轮之前那次「7 处直接站点」同形，其中 5 处（`dockBadge.ts` 一处、`spaces.ts` 四处）早已读 `bridgeDiag(...).ok` |

**④修法（两侧都补，判定与渲染点各一处）**

1. `privacyBackend.daemonGrant`／`daemonRevoke` 改为 `return bridgeDiag("perm_grant"/"perm_revoke").ok;`，并把注释改成**三值**语义（`true` 接受／`false` 拒绝／`null` 没问过），同时把代价写清：槽是**按命令名**的，两条并发 `perm_grant` 共用一个槽，后完成者胜。
2. `src/svelte/osPermissions.ts`：不再 `void` 丢弃 —— 新增 `mirrorWrite()` 把判定记进 `refusedMirrors`（`app|cap` 为键的 `Set`）、`mirrorRefused(app, cap)` 读它、`onMirrorVerdict(fn)` 两向通知（视图因此能**撤销**已经画出的标记）。这仍不改变「本地先写、gate 立即生效、离线可用」的既定语义：被记下的只是**这一对上的最后一次写没人接**。
3. `src/svelte/PermissionsApp.svelte`：新增第二枚标记（`data-testid="perm-mirror-<app>-<cap>"`、`⛔`、`aria-label`／`title` = 新键 `perm.mirrorRefused`），与 ⚠ **分开渲染**，因为因不同：⚠ 是「守护进程否认」，⛔ 是「守护进程从未确认」；`$effect(() => onMirrorVerdict(() => collectMirrorRefusals()))` 让标记在判定落地后就出现（不必等页面重挂载）。
4. i18n：`perm.mirrorRefused` 进 `en.ts`／`zh.ts` 两语，`perm.hint` 同时说明两枚标记。

**⑤一处纪律（本轮修法里最容易修反的地方）**：`null` **不记**成拒绝。离线／本机能力（`notifications`）根本没有被问过，把它记成「守护进程拒绝了」是**凭空指控**，而且会在每个离线用户屏上点亮一排 ⛔ —— 这与本仓既定的「`null` = 不作主张」相反。另外，同一对上的**后一次被接受的写清除**标记：标记陈述的是「最后一次写」，不是一次会话伤疤（否则一次瞬时失败会让那一对永远带着红点）。

**⑥证据**

| 命令 | 结果 |
| --- | --- |
| `bun test src/__tests__/privacy-backend.test.ts` | **11 pass / 0 fail**（新增 1 条：拒绝 → `false`、接受 → `true`、离线 → `null` 三向） |
| `bun test src/__tests__/osPermissions.test.ts` | **9 pass / 0 fail**（新增 4 条，见 ⑤：拒绝被记／接受不记／离线不记／同对后一次接受清除） |
| `bunx vitest run svelte-tests/permissions.svelte.test.ts` | **14 pass / 0 fail**（新增 1 条：拒绝桥下点一下按钮 ⇒ ⛔ 出现，且**没有** ⚠ —— 两个标记不互相冒充） |
| `bun run test`（`bun-iso-test.mjs`，229 个 pure 文件一个进程） | **EXIT=0**（模块级 `refusedMirrors` 在整批里不串味） |
| `bun run test:svelte`（161 个 DOM 文件，一文件一 worker） | **161 files passed / 1856 tests passed / 0 failed**（本轮新增的 DOM 用例在其中，整批一次通过） |
| `bunx tsc --noEmit` | **0 错** |
| `bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` | **1452 文件 / 0 error / 0 warning** |
| 前端门禁族（`void:scan`／`readfold:scan`／`diag:scan`／`voidrej:scan`／`deadmember:scan`／`write:scan`／`store:scan`／`i18n:scan`／`testreach:scan`／`vocab:scan`／`hover:scan`／`lifetime:scan`／`reactfree:scan`） | 全部 exit 0 |

**⑦负控（逐条注入 ⇒ 观察变红 ⇒ `cp` 到 /tmp 的定值快照 ⇒ 逐字节还原并由 `shasum -a 256` 复核）**

| # | 注入 | 结果 |
| --- | --- | --- |
| NC-1 | 把 `privacyBackend` 的判定退回常量 `return true;` | `privacy-backend.test.ts`：**恰 1 红**（`Expected: false / Received: true`） |
| NC-2 | `recordMirror` 两条分支都改成 `refusedMirrors.delete(key)`（拒绝永不入册） | **恰 2 红**：A「拒绝被记」+ D「同对后一次接受清除」（后者也以「先有一次拒绝」为前提，**预期耦合**） |
| NC-3 | 极性反转（接受入册、拒绝不入册） | **2 红**：A（拒绝没被记）+ **B 单独红**（`Expected: false / Received: true`）——证明「接受不记」这条断言**够得着**，不是被 A 顺带覆盖 |
| NC-4 | 接受时不删除（`if (!accepted) refusedMirrors.add(key)`） | **恰 1 红 / 8 绿**：只有 D「同对后一次接受清除」 |
| NC-5 | 把 `null` 当拒绝记（`recordMirror(appId, cap, verdict === true)`） | **恰 1 红 / 8 绿**：只有 C「没答过 ≠ 拒绝」——即 ⑤ 里那个最危险的修反方向 |
| NC-6 | 让桥**接受**（把测试里那个拒绝桩的 `throw` 改成 `return null`） | `svelte-tests/permissions.svelte.test.ts`：**恰 1 红**，红在**接缝**那句（`mirrorRefused("camera","camera")` 为 `false`）——证明标记跟踪的是真实拒绝，不是画上去的常量 |
| NC-9 | 把 `PermissionsApp.svelte` 里那个 ⛔ 的 `{#if}` 块整段删掉 | **恰 1 红**，红在**渲染**那句（`perm-mirror-camera-camera` 为 `null`），而接缝那句**通过**——NC-6 与 NC-9 各管一半：只有这两条一起，才证明这条 DOM 用例的两句断言**各自**都有够得着的控制（NC-6 只到接缝就红了，够不到渲染那句） |
| NC-7 | 把「没答过」（`null`）改成算作 drift | **2 红**：本轮新那条（它的「没有 ⚠」断言）+ 既有的「daemon 否认 ⇒ ⚠」那条（后者因 `verdict === false` 不再匹配）——证明「两个标记不互相冒充」这句是有判据的 |
| NC-8 | 从 `en.ts` 删掉 `perm.mirrorRefused` 一行 | `i18n-scan` 逐字 `FAIL — missing in en: perm.mirrorRefused`——证明这个新键**两语都被要求**、且确实被生产代码引用 |

**⑦-补 一次如实记录的支架自身失败（NC 系列第一次跑 NC-6 时）**：第一次 NC-6 不但没红，还留下了一个假象。
支架当时从 `/tmp/perm_fix/` 还原，而那个快照目录里**只有 5 个源文件**，**没有**本轮新增的 svelte 测试文件 —— 于是扰动写进了 `svelte-tests/permissions.svelte.test.ts`，还原那一步的 `cp` 报的是 `No such file or directory`、`shasum` 也报同名错误，而两条错都只在 stderr 上、被 `| tail` 滤掉，脚本仍以 0 结束、还打印了「还原逐字节相同」。
后果：**被扰动的测试文件没被还回去**，一个「拒绝桩」悄悄变成「接受桩」。它单独跑是 14/14 绿，整批跑红 —— 我先按「时序竞争」「双模块实例」「监听注册时序」猜了三轮，甚至写好了「订阅时重放」的修法；插桩打印（`recordMirror camera camera true` + `invoke returned null diag={"ok":true}`）才把它指回测试文件本身，读出那行被改掉的 `return null`。
教训与 ⑧ 同形但是新机制：**快照集比扰动集窄**。修法是把「还原」变成有前置条件的操作 —— 扰动前先验快照存在且非空（缺失即 `exit 2`，一个字节都不写），还原后用 python `hashlib` 复核并比对新旧哈希（不等即 `exit 3`），并且把**所有**会被扰动的文件（含测试文件）都放进快照集。修好后 NC-6 复跑：恰 1 红、还原哈希 `bf6644bf…` 逐字节相同。
（顺带记下：那个「重放订阅」的修法**没有**被采用 —— 它修的是一个不存在的 bug。）

还原后逐字节相同（`shasum -a 256`，对 /tmp 定值快照复核）：`privacyBackend.ts` = `64078d23118c1c5caa4272010d4c99488e7b5e05a26c0b154151ff7907606a73`、`osPermissions.ts` = `1867c1a4e5df56223ca7113b737aded1339fe26fee304eaa6ca7e05f5bca71d1`、`PermissionsApp.svelte` = `9d92fdbcdce7facef706c68868403a9fa4ef9ef4f662a59eadd008049ed36d0b`、`en.ts` = `96c7a112a6af28cf5eadde9bc3238643c876ea20a4c340e4d0dab14d2fcae45e`、`zh.ts` = `ea2ac940606dc43c25c059080201cfc03409232e3fd7c90e1e876ef4e9c6b310`。

（**这两条语言文件哈希是「还原那一刻」的实测值，不是此刻的值** —— 同日稍后一个并行轮向 `en.ts`／`zh.ts` 各加了两条自己的键（`settings.taskRefused`／`settings.taskRefusedNoReason`），所以今天再对 `shasum` 会不等：那是**并发的正常增长**，不是本轮还原失败。可复核的判据是：`grep -c '"perm.mirrorRefused"' src/i18n/locales/{en,zh}.ts` 各为 **1**，其余 6 个文件与快照逐字节相同。记在这里，是为了让下一个复核者不会把「别人加了两行」读成「你的还原没生效」—— 本仓的哈希证据天然带日期。）

**⑧教训**

**「分辨不出」是一句可以被量到的断言，不是一句可以顺手写下的免责。** 这次的注释里写着「unit 返回值 ⇒ 分辨不出成功与 null」—— 而在**同一个仓库**里，同一形状的判定早就被读出来四次（`spaces.ts` 的 `unitMutationOk`），连门禁的头部都把它点名为唯一可读的判定。写注释时把「我没读」写成「读不到」，代价不是文档不准确：它让下一个读这段代码的人**不再去找**那个判定，也让这次缺陷在 `void-cmd-scan` 的窗口之外活了整整一轮（该轮的清单只从 `backend.ts` 建）。**本轮的修法因此不是「加一个门禁」，而是把已有的判定接回渲染点**。

**同一轮第二次响起的钟是同一个道理，只是对象换成了我自己的工具**：一个「还原失败」的 `cp` 在没有前置条件时**不可能**失败得响亮 —— 缺文件、写不进、被滤掉的 stderr，三种都长得像成功。上一条缺陷的判据是「这个 `true` 不是判定」；这一条是「这个『还原成功』也不是判定」。同一轮里量到两次同形错误，说明它不是运气，是**默认写法**的问题。

**⑨这一轮明确没做的（如实边界）**

1. ⛔ 标记只落在**评审面**（`PermissionsApp`）。`grantCapability` 今天有 12 个调用文件（`CameraApp`／`StreamVoiceButton`／`InterpApp`／`VoiceMicButton`／`MapsApp`／`VoiceMemosApp`／`MagnifierApp`／`PrivacyPage`／`PermissionsApp` 等），那些**当场同意**的提示框今天都不画这枚标记。判定与订阅都在接缝（`osPermissions`）里，任何一个都能读；**本轮没有接**。
2. `bridgeDiag(command)` 是**按命令名**的一个槽 —— 两条并发 `perm_grant` 共用它，后完成者覆盖前者的判定。代价已写进注释，**未**消除（`backend.ts` 自己的 `PER_COMMAND_CAP` 文档解释了为何是名字而非调用点）。
3. 只读了 `perm_*` **写**的判定；`perm_authorize` 的读路径未动。
4. **未**做真机／真实守护进程复核（没有起 Tauri 宿主与守护进程 socket 去真拒一次），证据是假桥的逐命令结果 + Rust 侧签名与失败点的源码核实。
5. **未**动 `void-cmd-scan.mjs` 的清单（把窗口从 `backend.ts` 拓到全部 `invoke<null>` 站点会当场在别的轮次文件上转红）；该窗口比其声明窄这一条已在别处记过，本轮只修这一面。
6. **未**碰任何并行轮的红：`unwired:scan` 当前 exit 1，报 `fixedValues: ['src/lib/hostFs.ts::hostFsWriteText']`（「基线登记已接线、棘轮该缩」）—— 那是**另一轮**未提交的 `hostFs.ts` 改动留下的账，与本轮无关，本轮**未**改它一行。
7. NC 支架本身修好了（前置条件 + 哈希复核 + 完整快照集），但它仍是**一次性验证**、不是门禁：本轮之后没有任何东西会在 CI 上重跑这 9 条负控。
8. 本缺陷类**没有**独立门禁（「一个 unit 命令的判定有没有人读」今天只由 `void-cmd-scan` 的窄窗口覆盖），判别力来自本轮的 6 条用例 + 9 条负控。

**⑩ID 与并发**

落笔前经全树 `grep -rl`（排除 `.git`／`node_modules`／`target`／`dist`）重探：取号链 = 全树 grep -rl 重探（排除 .git／node_modules／target／dist／.svelte-kit，含散文引用）：REQ-A 已占 1000–1015（其间 1006 空）、F-DEV 已占 130／131 ⇒ 取 REQ 高水位+4 = REQ-A1019、F-DEV 高水位+3 = F-DEV-134，终值 **`REQ-A1019`／`F-DEV-134`**。探针写在写入脚本里作**前置条件**（任何一处被并行轮占用即 `exit 2` 中止，写一个字节之前），迭代时用 `PROBE=0` 跳过。

### 8.14（**撤回**）上一轮落笔为「七个窗口 `…WithDiag` 包装器把宿主拒绝读成了成功」的 REQ-A1062／F-DEV-135 是**误报**，本轮核实前提为假并逐处回退

**①被撤回的主张**：`lib/wm.ts` 的七条窗口 `…WithDiag` 包装器在 `null` 回复后回读 `bridgeDiag(command)`，而「`invoke` 只要调用**解析**（哪怕解析成 `null` —— 称其为 Rust `Err` 的序列化形状）就记 `ok: true`」，于是「宿主拒绝」与「成功」在账本里同值，两个 `noteFailure` 的 `if (diag.ok) return` 把要报的失败吞掉。

**②为什么这个前提是假的（决定性证据）**：Tauri 2 的 `#[tauri::command]` 返回 `Result<T, E>` 时，`Err` **不走成功回调**，而是走 error 回调 —— 即 JS 侧 promise **reject**，绝不是一个「解析成 `null`」的调用。证据取自本机 vendored 源码 `tauri-2.11.5`：
- `src/ipc/command.rs` 的 `impl<T: IpcResponse, E: Into<InvokeError>> ResultKind for Result<T, E>` 与 `ResultTag::block` ⇒ `resolver.respond(value.map_err(Into::into))`，`Err` 经 `respond(Err)` 送达 `return_result`；
- `src/ipc/mod.rs::return_task` 的文档逐字写着：**“If the Result is `is_err()`, the callback will be the `error_callback` function name and the argument will be the Err value.”**

于是 `lib/backend.ts::invoke` 的 `catch` 接住这次 reject，`noteDiag(command, {kind:"command-failed"})` 并返回 `null`。一条被拒绝的 `wm_*` 在账本里是 **`{ok:false, kind:"command-failed"}`**，`bridgeDiag(command).ok` 是 **`false`** —— 那两个 `noteFailure` 的 `if (diag.ok) return` 从来不会因此吞掉拒绝，**原代码是对的**。`host-refused-null` 这个派生只对「解析成 `null` 而不抛出」的调用成立，而那要求 Rust 返回类型是 `Result<Option<T>, _>` 且答 `Ok(None)`；本组七条命令（以及 split／snap 家族）都是 `Result<_, String>`，**产生不出这个形状**。本仓自己的用例早已这样建模（`src/__tests__/wm.test.ts` 逐字：「a Rust `Err` **rejected** the promise」）。

**③上一轮的测试为什么「验证」通过却仍是误报**：新增的 7 条用例用 `__TAURI_INTERNALS__.invoke = async () => null`（一个**不抛出**的桥）构造出「活桥答 null」。这正是那七条命令在真机上**产生不出来**的形状 —— 所以负控（把 `replyDiag` 改回 `bridgeDiag`）能变红，而真机路径不可达。**可证伪的教训**：负控证明的是「所断言的行为由被测代码决定」，不能证明「该行为在真实宿主上可达」；一个用假桥构造出的输入，要在 Rust 侧找到能产生它的返回类型才算数。

**④回退清单（逐处）**：
- `lib/wm.ts`：删去 `replyDiag` 函数与我在文件头加的那个 `WmReplyDiag` 定义；七条包装器的返回类型从 `WmReplyDiag` 收回 `BridgeDiag`、`replyDiag("wm_x")` 收回 `bridgeDiag("wm_x")`；split 段那条把我引入的注释改回一段**如实**描述（并写明 `Result<_,String>` 的拒绝走 reject 这条事实）。
- `WmReplyDiag` 保留（split／snap 家族本就在用），定义为 `BridgeDiag | { ok:false; kind:"host-refused-null"; command:string }`。
- `svelte/modules/DockContextMenu.svelte`：`noteFailure` 的参数类型收回 `BridgeDiag`，`bridgeDiag` 导入恢复。
- `svelte/modules/TopbarMainMenu.svelte`：`noteFailure` 的 `replyDiag(command)` 收回 `bridgeDiag(command)`，导入恢复。
- `src/__tests__/wm.test.ts`：删去整组 7 条用例与随之无用的三个 import。
- 台账：删 `docs/FMEA.md` 的 F-DEV-135 行、`docs/TRACEABILITY_MATRIX.md` 的 REQ-A1062 行、`scripts/fmea-gen.mjs` 的 F-DEV-135 注册项；`CHANGELOG.md` 的那条改为本撤回记录。

**⑤仍然有效、但不属于本轮产出的部分（如实记下，不宣称已修）**：账本是**事后**读的共享槽位（`perCommandDiag`，按命令名，容量 48）。若**同一命令**的两个调用并发、且后完成的那次成功，则先失败那次的 `bridgeDiag(command)` 会读到后者的 `{ok:true}` —— 这是一条**真实、潜在**的并发缺陷。`replyDiag` 读的是同一个共享槽位，因此**并不修**它。正确的修法是让调用点拿到**本次调用**的判决（例如让 `invoke` 一并返回该次调用的 `BridgeDiag`），而不是回读共享槽位。本轮只记录，不动。

**⑥split／snap 家族既有的 `host-refused-null`（未动）**：这些包装器用 `try { const s = await invoke(...); if (s) …; return host-refused-null } catch { … }`。因 `invoke` **从不抛出**，其 `catch` 不可达；一条 Rust `Err`（`command-failed`）会被标成 `host-refused-null`、丢掉 typed detail。唯一渲染点 `settings/WindowPage.svelte::diagNoteKey` 把 `command-failed` 与 `host-refused-null` **画成同一文案**（`wm.hostRefused`），故无用户可见差异 —— 记为**独立议程**，本轮不碰（改它动的是别轮在写的文件）。

**⑦验证（回退后，实测读数）**：
- `bun test src/__tests__/wm.test.ts` ⇒ **51 pass / 0 fail**（回退前含我新增的 7 条时为 58；删去后与基线一致）。
- `bunx tsc --noEmit` ⇒ **我的四个文件（`lib/wm.ts`、`DockContextMenu.svelte`、`TopbarMainMenu.svelte`、`wm.test.ts`）零错误**；全仓另有 **93** 条错，全部落在并行轮未提交的 `src/lib/robot.ts` 等文件（`TS1160: Unterminated template literal` 等），与本轮无关、本轮未触碰。
- `bunx vitest run svelte-tests/topbar-main-menu.svelte.test.ts` ⇒ **31 passed**；`… dock-context-menu … -hints …` ⇒ **12 passed**（两处渲染点回退后无回归）。
- `node scripts/fmea-gen.mjs --check` ⇒ **[OK] 645 failure modes documented**（F-DEV-135 行与注册项已删）。
- `deadcatch:scan` / `diag:scan` / `void:scan` / `write:scan` / `store:scan` ⇒ **OK**。**两条既有红（并行轮，本轮未触碰）**：`unwired:scan` 报 `pushNotifications.ts::PUSH_STATUS_FIELDS`；`i18n:scan` 报 `robot.beatSelf` / `robot.beatPeerUnknown` 在 `zh` 缺失。

**⑧如实边界**：本轮是**撤回**，不新增任何能力；**未改**任何 Rust；未主张 split／snap 家族既有的 `host-refused-null` 误标（⑥）与共享账本回读的并发窗口（⑤）已修 —— 两者都只**记录**，留给专门一轮。


### 8.15 起点是「继续审计与补全代码」，量到的是**一个动作的六处入口里、只有一处把判决丢了**：宿主拒绝的 `wm_open` 是一次**死点击**，理由只被「记录」、无人「读取」（REQ-A1176／F-SH-469）

**①现象（对工作树核实）**：Dock 里点一个 app 磁贴、Finder 磁贴、垃圾桶、溢出列表项或设置快捷方式，都走同一个动作 `wm_open`，而宿主**可以合法拒绝**它 —— `crates/amos-tauri/src/wm.rs::WmState::open` 的三条拒绝路径：`identity_of_label`（身份模型不认识的 label）、`!identity.is_first()`（REQ-A473，label 指向的不是该 app 的**首**实例）、`Self::check_new_app_window(&core)?`（该窗口类的 `multi_window` 上限）。这些不是崩溃，是**用户可以正常走到**的拒绝。然而这六处调用点逐字是 `void wmOpen(...)`：

- `src/svelte/modules/DockAppItem.svelte:40`
- `src/svelte/modules/DockFinderItem.svelte:28`
- `src/svelte/modules/DockTrashItem.svelte:47`
- `src/svelte/Dock.svelte:671`（溢出列表项）
- `src/svelte/Dock.svelte:748`（设置快捷方式）

而 `lib/wm.ts::wmOpen` 的返回类型是 `Promise<boolean>`，逐字为 `(await invoke<WmWindowsSnapshot>("wm_open", { label })) !== null`；`lib/backend.ts::invoke` **从不抛出** —— 它在 `catch` 里 `noteDiag(command, {kind:"command-failed", detail})` 之后 `return null`（REQ-A296）。故这个 `boolean` 的 `false` **就是**「宿主拒绝」。把它 `void` 掉，等于「宿主拒绝」这个事实**只进了账本，没有一个读者**。

**②为什么这是个缺陷、而且是一条**可证伪的**注释**：`DockFinderItem.svelte` 的旧注释把那个信念写了出来 —— 「A failure *is* recorded in the diagnostics ledger by `lib/backend` — but recorded is not read, and this comment used to stop at the first half」。**记录**不等于**读取**（memory `project_channel_needs_a_reader`），而 `lib/debugLog` 的文件头把 console 输出称作「为什么 X 在设备上不渲染」这类问题的主仪器。同一个动作的**其它**入口全都读了并说了：`Launchpad.openApp`、`DesktopNotificationCenter`、`TopbarMainMenu`、`TopbarAppleMenu`、`SpotlightOverlay`（走 `wmOpenWithDiag`，取出 typed code，soft log），以及**同一个 Dock 里**的 `DockContextMenu.noteFailure`（`wm_open` ∕ `wm_new_window` ∕ `wm_close` ∕ `wm_hide` ∕ `wm_focus`）。Dock 的磁贴是这个动作**唯一**「点击死掉、且在读者能看到的地方一个字都没有」的入口。

**③为什么全绿（门禁的窗口）**：`wmOpen` 的 `boolean` 不落在任何现有门禁的射程里 —— `void-cmd-scan` 覆盖 `invoke<null>(` 形状的 **void 桥命令**，`void-rejection-scan` 覆盖**会 reject 的被调者**，`diag-render-scan` 覆盖「读了诊断之后的渲染点」。「一个返回 `Promise<boolean>` 的**包装器**，其 boolean 被丢弃」三者都不覆盖。

**④修法（唯一报告者，六处接线）**：新增 `lib/wm.ts::wmOpenReported(label, surface)` —— `wmOpen` 为真则直接 `return true`（成功路径零开销）；为假则读 `bridgeDiag("wm_open")`，若账本 `ok` 则按不变量 `return false`（`invoke` 答 `null` 必已记录），否则从 `command-failed` 的 `detail.code` 取出宿主的 **typed code** 并 `console.warn(`🛟 [${surface}] wm_open(${label}) refused`, code ?? diag.kind)`。六处 `void wmOpen(...)` 一律改调它，`surface` 标签说明是哪一个入口死的。`wm.rs` ∕ Rust ∕ proto ∕ i18n 键 ∕ 布局**一行未动**。

**⑤验证（实测读数）**：
- 红先证：未改前 `svelte-tests/dock-open-report.svelte.test.ts` 的 app 磁贴一例 ⇒ `expected '' to contain 'amos.wm.window_cap'`。
- 修后：`dock-open-report.svelte.test.ts` **2 pass**；dock 家族（`dock*` ∕ `dock-context-menu*` ∕ `launchpad*`）合计 **65 pass**。
- 负控（逐叶各一）：把 `DockAppItem.svelte:40` 还原成 `void wmOpen(...)` ⇒ 该文件恰 **1 红 ∕ 1 绿**；把 `DockFinderItem.svelte:28` 同样还原 ⇒ 恰 **1 红 ∕ 1 绿**。两次均以 `cp` 快照 + `shasum -a 256` **逐字节**还原（绝不用 `git checkout --`）。

**⑥如实边界（不宣称已修）**：`wmOpenReported` 读的是**共享**的 `perCommandDiag` 槽位（按命令名索引，容量 48）—— 即 §8.14 ⑤ 已经记下的那条**真实、潜在**的并发窗口：**同一命令**的两个调用并发、且后完成的那次成功，则先失败那次读到的会是后者的 `{ok:true}`，于是这一处也会漏报。本轮只**接线**，不宣称修了该窗口；正确修法是让调用点拿到**本次调用**的判决（例如让 `invoke` 一并返回该次调用的 `BridgeDiag`），而不是回读共享槽位。此外：`DockTrashItem` 里 `openFilesAt("trash")` 的判决本来就是单独读的（`if (!openFilesAt("trash")) console.warn(...)`），被丢的只是**随后**那次 `wmOpen` —— 本轮的修法没有动那段既有逻辑。


### 8.16 起点是「继续审计与补全代码」，顺着 §8.15 的同一把尺子再扫一遍，量到的是**桌面壳还剩四处 `wm_open` 入口把宿主判决丢了 —— 而每一处都住在已经为同一命令备了上报者的文件里**（REQ-A1187／F-SH-477）

**①核实（对工作树）**：§8.15 收尾时把「丢判决」的入口逐个点了一遍，剩下的四处各有自己的**同一文件内的反例**：

- `DesktopStage.svelte`：`onIconDoubleClick` → `void wmOpen(targets[i])`、`onWindowKeyDown`（Enter/Space）→ `void wmOpen(id)`，而**同一个文件**的右键菜单路径 `openSelectedApps` 早就 `wmOpenWithDiag` + `noteOpenFailure` 逐条上报。一次多开里被宿主拒的那扇门，在双击 ∕ 键盘上是死点击。
- `DesktopShell.svelte`：`case "menu.preferences":` 与 `case "menu.amos-help":` 都 `void wmOpen("settings")`，而本文件第 441 行的 `windowMenuAction`（Zoom ∕ Enter Full Screen 在用）正是为这条命令写的上报者。
- `SpotlightOverlay.svelte`：`openApp` 里 `void wmOpen(id)` 丢了门的判决；同一面板的 `file` 行 `revealFileAcrossWindows` 失败会 `console.warn` —— 于是同一次失败有两条 `wm_open` 行、两种答案。
- `Shell.svelte`：`launchApp` 的桌面臂 `void wmOpen(id)`。

**②为什么每一盏灯都是绿的**：`lib/wm.ts::wmOpen` 返回 `Promise<boolean>`，而 `backend.invoke` **从不 reject** —— 它把理由记进 per-command 账本（`noteDiag`）并答 `null`，故 `false` 才是拒绝。测试机的宿主桩对 `wm_open` **resolve 一个快照（或 null）**，`backend.invoke` 对**已 resolve** 的调用一律记 `{ok:true}` ⇒ 拒绝分支从未被执行。唯一能到达它的是一条**会 reject 的桩**（Tauri 2：`#[tauri::command]` 返回 `Err` 走 error 回调 ⇒ JS promise reject ⇒ `catch` 记 `command-failed` 并答 `null`）。这也正是本轮四处用例各自**局部**重写 `refuseWmOpenWith(code)` 的原因：共享的 `installHost` 桩够不到那条分支。

**③修法（接回各文件已有的单一所有者，不新造上报者）**：
- `DesktopStage.svelte`：抽出 `openApps(ids, context)` 作**动作的单一所有者** —— 双击、Enter/Space、右键菜单三处全部经它；逐项读 `wmOpenWithDiag` 的 `{ok:false}`，交 `noteOpenFailure(command, label, context)`（`context` 指明是哪条路径死的）。
- `DesktopShell.svelte`：两行菜单改走本文件既有的 `windowMenuAction(() => wmOpen("settings"), "wm_open", "settings")`。
- `SpotlightOverlay.svelte`：`openApp` 改走 `wmOpenReported(id, "Spotlight")`（REQ-A1176 的单一上报者，§8.15 落地）；`file` 行的 `wm_open` 同样经它。
- `Shell.svelte`：桌面臂改走 `wmOpenReported(id, "Shell")`。

**④实测（读数）**：
- `svelte-tests/desktop-shell.svelte.test.ts`：`DesktopStage — a refused wm_open in the multi-open is reported (REQ-A1187)`（2 例）与 `DesktopShell — a refused menu-row wm_open is reported (REQ-A1187)`（2 例）。
- `svelte-tests/spotlight-search.svelte.test.ts`：`a file row whose wm_open is refused says so`（1 例）。
- 两文件合跑 **87 pass**（83 + 4）。
- 断言刻意落在**面**的面包屑（`[DesktopStage] onIconDoubleClick`、`[DesktopShell] wm_open(settings) refused`、`[Spotlight] wm_open(files) refused`）而非类型化 `code` —— 因为 `backend.invoke` 自己的 `amosWarn` 行**已经**带着 `code`（`safeDetail` 会 stringify 普通对象），只断言 code 会**不可失败**。

**⑤负控（逐叶各一，逐字节还原）**：
- `DesktopStage.svelte` 双击叶还原成 `void wmOpen(id)` ⇒ 恰 **1 红 ∕ 1 绿**。
- `DesktopStage.svelte` 键盘叶还原成 `void wmOpen(id)` ⇒ 恰 **1 红 ∕ 1 绿**。
- 两次均 `cp` 到 /tmp 后按 `shasum -a 256` 逐字节还原，整文件复跑 **81 ∕ 81**。

**⑥如实边界（不宣称已修）**：
- `wmOpenReported` 读的是**共享**的 `perCommandDiag` 槽位（按命令名索引、容量 48）—— 即 §8.14 ⑤ 记下的那条**真实、潜在**的并发窗口（同一命令两次重叠调用，前一次的失败可能读到后一次的成功 `{ok:true}`）。与本轮修法无关，继续记录。
- **`Shell.svelte` 的桌面臂当前在生产不可达**：桌面形态下 `Shell` 渲染 `DesktopShell`／`DesktopAppWindow`，而 `HomeDock`（§Shell 第 925 行）与 `AppLibrary`（第 871 行）都只在**非桌面** `{:else}` 分支挂载；`launchApp` 的唯一输入源是这两个组件的 `propsBus` 的 `open` 事件（`RecentsPanel`∕`SpotlightPanel` 各走自己的 `recents`∕`spotlight` 通道，不经 `launchApp`）。故这一臂是**「输入从不产生的守卫」**（memory `project_live_guard_input_never_produced`）—— 本轮如实记录，不当作已修的活缺陷；若将来 HomeDock∕AppLibrary 改在桌面挂载，该臂即自动变为活路径并已就绪。


### 8.17 起点是「继续审计与补全代码，完善功能」，量到的是**「显示桌面」的还原半场把宿主的判决丢了 —— 被拒的那扇窗既留在隐藏、又被从记忆里抹掉**（REQ-A1194／F-SH-483）

**①核实（对工作树）**：`HotCornersListener.svelte::toggleShowDesktop()` 是对称的两半，而只有一半读判决：

- **隐藏半场**（逐字）：`for (const w of snap.windows) { if (w.kind !== "App" || w.state === "Hidden") continue; if (await wmHide(w.label)) deskHidden.push(w.label); }` —— 只有宿主**确认**隐藏了的窗口才进 `deskHidden`。
- **还原半场**（逐字）：`if (deskHidden.length > 0) { const back = deskHidden; deskHidden = []; for (const label of back) await wmFocus(label); return; }` —— `wmFocus` 的 `Promise<boolean>` 被丢掉，而列表在循环**之前**就清空了。

`lib/wm.ts::wmFocus` 逐字为 `return (await invoke<WmWindowsSnapshot>("wm_focus", { label })) !== null;` —— `false` 是「宿主拒绝 ∕ 无桥」（`invoke` 从不 reject，它把理由记进 per-command 账本并答 `null`）。

**②为什么是缺陷而不是设计**：`deskHidden` 先清空 ⇒ 一次被拒的还原把那扇窗**留在隐藏**且**从记忆里抹掉**。下一次触发走隐藏半场，而它 `state === "Hidden"` 会被 `continue` 跳过 —— 于是这扇窗**再也回不来**（须改用 Dock ∕ Spotlight 找回）。文件第 108-111 行的注释只对**隐藏**半场立了规矩（「a per-window `wm_hide` that the host refused is simply not remembered」），还原半场没人回答同一个问题。

**③修法（把还原半场做成隐藏半场的镜像）**：
- 改走 `lib/wm::wmFocusWithDiag`（返回 `{ok:true}` 或 `{ok:false, diag}`）：只有 `ok` 的窗才离开记忆；被拒的推进 `stillDown`，循环后 `deskHidden = stillDown` —— 留下一扇**仍被记住**的窗给下一次手势重试。
- 同一处留一条带面标签的面包屑 `🛟 [HotCorners] wm_focus(<label>) refused`（`diag.kind` 为 `not-bridged` 时退化成它），与 `AppExpose` ∕ `MissionControl` ∕ `DockContextMenu` 三处**既有的**上报者同形；`diag.ok` 直接返回（无记录可解释）。

**④实测（读数）**：
- `svelte-tests/hot-corners-show-desktop.svelte.test.ts`（新 2 例，向 `window` 派发 `mousemove` 走真实入口）：
  1. `keeps a refused un-hide remembered, so the next trigger retries it (and says so)` —— 三次进角落（隐藏 → 被拒的还原 → 再触发），断言第三次**重试 `wm_focus`**（计数 2）且不再 `wm_hide`，并断言 `[HotCorners] wm_focus(a) refused`。
  2. `clears the memory once a restore succeeds — the next trigger hides again (the mirror)` —— 反向守卫，修法不许把「成功」也记成失败。
- 相邻套件复跑不回归：`hot-corners-page`（8 例）＋ `desktop-shell`（83 例）＋ `app-expose`（8 例）＝ **99 pass**。

**⑤负控（逐叶各一，逐字节还原）**：
- `deskHidden = stillDown` → `deskHidden = []`（丢掉记忆这一半）⇒ 恰 **1 红 ∕ 1 绿**。
- 去掉 `console.warn` 那行（丢掉上报这一半）⇒ 恰 **1 红 ∕ 1 绿**（只红报告那条）。
- 两次均 `cp` 到 /tmp 后按 `shasum -a 256` 逐字节还原（`HotCornersListener.svelte` = `1e19b9efeb26f16a90bf7939fefccdebce1e9b2f08ed034d9b0d1d23e62acf36`），绝不用 `git checkout --`。

**⑥如实边界（不宣称的部分）**：
- 这条只有「宿主真的拒绝」才可达 —— 窗口在两次触发之间消失、该窗属于一个 split、或整座桥缺失。真机未复核；证据是 happy-dom 下的**调用计数**与 `__TAURI_INTERNALS__` 桩（对 `wm_focus` **reject**，因为 `backend.invoke` 把一次 *resolved* 的调用记成 `{ok:true}`，只 resolve 的桩够不到拒绝分支）。
- 这三处（`AppExpose` ∕ `MissionControl` ∕ `DockContextMenu`）各自手抄了一遍同样的十行上报块；本轮**没有**把它们合并成单一属主（不同于 REQ-A1176 把六处**沉默**的入口收进 `wmOpenReported` 的那次），因为在它们各自的文件里已经被测试钉住、合并属重构而非修复。留作后续工作项。
- `triggerAction` 的其余分支（mission-control ∕ launchpad ∕ lock-screen ∕ notification-center）走 `ShellChromeApi`，与本条无关。


### 8.18 起点是「继续审计与补全代码，完善功能」，量到的是**Spaces 面板归档窗口后的重新应用把宿主的读数丢了 —— 而同一个文件里的切换控件读它**（REQ-A1197／F-SH-486）

**①核实（对工作树）**：`SpacesPanel.svelte` 里同一个命令 `spaces_switch` 有两个调用点，只有一处读读数。

- 切换控件（逐字）：`async function handleSwitch(index) { const report = await switchSpace(index); if (!report) { error = spacesErrorLabel("spaces_switch"); return; } currentIndex = index; const missed = report.hide_failed.length + report.show_failed.length; warning = missed > 0 ? t("spaces.switchPartial", { n: missed }) : null; }`
- 归档路径（逐字）：`} else { await loadSpaces(); await switchSpace(currentIndex); }` —— 读数丢掉。

`switchSpace` 逐字为 `return await invoke<SpaceSwitchReport | null>("spaces_switch", { index });` —— 成功是**对象**、拒绝是 `null`（REQ-A513 专门把旧的"布尔恒为 false"改掉，正是为了让两者分得开）。

**②为什么是缺陷而不是设计**：`handleAssignWindow` 开头 `error = null`，结尾 `loadWindows()` —— 窗口已经归档到别的桌面、列表也按账本刷新，而**屏幕没跟着走**（或宿主直接拒绝）时一句话也没有。`#warning` 的声明逐字写着它存在的理由：「与 `error` 分开：切换确实发生了，把它显示成"错误"会撒谎；但不说也不行 —— 那是用户看得见、别处看不见的状态」。这条路径恰好把该说的话全省了。

**③修法（一个属主，两处共用）**：
- 抽出 `applySwitch(index)`：拒绝 ⇒ `error = spacesErrorLabel("spaces_switch")`；成功 ⇒ `currentIndex = index` 且 `hide_failed + show_failed > 0` 时 `warning = t("spaces.switchPartial", …)`。
- `handleSwitch` 改成 `await applySwitch(index)`；`handleAssignWindow` 的重新应用改成 `await applySwitch(currentIndex)`。两处不再有两种答案。

**④实测（读数）**：
- `svelte-tests/spaces-panel-assign-switch.svelte.test.ts`（新 3 例，改窗口那一行的 `<select>` → `onchange` → `handleAssignWindow` 走真实入口）：①重新应用被拒 ⇒ 面板出现 `桌面索引超出范围`；②部分完成（`hide_failed` 非空）⇒ 出现 `spaces-switch-partial`；③干净完成 ⇒ 两条横幅都不出现。
- 相邻套件复跑不回归：`spaces.svelte.test.ts`（11）＋ `spaces-panel-hints`（3）＋ `mission-control`（16）＋ 本文件（3）＝ **33 pass**。

**⑤负控（逐叶各一，逐字节还原）**：
- 调用点还原成 `await switchSpace(currentIndex)` ⇒ 恰 **2 红 ∕ 1 绿**。
- `applySwitch` 的拒绝分支不再写 `error` ⇒ 恰 **1 红 ∕ 2 绿**（只红第 1 例）。
- 部分提示不再写 `warning` ⇒ 恰 **1 红 ∕ 2 绿**（只红第 2 例）。
- 三次均 `cp` 到 /tmp 后按 `shasum -a 256` 逐字节还原（`SpacesPanel.svelte` = `1faee7778fab2dd28270468672f2e9306bcd170e5ff8a8a2bc227ee1e6f88169`），绝不用 `git checkout --`。

**⑥如实边界（不宣称的部分）**：
- 这条只有在重新应用**被拒 ∕ 部分完成**时才显形（宿主 `switch_plan` 里某扇窗 hide ∕ show 失败，或当前桌面已被别的窗口删掉）；真机未复核，证据是 happy-dom 下的 DOM 断言。
- `spacesErrorLabel` 读 `bridgeDiag("spaces_switch")` —— 一条**按命令名**保留最近一次读数的槽位（与 `unitMutationOk` 是同一条既有约定），故继承「同一命令两次重叠调用时前一次可能读到后一次读数」的并发窗口（§8.14 ⑤ 记过同形的窗口）。与本轮修法无关，继续记录。
- 归档路径上「窗口归档成功、但重新应用被拒」时用户看到的是 `error`（而非 `warning`）—— 与本仓 `handleSwitch` 的既有口径一致（拒绝就是拒绝），未另立措辞。


### 8.19 起点是「帮助我按照航空航天级别标准修复上面发现的问题，审计与补全代码，完善功能」，量到的是**菜单栏 编辑 ▸ 拷贝 ∕ 粘贴 把宿主的判决丢了 —— 而同一个文件里 `noteFailure` 就是为这个形状写的**（REQ-A1213／F-SH-499）

**①核实（对工作树）**：`TopbarMainMenu.svelte::editRows` 的两行各挂着一个**死** `.catch()`。

- `edit.copy`（逐字）：`clipboardWrite({ kind: "text", text }, "topbar.file.copy").catch(() => undefined);`
- `edit.paste`（逐字）：`clipboardRead().then((entry) => { … }).catch(() => undefined);`

`lib/clipboard.ts` 逐字 `return invoke<ClipboardEntry>("clipboard_write", …)` ∕ `invoke<ClipboardEntry>("clipboard_read", …)`；`lib/backend.ts::invoke` 逐字在两条失败路上都 `return null`（`not-bridged` 直接返回；`catch` 里 `noteDiag({ ok: false, kind: "command-failed", … })` + `amosWarn("backend", …)` 之后再 `return null`）。**`invoke` 从不 reject**，所以这两个 `.catch` 是**死代码**。

**为什么是「同一形状被清扫过一次、漏了一处」**：`noteFailure` 的头部注释逐字写着三条 `wm_*` 行曾是这样 —— `the bar's three wm_* rows used to be "invoke("wm_*", ...).catch(() => undefined)" — "catch" is dead code because "invoke" swallows rejections into "null" (REQ-A296)`；紧邻的 `file.screenshot` 行也逐字读判决（`void screenshotCapture().then((path) => { if (path === null) noteFailure(…) })`）。编辑这两行没进那次清扫。

**②为什么是缺陷而不是设计**：可达的宿主拒绝是具体的、不是假设 —— `clipboard.rs` 逐字 `return Err(format!("clipboard text exceeds {MAX_TEXT_LEN} bytes"))`（一大段选区）、`require_foreground` 逐字 `Err(format!("clipboard read denied: '{caller}' is not the foreground window …"))`（窗口不在前台），外加整个没有桥的 WebView。用户点「拷贝」，屏上一句话也没有；诊断环里只有 `invoke` 那条泛泛的 `backend … clipboard_write failed`，**说不出是哪个动作被拒**。孪生对照在另一个文件：`SpotlightOverlay.svelte` 逐字 `notice = entry === null ? t("desktop.spotlightCopyFailed") : t("desktop.spotlightCopied")`，其注释逐字把这条规则说死了 —— 读**值**，不读 `.catch()`（`a catch here would be dead code, and this repo has removed that shape before`）。

**③修法（一个上报者，两处共用）**：

- `edit.copy`：`const entry = await clipboardWrite({ kind: "text", text }, "topbar.file.copy"); if (entry === null) noteFailure("clipboard_write", "topbar.file.copy", "topbar.edit.copy");`
- `edit.paste`：`const entry = await clipboardRead(); if (entry === null) { noteFailure("clipboard_read", "", "topbar.edit.paste"); return; }`

**为什么不是裸的 `entry === null` 判据**：`clipboard_read` 对**空剪贴板**答 `Ok(None)`（一次**成功**的调用），`invoke` 把它与 `Err(…)` 一起折叠成 `null`（本仓的「一个 `null` 两个事实」）。`noteFailure` 读 `bridgeDiag(command)`，于是「还没拷过东西」不报警、只有真的被拒才留痕 —— 第 ④ 例测试就是钉这一点的。

**④实测（读数）**：

- `svelte-tests/topbar-edit-clipboard-refusal.svelte.test.ts`（新 4 例，走真实入口：点 `menu-edit-trigger` 开菜单、点 `menu-edit-edit.copy` ∕ `menu-edit-edit.paste`）：①被拒的拷贝 ⇒ `🛟 [Topbar menu] … clipboard_write` 面包屑；②拷贝落地 ⇒ **没有**面包屑；③被拒的粘贴 ⇒ `clipboard_read` 面包屑；④**空剪贴板**（桩回 `null`）⇒ **没有**面包屑。
- 相邻套件复跑不回归：`topbar-main-menu`（24）＋ `topbar-container`（17）＋ `desktop-shell`（83）＋ 本文件（4）＝ **128 pass**；`bun run check` 全绿（exit 0）。

**⑤负控（逐叶各一，逐字节还原）**：

- copy 调用点还原成 `.catch(() => undefined)` ⇒ 恰 **1 红 ∕ 3 绿**（只红第 1 例）。
- paste 调用点还原 ⇒ 恰 **1 红 ∕ 3 绿**（只红第 3 例）。
- 保留 `entry === null` 而改写成不读 `bridgeDiag` 的裸 `console.warn`（仍点出命令名）⇒ 恰 **1 红 ∕ 3 绿**（只红第 4 例：空剪贴板被误报成拒绝）。
- 三次均 `cp` 到 /tmp 后按 `shasum -a 256` 逐字节还原（`TopbarMainMenu.svelte` = `7f19207483f6935f726ef37e9cd090e213fe362128adf4d6d0722c9275b74b95`），绝不用 `git checkout --`。

**省下的第一次负控（记录在案）**：第 3 次负控的第一版把 warn 文案写成不点命令名的 `topbar.edit.paste refused`，结果红的是第 3 例（`barSaid("clipboard_read")` 读不到命令名）而不是第 4 例 —— 那一版同时动了两个叶子，改回「点命令名、只去掉 `bridgeDiag`」后才逐叶隔离。

**⑥如实边界（不宣称的部分）**：

- 这条只在**被拒**时显形；真机未复核，证据是 happy-dom 下的 `console.warn` 断言与 `__TAURI_INTERNALS__` 桩。
- **残差（未修，如实记下）**：唯一读这个形状的门 `scripts/dead-catch-scan.mjs` 判的是 `try` ∕ `catch` **语句**（头部逐字 `It judges catch es, not outcomes`），且包装器清单只从名为 `backend.ts` 的模块收集；**promise 链上的 `.catch()`** 与 `clipboard.ts` 这类非 `backend.ts` 模块的包装器都在它的窗口之外 —— 这正是这两行全绿的原因。同类残差还有 `ShareSheet.svelte::copyTarget`（`await clipboardWrite(…)` 的判决未读）与 `lib/shortcuts.ts` 的 `copy_to_clipboard`（判决未读，但那里有一条**写明的**理由：快捷键的成败不影响返回值）。本轮不扩门（扩门有误报风险，需要单独一轮的负控）。
- `noteFailure` 读 `bridgeDiag(command)` —— 一条**按命令名**保留最近一次读数的槽位，故继承「同一命令两次重叠调用」的并发窗口。与本轮修法无关，继续记录。

### 8.20 起点是「帮助我按照航空航天级别标准修复上面发现的问题，审计与补全代码，完善功能」，量到的是 **§8.19 ⑥ 自己记下的那条残差：分享面板的「拷贝」把宿主的判决丢了 —— 而且实测比「丢判决」更硬，它根本没到达过宿主**（REQ-A1235／F-SH-516）

**①核实（对工作树）**：§8.19 ⑥ 的残差名单里逐字写着「同类残差还有 `ShareSheet.svelte::copyTarget`」。到现场核，`src/svelte/ShareSheet.svelte` 的 `copyTarget` 逐字：

```ts
async function copyTarget(): Promise<void> {
  if (!payload) return;
  dismiss();
  await clipboardWrite({ kind: "text", text: payload.value }, "share-sheet");
}
```

而组件顶部 `const payload = $derived(sharePayload())`，`dismiss()` → `closeShareSheet()` 把共享模块状态 `payload` 置空 —— `$derived` 随即反映它，于是**下一行的 `payload.value` 读的是 `null.value`，抛 `TypeError`**。也就是说：**`clipboardWrite` 一次都没被调用**，点击在到达宿主之前就断了；调用点的 `void` 把这次拒绝吞掉，而面板**已经**收起。结论比「丢了判决」更重：**「拷贝」这个目标从来没拷贝过任何东西**。

**②同一文件的反例（规则早就写下了）**：兄弟 `runTarget` 的注释逐字：

> Closing the sheet *is* the success gesture, so it now happens only when `result.success`, and a refusal is said in the surface that started it (REQ-A856, REQ-A1140).

代码也照做（`if (result.success) dismiss(); else failureNote = …`）。两条路各是一个目标，**只有运行这一条读了判决**。

**③叠在上面的第二层缺陷**：即便拿到了值，`ClipboardEntry | null` 也是丢掉的 —— 而 `null` 正是宿主拒绝（正文超 `MAX_TEXT_LEN`＝1 MiB，或整个没有桥的 WebView）。收起面板又**就是**成功手势，于是一次拒绝与一次成功在屏幕上完全一样。

**④修法**：先取值再 await，读宿主的判决，只在成功时收起。

```ts
async function copyTarget(): Promise<void> {
  if (!payload) return;
  const text = payload.value;
  failureNote = null;
  const entry = await clipboardWrite({ kind: "text", text }, "share-sheet");
  if (entry === null) {
    failureNote = t("shareSheet.copyFailed");
    return;
  }
  dismiss();
}
```

把原 `runError` 改名 `failureNote` 并让它持有**成句**（快捷方式的错误文本 vs.「剪贴板拒绝」两种来源在同一处渲染，渲染点不必知道自己在看哪一种），两条路复用同一个 `role="alert"` 结点；新增 i18n 键 `shareSheet.copyFailed`（`zh.ts` 与 `en.ts` 各一条）。Rust 一行未动。

**⑤实测（读数，红先）**：`svelte-tests/share-sheet-copy-refusal.svelte.test.ts`（新 3 例）修前 **3 红 / 0 绿** —— `TypeError: Cannot read properties of null (reading 'value')` 与 `expected "clipboardWrite" to be called 1 times, but got 0 times`。比预测更硬：第三例（成功路径）的 `toHaveBeenCalledWith` 也因 0 次调用而红，如实记录。

**⑥负控（逐叶各一，`cp` 逐字节还原，绝不用 `git checkout --`）**：

- ①还原原始 `copyTarget` ⇒ **3 红**（与红先一致）。
- ②保留取值与报告、但末尾无条件 `dismiss()` ⇒ 恰 **2 红**（第 1、2 例）。**与预测的 1 红不符**：面板一收起，`{#if payload}` 连同渲染点一起消失，所以第 1 例「要说出来」也红 —— 如实记录这次预测偏差。
- ③报告 `null`、但成功时不 `dismiss()` ⇒ 恰 **1 红**（第 3 例），前两例仍绿。
- 三次均按 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`。负控期间 `ShareSheet.svelte` 的定值快照为 `936f92d1377aaf71fe63b7e03dd2b0307189d872fd998e3ef6cc6ad8774cc766`；**此后仅有一次纯注释改动**（占位 id `REQ-A1219` → 定案 `REQ-A1235`，因 `REQ-A1219` 已被并发一轮的 `MessagesApp` 占用），它改变了文件哈希，故**对最终内容重跑负控 ①**（还原原始 `copyTarget` ⇒ 仍 **3 红**）、再对最终内容复跑三套件（13 绿）。最终内容 `ShareSheet.svelte` = `be64d32659b11c00b093512e162fe2f82c4f125087923a828a4605c0b9bc9eba`。

**⑦回归**：同族三套件（`share-sheet-copy-refusal` ∕ `share-sheet-run-refusal` ∕ `share-sheet`）**13 绿**。仓库门禁 `fmea-gen --check` OK（781 个失效模式）、`trace-scan` ∕ `docs-link-scan` ∕ `gate-index-scan` ∕ `tauri-command-scan` 均 EXIT=0。`bun run check`：**191 个测试文件 ∕ 2247 例全绿**，唯一红的是 `svelte-ignore-scan.mjs` 在 `src/svelte/FilesApp.svelte` 上的一条 finding —— 那是**并发一轮尚未落盘的编辑**（工作树删掉了一个 `<!-- svelte-ignore a11y_media_has_caption -->`，而**索引**里仍在第 1615 行；同一 finding 在我两次运行之间从 R5 变 R3，正是文件正在被改写的证据）。该文件本轮一字未动，不属本轮范围，如实记录而非顺手改掉。

**⑧如实边界（不宣称的部分）**：

- 拷贝成功路径走 `vi.mock("../src/lib/clipboard")` 的返回值，**未走真桥**；`clipboard_write` 的 1 MiB 上限由 Rust 侧既有测试覆盖。
- §8.19 ⑥ 的其余残差（promise 链上的 `.catch()`、非 `backend.ts` 的包装器、`lib/shortcuts.ts` 的 `copy_to_clipboard`）本轮不动，继续记录。

### 8.21 起点是「帮助我按照航空航天级别标准修复上面发现的问题，审计与补全代码，完善功能」，量到的是 **§8.19 ⑥ 残差名单里点名的第二处：Dock 角标 effect 把「已经画上」记在读到宿主的判决之前 —— 一次被拒的写入被记成完成，此后永不重试**（REQ-A1246／F-SH-525）

**①核实（对工作树）**：`src/svelte/Dock.svelte` 的角标 effect 逐字：

```ts
let lastBadge: string | null = null;
$effect(() => {
  const label = badgeText(dockBadgeTotal(notifs, quiet));
  if (label === lastBadge) return;
  lastBadge = label;
  void setDockBadge(label);
});
```

`lastBadge` 的语义写在它自己的注释里 —— 「值没变就不写……反复写只会换来一串无意义的宿主日志」。也就是说这个记忆的含义是 **「宿主已经在显示这个」**，那它就只能记**已被接受**的值。而 `setDockBadge` 返回 `Promise<boolean>`，**`false` 正是宿主拒绝**（`lib/dockBadge.ts::setDockBadge` 从 `bridgeDiag("dock_badge_set").ok` 取真值，因为命令答 `()`、线上与失败同为 `null`；Rust 侧 `crates/amos-tauri/src/dock_badge.rs` 的 `set_badge_label` ∕ `set_badge_count` 失败、以及 `no main window` 都会 `Err`）。于是两层缺陷叠在一起：

- 判决被 `void` 丢弃 —— 拒绝没有任何人知道。
- 记忆落在判决**之前** —— 同一个值此后直接 `return`，**永不重试**。真实的 macOS 图标停在旧数字（或干脆没有），而瓦片上的角标继续按 store 更新：屏幕上的两个数字永久分叉，且没有任何东西说得出这件事。

**②同一文件的先例（同形面包屑早就有了）**：`Dock.svelte` 自己的 `wm_windows` 处理逐字写着 `bridgeDiag("wm_windows")` + `if (!diag.ok && diag.kind !== "not-bridged")` + `console.warn("🛟 [Dock] wm_windows refused", code ?? diag.kind)` —— 同一把尺子：**未桥接是正常路径，真失败留一条面包屑**。角标这一路没有照做。

**③修法**：

```ts
if (label === lastBadge) return;
void setDockBadge(label).then((ok) => {
  if (ok) {
    lastBadge = label;
    return;
  }
  // `not-bridged`（手机 ∕ 平板形态）是正常路径，不是失败 —— 与 `wm_windows` 同一把尺子。
  const diag = bridgeDiag("dock_badge_set");
  if (diag.kind === "not-bridged") return;
  const code = /* …same shape as the wm_windows block… */;
  console.warn("🛟 [Dock] dock_badge_set refused", code ?? diag.kind);
});
```

被拒时记忆保持旧值 ⇒ 下一次 `store-updated` 抖动自然再试一次。Rust 一行未动。

**④实测（读数，红先）**：`svelte-tests/dock-badge-refusal.svelte.test.ts`（新 3 例，宿主桩 **reject** 以走 Tauri 2 的 `Err` 路径）修前恰 **2 红 ∕ 1 绿**。

**⑤一次自查（记录在案）**：第二例的第一版只断言 warn 文案含 `dock_badge_set` —— 它**通过了**，因为 `lib/backend.ts::invoke` 自己的 `amosWarn("backend", "dock_badge_set failed", err)` 已经带着命令名。这是「一个不可失败的断言」：只有把断言改成**界面面包屑**（`[Dock]`）之后它才在坏代码上变红。教训与 §8.19 ⑤ 同形，但这次的实现面比上次更硬 —— 不是「同时动了两个叶子」，而是「断言的目标早就被上游替我说了」。

**⑥负控（逐叶各一，`cp` 逐字节还原，绝不用 `git checkout --`）**：

- ①还原原始两行 ⇒ **2 红 ∕ 1 绿**（与红先一致）。
- ②保留「只在成功时落定」、去掉上报 ⇒ 恰 **1 红**（只红面包屑那例）。
- ③保留上报、但把 `lastBadge = label` 挪回判决之前 ⇒ 恰 **1 红**（只红重试那例）。
- 两个叶子互不遮蔽；三次均按 `shasum -a 256` 逐字节还原。`Dock.svelte` 的定值快照为 `fb850db128171e1dd3241658ac562d8161054f7b6f4b4861bb82cebb4e1076dd`。**`bun run check` 在本轮第一次落地时红过**（`typecheck:svelte` 报 `src/svelte/Dock.svelte` 344–351 六条 `Property 'kind'/'detail' does not exist on type `{ ok: true; }`）—— 这是门禁抓到的真缺陷，不是噪声：`bridgeDiag(command)` 的返回类型是 `BridgeDiag | { ok: true }`（「没有记录」那一支），第一版先判 `diag.kind === "not-bridged"` 而没先排除 `ok`，TS 就没把 `{ ok: true }` 收窄掉；修法照同文件 `wm_windows` 的既有形状 `if (diag.ok || diag.kind === "not-bridged") return;`。因该修正改变了文件哈希，**全部三条负控都对最终内容重跑**（结果同上：2 ∕ 1 ∕ 1 红）。

**⑦回归**：同族 6 套件（`dock-badge-refusal` ∕ `dock-badge` ∕ `dock-add` ∕ `dock-autohide` ∕ `dock-open-report` ∕ `home-dock`）**43 绿**；`lib/__tests__/dockBadge.test.ts` 属 bun 扫描集（`bun run check` 覆盖）。

**⑧如实边界（不宣称的部分）**：

- **真机未复核**：证据是 happy-dom 下 `__TAURI_INTERNALS__` 的拒绝桩与 `console.warn` 断言，未在真实 macOS Dock 上目视。
- `bridgeDiag(command)` 是**按命令名**共享的槽位（cap 48），继承「同一命令两次重叠调用时前一次可能读到后一次读数」的既有并发窗口（§8.14 ⑤）；`dock_badge_set` 只有这一个写者，故实际不重叠。
- **顺带核实、如实不修**：同族的 `src/svelte/osPushWatcher.ts:63` `void requestAttention("info")` 也丢弃判决，但那条**写明了理由** —— 「Fire-and-forget: the poller must not wait on a cosmetic call」—— 与 `lib/shortcuts.ts` 的 `copy_to_clipboard` 同属「有据可依的不读」，继续记录而非改掉。

---

### 8.22 起点是「帮助我按照航空航天级别标准修复上面发现的问题，审计与补全代码，完善功能」，量到的是 **§8.21 ⑧ 自己点名的那一族里破坏性最强的一半：两块通知面板的「清空」先清本地、再丢掉设备的判决 —— 被拒时屏幕先清空、轮询又把设备仍持有的行写回来**（REQ-A1251／F-SH-528）

**①起点与量法**。§8.21 的残差名单里记着「同族还有丢掉判决的地方」。本轮顺着「**一个动作把它的判决丢给了谁**」这条尺子扫通知域，落在两块浮层面板的「清空」上：

```ts
// NotificationCenter.svelte::clear（修前）
const clear = () => {
  const hadDeliveries = notifs.some((n) => n.source === "push");
  writeStoreValue(NOTIF_KEY, []);
  // Best-effort, like `markRead`: ... a device that refuses leaves the rows on screen
  // (the failure is visible, not hidden).
  if (hadDeliveries) void clearNotificationHistory();
};
```

`DesktopNotificationCenter.svelte::clear` 是同一形状的孪生（`persist([])` 在前）。

**②缺陷**。推送行在这两块面板里是**设备历史的投影**：`src/svelte/osPushWatcher.ts` 每几秒重问一次 `push_get_history`，把存储里已经没有的记录原样写回。所以一次只在本地生效的「清空」会在下一次轮询（≈5 秒）之后**复活**。而 `clearNotificationHistory()`（`src/lib/pushNotifications.ts`）返回的正是这个判决 —— `push_clear_history` 答 unit，`invoke` 把 `Err` 折成 `null`，除 `bridgeDiag` 之外拒绝与成功无从分辨（REQ-A845 ∕ F-SH-270）。两块面板把它丢进了 `void`，并且**先**删了本地。

**③一句可检验的假前提**。两处注释都写着「a device that refuses leaves the rows on screen（the failure is visible, not hidden）」。屏幕上的行恰恰在读到判决**之前**就被删掉了 —— 这正是它们**当不了**「告知」的原因。这不是「少报一句」，而是屏幕与设备在下一次轮询前永久不一致。

**④单所有者规则早已写下**。同族的 `settings/NotificationsPage.svelte::clearAll`（REQ-A1238）与 `PushSettings.clearPushHistory` 逐字写着：**The local wipe is the destructive step, so it waits for the device to confirm**。两块面板做的是它的反面。

**⑤修法（顺序就是修法）**。先问设备、由它的答复决定本地那一半：

```ts
if (hadDeliveries && bridged() && !(await clearNotificationHistory())) {
  clearErr = t("pushSettings.clearFailed");   // 设备没做 ⇒ 本地一条也不许删
  return;
}
persist([]);   // 只在成功之后
```

拒绝要**渲染出来**（`NotificationCenter` 用本文件已有的 `role="status"` 便笺习惯，`data-testid="nc-push-refused"`；`DesktopNotificationCenter` 与 `storeError` **分开**新增 `clearErr` + `data-testid="dnc-push-refused"` —— 一次写失败不该抹掉另一件事的说法），复用同一条 i18n 键 `pushSettings.clearFailed`。

**⑥门的范围等于它的理由**。写回本地的是 `osPushWatcher`，它在无桥时第一步就 `if (!bridged()) return 0`。于是**没有宿主**时既没有设备历史可清、也没有轮询会写回 —— 那一下本来就是纯本地动作，不该被一句问不到的判决拦住。这与 §8.20 里 `NotificationsPage` 的 `bridged()` 门是同一条尺子。

**⑦红先与负控**。新套件 `crates/amos-tauri/frontend-ts/svelte-tests/notif-center-clear-refusal.svelte.test.ts` 3 例（两块面板各一例拒绝叶 + 一例纯本地叶）。**红先**：修前恰 **2 红 ∕ 1 绿**（两例拒绝叶红、纯本地叶本来就绿）。**负控 ×3（逐叶隔离、`cp` 逐字节还原 + `shasum -a 256`）**：①`NotificationCenter` 还原「先清本地、再 `void`」⇒ 恰 **1 红**；②保留正确顺序但删掉 `clearNote = t(…)` ⇒ 恰 **1 红**（同一条用例的第二条断言）；③`DesktopNotificationCenter` 还原原始形状 ⇒ 恰 **1 红** —— 顺序叶与上报叶互不遮蔽。全量 svelte 套件 **193 文件 ∕ 2266 例全绿**。`bun run check` 的唯一红是 `svelte-ignore-scan` 对 `src/svelte/FilesApp.svelte:1640` 的既有发现（另一轮的文件，未动）。

**⑧如实边界（不宣称的部分）**：

- **真机未复核**：证据是 happy-dom 下 `__TAURI_INTERNALS__` 的拒绝桩（`push_clear_history` throws ⇒ `invoke` 折成 `null` ⇒ `bridgeDiag.ok` 为 false）与渲染断言。
- **同族残留，本轮未修**：`dismiss`（`deleteNotification`）与 `markRead`（`markNotificationRead`）在两块面板里同样被 `void`。它们的破坏性小一档（那两条命令答一个 `boolean`，且删除的是**一行**、不是整份历史），但形状相同，留档待下一轮。
- **本轮的两块面板改动建立在另一轮的进行中改动之上**：修前的工作树里，`clear` 已被（未提交的）另一轮从「只写本地」改成「连设备一起清、但丢判决」；本轮补上那条纪律。工作树里的 `NotificationCenter.svelte` 期间还被 REQ-A1249（删 `seedNotifs`）改过一次，两次改动**互不重叠**（一行合入时 `git diff` 核实）。

---

### 8.23 起点是「帮助我按照航空航天级别标准修复上面发现的问题，审计与补全代码，完善手机操作系统的功能」，量到的是 **§8.22 ⑧ 自己点名的那条残差：逐条「忽略」与整份「清空」同形、只是缩到一行 —— 只在本地面删掉那条推送，设备的判决丢进 `void`**（REQ-A1303／F-SH-578）

**①起点与量法**。§8.22 的残差写着「`dismiss`（`deleteNotification`）与 `markRead`（`markNotificationRead`）在两块面板里同样被 `void`，形状相同，留档待下一轮」。本轮先把这两条分开核实，只留真正的那一条：

```ts
// NotificationCenter.svelte::dismiss（修前）
const dismiss = (id: string) => {
  if (notifs.find((n) => n.id === id)?.source === "push") void deleteNotification(id);
  writeStoreValue(NOTIF_KEY, removeNotif(notifs, id));
};
```

`DesktopNotificationCenter.svelte::dismiss` 同形（`persist(removeNotif(notifs, id))` 在后）。

**②为什么 `markRead` 不属于这一族（如实排除）**。投影 `mergePushHistory` 是**按 id 只增**的：`if (held.has(rec.id)) continue;` —— 它对已经在列表里的 id 什么都不做，因此一次被拒的已读回执**不会**把 `read` 改回去。该文件写下的理由（「a device that refuses cannot un-read the list」）成立。**排除一条，和确认一条一样是结论**，写在这里以免下一轮重复核查。

**③缺陷**。`dismiss` 则完全是 `clear` 的缩影：推送行是设备历史的投影（`osPushWatcher` 每几秒重问 `push_get_history` 并把存储里没有的写回），所以只在本地面删掉的一行会在下一次轮询之后回来 —— 屏幕先消失又出现，中间没有一句解释。逐条「忽略」是这一族里**最常被点**的控件（每一行都有一颗），暴露面比「清空」更大。

**④本轮真正的技术要点：判决在账本里，不在布尔值里**。`delete_notification`（`push_notifications.rs`）答的是「设备手里有没有这条」：`true` = 删掉了，一个格式良好的 `false` = 设备本来就没持有 —— **两者都是答复**，两种情况下这一行都真的不在设备上了，本地删掉是对的。只有 `bridgeDiag` 知道这次调用**到没到**设备，而「会不会被写回来」问的正是后者。所以：

```ts
if (row?.source === "push" && bridged()) {
  await deleteNotification(id);
  if (!bridgeDiag("push_delete_notification").ok) { pushNote = t("pushSettings.deleteFailed"); return; }
}
persist(removeNotif(notifs, id));
```

拿那个布尔值当判决（`!(await deleteNotification(id))`）会把一次**成功**报成失败 —— 镜像缺陷。这不是理论顾虑：`markNotificationRead` 的 `?? false` 早就在 `pushNotifications.ts` 里被记为「`false` 也可能是没有桥」，同一条尺子。`bridged()` 依旧把门限在理由之内（无宿主时既没有历史可删、也没有轮询会写回）。

**⑤共用一个便笺槽，顺带改掉一个够不着的名字**。两块面板现在有**两种**动词会各自被设备拒绝（清空 ∕ 忽略），而它们说的是同一件事 ——「你刚点的那一下没到设备」。所以共用一个槽（后一次替换前一次，而不是堆叠）。随之更名：`nc-clear-refused` → `nc-push-refused`、`dnc-clear-refused` → `dnc-push-refused`，并**同步更新 F-SH-528 在 `fmea-gen.mjs` 里的 marker 与 `docs/FMEA.md`、本文件 §8.22 的行文** —— 一个指向被改名符号的 marker 是一条够不着的声明，不是证据。

**⑥红先与负控**。新套件 `crates/amos-tauri/frontend-ts/svelte-tests/notif-center-dismiss-refusal.svelte.test.ts` **4 例：两块面板各一例拒绝叶，另加两例控制叶** —— 设备**答了** `false`（镜像缺陷的检测器）与无宿主（纯本地路径照常生效且不出声）。**红先**：修前恰 **2 红 ∕ 2 绿**。**负控 ×3（逐叶隔离、`cp` 逐字节还原 + `shasum -a 256`）**：①`NotificationCenter` 还原原始两行 ⇒ 恰 **1 红**；②保留正确顺序但把判决读成命令的布尔值 `!(await deleteNotification(id))` ⇒ 恰 **1 红**，且**恰是那条镜像控制叶**（顺序叶与判决来源叶互不遮蔽）；③`DesktopNotificationCenter` 还原原始形状 ⇒ 恰 **1 红**。全量 svelte 套件 **198 文件 ∕ 2309 例全绿**。

**⑦如实边界（不宣称的部分）**：

- **真机未复核**：证据是 happy-dom 下拒绝桩（`push_delete_notification` throws ⇒ `invoke` 折成 `null` ⇒ `bridgeDiag.ok` 为 false）与渲染断言。
- **`bun run check` 本轮的红不在本轮的改动里**：`typecheck:svelte`（`--fail-on-warnings`）红在 `src/svelte/FilesApp.svelte:1650` 的 `a11y_media_has_caption`（`<video>` 缺 `<track kind="captions">`），`svelte-ignore-scan` 的 R5 也落在这个文件的 1640 行。两者都是另一轮正在进行中的改动，本轮**未动**该文件；本轮改动的两个 `.svelte` 在 `svelte-check` 下 0 errors ∕ 0 warnings。
- **同一份新行文的 marker 纪律**：F-SH-578 的 markers（`REQ-A1303`、`bridgeDiag("push_delete_notification")`、`pushSettings.deleteFailed`）都指名修订后**仍然存在**的字符串。
