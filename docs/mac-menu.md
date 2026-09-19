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
- `File ▸ New Window` ✅ **已收口为「New Files Window」(REQ-A434)**:它开的就是**「文件」应用**的窗口(`wm_open("files")`,与 Finder 的 "New Finder Window" 同形),此前标签说"New Window"却 **没有**说出是哪个应用 —— 实测(2026-09-18)在 Notes 窗口聚焦时点它,用户拿到一个「文件」窗口且无从预知;真正的"给当前应用再开一个窗口"需要"标签 ⇄ 应用"之外的第二身份(宿主一个 label 只有一个窗口),所以当下的诚实做法是**让标签说出会发生什么**。
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

### 5.2 明确**不是**缺口的:`⌘` + 反引号（同应用窗口循环）

审计里一度把"`⌘` + 反引号（同应用窗口循环）"记成缺口 —— 检索后**撤回**:宿主**一个 label 只有一个窗口**
(`wm.rs` 的 `label ⇄ app` 映射,REQ-A434 的注释也写明"per-app 'new window' 需要标签之外的第二身份"),
所以"在同一个 app 的窗口之间循环"当前**没有可循环的对象**。加一个只会得到死键 —— 本仓对死键的
立场是"宁可不加,也不加一个按下去什么都不发生的键"。真正的缺口是**多窗口身份模型**本身
(per-app 菜单模型、per-app 多窗口),它记在 G6 那一族里。

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
