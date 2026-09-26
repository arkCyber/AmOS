# AmOS — macOS 原生菜单(Aqua Global Menu)

> 状态:已实现 (P0-2 完成,2026-09-16)
> 范围:macOS 桌面形态的原生全局菜单
> 关联:
> - `crates/amos-tauri/src/menu.rs`(宿主实现)
> - `crates/amos-tauri/src/lib.rs`(boot 接入)
> - `docs/PC_DESKTOP_AUDIT.md` §3.4(顶栏缺陷)

## 1. 设计目标

macOS 用户进入桌面形态时,顶部必须看到**真实的 Aqua 全局菜单** —— Apple 🍎 + 当前应用名(固定 "Amos")+ File / Edit / View / Window / Help。这是 macOS 桌面体验**最显眼**的特征之一(参见 `PC_DESKTOP_AUDIT.md §3.4`)。

## 2. 菜单结构

| 菜单 | 内容 | 由谁处理 |
|---|---|---|
| **Amos**(Apple 菜单) | About Amos / Preferences… / Services (占位) / Hide Amos / Hide Others / Show All / Quit | About → **平台自己的 About 面板**(`orderFrontStandardAboutPanel`,REQ-A432)/ Quit / Hide-Amos 由 Rust 处理,其余发到前端 |
| **File** | New Window (⌘N) / Close Window (⌘W) | 发到前端 |
| **Edit** | Undo / Redo / Cut / Copy / Paste / Select All | 预定义项(muda) + **我们提供的文案**（REQ-A439：行文本来自 `MenuLabels`，所以中文 UI 下是「撤销 / 重做 / 剪切 / 拷贝 / 粘贴 / 全选」，而不是 AppKit 的**系统语言**文案）；行为仍是平台的选择器（`undo:` / `copy:` / …），WebView 处理 |
| **View** | Minimize (⌘M) / Zoom / Enter Full Screen (⌃⌘F) | 发到前端 |
| **Window** | Minimize / Maximize | 预定义项 |
| **Help** | (空,留作应用自定义) | — |

**窗口类条目的可用性(CREQ-A433)**:`Close Window` / `Minimize` / `Zoom` / `Enter Full Screen` 只作用于**被聚焦的应用窗口**。没有这样的窗口时(只有启动器 / 空桌面)它们**会被置灰** —— 实测(2026-09-18,AX 逐项点击)此前它们是**可用的却什么都不做**(壳有意跳过启动器 F-SH-008,而启动器本身已是屏幕大小、Zoom 无处可 zoom),这正是 F-SH-001 那类"看起来能用"的缺陷长在操作系统自己的菜单里。同步由 `menu::sync_window_items` 负责,触发点是**平台自己的焦点事件**(`WindowEvent::Focused`)与安装完成:判据先问平台 key 窗口、再回落到窗口管理器(F-PLATFORM 的一致性,见 REQ-A431)。

**已知不符/未做(如实记录)**:
- `File ▸ New Window` ✅ **标签又说真话了（REQ-A473 收口 REQ-A434）**：REQ-A434 曾把它改名为「New Files Window」，因为该条目**只能**开「文件」应用的窗口（`wm_open("files")`）—— 真正的 per-app 新窗口需要"标签 ⇄ 应用"之外的第二身份。身份模型落地后（`crates/amos-wm/src/identity.rs`），该分支改为向壳要 **`wm_new_window(被聚焦的应用)`**（`DesktopShell` 的 `menu.new-window` → `desktopSystemKeys::newWindowTarget`，只有在**没有**应用窗口被聚焦时才落回「文件」—— Finder 自己的规则），于是标签重新叫 `New Window` / 「新建窗口」，与 in-app 菜单那一行同词。**落回文件是"一处"规则**（菜单行、⌘N、原生条目共用 `newWindowTarget`），不是三处各写一遍。
- 菜单标签**随 UI 语言**：✅ **已做（REQ-A437）**——`MenuLocale` + `MenuLabels`（zh/en 两张表，中文措辞照 Apple 菜单词汇），启动时宿主读共享存储的 `amos-ui.locale`，切语言时前端调 `menu_set_locale` 重画；菜单栏此前是**整屏唯一说英文的地方**（壳默认 zh）。**门禁**：`scripts/menu-i18n-scan.mjs`（`make lint`，`--selftest` 6 断言）钉住"标签只能来自 `MenuLabels`"（`build_menu` 里出现字符串字面量即红，加速键 `Some("CmdOrCtrl+N")` 不算标签）与"每个字段都真的被画出来"（没有死译文）。仍未做：**系统语言变更**不追（AppKit 自己的事）、Windows/Linux 菜单、`Services` 仍是占位。
- `Services` 是占位(系统级服务子菜单未接入)。
- **Edit 菜单的行文案随 UI 语言** ✅ **已做(REQ-A439)**:预定义项的行文本此前由 AppKit 按**系统语言**生成 —— 在一台系统语言英文、UI 语言中文的 Mac 上,`编辑` 里读到的却是 `Undo / Redo / Cut / Copy / Paste / Select All`(实测)。现在六行(window 菜单的 `最小化 / 缩放` 同理)都通过 `*_with_text(l.<字段>)` 给我们自己的文案(Apple 中文词汇:**拷贝**不是「复制」);**选择器与 ⌘ 加速键仍是平台自己的**,行为不变。门禁 `scripts/menu-i18n-scan.mjs` 已扩展到 `*_with_text("字面量")` 这一形状。**仍由系统注入的三行未动**:`AutoFill` / `Start Dictation…` / `Emoji & Symbols`(AppKit 自动加进 Edit 菜单,不在我们的树里)。
- **⌘A(全选)在 macOS 上按不动 —— 实测的平台缺口(未修,记录在案)**:2026-09-19 在本机 `Amos.app` 的「文件」窗口里(搜索框用 Tab 聚焦,`AXFocusedUIElement = AXTextField`):

  | 手势 | AmOS | 对照:TextEdit(同一台机、同一脚本) |
  |---|---|---|
  | ⌘C / ⌘X / ⌘V | 动作(⌘C 进剪贴板、⌘V 落下文本) | 动作 |
  | ⌘Z | 动作(撤销刚打的字) | 动作 |
  | 点 `编辑 ▸ 剪切/拷贝/粘贴/撤销/全选` | 动作(全选那行点下去能把字段文本选中并复制) | — |
  | **⌘A / ⇧⌘A / ⌥⇧⌘A** | **什么都不发生**(⌘A 后再 ⌘C,剪贴板为空 ⇒ 页面里没有任何选区) | 选中并复制 |

  四次改动都试过,结论是**它在我们这一侧按不动**:①平台自带行(⌘A 由 muda 注册,AX 里 `AXMenuItemCmdChar=A`、`enabled=true`)不触发;②换成我们自己的 `MenuItem` + `CmdOrCtrl+A`,同样不触发(日志里 `menu item activated` 一次都没有);③把该行**去掉加速键**,按键也没有落到页面的 `keydown`(前端的捕获监听器没被调用);④页面既然收不到键,前端的规则对它无效。点击路径一直是好的(平台选择器),所以这一行**留着平台实现 + 我们的文案**,并把「键盘 ⌘A」登记为缺口而不是假装完成。已做的补救:`lib/editKeys.ts` 提供 `selectAllInFocus` / `selectAllFromMenu`(聚焦字段选内容、否则选页面),用于**没有原生菜单的平台**(Windows/Linux: `menu::install` 是 no-op)与**壳自己的 Edit 菜单行**(那一行的实现此前是 dispatch 一个合成 `keydown`,什么也不做)。


## 3. 事件路由

```
muda MenuEvent
  ↓
menu::on_menu_event(app, event)
  ↓
  ├─ menu.about       → Rust → 平台自己的 About 面板（orderFrontStandardAboutPanel，REQ-A432）
  ├─ menu.quit        → Rust → std::process::exit(0) [terminal]
  ├─ menu.hide-amos   → Rust → window.hide()
  └─ 其它 (含 menu.preferences / menu.new-window / menu.close-window / …)
        → emit "menu-event" (前端监听)
```

终端事件(`menu.quit` / `menu.close-window`)在 Rust 处理后**不**发到前端;其余(如 `menu.preferences`)发到前端,让壳内的对应 UI 与原生菜单**同步**。`menu.about` **不需要**前端:面板由平台自己渲染(REQ-A432 —— 在此之前它 emit 一个无人订阅的 `show-about-dialog`,实测点击后什么都不出现)。

## 4. macOS 平台约束

- `.set_menu()` 调用的菜单根**只能**包含 `Submenu`(直接 `MenuItem` 不可);
- 我们在 `build_menu` 里严格只用 `SubmenuBuilder` 喂 `MenuBuilder`;
- 每棵树只能 build 一次(`MenuItemKind` 不能复用),所以 `item()` 是值构造,不是共享句柄。

## 5. 非 macOS 桌面

非 macOS 上 `install()` 是 **no-op**(记一条 `debug` 日志)。Windows GTK 菜单与 Linux 桌面菜单不在本轮范围(参见 `PC_DESKTOP_AUDIT.md §5.1`)。

### 5.1 那么那里的"菜单"是什么 —— 顶栏的 in-app 菜单

在没有原生菜单栏的平台上,顶栏里那颗 **File / Edit / View / Window / Help** 就是**唯一**的菜单面
(`frontend-ts/src/svelte/modules/TopbarMainMenu.svelte`,REQ-A275)。因此它的每一行都有额外的
分量:**在这里画成"不可用"就等于那条命令从菜单不可达**。

- **REQ-A457(2026-09-19)之前**,`Window ▸ 缩放` 与 `View ▸ 进入全屏幕` 正是这种行:它们被画成
  灰的(`…Unavailable`,无 handler),而 `wm_zoom` / `wm_fullscreen` **早已存在**、原生菜单也已接线
  (REQ-A415)——同一个 shell 的两个菜单面对同一条命令说法相反,平台上的用户根本点不到它。
- **修法**:两行改为真动作,并且**不再各自判断"哪个窗口是焦点"** —— 壳通过
  `SHELL_CHROME_API.windowAction("zoom" | "full-screen")` 代做,落进 `DesktopShell::applyWindowAction`;
  原生菜单的 `menu.zoom` / `menu.enter-fullscreen` 走的是**同一个函数**。于是"焦点窗口是谁"
  只有一个所有者(壳的 `wm_windows` 轮询),两条路也不会再漂。
- 仍然是灰的、且**应当**保持灰的是:`File ▸ 打印…`(宿主没有打印管线)、`Window ▸ 前置全部窗口`
  (宿主没有该命令)、`Help ▸ 搜索 / 应用帮助`(没有 per-app 帮助内容)、`Edit ▸ 撤销`
  (见下)。

### 5.1.1 菜单里的键帽（keycap）说的是**哪一个**键（REQ-A484）

**已做（REQ-A484）**：菜单行右边那个 `⌘W` / `⌘N` **不再读默认表**，而是读**用户合并后的绑定**
（默认 + 覆盖 + 禁用，即 `DesktopShell` 派发时用的同一份 `keyboardBindings.bindings.system`）——
`lib/desktopKeys.ts::desktopShortcutLabel(kind, bindings?)`，`DESKTOP_SYSTEM_KEYS` 每行带**配置 id**
（`intentIdFor`）。**禁用**的绑定在合并后的 map 里**不存在**，于是菜单**什么都不画**：菜单不得广告
壳没有的绑定（REQ-A342 的那条规则）。**Dock 右键菜单**这一轮第一次画上键帽，且**只给动作与和弦一致的
两行**画：`新建窗口 ⌘N`、`隐藏 ⌘H`；`打开`/`显示` 没有对应和弦，`退出` 不画（macOS 那里是 ⌘Q，本壳
未绑定；最近的 ⌘W 关的是**焦点**窗口，是另一个动作），`选项…` 是灰占位。

**已做（REQ-A485）：原生菜单栏的 accelerator 跟着用户的键位走**。这一格此前是 `menu.rs` 里的**编译期字面量**
（`DEFAULT_ACCELERATORS` 的七行：⌘, / ⌘H / ⌥⌘H / ⌘Q / ⌘N / ⌘W / ⌘M），界面上**读不出来**（标题里没有键帽），
于是改绑/禁用之后菜单栏会一直广告旧键。现在：壳在**挂载与配置变化**时把合并后的绑定推给宿主
（`menu_set_shortcuts`，与语言同步 `menu_set_locale` 同一条先例），宿主用 muda 的 `set_accelerator` 就地更新，
`null` = 该绑定被禁用 ⇒ **清掉那一格的键帽**；找不到行或设置失败会按 id `warn!`。**真机读数**：宿主日志
`menu accelerators synced with the shell's bindings applied=5 sent=5`，AX 读到 `新建窗口 → Cmd+N`、
`关闭窗口 → Cmd+W`、`最小化 → Cmd+M`（读法：`AXMenuItemCmdChar` + `AXMenuItemCmdModifiers`）。
**边界**：真机只走了默认绑定（改绑要写 WebView 的 localStorage）；⌘Q / ⌥⌘H 等行也同步了，但其中一部分 AppKit
另有约定；**⌘\`** 没有原生行，因此不在同步集里。

**已修（REQ-A487）：那次读数的两个 5 是巧合 —— 告警自己的计数错了**。上面的真机读数是在**全部绑定都没被禁用**的
状态下取的（`sent=5 applied=5`），于是掩盖了一件事：壳用来和宿主比对的 `sent` 是 payload 里**非 null** 的条数，
而宿主数的 `applied` 是**碰过的行数**——包括它**清掉**的那一行（`null` = 用户禁用了该绑定，清掉键帽同样是"干了活"，
`apply_accelerators` 把它计入，它自己那句短警告也是拿 `updates.len()` 比）。两者在"有一个绑定被禁用"的配置下
必然不等：读者可见的后果是**挂载即告警**`the host synced fewer menu accelerators than the shell sent
{"sent":4,"applied":5}` —— 一边说"同步得比发的少"，一边 `applied`(5) 比 `sent`(4) **大**。**一个在没坏时也会响的
告警，就是真的坏了时被忽略的那个**（这一格修的就是告警本身，不是同步）。修法：`sent` 改成**问过的行数**
（`Object.keys(payload).length`），并在两侧都钉住：壳侧
`svelte-tests/desktop-shell.svelte.test.ts`（禁用一行 ⇒ 宿主答 5 ⇒ **不得**告警；宿主答 4 ⇒ 必须告警且
`sent:5 / applied:4`），宿主侧 `menu.rs::tests::accelerator_updates_read_the_shell_payload`（`null` 也产出一条
update ⇒ `updates.len()` 就是 payload 长度）。**复现证据**：把两条测试里宿主答 5/答 4 分别喂进去，修前第一条
红（`{"sent":4,"applied":5}` 打进日志），修后 4 条全绿。

### 5.2 ~~明确**不是**缺口的:`⌘` + 反引号（同应用窗口循环）~~ → **已做（REQ-A473）**

审计里一度把"`⌘` + 反引号（同应用窗口循环）"记成缺口 —— 检索后**撤回**:宿主**一个 label 只有一个窗口**
(`wm.rs` 的 `label ⇄ app` 映射,REQ-A434 的注释也写明"per-app 'new window' 需要标签之外的第二身份"),
所以"在同一个 app 的窗口之间循环"当时**没有可循环的对象**；当时登记的真正缺口是**多窗口身份模型**本身。

**该模型已落地**（`crates/amos-wm/src/identity.rs`：`files` / `files_2` / `files_3`；一个身份一种拼写；
序数有上界；分配取最小空闲序数；循环顺序由序数决定），于是：

- `⌘\``（`SYSTEM_DEFAULTS.cycleWindows`）→ `wm_cycle_app(app_id, forward)`：只走**焦点窗口所属应用**的
  环，按序数、可回绕；带 Shift 时反向（`SystemIntentOptions.forward`）。**不足两扇窗时具名拒绝**
  （"there is nothing to cycle"）而不是"成功但没动" —— 死弦是本仓的缺陷形状。
- `⌘N`（`SYSTEM_DEFAULTS.newWindow`）→ `wm_new_window(app_id)`：宿主自己分配实例 label，调用方只说应用。
  与 `File ▸ New Window`、原生菜单项共用 `newWindowTarget` 这一条规则。

**仍未做**（如实登记，别把这一节读成"窗口那族做完了"）：**per-app 菜单模型**（每个应用自己的主菜单）仍是
F-SH-001 那一族；Dock 右键菜单已有「新建窗口」（REQ-A474）。

**锚在指针上的菜单怎么放**（REQ-A481 的真机缺陷 F-SH-037，已修）：它们用 `left:x; top:y` 直画，而 Dock 在窗口
**最底边** —— 1496×880 的窗口里右键 访达 图标（指针 y=839、面板 200×223）时面板画到 y=1091，被窗口下边缘（909）
截断，除第一行外的每一行**存在但够不着**（像素实测：菜单本该在的地方是桌面壁纸）。现在四个锚在指针上的浮层
（Dock 图标菜单 / Dock 全局菜单 / Dock 溢出菜单 / 桌面右键菜单）共用 `lib/menuPlacement.ts::placeMenu`：
**先翻转、后夹取**（下面放不下就画到指针上方；两边都不够则保住前几行、允许下溢；margin 永远不能把面板挤出窗口；
**没有测量到尺寸的菜单不动**）。真机复核：同一个菜单的 AX frame 从 `(793,868) 200×223`（底 1091，被裁）变成
`(793,677) 200×183`（底 860 ≤ 880 ✓），而且点击「新建窗口」**真的开出了窗口**。
**App Exposé 已做**（REQ-A476）：`⌃↓` 铺开**焦点应用**的窗口（`svelte/AppExpose.svelte` + `lib/wm.ts` 的
`windowsOfApp`/`focusedAppOf` + `desktopLayout.shouldShowAppExpose`）；焦点应用不足两扇窗时**什么都不开**
（macOS 同样）并把原因写进诊断账本（`desktopSystemKeys.appExposeRefusal`）。它的边界：**没有缩略图**
（瓷砖是应用图标 + 名字）、**没有方向键网格导航**、顺序就是宿主给的顺序。

### 5.3 仍未做的:`Edit ▸ 撤销`(诚实登记)

原生的 `编辑 ▸ 撤销` 用平台选择器(点击有效);in-app 那一行仍是灰的。要让它真,唯一的路是
`document.execCommand("undo")` —— 与 `⌘A` 用 `execCommand("selectAll")` 同一条(已废弃但 WebKit
仍实现)。**本轮没做**,原因是**无法在本机验证**:`execCommand` 在 happy-dom 里没有实现,而真实
WebView 的撤销行为没有可用的观测手段(没有 GUI 自动化)。宁可继续把它画成灰的,也不把
"看起来接好了、实际取决于引擎"的东西当成已接 —— 这条与 §7 里 `⌘A` 的处置同一个理由。

## 6. 验收

- 在 macOS 上启动桌面形态 → 顶部出现完整菜单条
- ⌘Q / ⌘W / ⌘M / ⌘N 触发对应操作
- `Amos ▸ About Amos` 出现**平台自己的** About 面板(名字/版本/图标来自 bundle 的 `Info.plist`)
- 只有启动器时 `Close Window` / `Minimize` / `Zoom` / `Enter Full Screen` 为**灰**(无窗口可作用);聚焦任一应用窗口后变回可用
- Hide Amos (⌘H) 隐藏主窗口
- 前端收到 `menu-event` 事件时更新自己的 UI(如顶栏聚焦状态)

## 7. 不在本轮范围

- 每个 app 注册自己的菜单描述(每个 app 描述 File / Edit 等) —— 需要 Tauri 2 后续窗口级菜单覆盖 + 菜单注册 API;目前菜单是**全局共享**的;
- NSAlert 真正的"关于本机"对话框 —— 需要 objc2/objc FFI,留作后续 Phase。
- **⌘A 的键盘通路**(见 §"已知不符/未做"里那张实测表):菜单项已注册该加速键、页面也收不到按键,三次改法都没能让它动作;要再往下查需要 WWDC 级别的 WebView/AppKit 追踪,或在宿主层用 `NSEvent` 监视器抢键(平台代码 + FMEA 成本,未做)。
