# 审计：桌面多窗口与「高阶生态」的真实残缺（AmOS vs FydeOS）

> 日期：2026-09-15（REQ-A254）。触发：用户提问——「FydeOS 的 PWA 网页生态极度成熟……
> 而 AmOS 由于走移动端路线，多窗口桌面特性尚未合入主线（处于 Roadmap 阶段），且输入法层
> 仍缺乏原生的中文输入支持」。
>
> 本页是**取证结论**，不是路线图：每条判断后面都跟着可以自己跑一遍的命令或文件位置。
> 结论先行：**这句话在本仓库的当前 HEAD 上已经不成立**（多窗口已合入主线、中文输入已落地），
> 但它指向的那类残缺**真实存在**，只是不在它说的位置。下面把「已有什么」与「真缺什么」分开写。

---

## 1. 前提校正（三条断言，逐条取证）

### 1.1 「多窗口桌面特性尚未合入主线」——**不成立**

| 断言 | 证据（可自跑） |
|---|---|
| 宿主有真实的多窗口适配层 | `crates/amos-tauri/src/wm.rs`：12 条命令（`wm_open/focus/hide/close/home/windows/layout_snapshot/layout_set_screen/split*/set_shell_title`）一次性注册在 `lib.rs` 的 `generate_handler!`；`WmState::apply()` 把 `WmEvent` 落到真实 `WebviewWindow`（show/hide/set_focus/close） |
| 新窗口**直接进入该 app** | `wm.rs:684` `WebviewUrl::App(format!("{APP_ENTRY}#window={label}"))` + `frontend-ts/src/lib/windowRoute.ts` 解析 `#window=<label>` |
| 桌面壳层存在且有人挂 | `frontend-ts/src/svelte/{DesktopShell,DesktopStage,TopBar,Dock,Launchpad,SpotlightOverlay,MissionControl}.svelte`；`Shell.svelte` 在 `isDesktop` 分支挂 `DesktopShell` |
| 启动器真的走多窗口 | `invoke("wm_open", …)` 出现在 `Launchpad.svelte:94`、`SpotlightOverlay.svelte:76`、`Dock.svelte:123`、`DesktopStage.svelte:74/115/120`；`invoke("wm_focus", …)` 出现在 `Dock.svelte:121`、`MissionControl.svelte:53` |
| 分屏落到**真实 OS 窗口** | `wm.rs::apply_split_to_real`（`set_position`/`set_size`，`wm.rs:1123-1125`） |
| 焦点跨窗口同步 | `wm.rs::apply` 在最外层焦点变化时写共享 store 的键 `APP_FOCUSED_KEY`（`SharedStore::set` 自带的 `store-updated` 广播），`TopBar` 用 `createStoreValue(APP_FOCUSED_KEY)` 读取并显示当前 app 名（**只有 store 一条通道**：原本另发的 `app-focused-changed` 事件无人订阅，本轮删除） |

**为什么会有「还在 Roadmap」的印象**：仓库里确实留着**两处陈旧的自我描述**，它们比代码落后：

1. `docs/PC_DESKTOP_AUDIT.md` §3.2（P0-2）写「`wm_open` 完全没有被启动器调用」「没有任何代码
   生成 `#window=<id>`」。**这两句在 REQ-A250 之后就都不成立了**（见上表）。
2. `scripts/tauri-command-allowlist.json` 里为 `wm_open`/`wm_focus` 挂的"无消费者"理由同样过期——
   而**门禁比文档先发现问题**：`node scripts/tauri-command-scan.mjs` 会打印
   `allow-list: 2 stale entry(ies) — shrink with a reason: wm_focus (now consumed), wm_open (now consumed)`。
   本轮已把这两条删除（allow-list 20 → 18），并把 `docs/multi-window.md` §5 那段
   「`wm_*` 尚未接线」的现状描述改正（REQ-A254）。

> 结论：**多窗口是主线代码，不是 Roadmap**。它的残缺在后面（§3 的 G5），而不是「没合入」。

### 1.2 「输入法层缺乏原生的中文输入支持」——**不成立**（但边界要看清）

| 断言 | 证据 |
|---|---|
| 有真实的中文（拼音）输入引擎 | `crates/amos-ime`：`inputx-pinyin` 1.4（内嵌 ~165k 码 FST 词典 + L0 学习层）、`PinyinInput`（整码词 + 整句 Viterbi 组合）、模糊音 9 对、`ImeProfile` 持久化 |
| 有会话与命令面 | `crates/amos-tauri/src/ime.rs`：`ime_status/key/backspace/clear/commit/fuzzy_toggle/fuzzy_preset/learning_clear/forget_last` + `amos-ime.json` 原子写 |
| 有键盘 UI 与光标插入 | `frontend-ts/src/{lib/ime.ts, svelte/ImeKeyboard.svelte, svelte/ImeOverlay.svelte}`（挂 `Shell.svelte` ⇒ 每个 app 都能用） |
| 物理键盘也驱动同一引擎 | `ImeOverlay` 捕获阶段接管 a–z / 1–9 / 空格 / 回车 / 退格（`docs/input-method.md` §Key behaviours） |

**真正的边界**（这才是这句话里唯一成立的部分）：
`docs/input-method.md` 自己写着——**这是 in-app 输入法，不是系统级 IME**。全仓 `grep -rn
'InputMethodService' --include='*.kt' --include='*.java' crates/ deploy/` **无任何命中**：
AmOS 的拼音只能输入**它自己的 WebView**，容器里的 Android app、宿主机的别的应用都用不到它。
要做成系统级输入法需要一个独立的 `InputMethodService` APK（这是**新能力**，见 §3 的 G3）。

### 1.3 与 FydeOS 的生态对照（用户真正在问的那张表）

| 能力 | FydeOS | AmOS 现状 | 证据 / 缺口编号 |
|---|---|---|---|
| B/S 应用（浏览器即应用） | 原生浏览器 + 完整 Web | **无通用浏览器**；有 `Shell.svelte` 内的 web-bundle 宿主（真 origin、CSP 收口） | `docs/pwa-index.md` §4；G2 |
| PWA 安装/启动 | 完整（安装、图标、独立窗口） | 索引+网关+安装器已落地；**预装声明无法启动**（无「打开远程 URL」能力） | `pwa::serve_index`、`ExtAppHost.svelte`、`PwaHubApp.svelte`；G2 |
| Android 应用 | ARC++ / 容器（**平台自带**，桌面形态也有） | Linux：Waydroid 容器 + F-Droid 通道 + LMK 已落地；**macOS 没有可用容器**（需 Linux 内核）⇒ 宿主如实上报 `runtime: demo` 并横幅告知，不再把夹具当装机应用 | `docs/android-compat.md`；**D14 / G8** |
| Linux 桌面应用 | Crostini 容器 | **宿主机 `.desktop` 直接列出并启动**（本轮落地） | `docs/desktop-native-apps.md` |
| Windows 应用 | 无 | **Wine 前缀里的应用列出并启动**（本轮落地） | `docs/desktop-native-apps.md` |
| 多窗口/桌面 | 成熟 freeform + 多桌面 | 多窗口 + Dock/顶栏/启动台/Mission Control/**真分屏**已落地；**形态策略已强制到窗口层**（G5 收口） | §1.1；G5 |
| 中文输入 | 系统级输入法框架 | in-app 拼音输入法（引擎/UI/学习都真）；多窗口下**每窗口一条缓冲、共享同一个学习层**（REQ-A258 收口 G1） | §1.2；G3 |
| 联想/云输入 | 有 | 本地、离线；**联想已接线**（词三元 FST，提交两词后给建议，标签「联想」；不联网、无云输入） | `docs/input-method.md` §Next-word suggestions；G4 ✅ |

---

## 2. 本轮实测到的真缺陷（每条都能被判据复现）

起点是一棵**有未提交在建工作**的工作树：`crates/amos-tauri/src/{wine,linux_apps}.rs` 是新增
但**未 `git add`** 的文件，`lib.rs`/`Cargo.toml` 里已把它们接进命令表。先跑仓库自己的门禁，
失败清单就是缺陷清单——下面每条都注明**是谁发现的**。

### D1 六条命令**从未注册**（构建配置写错了 `target_os`）

* 现象：`node scripts/tauri-command-scan.mjs` ⇒
  `FAIL — wine_apps/wine_launch/wine_is_available/linux_apps/linux_launch/linux_is_available is declared #[tauri::command] but NOT registered (unreachable)`。
* 根因：`lib.rs` 把 handler 条目标成 `#[cfg(target_os = "darwin")]`——**`darwin` 不是合法的
  `target_os` 值**（`macos` 才是），该 `cfg` 永远为假；同一处还产生 4 条
  `unexpected cfg condition value: darwin` 警告（`clippy -D warnings` 下即失败）。
* 处置：模块与条目改 `#[cfg(desktop)]`，**可用性下沉为运行时**（`wine_is_available()` /
  `on_linux()`）——与 `amos-wm::form` 对「手机 vs 平板」的处置同一条规则：一个编译目标、两种事实。

### D2 启动路径是**信任边界漏洞**（WebView 说什么就跑什么）

* 现象：`wine_launch(exe_path: String)` 直接 `Command::new("wine").arg(exe_path).spawn()`；
  `linux_launch(exec: String)` 直接 `Command::new(exec).spawn()`。
* 为什么是缺陷：任一 WebView（**第三方 web-bundle 就运行在自己的 WebView 里**，拿得到
  `invoke`）都能让宿主执行任意路径——这与 `[permissions]` 那套收口点完全相反。
* 处置：命令参数改为 **`id`**（只可能来自宿主自己的枚举），`app_by_id()` **重新枚举**再查找，
  未知 id 具名拒绝并原样上屏；id 经字符白名单 + 64 字符上界。测试
  `a_path_is_not_an_id_and_is_refused`（两侧各一条）钉住它。

### D3 两份重复的 `.desktop` 解析器，且都是**无界递归**

* 发现者：`node scripts/rust-recursion-scan.mjs` ⇒
  `NEW crates/amos-tauri/src/linux_apps.rs:74 fn desktop_files_in` +
  `NEW crates/amos-tauri/src/wine.rs:99 fn collect_wine_desktop_files_recursive`
  （Power of 10 规则 1 禁止递归）。
* 处置：解析与遍历收敛到一处 `crates/amos-tauri/src/desktop_entry.rs`——纯解析（`&str` 进、
  值出，可离线测）+ **显式工作列表 BFS**（深度上限 4、文件上限 512，触顶**计数上报**）。

### D4 Linux 侧的「去重」是**恒真表达式**（从未生效）

* 现象：`seen.entry(app.id.clone()).or_insert(()).is_empty()` —— `()` 永远 "empty"，所以
  `retain` 全留：`/usr/share` 与 `~/.local/share` 里同 id 的条目会**各列一次**。
* 处置：`HashSet<String>` 按 id 去重（用户目录在前 ⇒ 保留用户自己那一份）。

### D5 `home_dir()` 取不到时**静默扫相对路径**

* 现象：`dirs::home_dir().unwrap_or_default()` ⇒ 空 `PathBuf`，`~/.wine` 变成**相对**
  `./.wine`：列出的会是「宿主启动目录」下的东西。
* 处置：返回 `Option`，没有 home 就 `warn!` 并**不列**（`linux_apps` 同样处理，并说明用户目录内容缺失）。

### D6 解析器**吃掉 Windows 路径的反斜杠**

* 现象：`C:\Program Files\App\app.EXE` 被读成 `C:Program FilesAppapp.EXE`——Wine 条目里最常见的
  写法直接坏掉。
* 发现者：本轮自己写的 `the_executable_is_the_token_carrying_the_exe_extension`（先失败才修）。
* 处置：按 spec **只把 `\\` 当转义**，孤立 `\` 是数据（`C:\Program Files\…` 原样保留）。

### D7 `.desktop` 是**无界读**

* 现象：`std::fs::read_to_string(path)` 无任何上限（仓库在 `note_export` 等处有 `MAX_*_BYTES` 纪律）。
* 处置：`desktop_entry::MAX_ENTRY_BYTES = 64 KiB` + `read_bounded()` 返回**拒绝理由**，
  调用方计入 `skipped_entries`。

### D8 交付物**不在 git 里**（clean checkout 无法构建）

* 发现者：`node scripts/untracked-source-scan.mjs`（`UNTRACKED … wine.rs / linux_apps.rs`）与
  `node scripts/dangling-source-scan.mjs`（`lib.rs -> wine.rs` 指向未跟踪文件）。
* 处置：`git add`（两个扫描现在都是 OK）。

### D9 `wm.rs` 的 discard 棘轮回归，指向一个**发出去没人听的事件**

* 发现者：`node scripts/rust-discard-scan.mjs` ⇒ `more discards than baselined: wm.rs (6 > 5)`。
* 根因：新增的 `let _ = app.emit(APP_FOCUSED_EVENT, &label);` 丢弃了投递失败——正是仓库
  反复强调的「静默失效」形状。
* 处置（两步，第二步是真正的收口）：先把丢弃改成可见的 `warn!`，随即发现这条事件**本身**
  就是多余的（见 D13），于是**整条删掉**——棘轮因此回到基线以下，而不是"用一个 warn 掩盖一个
  不该存在的通道"。

### D13 宿主发出的事件**没有任何订阅者**（门禁自己抓到的）

* 发现者：`node scripts/tauri-event-scan.mjs` ⇒
  `FAIL — app-focused-changed is emitted by the host but no screen subscribes to it`。
* 判断谁是错的：前端**故意**只读共享 store——`frontend-ts/src/lib/wm.ts:390` 的注释写着理由
  （「one source, and `createStoreValue` already re-renders on it」，并记着此前导出的
  `APP_FOCUSED_EVENT` 常量就是被 `unwired-scan` 判掉的）。也就是说**错的是宿主那条 `emit`**：
  事实只有一个真源（`amos.app_focused`），而 `SharedStore::set` 已经会广播 `store-updated`。
* 处置：删除 `wm.rs` 的 `emit` 与 `store.rs` 的 `APP_FOCUSED_EVENT` 常量，并把
  `docs/multi-window.md` §6.2/§6.4、`docs/PC_DESKTOP_ARCHITECTURE.md` §"数据流"/§6.1 里
  「TopBar 订阅事件」「广播 app-focused-changed」这些**与代码不符的描述**改正为 store 通道。
  （`scripts/tauri-event-allowlist.json` 里没有它——所以这不是靠豁免过的，而是靠删掉死通道。）

### D10 输入法：**切换模糊音会静默清空学习词库**（内存 + 磁盘）

* 现象：`PinyinInput::set_prefs` 为换 `FuzzyConfig` **重建** `PinyinEngine`，而 L0 学习层住在
  那个 engine 的词典里 ⇒ 用户辛苦置顶的词当场消失；更糟的是桥层 `fuzzy_toggle`/`fuzzy_preset`
  **紧接着 `persist()`**，于是把**空的学习层写回** `amos-ime.json`（持久丢失）。
* 证据（写测试先行）：`changing_fuzzy_preferences_keeps_the_learned_words` 修复前
  `assertion left: 0, right: 1`；桥层新用例 `toggling_a_fuzzy_pair_does_not_erase_the_profile_learner`
  在修复前也会看到磁盘上的 `pins` 变空。
* 处置：重建时把 L0 搬过去（`export_l0` → 新 engine → `import_l0`）；**缓冲仍清空**（排序规则真的变了）。
  两个回归用例 + `docs/input-method.md` 的行为条款。

### D11 **门禁自身**的解析缺陷（我这两个 FAIL 的根因）

* 现象：`tauri-command-scan` / `tauri-args-scan` 都用 `src.indexOf("]")` 给
  `generate_handler![…]` 定界。逐条 `#[cfg(desktop)]` 自带一个 `]` ⇒ 列表在第一处属性就被截断，
  其后所有命令被报成「declared but NOT registered」。
* 处置：两侧都改为**括号配平**扫描（`matchingBracket`），并各补自测（`tauri-command-scan`
  21 条断言含 5 条新回归；`tauri-args-scan` 26 条全绿）。

### D12 六条命令**没有任何消费者**（dead surface）

* 现象：即便注册对了，`tauri-command-scan` 仍会报「registered but no screen calls it」——
  这正是本仓最忌讳的形状（"已定义 + 已单测 + 没人调用"）。
* 处置：新增真实界面——`frontend-ts/src/lib/nativeApps.ts`（桥 + 忠实归一化）与
  `frontend-ts/src/svelte/NativeAppsApp.svelte`（应用 id `nativeapps`，注册进 `appRegistry`
  与 `appMeta`，中英 i18n 全键，四个状态互不混淆），并有 11 + 4 条前端测试。


### D14 桌面把**内置假的安卓应用列表**当成「本机已安装应用」（REQ-A255）

* 现象（macOS / 未装 Waydroid 的 Linux 上必现）：`AndroidRuntime::auto()` 在**没有容器**的主机上回退到
  `DemoRuntime`——一个写死 4 个包名（微信/抖音/淘宝/高德）+ 合成 window id 的**夹具**；
  `GetInstalledApps` 只回 `apps`，于是「安卓应用」页把它们**当成这台机器装好的应用**列出，
  点按后宿主回报「已启动 · waydroid_demo_com.tencent.mm」。
* 为什么是缺陷（两条，都不是"样式问题"）：
  1. **叙述虚假**：用户看到的是"我的机器上有微信"。事实是这台机器上**没有**任何 Android 运行时。
  2. **表面无人绘制**：`open_surface("legacy:waydroid_demo_*")` 只把它登记进 `amos-wm`
     的焦点/z 序模型；该宿主上**没有任何合成器**在画它——屏幕上什么都不会出现。
* 处置（三处）：`AppListResponse` 新增 `runtime` + `demo`（服务端由 `runtime_name()`/`is_demo()`
  填）→ 桥回 `AndroidAppsOut` → 界面在 `demo` 时显示横幅、**不**谎报「已启动」、**不**写「最近启动」；
  `demo` 只认字面 `true`（缺失 = 未知，不冤枉真实容器）。两侧测试钉住（`the_list_carries_the_runtime_that_answered`、
  `normalizeAppsReply` 6 例、`android.svelte.test.ts` 的 demo/real 两例）。
* 诚实边界（登记为 **G8**）：本轮只让系统**说清现状**；要在 macOS 上真的跑 APK 需要新能力
  （VM 内的 Android 或远程 adb 设备），是产品决策。


| # | 缺口 | 现状（证据） | 建议设计 | 影响面 |
|---|---|---|---|---|
| **G1** | 输入法**跨窗口共享同一个会话** | ✅ **已收口（REQ-A258）**：原状是 `ImeBridge` 单个 `Mutex<ImeInner>`（词典 + 学习层 + **一条拼音缓冲** 全进程共用）、`ime_*` 命令**不带窗口标签** ⇒ 两个窗口共用一条缓冲（A 的候选栏显示 B 打的码、B 的提交吃掉 A 的码）。现在按作用域拆开：`PinyinCore`（`Arc`，词典 + L0 学习层 + 模糊音偏好，**进程级**）、`PinyinInput`（**每窗口**一条缓冲 + 提交提示 + 撤销码），九条 `ime_*` 全部带 `window: tauri::WebviewWindow`（宿主注入，JS 不传；`clipboard.rs` 先例）并按 `window.label()` 归档缓冲；设备级动作仍设备级（改模糊音 ⇒ 换引擎并**清空每个窗口的在途缓冲**，带计数 `info!`）；每窗口条目**有界**（`MAX_IME_SESSIONS = 64`，先丢弃"没什么可失去"的窗口，只有所有窗口都在打字才逐出 LRU 并 `warn!`）。学习层因此只有一份、profile 只有一处真源 | 见左（已实现）；剩真机观感复核与"跨窗口续用同一条缓冲"（产品决定，非缺陷） | 中 → ✅ |
| **G2** | PWA **预装声明无法启动** | `docs/pwa-index.md` §4 明写：`[display].url` 是远程站点，AmOS「没有打开 URL 的能力」（无 `window.open`、无 opener 插件、无远程 URL webview）；屏幕只呈现声明 | 需要**新能力**：① 宿主侧远程 URL webview（配 `Content-Security-Policy`/域名白名单，与已安装 bundle 同一套 `allowed_domains` 文法）；② 或外部浏览器 intent。二者都是安全决策，不该由画面单方面假装 | 大（新能力 + 安全评审） |
| **G3** | 输入法**不是系统级 IME** | 全仓无 `InputMethodService`/IME APK（grep 为空）；`docs/input-method.md` §Honest boundaries 自述 | 独立 APK（`inputmethodservice.InputMethodService`）+ 与 System UI 共享引擎（AIDL 或复制引擎）；设备侧验收 | 大（新 APK + 真机） |
| **G4** | **联想/下一词**未接线 | ✅ **已收口（REQ-A260 复核 REQ-A259）**：REQ-A259 只把 `bigrams` 数据编了进去（并声称"已完成"），但**联想根本没到用户眼前**——`predict_next_words_context`（真正要用的那个 API）需要 `trigrams`，而那个特性**没开**；候选栏也只在 `composing` 时渲染，提交后什么都不显示。本轮：`amos-ime` 开 `predict = [bigrams, trigrams]`（default on）；域侧 `PinyinInput::predictions()` 走 crate 的 **context（trigram）路径**、需要**两个已提交词**的上下文；宿主在缓冲为空时把建议作为候选（`kind: "predict"`，同一索引空间）返回，`ime_commit` 落在建议分支时插入但**不教学习层**、不留撤销；键盘在 `composing \|\| suggesting` 时渲染候选栏并给联想标签。**实测体积**（两条路一致）：隔离探针 `cargo build --release -p amos-ime --example size_probe` 4,833,200 B → 24,449,456 B；**整个 System UI 二进制**（`cargo clean -p amos-tauri` 后重建两次，只差特性）21,012,144 B → 40,628,464 B ⇒ **+19.6 MB**（两个 FST 文件 18.0 MB；字节探针 0/2 → 2/2 证明数据确实被链接）。开关是 `predict` 特性，瘦身构建 `--no-default-features` 时引擎按契约返回"没有建议" | 见左 | 剩真机/肉眼复核（真机上连续提交两词看建议是否出现且点击插入）；移动端 APK 是否接受 +19.6 MB 属产品决定（开关已就绪） | 中 → ✅（+体积决策） |
| **G5** | 形态策略**只上报不强制** | ✅ **已收口**（REQ-A256 落地主体 + **REQ-A257 复核收口**）：规则只有**一个实现处**——`LayoutPolicy::check_app_window(open) → AppWindowRefusal{form, open}`（领域纯函数），宿主 `WmState::check_new_app_window()` 同时服务生产路径 `open()` 与测试缝 `register_app()`，且**在注册之前**问（被拒的窗口在模型里不留痕）；窗口几何统一走 `LayoutPolicy::fit_window`（`enforce_min` → 按屏幕封顶 → `clamp_into`），**新窗口开在哪**（`initial_window_in`）与**屏幕变小后拉回哪**（`WmState::reclamp_windows`，读平台真实几何、只动需要动的窗口）共用它；建窗 `.resizable(free_resize)` + `.min_inner_size(min_pane)`；分屏落位前 `enforce_min(min_pane)`。两个原先零调用的领域函数都进了生产路径，`layout.rs` 相关函数改为 `const fn`。详见 `docs/G5_POLICY_ENFORCEMENT.md` | 剩**真机观感复核**（把桌面壳拉小、看窗口是否被拉回）+ 一处测试别名（`new_for_test`）待清理；失效模式已进**机读** FMEA inventory（`docs/FMEA.md` §2.2 的 F-WM-014–018，`node scripts/fmea-gen.mjs --check` EXIT 0） | ✅（余为设备/肉眼项） |
| **G6** | 桌面壳层的观感项 | **部分收口（REQ-A261）**：壳 chrome 已按 **容器 ↔ 挂件** 拆分（`lib/shellModule.ts` 契约 + `svelte/shellModules.ts` 注册表 + `svelte/modules/*`），外观收进 `lib/shellChrome.ts` 一处（24px 命中区、hover、**focus-visible 环**、读数 `tabular-nums` + 固定最小宽）；顺带修掉一个真缺陷——顶栏「控制中心」原本是**有名字、能聚焦、点下去什么都不做**的按钮，现为 disabled + 说明性名字。**屏幕外观未变**（顺序/字号/颜色/玻璃面保持）。仍属设备/肉眼项：per-app 菜单模型（`docs/multi-window.md` §6.5）、顶栏玻璃感/Dock 磁吸曲线、桌面状态行去留、多窗口真机 e2e | 逐项肉眼/真机复核（每项现在对应**一个挂件文件**，可独立交付） | 小 |
| **G7** | 原生应用层的后续面 | `docs/desktop-native-apps.md` §4：图标主题解析、PID 生命周期（无法「从 AmOS 关掉它」）、`Path=`/`StartupWMClass`/`Terminal=`、真机验收 | 见该页 | 小-中 |
| **G8** | **macOS 上没有 Android 运行时**（Linux 有 Waydroid，Android 真机走 no-UI 基座；macOS **没有**可用容器：需要 Linux 内核，且无 KVM/LXC） | 本轮起宿主如实上报 `runtime: demo` + 界面横幅（D14）；三种方案见 `docs/android-compat.md` §桌面形态 | 产品决策三选一：① VM 内 Android（新驱动 + VD→纹理像素通路）；② 远程 adb 设备/农场（需网络与信任边界设计）；③ **如实为空**（今天的状态，但必须是"说清的空"） | 大（新能力 ± 安全评审） |

> G5 曾是这一轮**最值得下一轮做**的一条，现已收口（`docs/G5_POLICY_ENFORCEMENT.md` + REQ-A257）；
> **G1**（输入法跨窗口会话）是同一种形状在另一个子系统的翻版——多窗口已落地，而输入法还当自己
> 是单窗口——也已在本轮收口（REQ-A258，`docs/input-method.md`）。
> 下一步优先级最高的是 **G2**（远程站点/PWA 启动能力，需要一次明确的产品/安全决策）、
> **G8**（macOS 上的 Android 运行时，产品决策三选一），以及 **G6/G7** 的逐项真机复核。

---

## 4. 复现（每条结论对应的命令）

```bash
# 门禁：本轮修掉的五个 FAIL（现在都 OK）
node scripts/tauri-command-scan.mjs      # D1/D12 + allow-list 陈旧项
node scripts/tauri-args-scan.mjs         # D11
node scripts/rust-recursion-scan.mjs     # D3
node scripts/rust-discard-scan.mjs       # D9
node scripts/untracked-source-scan.mjs   # D8
node scripts/dangling-source-scan.mjs    # D8

# 输入法缺陷：先写用例、跑给失败看（负控），修完再跑
cargo test -p amos-ime --lib changing_fuzzy_preferences_keeps_the_learned_words
cargo test -p amos-tauri --lib ime::tests::toggling_a_fuzzy_pair_does_not_erase_the_profile_learner

# 原生应用层
cargo test -p amos-tauri --lib desktop_entry::    # 7
cargo test -p amos-tauri --lib wine::             # 6
cargo test -p amos-tauri --lib linux_apps::       # 6
cd crates/amos-tauri/frontend-ts && bun test src/__tests__/nativeApps.test.ts        # 11
cd crates/amos-tauri/frontend-ts && npx vitest run svelte-tests/native-apps.svelte.test.ts  # 4

# 输入法跨窗口会话（REQ-A258）与联想（REQ-A260）
cargo test -p amos-ime                                            # 42
cargo test -p amos-tauri --lib ime::                              # 31（窗口不共享缓冲 / undo 归属 / 联想建议）
cargo test -p amos-tauri --lib ime::two_windows_do_not_share_a_composition_buffer
# 联想的体积（可复现）：同一条命令两次，只差特性
cargo build --release -p amos-ime --example size_probe
cargo build --release -p amos-ime --no-default-features --example size_probe
ls -l target/release/examples/size_probe   # 24,449,456 B vs 4,833,200 B
# 前端
cd crates/amos-tauri/frontend-ts && npx vitest run svelte-tests/ime-keyboard.svelte.test.ts  # 30

# 整仓
cargo test -p amos-tauri --lib            # 332（REQ-A257 收口后为 341：+ REQ-A256 四条宿主用例 + 本轮五条）
cargo clippy -p amos-tauri -p amos-ime --all-targets -- -D warnings
node scripts/fmea-gen.mjs --self-test     # FMEA 机读 inventory 自测
node scripts/fmea-gen.mjs --check         # docs/FMEA.md ↔ inventory ↔ 代码 三方一致（含 F-WM-014..018）
cd crates/amos-tauri/frontend-ts && bun run check   # EXIT=0
```

---

## 5. 一句话总结

**「多窗口没合入主线、输入法没有中文」这两个判断在代码面前不成立**（证据见 §1）；真正的
残缺是**生态位**（远程站点/PWA 启动能力 G2、系统级 IME G3、联想 G4、**桌面形态的 Android 运行时 G8**）
与**策略落地**（形态策略不强制到窗口 G5），外加一批**只在跑门禁时才会现形的真实缺陷**
（§2 的 D1–D14，其中 D2 是信任边界、D10 是用户可感知的数据丢失、**D14 是把内置夹具当成装机应用**）。
本轮把 D1–D14 全部收口并把 G1–G8 **如实登记**——没有把"未做"写成"已做"。

**后续轮次**：G5 已收口（REQ-A256/A257），**G1 也已在 REQ-A258 收口**——它是同一种形状在另一个
子系统上的翻版（多窗口已落地、输入法还当自己是单窗口）：现在是"一个进程级引擎 + 每窗口一条缓冲"，
九条 `ime_*` 带调用窗口、设备级动作（模糊音/清空学习）仍设备级并写明作用域。剩下真正未做的仍是
**生态位**（G2/G3/G4/G8）与**观感/真机复核**（G6/G7）。

