# AmOS — FMEA 失效模式与影响分析

> **Failure Modes and Effects Analysis**(失效模式与影响分析)
>
> 来源:ARP4754A/ARP4761 民用航空安全方法学 + DO-178C 软件保证框架
>
> 状态:**机读 + 文档化**,由 `scripts/fmea-gen.mjs` 从代码扫描导出
>
> 适用:**所有已识别的安全关键路径**(守护进程、桥、传输、机器人控制)
>
> **诚实声明**:本文件由代码与文档双源扫描生成。**真实部署前的适航审定**要求**独立 FMEA 团队**复核本表;本文件用作工程纪律而非审定证据。

---

## 1. 风险评估尺度

### 1.1 严重性 (Severity, S)

| 等级 | 含义 | 示例 |
|---|---|---|
| **S5 — 灾难性** | 可能致人死亡/系统丧失 | 误急停;UDS 越权访问;电源切断未广播 |
| **S4 — 严重** | 主要功能失效,需操作员干预 | 守护进程崩溃;剪贴板泄露给另一用户 |
| **S3 — 中等** | 次要功能失效,有降级路径 | 推理响应缓存污染;日志轮转失败 |
| **S2 — 轻微** | 用户可察觉但不影响主功能 | UI 文案错误;时区显示偏移 |
| **S1 — 可忽略** | 用户不可见,无操作影响 | 调试日志缺失;诊断计数偏差 |

### 1.2 发生率 (Probability, P)

| 等级 | 含义 | 频次 |
|---|---|---|
| **P5 — 频繁** | 在常规使用中必然发生 | 每次会话触发 |
| **P4 — 偶尔** | 在某些使用模式下发生 | 每周可见 |
| **P3 — 罕见** | 边缘场景下发生 | 每月可见 |
| **P2 — 不太可能** | 在异常配置下发生 | 每季度可见 |
| **P1 — 极不可能** | 仅理论分析可达 | 已知案例中未发生 |

### 1.3 可检测度 (Detectability, D)

| 等级 | 含义 | 检测手段 |
|---|---|---|
| **D5 — 不可检测** | 无任何信号告诉用户/系统 | 静默丢弃;无日志 |
| **D4 — 难以检测** | 仅事后取证才可发现 | 日志文件损坏 |
| **D3 — 可检测** | 需专业工具/读日志 | `get_status.*` 上 wire |
| **D2 — 易检测** | 普通用户可见 | 横幅/通知/UI 变化 |
| **D1 — 自动处理** | 系统自带降级/重试 | 熔断器/超时/重拨 |

### 1.4 风险优先级数 (RPN) = S × P × D

| RPN 范围 | 行动 |
|---|---|
| **≥ 100** | 必须缓解(强制门禁+回归测试) |
| **50-99** | 应缓解(单测覆盖 + 文档化边界) |
| **20-49** | 可接受(纳入监控) |
| **< 20** | 不需行动 |

---

## 2. 关键功能失效模式

### 2.1 守护进程 (amos-ai)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|----------|
| F-AI-001 | 守护进程进程崩溃 | System UI 失去 AI/翻译/审计/守护能力 | 4 | 3 | 2 | 24 | `amos-supervisor` 崩溃自动拉起;UDS 重拨 | `supervisor-smoke.sh` |
| F-AI-002 | 守护进程内存泄漏 | OOM 杀进程 | 4 | 2 | 3 | 24 | `GenerationPool` 上限;`ResponseCache` LRU+TTL | `pool::tests`, `cache::tests` |
| F-AI-003 | 守护进程未察觉挂起(死锁/长 GC) | 客户端超时但 UI 不知 | 4 | 2 | 4 | 32 | gRPC deadline;`probe_requests_per_second` 独立通道 | `security::probe` 单测 |
| F-AI-004 | 日志 sink 写失败静默 | 事故后无取证依据 | 3 | 2 | 5 | 30 | `LogSinkReport` 上 wire + 计数 | `logfile::tests` |
| F-AI-005 | 推理后端响应截断/乱码 | 用户收到残缺文本 | 3 | 3 | 2 | 18 | 流式契约 + `bytes_per_token` 健康检查 | `inference::tests` |
| F-AI-006 | 后端不可达但声明"已连接" | 永远等待响应 | 3 | 3 | 2 | 18 | `BreakerBackend` 三态熔断 | `breaker::tests` |
| F-AI-007 | 会话累积无界 | 内存耗尽 | 3 | 2 | 3 | 18 | `SessionManager` 上限 100 | `session::tests` |
| F-AI-008 | 池满拒绝但未区分原因 | 无法判断扩容还是重试 | 2 | 3 | 2 | 12 | `Saturated` vs `WaitTimeout` 类型化拒绝 | `pool::tests` |
| F-AI-009 | 审计落盘失败 → 用户被告知"已记录" | 监管不可追 | 4 | 2 | 4 | 32 | `ok=false` 诚实回返;`recorded/attempted/reason` 报告 | `privacy_audit_e2e` |
| F-AI-010 | UDS 异用户访问通过 | 隐私数据被同主机其他用户读取 | 5 | 2 | 5 | 50 | `peercred.rs` 同用户校验 + `AMOS_UDS_PEER` 策略 | `peercred::tests` |
| F-AI-011 | TCP 通道被同主机其他进程访问 | 与 F-AI-010 同形,但跨网络 | 5 | 2 | 4 | 40 | `tcp_auth.rs` token 校验 + 强制环回 | `tcp_token_e2e.rs` |
| F-AI-012 | 资源门告警未送达 | 操作员不知告警 | 3 | 2 | 3 | 18 | `Alerts` 字段上 wire,UI 渲染 | `alerts::tests` |
| F-AI-013 | 速率限制被旁路 | 资源耗尽攻击 | 3 | 3 | 2 | 18 | `validate_probe` 仍走安全层;`Rejected` 写审计 | `security::tests` |

### 2.2 窗口管理 (amos-tauri/wm)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|-----|-----------|----------|
| F-WM-014 | Phone 形态打开多个 app 窗口 | 布局混乱,与手机语义不符 | 3 | 1 | 2 | 6 | `multi_window=false` 在窗口创建时强制拒绝 | `phone_form_factor_refuses_second_app_window` |
| F-WM-015 | 分屏窗格尺寸低于可用值 | 用户无法点击或看清内容 | 3 | 1 | 2 | 6 | `enforce_min` 在应用布局时自动提升 | `enforce_min_is_applied_to_split_panes` |
| F-WM-016 | Tablet 窗口意外可缩放 | 触摸设备无缩放交互,行为意外 | 2 | 1 | 2 | 4 | `.resizable(policy.free_resize)` 强制应用 | （隐式：Tauri 原生行为）|
| F-WM-017 | 屏幕变小后 app 窗口挂在屏幕外 | 用户在屏幕上**看不到也点不到**自己的窗口 | 3 | 1 | 2 | 6 | 每次真实屏幕变化后 `WmState::reclamp_windows()` 读平台真实几何(无宿主账本可漂移)、按 `LayoutPolicy::fit_window` 回夹,**只动需要动的窗口**;跳过 Launcher / 外部表面 / 隐藏窗口,读不出的几何计数 + `warn!` 不猜位置 | `reclamp_target_moves_only_windows_that_need_it`、`only_a_believable_reading_becomes_a_window_position` |
| F-WM-018 | 被拒的 app 窗口在状态机里**留痕**(模型有窗口、屏幕上没有) | 布局/焦点/z 序被幽灵窗口污染(REQ-A227 形状) | 3 | 1 | 3 | 9 | 判定**在注册之前**问:`WmState::check_new_app_window()`(生产 `open()` 与测试缝 `register_app()` 共用),拒绝是数据(`AppWindowRefusal`)而非字符串 | `a_refused_app_window_leaves_no_trace_in_the_model`、`a_class_without_multi_window_refuses_the_second_app_window` |
| F-WM-019 | **桌面专属 API 未做 cfg 门 ⇒ 整个 Android APK 构建中断，而所有门都绿**（实测 2026-09-16）：给桌面窗口设 `title_bar_style(Overlay)`（REQ-A249 §4.3）的那一行被一个**运行期** `if policy.form == FormFactor::Desktop` 包着 —— 运行期守卫**不能让方法在编译期存在**：`title_bar_style` 在 Android/iOS 的 Tauri 上**根本没有** ⇒ 交叉编译 `aarch64-linux-android` 时 `E0599: no method named title_bar_style found for WebviewWindowBuilder`（`wm.rs:902`），`cargo tauri android build` 在 Rust 阶段即失败 | `make android-app` **整条命令死掉** ⇒ **产不出 APK** ⇒ 装不上、真机验收（本轮正卡在这里）全部堵死 ✗；而在宿主侧它完全**隐形**：`cargo check` ✓、全部测试 ✓、`a11y`/`i18n`/`hover` 门 ✓ 全绿 ⇒ 缺陷只对**移动目标**可见 | 3 | 3 | 4 | 36 | ①**按本仓既有范式修**：`wm.rs` 里 `window_maximize` 早就是成对的 `#[cfg(desktop)]`/`#[cfg(not(desktop))]` + 「cross-target no-op that still compiles」注释 ⇒ 同一范式把该行门进 `#[cfg(desktop)]`；`let mut builder` 只在桌面被重新赋值 ⇒ 加 `#[cfg_attr(not(desktop), allow(unused_mut))]`，两个目标都零警告；②**补上缺席的那道门**：`mobile-check` 只**报告**工具链（从不失败 ✗）、`pdf-android-check`/`vector-db-check` 只交叉编译它们自己的 crate ⇒ 此前**没有任何门编译 `amos-tauri` 的 Android 目标** ✗；新增 `android-app-check` = `cargo ndk -t arm64-v8a -P 31 check -p amos-tauri --features android`（NDK 的 `cc` shim 只有带 API 后缀的名字 `aarch64-linux-android31-clang` ⇒ 环境必须由 cargo-ndk 提供 ⇒ 与 `android-audio-check` 同工具）并**并入 `verify`** | 门本身即保护：`make android-app-check` ⇒ **OK** ✓（`--features android` 走真实移动配置）；**修复判据 = 修复前同一行的实测**：修复前 `make android-app` 报 `E0599 @ wm.rs:902` ✓，修复后 `cargo tauri android build` ⇒ `Compiling amos-tauri` → **`Finished`（33.46s）** 且 `libamos_tauri_lib.so` symlink 进 `jniLibs/arm64-v8a` ✓ ⇒ **APKBUILD=OK** ✓（672MB 未 strip 调试包）；回归证据 = 宿主 `cargo check -p amos-tauri` ⇒ **Finished（4.76s）** ✓ ⇒ cfg 门没有破坏桌面路径 ✓ |


### 2.2c 桌面壳 chrome (前端)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|-----|-----------|----------|
| F-SH-001 | **不可用的 chrome 控件假装可用**(有可读名字、能 Tab 聚焦、点下去什么都不做) | 用户点了没反应、无从判断是坏了还是没做(REQ-A261 实测:顶栏「控制中心」;REQ-A262 又抓到三处:主菜单五个标题、Dock 废纸篓、桌面右键「新建文件夹」) | 2 | 3 | 4 | 24 | 可用性=**真行为**:未接入的控件 `disabled` + `aria-disabled` + 说明性名字(i18n),而不是留一个按钮;菜单里做不到的**行**渲染成 macOS 的灰项(不是把行删掉——删掉会藏起真实缺口);模块契约让"接入"变成单文件改动(`modules/ControlCenterButton.svelte` / `DockTrashItem.svelte`);Apple 菜单则相反——**能做的真做**(系统设置… / 锁定屏幕),做不到的才灰 | `chrome-widgets.svelte.test.ts`(控制中心 / 主菜单五条 / Apple 菜单灰项)+ `dock-widgets.svelte.test.ts`(废纸篓 disabled + 名字带原因)+ `desktop-shell.svelte.test.ts`(Dock 废纸篓 + 桌面右键「新建文件夹」灰项、同级「更改壁纸…」可点) |
| F-SH-002 | 挂件写回容器模板里 ⇒ **无边界、无法独立交付**(顺序/存在性住在模板而非数据) | 每加一个指示器都要改顶栏;挂件的测试被迫挂载整条栏;两个人无法同时改两个挂件 | 2 | 4 | 3 | 24 | 容器 ↔ 挂件:注册表 `svelte/shellModules.ts` 是数据,容器只按 `modulesFor(slot)` 渲染;**五个槽位各有容器**(顶栏左右 / stage / dock / overlay,REQ-A262 补齐后四个空槽位才有挂件);把手 `ShellChromeApi` 由**壳**注入一次(不是每个容器各注入一份);外观收进 `lib/shellChrome.ts` 一处(顶栏 / dock 瓦片 / 菜单面板 / 运行点) | `shellModule.test.ts`(槽位/顺序/不变量/i18n 键/**每个槽位非空**)+ `chrome-widgets.svelte.test.ts` + `dock-widgets.svelte.test.ts`(**每个挂件单独挂载**,含 dock 瓦片)+ `topbar-container.svelte.test.ts`(容器自身 markup 只有两个槽位)+ `unwired-scan`(每个模块必须被注册表引用) |
| F-SH-003 | **快捷键写在注释/文档里,代码里没有绑定**——"声称的能力"与"真的能力"不一致(REQ-A262 实测:`lib/shellChrome.ts` 写着"⌘Space/F4 are bound",F4 从未绑定) | 文档/注释成了不可验证的承诺;下一个人据此判断"已经支持",缺口被永久掩盖(与 F-IME-003 同形) | 2 | 3 | 4 | 24 | 绑定=**数据**:浮层注册表的 `shortcuts` 一处声明,键处理器用 `moduleForShortcut("overlay", …)` 查它、挂件的 tooltip/`aria-keyshortcuts` 用 `overlayShortcutHint()` 读**同一行**;`formatShortcut()` 从同一份字段生成标签,不可能与匹配器不一致 | `shellModule.test.ts`(绑定唯一 + 匹配集合就是 `F3/F4/Meta+Space/Meta+Tab` + 严格修饰键 + 标签来自同一行)+ `desktop-shell.svelte.test.ts`(F4/F3 真的开合 + 顶栏与 Dock 的 tooltip 显示 F4) |
| F-SH-004 | **跨组件的事件通道存在、目的端处理器是空的**(看起来"接好了",其实什么都不做) | 死接线冒充集成:舞台派发 `desktop:placeholder`,壳收到后 `return;`——用户点了「新建文件夹」既没反应、也没有任何"未接入"的提示 | 2 | 2 | 4 | 16 | 意图走**壳注入的把手**(`SHELL_CHROME_API`):舞台的「打开启动台」调 `openLaunchpad()`,浮层由壳按注册表渲染;两条 `desktop:*` window 事件已删除,做不到的动作变成灰项 + 原因(与 F-SH-001 同一条规则) | `desktop-shell.svelte.test.ts`(「⌘Space / F4 打开浮层」「Esc 只关最上一层」「右键菜单:可点的可点、做不到的灰且有名」——若任一条 window 事件接线复活,这些用例会走不到那条路径)+ `chrome-widgets.svelte.test.ts`(单独挂载时没有把手 ⇒ 什么也不做,而不是抛错) |
| F-SH-005 | **同一套设备交互规则被抄进多个屏**:规则的真实内容(顺序、闸门、拒绝分支、失败后重读)只能从两个组件的实现里读出来,改一处就与另一处不一致 | 一个屏说"平台接管了,请去系统设置",另一个屏照旧去写一个**注定失败**的 `radio_set`;第三个屏(桌面控制中心)会变成第三份 | 3 | 3 | 3 | 27 | 规则收进 `lib/quickRadio.ts`:**一处**实现(`tapRadio`/`syncQuickRadios`/`readManagedSwitches`/`openRadioSettings`),命令是**端口**(`RadioCommands` + `HOST_RADIO_COMMANDS`),返回值写明"设备答了什么"(`RadioTapOutcome` + `persist`:只有设备确认过的写才落 store);三个屏(桌面控制中心 / 通知中心 / 设置)只保留各自的措辞与状态 | `quickRadio.test.ts`(**17** 例,用假端口覆盖 offline/gated/managed/applied/refused/unread 每条分支,含"平台接管的开关从未被尝试写")+ 三个屏各自的 DOM 测试(通知中心 14 / 设置 15 / 控制中心 9) |
| F-SH-006 | **开关型控件只做了一半**:能打开、不能关(再点一次没反应),或面板开着而控件不说自己在开着的状态 | 用户以为坏了:打开面板后再点那个图标,面板不消失;读屏软件也听不出它是开着的 | 2 | 3 | 3 | 18 | 把手给出**成对**的能力:`toggleOverlay(id)`(macOS 的菜单栏项就是这样:同一个点击开/关)与 `isOverlayOpen(id)`(只读,给 `aria-expanded`);`ChromeIconButton` 多一个 `expanded` prop,`undefined` ⇒ 不是展开控件、不渲染该属性 | `desktop-shell.svelte.test.ts`(「⚙️ 点开、再点关,`aria-expanded` 与之一致」)+ `chrome-widgets.svelte.test.ts`(无壳时 `aria-expanded=false`,点了不抛错)+ `control-center.svelte.test.ts`(面板内的关闭路径) |
| F-SH-007 | **浮层层序由组件的 class 决定,而不是用户打开的顺序**:每个浮层自带写死的 `z-index`,于是"后打开的在上"只在恰好对上那对组合时成立 | 用户在控制中心之上按 ⌘Space,聚光灯却可能压在下面;层级看起来随机,因为决定它的是模板里的数字 | 2 | 2 | 3 | 12 | 壳按**打开顺序**给层:`{#each openOverlays as id, index}` 外面包一层 `pointer-events-none` 的 `absolute inset-0`,其 `z-index = 100 + index`(指针事件仍由各浮层自己决定,层序与命中区互不干扰) | `desktop-shell.svelte.test.ts`(「overlays stack in the order they were OPENED」:层数组与 `z-index` 单调递增,换一个打开顺序仍然成立) |
| F-SH-008 | **系统快捷键把焦点窗口关掉 —— 漏到 "main" 上 ⇒ 整个桌面壳消失** | 用户按 ⌘W 想关掉当前 app,**整个 Launcher 关闭**,桌面一片黑;若 `focusedWindowLabel` 实现错位(如把 `state` 读成 `focused`),`wm_close` 收到 `undefined`,宿主按 `String::new` 处理 ⇒ 行为不可预期 | 3 | 2 | 3 | 18 | `DesktopShell` 的 `handleSystemShortcut` **先于**浮层快捷键:⌘W→`wm_close(label)`、`label !== "main"` 且**无焦点时是 no-op**;`focusedWindowLabel` 由 `wm_windows` 的 `focused: true` 字段读出(不是 `state: "Focused"` —— 后者只是分类),与 Dock 的运行点白点**共用同一组 5 s 定时器**;严格修饰键(`meta` 必须按下、未列出的修饰键必须缺席)防止 `w` 被当成 `⌘W` | `desktop-shell.svelte.test.ts`(「system shortcuts route through the focused window to `wm_close` / `wm_hide`」带 `label: "files"` + 「no focused window ⇒ no command reaches the host」+ 「plain ⌘+key does not fire」,**负控**:把 `focused` 读成 `state` ⇒ 用例 FAILED) |
| F-SH-009 | **Dock 右键菜单在组件已卸载后访问 `$props.label`**——DockContextMenu 调 `await invoke("wm_close", { label })` 之前先 `onclose?.()`,父级的 `{#if ctxMenu}` 立即卸载本组件;Svelte 5 中**已卸载组件的 `$props` getter 读取会抛 `Cannot read properties of null (reading 'label')`**,栈精确指向 `Dock.svelte:304:19` 那个 `get label [as label]` | Dock 右键菜单的 Quit/Hide/Show **全抛 TypeError**,菜单看起来"按了没反应";生产环境会污染控制台/诊断 ledger | 3 | 2 | 3 | 18 | DockContextMenu 的每个动作函数**先把 `label` 读到局部 `targetLabel` 再调 `onclose?.()`**(闭包捕获,不是"复制字符串"——写在文件头注释的 *Prop-read ordering* 段);这是 Svelte 5 `{#if}` + `$props()` + 异步动作的**必踩**坑,也是本轮修法第一版自己又踩一次的洞 | `desktop-shell.svelte.test.ts`(「right-click an app tile opens a dock context menu, and Quit calls `wm_close`」,**负控**:不先读 `label` 到局部 ⇒ 用例抛 `TypeError: Cannot read properties of null (reading 'label')`,栈指向 `Dock.svelte:304:19` —— **这是修复前真会抛的栈**,不是"我以为会") |
| F-SH-010 | **多选 Shift-click 直接 `replace` selection 而非 `union`** —— 一段实现里写 `selectedIds = new Set(unionRange(anchor, target))`,把"之前已经点过的、不在 anchor..target 范围内的 icon"**静默丢弃**;典型场景:Cmd-click A 选中 A,Cmd-click C 再选中 C(set = {A, C}),Shift-click E,期望 {A, B, C, D, E}(union),**实际**只剩 {B, C, D, E}(A 丢了)——用户"明明选过 A"的图标突然反白,无法判断"被某个看不见的规则清掉了",只能从头点一遍 | 用户在桌面多选上的预期=macOS Finder 的 union 语义;实现走 replace ⇒ 选区被静默吃掉且**没有任何提示**(选区计数 chip 同步变少,看起来"是 shift-click 本来就这么多") | 3 | 3 | 4 | 36 | `onIconClick` 的 Shift-click 分支改成 `selectedIds = new Set([...selectedIds, ...unionRange(anchorId, id)])` —— 范围作为增量**并入**已有选区,而不是替换;同时 Cmd-click toggle-off (`wasSelected`) 不动 `anchorId`(macOS:anchor 留在上一次真正的 add 上,而不是被 remove 的 id 上),只更新 `focusedId` —— 这两条规则共同保证"Cmd-click + Shift-click"的手势链不丢选 | `desktop-shell.svelte.test.ts`(「Cmd-click toggles one icon in/out; Shift-click unions a range (F-SH-010)」,**负控**:把 union 改回 replace ⇒ 用例 FAILED `clock should be selected after Shift-click: expected false to be true` —— **是修复前真会失败的断言**,不是"我以为会";把 toggle-off 改回 `anchorId = id` ⇒ 用例 FAILED `expected false to be true`) |
| F-SH-011 | **顶栏 Edit → Select All 与键盘 ⌘A 是两条平行的"全选"路径** —— 一处更新选区模型、一处忘改;典型场景:键盘 ⌘A 改成"全选 + 置 anchor 于最后一格",顶栏菜单的 `edit.select-all` 还**只派发**合成 keydown 事件,这条事件也许走不到 `onWindowKeyDown`(浏览器差异、合成事件不被冒泡到 window 等);用户从菜单点"Select All"图标**一个都没选中**,看起来"菜单是个装饰" | 用户在顶栏与键盘之间选择操作路径,期望**两者等价**;实际只能从一条路径选中,另一条路径"按了没反应" | 2 | 2 | 3 | 12 | 顶栏 `edit.select-all` 派发 `new KeyboardEvent("keydown", { key: "a", metaKey: true })` 到 `window`,由 `DesktopStage.onWindowKeyDown` **同一份代码**消费 —— 不是再写一份"全选图标"的循环;happy-dom 下 `window.dispatchEvent` 确实会让 window 上的 keydown listener 收到(已 probe 验证),且 `meta` 修饰键被 `onWindowKeyDown` 的严格检查通过;这是"两个 UI 入口 → 一个真源"的标准模式 | `desktop-shell.svelte.test.ts`(「topbar Edit → Select All marks every visible desktop icon as selected (F-SH-010)」,**负控**:把 `edit.select-all` 的 `run` 改成 `return`(no-op) ⇒ 用例 FAILED `Edit → Select All must select every icon, not just focus the grid: expected null to be truthy`,断言 chip 出现 + 4 个 icon 全部 `aria-selected="true"`) |
| F-SH-012 | **共享工作树里**未提交**的工作被并发会话整体回退（过程失效，本轮实测到）**：多个会话同时在同一工作树里干活，`git checkout` / `reset --hard` / `stash` 这类**树级**动作会把别人**未提交**的改动一并抹掉。本次实测：一个会话的整套改动（`Shell.svelte` 的键盘准入 + `inert` 绑定、`svelte-tests/shell.svelte.test.ts` 的用例、`lib/time.ts` 的 DST 修复、前端 `package.json` 的扫描器接线、以及 **TRACEABILITY / FMEA / CHANGELOG / §8** 的登记）在几个提交之后**全部消失** ✓ | 后果里最危险的一条是**它不会出声** ✗：树照旧能编译、老行为照旧、`git status` 甚至显示**干净**（文件被 checkout 回旧版本 ⇒ "未修改" ✓）⇒ 你以为工作还在。第二个后果是**幸存物变成孤儿** ✗：新建的文件（untracked）**活下来**，但它们依赖的改动没了 ⇒ 例如 `systemKeys.ts` 在、而 `Shell.svelte` 不再 import 它 ⇒ 扫描器把它们报成"**newly unwired exports**" ✗，读起来像代码缺陷，其实是**工作被回退**的症状 ✓ | 4 | 2 | 4 | 32 | ①**每轮结束就提交**（工作树不是账本；本次是在发现损失后才第一次提交幸存文件 ✓）；②**永不**在共享工作树里跑树级 `git checkout/reset/stash`（要回退就只对自己的路径 `git checkout -- <paths>` ✓）；③**用内容校准判断**，不要信 `git status`（本次用 `grep -c 'shellKeyIntent\\|ShortcutHud' Shell.svelte` = 0 与 `git log -1 -- <file>` 才确认 ✓）；④发现回退后**先把幸存的新文件提交/接线**，再谈重做（本次把 `testreach:*` 与 `hover/lifetime/reactfree` 的 `check` 接线补回 ✓，而**不**去重写整个会话 ✗）；⑤FMEA/追踪登记**越早提交越好**（登记被回退 = 下一次审计会重复同样的结论 ✗） | `crates/amos-tauri/frontend-ts/src/lib/desktopKeys.ts`、`crates/amos-tauri/frontend-ts/scripts/orphan-test-scan.mjs`（幸存物，本轮补接线后提交）、`crates/amos-tauri/frontend-ts/package.json`（`testreach:*` 与 `check` 链修复）。**验证**：`git log --oneline -1 -- crates/amos-tauri/frontend-ts/src/svelte/Shell.svelte` ⇒ 停在 **REQ-A290**（远早于本会话 ✓）；`grep -c 'shellKeyIntent\\|ShortcutHud\\|overlayOpen' Shell.svelte` ⇒ **0** ✓；`grep -c addLocalDays lib/time.ts` ⇒ **0** ✗（DST 修复同样丢失 ✓）；`grep -c testreach package.json` ⇒ 修复前 **0** / 修复后 **3** ✓；`node scripts/fmea-gen.mjs --check` ⇒ 修复前 **77** 条（回退到 F-SH-011 时期 ✓）、本次登记后 **78** ✓ |
| F-SH-013 | **壳从不 push 历史条目 ⇒ 平台的返回手势**退出整个应用**（REQ-A347 重接）**：宿主把返回实现成 `if (webView.canGoBack()) goBack() else exit()`（Tauri 生成的 `WryActivity`），而全库 `popstate`/`pushState` 计数为 **0** ⇒ `canGoBack()` **永远为假** ⇒ 在应用里、App Library、编辑模式、或任何浮层打开时按返回，**直接离开 AmOS** ✗ | 用户正在读一条消息，按一下返回把**整个系统界面**关掉 —— 不是"回上一屏"而是"离开 AmOS"；在**主屏**按返回本该退出、也确实退出 ⇒ 行为在根部"看起来是对的"，问题因此隐蔽 | 3 | 3 | 3 | 27 | ①**一层级一条历史条目**（`lib/backNav` 的 `levelOf`/`pushDecision`）：跨两级（主屏 → 带浮层的应用）必须 push **两条**，否则一次返回退两级；②**两个方向都幂等**（不用抑制标志）：壳自己回主屏时顺手 `history.go(-n)` 收回多余额度，随之而来的 `popstate` 发现深度已一致 ⇒ 天然不重复动作；③**根上什么都不做**（平台的"在根退出应用"是正解，壳不吞）；④**桌面形态刻意排除**（真窗口有自己的关闭语义）；⑤深链启动也算一层（否则"没打开过却无处可回" ✗） | `svelte-tests/shell.svelte.test.ts`（**+3**：应用=1 条且 `{amosDepth:1}` ✓、其上浮层=第 2 条 ✓、壳自回退 ⇒ `history.go(-1)` ✓、桌面 ⇒ **0 条** ✓）。**负控：关掉 push 分支（`if (false)`）⇒ 恰好 1 红**，报错正是 `opening an app pushed exactly one entry: expected [] to have a length of 1` ✓，md5 还原 ✓ |
| F-SH-014 | **菜单的键帽来自一个**从未定义**的 i18n 键 ⇒ 屏幕上印出键名本身（REQ-A348 收口）**：`TopbarMainMenu` 用 `t(row.shortcutKey)` **动态**取值，而 `desktop.menu.file.closeWindowShortcut` 等 5 个键在 zh/en **都不存在**；`translate()` 的兜底是 `raw ?? key` ⇒ 菜单右侧显示 `desktop.menu.file.closeWindowShortcut` ✗。同一族的第二处：**17 个行标签键**（`desktop.menu.file.closeWindow` 等）也从未定义 ⇒ 整个菜单栏显示键名 | 用户打开"文件"菜单看到的是 `desktop.menu.file.newWindow` 之类的**内部键名** ✗ —— 不是"少了一条快捷键提示"，而是**菜单不可读**；而 `i18n-scan` 全绿 ✓（它的边界明写"运行期表达式不评估"✗），所以没有任何门会红 | 2 | 4 | 3 | 24 | ①**键帽不翻译、且从绑定表派生**：`desktopShortcutLabel(kind)`（`lib/desktopKeys.ts`）渲染 `⌘W`/`⌘M`，平台键（⌘C/⌘V/⌘A）只在一处写成字面量并注明理由；②**没人绑定的行不声称有键**（⌘N 未接线 ⇒ 该行**无**键帽）；③**补齐 17 个标签键**（zh+en 同步，文案取 macOS 惯例）；④**字典"集合"一致性进测试**（`__tests__/i18n.test.ts` 的双字典键比对 ✓ —— 正是它抓到了 12 个只在 zh 的 `ringtone.*` ✗） | `svelte-tests/topbar-main-menu.svelte.test.ts`（**5 例**：键帽=字面 `⌘W`/`⌘M`、不泄漏 `desktop.menu`、⌘N 行无键帽、平台键 ⌘C/⌘V/⌘A、宿主 `menu-event` 有消费者）。**负控**：让 `desktopShortcutLabel` 返回 `""` ⇒ 恰好 1 红（`expected '关闭窗口' to contain '⌘W'`）✓；首版用例曾**两边调同一函数**（"测试在测自己" ✗）⇒ 改为字面期望后才有判别力 ✓ |
| F-SH-015 | **测试文件存在，却**没有任何 runner 会执行它**（孤岛测试，REQ-A349 成门）**：`bun`（`bun-iso-test.mjs`）只扫 `src/__tests__` 与 `src/lib/__tests__`，`vitest` 只含 `svelte-tests/` ⇒ 第三类目录（如 `src/svelte/…/__tests__/`）的文件**静静地永远不跑** ✗。实测：并发会话新建的 `src/svelte/settings/__tests__/KeyboardPage.test.ts` 正是如此，且**根本跑不起来**（DOM 测试写在 bun 的扫描根之外，手动跑即 `ReferenceError: Can't find variable: document`）✗ | 一整份"看起来有测试"的文件**从未执行**，而所有门都绿 ⇒ 它保护的代码**没有任何证据**；更隐蔽的是它会**腐烂**（接口改了没人发现）。本仓在这条路上已交过学费：`bun-iso-test.mjs` 的注释专门解释为何把 `src/lib/__tests__` 纳入扫描（"otherwise those files would silently never run"）⇒ **知道这个失败模式，却没有门守着** ✗ | 2 | 3 | 4 | 24 | ①**新增门** `scripts/orphan-test-scan.mjs`：收集前端全部 `*.{test,spec}.*`，判路径是否落在某个 runner 的根内，否则 **FAIL 并给出怎么改**（DOM 测试 → `svelte-tests/`；纯测试 → `src/__tests__/` 或 `src/lib/__tests__/`）；②**例外必须写进 `scripts/test-reach-allowlist.json` 并带理由**，且**陈旧条目会失败**（文件已可达或已不存在 ⇒ 必须删掉）⇒ 豁免不会腐烂；③**同一个"文件需要自己的运行环境"家族**：`// bun-iso-tz: <zone>` 标记让带时区的文件**独立进程 + 指定时区**运行（`bun-iso-test.mjs` 已认得 ✓），且每个这样的文件**自带"时区真的是它"的断言** ⇒ 不会变成空洞测试 | `scripts/orphan-test-scan.mjs`（**自检 9 例** ✓ + `--json`）、`scripts/test-reach-allowlist.json`、`crates/amos-tauri/frontend-ts/package.json`（`testreach:selftest`/`testreach:scan` 并入 `check` 链 ✓）。**实证**：建门时它 **FAIL 点名那一个文件** ✓；并发会话随后把文件搬进 `svelte-tests/` ⇒ 门立刻报"**豁免已不再需要**"（防腐烂设计**在真实场景当场应验** ✓）；`--selftest` 打断 `runnerFor` ⇒ 1 条失败并指出用例 ✓ |
| F-SH-016 | **一个"有测试、却没有生产者"的服务 ⇒ 功能对用户**根本不存在**，而所有门都绿（REQ-A350 收口）**：`lib/mediaExport.ts`（写共享集合的整个"写入半")有 **6 个导出、15 条测试全绿** ✓，而全库 `src/svelte/*.svelte` **没有一处**引用它 ✗ ⇒ 录音只活在 `VoiceMemosApp` 自己的内部 store 里 ⇒ Files、图库、以及**任何其它应用**都看不到它 ✗ —— 而 REQ-A313 明写"录音必须是**用户找得到的文件**" ✓ ⇒ 能力**在代码里存在、在设备上不存在** ✗ | 用户录了一段音，去 Files / 录音目录找，**什么也没有** ✗；换一台应用（或重启后换一条路径 ✗）同样找不到 ⇒ 与"根本没做这个功能"对用户完全等价 ✓。而工程侧**看不出问题**：单测全绿 ✓、`tsc` 全绿 ✓、`i18n`/`a11y`/`hover`/`lifetime` 全绿 ✓ ⇒ 只有 `unwired-scan` 的"新未接线导出"能把这种**孤儿服务**数出来 ✓（它当时报了 `mediaExport` 的 6 个导出 ✓） | 2 | 3 | 4 | 24 | ①**接线**：录音行加"保存到「录音」目录"动作 ✓ —— `blobBytes`（录音 blob）/ `buildWavBytes`（种子片段的合成音频 ⇒ **保存的就是听到的**）→ `exportNameFor(createdAt, mime)` → `exportToSharedCollection("audio", name, bytes, RECORDING_EXPORT_DIR)` ✓；②**结果如实渲染**（saved / refused / offline / empty，宿主给出新词就原样显示 ✓）并挂 `aria-live` ✓ —— **绝不静默无动作** ✓；③**我第一次的接线有一个真 bug，靠"读服务签名"抓住** ✗：`exportToSharedCollection(kind, name, bytes, dir = CAMERA_EXPORT_DIR)` 的第 4 个参数被我漏掉 ⇒ 录音会被写进 **DCIM/Camera** ✗（一个"用户找不到它"的位置 ✗）⇒ 传 `RECORDING_EXPORT_DIR` ✓ 并把教训写进注释 ✓；④**把门的判据留在原地**：`unwired-scan`（`scripts/unwired-baseline.json`）就是这条纪律的执行者 ✓ —— 新导出要么接线、要么删除、要么带理由进基线 ✓ | `svelte-tests/vmemos.svelte.test.ts`（**+2**：宿主调用序列 = `media_grant_write` → `media_save` ✓、载荷是**字节数组** ✓、**集合是 `recordings` 而非默认的相机胶卷** ✓、文件名形如 `Amos-YYYYMMDD-HHMMSS.wav` ✓、结果文本可见 ✓；拒绝 ⇒ 显示"宿主拒绝了写入"且**不**含"已保存" ✓）。**负控：把导出改成空操作 ⇒ 恰好 2 红** ✓，报错正是"那一行**什么都不显示**" ✓（= 该功能要杜绝的静默无动作 ✓），还原后 7/7 ✓。**等待改为轮询而非固定睡眠** ✓（本仓 `focusTrap` 的既有防抖纪律 ✓）。**另**：首版测试断言**硬编码文案** ✗ ⇒ 并发会话改写文案后误红 ⇒ 改为断言**字典值** `zh[...]`（本仓既有写法 ✓）⇒ 文案再改也不会误红 ✓ |


| F-SH-017 | **动作声称了一个从未发生的效果（"分享"只复制文本，且剪贴板失败时照样声称成功），而一整屏已写好的导出 UX 没有任何生产者**（REQ-A352 收口）：①`PhotosApp` 的 `shareSel`/`shareVideo` 把一段**字幕文本**写进剪贴板 ✓，然后**无条件** `wallMsg = t("photo.shared")`（= "已复制分享文本" ✗）—— 异常被 `catch {}` 吞掉 ⇒ **WebView 无安全上下文时剪贴板本就不存在**，用户仍然看到"已复制" ✗；**照片/视频的字节从未离开应用** ✗。②同一屏幕里，`camera.exportToSystem` / `exporting` / `exported` / `exportOffline` / `exportRefused` / `exportFailed` **六个键在 zh 与 en 都已写好**（按钮名、"正在写入…"、"已写入系统存储（DCIM/Camera）✅"、拒绝、无字节…✗）而全库 `grep camera\.export` **零生产者** ✗ ⇒ 整套 UX 无人可达 | 用户点了"分享"看到"已复制分享文本" ⇒ **以为已经分享出去** ✓；点了"存到系统存储"根本不存在这个按钮 ⇒ **以为相册里有、其实没有** ✗。而工程侧全绿：单测 ✓、`tsc` ✓、`i18n` 键引用扫描 ✓（键在字典里就"存在"✓）、可达性扫描 ✓ ⇒ 只有"读代码找消费者"能发现 ✓ | 2 | 4 | 3 | 24 | ①**声明跟随效果**：抽出 `copyText()`，只有 `await writeText` **真的 resolve** 才 `photo.shared` ✓，否则 `photo.shareFailed`（新增键，zh+en 同步 ✓）；视频那半同样改为 `await`（原来连 `await` 都没有 ✗）；②**接上那六个键**：新增"存到系统存储"按钮（静态图查看器 + 视频浮层各一处 ✓）⇒ `dataUrlToBytes`/`blobBytes` → `exportNameFor(ts, dataUrlMime(...))`（扩展名取自 data URL **自己的**媒体类型 ⇒ PNG 不会被存成 `.jpg` ✓）→ `exportToSharedCollection("image"|"video", name, bytes, CAMERA_EXPORT_DIR)` ✓；③**没有字节就绝不发**：演示/渐变瓦片没有 `data` ⇒ 本地直接说 `camera.exportFailed` **且完全不碰宿主写路径** ✓（在相册里写一个空文件 = 声称有一张并不存在的照片 ✗）；④`expBusy` 期间禁用按钮 ⇒ 一次动作只有一次写入/一行结果 ✓ | `svelte-tests/photos.svelte.test.ts`（**+5**：真字节进 `DCIM/Camera`、name=`Amos-20260916-180507.png`、kind=`image` ✓；拒绝 ⇒ 显示拒绝且**从不**显示"已写入" ✓；无 `data` 的瓦片 ⇒ `camera.exportFailed` 且 `media_save`/`media_grant_write` **调用数为 0** ✓；剪贴板不可用 ⇒ `photo.shareFailed` 且**不含**"已复制" ✓；剪贴板可用 ⇒ 仍显示"已复制"且 `writeText` 真被调用 1 次 ✓）。`src/__tests__/mediaExport.test.ts` **+2**（`dataUrlMime`：大小写/参数归一化 ✓；`data:;base64`、`data:base64`、`blob:`、空串 ⇒ **null 而非猜一个图片类型** ✓）。套件：photos **17 → 22/22** ✓ |
| F-SH-018 | **豁免名单（allow-list）自己没有防腐门 ⇒ 它保护的是早就不存在的文案，并且会吞掉下一个真正的死键**（REQ-A353 成门）：`scripts/i18n-allowlist.json` 用"键 + 理由"豁免那些**代码到不了**的文案 ✓，而 `i18n-scan` 只把它**打印出来**、**从不检查它是否还成立** ✗ ⇒ 键被删掉之后条目仍在 ✓（`files.preview`/`files.previewOpen`/`files.previewClose`/`files.previewFailed`/`media.showingNewest` 就是这么过期的 ✓：HEAD 里 1/1 存在 ✓，工作区已被删成 0/0 ✗，而条目照样"保护"它们 ✓）。**更贵的一面**：只要键进了名单就**跳过死键检查** ✗ ⇒ 一条陈旧的豁免等于给**下一个真正不可达的文案**发通行证 ✓（那正是 F-SH-017 那六个 `camera.export*` 的同类 ✓：它们当时**不在**名单里 ✓，所以死键检查确实抓得到 ✓ —— 名单一旦被滥用就抓不到了 ✗） | 覆盖率**虚假** ✓：一个键"有豁免"读起来像"被审过、故意留着的" ✓，实际可能已不在任何字典里 ✓ ⇒ 审计报告会长期高估字典的干净程度 ✓；而 `fmea-gen`/`unwired-scan`/`orphan-test-scan` 都有"豁免陈旧即失败"的纪律 ✓，唯独 i18n 这一份没有 ✗（同一族门的不一致 ✓） | 2 | 3 | 4 | 24 | ①新增纯函数 `staleAllowList(allow, isReferenced, inDictionaries)` ✓ —— **两类**：`live`（生产已引用该键 ⇒ 豁免什么也没遮住 ✓）与 `absent`（**两个字典里都没有**该键 ⇒ 豁免什么也没保护 ✓，判据收紧过：只在单侧缺失属于**一致性检查**的管辖、且豁免仍在为那一侧工作 ✓）；②接入 `i18n-scan` 的**硬门** ✓（打印 FAIL ✓ + 进 `--json` ✓ + 进 `process.exit` 条件 ✓ + 首行汇总显示 `N STALE` ✓）；③**进自检** ✓（3 条断言：live 陈旧 ✓ / absent 陈旧 ✓ / **仍在履行理由的条目不得报** ✓）；④与 `orphan-test-scan`（豁免不再需要 ⇒ 失败 ✓）、`unwired-scan`（基线项已接线 ⇒ 提示收缩 ✓）保持同一纪律 ✓ | `i18n-scan.mjs --selftest` ⇒ **60 条断言 / 0 失败** ✓（含新增 3 条 ✓，即上下两支都真跑到 ✓）；**实况**：新门一上线立刻报 **5 条** ✓（`files.preview`×4 + `media.showingNewest` ✓，全部由查 `HEAD:` 与工作区的**存在性差异**归因到并发会话的在制删除 ✓，非本轮引入 ✓）；入口链无需改动 ✓ —— `check` 已包含 `i18n:selftest && i18n:scan` ✓ |
| F-SH-019 | **分页的契约有三处与真正的宿主不符，且恢复点在宿主顺序里**不良定义**（REQ-A354 实测更正）**：①`mediaPaging.ts` 的模块头写"**宿主对列表做上限并回传游标**" ✗、`canLoadMore` 的注释写"宿主已经用**它自己的 `total`** 说了还剩多少" ✗ —— 而**实测**宿主 `media_list(state, collection) -> Vec<MediaItem>`（`crates/amos-tauri/src/media.rs`）**既无游标参数、也无页大小、也无总数** ✗ ⇒ 照这些注释去实现 `fetch` 的人**必然写不出能用的东西** ✗。②更实质的是：宿主与 provider 的排序是 `items.sort_by_key(|i| std::cmp::Reverse(i.ts))`（`crates/amos-media/src/hostfs.rs:126`、`provider.rs:278` ✓）—— **只有 `ts` 降序、没有任何 tiebreaker** ✗ ⇒ 同 `ts` 组内顺序是目录扫描的产物 ✓ ⇒ "**取宿主那一页的最后一项**"当恢复点**不是良定义的** ✗：边界落在同 `ts` 组内时，按时间戳恢复会**丢掉该组剩下的项**（或重复）✗。③我还把"宿主文档顺序 `(ts desc, name asc)` ⇒ 正确游标是 `{ts,name}`"**写进了登记册** ✗ —— 那是**推断错误** ✓（宿主既没有 name tiebreaker，也没有游标概念 ✓）；正确命题是**前端必须自持全序** ✓ | 用户点"加载更多"后，**同一秒拍的一批照片里有几张永远不出现** ✗（或重复出现 ✓），而界面、日志、测试**全都正常** ✓ —— 只有数数才发现 ✓；它正是这个模块自己写在头上的那种"看起来能用、直到用户数照片"的失效 ✓。另：注释与实现不符会让**下一位实现者**照错文档写代码 ✗（这类"文档说宿主有、宿主其实没有"的偏差不触发任何门 ✗） | 3 | 3 | 3 | 27 | ①**把实测契约写进模块头** ✓（引用 `hostfs.rs`/`provider.rs` 的行号 ✓，并写明"没有游标、没有页大小、没有总数" ✓）；②**把恢复点表达在前端自己的全序里** ✓：新增 `afterCursor(it, cursor)` ✓ —— `(ts desc, id asc)`，与 `newestFirst` **同一个序** ✓（跨 `ts` 比 `ts` ✓、同 `ts` 比 `id` ✓、游标自身**排除**在外 ✓）；③新增 `pageOf(all, cursor, limit)` ✓ —— 这就是屏幕要交给 `fetchInto` 的 `fetch` ✓（宿主不分页 ⇒ 切片是我们的 ✓：`findIndex(afterCursor)` 定位 ✓、`remaining` 由我们算 ✓、不在列表里的游标按**单调性**落在其后的第一项 ✓）；④**更正登记册里的错误判断** ✓（两处历史行在原句处加注 ✓，不改写历史 ✓）；⑤测试补上**最危险的那一格**：同 `ts` 组跨页 ✓ | `src/__tests__/mediaPaging.test.ts`（**+4**：同 `ts` 组跨页**不丢不重** ✓（`a,b` → `c,d` ✓）；逐页重组**逐字等于**原集合 ✓（无丢失、无重复 ✓）；列表外的游标落在其后的第一项 ✓（三种情形 ✓）；**负控**：只比 `ts` 的恢复谓词**确实会丢掉 `c`** ✓（`["d"]` ✓）而真谓词给出 `["c","d"]` ✓）。套件 **6 → 10/10** ✓；`tsc` 对我的文件 **0 错** ✓ |



| F-SH-020 | **导出的兜底路径在吞掉失败之后仍声称成功；而且那条消息是**硬编码中文**（英文用户看到中文）——`i18n-scan` 的硬编码检查只看 `.svelte` 的 **markup 段**，脚本段里的中文字面量是**门的盲区**（REQ-A355 收口，F-SH-017 同族）**：`NotesApp.svelte` 的 `doExportOne` 在"无后端"时回退到剪贴板 ✗，写法是 `try { await copySelection(text) } catch { /* clipboard unavailable */ }` 然后**无条件** `exportMsg = t("note.exportCopied")` ✗ —— 而 `copySelection`（`lib/clipboard.ts:98`）**本来就返回 boolean** ✓（`clipboardWrite(...) !== null` ✓）⇒ 返回值被丢掉 ✓；`doExportMd` 更直接：`exportMsg = "已复制 .md 到剪贴板（未连接后端）"` ✗ 是**字面量中文** ✓✓ | 用户在无宿主的 WebView 里点"导出" ⇒ 看到"**已复制到剪贴板（未连接后端）**" ✓ 而笔记**既没成文件、也没进剪贴板** ✗ ⇒ 与"数据全损"对用户等价 ✓（他关掉页面以后再也找不回来 ✓）；英文用户更糟 ✓：看到的是一句**中文** ✓（语言被无视 ✓）。工程侧为什么全绿：单测 ✓、`tsc` ✓、`i18n-scan` ✓ —— 因为该门**只扫 markup 段**（`markupOf()` ✓），**脚本段字面量不在其视野** ✗ | 3 | 3 | 4 | 36 | ①**声明跟随效果** ✓：新增 `copiedToClipboard(text)` ✓ —— `copySelection` 的 boolean **被使用** ✓，抛出的写也算失败 ✓；`doExportOne` 改为三态 ✓（真文件 ⇒ `note.exportedTo {name}` ✓；剪贴板真的落地 ⇒ `note.exportCopied` ✓；否则 ⇒ `note.exportCopyFailed` ✓ = "导出失败，且剪贴板不可用——**笔记仍在 AmOS 内，没有丢失**" ✓，先安抚且为真 ✓）；②`doExportMd` 同样改为按结果分支 ✓（成功才有 `note.exportMdCopied` ✓），并把 `"未命名"` 与 `已导入「…」` 两处**脚本段中文**一并键化 ✓（`note.untitled` ✓ / `note.imported {title}` ✓）；③4 个键 zh+en **同步** ✓；④**测试不再替缺陷背书** ✓：原有用例断言的就是那句**错误**文案 ✗ ⇒ 改为断言"**诚实失败**" ✓ 并补"剪贴板可用仍报已复制"的正例 ✓ | `svelte-tests/notes.svelte.test.ts`（**+1 并重写 2**：无剪贴板 ⇒ `note.exportCopyFailed` 且**不含** `note.exportCopied` ✓；剪贴板可用（假桥应答 `clipboard_write`）⇒ `note.exportCopied` 且**载荷真的到达**（`written[0].text` 含正文 ✓）；`.md` 路径同样断言"成功措辞只留给真的复制" ✓）。套件：notes + note-editor **47/47** ✓；`i18n-scan` 我新增的 4 键**无死键** ✓ |
| F-SH-021 | **相机应用拍下的东西永远到不了系统相册 —— 而且"看起来能看照片"的那个控件根本没有处理函数**（REQ-A356 收口）：`CameraApp` 把照片/视频只写进**自己的**私有 store（`lib/photos.ts` 的 `PHOTOS_KEY` ✓ / `lib/cameraCapture.ts` 的 MediaStore ✓）✗，于是系统图库、Files、任何其它应用都看不到 ✗；而 `camera.exportToSystem` / `exporting` / `exported` / `exportOffline` / `exportRefused` / `exportFailed` **六个键早在 zh 与 en 里写好** ✓（连"已写入系统存储（DCIM/Camera）✅"都有 ✓）却**零生产者** ✗ —— 是**先写好了 UX、再没人接线** ✓（F-SH-016 的同族 ✓）。**同屏第二个发现**：底部缩略图按钮 `aria-label={t("a11y.lastPhoto")}` **没有任何 `onclick`** ✗ ⇒ 用户点它期待"看刚拍的那张"（iOS 语义 ✓）而**什么都不发生** ✗ | 用户拍完照，去系统图库/Files 找 ⇒ **什么也没有** ✗；只有回到 AmOS 里、打开 Photos 才看得到 ⇒ 与"相机没做导出"对用户等价 ✓。而"点了没反应"的缩略图会让人以为**照片丢了** ✓（比没有这个控件更糟 ✓：它暗示有内容 ✓） | 3 | 3 | 4 | 36 | ①**接线**：新增 `exportToSystem()` ✓ —— 视频模式导出**最新的那段录像**（`captures` 里按 `ts` 取最大值 ✓，不依赖列表顺序 ✓）、否则导出缩略图那张**静默**；`dataUrlToBytes`/`dataUrlMime`（扩展名取自 data URL 自己的媒体类型 ✓）/`blobBytes` → `exportNameFor` → `exportToSharedCollection("image"\|"video", name, bytes, CAMERA_EXPORT_DIR)` ✓（`dir` 显式传 ✓）；**没有字节就不发** ✓（演示帧、或字节已丢的旧库项 ⇒ 本地直说 `camera.exportFailed` 且**不碰宿主写路径** ✓）；②**如实渲染** ✓：`hint` 那行加 `role="status"` ✓（原本只是个 `<p>` ✗ ⇒ 结果对读屏不可见 ✗），并按四种结果分支 ✓；③**只在有东西可导出时才给按钮** ✓（`last?.data \|\| (mode==="video" && captures.length>0)` ⇒ 没有捕获就没有控件 ✓，不给"按了什么都不做"的按钮 ✓）；④**未修的地方如实登记** ✓：缩略图仍**没有**处理函数 ✗（它应该是"打开刚拍的那张"✓，属于导航接线 ✓）—— 本轮只把它写进本行，不擅自改交互 | `svelte-tests/camera.svelte.test.ts`（**+3**：预置带 `data` 的照片（`last` 由 `latestPhoto(store)` 初始化 ✓ —— 而 happy-dom **没有 canvas** ⇒ 快门路径产出的是**无 `data`** 的照片 ✓、`last` 只在有像素时才设 ✓ ⇒ 靠驱动快门**测不到**这条路径 ✓，这一点写进用例注释 ✓）：真字节进 `DCIM/Camera`、`kind=image`、`name=Amos-20260916-180507.png` ✓；拒绝 ⇒ 显示拒绝且**从不**显示"已写入" ✓；**什么都没拍 ⇒ 控件不存在** ✓。套件 **13 → 16/16** ✓ |
| F-SH-022 | **门的盲区：i18n 的"硬编码文案"检查只读 `.svelte` 的 markup 段 ⇒ 脚本段里写下的用户可见文案**对每一道门都不可见**（REQ-A357 补门）**：`i18n-scan.mjs` 的 `hardcodedCopy()` 用 `markupOf()` 切出 `</script>` 之后的 HTML ✓ ⇒ `exportMsg = "已复制 .md 到剪贴板（未连接后端）"`（`NotesApp.svelte` ✗）这类**脚本段字面量不在其视野** ✗ ⇒ REQ-A355 修完才发现：**它是"出厂就带着中文"的那类缺陷，而所有门全绿** ✓（F-SH-020 因此能溜过去 ✓）。实测盲区规模 ✓：脚本段含 CJK 的字面量共 **1863** 处，其中 **1651 在 `zh.ts` 自己**（字典 ✓ 不算）；余 **212 处 / 24 文件**里**数据与文案混杂** ✓（`cityIndex.ts` 51 处城市名 ✓、`ClockApp` 的 `日一二三四五六` ✗、`FilesApp` 的 `"文档"` ✗…）⇒ **一律报红会变成 212 条的红墙** ✗（没人会读 ✓） | 后果就是 F-SH-020 的后果：**英文用户看到中文** ✓、且**没有任何门会红** ✓（`i18n-scan` ✓、`tsc` ✓、单测 ✓ 全绿 ✓）⇒ 这一类缺陷可以在"全绿"的树里长期存活 ✓；而**盲区的存在与否本身**是照不出自己的 ✗（没有门会报"我这里看不到"✓） | 3 | 3 | 4 | 36 | ①**把门补到另一半** ✓：新增纯函数 `assignedCJKCopy(src)` ✓ —— 判据**故意收窄**到真有判别力的形状："**CJK 字面量作为赋值右值或 `$state(...)`/`$derived(...)` 初值**" ✓（= 会被渲染的文案 ✓）；**数据表不算** ✓（`const CITIES = ["北京", …]` 的元素不是赋值 ✓ ⇒ 地名/种子/夹具是**数据** ✓，混进来只会把真发现埋掉 ✓）；注释跳过 ✓（注释不是文案 ✓）；②**实测收窄后的命中量 = 1** ✓（`MapsApp.svelte:34 let label = $state("北京")` ✓ ⇒ 一个带理由的豁免 ✓，**不产生红墙** ✓）；③**复用既有机制** ✓：`i18n-literal-allowlist.json`（键 = 字面量 + 必填理由 ✓）而不是新造一份基准 ✓；④**同一个"豁免不许腐烂"纪律** ✓：新增 `staleLiterals` ✓ —— 某条字面量豁免在当前源码里**再也找不到** ⇒ FAIL 并提示删除 ✓（与 REQ-A353 给键豁免加的 `staleAllowList` 同构 ✓）；⑤进 `--selftest` ✓（**5 条**断言：赋值 ✓、`$state()` 初值 ✓、数据表**不得**报 ✓、注释**不得**报 ✓、`t(...)` 调用**不得**报 ✓） | `i18n-scan.mjs --selftest` ⇒ **60 → 65 断言 / 0 失败** ✓（新增 5 条，**正反两支都真跑到** ✓）；实况 ✓：新门对当前树报 **1 处**（`北京` ✓）⇒ 加豁免后 **OK** ✓、`staleLiterals` **0** ✓、整份扫描 **exit=0** ✓；`--json` 增 `scriptCopy`/`staleLiterals` ✓；退出码纳入 ✓ |
| F-SH-023 | **一个"看起来像导航、其实没有处理函数"的控件 ⇒ 用户把它读成"我的照片没了"**（REQ-A358 收口，F-SH-021 里登记的那条 open item）：`CameraApp` 底部缩略图带 `aria-label={t("a11y.lastPhoto")}` ✓、**有 `disabled={!last}`** ✓、**显示着刚拍那张的缩略图** ✓ —— 却**没有任何 `onclick`/处理函数** ✗ ⇒ 点它**什么都不发生** ✗。而同屏另外两个控件（快门 ✓、翻转 ✓）都是真控件 ✓ ⇒ 用户逐一试过后只能得出"照片没存上"的结论 ✓ | 比**没有**这个控件更糟 ✓：它**暗示里面有内容** ✓（缩略图就是那张照片 ✓）却对点击毫无反应 ✓ ⇒ 用户以为照片丢了 ✓（iOS 语义里它该打开那张照片 ✓）。工程侧**没有门看得见它** ✗：`i18n-scan` 的"每个可交互元素有可读名" ✓ 只查**名字**（它有名字 ✓）、`a11y-scan` 同理 ✓ ⇒ **"控件有名字但没有行为"这一族没有任何门** ✗ | 3 | 3 | 4 | 36 | ①**按本仓既有范式接线** ✓：`appLinks.ts` 里早已有 `openNote` / `composeSmsTo` / `openSettingsSearch` / `dialNumber` ✓（"设好目标屏幕的 props channel ⇒ 再切 shell 表面" ✓），而 **photos 没有自己的深链** ✗ ⇒ 照抄范式补 `PhotosLink{photoId,nonce}` + `PHOTOS_CHANNEL` + `photosChannel()` + `openPhoto(photoId)` ✓；②**消费端与 Notes 同构** ✓：`PhotosApp` 在 `$effect` 里 `subscribe` ✓ ⇒ 找到该 id 就 `sel = target` ✓（打开查看器 ✓）、**消费后清空 channel** ✓（再回 Photos 不会重放 ✓）、**找不到就诚实忽略** ✓（网格照旧 ✓ **绝不凭空造一张** ✓）；③相机侧一行接线 ✓：`onclick={() => last && openPhoto(last.id)}` ✓（`disabled={!last}` 保留 ✓） | `svelte-tests/photos.svelte.test.ts`（**+2**：请求 `p1` 时查看器显示 **`1 / 2`** ✓ —— 即**被请求的那张**而不是最新的 `p2` ✓（若实现写错成"打开最新"，这里会是 `2 / 2` ✓）；**已在库里不存在的 id ⇒ 不打开查看器** ✓（断言无 `N / M` 计数 ✓））；`svelte-tests/camera.svelte.test.ts`（**+1**：点缩略图 ⇒ channel 收到 `{photoId:"p2"}` ✓ —— 断的是**请求真的发出** ✓，不依赖 shell ✓）。套件：photos **22 → 24/24** ✓、camera **16 → 17/17** ✓ |
| F-SH-024 | **"控件永远无法动作"这一族没有任何门**（REQ-A359 成门）：F-SH-023 那个缩略图（有 `aria-label` ✓、有 `disabled={!last}` ✓、显示着刚拍那张 ✓、**却没有处理函数** ✗）之所以能出厂，是因为 a11y 门只查**"有没有可读名字"** ✗、`i18n-scan` 同理 ✗ ⇒ **"有名字、无行为"看不见** ✓。判据必须是可辩护的 ✓：**没有事件处理函数、又没有别的出路（`href`/`type=submit`/`form=`/`{...rest}`）的 `<button>`** ✓，且**只排除静态** `disabled`/`aria-disabled="true"`（点了也拦下 ✓ ⇒ `DockContextMenu` 的灰项「选项 ›」是**诚实的占位** ✓）✗ —— **动态** `disabled={…}` **不排除** ✓（非禁用态仍可点 ⇒ 必须有处理函数 ✓，F-SH-023 正是这种 ✓）；`src/svelte/modules/` 下的**通用**组件不报 ✓（处理函数由调用方传入 ✓，实测 `ChromeIconButton`/`DockTileButton` ✓） | 若这类控件漏进产品：用户点它**毫无反应** ✓ 而它**暗示有内容/有动作** ✓ ⇒ 比没有这个控件更糟 ✓（F-SH-023 里用户据此以为"照片丢了" ✓）。门缺席的代价写在实测里 ✓：我第一版判据（朴素 `/<button[^>]*>/`）**报了 2 条假阳性** ✗ —— 因为 `onclick={() => {` 的 **`>`** 把标签截断 ⇒ 处理函数读不到 ✓（**同一类错误在探针阶段已经犯过一次** ✓）；改花括号/引号感知扫描后 ⇒ **0 条** ✓ | 3 | 3 | 3 | 27 | ①新规则 **R9 `r9_deadControl`** ✓ 接入 `a11y-scan.mjs` 的 `rules` 表 ✓；②**扫描器**用 `buttonTags()`（**花括号 + 引号感知** ✓ —— 专治箭头函数里的 `>` ✓，并把这次教训写进注释 ✓）；③判据边界全部**实测支撑** ✓（静态 disabled ✓ / props spread ✓ / 通用组件目录 ✓）；④自测 **+4 条断言** ✓：**用 F-SH-023 的历史形状做负控** ✓（`aria-label` + `disabled={!last}` + 无处理函数 ⇒ **必须报** ✓）、静态禁用占位 ⇒ 不报 ✓、props spread ⇒ 不报 ✓、正常按钮 ⇒ 不报 ✓；⑤顺手把自测汇总里那句**陈旧的**"15 assertion(s)" ✗ 改为不带数字的实话 ✓ | `a11y-scan.mjs --selftest` ⇒ **all assertions passed（0 failures）** ✓（含新增 4 条 ✓）；实况 ✓：对当前树 **0 条 dead-control** ✓（两个通用组件被目录规则排除 ✓、灰项被静态禁用规则排除 ✓），整份扫描 **exit=0** ✓（本扫描器的约定：只报告缺口 ✓）；**这一步本身就是"门没冤枉人"的证明** ✓ |
| F-MED-001 | **保存时的 MIME 与文件名不一致 ⇒ Android 把文件改名，产出"内容与名字不符"的文件**（REQ-A360 真机发现 ✓，**只有真机才能看见**）：`crates/amos-media/src/android.rs::save()` 给 Android 胶水传的是 **kind 的默认 MIME** ✗（`crates/amos-media/src/mapping.rs:58` `mime_for` ⇒ `MediaKind::Audio => "audio/mpeg"` ✓，**与文件名无关** ✓），而同一文件里就有**按名字**的 `kind_and_mime_for_name()` ✓ ⇒ 于是 `Amos-20260917-125338.wav` 被 MediaStore 按 `audio/mpeg` **规范化为 `Amos-20260917-125338.wav.mp3`** ✗✗（设备实测 ✓：`/storage/emulated/0/Recordings/` 下确有此名 ✓、MediaProvider 日志显示 `.pending-…wav.mp3` → `…wav.mp3` 的移动 ✓） | 用户（或任何别的应用）按名字判断类型 ⇒ **一个装着 WAV 字节的 `.mp3`** ✓：播放器可能拒播 ✓、分享时元数据错 ✓、用户以为"格式被改坏了" ✓。**门的盲区**：这条路径**只在有 Android 胶水的真机上运行** ✗（host 单测走 Mock provider ✓、前端门只看 `exportNameFor` 产出的名字 ✓ 那是对的 ✓）⇒ **没有真机就永远看不见** ✓ —— 本会话多轮"设备不可达"期间，这处缺陷是**不可观测**的 ✓ | 3 | 3 | 4 | 36 | ①**按名字取 MIME** ✓：`kind_and_mime_for_name(&name)` ✓（`.wav` ⇒ `audio/wav` ✓、`.ogg` ⇒ `audio/ogg` ✓），**名字说不出类型时才回退**到 `mime_for(kind)` ✓；②把这次真机证据与"为什么只有真机能发现"写进代码注释 ✓；③`crates/amos-media/` 动手前**干净** ✓（F-SH-012 纪律 ✓） | **真机证据链** ✓（Ragentek S5 / Android 14）—— ①`provider = "android-mediastore"` ✓、`media_list("recordings")` ⇒ **1** ✓；②`content query content://media/external/audio/media` ⇒ `_display_name=Amos-20260917-125338.wav.mp3` ✓、`_data=/storage/emulated/0/Recordings/Amos-20260917-125338.wav.mp3` ✓；③`adb shell ls -la /storage/emulated/0/Recordings` ⇒ `-rwxrwx--- 48044 … Amos-20260917-125338.wav.mp3` ✓（**48044 字节 = 真字节** ✓，前端 `buildWavBytes` 的合成音频 ✓）；④MediaProvider 日志 `Moving …/.pending-…wav.mp3 to …/…wav.mp3` ✓；⑤UI 自述 = **"已存入系统录音（Recordings）"** ✓（**与文件真的存在一致** ✓ —— 这一条是本会话最想要的结论 ✓）。`cargo test -p amos-media` ⇒ 通过 ✓ |
| F-DEV-001 | **验收探针只采样一次 ⇒ 在 MediaStore 的 `IS_PENDING` 窗口里读出"什么都没写"的假结论；配套的是"仪器的输出被丢弃"⇒ 状态没生效也无从发现**（REQ-A361 成工具能力 ✓）：真机验收里**两次**从"写完立刻读"得出"导出没写进系统集合" ✗ —— ①`media_list` 紧接写入读 ⇒ **0** ✓，②`adb shell ls /sdcard/Recordings` 也看不到 ✗；而**权威测量**（`content query content://media/...` + canonical `/storage/emulated/0/...` 路径 ✓）证明**文件一直在** ✓（48044 字节 ✓）。机理明文：Android 的 MediaStore 以 `IS_PENDING=1` 插入、**之后才发布** ✓，shell 侧的 `/sdcard`（FUSE 视角）也滞后 ✓。第二次的同类错误：我用 `>/dev/null` **丢弃了 `window.__probeExpect=…` 设置调用的输出** ✗ ⇒ 设置**没生效** ✓、正例返回 `found:false` ⇒ 看起来像被测对象坏了 ✓ | 后果是**审计结论反向** ✓：能力已经可用、却被记成"根本没写" ✓ ⇒ 若不再复核，团队会去"修"一个不存在的问题 ✓，而真正的问题（`F-MED-001` 的双扩展名 ✓）反而可能被这个假象盖住 ✓。更深一层：**探针是被反复信任的仪器** ✗ ⇒ 它的时序缺陷会**污染每一轮真机结论** ✓（本会话就有两轮被污染 ✓） | 2 | 4 | 3 | 24 | ①探针能**等自己的期望** ✓：`window.__probeExpect={collection,name\|prefix}` + `window.__probeTimeoutMs`（默认 8s ✓）⇒ 轮询并报告 `found`/`settledMs`/`timedOut` ✓（把"一次性采样"换成"**有界收敛**" ✓）；②文件头把两条规则写成纪律 ✓：**时序**（等落盘 ✓）与**路径**（文件问题一律 canonical + `content query` ✓）；③`matches` 不再假定 `.wav` ✓（图片导出同样认得 ✓）；④**真机双向验证** ✓：负控（永不出现的名字）⇒ `found:false / timedOut:true / 1402ms` ✓、正例（`prefix:"Amos-"`）⇒ `found:true / 437ms` ✓；⑤我自己的纪律：**不再丢弃仪器的输出** ✓（设置调用一律回显 ✓） | `scripts/device-probe-media-export.js`（改造 ✓ + 头注释纪律 ✓）；真机（Ragentek S5 / Android 14 ✓）实证见上 ✓；`make device-media-probe` 仍可用 ✓（无参数时为纯只读列举 ✓） |
| F-TAU-007 | **闹钟的"设备绑定"被文档标注为 seam，却从来没有被调用 ⇒ 睡着的手机叫不醒**（REQ-A362 真机测实 ✓，**只有真机能测出**）：`crates/amos-tauri/src/alarm_sched.rs` 的模块头自己写着"…that **device binding stays a caller/device seam**" ✓，`android-glue/.../AlarmGlue.kt` 也写明约定——Rust 应在**每次 `scheduler_alarm_register` 成功后**调用 `AlarmGlue.schedule(ctx, id, atMs)` ✓（取消时 `AlarmGlue.cancel` ✓，内部是 `setExactAndAllowWhileIdle(RTC_WAKEUP, …)` + `AlarmReceiver` 拉起到前台 ✓）。**实测** ✗：CDP 通过真桥登记一个 3 分钟后的闹钟 ⇒ JS promise **正常 resolve、无错误** ✓，而 `adb shell dumpsys alarm \| grep -i amos` **空** ✗、`dumpsys alarm \| grep -E 'u0a172\|com.amos.ai'` **空** ✗（该应用 uid 10172 ✓）、logcat **无任何 alarm 痕迹** ✗ ⇒ 宿主只把闹钟记进**内存 ledger** ✓，AlarmManager 里什么都没有 ✓ | **用户最在意的场景不成立** ✗：手机进入 doze / 应用被后台杀掉后，**闹钟叫不醒设备** ✓（进程活着时的轮询路径能响 ✓ ⇒ "看起来能用" ✓，正是最难发现的那种 ✓）。**门为何全绿** ✓：这条缝**只在真机的 Android 分支上运行** ✗，host 单测走 ledger ✓、前端单测只验 `nextAlarmAtMs` 的**算术** ✓（那部分是对的 ✓，DST 修复本身有效 ✓）⇒ **能力缺口与算术正确被混为一谈** ✓。**与 F-SH-016/021/023 同族** ✓（能力在代码里、在设备上不存在 ✗），**区别**：这次**文档如实标注为 seam** ✓ ⇒ 不是撒谎 ✗，而是**未落地的设备绑定** ✓ | 4 | 4 | 3 | 48 | **修法的范式本仓已有** ✓（不必发明 ✓）：①`crates/amos-jni/src/lib.rs` 的 `attached(vm)` / `with_env(vm, f)` ✓ 存在，注释明写"取代每个 provider 调用点的 `attach_current_thread`" ✓；②`crates/amos-flashlight/src/android.rs` **正是所需形状** ✓ —— "requires a real Android VM (`jni::JavaVM`) plus a `GlobalRef` to the app `Context`" ✓，由 Kotlin 侧在启动时构造 provider ✓；③处置（**待做** ✗）：新增 amos-tauri 侧的 Android alarm provider（持有 `JavaVM` + Context 的 `GlobalRef` ✓）⇒ `scheduler_alarm_register`/`_cancel` 在 `#[cfg(feature="android")]` 分支调用 `AlarmGlue.schedule/cancel` ✓，**保留**既有 ledger/轮询路径不变 ✓（防回归 ✓）；④**判据现成** ✓：`dumpsys alarm \| grep -i amos` 从**空变非空** ✓，并在 `atMs` 前后用 `dumpsys` + `logcat` 核对**真的唤醒** ✓ —— 这是 DST 链条上最后一块真机证据 ✓ | 真机（Ragentek S5 / Android 14）实证 ✓：登记调用 resolve 无错 ✓、`dumpsys alarm` 三处查询皆空 ✓、logcat 无痕 ✓；代码侧证据 ✓：`alarm_sched.rs` 的 seam 注释 ✓ + `AlarmGlue.kt` 的调用约定 ✓（**两条独立证据**支持"从未被调用" ✓）|









### 2.2b 输入法 (amos-ime / amos-tauri)


| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|-----|-----------|----------|
| F-IME-001 | 两个窗口**共用一条拼音缓冲**(A 的候选栏显示 B 打的码、B 的提交吃掉 A 的码) | 用户看到/提交**不是自己打**的字(REQ-A258 的 G1) | 3 | 1 | 2 | 6 | 作用域拆开:`PinyinCore`(词典 + L0 学习层 + 模糊音,`Arc`,进程级)与 `PinyinInput`(每窗口一条缓冲 + 提示 + 撤销码);九条 `ime_*` 带 `window: tauri::WebviewWindow` 按 `window.label()` 归档缓冲;设备级动作(模糊音/清空学习)显式作用于每个窗口 | `two_windows_do_not_share_a_composition_buffer`、`the_undo_hint_is_per_window`、`two_sessions_over_one_core_keep_their_own_buffers`(**负控**:改成单会话 ⇒ 前两条 FAIL) |
| F-IME-002 | 每窗口一条缓冲 ⇒ 窗口标签只增不减,**无界增长** | 长会话内存/查找成本持续上涨(Power of 10 #3) | 2 | 2 | 3 | 12 | `MAX_IME_SESSIONS = 64`:达上限先丢弃"没什么可失去"的窗口(空缓冲/无撤销码/无提交提示),只有所有窗口都在打字才逐出最少使用并 `warn!` | `the_window_map_is_bounded_and_prunes_what_holds_nothing`(含"正在打字的窗口不会在有空闲可丢时被逐出") |
| F-IME-003 | 联想(下一词)**数据装了但没接线**:候选栏不呈现 ⇒ 用户看不到联想,而文档却写着"已完成" | 功能缺口被当成已交付(REQ-A260 复核 REQ-A259) | 3 | 2 | 3 | 18 | `state_of` 在**缓冲为空**时把建议作为候选返回(kind `predict`,与缓冲候选同一索引空间);键盘在 `composing \|\| suggesting` 时渲染候选栏并给 `ime-predict-tag` 标签;域侧 `PinyinInput::predictions()` 只在**两个已提交词**的上下文下给建议(拒绝噪声) | `an_empty_buffer_offers_suggestions_for_what_this_window_committed`、`predictions_need_two_committed_words_of_context`、`suggestions render with their own tag and no composition chip` |
| F-IME-004 | 联想建议**被当成用户输入**:污染学习层,或给出一个永远无效的"撤销此词" | 词典学到用户没打过的词;撤销按钮是坏承诺 | 3 | 2 | 3 | 18 | `commit_prediction` 只记录提交(供链式建议),**不**教学习层;宿主在建议分支把 `last_pick_code` 置 `None`(建议没有拼音码 ⇒ 没有可撤销的 pin) | `picking_a_suggestion_inserts_it_and_teaches_nothing`、`a_picked_prediction_continues_the_chain_without_teaching_the_learner` |
| F-IME-005 | 联想的 FST 数据使二进制变大(实测,隔离探针与应用二进制两条路一致:**+19.6 MB**) | 移动端 APK 体积上涨,装机/更新成本上升 | 2 | 1 | 1 | 2 | `amos-ime` 的 `predict` 特性(default on)是**唯一**开关;瘦身构建 `--no-default-features`:所有调用点无条件(我们自己代码里没有 `cfg`),缺数据时引擎按契约返回"没有建议"而不是假装 | `predictions_need_two_committed_words_of_context`(缺数据时同样返回空 ⇒ 路径不会 panic/假报) |

### 2.3 System UI 桥 (amos-tauri)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-TAU-001 | 桥返回 null 而非结构化错误 | UI 不知根因 | 3 | 4 | 3 | 36 | `backend.ts` 改为 `{ok, error}` 形态 + 诊断账本 | `backend.test.ts` |
| F-TAU-002 | AI 桥超时未上报 | UI 卡死 | 4 | 3 | 2 | 24 | gRPC deadline + 探针 | `ai_bridge::tests` |
| F-TAU-003 | 剪贴板跨用户泄露 | 隐私 | 5 | 2 | 4 | 40 | `clipboard_guest` 审计计数;前台门控 | `clipboard_guest_link_e2e` |
| F-TAU-004 | 剪贴板后台读取 | 隐私 | 4 | 2 | 5 | 40 | `clipboard-changed` 公告只含元数据 | `clipboard-announce.test.ts` |
| F-TAU-005 | 远程驱动 (host→container) 静默失败 | 状态分叉 | 3 | 3 | 3 | 27 | `mirror_failed` warn | `lmk_reverse_drive.rs` |
| F-TAU-006 | 卸载策略被 UI 绕过 | 系统包被删 | 4 | 2 | 4 | 32 | `UninstallGuard` 单一构造点 | `devcare::the_preview_and_the_enforcement_agree` |
| F-TAU-007 | 云端 API key 写入失败 UI 谎报"已保存" | key 实际未落盘 | 4 | 2 | 4 | 32 | `persist_cloud_key` 全检查 + 0600 模式断言 | `ai_bridge::persist_cloud_key` |
| F-TAU-008 | WebView 里未捕获异常刷新即失 | 失败不可见 | 3 | 3 | 4 | 36 | `uiFailures.ts` 观察者记账本 | `uiFailures.test.ts` |

### 2.3 机器人中间件 (amos-link)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-LK-001 | 误报急停 | 机器人骤停 | 4 | 2 | 2 | 16 | `latched` 状态需显式恢复;`deadman` watchdog | `amos-link` 17 lib 测试 |
| F-LK-002 | 漏报急停 | 失控 | 5 | 1 | 1 | 5 | 多源汇总;**`return path`** 折叠 | `amos-link` return path 测试 |
| F-LK-003 | CRC 校验后分配(解码前) | 16 MiB 帧接收端先分配 32 MiB | 4 | 2 | 4 | 32 | `crc32_over()` 流式 CRC,**修复后负控实测** | `codec::allocation_budget` |
| F-LK-004 | 多 NIC 信标走错接口 | 5G modem 出 / Wi-Fi 收 | 4 | 3 | 3 | 36 | `AMOS_LINK_BEACON_IFACE` 钉接口;`lan_multicast.rs` 真测 | `lan_multicast.rs` |
| F-LK-005 | 节点把自己当 peer | 自我回声 | 3 | 4 | 2 | 24 | `PeerRegistry::with_local` 拒绝本机 id | `amos-link::a_node_is_never_a_peer_of_itself` |
| F-LK-006 | 匹配器在注册表锁内分配 | broker 抖动 | 3 | 3 | 3 | 27 | 栈定长数组 + 1000 matches 0 bytes 断言 | `keyexpr::allocation_budget` |
| F-LK-007 | 锁中毒 ⇒ offer_blocking 无界等待 | 控制回路卡死 | 4 | 2 | 4 | 32 | `LinkError::Closed` 类型化 + 负控 `Elapsed` | `broker::tests` |
| F-LK-008 | 静默截断 (`usize as u32`) | 数字读错 | 3 | 2 | 4 | 24 | 饱和算子 + 负控 | `count_to_u32` 单测 |
| F-LK-009 | CLI `--seconds u64::MAX` panic | 进程崩溃 | 4 | 2 | 5 | 40 | `deadline_after()` 解析期拒绝 exit 2 | `cli_smoke::arguments_that_used_to_crash_*` |
| F-LK-010 | 真实硬件 HAL 未测驱动 | 误以为电机已断电 | 5 | 1 | 4 | 20 | `StreamRobotHal` 写入前验证 + 帧计数实测 | `motor --device` 进程级 |
| F-LK-011 | 公告塞不进信标帧 ⇒ 节点在 LAN 上**静默不可见** | 每张对端表都没有它,而日志只有 `debug!` | 4 | 3 | 3 | 36 | `PeerInfo::advertising` **启动期**探针编码(逐字段界 8×128B **不等于** 512B 整帧界)+ CLI `--endpoint` 越界 exit 2 / exit 1 | `an_unemittable_advertisement_is_refused_before_the_task_starts`、`cli_smoke::an_advertised_endpoint_*`(第 5 段) |
| F-LK-012 | 时钟不一致被读成 **0 延迟**（`Timestamp::since` 对未来的戳饱和为 0） | 操作员读「刚刚到达」;`bench` 的 p50/p99 比链路更漂亮 | 3 | 3 | 3 | 27 | CLI 单一规则 `age_between`(未来 ⇒ `InTheFuture`,人类行 `age=unknown(…)`/JSON `age_ms: null`);`bench` 把不可测帧**计数不计样**(`skewed`/`latency_us.samples`);`clock_synced=false` 旁注 | `a_frame_stamped_in_the_future_has_no_age_to_print`、`a_benchmark_never_counts_an_unmeasurable_frame_as_zero_latency`、`cli_smoke::the_age_caveat_and_the_bench_sample_count_are_wired` |
| F-LK-013 | **真网络上的节点把自己的计数器留在 0**（传输不计数 ⇒ `published`/`delivered` 终生为 0，而 0 被读成「没发过」） | 操作员/判决/面板把一条正在发帧的链路读成空闲 | 4 | 3 | 4 | 48 | 传输持有节点的那一组计数器（`Transport::metrics`）：`put` 成功 ⇒ `published+1`、转发交接 ⇒ `delivered+1`；`LinkNode::with_parts` 在两组不同 Arc 时 `warn!` | `a_node_over_a_real_session_counts_what_it_publishes`（真 TCP 会话，两个 peer） |
| F-LK-014 | **老 daemon 少一个 RPC ⇒ 整次读取失败**（文档承诺的是「少显示一栏」）→ 面板变「未连接」、CLI exit 1，连已答的状态/对端表一起丢 | 升级期的现场读不到任何东西；「我们没被告知」被渲染成「没有人上报」 | 3 | 3 | 3 | 27 | 只对 `Unimplemented` 降级：回程成为 `actuations: null`（三态）+ `warn!`，其它失败照实报错；CLI 与面板同一规则；三态纯函数 `returnPathLevel` | `a_daemon_without_the_return_path_still_answers_the_panel`、`an_older_daemon_still_answers_the_status_over_a_socket`、`link-page.svelte.test.ts` |
| F-LK-015 | **QoS 只在进程内成立**：网络传输上 `Qos::sensor()`（latest-wins）交给消费者的是**最老的那一帧**；`DropPolicy::DropNewest` 从不生效（满即背压整条链路）；订阅自己的 `dropped` 恒为 0 | 相机→大脑链路上拿到陈旧帧（正是该 profile 要避免的）；丢帧数读成 0，操作员据此判断链路健康 | 4 | 3 | 4 | 48 | 远端订阅按 profile 建**同样的 sink**（`Subscription::remote_latest` / 有界队列），转发任务按可靠性分支（best-effort 满即丢并计数、reliable 满即等）；新增 `RelayCounters` 让订阅侧与节点侧计数器同源 | `a_latest_only_subscription_over_a_real_session_keeps_the_newest_frame`、`a_best_effort_queue_over_a_real_session_drops_the_newest_and_counts_it`（真 TCP 环回会话，先红后绿） |
| F-LK-016 | **平台剖面机器未解锁 ⇒ motion 被拒**：剖面机器的 `Motion` 批次**不自带 `Enable`**（与参考四足不同），运行期需要显式 `Arm`；漏 Arm 的 motion 路径会让机器「以为能走、其实收不到」 | 操作员下达 "go"，机器不动；驾驶舱/UI 把这读成链路/规划故障而不是 arming | 3 | 2 | 3 | 18 | `step_inner` 的 motion 分支**先看是否 latched**：未解锁时用剖面 `Vocabulary::arm_hint()`（`arm` 或 `enable`）点名解锁键并返回 `Refused`；`Halt` 永不被拒（cut torque 必须在任何状态下生效）；参考机的运动批次自带 `Enable`，该分支对它永不触发（参考机等价测试钉住） | `the_drone_refuses_motion_until_armed`、`the_reference_machine_never_enters_the_must_be_armed_branch` |
| F-LK-018 | **固定位姿动作上的 `speed` 被收下、校验、然后丢掉**：`Platform::parse_intent` 解析 `speed` 并做 `[0,1]` 范围检查，而 `speed_scaled: false` 的动作（`takeoff`/`rtl`/`hover`/`lane_keep`/`cycle`…）把它**丢弃** —— 实测 `takeoff` 的 `speed:0.0` 与 `speed:1.0` 产出**同一批** 4×55% 推力帧 | 地面站要求「温柔起飞」/「慢一点进近」，机器全速执行且**没有任何提示**；操作员据此以为该数字生效了（正是本仓在别处一律拒绝的「静默丢掉输入」） | 3 | 3 | 3 | 27 | `parse_intent` 在范围检查之后**拒绝显式 speed**：`action takeoff on platform drone has a fixed pose, so speed 0.1 cannot be honoured: remove it, or send the set points you want in targets`；`Arm`/`Halt` 不受影响（拼错字段不得拦住解锁与停车）；参考机的步态全是 `speed_scaled: true`，该分支对它永不触发 | `a_speed_that_cannot_be_honoured_is_refused_not_dropped`（含「每个动作要么用上要么拒绝」的全剖面扫描）、负控 1/5 |
| F-LK-019 | **同一执行器的两个设定点被 `find()` 静默取第一个**：`[{"actuator":0,"arg":10000},{"actuator":0,"arg":90000}]` ⇒ `arg:90000` 消失，**JSON 字段顺序**决定了无人机飞哪个推力 | 一条自相矛盾的指令被静默二选一；现场复盘时「我发的明明是 90000」无人能解释 | 3 | 2 | 4 | 24 | `parse_intent` 拒绝重复：`actuator 0 (thruster_1) is named twice in one intent: two set points for one actuator leave the layer choosing which of them to drop`；参考机路径冻结（其语义是「第一个赢」并逐字节为证） | `two_set_points_for_one_actuator_are_refused_rather_than_first_wins`、负控 2/5 |
| F-LK-020 | **「只有目标参数的动作」可以不带参数**：`{"action":"goto"}` 被接受并飞出默认 58% 推力位姿 —— 一个顶着「去某处」名字的**默认动作**（`waypoint` 同理） | 工具少填一个字段 ⇒ 机器动起来，而且动的是剖面作者随手写的位姿 | 3 | 2 | 3 | 18 | `ActionSpec::min_params`（`goto`/`waypoint` = 1）在参数校验**之后**检查：`… needs at least 1 of its parameters (north_mm, east_mm, altitude_mm), and this intent names none of them — a target is not a default`；有文档化默认值的动作仍是 0（车道偏移 0 = 居中） | `an_action_that_is_its_target_is_refused_without_one`（含 7 个「有默认值、不得要求参数」的反例）、负控 3/5 |
| F-LK-021 | **「机器是数据」是空话**：`Platform` 字段私有 + 六份 `const` ⇒ 部署的自有机器（±120° 机械臂、八旋翼、不同制动执行器）只能改本 crate 的文件；而自相矛盾的剖面（位姿长度与执行器表不符、两个 `Arm`、行程超出帧参数空间、看门狗排不出来）**没有任何一条规则在编译期或构造期拦它** | 一台带着自相矛盾词表的机器上线：接受了指令、写出了没人能解释的帧；`plan()` 里那些拒绝句子对六个内置剖面**永不可达**（测试无法覆盖） | 4 | 2 | 3 | 24 | 新增 `Platform::from_parts(kind, actuators, actions, envelope, arm_on_motion)` + `Platform::validate()`（18 条规则：执行器 ≥1、序号从 0 连续、≤12 且在帧参数空间内、名字唯一、行程有序且两端合法；动作键唯一、恰好一个 `Arm` 与一个 `Halt`、位姿长度/行程、非运动动作位姿惰性、参数名唯一且区间有序、`min_params` 可满足、包线可排程）。集成测试把**同一条规则**跑在六个内置剖面上（一条规则、两个调用方） | `a_misdeclared_profile_is_refused_naming_the_rule_it_broke`（18 个剖面各坏一条规则）、`a_deployment_profile_is_a_usable_machine_not_just_an_accepted_value`、负控 4-5/5 |
| F-LK-017 | **剖面参考机兼容性**：把"参考四足"换到 `Vocabulary::Profile(&quadruped)` 路径必须与 `Vocabulary::Reference` 路径**逐字节产出相同的帧**，否则迁移现存 fleet 时机器人行为漂移 | 同一架机器人从老 daemon 切到新 daemon 后步态不一致；上游控制/学习数据对不上 | 3 | 3 | 2 | 18 | `Platform::quadruped()` 用与手写 `robot_hal::plan` **同一份逻辑**构建 motion（同样的 `Enable(0)` 前导、同样 12 关节位置帧、同样的速度换算）；**等价测试** `the_reference_platform_plans_byte_identically_to_the_handwritten_path`（含前导 `Enable(0)` 这个历史怪癖，不修正——修正会破坏现有数据） | `the_reference_platform_plans_byte_identically_to_the_handwritten_path`（13 例剖面契约测试的第一条） |

### 2.4 数据完整性

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-DA-001 | 损坏的 localStorage 被静默回退 | 用户数据丢失 | 3 | 3 | 4 | 36 | `readJson` 区分缺失/损坏 + 隔离备份 | `amosStore.test.ts` |
| F-DA-002 | 隔离备份从未被读出 | 用户拿不回数据 | 2 | 4 | 4 | 32 | `listQuarantined` / `readQuarantine` UI 暴露 | `amosStore.test.ts` |
| F-DA-003 | 长会话无界累积 | OOM | 3 | 4 | 3 | 36 | `capTail` 200 条上限 | `bounded.test.ts` |
| F-DA-004 | 备份快照 key 与真实存储分叉 | 收藏/消息漏备份 | 4 | 3 | 4 | 48 | `SYNC_STORES` 改为模块常量键 | `settings.test.ts` |
| F-DA-005 | AI 历史会话读取未授权 | 历史泄露 | 3 | 2 | 3 | 18 | `GetHistory` RPC + session ownership 校验 | `ai_history_e2e` |

### 2.5 Android 集成

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-AND-001 | 相机 use-after-free | 进程崩溃/帧损坏 | 4 | 3 | 3 | 36 | `CameraGlue` 串行化 + epoch 守卫 | `Nv21PackerTest` |
| F-AND-002 | LMK 误杀活跃应用 | 关键进程被杀 | 4 | 2 | 3 | 24 | `UninstallGuard`;`mirror_failed` warn | `lmk_reverse_drive.rs` |
| F-AND-003 | 真实电池读数缺失上报 0 | 虚假低电量告警 | 3 | 3 | 4 | 36 | `BatteryReading::chargingFrom()` UNKNOWN 省略 | `devcare::battery` |
| F-AND-004 | APK 安装超时误报 | 用户以为成功 | 3 | 2 | 2 | 12 | `AMOS_ANDROID_INSTALL_TIMEOUT=180s` 独立 | `android_test.rs` |
| F-AND-005 | JNI 调用阻塞 UI 线程 | ANR | 4 | 3 | 2 | 24 | `spawn_blocking` 五处 | 手动审计 |

### 2.6 真机设备 (amos-telephony / amos-radio / amos-sensor)

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|---|-----------|-----------|
| F-TEL-001 | 紧急号码(110/112/911)被录音 | 隐私违规 | 5 | 2 | 5 | 50 | `hard no-record rule for emergency` | `telephony::tests` |
| F-TEL-002 | 黑名单生效但 UI 显示"未生效" | 拦截假象 | 4 | 2 | 3 | 24 | `blocklistCheck` 实时提示 | `phone.svelte.test.ts` |
| F-RAD-001 | 飞行模式级联未完整 | 设备未真正断网 | 4 | 2 | 3 | 24 | `RadioManager` cascade + guard | `radio::tests` |
| F-SEN-001 | 传感器 mode 切换未生效 | 耗电/低质量 | 3 | 3 | 3 | 27 | `SensorManager` 显式 apply | `sensor::tests` |

---

## 3. 跨功能风险点

### 3.1 资源/内存边界 (NASA Power of 10 #2)

| 模块 | 已建立边界 | 测试 |
|------|------------|------|
| `amos-ai::pool` | `NonZeroUsize` 容量 + RAII permit | 12 任务并发 |
| `amos-ai::cache` | 32 条/300s/256 KiB | 命中/过期/LRU/超限 |
| `amos-ai::session` | 100 条上限 | 单测 |
| `amos-link::broker` | 有界 slot + `Closed` 类型化 | 锁中毒负控 |
| `amos-sms::trash` | 256 FIFO | 单测 |
| 前端 `AiApp` | `capTail(CHAT_MSG_CAP=200)` | `bounded.test.ts` |
| 前端 `InterpApp` | `capTail(SEG_CAP=200)` | 同上 |
| 前端 `notifyStore` | `NOTIF_CAP=100` | 同上 |

### 3.2 失败可见性 (Power of 10 #7)

| 模块 | 失败处理 | 测试 |
|------|----------|------|
| `backend.ts` invoke | 永不 reject,记诊断账本 | `backend.test.ts` |
| `amos-ai::server` | `Status` 类型化(InvalidArg/Unauth/Internal) | 各 e2e |
| `amos-ai::governor_service` | `mirror_failed` warn | `lmk_reverse_drive.rs` |
| 前端 `uiFailures` | 全局未捕获观察者 | `uiFailures.test.ts` |

### 3.3 静态约束 (P0-1)

| 维度 | 门禁 |
|------|------|
| 生产代码禁 `unwrap/expect/panic` | `scripts/rust-panic-scan.mjs` (39 crate 全部通过) |
| 禁 `unsafe` 无 SAFETY 注释 | `scripts/unsafe-scan.mjs` |
| 禁 `std Mutex` 跨 `.await` | `scripts/lock-across-await-scan.mjs` |
| 禁 `std::fs` 在 `async fn` 内 | `scripts/blocking-in-async-scan.mjs` |
| 禁递归(含互递归) | `scripts/rust-recursion-scan.mjs` |
| 禁 must-use 静默丢弃 | `scripts/rust-discard-scan.mjs` |
| 禁 hot spin loop | `scripts/hot-loop-scan.mjs` |

---

## 4. 残余风险(已识别且接受)

> 这些风险**当前未缓解**,**已文档化**为"已知缺口"。**任何改动必须重新评估**。
>
> 接受人必须非空;`fmea-gen.mjs --emit-residual` 会机读校验空接受人**(含 `TBD` / `(TBD)` 后缀)**。
>
> **关于本表的签字模型(诚实声明)**:AmOS 是研究/原型 OS、未做 DAL 审定(见 §6),本表
> 当前由单一开发者 (`arkSong`) 同时承担 safety / ai / security / android 四类 role 的
> 残余风险签字。该做法**不符合职责分离**(理想的合规模型是各 role 由独立负责人分别复核),
> 但在无独立审查员的现状下,这是使本表"有人签字、避免空挂"的可执行方案。**一旦项目进入任
> 何受监管/审定路径,本节必须按 role 拆分并补独立签字。**

| 残余风险 | 接受理由 | 跟进 | 接受人 | 日期 |
|----------|----------|------|--------|------|
| F-LK-002(漏报急停)在异构板上未端到端验证 | 单元测充分,真机集成属设备 bring-up | 真机验收(runbook) | arkSong (safety) | 2026-09-15 |
| F-DA-005(AI 历史)在真机 SMS 已读回执上未联调 | 设备 SMS 由系统侧负责,本服务只读自身模型 | 设备 bring-up | arkSong (ai) | 2026-09-15 |
| F-AI-013(速率限制被旁路)在恶意客户端下可能放大 | 安全层是 best-effort | 加固留给后续 P2 | arkSong (security) | 2026-09-15 |
| F-AND-005(JNI 阻塞)在真机慢路径下未实测 | 代码侧全走 `spawn_blocking`,实测属设备 | 设备 bring-up | arkSong (android) | 2026-09-15 |

---

## 5. 自动生成说明

- 本表由 `scripts/fmea-gen.mjs` 从 **代码与测试**双源扫描生成
- 任何新增 P0/P1 路径应同步在表中登记
- 任何 RPN ≥ 100 项必须由独立验证人复核
- 残余风险表 (§4) 中的项目必须**有书面接受签字**才能进入审定;`--emit-residual` 会机读校验
- 三个模式:
  - `node scripts/fmea-gen.mjs --check`         文档 ↔ inventory ↔ 代码三方一致性
  - `node scripts/fmea-gen.mjs --emit-json`     机器可读 inventory(供仪表盘消费)
  - `node scripts/fmea-gen.mjs --emit-residual` 残余风险签字状态

---

## 6. 与 DO-178C DAL 的对应

> AmOS 是**研究/原型 OS**,**未**按任何 DAL 审定。本节用于映射关系,不可作审定证据。

| DO-178C DAL | 适用系统 | AmOS 当前对应 |
|-------------|----------|---------------|
| DAL A | 灾难性失效 | F-LK-002、F-TEL-001、F-AI-010/011 — **未达 DAL A 审定** |
| DAL B | 严重/危险 | F-DA-004、F-AND-002 — 已建门禁,**仍需独立验证** |
| DAL C | 重大 | F-LK-007、F-AI-001 — 单元覆盖充分 |
| DAL D | 轻微 | 多数 S3 项 |
| DAL E | 无安全影响 | S1-S2 项 |

**结论**:AmOS **不申请**任何 DAL 审定。文档顶部"⚠️ 非审定软件"声明强制保留。
