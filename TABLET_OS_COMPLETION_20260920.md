# 平板电脑操作系统功能审计与补全 — 完成报告

**日期**: 2026-09-20
**范围**: `crates/amos-tauri/frontend-ts`（Svelte 壳 + `src/lib` 纯模块）+ `docs/multi-window.md`
**目标**: 按航空航天级标准审计平板（tablet）形态的全部代码路径，补全登记在案的功能缺口，并以**单测 + DOM 组件测试 + 全仓扫描门**验证
**验证方式（用户选定）**: `bun` 单测 + `vitest`/Svelte DOM 组件测试 + 仓扫描门。**未做真机 GUI 验证**（见 §5 边界）

> 说明：本仓工作树同时承载**其他会话**的在途改动（`git status` 里有大量与本轮无关的文件）。本报告只覆盖本轮落地的四处补全与三条审计发现，其余文件不入账。

---

## TL;DR

平板形态此前**已相当完整**：形态判定（`amos-wm::form`）、运行时不变量（同一 `aarch64-linux-android` 构建靠 `LayoutPolicy::columns_for(width)` 分档）、内容密度（`lib/formLayout.ts` 的 `homeGrid`/`appLibraryColumns`/`photosCols`/`pwaHubCols`）、壳内双窗格分屏（`SplitSurface.svelte` + `AppPane.svelte`，REQ-A512）都在。**登记在案的缺口只剩三处**，加上一处**潜伏缺陷**是本轮审计新发现的：

| # | 缺口 | 登记处 | 本轮 |
|---|---|---|---|
| 1 | 内置 app 无侧栏/主从布局 —— `columns` 只是被展示，无行为消费者 | `docs/multi-window.md:79` 边界 ④、`:87` 边界 ② | ✅ 已补（纯模块 + 设置页侧栏） |
| 2 | 分屏布局不跨重启持久化 | `docs/multi-window.md:79` 边界 ③ | ✅ 已补（`lib/splitPersist.ts`） |
| 3 | 平板 Dock 无「最近使用」区（iPadOS 有） | 本轮审计新登记 | ✅ 已补（`dockRecentSlots`/`dockRecents` + `HomeDock`） |
| 4 | **潜伏缺陷**：形态信号有**两份**真源，且 `$derived(currentFormFactor())` **不响应**形态推送 | 本轮审计新发现 | ✅ 已补（`lib/formAuthority.svelte.ts` 单一真源） |

### 验收

| 项 | 结果 |
|---|---|
| `bun run typecheck:svelte` | ✅ **1386 files / 0 errors / 0 warnings** |
| `bun run test`（bun-iso 全量：纯逻辑批 + 逐文件 DOM 隔离） | ✅ **OK** |
| `bun run teststrict`（vitest Svelte 组件套件） | ✅ **123 files / 1449 tests passed** |
| `node scripts/unwired-scan.mjs` | ✅ **0 finding** |
| `node scripts/i18n-scan.mjs` | ✅ **0 finding**（2390 keys, en/zh parity, 无硬编码文案） |
| `node scripts/store-scan.mjs` | ✅ **OK**（116 keys，`amos.split` 已分类） |
| `node scripts/write-scan.mjs` | ✅ **OK**（141 writes） |
| `node scripts/lifetime-scan.mjs` | ✅ **OK**（48 interval / 63 subscription / 全局监听） |
| `node scripts/react-free-scan.mjs` | ✅ **OK**（0 `.tsx`，33 loader 全 `.svelte`） |
| `node scripts/hover-scan.mjs` | ✅ **OK** |
| `cargo test -p amos-wm`（几何权威，未改动，回归确认） | ✅ **70 lib + 2 集成 passed** |

---

## 1. 审计起点：读出来的真实状态

`docs/multi-window.md` §REQ-A512 那条**主动写下**了四道诚实边界。逐条核对代码后的结论：

| 边界 | 原文 | 实测 |
|---|---|---|
| ① 两套承载只共用几何规则 | 原生分屏控件仅桌面可用 | ✅ 成立（设置页按 `multi_window` 出闸） |
| ② 拖拽分隔条每 rAF 一次宿主往返 | 真机延迟未实测 | ✅ 成立（仍未实测，见 §5） |
| ③ **分屏不跨重启持久化** | —— | ❌ **缺口** ⇒ §2.2 已补 |
| ④ **`columns` 无行为消费者** | 只被「窗口与形态」页展示 | ❌ **缺口** ⇒ §2.1 已补 |
| （`:87` ②）**未做 iPad 式侧栏** | 壳层没有 per-app 导航模型 | ❌ **部分缺口** ⇒ §2.1 已补（设置页有导航模型） |

审计同时发现一个**文档没写、代码里真实存在**的缺陷（§2.4）：形态信号有两份真源，且其中一份在 Svelte 里是**非响应**的。

---

## 2. 本轮五项变更

### 2.1 可复用的主从布局纯模块 + 设置页 iPad 式侧栏（缺口 1）

**起点**：`columns` 此前只被「窗口与形态」页**如实展示**，没有任何**行为**消费者（`docs/multi-window.md:79` 边界 ④）；`:87` 边界 ② 明确记着「本轮**没有做** iPad 式**侧栏**：壳层没有 per-app 导航模型，编一个假目录比不做更糟」。

**做法（两步，避免"编一个假目录"）**：
1. **先建纯决策**（不含任何目录）：`lib/formLayout.ts::masterDetail(form, columns, width) -> { sidebar, sidebarWidth }`。它同时消费**类别**与宿主的**实测** `columns`——`columns >= 2` 是**与 `canSplit` 同一个**闸门；再加一道测宽阈值（`TABLET_SIDEBAR_MIN_WIDTH = 700`），保证「有侧栏时详情列永远 ≥ 手机自己的 `min_pane` 360 px」——即侧栏**不可能让内容比没有侧栏更差**（iPadOS 在窄 Split View 里收折侧栏是同一条理由）。宽度是实测屏宽的**有界分数**（32 %，夹在 `[260, 360]`），不是第二套布局引擎。
2. **再由"本身就有导航模型"的 app 采纳**：`SettingsApp.svelte`（iPadOS 设置式 master-detail）。未选型态 / `columns < 2` / 窄平板 / 未测量屏**保持字节级不变的手机分组列表 + push 页**；侧栏行有 `aria-current`，搜索复用**同一批** canonical 行（label + subtitle + `EXTRA` 同义词），选行后详情列滚动复位。

**未做的（如实）**：其余内置 app **仍未**采纳主从布局——纯模块已就位，但「给每个 app 编一套目录」依然是不做的决定（`docs/multi-window.md:87` 边界 ② 已就地订正为"部分关闭"）。

**文件**：`src/lib/formLayout.ts`（`masterDetail` + 3 常量 + 1 分数常量）· `src/svelte/SettingsApp.svelte`（`searchField`/`pageBody` snippet 抽取 + `{#if wide}` 侧栏分支）· `src/i18n/locales/{zh,en}.ts`（`settings.sidebarPlaceholder`）· `src/__tests__/formLayout.test.ts` · `svelte-tests/settings-sidebar.svelte.test.ts`（新）

### 2.2 分屏布局跨重启持久化（缺口 2）

**起点**：`docs/multi-window.md:79` 边界 ③「分屏布局**不跨重启持久化**」——平板在分屏上被关掉，再开就回到一张白首页。

**做法**：
* **纯解码层** `lib/splitPersist.ts`：`parseSplit(raw, available)` 是**诚实边界**所在——任一门窗 app 已不在装（或值被手改成不存在的 id / 自成一格 / 非对象）就返回 `null`，**绝不给一个半意图**；轴向未知/缺失回退 `auto`（交给宿主按真实宽高比选），比例缺失/越界夹到 `[1, 99]`（`clampSplitPercent` 是**唯一**的夹取处，`enterSplit`/`setSplitPercent` 都走它）。`encodeSplit` 让**写入路径**也过同一道夹取。
* **写入落在结算点，不落在每一帧**：进入分屏 / 换二次窗格 / 退出**立刻**写（退出是 `removeStoreValue`，未写完的合并写被取消 ⇒ 关掉的分屏不可能"复活"）；拖拽中的比例按 **250 ms 合并**——一次拖拽不是每秒六十次 `store_set`（每次都是 Rust 镜像往返）。
* **恢复一次**：`shellState.restoreSplit()` 由 `Shell.svelte` 在宿主报出**实测屏幕后**调用（`columns` 闸门需要它）。拒绝条件全部在 `restoreSplit` 内，调用方无需判断：表面不是"未经触碰的首页"（锁屏/深链已路由）、类别是 `desktop`（其 app 是真 OS 窗口，壳内分屏从不提供——`Shell.splitAvailable` 同一条排除）、屏幕放不下两个窗格、任一门窗 app 不在装、值畸形 ⇒ 一律 `false` 并**保持首页**。

**文件**：`src/lib/splitPersist.ts`（新）· `src/svelte/shellState.svelte.ts`（`enterSplit`/`exitSplit`/`setSplitPercent`/`open` 的换窗格分支 + `restoreSplit`）· `src/svelte/Shell.svelte`（boot 恢复）· `scripts/store-allowlist.json`（`amos.split` 分类为 configuration）· `src/__tests__/splitPersist.test.ts` · `svelte-tests/shell-state.svelte.test.ts`

### 2.3 平板 Dock 的「最近使用」区（缺口 3）

**起点（本轮审计新登记）**：iPadOS 的 Dock 在固定 app 之后、经一条分隔线，最多显示 **3 个最近用过的 app**——Dock 因此兼作"快捷切换器"，刚离开的 app 一按即回。本仓的 `HomeDock.svelte` 只渲染 `layout.dock`，**没有**这一段；平板上刚用过的 app 只能靠底部边缘上滑（Recents 面板）去找。

**做法**：纯决策继续留在 `lib/formLayout.ts`（与 `homeGrid`/`appLibraryColumns` 同族）：
* `dockRecentSlots(form)`：**仅平板 3**；手机/机器人 0（iPhone 的 Dock 无此段，其切换器是独立 Recents 表面）；**桌面也刻意 0**——桌面类由 `DesktopShell.svelte` + `lib/desktopLayout.ts` 自己的 Dock 渲染、从不挂载本启动器，答 3 会是一段**没有生产路径渲染的策略**（`docs/multi-window.md` / REQ-A250 已登记的"同类别两套真源"边界）。
* `dockRecents(recents, pinned, slots)`：不重复已固定的 app（腾出的名额让下一个最近项补上）、去重取最早出现（即最近）、按 `slots` 截断；**不**再过滤可用性——Recents 存储本就只存内置 id（`shellState.open` 只对 `appTitleKey` 命中的记录 recent），在此再造一道可用性检查就是"同一个决定住在第三个地方"。
* 载荷缺 `form` ⇒ 按手机 ⇒ 0 槽 ⇒ **今天的 Dock 一字不变**（"缺失载荷不获得新能力"）。

**文件**：`src/lib/formLayout.ts` · `src/svelte/HomeDock.svelte`（`form` 载荷 + recents 订阅 + 分隔线/区段渲染）· `src/svelte/Shell.svelte`（home 通道推 `form: shellForm`）· `src/__tests__/formLayout.test.ts` · `svelte-tests/home-dock.svelte.test.ts`

### 2.4 形态信号收敛为单一真源（缺口 4 —— 本轮审计新发现的潜伏缺陷）

**缺陷（代码里真实存在、文档未记）**：形态信号有**两份**真源——`lib/desktopApps.ts` 的手写 store 快照（应用注册表读它）与 `Shell.svelte` 直接调 `setFormFactor`。更要命的是后者：`PhotosApp`/`PwaHubApp` 里写的是

```ts
const form = $derived(currentFormFactor());   // ← 手动 subscribe 的快照
```

**手动订阅的快照读进 `$derived` 不注册响应依赖**：它算一次就**永久停在**首次读到的值。于是宿主**旋转/改窗**推送新类别时，照片网格、PWA 索引的列数**不会**重算——一个需要重新挂载才"看起来对"的缺陷（本仓 `lib/formLayout.ts` 头部注释里"一个组件从它派生的值必须真的重新派生"说的正是这件事）。

**修法**：新建 `lib/formAuthority.svelte.ts`（模块级 `$state` rune），删除 `desktopApps.ts`；**写入者收窄为两个**：`setFormFactor`（测试/预览/壳的 boot）与 `shellState.setLayoutSnapshot`（生产路径——存快照的同一步重新声明它的 `form`，所以"类别"**不可能**与"带来它的那块实测屏"不一致，`Shell.svelte` 因此**不再**需要第二处 `setFormFactor` 调用，也就没有"新增推送点时忘记同步"的空间）。`resetShellState` 经 `setLayoutSnapshot(null)` 清回诚实的"尚无宿主作答"态。

**文件**：`src/lib/formAuthority.svelte.ts`（新）· `src/lib/desktopApps.ts`（删）· `src/svelte/{Shell,PhotosApp,PwaHubApp}.svelte` · `src/svelte/appRegistry.ts` · `src/svelte/shellState.svelte.ts` · `svelte-tests/formAuthority.svelte.test.ts`（新，取代 `src/__tests__/desktopApps.test.ts`）

> 注意测试**位置**：`formAuthority.svelte.ts` 是不可被 bun 批处理的 rune 模块（bun 无 rune 编译器，实测报 `ReferenceError: Can't find variable: $state`），其单测因此归入 `svelte-tests/`（vitest + vite-plugin-svelte），而不是 `src/__tests__/`。这是本轮踩到并纠正的一个真实错误。

---

## 3. 审计发现登记

| # | 缺陷 | 状态 |
|---|---|---|
| D-1 | `$derived(currentFormFactor())` 读手动订阅快照 ⇒ **不响应**形态推送（照片/PWA 列数在旋转后不重算） | ✅ 已修（§2.4） |
| D-2 | 形态信号两份真源（`desktopApps.ts` store + `Shell.svelte` 直调），可静默不一致 | ✅ 已修（单一真源 + 单一生产写入者） |
| D-3 | `Shell.svelte` 在 boot 与每次推送各多写一次 `setFormFactor`，与 `setLayoutSnapshot` 重复（新增推送点易漏） | ✅ 已修（收进 `setLayoutSnapshot`） |
| D-4 | `lib/splitPersist.ts::encodeSplit` 首版**定义但未接线**（`unwired:scan` 红） | ✅ 已修（接线为写入路径的夹取） |
| D-5 | `svelte-tests/*` 的 `setFormFactor` 导入在 `desktopApps.ts` 删除后**悬空** | ✅ 已修（指向 `formAuthority.svelte`） |
| **D-6** | **`WebManApp.svelte:113` 用 `window.innerWidth >= 768` 判定"桌面模式"** —— 这正是 `lib/formLayout.ts` 头部明令禁止的"从视口猜类别"：平板横屏（1200 px）会拿到桌面态浏览器 chrome，而宿主的类别说 tablet | ✅ **已修（第二轮 REQ-A554，见 §7）** |
| **D-7** | **原登记为"`docs/TRACEABILITY_MATRIX.md` 落后于 `CHANGELOG.md`"——此前提经核验为不实**（详见 §7）：A547 无任何条目、A550 不在 CHANGELOG、矩阵本身是 `REQ-A372` 明文声明的"部分索引"（`trace-scan` 把缺行判为 informational 而非失败） | ✅ **已核验收口（第二轮 REQ-A554，见 §7）**；另**新登记**两处真实台账缺陷（幻影 id A547/A548、REQ-A544 双占用） |

**D-6 为何当时不改**：一个浏览器 app 的"桌面模式工具栏"可以是**响应式 Web UI** 的合法行为（与设备类别无关），也可以是"照类别走"。这需要**产品决定**而非机械修改——贸然改成 `currentFormFactor()` 会让"桌面形态下把窗口缩窄"不再切换浏览器 chrome，那是另一种回归。故第一轮只登记；**第二轮（REQ-A554）**裁决为"照类别走"（`formLayout.ts` 规则 1 是明文的），改由纯函数 `webManInline(form)` 决定，见 §7。**注**：原登记写"平板横屏（1200 px）会拿到桌面态……而宿主的类别说 tablet"——方向写反了：旧阈值是"宽即桌面"，平板横屏（≥768）**恰好**走内联（与 tablet 应有的行为一致）；真正错的是**窄视口的平板**与**被缩窄的 Mac 窗口**会拿到 punt 卡片。

**D-7 为何不当"补行"处理**：`docs/TRACEABILITY_MATRIX.md` 头部（`REQ-A372`）明文写着它**是部分索引、不是全部编号的花名册**，且"凭编号回填一条我没做过的记录，比缺一行更坏"。故正确处置**不是**补记，而是**核验那 5 条编号的真实状态**并订正本节自身的断言——见 §7。

---

## 4. 测试与门禁证据（实测）

### 4.1 新增/扩展的测试

| 文件 | 数量 | 钉住的性质 |
|---|---|---|
| `src/__tests__/formLayout.test.ts` | **48**（+14） | `masterDetail` 8 条（仅平板 / `columns<2` / 窄屏 / 未测量 / 宽度有界 / 详情列永不窄于手机 `min_pane` / `sidebarWidth===0 ⟺ !sidebar` / 纯性）+ `dockRecentSlots` 3 条 + `dockRecents` 6 条 |
| `src/__tests__/splitPersist.test.ts`（新） | **13** | 夹取（1..=99、非有限 ⇒ 50、整数）+ 解码（门 app 缺失 ⇒ **整体拒绝**、非对象/缺 id/自成一格 ⇒ 拒绝、未知轴 ⇒ `auto`、越界比例 ⇒ 夹取、空可用集 ⇒ 拒绝）+ `encodeSplit` 往返 + 键名 |
| `svelte-tests/shell-state.svelte.test.ts` | **25**（+11） | 进入/换窗格**即刻**落盘、退出**清除**、拖拽比例**合并后落一次**、退出**取消**待写、恢复成功、门 app 缺失/手机/桌面/已路由 **四种拒绝**、畸形值逐一拒绝、缺轴向比例以保守默认恢复、`resetShellState` 丢弃待写与存量 |
| `svelte-tests/settings-sidebar.svelte.test.ts`（新） | **8** | 手机无侧栏（含无宿主保守路径）、`columns<2`/窄平板无侧栏、实测平板出侧栏+详情+占位、选行渲染详情并标 `aria-current`、搜索过滤**同一批** canonical 行（用 `background` 这一**同义词**而非可见标签取证）、宿主**重新测量**时 phone⇄tablet **不重挂载**地翻转 |
| `svelte-tests/home-dock.svelte.test.ts` | **19**（+4） | 平板出最近区+分隔线 / 手机**两者皆无**、载荷缺类别 ⇒ 手机 Dock、已固定的 app **不重复**、点最近瓦片走**同一条** `open` 上行通道 |
| `svelte-tests/formAuthority.svelte.test.ts`（新） | **7** | 无宿主 ⇒ 非桌面；四类别逐一判定；`currentFormFactor()` 未作答返回 `null`（**保守**）|

### 4.2 全量套件

```
bun run typecheck:svelte  →  COMPLETED 1386 FILES 0 ERRORS 0 WARNINGS
bun run test              →  [bun-iso] test OK        （纯逻辑批 + 逐文件 DOM 隔离）
bun run teststrict        →  Test Files 123 passed (123) / Tests 1449 passed (1449)
cargo test -p amos-wm     →  70 passed + 2 passed（几何权威未改，仅回归确认）
```

### 4.3 扫描门

```
unwired-scan   OK — 无不可达 src/lib 模块未入账（5 条带理由）、无未挂载生产组件未入账（6 条）
i18n-scan      OK — 2390 keys、en/zh 键集与 {param} 一致、无死键、无硬编码文案、交互元素均有可读名
store-scan     OK — 116 keys / 24 SYNC / 92 分类（7 类）；amos.split 归 configuration
write-scan     OK — 141 writes：60 verified / 13 classified / 68 non-content
lifetime-scan  OK — 48 interval 各自清理、63 组件订阅有生命周期、全局监听有移除
react-free     OK — 0 .tsx、无 react 依赖、33 loader 全 .svelte
hover-scan     OK — hover 仅作用于可悬停指针
```

---

## 5. 诚实边界（本轮**没有**做到的）

1. **未做真机 GUI 验证**（用户已明确选择单测 + DOM 组件测试）。因此：分屏拖拽的**实际延迟**、分隔条在真实手指下的手感、侧栏在真机滚动中的表现**均未实测**——`docs/multi-window.md:79` 边界 ②「真机延迟未实测」因此**仍然成立**（本轮未关闭它）。
2. **仅设置页采纳主从布局**。其余内置 app（邮件/备忘录/文件…）**未**接入；纯模块已可复用，但"每个 app 一套目录"仍未做。模块化设计使后续接入是"采纳",不是"重写"。
3. **桌面 Dock 的最近区未接**（`dockRecentSlots("desktop") === 0`）。macOS 的 Dock 确实有这一段，但桌面 Dock 归 `DesktopShell`/`desktopLayout.ts`，在那边落地需要一次**同类别两套真源**的收敛（REQ-A250 已登记）——本轮不把新策略写进没有生产路径的地方。
4. **第三方（store）app 不能作为分屏窗格恢复**：`parseSplit` 的可用集是内置 id（`appIds()`）。一个 store app 在两次运行之间可能被卸载，因此**不予恢复**是刻意的诚实边界，不是遗漏。
5. **`amos.split` 未列入云端备份的 SYNC_STORES**，归 `configuration`（与 `amos.home.layout` 同类：UI 状态，丢失的代价是一次重设，不是内容）。
6. **D-6（WebMan 视口判桌面）与 D-7（矩阵落后 5 条）在第一轮已登记未改**——理由见 §3；**两者均在第二轮（REQ-A554）收口**，见 §7。
7. **未改任何 Rust 代码**：几何权威 `amos_wm::layout::split_panes` / `LayoutPolicy` 一字未动；`cargo test -p amos-wm` 仅作回归确认。
8. **工作树含其他会话的在途改动**，本轮变更清单只含 §2 列出的文件；全量测试/门禁是在**整棵工作树**上跑的，因此其绿灯也覆盖了那些在途改动（若它们引入缺陷，本报告不会把它归给本轮）。

---

## 6. 本轮变更文件清单

**生产代码**

* `src/lib/formLayout.ts` — `masterDetail` + `TABLET_SIDEBAR_*` + `dockRecentSlots` + `dockRecents` + 头部边界订正
* `src/lib/formAuthority.svelte.ts` — **新增**（形态信号单一真源，rune）
* `src/lib/splitPersist.ts` — **新增**（分屏意图纯解码层）
* `src/lib/desktopApps.ts` — **删除**（并入 formAuthority）
* `src/svelte/shellState.svelte.ts` — 分屏持久化 + `restoreSplit` + `layoutSnap()` + 形态写入收敛
* `src/svelte/SettingsApp.svelte` — iPad 式侧栏（snippet 抽取 + `{#if wide}` 分支）
* `src/svelte/HomeDock.svelte` — Dock 最近区 + `form` 载荷
* `src/svelte/Shell.svelte` — boot 恢复分屏、推送 `form`、去掉重复的形态写入
* `src/svelte/{PhotosApp,PwaHubApp}.svelte`、`src/svelte/appRegistry.ts` — 改读单一真源
* `src/i18n/locales/{zh,en}.ts` — `settings.sidebarPlaceholder`

**配置**：`scripts/store-allowlist.json`（`amos.split`）

**文档**：`docs/multi-window.md`（边界 ③ 订正为已持久化、边界 ④ 订正为已有两个行为消费者、`:87` ② 订正为部分关闭）· `CHANGELOG.md`（REQ-A552）· `docs/TRACEABILITY_MATRIX.md`（REQ-A552）

**测试**：`src/__tests__/formLayout.test.ts` · `src/__tests__/splitPersist.test.ts`（新）· `svelte-tests/settings-sidebar.svelte.test.ts`（新）· `svelte-tests/formAuthority.svelte.test.ts`（新）· `svelte-tests/shell-state.svelte.test.ts` · `svelte-tests/home-dock.svelte.test.ts` · `src/__tests__/desktopApps.test.ts`（删）

---

## 7. 第二轮收口（REQ-A554，2026-09-20）

第一轮在 §3 登记了 D-6 / D-7 两处"已登记、未改"的缺口。本轮（用户选定"收口已登记缺口"）把它们收掉——其中 D-7 的**前提本身经核验为不实**，是本轮最值钱的发现。

### 7.1 D-6 已修：浏览器的内联判定改由宿主的类别决定

`WebManApp.svelte` 原来用一个 `$effect` + `resize` 监听，按 `window.innerWidth >= 768` 在"内联 iframe"与"用浏览器打开"卡片之间二选一——**这正是 `lib/formLayout.ts` 规则 1 明令禁止的"从视口猜类别"**。

**修法**：新增纯函数 `lib/formLayout.ts::webManInline(form)`（与 `photosCols`/`pwaHubCols` 同族）：大屏类别（`desktop` / `tablet`）内联，`phone` / `robot` 保留 punt 卡片；`WebManApp` 改为 `const inline = $derived(webManInline(currentFormFactor() ?? "phone"))`，**整段 `$effect` + `resize` 监听删除**。`currentFormFactor()` 的 `null`（宿主未作答）经 `?? "phone"` 落到保守态，与 `dockRecents` 的"缺失载荷不获得新能力"同一条纪律。

**行为变更（如实）**：①窄视口的平板（如平板竖屏 < 768 px 的场景）从 punt 变内联；②桌面形态下被缩窄到 < 768 px 的应用窗口从 punt 变内联（与"类别来自宿主、与窗口多宽无关"一致）；③**手机类别即使视口 ≥ 768 px 也不再被误判为桌面**（旧代码会被宽视口骗走）；④未测量类别（`null`）保持今日的 punt 卡片。

**第一轮登记里方向写反了一处**（已就地订正）：原文举例"平板横屏（1200 px）会拿到桌面态浏览器 chrome"，但 1200 ≥ 768 **恰好**也走内联分支——旧阈值真正的错处是**窄视口**那侧，不是宽视口那侧。

### 7.2 D-7 已收口：核验后发现前提不实，且**不应**补矩阵行

D-7 原文断言"`REQ-A545/546/547/548/550` 在 CHANGELOG 有条目、矩阵无行"。逐条核验（`grep` + `trace-scan.mjs`）后：

| 编号 | 实测状态 | 原断言 |
|---|---|---|
| A545 | ✅ 有 CHANGELOG 正文条目（"八个核心缺口" ②，AI Backend Unconfigured）；矩阵无行 | 成立 |
| A546 | ✅ 有正文条目（③，`host_fs.rs` 借用修复）；矩阵无行 | 成立 |
| **A547** | ❌ **全仓零命中** —— 连 CHANGELOG 都没有 | **不实** |
| A548 | ⚠️ 仅出现在该条目的**标题区间** `REQ-A544 → REQ-A548`，**正文无对应项** | 不实（幻影） |
| **A550** | ❌ **不在 CHANGELOG**，存在于 `docs/rust-unwired-audit.md`（一次 baseline 复测） | **不实** |

**关键**：`docs/TRACEABILITY_MATRIX.md` 头部（`REQ-A372`）明文声明它是**部分索引、不是花名册**，并写着"凭编号回填一条我没做过的记录，比缺一行更坏"；`node scripts/trace-scan.mjs` 也把缺行判为 **informational**（输出 77 条 informational，**判据本身 OK**）。因此正确的处置**不是补记 5 行**（那会把 3 条我未取证的记录写成"已验证"），而是**订正 D-7 自身的断言**——它属于本仓反复出现的同一族缺陷：**一个登记项断言了它从未测量的性质**。

### 7.3 顺带登记的两处**真实**台账缺陷（未改，仅登记）

* **幻影 id**：CHANGELOG 条目 `REQ-A544 → REQ-A548` 的标题声明了 5 个编号，正文只填到 `REQ-A546`——`A547` 全仓零命中、`A548` 仅存在于标题。区间标题**多报了两个编号**。
* **`REQ-A544` 双占用**：`REQ-A544` 同时被两个不同轮次使用——"八个核心缺口"条目的 ①（Telephony InCallService 录音，见 `docs/FMEA.md` 的 `F-DEV-087`）与 "`ExactAlarmClock` 文档订正"条目（矩阵行 719）。矩阵只收其一行。这是并发会话各自取号导致的碰撞（同 `REQ-A542/543` 的形态）。**本轮不重编号**（FMEA 与矩阵都按 `REQ-A544` 引用，改号会波及未验证的引用），只如实登记。

### 7.4 本轮验证

`bun run typecheck:svelte` ⇒ **1386 files / 0 errors / 0 warnings**；`bun test src/__tests__/formLayout.test.ts` ⇒ **50 pass / 0 fail**（+2）；`bunx vitest run svelte-tests/webman-iframe-posture.svelte.test.ts` ⇒ **6 pass / 0 fail**（+3）；`bun run test`（bun-iso 全量）**OK**；`bun run teststrict` ⇒ **124 files / 1456 tests passed**；七道前端扫描门 + `trace-scan` 全绿。**负控（实测，非预期）**：把 `WebManApp` 的 `inline` 派生逐字节还原为旧表达式 `$derived(window.innerWidth >= 768)` ⇒ `webman-iframe-posture.svelte.test.ts` **恰好 3 红 / 3 绿** —— 红的**全部**是本轮新增的三条 REQ-A554 用例（平板+320 px、手机+1200 px、宿主 `null`+1200 px），三条既有用例仍绿；`cp` 逐字节还原 + `sha256 516d93a7…` + `diff -q` 校验一致后 6/6 复绿。

## 8. 第三轮：Rust 模块审计（`amos-identity`，REQ-A561，2026-09-20）

按用户选定的「Rust 模块审计轮」方向，挑中了 `crates/amos-identity` —— 它是本仓**零 FMEA 条目**的四个最少被审表面之一，且经核验是**纯 DID/Web3 域核、无任何消费者**（`grep` 全 `crates/` 排除自身后零命中）。方法：逐行「文档/类型 vs 代码」比对。

### 8.1 三处发现与修法

| # | 发现 | 形状 | 修法 |
|---|------|------|------|
| F-1 | **KDF 强度按错误曲线设置** | `DEFAULT_PBKDF2_ROUNDS = 210_000`，注释写「OWASP guidance for **PBKDF2-HMAC-SHA256**」—— `210 000` 是 OWASP 的 **SHA-512** 数字，SHA256 是 **600 000** ⇒ seal 默认强度只有建议值的 **35%**，宣称的强度从未达到 | 改为 **600 000** + 订正注释 + 新用例 `default_rounds_meet_owasp_pbkdf2_sha256_floor`（`const { assert!(..) }` ⇒ **编译期**不变量） |
| F-2 | **一个从不被构造的错误变体（死码）** | `Error::InvalidSeed` 全 crate 零构造——无效 secp 种子经 `?` 的 `From<amos_web3::error::Error>` impl 塌缩成不透明的 `Error::Web3(String)`，调用方无法匹配「种子非法」 | `IdentityKey::from_seed` 的 secp 分支显式匹配 `InvalidSecret → InvalidSeed`，其余仍走 `Error::Web3`；新用例 `invalid_secp_seed_is_invalid_seed_not_web3` |
| F-3 | **文档断言一个从未被测量的量** | `docs/identity-web3.md` 写「41 unit tests + doctests」，实测 **45 单测 + 2 doctest** | 更正计数 + 补 Audit notes 一节 |

### 8.2 为什么这三条算「真缺陷」而非整洁度

* **F-1 是安全参数静默打折**：常量名与注释共同断言「已按 OWASP 设置」，而实际强度只有建议值的 35%——一次离线暴力破解的成本被低估约 2.9 倍。这是本仓 F-SH-001 族的同形（**断言了一个代码从未建立的性质**）。
* **F-2 是可判别性丢失**：一个专为「让调用方能区分错误」而生的变体成了永不触发的死码，调用方被迫**匹配字符串**，字符串一变就静默失配。
* **F-3 与 F-DEV-031 族同形**（文档断言了代码从未被测量的性质）。

### 8.3 验证与负控（实测）

`cargo test -p amos-web3 -p amos-identity` ⇒ **18（identity）+ 27（web3）单测 / 2 doctest** 全绿；`cargo clippy -p amos-identity --all-targets -- -D warnings` **0 警告**；`cargo fmt --check` **净**；`node scripts/fmea-gen.mjs --check` ⇒ **258 条**（+1，`F-SH-073`）；`node scripts/rust-unwired-scan.mjs` ⇒ **23 baseline / 0 new**；`node scripts/trace-scan.mjs` ⇒ 退出 **0**。

**负控（实测，非预期）**：把 `DEFAULT_PBKDF2_ROUNDS` 还原为 `210_000` ⇒ 新用例的 `const { assert!(..) }` 在**编译期**即 `error[E0080]: evaluation panicked: assertion failed: DEFAULT_PBKDF2_ROUNDS >= 600_000`（比运行期失败更强）。把 `InvalidSecret → InvalidSeed` 映射改回 `Web3(..)` ⇒ `invalid_secp_seed_is_invalid_seed_not_web3` **恰好 1 红 / 17 绿**。随后 `cp` 逐字节还原并以 `diff -q` 校验，18 绿复现。

### 8.4 诚实边界

1. **改默认轮数不破坏历史数据**：`rounds` 是**每次调用的参数**、不烘进 at-rest 线格式（未改 `FORMAT_MAGIC`，未改 `seal`/`from_sealed` 签名），已用显式轮数封装的历史 blob 照常打开。
2. **未给 Ed25519 加种子校验**：任意 32 字节都是合法 Ed25519 种子，这是 `ed25519-dalek` 的契约，**不是**缺陷。
3. **未给 `IdentityKey` 加 `Debug`**（仅为测试方便，非本轮目标）。
4. **「600k」不是密码学证明**：它是文档承诺的 OWASP 值，以常量断言钉住防回归，而非对 KDF 下界的证明。
5. **该核仍无任何消费者**：本轮只让**已有**调用路径的错误可判别，未新增接线或 UI；rounds 的改动对全 workspace 无影响（已 `grep` 证实无引用）。
6. **并发取号**：会话期间 A555–A560 均被并发轮次占用，逐条重探 id 空间后取 **A561 / F-SH-073**。

## 9. 第四轮：Rust 模块审计（`amos-applife` / `amos-ai::governor`，REQ-A579，2026-09-20）

沿同一「Rust 模块审计轮」方法，目标为 `crates/amos-applife` —— 本仓**零 FMEA 条目**的纯生命周期域核（无 I/O、无时钟、`std` only），及其在宿主侧的接缝 `crates/amos-ai/src/governor.rs` 的 `move_app`。方法同前：逐行「文档/类型 vs 代码」比对。

### 9.1 两处发现与修法

| # | 发现 | 形状 | 修法 |
|---|------|------|------|
| F-1 | **README 断言不存在的符号** | `crates/amos-applife/README.md` 写 reclaim「按 `reclaim_rank` 排序」—— 该符号**全 crate 不存在**（真名 `AppState::rank`），且回收不是「按 rank 打分」而是**两段键排序**（rank DESC + seq ASC）；又写递归由「`now` 参数」推入，而该 crate **根本没有时钟**（递归来自每次迁移自增的单调 `counter`）；示例行说演示 "foreground"（实为 foreground→background→cached + 有界 `budget` 的排序方案）；对 `docs/app-lifecycle.md` 的链接概括为 "thresholds"（该文档写的是**回收顺序**、无阈值） | README 四处订正为**实测事实**，`reclaim_rank` → `AppState::rank`、删去 `now` 暗示、示例行与链接概述改准 |
| F-2 | **错误分类撒谎且随目标漂移** | `ResourceGovernor::move_app` 对不可设的 `AppState::Visible` 返回 `InvalidTransition { from: "." }` —— `"."` 是**编造的哨兵**、不是进程真实当前态；且它对**从未注册**的 id 也返回 `InvalidTransition`，而其余**每一个**目标对未注册 id 都返回 `Unknown` ⇒ 同一事实因目标不同报成两种错 | `S::Visible` 分支先查真实状态：`Err(e) => Err(e)`（未注册 ⇒ `Unknown`，与其余目标一致）；`Ok(from) => InvalidTransition { from: from.key(), .. }`（`from` 用**真实**当前态）+ 2 条单测 |

### 9.2 为什么这两条算「真缺陷」而非整洁度

* **F-1 是文档指向一份不存在的产物**：维护者按 README 找 `reclaim_rank` 会落空，并误以为回收是「按 rank 打分」而非「两段键排序」——改排序键时会以为只需改「那个函数」。与 F-SH-072 族同形（文档指向不存在的索引/符号）。
* **F-2 让调用方按 `from` 分支时拿到假值**：`"."` 使「当前处于什么状态」的判别静默走错分支，而 `Unknown`（「没有这个 id」）与 `InvalidTransition`（「有这个 id、但迁移不合法」）的语义区分在 `Visible` 这一支被抹平，且抹平方式**与其余每个目标不一致**。

### 9.3 验证与负控（实测）

`cargo test -p amos-ai --lib governor::` ⇒ **14 passed**（+2）；`cargo test -p amos-ai --test lmk_reverse_drive` ⇒ **3 passed**、`--test governor_rpc_e2e` ⇒ **1 passed**；`cargo test -p amos-applife` ⇒ **9 lib + 3 集成** 全绿；`cargo clippy -p amos-ai --lib -- -D warnings` **0 警告**、`cargo fmt -p amos-ai -- --check` **净**；`node scripts/fmea-gen.mjs --check` ⇒ **278 条**（+1，`F-SH-074`）；`node scripts/rust-unwired-scan.mjs` ⇒ **23 baseline / 0 new**；`node scripts/trace-scan.mjs` ⇒ 退出 **0**。

**负控（实测，非预期）**：(a) 把 `S::Visible` 分支还原成 `from: ".".to_string()` ⇒ `move_app_visible_names_the_real_source_state` **恰好 1 红**（`left: from:"." / right: from:"background"`）；(b) 把 `Err(e) => Err(e)` 改回编造的 `InvalidTransition` ⇒ `move_app_visible_for_an_unknown_app_is_unknown` **恰好 1 红**（`left: InvalidTransition / right: Unknown("ghost")`）。两次均以 `/tmp/governor.bak` `cp` 逐字节还原、`diff -q` 校验后全绿复现。

### 9.4 诚实边界

1. **`AppState::Visible` 在宿主侧不可达是故意的**：它由 surface 可见性派生，`governor_service` 将其映射成 `ProtoState::Unspecified`；**未**新增 `go_visible`、**未**改这一设计 —— 既有的 `lmk_reverse_drive::a_container_tier_the_host_cannot_represent_is_reported` 正是钉住它的用例，本轮只修**错误分类**。
2. **`LifecycleError::InvalidTransition` 不是死变体**：全 workspace `grep` 确认 `governor.rs` 构造它，删它会破坏构建。教训：判定死变体前必须**全仓**（而非单 crate）grep。
3. **两处回收策略确有重复，本轮只登记不修**：`AppLifecycle::reclaim_candidates`（类型化、LRU、`AppState::rank` 两段键）与 `amos-devocare::boost::reclaim_plan`/`reclaim_rank`（按字符串键、稳定输入序）语义并不等价，合并会改掉后者依赖的稳定排序——超出本轮范围，登记为后续议题。
4. **未改 `manager.rs`/`spec.rs` 的生产逻辑**：本轮仅改文档与 `move_app` 的一个分支。
5. **并发取号**：会话期间 A562–A578 已被并发轮次占用（a11y 轮等），逐条重探 id 空间后取 **A579 / F-SH-074**。

## 10. 第五轮：Rust 模块审计（`amos-network-guard` / `amos-ai::netguard_service`，REQ-A580，2026-09-20）

同一「Rust 模块审计轮」方法，目标为 `crates/amos-network-guard`（零 FMEA 的安全面）+ 它在守护进程侧的接缝 `crates/amos-ai/src/netguard_service.rs`。这轮与前四轮不同：找到的不是「文档写错」，而是**一个被文档当作已接通、实则从未被实例化的机制**。

### 10.1 两处发现（一处已修，一处据实登记）

| # | 发现 | 形状 | 处置 |
|---|------|------|------|
| F-1 | **`NetworkGuard` 缝零实例化** | `guard.rs` 自述 `NetworkGuard` 是「the single external seam a transport layer (gRPC service, Tauri bridge, …) talks to」；而全仓**没有任何生产代码构造过任何 guard** —— `MockNetworkGuard`/`VpnNetworkGuard`/`NftablesNetworkGuard` 及其 `apply`/`flush` 只存在于 crate 自己的单测。守护进程 `NetGuardSvc` 的 `backend: "mock"` 是**写死的 `&'static str` 字面量**、`StatusReply.enforced` 写死 `false` ⇒ `Toggle` 的 arm **从未到达任何后端** | **已修**：`NetGuardSvc` 持有 `Box<dyn NetworkGuard>`（默认 `MockNetworkGuard`），`Toggle(true)` 驱动 `apply(held_rules)`、`Toggle(false)` 驱动 `flush()`；失败**如实返回 `Unavailable` 且不留下假 armed**；`enforced` 改为后端自己的 `NetworkGuard::enforces()`（trait 默认 `false`，真后端在**确实丢包**后才覆写）；`with_parts` 让真后端可注入 |
| F-2 | **规则无来源（`policy_rules` 恒为 0）** | 守护进程持有 `RuleSet` 并把它的大小当作 `StatusReply.policy_rules` 上报，而**没有 RPC/路径**往这只 `RuleSet` 里塞规则 ⇒ `RuleSet::insert`、`Policy::allow`/`block`、`effect_for`、`blocked` 至今**零生产调用者**，`policy_rules` **每次启动恒为 0**，而 proto 把它文档成「Number of egress policy rules the guard holds」——一个**测量** | **据实登记，本轮未修**：给守护进程一条真正的规则配置入口是**独立的一轮工作**；proto/前端字段注释已改述为「reserved」，不再冒充测量 |

### 10.2 为什么 F-1 算「真缺陷」而非整洁度

`StatusReply.enforced` 的存在意义，是把「真的在拦」与「只记了意图」分开 —— 而它的真值来自一个**常量**，不是任何后端能力的函数。`rust-unwired-scan` 保持绿，正因为该模块**自己的单测**被算作调用者，这与 F-WM-022（`WindowStateStore` 写完、测过、生产里没有调用者）是**同一形状**。F-2 则与 F-SH-070/F-SH-072 同族：文档（这里是通过 wire 暴露给界面的一个字段）断言了一个代码从未建立的量。

### 10.3 验证与负控（实测）

`cargo test -p amos-network-guard` ⇒ **14 passed**（+1）；`cargo test -p amos-ai --lib netguard_service::` ⇒ **10 passed**（+3）；`cargo test -p amos-tauri --lib netguard` ⇒ **6 passed**；`cargo clippy -p amos-network-guard --all-targets --features nftables,vpn -- -D warnings` 与 `cargo clippy -p amos-ai --lib -- -D warnings` 均 **0 警告**；`cargo fmt` 净；`cargo check -p amos-network-guard --features nftables,vpn` 通过；`node scripts/fmea-gen.mjs --check` ⇒ **279 条**（+1）；`node scripts/rust-unwired-scan.mjs` ⇒ **23 baseline / 0 new**。

**负控（实测，非预期）**：(a) `enforced: self.guard.enforces()` 还原为 `false` ⇒ `enforced_follows_the_backends_own_claim` **恰 1 红**；(b) `Toggle` 的 `outcome` 换成 `Ok(())` ⇒ **2 红**（`arming_drives_the_guard_seam_and_disarming_flushes_it` + `a_backend_that_cannot_arm_never_reports_armed` —— 该变异同时废掉 apply/flush 与错误传播，二者共用 `outcome`，**如实**报 2 而非 1）；(c) 错误分支换成 `let _ = outcome;` ⇒ `a_backend_that_cannot_arm_never_reports_armed` **恰 1 红**；(d) `enforces()` 默认改 `true` ⇒ `recording_backends_do_not_claim_to_enforce_by_default` **恰 1 红**。四次均以 `/tmp/*.good` `cp` 逐字节还原、`diff -q` 校验后复绿。

### 10.4 诚实边界

1. **规则来源仍未做**：没有任何 RPC 配置规则，`policy_rules` 恒为 0，`effect_for`/`blocked` 仍只有单测调用者。本轮**只**把「缝」接上，不改「谁给规则」。
2. **`enforces()` 默认 `false`** ⇒ 今日**任何**后端都报 `enforced=false`（真 `VpnService`/nftables 后端未接线）；预览这一诚实默认正是它存在的理由。
3. **未改 proto 的字段/消息**（只改注释），因此**无 wire 破坏**；Tauri 桥与前端只改注释，未改行为。
4. **`StatusReply.backend` 仍是 `&'static str`**：它现在与所持 guard 对应，但注入真后端仍靠 `with_parts` 调用方传对名字 —— 无编译期约束，登记为下一步。
5. **并发取号**：A579 为我上一轮所留，A580/A581 落笔前重探后取 **A580 / F-SH-075**。

## 11. 第六轮：Rust 模块审计（`amos-vector-db`，REQ-A583 / F-SH-076，2026-09-20）

第六轮选定 `crates/amos-vector-db` —— 零 FMEA 的纯离线检索核（无 I/O、无时钟）。本轮发现的形状与第五轮同族（**文档断言了一个代码没有建立的量**），但落点更靠里：这次断言的是一条**安全属性**，而守卫建在错误的门口。

### 11.1 三处发现与修法

**F-1（实体缺陷）——「插入时拒绝非有限向量」这条承诺，插入路径从未执行。**

`README.md` 与 `src/lib.rs` 都写：非有限向量（`NaN`/`inf`）在**插入时**被拒，这防的失效模式是「一个相似度分悄悄变成 `NaN` 并把一切排到最前」。真正做有限性检查的是 `Vector::new`（`src/model.rs`）；而 `FlatIndex::add`/`upsert`（`src/index.rs`）**只调 `validate_dim`**（只比长度）。

关键在于绕过**不需要 `unsafe`**：`Vector` 的 `id`/`data` 是 **`pub`** 字段，又 derive 了 `Deserialize` ⇒ 任何调用方都能用结构体字面量或反序列化造出一个含 `NaN` 的 `Vector`，`new` 根本不在路径上。一旦这样一行进了索引，`search` 对它打分得 `NaN`，排序键是 `sb.total_cmp(sa)`，而 `f32::total_cmp` **把正 `NaN` 排在 `+inf` 之上** ⇒ 该行**永远返回为 rank 0**，正是文档声称已防住的那个静默腐蚀。附带两处不一致：`add` 接受空 id（`"   "`）并入索引，而 `load_bytes` 把空 id 判为 `Corrupt` —— 插入路径比加载路径松。

**修法**：`src/index.rs` 抽出 `validate_vector(&self, &Vector)` **全契约守卫**（非空 id + 全部分量有限 + 长度等于索引维度），`add`/`upsert` 都改走它，**不再依赖调用方是否用了 `Vector::new`**；维度错误仍以 `DimMismatch` 具名（既有测试不变）。空数据**不设单独分支** —— `dim >= 1` 恒真，长度守卫必然拒绝（见 11.3 的负控教训）。

**F-2（假文档）—— README 声称度量有 `euclidean`。**

`README.md` 写「`Metric` (cosine / dot / **euclidean** as configured)」。而 `src/metric.rs` 的 `enum Metric` 只有 `Cosine`/`Dot` 两个变体，设计文档 `docs/vector-db-rag.md` 也写「cosine or dot」。改 README 那一行为「cosine / dot as configured — those are the only two variants」。

**F-3（假文档）—— `norm()` 谎称会返回错误。**

`src/metric.rs::norm` 的文档写「Returns an error when lengths are zero（guarded upstream, but kept total/panic-free regardless）」。它签名是 `fn norm(a: &[f32]) -> f32`，**不可能是 `Result`**（`Result` 未导入，也无 `.into()`）。改正为「Total and panic-free: returns `f32`…an empty slice yields `0.0`」。

### 11.2 为什么 F-1 算「真缺陷」而非整洁度

因为它让一条**被明文承诺的安全属性**变成空话，且失效后果是**用户可见**的：任何直接构造/反序列化 `Vector` 的调用方（宿主 RAG 路径、快照旁路、未来的导入工具）都能把一行 `NaN` 塞进索引，之后**每一次检索**的第一个结果都是那行垃圾 —— 用户拿到的「最相关」结果是一条没有意义、分数为 `NaN` 的命中，且无任何错误浮出。这不是「代码不够漂亮」，是**代码与它自己的契约分家**，与第五轮 F-SH-075、第四轮 F-SH-074 同一族。注意 `rust-unwired-scan` 会保持绿 —— 因为模块**自己的测试**都走 `Vector::new`，从未走绕过路径；这正是「模块写完、测过、没人走那条路」的静默。

### 11.3 验证与负控（实测）

- `cargo test -p amos-vector-db` ⇒ **38 lib + 6 集成 + 0 doc** 全绿（lib +3）。
- 新增三条单测：`insert_refuses_a_vector_that_bypassed_validation`（手造含 `NaN` 的 `Vector` 在 `add`/`upsert` 均被拒且不落库）、`insert_refuses_a_blank_id_like_load_does`（空 id 与 `load_bytes` 一样被拒）、`a_poisoned_row_can_never_rank_top`（毒行进不去 ⇒ top hit 恒为有限分的真实向量）。
- `cargo clippy -p amos-vector-db --all-targets -- -D warnings` **0 警告**；`cargo fmt -p amos-vector-db -- --check` **净**；`node scripts/fmea-gen.mjs --check` ⇒ **280 条**（+1）。
- **负控（实测）**：把 `add`/`upsert` 的 `validate_vector(&vector)?` 还原为 `validate_dim(vector.data.len())?`（修复前的守卫）⇒ **恰 3 红**，正是本轮新增的三条，其余 **35 绿**；`cp /tmp/vdb_index.good` 逐字节还原、`diff -q` 校验后复绿 38。
- **一次如实撤回**：最初还写了第四条 `insert_refuses_empty_data`。负控显示它**不变红** —— 因为 `dim >= 1` 恒真，空数据必先被维度守卫拦下，于是「空数据分支」是**死代码**。据此删掉该分支与该测试，只留 3 条真有判别力的。（教训与第四轮同一形状：先写测试、再用负控证明它真的有判别力。）

### 11.4 诚实边界

1. **未改 `Vector` 的公开字段或 `Deserialize`**：那会破坏 RAG 调用方与快照格式。修的是「索引不再信任调用方」，不是把绕过路径物理堵死。
2. **`search` 对查询的有限性检查原本就有**：本轮只补**存储**侧，未动查询侧。
3. **`metric.rs` 只改文档**，行为不变（`norm` 向来返回 `f32`）；README 只改**度量**那一行，其余承诺此前已为真。
4. **未改 `docs/vector-db-rag.md`**：其「cosine or dot」本就与代码一致，是 README 单方面多写了 euclidean。
5. **并发取号**：A581（删 `space_for_window`）与 A582（前端 gps 接线）先后被同期会话占用，A583 落笔前重探后取 **A583 / F-SH-076**。

## 12. 第七轮：Rust 模块审计（`amos-sms`，REQ-A585 / F-SH-077，2026-09-20）

第七轮选定 `crates/amos-sms` —— 零 FMEA 的 SMS 域核（无 I/O、无时钟）。先核了 README 那条最重的安全声明（「余额在到达任何 UI 面前被遮掩，通知与锁屏绝不泄漏」）：`redact_for` 在 `crates/amos-tauri/src/sms.rs` 的**全部**读命令上接线（`sms_snapshot`→`redact_threads`、`sms_messages`→`redact_messages`），其余命令只返回计数/编号，**未发现泄漏**——这条声明是真的。随后核分段计数，发现一处真缺陷。

### 12.1 发现与修法（F-1）

**「保守」的计数器在说反话：它低报，且只对它自己文档点名支持的子集低报。**

`src/validate.rs` 自述「Limits are conservative and explicit」，且 `is_gsm7` 的文档明写它认得 GSM 03.38 的 **basic or extension table** —— `^` `{` `}` `[` `]` `~`、竖线、反斜杠与换页 `\u{0c}` 都被认作 GSM-7。

但在 `segment_count` 里，GSM-7 分支用 `text.chars().count()` 当单位数，也就是**每个字符算一个 septet**。而 GSM 03.38 的**扩展表字符以 `ESC` + 该字符两个 septet 发送**的 ⇒ 这些字符被**少算一半**。直接后果：81 个 `^` 只占 81 个单位（≤160）⇒ 报告 **1** 段，而真实是 162 septets ⇒ **2 段**。一行全是 `^`/`{`/`~` 的消息，报告的段数可以低到真值的一半。

这与该模块「conservative（保守）」的自述**方向相反** —— 它低报，而保守应当高报。用户/审计看到的是错的计费段数（`checked_send` 把 `segment_count` 随审计轨迹返回）。消息本身仍会被电台正确拆分，故非数据损坏 —— 这是它 severity 为 2 而非 3 的原因。

**修法**：新增 `is_gsm7_extension(c)`（列出这 9 个字符）与 `gsm7_units(text)`（扩展字符记 2 septets、其余记 1），`segment_count` 的 GSM-7 分支改用它。**分类（`is_gsm7`）不动** —— 把扩展字符判为 GSM-7 是对的（它们确实是 GSM-7，只是贵）；**UCS-2 分支不动**（`encode_utf16().count()` 本就对，emoji 记 2）。

### 12.2 为什么这条算「真缺陷」而非整洁度

因为它是一个**被明文称为「保守」的计数器在说反话**，且只对**它自己文档里点名支持**的那个子集说反话。同一个「文档断言、代码未建立」的家族（F-SH-070/072/074/076）又一处，只是这次的量是一个**数字**。既有测试 `counts_segments_for_gsm7_and_ucs2` 只用 `a`/`中`/`😀`，从未测过一个扩展字符，所以 `cargo test` 一直绿 —— 又一个「模块写完、测过、那个子集没人走」的盲区。

### 12.3 验证与负控（实测）

- `cargo test -p amos-sms` ⇒ **56 lib + 0 doc** 全绿（lib +1）。
- 新增单测 `gsm7_extension_chars_cost_two_septets`：钉住 160/2 边界（80 个 `^` ⇒ 1 段、81 ⇒ 2 段），并遍历全部 9 个扩展字符各断言 2 段，同时用同长度的 `a` 断言仍为 1 段（无回归）。
- `cargo clippy -p amos-sms --all-targets -- -D warnings` **0 警告**；`cargo fmt -p amos-sms -- --check` **净**；`node scripts/fmea-gen.mjs --check` ⇒ **281 条**（+1）。
- **负控（实测，先红后绿）**：修**前**先写测试 ⇒ 恰 1 红（`left:1 / right:2`，即 81 个 `^` 被报成 1 段，证明缺陷真实存在）；修后把 GSM-7 分支还原为 `text.chars().count()` ⇒ **恰 1 红**（同一条），其余 **55 绿**；反向还原、`fmt --check` 净后复绿 56。

### 12.4 诚实边界

1. **未改 `is_gsm7` 的分类**：把扩展字符判为 GSM-7 是对的（它们确实是 GSM-7，只是贵）。本轮只修**计数**。
2. **未改 UCS-2 路径**：`encode_utf16().count()` 本就正确。
3. **未改 `MAX_TEXT_CHARS`**：1600 字符的上限与段数无关，仍是字符数门。
4. **模块文档「1600 characters ≈ 10 GSM-7 segments」未改**：那是带 `≈` 的近似，含扩展字符时会更多；`segment_count` 的文档已注明扩展字符计双。
5. **未做真机复跑**：段数是纯函数，电台的真实拆分段数属设备验收（README 既有边界）。
6. **并发取号**：A584 已被同期会话占用，A585 落笔前重探后取 **A585 / F-SH-077**。

---

## 13. 第八轮：Rust 模块审计（`amos-devocare`，REQ-A591 / F-SH-079，2026-09-20）

**起点**：继续「Rust 模块审计轮」——选一个**零 FMEA** 的 crate，做文档-对-代码审计，找「一条被声明的属性/机制，代码里没有任何路径建立它」。本轮选中 `crates/amos-devocare`（设备管家领域内核，纯 `std`、无 I/O 破坏面，除 `hostfs` 外全离线）。

**方法**：逐模块通读 `guard.rs` / `junk.rs` / `spec.rs` / `health.rs` / `audit.rs` / `boost.rs` / `permissions.rs` / `provider.rs` / `hostfs.rs` / `error.rs` / `lib.rs` / `README.md`，再对每一条「承诺」回代码里核对。`guard`（关键包拒绝）、`junk`（去重/拒绝/饱和）、`health`（未观测不评估）、`audit`（部分清理记为 error）、`boost`（受保护 tier 永不回收）经核对**均为真**；缺口落在 `hostfs`。

### 13.1 发现与修法（F-1）

**F-1：一个「部分扫描」被当成扫描完了 —— 走过深度上限的子树既没被枚举、也没被计入任何计数，于是被截断的扫描看起来完整。**

- **承诺**：`hostfs.rs` 模块头写「A scan additionally reports how many directories it could not read (`HostScan::unreadable_dirs`) so a partial scan is never presented as a complete one」；`docs/devcare.md` REQ-DC18 登记「不可读目录计数（部分扫描不冒充完整）」。
- **只有一种截断被计数**：`unreadable_dirs` 仅在 `read_dir` 读取条目失败、或某条目 `symlink_metadata` 失败时自增。`Frame::open` 在 `depth > MAX_SCAN_DEPTH` 时**直接 `return Ok(None)`** —— 那条子树被整体跳过，**不增计数、不留痕迹**。
- **实测**：造一条比 `MAX_SCAN_DEPTH`（12）更深的目录链、最深叶子放一个 `*.tmp` ⇒ `scan()` 返回 `Ok` 且 `unreadable_dirs == 0`。唯一的信号（该文件没出现）与「那个文件本来就不存在」无法区分。
- **缺口落在最需要的调用方**：Tauri 桥把 `HostScan::unreadable_dirs` 直通到 `DevCareStatus.unreadable_dirs`（UI 据此提示「扫描不完整」），深度截断时该值恒为 0 ⇒ 用户看到「扫描完成」，而深层缓存目录里可回收的条目从未被列出。
- **修法（让截断可见，不动边界）**：`Frame::open` 的 `depth > MAX_SCAN_DEPTH` 分支**先 `out.unreadable_dirs += 1` 再返回 `None`**，把「未进入的子树」纳入既有的部分扫描计数；同步扩充 `HostScan::unreadable_dirs` 的文档、模块头与 `MAX_SCAN_DEPTH` 的文档；`scan_is_depth_bounded` 增加「必须报为部分」的断言，新增单测 `scan_reports_a_depth_truncated_walk_as_partial`。

### 13.2 为什么 F-1 算「真缺陷」而非整洁度

1. **文档断言了一个代码未建立的量** —— 模块头与设计文档都写「部分扫描不冒充完整」，而深度截断恰好把部分扫描冒充成完整。与 F-SH-070/072/076/077 同族。
2. **可观测性缺口落在用户可见的判定上** —— `unreadable_dirs` 是「扫描完整 / 不完整」的唯一信号，它恒为 0 时，用户被明确告知「扫完了」，而证据（深层目录未被列出）无法与「本来就没有」区分。
3. **方向是「最激进的省略」** —— 深度上限是**有意的**边界（不是缺陷），缺陷是它**静默**；按本仓诚实规则，截断必须可观测。省略不产生任何日志，因此比做错更难被发现。

### 13.3 验证与负控（实测）

- `cargo test -p amos-devocare` ⇒ **86 lib（+1）+ 4 集成 + 0 doc** 全绿。
- `cargo clippy -p amos-devocare --all-targets -- -D warnings` ⇒ **0 警告**；`cargo fmt -p amos-devocare -- --check` ⇒ **净**。
- `node scripts/fmea-gen.mjs --check` ⇒ **284 条**（+1）。
- **负控**：把 `Frame::open` 的深度分支还原为「直接 `return Ok(None)`」（修前行为）⇒ **恰 2 红** —— 新增的 `scan_reports_a_depth_truncated_walk_as_partial` 与加严后的 `scan_is_depth_bounded`（后者因本轮新增的「必须报为部分」断言而红），其余 **84 绿**；`cp /tmp/devocare_hostfs.good` 逐字节还原、`diff -q` 校验后复绿 86。

### 13.4 诚实边界

1. **未改深度上限本身**：`MAX_SCAN_DEPTH = 12` 是有意的有界遍历，也是 NASA Power of 10 #1 禁递归的前置；本轮只让截断**可见**。
2. **未混同两种处置**：`MAX_JUNK_ITEMS` 超上限仍是**硬拒**（`TooManyItems`），与深度截断的「可观测的部分扫描」是不同处置。
3. **未改既有安全属性**：`is_within` / `is_safe_root` / 符号链接不跟随均未动。
4. **未做真机复跑**：扫描是纯文件系统遍历，本轮的证据是可控 temp 树的单测与负控。
5. **顺带更正**：`README.md` 的「诚实边界」此前写「超上限报告**截断**结果」——与代码相反，改为「超上限即拒绝；提前停下报为部分」；同页把干净计划那条清单里被误挂的 boost 符号换成本就属于它的 `JunkKind::is_auto_cleanable` / `needs_review`。
6. **并发取号**：A586–A590 与 F-SH-078 均已被同期会话占用，A591 落笔前重探后取 **A591 / F-SH-079**。

---

## 14. 第九轮：Rust 模块审计（`amos-pdf-parser`，REQ-A594 / F-SH-080，2026-09-20）

**起点**：继续「Rust 模块审计轮」——选一个**零 FMEA** 的 crate，做文档-对-代码审计，找「一条被声明的属性/机制，代码里没有任何路径建立它」。本轮选中 `crates/amos-pdf-parser`（离线 RAG 抽取核，纯 Rust on `lopdf`，解析器是对抗性审计的经典领域：恶意输入、边界、panic）。逐模块通读 `extract.rs` / `layout.rs` / `table.rs` / `chunk.rs` / `model.rs` / `util.rs` / `error.rs` / `cli.rs` / `README.md` / `docs/offline-rag-pdf.md`。`chunk`（有界、无损、码点不切裂）、`layout`（几何 + 可插拔解码）、`table`（只对几何对齐的单元格开火）、`util`（CJK≈1 / Latin≈¼）以及「逐页软失败 + 未知算子不 panic」经核对**均为真**；缺口落在**加密输入**。

### 14.1 发现与修法（F-1）

**F-1：一个「加密 PDF 是拒绝」的承诺从未建立 —— 加密文件的结构照常解析、密文流被当明文解码，于是「拒绝」变成了一个成功的、空或乱码的解析结果。**

- **承诺**：`README.md` 的诚实边界写「**Encrypted/corrupt PDFs are refusals** (typed errors), never partial nonsense」；`docs/offline-rag-pdf.md` 也把「非 PDF 字节被 `%PDF-` 魔法早拒」列为对抗性鲁棒性基线。
- **没有任何代码路径建立它**：全 crate 里 "encrypt" 一词**只出现在 README**（`grep -rni encrypt crates/amos-pdf-parser` 仅命中那一行）；代码从未调用 `Document::is_encrypted()`。`lopdf::Document::load_mem` 只解析**结构**、既不校验也不解密 —— `/Encrypt` 留在 trailer 里，字符串与流（含内容流）仍是密文。
- **实测（修前）**：给一份真实 PDF（`lopdf` writer 生成、xref 正确）的 trailer 加上 `/Encrypt` 引用后 `parse_bytes` ⇒ 返回 `Ok(ParsedPdf { …, warnings: [] })` —— **既未拒绝、也无任何提示**。真加密文件的密文流会逐页 `extract_text` 解码失败 ⇒ 只多一条 warning + 空页，**仍是 `Ok`**。
- **方向是「静默的假成功」**：不是 fail-closed 的拒绝，而是把一个无法读取的文件报成成功解析；调用方（RAG 摄取队列）拿到一个看似正常、实则空或乱码的文档，无从据此路由或告警。
- **修法**：`error.rs` 新增 typed 变体 `PdfError::Encrypted`；在**唯一**的装载点 `extract_document` 开头加 `if doc.is_encrypted() { return Err(PdfError::Encrypted) }`（`extract_bytes` / `extract_path` / `PdfParser::parse_bytes` / `parse_path` 四条公开路径全部经过它）；扩充 `extract.rs` 模块头，说明「加密是唯一不软的失败」；集成测试 `encrypted_pdf_is_refused_not_partially_parsed` 用真实 PDF 追加 `/Encrypt`，先断言 `is_encrypted()`，再断言拒绝且消息含 "encrypt"。

### 14.2 为什么 F-1 算「真缺陷」而非整洁度

1. **文档断言了一条代码未建立的拒绝属性** —— README 明写「加密 PDF 是 typed error 的拒绝」，而代码连 `is_encrypted()` 都没调过。与 F-SH-070/072/076/077/079 同族。
2. **失败方向是「假成功」而非 fail-closed** —— 危害不在「读不到」，而在「把读不到报成读到了」：下游拿到带零警告的成功文档，密文被当明文解码，用户/模型可能读到乱码而毫不知情。
3. **可观测性缺口** —— 没有任何 warning 或 error 指出「这份文件是加密的、因此不可信」，唯一的信号（内容为空/乱码）与「文件本来就没文本」无法区分。

### 14.3 验证与负控（实测）

- `cargo test -p amos-pdf-parser` ⇒ **38 lib + 8 集成（+1）+ 0 doc** 全绿。
- `cargo clippy -p amos-pdf-parser --all-targets -- -D warnings` ⇒ **0 警告**；`cargo fmt -p amos-pdf-parser -- --check` ⇒ **净**。
- `node scripts/fmea-gen.mjs --check` ⇒ **287 条**（+1；本轮落笔时另有并发会话已加入 F-INT-001 / F-TR-001）。
- **负控**：把 `extract_document` 的 `is_encrypted` 守卫去掉（修前行为）⇒ **恰 1 红** —— 新增的 `encrypted_pdf_is_refused_not_partially_parsed`，其余 **7 集成 + 38 lib 绿**；`cp /tmp/pdf_extract.good` / `/tmp/pdf_error.good` 逐字节还原、`diff -q` 校验后复绿。

### 14.4 诚实边界

1. **未实现解密**：crate 无密码 API，故连「owner-password-only、空用户口令本可打开」的文件也一并拒绝 —— 这是与 README 字面承诺一致的保守选择，也是本轮的功能取舍。
2. **未混同两种处置**：单页解码失败仍是逐页软失败（warning + 空页），与「整份声明加密」的整份拒绝是不同处置。
3. **未改既有属性**：`%PDF-` 魔法早拒、`layout`/`table`/`chunk` 的既有行为均未动。
4. **测试夹具是「声明加密」而非「真加密」**：`lopdf` 0.34 无公开加密 API，无法在测试里产出真密文；而「文件声明自己加密」正是该判定所依赖的全部条件（`is_encrypted()` 只看 trailer 的 `/Encrypt`），故足以判别守卫是否存在。**未做**与真实加密 PDF 的联调。
5. **并发取号**：A592 / A593 已被同期会话占用，A594 落笔前重探后取 **A594 / F-SH-080**。

---

## 15. 第十轮：前端审计（WebMan 浏览器，`frontend-ts`，REQ-A598 / F-SH-081，2026-09-20）

**起点**：用户指出「我们有 WebMan 浏览器」——本仓的前端浏览器子应用，请审计并补全它。与「Rust 模块审计轮」同一判定纪律（找「一条被声明的能力，代码里没有任何路径建立它」），但对象换到 `crates/amos-tauri/frontend-ts`：`src/svelte/WebManApp.svelte`（~550 行组件）、`src/lib/webman.ts`（域核）、`WEBMAN_IMPLEMENTATION_REPORT.md`（宣称的能力清单）、`WEBMAN_COMPLETION_FINAL_2026_SEP20.md`（自述的已知缝）。逐条把报告里的 ✅ 拿回代码核对：标签栏、地址栏、书签/历史/下载/设置侧栏、隐私模式、快速链接、菜单弹窗**均为真**；缺口落在**「前进/后退 = 导航历史」**这一条。

### 15.1 发现与修法（F-1）

**F-1：一条被声明的能力（「前进/后退 = 导航历史」）从未建立 —— 两个按钮只翻转一个组件内布尔量，全 crate 不存在任何导航历史。**

- **承诺**：`WEBMAN_IMPLEMENTATION_REPORT.md` 第 35 行「✅ 前进/后退/刷新按钮」、第 61 行「| 前进/后退 | ✅ | 导航历史 |」。
- **没有任何代码路径建立它**：`WebManApp.svelte` 里两个按钮是 `onclick={() => (canGoBack = !canGoBack)}` / `onclick={() => (canGoForward = !canGoForward)}` —— 点一下只翻转一个组件内布尔量；`inputValue`、`activeTab.url`、落盘的 `TABS_KEY` 值全都不动。`grep` 全 crate 也不存在任何导航栈。
- **同族第二次现身**：这是 F-SH-046 同族的复发 —— **判据住在组件状态里 ⇒ 无头测试够不着 ⇒ 缺陷活下来**。`canGoBack` 是一个可被任意翻转的组件状态，而非从历史真值派生的量；无头单测看不到组件内部布尔量，DOM 测试也没覆盖这两个按钮的行为。
- **代价**：浏览器两个最基本的按钮是假的 —— 用户点「←」页不动（只是把「→」点亮了），而报告里的 ✅ 让读文档的人以为这条路已经通了。
- **修法（判据抽成纯函数 + 组件只做派发）**：`lib/webman.ts` 新增 `NavStack`（`{ entries: string[]; index: number }`）+ `emptyNavStack` / `pushNavEntry`（同一页不入栈、截断前进支路、`NAV_HISTORY_MAX_COUNT = 50` 从最旧一端丢）+ `goBackNav` / `goForwardNav` / `canGoBackNav` / `canGoForwardNav`，**每个标签页一份、会话内存**（不新增 `amos.webman.*` 键，理由同 `ClosedTab` —— 这是易失的导航位置，不是用户数据）。`WebManApp.svelte` 里 `loadUrl(url, push)` 是新导航（入栈）与 ← / →（**不**入栈，否则回退一次就多一条历史）唯一的落点；`canGoBack` / `canGoForward` 改成 `$derived`（从 `navStacks[activeTabId]` 真值派生）；标签关闭时其栈随它一起丢；落盘标签与恢复出来的标签以自己那一页为栈的起点。
- **顺带查出的判定既存缺陷（F-2）**：修 `onclick` 时 `i18n-scan` 当场照出**同一段 markup 里更早的一个** —— `← / → / ↻ / ⋮ / +` 五个只有字形的按钮「没有可读名字」。根因是扫描器打开标签的正则在 `onclick={() => …}` 的 `=>` 上截断（`[^>"']` 吃不掉 `>`），把整段 `{…}` 当成"动态名字"而误判为已命名；把 `onclick` 换成具名函数后 `=>` 消失、缺陷遂显形。修法：`←/→/↻` 补 `aria-label={t("webman.a11y.back/forward/reload")}`、两个 `⋮` 补 `webman.a11y.menu`、`+` 接上**原先预留、已在 i18n-allowlist 里写明理由**的 `webman.newTabButton`，并从 allowlist 撤下该键。这处是**扫描器盲区**导致的既存缺陷，非本轮引入。

### 15.2 为什么 F-1 算「真缺陷」而非整洁度

1. **文档断言了一条代码未建立的能力** —— 报告明写「前进/后退 ✅ 导航历史」，而代码里连一个栈都没有。与 F-SH-046 同族。
2. **失败方向是「静默的假成功」的镜像：假装成功** —— 按钮可点、点下去有视觉反馈（另一个按钮被点亮），但真实状态不变。用户与读文档者都被误导。
3. **测试盲区** —— 判据住在组件状态里，无头单测够不着、DOM 测试未覆盖 ⇒ 缺陷在两个测试层都活了下来（正是 F-SH-046 的判据）。

### 15.3 验证与负控（实测）

- `src/lib/__tests__/webman-nav-history.test.ts` ⇒ **14**（空栈 / A→B→C 双向移动 / 最旧最新端夹取 / 截断前进支路 / 同页不入栈 / 有界与 `index` 不变量）。
- `svelte-tests/webman-nav-buttons.svelte.test.ts` ⇒ **4**（两个按钮的 `disabled` 从真值派生、点 ← 后地址栏与 `TABS_KEY` 一起回去、→ 再前进、截断后 → 变灰）。
- `npx svelte-check` ⇒ **0 error / 0 warning**（1388 files）；`bun run test` ⇒ `[bun-iso] test OK`；`bun run test:svelte` ⇒ **126 files / 1483 tests passed**；`bun run typecheck` ⇒ **净**。
- `bun run check` ⇒ **exit 0**（i18n 2422 keys / 42 allow-listed；orphan-test-scan 362 test files 全执行）。
- `node scripts/fmea-gen.mjs --check` ⇒ **[OK] 291 条**（+1）。
- **负控（实测）**：把 `goBackNav` / `goForwardNav` 强制回 `url: null`（= 修复前「点了不动」的语义，逐字节还原 + sha256）⇒ **恰 5 红**（新单测）+ **2 红**（新 DOM 测试），其余 `webman*.test.ts` **156 绿**；`cp` 逐字节还原后 **14 + 4** 复绿。
- **i18n 侧自证**：撤掉 `aria-label` ⇒ `i18n-scan` 恰好报那两条字形按钮。

### 15.4 诚实边界

1. **跨源 iframe 的 `history` 不可读**：只有**本应用派发过的 URL** 才入栈，页内锚点跳转与 iframe 内部导航不进（这是浏览器的同源边界，非本轮遗漏）。
2. **会话内存、不落盘**：导航栈随标签关闭而丢、随进程结束而丢（与 `ClosedTab` 同取舍），不新增 `amos.webman.*` 键。
3. **未改** `HISTORY_MAX_COUNT`：那是**落盘的"访问历史"**（另一条有界列表），与每标签页的导航栈是两件事，未混同。
4. **未接真实 WebView 导航事件**：判据是纯函数 + DOM 测试，**未做**真机 GUI 联调（`navigate` 仍是 `loading` 定时器驱动的既有模拟层）。
5. `NAV_HISTORY_MAX_COUNT = 50` 是**每标签页**的有界深度（一条只涨不落的栈即内存泄漏，与 `CLOSED_TAB_MAX_COUNT` 同理）。
6. **并发取号**：A595 / A596 / A597 已被同期会话占用，A598 落笔前重探后取 **A598 / F-SH-081**。

---

## 16. 第十一轮：前端审计（WebMan 浏览器，Chrome 风格，`frontend-ts`，REQ-A600 / F-SH-082，2026-09-20）

**起点**：用户接着上一轮（REQ-A598 / F-SH-081 修好「前进/后退 = 导航历史」）提出「按照谷歌浏览器的风格，审计与完善浏览器的功能」。判定纪律不变（找「一条被声明的属性/能力，代码里没有任何路径建立它」），对象是 `WEBMAN_IMPLEMENTATION_REPORT.md` 的功能清单与 `WebManSettings` 的字段表：把每一条声明拿回代码核对。标签栏、地址栏、书签/历史/下载侧栏、隐私模式、安全搜索、快速链接、菜单**均为真**；缺口落在**三个被声明却没有消费者的设置**。

### 16.1 发现与修法（F-1 / F-2）

**F-1：`blockPopups` / `javaScriptEnabled` 没有任何代码路径读取 —— iframe 的 `sandbox` 是写死的字面量，于是「默认阻止弹窗」是假声明。**

- **承诺**：`WebManSettings` 声明 `blockPopups`（默认 `true`，源码注释写「阻止弹窗」）与 `javaScriptEnabled`（默认 `true`），那是两个面向用户的安全开关。
- **没有任何代码路径建立它**：`WebManApp.svelte` 的 `<iframe sandbox="allow-scripts allow-popups allow-forms">` 是**字面量**；`grep` 全 crate，两个设置只有三处出现 —— 定义、默认值、反序列化，**零消费者**。
- **同族第三次现身**：F-SH-046 / F-SH-081 同族 —— **判据住在组件模板里 ⇒ 无头测试够不着 ⇒ 缺陷活下来**。
- **代价**：安全开关是假的。用户以为默认「阻止弹窗」，而 `allow-popups` 恒被授予（被加载页面的 `window.open` / `target=_blank` 全部放行）；把「JavaScript」关掉也不会有任何效果。这三条设置的 UI 根本没暴露（设置面板只画了搜索引擎 / 隐私模式 / 安全搜索）⇒ 用户既看不见、也改不动。
- **修法**：`lib/webman.ts` 新增纯函数 `iframeSandbox(settings)` —— `allow-scripts` 当且仅当 `javaScriptEnabled`；`allow-popups` 当且仅当 **不**阻止弹窗（`blockPopups === false`）；`allow-forms` 恒有；**永不** `allow-same-origin`。令牌顺序固定（scripts → popups → forms）故输出可被逐字节断言。`WebManApp.svelte` 改为 `sandbox={iframeSandbox(settings)}`；设置面板「隐私与安全」区补 `toggleBlockPopups` / `toggleJavaScript` 两个 Chrome 风格开关（复用既有 switch 行样式）。

**F-2：`homepage` 设置无消费者 —— 一个「可设置的主页」却没有去主页的方法。**

- **承诺**：`WebManSettings.homepage`，源码注释「默认主页」，默认 `https://www.google.com`。
- **没有任何代码路径建立它**：`grep` 全 crate，只有定义 / 默认值 / 反序列化 —— 工具栏里没有主页按钮，`navigate` 也不读它。
- **修法**：工具栏补一个 Chrome 风格的「主页」按钮（`goHome` → `navigate(settings.homepage)`），复用同一套 URL 清洗与安全搜索（不为"主页"开旁路）。这是 `homepage` **唯一**的消费者。

### 16.2 为什么算「真缺陷」而非整洁度

1. **声明了一条代码未建立的属性** —— 类型层声明了两个安全开关，模板层却把 `sandbox` 写死；`blockPopups: true` 的默诺（"阻止弹窗"）在任何模式下都不成立。与 F-SH-046/081 同族。
2. **失败方向是「假保护」** —— 不是漏掉一个便利功能，而是**安全开关看着在、实际不在**：用户以为弹窗被挡，实则放行。
3. **测试盲区** —— 判据住在模板里，无头单测够不着；既有的 `webman-iframe-posture` 测试只钉了 `allow-scripts` 在 / `allow-same-origin` 不在，从未断言 `allow-popups` 与设置的关系。

### 16.3 验证与负控（实测）

- `src/lib/__tests__/webman-sandbox.test.ts` ⇒ **7**（默认⇒有 scripts 无 popups / 永不 `allow-same-origin`（四组合穷举）/ 关 JS⇒撤 scripts / 取消阻止弹窗⇒有 popups / 两关⇒只剩 `allow-forms` / 令牌顺序逐字节）。
- `svelte-tests/webman-sandbox.svelte.test.ts` ⇒ **5**（默认沙箱无 `allow-popups` / 落盘 `blockPopups:false`⇒iframe 真有 `allow-popups` / 落盘 `javaScriptEnabled:false`⇒撤 `allow-scripts` / 面板点开关⇒沙箱当场撤回且落盘 / 主页按钮把地址栏与 `TABS_KEY` 一起带到 `homepage`）。
- `npx svelte-check` ⇒ **0 error / 0 warning**（1389 files）；`bun run test` ⇒ `[bun-iso] test OK`；`bun run test:svelte` ⇒ **127 files / 1488 tests passed**；`bun run typecheck` ⇒ 净；`bun run check` ⇒ **exit 0**。
- `node scripts/fmea-gen.mjs --check` ⇒ **[OK] 292 条**（+1）。
- **负控（逐字节还原 + sha256）**：(a) 令 `iframeSandbox` 恒回写死串（= 修复前"忽略设置"语义）⇒ **恰 4 红**（新单测）+ **3 红**（新 DOM 测试），其余 webman 单测全绿；还原后 7 + 5 复绿。(b) 令 `goHome` 恒定 `navigate('https://www.example.com/')`（= 不读 `homepage` 的修复前语义）⇒ **恰 1 红**（主页 DOM 测试），还原后复绿。

### 16.4 诚实边界

1. **未接真实 WebView 网络栈**：`sandbox` 的令牌由 happy-dom 的属性断言钉住，**未做**真机验证「浏览器内核确实按 `allow-popups` 拦截了 `window.open`」——属性是否正确是代理判据。
2. `allow-forms` **有意**不做开关（表单是网页基本面，Chrome 也不把它放进可关项）。
3. **未接** `homepage` 的编辑入口：用户仍改不了默认主页（仍是 `https://www.google.com`）—— 本轮只让这条设置**有消费者**，改值需要另开一个输入 UI。
4. `iframeRef` 的强制重载（`⌘R` 的 `iframe.src = iframe.src`）与地址栏 ↻ 走的是两条路，**未在**本轮统一（是另一条独立观察）。
5. `blockPopups` 默认 `true` ⇒ 默认沙箱**收紧**（撤 `allow-popups`）是**有意的行为变更**，与"默认阻止弹窗"的既有承诺对齐。
6. **并发取号**：A595–A599 已被同期会话占用，A600 落笔前重探后取 **A600 / F-SH-082**。

---

## 17. 第十二轮：Rust 模块审计（`amos-mail` 邮件引擎，REQ-A602 / F-SH-083，2026-09-20）

**起点**：用户接着说「继续审计与补全代码，完善功能」。判定纪律不变（找「一条被声明的属性/能力，代码里没有任何路径建立它」），对象选 `crates/amos-mail` —— 零 FMEA 的邮件客户端域核（`MailClient<P: MailProvider>` + `model.rs` + `MockMailProvider`）。逐条把 README 与类型层的声明拿回代码核对：地址解析/格式化（`"Ada <ada@example.com>"`）、文件夹、未读态、附件往返、持久化**均为真且有测试**；缺口落在**三处被声明、却没有任何代码路径建立的「HTML 正文」**。

### 17.1 发现与修法

**`SendDraft.body_html` / `SendDraft::html(..)` / `Email.body_html` —— 一条被声明的能力（「HTML 正文 + 纯文本正文」）没有任何代码路径建立它。**

- **承诺**：`SendDraft::html` 的注释写「Chainable builder: add an HTML body alongside the plain-text one」，`Email.body_html: Option<String>` 声明为 `fetch` 返回的载荷 —— 一个「HTML 备选正文」的能力。
- **没有任何代码路径建立它**：`MockMailProvider::insert`（`provider.rs`）把 `body_html` 写死成 `None`（**发出的副本丢 HTML**）；`smtp::build_message`（`live/smtp.rs`）只 `builder.body(draft.body_plain.clone())` —— **唯一**的线上发送路径根本不读 HTML；`LiveImapProvider::fetch` 也写死 `None`。`grep` 全 crate，`.html(` 无任何调用点，`Email.body_html` 在任何 provider 下都**永不**是 `Some`。
- **代价：静默数据丢失** —— `client.compose(...).html("<b>x</b>")` 在默认构建下无声丢弃：无错、无告警、无落盘；`MailProvider::send` 承诺的「stores a copy of the sent message」在 HTML 这一维不成立（副本不是副本）。
- **修法**：(a) mock 把 `body_html` 穿过 `insert` → `send` 的**单一**内部缝隙（`insert` 新增一个 `body_html` 参数、`send` 传 `draft.body_html.clone()`；`deliver` 播种来信仍传 `None`，其**公开签名不变**）；(b) SMTP 在 `body_html` 为 `Some` 时发 `multipart/alternative`（`MultiPart::alternative_plain_html`），让声明的 HTML 备选真正上到线上；(c) 顺手订正 `lib.rs` 两条被代码否证的旧文档（「Today only the deterministic MockMailProvider implements it」「This crate performs **no I/O** of its own」—— 而 `live` 早已 ship 了 `LiveImapProvider`/`smtp::send`）。

### 17.2 为什么算「真缺陷」而非整洁度

1. **声明了一条代码未建立的属性** —— 类型层三处声明「HTML 正文」，代码里 `.html(` 零调用、`body_html` 恒 `None`。与 F-SH-070/072/076/077/079/080/082 同族（文档/类型断言，代码未建立的量）。
2. **失败方向是「静默的数据丢失」** —— 不是漏掉一个便利功能，而是把一个**被写进公开 API 与文档**的正文维度无声吞掉：调用方以为设了 HTML，实际存与发都没有。
3. **测试盲区** —— 既有测试只走 `body_plain`（附件往返、持久化、搜索都只断言纯文本），从未有一处调用 `.html(..)`，故 `cargo test` 一直绿。

### 17.3 验证与负控（实测）

- `cargo test -p amos-mail` ⇒ **28 lib（+2）**（新增 `sent_html_body_lands_in_the_sent_copy`：`SendDraft::html(..)` ⇒ `fetch(SENT, ..).body_html == Some(..)` 且纯文本保留；对照组 `plain_draft_has_no_html_body`：没调 `.html()` 的草稿仍是 `None`）。
- `cargo test -p amos-mail --features live` ⇒ **41（+1）**（新增 `html_body_is_transmitted_as_a_multipart_alternative`：loopback SMTP sink 抓 DATA ⇒ 含 `multipart/alternative` 与 `<b>rich</b>`）。
- `cargo check -p amos-mail-cli -p amos-tauri` ⇒ `Finished`；`cargo clippy -p amos-mail --all-targets --features live -- -D warnings` ⇒ **0 警告**；`cargo fmt -p amos-mail -- --check` ⇒ **净**；`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 294 条**；`node scripts/trace-scan.mjs` ⇒ **OK**。
- **负控（逐字节还原 + sha256）**：(a) 令 `insert` 回写死 `body_html: None`（= 修复前语义）⇒ **恰 1 红**（`sent_html_body_lands_in_the_sent_copy`），对照组仍绿，27 passed / 1 failed；还原（sha256 `df281b10…`）后复绿。(b) 令 `build_message` 回只渲染 `body_plain`（= 修复前语义）⇒ **恰 1 红**（`html_body_is_transmitted_as_a_multipart_alternative`），`send_delivers_to_a_local_smtp_sink` 仍绿，40 passed / 1 failed；还原（sha256 `3ac048dd…`）后复绿。

### 17.4 诚实边界

1. **未接真实外部 SMTP 中继**：HTML 备选由 loopback sink 抓 DATA 断言 `multipart/alternative` 与 `<b>rich</b>`，**未做**对公网中继的真实投递。
2. **未做 HTML 渲染**：README 早已写明「rendering (and its sanitisation) is a UI concern」—— 本轮只让 HTML 正文能**存**与能**发**。
3. `LiveImapProvider::fetch` 仍写死 `body_html: None`：取信侧的 MIME 解析（`text/html` part 的抽取）是另一项工作，**未**混入本轮。
4. `MockMailProvider::send` 仍只把 `to` 存进副本：Cc/Bcc 不进 `EmailSummary`（该模型本就没有 cc 字段；Bcc 不进副本与常见客户端一致）。
5. 同一 crate 的 `EmailFlags.answered`（`\Answered`）是**同族的另一处观察** —— 被声明、被序列化，却没有任何代码路径把它置真（无 `set_answered`、无 reply 操作）；本轮**未**修，留作下一轮对象。
6. **并发取号**：A601 已被同期媒体轮（F-MED-002）占用，A602 落笔前用 `grep` 重探后取 **A602 / F-SH-083**。

---

## 18. 第十三轮：Rust 模块审计（`amos-mail` 邮件引擎续，`EmailFlags.answered`，REQ-A603 / F-SH-084，2026-09-20）

**起点**：用户接着说「继续审计与补全代码，按照航空航天级别标准」。对象是第十二轮 §17.4 第 5 条**自己留下的观察**：同一 crate 的 `EmailFlags.answered`（`\Answered`）。判定纪律不变（找「一条被声明的属性/能力，代码里没有任何路径建立它」）。

### 18.1 发现与修法

**`EmailFlags.answered` —— 一条被声明的属性（「已回复 (\Answered)」）在双向都没有任何代码路径建立它。**

- **承诺**：`crates/amos-mail/src/model.rs` 的 `EmailFlags.answered` 文档写「Replied to (\Answered)」，与 `seen`（`\Seen`）、`flagged`（`\Flagged`）并列。后两者都有**完整的读写对**（`set_seen`/`set_flagged` 贯通 `MailProvider` trait → `MockMailProvider` → `MailClient` → IMAP `store_seen`/`store_flagged` → `LiveImapProvider` → Tauri 命令 → 前端），唯独 `answered` 一个 setter 也没有。
- **读侧更糟**：`live/imap.rs::fetch_inbox_summaries` 解析 `a4 FETCH {list} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])` 的响应行时只做 `line.contains("\\Seen")`，紧接着 `flags: EmailFlags { seen, flagged: false, answered: false }` —— 服务器在**同一条** `FLAGS (...)` 组里发来的 `\Flagged` 与 `\Answered` 被硬编码抹掉。于是即便用户先前用 `set_flagged` 打了星，重新 `list` 回来 `flagged` 也是 `false`（**写进去读不回来**）。
- **覆盖面**：`grep` 全 crate，`set_answered` / `store_answered` / `answered` 作为**写入目标**零命中。
- **修法**：
  - (a) **读侧按组解析三枚系统标志** —— 新增私有 `flag_group(line)`：取 lowercase 后定位 `flags (`，只截取到匹配的 `)` 之间的内容，再在其中做大小写无关的 `\seen`/`\flagged`/`\answered` 判定。只认该组可避免正文/主题里的**字面量** `\Seen` 冒充标志（RFC 3501 §2.3.2：系统标志大小写无关）；`EmailFlags` 三个字段改为真实解析值。
  - (b) **写侧补齐 `set_answered` 全链** —— `MailProvider` trait 加 `set_answered`（文档「Mark a message replied / un-replied」），`MockMailProvider` 落 `msg.answered`，`MailClient::set_answered` 转发，`live/imap.rs::store_answered` 发 `+/-FLAGS (\Answered)`，`live.rs` 再导出，`LiveImapProvider::set_answered`（仅支持 INBOX，与 `set_seen`/`set_flagged` 同），`amos-tauri::mail_set_answered` 命令（`check_mail_name` 校验 + 注册进 `lib.rs`），前端 `backend.ts::mailSetAnswered` + `MailApp.svelte` 阅读器里的「标为已回复 / 已回复」切换钮 + zh/en 文案 + `backend.test.ts` 路由断言。
  - (c) 订正 `live/imap.rs` 模块头的过时命令清单「STORE (Seen/Flagged)」→ `(Seen/Flagged/Answered)`。

### 18.2 为什么算「真缺陷」而非整洁度

1. **声明了一条代码未建立的属性** —— 模型层声明「已回复」，而写侧无任何 setter、读侧把服务器权威状态常量覆盖。与 F-SH-070/072/076/077/079/080/082/083 同族。
2. **两个方向同时背离** —— 读侧是**静默数据丢失**（星标 / 已回复在列表里永远丢失；无错、无告警），写侧是**能力缺失**（客户端无法标记已回复）。合起来 `answered` 在任何 provider、任何路径下都**永不**为真。
3. **测试盲区** —— 既有 `fetch_headers_parses_subject_from_and_seen_flags` 的桩服务器只发 `FLAGS (\Seen)`，从未在同一行发过 `\Flagged`/`\Answered`，故读侧的丢标志一直绿。

### 18.3 验证与负控（实测）

- `cargo test -p amos-mail` ⇒ **29 lib（+1）**（`provider::tests::answered_flag_toggles_and_persists`：mock 置真后 `list` 见真、置假后 `fetch` 见假）。
- `cargo test -p amos-mail --features live` ⇒ **45（+4）**：`fetch_headers_reads_flagged_and_answered_from_the_flags_group`（服务器发 `FLAGS (\Seen \Flagged \Answered)` ⇒ 三枚皆真；对照组第 2 封 `FLAGS ()` 但**主题含字面量 `\Seen`** ⇒ 三枚皆假，证明 `flag_group` 只认标志组）、`store_answered_sends_the_answered_flag_command`、`set_answered_via_live_provider`。
- `cargo check -p amos-tauri` ⇒ `Finished`；`cargo clippy -p amos-mail --all-targets --features live -- -D warnings` ⇒ **0 警告**；`cargo fmt -p amos-mail -p amos-tauri -- --check` ⇒ **净**；前端 `npm test -- --run` ⇒ **exit 0（3780 pass / 0 fail）**；`node scripts/rust-unwired-scan.mjs` ⇒ **585 文件 / 21 unwired（0 new）/ 1 orphan（OK）**；`node scripts/tauri-command-scan.mjs` ⇒ **282 registered（OK）**；`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 295 条**；`node scripts/trace-scan.mjs` ⇒ **OK**。
- **负控（逐字节还原 + sha256）**：三处同时注入修复前语义 —— 读侧回写死 `let flagged = false; let answered = false;`、`store_answered` 回发 `\Seen`、mock 回写死 `msg.answered = false;` ⇒ **恰 4 红**，即四条新测试，其余 **41 绿**；`cp /tmp/imap.rs.good /tmp/provider.rs.good /tmp/imap_provider.rs.good` 逐字节还原（`diff -q` 净、sha256 `5050d3bb…` / `7019040e…` / `1b59a760…` 与快照一致）后复绿 45。

### 18.4 诚实边界

1. **未接真实 IMAP 服务器**：三枚标志的解析与 `STORE` 命令由 loopback 桩服务器钉住，**未做**对真实公网 IMAP 的联调。
2. `LiveImapProvider::set_answered` 仅支持 `INBOX`（与既有 `set_seen`/`set_flagged` 一致），非 INBOX 返回诚实的 not-yet-supported 错误。
3. **未自动在回复时置位**：本轮建立的是「可显式标记」的能力；`send` **不会**自动把被回复的信标为 `\Answered`（那需要 `in_reply_to` 与线程解析，是另一项工作）。
4. `LiveImapProvider::fetch` 的 `body_html: None` 仍在（取信侧 MIME 解析，另一项工作）。
5. `MockMailProvider::send` 仍只把 `to` 存进副本（`EmailSummary` 本就没有 cc 字段）。
6. **并发取号**：A601（媒体轮 F-MED-002）、A602（上一轮 F-SH-083）已被占，A603 落笔前用 `grep` 重探（最高号 A602）后取 **A603 / F-SH-084**。

## 19. 第十四轮：Rust 模块审计（`amos-profiling` 推理剖析，`ProfileTracker::ttft_ms`，REQ-A605 / F-SH-085，2026-09-20）

**起点**：用户接着说「继续审计与补全代码」。对象是零 FMEA 的 `crates/amos-profiling`（on-device 推理剖析 / 功耗估算）。判定纪律不变（找「一条被声明的属性/能力，代码里没有任何路径建立它」）。

### 19.1 发现与修法

**`ProfileTracker::ttft_ms` —— 一条被声明的延迟（「首字延迟，按每次请求计」）被算成一个无界的累计和。**

- **承诺**：`crates/amos-profiling/src/tracker.rs` 的 `ttft_ms` 文档写「Time-to-first-token estimate (ms): dominated by the prompt-eval wall of the **most recent stretch**」—— 一个**延迟**量（量纲 ms/请求，不随请求数变化）。
- **代码**：返回体是 `self.prompt_wall.as_secs_f64() * 1000.0`，而 `prompt_wall` 是**所有** prefill 段的 `Duration` 之和（`record` 里 `self.prompt_wall += wall`）。于是 K 次各 150 ms 的 prefill 报 `150·K` ms —— 一个**累计时间**被印成一次请求的**延迟**。
- **合并更错**：`merge` 把两个 tracker 的 `prompt_wall` 相加，合并两条各含一次 150 ms prefill 的 tracker 得 300 ms —— 一个「合起来的延迟」这种东西根本不存在。
- **覆盖面**：`grep` 全 crate，`prompt_records` 只在 `record`/`merge`/getter 与 `report` 的 `prompt_records` 字段出现，**没有任何**地方用它去除 `prompt_wall`（「按请求平均」这条路径从未被建立）。
- **修法**：
  - (a) **返回按请求的均值** —— `ttft_ms()` 改为 `safe_div(self.prompt_wall.as_secs_f64(), self.prompt_records as f64).map(|secs| secs * 1000.0).unwrap_or(0.0)`；`safe_div` 守卫分母，空 tracker ⇒ `0`，绝非 `NaN`/`inf`。
  - (b) **文档改为如实描述机制** —— 写清「the **mean** prefill wall per prompt-eval stretch … not a running sum」，并点明与守护进程 `amos-ai::profiler` 的 `ttft_us_total / ttft_samples` 是**同一定义**，两处因此一致。
  - (c) **`report.rs` 字段文档同步**（「mean prefill wall per prompt-eval stretch」）。
  - (d) **把区分性钉成 3 条用例**（见 §19.3）。

**选均值而非「最近一次」的理由**：tracker 有意只保存无损的**和**（结构文档「intentionally dumb and lossless about the *sums*」），「最近一次」无法从和里推得，且会让 `merge` 无定义；均值是唯一与「无损和 + 记录数」这套设计自洽的每请求量，也正是守护进程已经在报的那个量。

### 19.2 为什么算「真缺陷」而非整洁度

1. **声明与算术不符** —— 文档说的是「最近一次」，代码给的是「所有次之和」；两种读法都与代码不符。
2. **量纲错误且无界** —— TTFT 是这组指标里**唯一**没有归一化的量（邻居 decode TPS = `tokens / wall`、ms-per-token = `1000 / TPS` 都是率）；它随采样数线性增长，同一份模型在长会话里显得越来越慢。
3. **与守护进程的定义不一致** —— `crates/amos-ai/src/profiler.rs` 用它自己的原子量报 `ttft_us_total / ttft_samples`（**均值**，其自测 `ttft_averages_across_samples` 断言 100+300 ⇒ 200），两个「同名的 TTFT」会给出不同的数，而 `amos-ai` 正是 `ProfileTracker` 的消费者。
4. **测试盲区** —— 既有 `decode_throughput_and_ms_per_token` 只喂**单次** prefill（和与均值相同），缺陷在一排绿测试下完整存活；一旦折入第二次 prefill 真值就发散。

### 19.3 验证与负控（实测）

- `cargo test -p amos-profiling` ⇒ **26 单元（+3）+ 0 doc** 全绿。
- `cargo clippy -p amos-profiling --all-targets -- -D warnings` ⇒ **0 警告**（P0-1 门）；`cargo fmt -p amos-profiling -- --check` ⇒ **净**；`cargo check -p amos-ai` ⇒ `Finished`（下游消费者）；`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 296 条**；`node scripts/rust-unwired-scan.mjs` ⇒ **585 文件 / 21 unwired（0 new）**；`node scripts/trace-scan.mjs` / `docs-link-scan.mjs` / `claim-scan.mjs` ⇒ **OK**；`node scripts/tauri-command-scan.mjs` ⇒ **282 registered（OK）**。
- 新增用例：`ttft_is_a_per_request_latency_not_a_running_sum`（两次 prefill 150 ms + 250 ms ⇒ **200.0** ms 而非累计 **400**；再折 400 ms ⇒ **800/3** 而非累计 800）、`merged_ttft_stays_a_mean_not_a_sum`（两个各含一次 150 ms prefill 的 tracker `merge` ⇒ **150.0** ms 而非 **300**）、`empty_tracker_ttft_is_zero_not_nan`（空 tracker ⇒ `0.0`）。
- **负控（逐字节还原 + sha256）**：把 `ttft_ms()` 还原为修复前语义 `self.prompt_wall.as_secs_f64() * 1000.0`（累计和）⇒ **恰 2 红**（`ttft_is_a_per_request_latency_not_a_running_sum` / `merged_ttft_stays_a_mean_not_a_sum`），其余 **24 绿**（`empty_tracker_ttft_is_zero_not_nan` 仍绿 —— 空 tracker 的和也是 0，故判别力由另两条承担）；`cp /tmp/tracker.rs.good crates/amos-profiling/src/tracker.rs` 逐字节还原（`diff -q` 净、sha256 `4a0f79b7…` 与快照一致）后复绿 26。
- **流程更正（如实记录）**：本轮首次快照时把**修复前**的 `tracker.rs` 存成了「good」，导致首轮负控的还原把修复与新测试一并回退；发现后重建快照（对**修复后**状态取 sha256 `4a0f79b7…`），负控按上述重做并复绿。

### 19.4 诚实边界

1. **未接任何真实硬件功耗采样** —— 本轮只审计 `ttft_ms` 的算术；`ProfileReport::compute_sampled` 的窗口均值口径不变。
2. **未改 `ttft_ms` 的返回类型**（仍是 `f64`，空 tracker 为 `0.0`），未引入 `Option`，以免下游 `amos-ai` 与 `Display` 的既有调用点受影响。
3. `crates/amos-audio/src/lib.rs`（**另一 crate**）的 ASCII 图把 mock 麦克风写作 `MockMic`，而实际类型是 `SineMic`/`FrameMic`/`SilenceMic` —— 一处真实的文档笔误，但它不属于本轮对象 `amos-profiling`，**本轮未动**。
4. **并发取号**：A604 已被媒体轮（`docs/media.md` 的 `media_url` 发射半）占用，A605 落笔前用 `grep` 重探（最高号 A604）后取 **A605 / F-SH-085**。

## 20. 第十五轮：零 FMEA 盲区扫描（`amos-link-py` Python 绑定，`PyLinkMetrics::errors`，REQ-A608 / F-SH-088，2026-09-20）

### 20.1 选面

本轮继续「零 FMEA 盲区」扫描。前几轮已覆 `amos-profiling`（F-SH-085），本轮把仓内**尚未登记 FMEA、且不在工作区**的边角 crate 逐一读过：`amos-int-cli`、`amos-jni`、`amos-link-py`、`amos-link-cc`、`amos-mail-cli`。多数是文档齐备、测试到位的干净实现（`amos-int-cli` 的 REPL、`amos-link-cc` 的 C ABI 错误路径、`amos-mail-cli` 的 `imap-unseen`/`send` 分支都审过，未发现「声明了却没建立」）。命中点在 **`amos-link-py`**：PyO3 绑定里一个暴露给 Python 的健康读数。

### 20.2 发现与修法

`crates/amos-link-py/src/lib.rs::PyLinkMetrics::errors`：

- **声明**：`/// Get total errors`，与 `published`/`delivered`/`dropped`/`delivery_ratio` 并列，是 Python 侧可读的健康面。
- **代码**：返回体硬编码 `0`，注释写「MetricsSnapshot doesn't have errors field, return 0」。
- **前提是假的**：`crates/amos-link/src/metrics.rs` 的 `MetricsSnapshot` 确有 `decode_errors` 与 `encode_errors`（`LinkMetrics::record_decode_error`/`record_encode_error` 写入、`snapshot()` 读出），且 `amos-link/src/health.rs` 早已用它们判定 `LinkHealth::Degraded`。于是同一份错误计数，Rust 侧与 health 报告都看得见，唯独 Python 绑定把它抹成一个常量。
- **修法**：`errors()` 返回 `snap.decode_errors + snap.encode_errors`（`snap = self.inner.snapshot()`），与 Rust 真相一致；删掉与代码相悖的陈旧注释；新增可判别的 Rust 单测；并把 Python 测试里那条恒真断言（`assertGreaterEqual(metrics.errors, 0)`）收紧为「新节点恰为 0」。

### 20.3 为什么算「真缺陷」而非整洁度

判据是「一条被声明的属性/能力，代码里没有任何路径建立它」：`errors` 被声明为「总错误数」，而**没有任何路径**把错误计数喂给它 —— 它恒为 `0`。对 Python 侧（以 `amos-link` 做编排/健康门控的上层）而言，这是一个**恒真的假信号**：`metrics.errors == 0` 会被读成「链路无错误」，而 `MetricsSnapshot` 明明记录了非零错误、health 报告也在据此判 Degraded。相邻四个 getter 都真实读快照，唯独这个不是 —— 是同组里唯一的异类。

### 20.4 验证与负控（实测）

- `cd crates/amos-link-py && cargo test` ⇒ **1 单元（+1）/ 0 failed**（修复前该 crate 跑 **0** 条）。
- `cargo clippy --all-targets` ⇒ 本改动**零**新增告警。
- **负控（逐字节还原 + sha256）**：把 `errors()` 还原为修复前语义 `0` ⇒ **恰 1 红**（`metric_errors_reports_the_snapshots_error_counters`），`cargo test` 由 1 passed 变 1 failed；`cp /tmp/link_py_lib.rs.good` 逐字节还原（`diff -q` 净、sha256 `d3a8463676d88f8da666b8951621d5024f123a1de6ee30c0eb88eddcd3324b4f` 与快照一致）后复绿 1。
- 台账：`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 299 条**；`trace-scan` / `docs-link-scan` / `claim-scan` ⇒ **OK**。

### 20.5 诚实边界

1. **该 crate 不在工作区**：`crates/amos-link-py/Cargo.toml` 用空 `[workspace]` 表把自己排除在顶层工作区之外、`crate-type = ["cdylib"]`，只用 maturin 构建 ⇒ `cargo test -p amos-link-py` 不适用，测试命令是 `cd crates/amos-link-py && cargo test`；工作区的那些门（`rust-unwired-scan` / `tauri-command-scan` 等）**不覆盖**它。
2. **两处既有瑕疵未动**：`cargo fmt -- --check` 在该文件**修复前即**对 import 块报差异；6 条 pyo3 `deprecated` 告警亦为既有 —— 两者**不在本轮范围**，未改动，如实记录以免被误记为回归。
3. **未补 P0-1 门**：该 crate 头部**没有** `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]`。属独立议题（可能牵出既有代码的 unwrap），本轮为避免扩大改动面未加。
4. **同族反向缺口**：`PyLinkMetrics` **未**暴露 `blocked`（`MetricsSnapshot` 有该字段）—— 这是「声明的能力少于数据」，与缺陷同族但方向相反，本轮未动，留作后续。
5. **未做真机/Python 端到端**：判别性证据是 crate 内的 Rust 单测（`errors()` 无 `Python` 参数，纯 Rust 可构造断言）；`tests/test_amos_link.py` 只做了断言收紧，未在 `maturin develop` 后跑一遍 pytest。
6. **并发取号**：A606/A607 已被占，A608 落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 重探（最高号 A607）后取 **A608 / F-SH-088**。

---

## 21. 第十六轮：零 FMEA 盲区扫描（`amos-link-cc` C ABI 订阅者计数，`amos_link_subscriber_stats`，REQ-A609 / F-SH-089，2026-09-20）

### 21.1 选面

本轮先按「零 FMEA、且尚未审读」的清单扩面：`amos-wm`（窗口管理器，五个纯域模块全部逐行读过：`lib.rs` 的状态机 + `form.rs` 的形态策略 + `identity.rs` 的窗口身份 + `layout.rs` 的几何 + `split.rs` 的分屏会话）、以及 `appstore-cli`/`asr`/`audio`/`clipboard`/`display`/`flashlight`/`int-cli`/`jni`/`mail-cli`/`proto`/`robot`/`tts` 等。`amos-wm` 的文档密度与不变量测试（2000 步确定性属性测试 + `assert_wm_invariants`）都很扎实，未命中；`robot` 是 8140 行的大核、留作后续单独一轮。命中点在**上一轮（§20.1）曾整体扫过、当时判为「C ABI 错误路径干净」的 `amos-link-cc`** —— 本轮把它当作「有 C 头文件声明、就有可核对的契约」重新逐函数读，在**订阅者计数**这一函数上撞见与 F-SH-088 同族的缺陷：声明了一个测量，返回了一个常量。

### 21.2 发现与修法

`crates/amos-link-cc/src/lib.rs::amos_link_subscriber_stats`：

- **声明**：`crates/amos-link-cc/amos_link.h` 把 `received` / `dropped` / `decode_errors` 定义为 `struct amos_link_sub_stats` —— 订阅者的运行计数；函数 `amos_link_subscriber_stats(sub, stats)` 供 C 调用方读取。
- **代码**：函数体写 `(*stats).received = 0; (*stats).dropped = 0; (*stats).decode_errors = 0;`，注释写「Stats are maintained in the background thread; return zeros for now」。
- **前提是假的**：后台读取线程（`SimpleSubscriber` 的 spawn 循环，lib.rs 内）只把帧转发进 std mpsc，**从不累加任何计数**；全仓没有任何自增落到这三个字段。所谓「maintained in the background thread」是空头支票。
- **为什么没被测出来**：既有测试 `subscriber_stats_returns_zeros` 反而把这段桩**钉成合同**（断言全零），于是缺陷在一排绿下完整存活 —— 与 F-SH-088 里那条恒真断言 `assertGreaterEqual(metrics.errors, 0)` 是同一种「测试保护了缺陷」。
- **修法**：在 `SimpleSubscriber` 上加 `received` / `decode_errors` 两个 `Arc<AtomicU64>`；后台读取线程在 `subscription.recv()` 成功处 `received.fetch_add(1)`、在 `Err(_)`（解码失败并继续读取）处 `decode_errors.fetch_add(1)`；`amos_link_subscriber_stats` 读出真值。`dropped` 保持 `0` —— 因为 reader→caller 的 std mpsc 通道**无界**、确实从不丢帧（此时 0 是**事实**而非占位，写进函数文档）；上游 QoS 队列的丢弃由 `amos_link_node_metrics` 报告，未复制一条平行的丢帧计数。删掉与代码相悖的陈旧注释，改写为真值语义（`received` = 已到达订阅者的帧，尚未 poll 的也算）。

### 21.3 为什么算「真缺陷」而非整洁度

判据是「一条被声明的属性/能力，代码里没有任何路径建立它」：C 头文件声明了三个订阅者计数器，而**没有任何路径**去建立它们 —— 三个字段恒为 `0`。对 C 调用方（以 `amos-link-cc` 做机器人中间件的上层）而言，这是一个**恒零的假信号**：读到 `received == 0 && decode_errors == 0` 无法区分「确实没有帧」与「这函数从不计数」。与 F-SH-088 完全同构：同组里其它读数（`amos_link_node_metrics` 读的是真实快照）都真实，唯独这一个不是。

### 21.4 验证与负控（实测）

- `cargo test -p amos-link-cc` ⇒ **92 passed / 0 failed**（+1 新测试 `subscriber_stats_count_delivered_frames`）。
- `cargo clippy -p amos-link-cc --all-targets` ⇒ 本改动**零**新增告警。
- **负控（逐字节还原 + sha256）**：把 getter 还原为修复前语义（写三个 `0`）⇒ **恰 1 红**（`subscriber_stats_count_delivered_frames`，同套件的 `subscriber_stats_null_returns_neg2` 仍绿），`cargo test` 由 2 passed 变 1 failed；`cp /tmp/link_cc_lib.rs.good` 逐字节还原（`diff -q` 净、sha256 `56c3b19e55f3e682089977d215486ca27b869c5247d7c38b1428a831ef14ad80` 与快照一致）后复绿 2。
- 台账：`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 300 条**；`trace-scan` / `docs-link-scan` / `claim-scan` ⇒ **OK**。

### 21.5 诚实边界

1. **新测试依赖同节点 loopback**：判别证据是「在同节点发一帧、轮询到 `Ready` 后断言 `received >= 1`」；同节点 in-process loopback 是既有 `pub_sub_roundtrip_single_message` 已在用的机制，本轮**未**做多节点/真实传输（Zenoh/LAN）的端到端。
2. **`dropped` 仍恒 0**：这是无界通道的**事实**，不是本轮偷懒 —— 真正会丢帧的地方是上游 QoS 队列，那一层由 `amos_link_node_metrics` 的 `dropped` 报告，本轮未在此函数里复制一条平行计数（避免「一条规则两处实现」）。
3. **未改 C 头文件**：`amos_link_sub_stats` 的字段定义保持原样（`received` / `dropped` / `decode_errors`），只让实现符合它。
4. **上一轮的漏检已被记录**：§20.1 曾把 `amos-link-cc` 整体判为「C ABI 错误路径干净」而放过，本轮说明**错误路径**确实干净、漏的是**计数路径** —— 审计面从「错误路径」扩到「有头文件声明的每一个契约」才撞上。
5. **并发取号**：A608 已被上一轮占用，A609 落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 重探（最高号 A608）后取 **A609 / F-SH-089**。

---

## 22. 第十七轮：零 FMEA 盲区扫描（`amos-asr` 流式语音识别，utterance 时间边界，REQ-A611 / F-SH-090，2026-09-20）

### 22.1 选面

从零 FMEA 条目、且「有对外声明的属性/契约」的模块里挑 —— 本轮落到 `crates/amos-asr`。它是本地流式 ASR 的实现层，对上实现 `amos_int::Pipeline`，是整条「听 → 译 → 说」链路里**唯一直接看到音频**的组件。切入点是它的输出事件 `AsrEvent::Final`：该事件携带 `start` / `end` 两个 `Duration` 字段，下游（`amos_int::segment`）把它们读作「Approximate utterance start/end (wall-clock offset within the session)」——一个**被声明的测量量**。

### 22.2 发现与修法

**发现**：`crates/amos-asr/src/pipeline.rs` 里两处构造 `AsrEvent::Final` 的地方（`feed_audio` 的端点分支、`end_of_utterance` 的强制 flush）都把 `start` / `end` 写死为 `Duration::ZERO`。整条流水线里**没有任何路径**去建立这两个时间 —— 没有时钟、没有累加、没有从样本数推时长。同名的硬编码 `ZERO` 亦见于 `crates/amos-int/src/session.rs` 的 mock 管线（599/655 行）与 `reset_builder`、以及 `crates/amos-translate/src/grpc_pipeline.rs`（188/189 行）。于是每个定稿话语（`Segment`）都自称落在 t=0 且零宽度：一条**恒零的假信号**。而 `AsrPipeline` 恰恰是唯一有资格说出真值的一层 —— 它按块吃 PCM，只要记下吃了多久即可。

**修法**：给 `AsrPipeline` 装一条**音频时钟**。新增内部状态

```rust
struct AsrState<R> { recognizer: R, fed: Duration, utterance_start: Duration }
```

`feed_audio` 在端点判定**之前**按 `chunk.len() / SAMPLE_RATE_HZ`（16 kHz）累加 `fed` —— 这样触发端点的那个 final 的 `end` 会把「刚吃进、完成了这句」的这块音频算进去；`Final { start: utterance_start, end: fed }`，端点后 `utterance_start = fed`（下一句从这句结束处起算）。`end_of_utterance` 用同一对取值并同样推进 `utterance_start`。样本→时长的换算抽成 `samples_to_duration`，采样率常量化 `const SAMPLE_RATE_HZ: u32 = 16_000`，与 `Pipeline::feed_audio` 声明的「16 kHz f32」约定同源（160 样本 = 10 ms）。

### 22.3 为什么算「真缺陷」而非整洁度

判据是「一条被声明的属性/能力，代码里没有任何路径建立它」：`Segment.start` / `Segment.end` 的文档明写是「wall-clock offset within the session」的测量，而**没有任何路径**去建立它 —— 两处构造点恒写 `ZERO`。对下游消费者（翻译/会议记录/时间轴 UI）而言，这是一个**恒零的假信号**：时间轴永远退化成「所有话语都在 t=0」，且无法区分「真的从 0 开始」与「这层从不测量」。与 F-SH-088 / F-SH-089 完全同构（同族 F-SH-*：**声明的测量/能力，无路径建立**）；区别在于本轮的替身是**时间戳**而非计数器，且它落在唯一能看到音频的那一层，修复即「让已有的信息被记录」。

### 22.4 验证与负控（实测）

- `cargo test -p amos-asr` ⇒ **7 passed / 0 failed**（+1 新测试 `finalized_utterance_carries_its_real_time_bounds`）。
- `cargo clippy -p amos-asr --all-targets` ⇒ 本改动**零**新增告警。
- `cargo test -p amos-int` ⇒ **42 passed / 0 failed**（下游 `Segment` 消费方无回归）。
- **负控（逐字节还原 + sha256）**：把 `feed_audio` 的 `Final` 取值还原为修复前语义（`start: Duration::ZERO, end: Duration::ZERO`）⇒ **恰 1 红**（`finalized_utterance_carries_its_real_time_bounds`），`cargo test -p amos-asr` 由 7 passed 变 6 passed / 1 failed；`cp /tmp/asr_pipeline.rs.good` 逐字节还原（`diff -q` 净、sha256 `aa384fb2c0c8dcb0beeb853a1db564feb420b2c022fef3073c7af1d846f116e9` 与快照一致）后复绿 7。
- 台账：`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 301 条**；`trace-scan` / `docs-link-scan` / `claim-scan` ⇒ **OK**。

### 22.5 诚实边界

1. **只建立了流式这一条路径的时钟**：`session.rs` 的 mock 管线与 `grpc_pipeline.rs` 的同名硬编码 `ZERO` **未在本轮改动** —— 前者是测试替身，后者的上游本就不经过本地音频时钟，两者属独立议题，本轮不越界改动。
2. **采样率是声明的名义值**：时钟按 16 kHz 换算；若调用方实际以别的速率灌入 `feed_audio`，时间会有比例偏差。该速率是 `Pipeline::feed_audio` 文档声明的约定（「16 kHz f32」），本轮以声明为准，**未**新增运行时采样率参数（避免为一个未出现的需求加接口）。
3. **`PartialSegment` 不带时间**：本轮只修 `Final` 的时间边界，未给部分假设（partial）扩字段 —— 那属于另一条声明面。
4. **测试用既有 mock 识别器**：判别证据是「喂 3 帧 10 ms 音频后断言首句 `[0, 30ms]`、次句 `[30ms, 60ms]`」，走的是既有 `MockStreamingRecognizer`，**未**接真实声学模型/音频文件端到端。
5. **并发取号**：A610 已被他轮（NFC/BLE 屏）占用，A611 落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 重探（最高号 A610）后取 **A611 / F-SH-090**。

## 23. 第十八轮：零 FMEA 盲区扫描（`amos-flashlight` 手电未确认信号，REQ-A613 / F-SH-092，2026-09-20）

### 23.1 选面

从零 FMEA 条目、且「有对外声明的属性/契约」的模块里挑 —— 本轮落到 `crates/amos-flashlight`（手电管理器）与其 Tauri 桥接 `crates/amos-tauri/src/flashlight.rs`。它是一个策略-拥有型的管理器（provider 是「哑寄存器」，全部规则住在 manager 里、可单测），对上通过桥接层暴露给 System UI，并定义了一组 wire code 供前端/日志消费。

### 23.2 发现与修法

**发现**：桥接层 `crates/amos-tauri/src/flashlight.rs` 的 `pub mod codes` 声明了 `PROVIDER_UNCONFIRMED = "amos.flashlight.provider_unconfirmed"`，文档写它是「Torch request reached the provider, but the device did not confirm the change (Android: `setTorchMode` returned false / silent failure)」—— 一条**具名的静默失败信号**。但全仓 grep 该常量只命中其**声明**与一条「断言常量在 `codes::ALL` 里可见」的稳定性测试：**没有任何代码路径发出它**。`flashlight_set` 调 `bridge.manager.set_on(enabled)` 后直接 `persist` 并返回快照 —— 从不比较「请求的 on」与「provider 权威报告的 on」，于是「provider 报 Ok 却根本没动」的静默失败被当成成功镜像给了 UI。

更根上的问题在 `crates/amos-flashlight/src/provider.rs`：`FlashlightProvider::set_on` 的文档**谎称**它「Returns the boolean the backend reported」，而签名是 `async fn set_on(&self, on: bool) -> Result<()>`。真相是 Android `setTorchMode` 本就是 void、也没有 `getTorchMode` —— **无从取得每调确认**；确认只能由「请求 vs 权威快照」的比较**推得**，而这一步从未发生。

**修法**：在 `FlashlightManager` 上新增
```rust
pub async fn set_on_checked(&self, on: bool) -> Result<(FlashlightState, bool)>
```
`confirmed = snap.lit() == on`，其中 `snap` 取自 provider 的**权威**报告（不是调用方的意图）。`FlashlightProvider::set_on` 的文档订正为「`Ok(())` = accepted without error，无每调确认布尔，确认由 `set_on_checked` 比较请求与权威快照得出」。桥接层 `flashlight_set` 改用 `set_on_checked`，`!confirmed` 时 `tracing::warn!(code = codes::PROVIDER_UNCONFIRMED, requested = enabled, actual = snap.on, …)` —— **建立了该 wire code 的产生路径**。

### 23.3 为什么算「真缺陷」而非整洁度

判据是「一条被声明的属性/能力，代码里没有任何路径建立它」：`PROVIDER_UNCONFIRMED` 被**声明**为一条具名信号（其文档精确描述了 Android 的静默失败场景），而**没有任何路径**发出它 —— 一条**死 wire code**。对运维/诊断而言这是「宣称能报警、实际永不报警」：真实的静默失败会被静默。与 F-SH-088 / F-SH-089 / F-SH-090 完全同构（同族 F-SH-*：**声明的测量/能力/信号，无路径建立**）；区别在于本轮的替身是**日志信号**而非计数器或时间戳，且它牵出一个**与代码相悖的文档**（provider 谎称返回确认布尔）。修复即「让已经存在的意图产生真实事件」。

### 23.4 验证与负控（实测）

- `cargo test -p amos-flashlight` ⇒ **14 passed / 0 failed**（+2 新测试 `set_on_checked_confirms_a_provider_that_honours_the_request`、`set_on_checked_flags_a_silent_failure`）。
- `cargo test -p amos-tauri --lib flashlight` ⇒ **7 passed / 0 failed**（桥接层无回归）。
- `cargo clippy -p amos-flashlight -p amos-tauri --all-targets` ⇒ 本改动**零**新增告警。
- **负控（逐字节还原 + sha256）**：把 `set_on_checked` 的确认判据还原为恒真语义 `Ok((snap, true))` ⇒ **恰 1 红**（`set_on_checked_flags_a_silent_failure`），`cargo test -p amos-flashlight` 由 14 passed 变 13 passed / 1 failed；`cp /tmp/fl_manager.rs.good` 逐字节还原（`diff -q` 净、sha256 `65d965cc81857ff45d3ab85015f9ebc549a97ecc2a0d28a106ea6d00ea1552b7` 与快照一致）后复绿 14。
- 台账：`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 303 条**；`trace-scan` / `docs-link-scan` / `claim-scan` ⇒ **OK**。

### 23.5 诚实边界

1. **只建立信号路径，未回传 UI**：本轮把未确认状态变成一条携带具名 code 的 `warn` 日志（`amos.flashlight.provider_unconfirmed` 终于有产生路径），**未**把它塞进 Tauri 命令的返回值或前端界面 —— `flashlight_set` 仍返回权威快照（那本就是真值），是否在界面上显式提示「未确认」属独立议题，本轮不越界。
2. **确认判据是状态比较**：`confirmed = snap.lit() == on` 只分辨「落定态与请求是否一致」，对「provider 只部分生效」的中间态不做更细分辨（该硬件接口本就没有更细的状态面）。
3. **无新增测量成本**：`set_on_checked` 内部走一次 `snapshot()`，而既有 `set_on` 路径本就会 snapshot 后返回 —— 未引入额外硬件往返。
4. **测试止于 crate/库级**：判别证据是「喂入接受写入却不改状态的 `StuckProvider` ⇒ `confirmed == false`」，走的是 `amos-flashlight` 的 provider 抽象与 `amos-tauri` 的 lib 级测试，**未**接真实 Android 手电硬件端到端。
5. **并发取号**：A611/A612 已被他轮占用，A613 落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 重探（最高号 A612）后取 **A613 / F-SH-092**。

## 24. 第十九轮：零 FMEA 盲区扫描（`amos-mail` 真实 IMAP 收件时间戳，REQ-A614 / F-SH-093，2026-09-20）

### 24.1 选面

从零 FMEA 条目、且「有对外声明的属性/契约」的模块里挑 —— 本轮落到 `crates/amos-mail`（邮件客户端域核）的**真实网络读取路径** `live/imap.rs`（`live` feature）。它是把本地 mock 换成真 IMAP 的那一层，对上实现 `MailProvider` seam，产物是 `EmailSummary`——一份「轻量元数据」（id/mailbox/from/to/subject/date/flags/attachment_count）。

### 24.2 发现与修法

**发现**：`crates/amos-mail/src/model.rs` 把 `EmailSummary.date` 文档写作「Unix epoch seconds」，且它是**承载语义**的字段 —— mock provider 存真实日期，`MailClient`/`provider.rs` 的 `list`/`search` 都按 `date` 做 newest-first 排序（`sort_by_key(Reverse((m.date, m.seq)))`）。但真实 IMAP 路径 `fetch_inbox_summaries` 构造 `EmailSummary { …, date: 0, … }`，发往服务器的命令是

```text
a4 FETCH … (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])
```

—— **只**要 From / Subject，**连 `Date` 头都没请求**；没有解析函数，也就无从建立这个测量。于是每一封真实邮件都自称发信于 Unix 纪元（1970-01-01），列表「最新在前」的排序退化为「全部相等」（回落到序列顺序）。

**修法**：两步 —— ①把数据要过来：FETCH 命令改为 `(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`；②落地一个纯解析器 `rfc5322_epoch(&str) -> Option<i64>`：去掉括号注释、丢弃可选的星期前缀、解析 `DD Mon YYYY HH:MM:SS ±ZZZZ`，两位数年份按 RFC 5322 的 00-49→20xx / 50-99→19xx，数值时区（`+HHMM`/`-HHMM`）与常见命名时区（GMT/UT/UTC/EST/PST…）都支持，用 Howard Hinnant 的 `days_from_civil` 算纪元秒再减去时区偏移。解析循环新增 `Date:` 分支：

```rust
} else if let Some(v) = hline.strip_prefix("Date:") {
    date = rfc5322_epoch(v).unwrap_or(0);
}
```

—— 能解析就写**真值**，不可解析 / 缺失才回落 `0`（既有「未知」哨兵），**绝不编造**。

### 24.3 为什么算「真缺陷」而非整洁度

判据是「一条被声明的属性/能力，代码里没有任何路径建立它」：`EmailSummary.date` 文档明写「Unix epoch seconds」，且下游排序真的依赖它，而**真实网络路径**上**没有任何路径**去建立它 —— 构造点恒写 `0`，连请求都没有。对用户而言这是一个**恒零的假读数**（每封邮件都「发信于 1970」），且无法与「真无日期」区分。与 F-SH-090（ASR `start`/`end` 恒 `Duration::ZERO`）完全同构：声明了一段时刻，返回了一个常量；区别在于本轮的「手」是网络请求——修法既有「让已有的信息被请求」也有「把已有格式解析成真值」。同族：F-SH-088 / F-SH-089 / F-SH-090 / F-SH-092。

### 24.4 验证与负控（实测）

- `cargo test -p amos-mail --features live` ⇒ **48 passed / 0 failed**（+3 新测试 `rfc5322_dates_convert_to_epoch_seconds`、`an_unparseable_date_is_none_not_a_fabricated_epoch`、`fetch_headers_carries_the_real_message_date`）。
- `cargo clippy -p amos-mail --features live --all-targets` ⇒ 本改动**零**新增告警。
- **负控（逐字节还原 + sha256）**：把 `Date:` 分支还原为修复前语义（恒 `date = 0`）⇒ **恰 1 红**（`fetch_headers_carries_the_real_message_date`；两条纯解析器用例仍绿，因其独立于调用点），`cargo test` 由 48 passed 变 47 passed / 1 failed；`cp /tmp/mail_imap.rs.good` 逐字节还原（`diff -q` 净、sha256 `73d9a35cd70878f2ae1d4d223da417929a85777b382ddbef998e3057575472ea` 与快照一致）后复绿 48。
- 台账：`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 304 条**；`trace-scan` / `docs-link-scan` / `claim-scan` ⇒ **OK**。

### 24.5 诚实边界

1. **`0` 仍表示「未知」**：本轮沿用既有哨兵（无 Date 头或不可解析时 `date = 0`），**未**把字段改成 `Option<i64>` —— 那会牵动 model 的序列化面与 UI 显示，属独立议题，不越界。
2. **解析器覆盖面**：支持 RFC 5322 常见形态（星期可选、两位数年、数值/命名时区、括号注释）与 obs-zone 的常见命名时区；**未**处理军事单字母时区（A–Z 除 J），未识别命名时区按 RFC 默认当 UTC（偏移 0）。
3. **`attachment_count` 未动**：真实路径同样写 `0`（FETCH 未请求 BODYSTRUCTURE），但 model 文档已注明「bodies are fetched separately」，属另一条声明面，本轮不扩大范围。
4. **测试止于进程内假服务器**：判别证据是「进程内 IMAP 服务器回一封带 `Date:` 头的邮件 ⇒ 断言其各自纪元秒（以 `date -u` 校准）」，并额外断言 FETCH 命令**确含 `DATE`**（防「解析器对了但没请求」的半修复）；**未**接真实 Gmail/IMAP 服务器端到端（TLS 握手本就需真服务器）。
5. **并发取号**：A613 已被前一轮占用，A614 落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 重探（最高号 A613）后取 **A614 / F-SH-093**。

## 25. 第二十轮：零 FMEA 盲区扫描（`amos-appstore` APK 安装版本码，REQ-A618 / F-SH-096，2026-09-20）

### 25.1 选面

从零 FMEA 条目、且「有对外声明的属性/契约」的模块里挑 —— 本轮落到 `crates/amos-appstore`（应用商店域核）的**设备侧安装路径** `client.rs`。它把「下载 → 校验 → 安装」的生命周期建在 `StoreProvider` 与 `PackageInstallerBridge` 两个 seam 之上：前者管网络与目录，后者管设备侧 `PackageInstaller`。APK 走的是与 web-bundle 不同的、诚实的设备路径（`install_apk`/`upgrade_apk`），产物是一次 `InstallRequest`。

### 25.2 发现与修法

**发现**：`crates/amos-appstore/src/android.rs` 的 `InstallRequest.version_code: u64` 文档原话是

```text
/// `versionCode` of the APK (used for upgrade bookkeeping).
```

—— 它是平台判断「这是升级还是重装、能不能降级」的整数键。但**唯一**的生产者 `crates/amos-appstore/src/client.rs::commit_apk` 恒填：

```rust
version_code: 0, // versionCode isn't part of the catalog model today
```

而这句注释**已不成立**：`AppManifest.version: Version`（`model.rs`）就在目录模型里，`fdroid::version_code_from(&Version) -> i64` 这个 base-1000 semver→`versionCode` 编码器也早就存在且有测试。于是**每一次**安装（`InstallMode::Full`）与**升级**（`InstallMode::InheritExisting`）递给 bridge 的 versionCode 都是 `0`。

**修法**：一步 —— 把可得的真值填进去，复用已有的、已测试的编码器：

```rust
version_code: version_code_from(&manifest.version).max(0) as u64,
```

（`.max(0)` 与同文件 `version_code_to` 的既有写法一致 —— `version_code_from` 本身 `saturating`，故其值恒非负；不发明新的编码。）该值只在 `PackageInstallerBridge` 缝隙处可见，于是新增一个会**记录** `open_session` 请求的测试桩 `RecordingBridge`（把 `req.version_code` 记进 `Arc<Mutex<Vec<u64>>>`），断言「装 1.0.0 带 1_000_000、升到 2.3.4 带 2_003_004」。

### 25.3 为什么算「真缺陷」而非整洁度

判据是「一条被声明的属性/能力，代码里没有任何路径建立它」：`InstallRequest.version_code` 文档明写「used for upgrade bookkeeping」，而**没有任何路径**去建立它 —— 构造点恒写 `0`。对平台侧而言这是一条**恒零的假读数**：每一次安装/升级都像「同一个 build」，分不出真升级与重装、做不了降级检测。与 F-SH-093（IMAP `EmailSummary.date` 恒 `0`）完全同构：声明了一个量，返回了一个常量；区别在于本轮的「手」是一条**已存在的编码路径**（`version_code_from` + `AppManifest.version`），修法是把它们接起来，而不是新增机制。同族：F-SH-088 / F-SH-089 / F-SH-090 / F-SH-092 / F-SH-093。

### 25.4 验证与负控（实测）

- `cargo test -p amos-appstore` ⇒ **123 lib + 5 集成 + 0 doc passed / 0 failed**（+1 新测试 `commits_carry_the_real_version_code_not_a_constant_zero`）。
- `cargo clippy -p amos-appstore --all-targets -- -D warnings` ⇒ **0 告警**。
- **负控（逐字节还原 + sha256）**：把 `version_code` 还原为恒 `0`（修前行为）⇒ **恰 1 红**（`commits_carry_the_real_version_code_not_a_constant_zero`；`left: [0, 0]` vs `right: [1000000, 2003004]`），其余 122 绿；`cp /tmp/appstore_client.rs.good` 逐字节还原（`diff -q` 净、sha256 `ea8422e954c427e21f31f52e3230dce6c089730a00000d33a6af3b567e23c488` 与快照一致）后复绿 123。
- 台账：`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 308 条**；`trace-scan` / `docs-link-scan` / `claim-scan` ⇒ **OK**。

### 25.5 诚实边界

1. **未新增以 versionCode 为准的平台侧消费者**：本改动建立的是「声明的量被填成**真版本**」这条路径，而非改变既有行为 —— `SideloadOnlyBridge` 仍把 `req.version_code` **整个忽略**，实际记账发生在**设备侧** bridge（📱，device-bringup）。这是与 F-SH-093 同一类诚实边界：修的是「声明与建立之间缺的那条路」，不是「平台已按它判定」。
2. **只编码 `major.minor.patch`**：`Version.pre`（预发布标签）不进 versionCode，与 `fdroid::version_code_from` 的既有语义一致（且该函数文档已写明 base-1000 拆分只在 minor/patch < 1000 时是精确逆）。
3. **测试止于 bridge 缝隙**：判别证据是「记录型桩收到的 `InstallRequest.version_code`」，而非真机 PMS 的升级判定 —— 后者需真设备。
4. **未动 `SideloadOnlyBridge`**：它是「无 JNI 后端时的诚实占位」，本轮不替它发明 versionCode 语义。
5. **并发取号**：A617 / F-SH-095 在编辑期间被另一轮（PhotosApp 查看器）占用，A618 落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 重探（最高号 A617）后取 **A618 / F-SH-096**。

---

## 26. 第二十一轮：零 FMEA 盲区扫描（`amos-appstore-cli` 帮助文本与运行器分叉，REQ-A619 / F-SH-097，2026-09-20）

### 26.1 选面

在 §25 之后继续按「零 FMEA、且尚未审读」的清单扩面：`amos-clipboard`、`amos-display`、`amos-tts`、`amos-audio`、`amos-proto`、`amos-jni` 等都已逐行读过且未命中（文档密度高、不变量测试扎实），`amos-robot` 是 8140 行大核、仍留作单独一轮。本轮落到**上一轮（§25.1）刚碰过的邻域** `crates/amos-appstore-cli`（应用商店 CLI）—— 它有一个**面向人的契约面**：`USAGE` 帮助文本。CLI 的帮助文本是唯一发现面，故它「声明了什么」与「代码建立了什么」必须一致；这恰好是 F-SH 族（声明了一个性质、代码里没有路径建立它）的**新变体**：这次声明的是**一条不存在的回落路径**，而代码建立的是硬拒绝。

### 26.2 发现与修法

**①声明**：`crates/amos-appstore-cli/src/lib.rs` 的 `USAGE`（`--catalog` 一行）原话是「Requires building with --features live (default build **ignores it**)」——它声明的是「默认构建**静默忽略** `--catalog` 并**回落到**离线 demo 目录」这一行为。

**②代码**：同文件的 `run_with_catalog` 在非 `live` 构建里**明确报错** `"--catalog needs a live build: …"`，其函数注释甚至写着「a clear error so a user isn't **silently handed the offline demo catalog**」——代码建立的是**硬拒绝**，与帮助文本声明的「静默忽略」**正好相反**；兄弟行 `--repo` 并无「ignores it」字样，可见这是**漂移**而非本意。

**③同一次漂移的第二处**：`download` 子命令**必需** `--out <PATH>`（缺了就报错 `"download needs --out <PATH> …"`），但 `OPTIONS` 列表**从未列出**该选项——一个被声明的能力（`download`）缺了它唯一的输出目的地，用户按帮助文本照做只会在运行期撞错。

**④为什么没被测出来**：既有测试从不把 `USAGE` 当契约来断言（没有一条检查帮助文本与实际分叉行为是否一致），doc 与 code 这两份真相各活各的，漂移在整排绿下存活。

**⑤修法（不改行为，只修声明）**：`--catalog` 一行改为如实描述「without it the command **refuses loudly rather than silently falling back** to the demo」；`OPTIONS` 补上 `--out <PATH>  With download: where to write the verified package bytes (required — `download` refuses without it).`。硬拒绝与必需 `--out` 都是**正确实现**，修的只是**声明**（一处规则一处实现，不向错误文本对齐代码）。

**⑥在契约面断言**：新增判别测试 `usage_documents_the_catalog_refusal_and_the_download_destination`（断言 `USAGE.contains("--out <PATH>")` **且** `!USAGE.contains("ignores it")`，修复前两条皆红），另加行为钉 `a_non_live_build_refuses_catalog_rather_than_falling_back`（`#[cfg(not(feature = "live"))]`，钉住帮助文本所描述的真行为）。

### 26.3 为什么算「真缺陷」而非整洁度

1. **两条真相不一致且方向相反**：帮助文本说「沉默退到 demo」，代码说「大声报错退出」。用户读到帮助文本后预期（默默用 demo）与实际（命令失败）**正好相反**——这不是措辞不精确，是**声明了一条代码里不存在的路径**（F-SH 族定义）。
2. **必需输入不可发现**：`download` 的 `--out` 在 `OPTIONS` 里不可见，用户只能靠运行期报错才发现它存在——被声明的能力却缺了宣告，与 ③ 同一处漂移。
3. **判别测试有真靶子**：把帮助文本还原为修前的「ignores it」⇒ 判别测试恰 1 红（见 26.4 负控）——证明断言咬在真差异上，而非恒真。

### 26.4 验证与负控（实测）

- `cargo test -p amos-appstore-cli` ⇒ **16 passed / 0 failed**（默认无 `live`）；`cargo test -p amos-appstore-cli --features live` ⇒ **17 passed**。
- **负控（逐字节还原 + sha256）**：把 `USAGE` 的 `--catalog` 一行还原为修前的「(default build ignores it)」⇒ **恰 1 红**（`usage_documents_the_catalog_refusal_and_the_download_destination`，因 `contains("ignores it")` 成立），其余 15 绿、行为钉测试仍绿；`cp /tmp/appstore_cli.rs.good` 逐字节还原（sha256 `5e804eb9c1a7451fc44f200dcf8e101025e5f634bdd3d9b32d67caf1daf78bfa` 与快照一致，`diff -q` 净）后复绿 16。

### 26.5 诚实边界

1. **未改 `run_with_catalog` 的硬拒绝**：帮助文本向代码对齐，不是代码向文本对齐——「宁可报错不静默回落」本身是正确的。
2. **未改 `download` 对 `--out` 的必需性**：只把它补进 `OPTIONS` 的发现面，运行期检查原样。
3. **行为钉测试的构建条件**：`a_non_live_build_refuses_catalog_rather_than_falling_back` 只在默认（无 `live`）构建下运行，`--features live` 时被 `#[cfg]` 排除（那条路径下 `--catalog` 本就成功），故 live 构建计数为 17 而非 18——这是**有意的**，不是漏测。
4. **未做真机/真终端联调**：证据是 `USAGE` 文本断言与 `run(...)` 的错误串断言，纯函数级，无需设备。
5. **并发取号**：A618 / F-SH-096 为本轮前一步，A619 落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 重探后取。

---

## 27. 第二十二轮：零 FMEA 盲区扫描（`amos-mail-cli` 收件人按旗标分类，REQ-A621 / F-SH-098，2026-09-20）

### 27.1 选面

在 §26 之后继续按「零 FMEA、且尚未审读」的清单扩面。目标是在上一轮（§26）的邻域再找一个**面向人的契约面**——`crates/amos-mail-cli`（应用商店 CLI 之外的第二个 CLI）自带一段 `USAGE` 帮助文本，其 `send` 子命令声明了 `--to`/`--cc` 的语义。本轮不只看帮助文本本身，而是顺着声明一路读到**执行体** `build_draft`，在那里撞见 F-SH 族的新变体：**声明的收件人分类语义，在输入重叠时没有任何代码路径建立它**。

### 27.2 发现与修法

**①声明**：`crates/amos-mail-cli/src/lib.rs` 的 `USAGE` 写着 `send --to <ADDR> [--to ...] [--cc ...]`——一个 `--to` 地址是**主收件人**（To 头），一个 `--cc` 地址是**抄送**（Cc 头），两个由旗标区分的列表。

**②代码**：`build_draft` 原写成 `for raw in a.to.iter().chain(a.cc.iter())` + `let is_cc = a.cc.iter().any(|c| c == raw)`——即"这个地址只要在 `--cc` 里出现过，就当 Cc"，分类依据是**列表成员资格**而非**来源旗标**。

**③后果（静默的收件人损坏）**：当一个地址**同时**出现在 `--to` 与 `--cc`（自己抄送自己、把通讯组既放 To 又放 Cc），`--to` 那一份被送进 Cc（**To 里没有任何代码路径建立它**），`--cc` 那一份又被 `push` 一次 ⇒ **To 少一个、Cc 多一个重复**。常见的一格 `--to a@x --cc a@x` ⇒ To 空、Cc=`[a,a]`，而 `has_recipients()` 仍为真，照样发送。这既不是报错也不是警告，是一条"成功发送"的成功路径产物。

**④为什么没被测出来**：既有的 `dispatch_send_puts_copy_in_sent` 只喂**单一** `--to`，`--cc` 与 `--to` 从不重叠，成员资格判断在这条路上与来源判断**恰好等价**，缺陷在整排绿下存活（与 F-SH-093/F-SH-097 同族：声明了一个属性，代码里没有路径建立它）。

**⑤修法**：两个列表**各自独立地按来源旗标构建**（`for raw in &a.to { draft.to.push(...) }` 与 `for raw in &a.cc { draft.cc.push(...) }` 各成一段），**删掉成员资格判断**（`is_cc`/`any`）——分类只由"来自哪个旗标"决定。每段各自保序、仍逐个 `Address::bare(...).context("invalid recipient address")` 校验。**不改 `USAGE`**：声明本已正确，修的是建立；`has_recipients` 只看"两列表合计非空"，与本缺陷无关。

**⑥在产物面断言**：新增判别测试 `to_and_cc_are_classified_by_flag_not_by_membership`——`build_draft` 进 `--to a@x,bob@x` + `--cc a@x,carol@x`，断言 `to == [a@x, bob@x]` **且** `cc == [a@x, carol@x]`。

### 27.3 为什么算「真缺陷」而非整洁度

1. **静默的收件人损坏**：一个被声明为主收件人（To）的地址在重叠输入下不进 To——收件人**收不到**按要求的主送通知，同时抄送列表被塞入重复项；没有报错、没有警告。
2. **不是"非法输入"**：同一地址既是主收件人又是抄送人是明确定义的语义（收一次即可）。靠"把重复当非法输入直接拒绝"来回避，等于**拒绝了合法输入**——诚实做法是按旗标正确分类。
3. **判别测试有真靶子**：把分类还原为成员资格判断 ⇒ 判别测试恰 1 红（`left: ["bob@x.io"]` vs `right: ["ada@x.io", "bob@x.io"]`，见 27.4 负控）——证明断言咬在"To 少了谁"这一真差异上。

### 27.4 验证与负控（实测）

- `cargo test -p amos-mail-cli` ⇒ **16 passed / 0 failed**（+1）；`cargo clippy -p amos-mail-cli --all-targets -- -D warnings` ⇒ **0 告警**。
- **负控（逐字节还原 + sha256）**：把分类还原为成员资格判断（`is_cc = a.cc.iter().any(...)`，修前行为）⇒ **恰 1 红**（`to_and_cc_...`：`left: ["bob@x.io"]` vs `right: ["ada@x.io", "bob@x.io"]`——To 里确实少了 `ada`），其余 15 绿；`cp /tmp/mail_cli.rs.good` 逐字节还原（sha256 `8811c22b90e07da37f07faea8e79ec2f4f42c3cc28d279d647724d3c0f144d3c` 与快照一致，`diff -q` 净）后复绿 16。

### 27.5 诚实边界

1. **未改 USAGE / `parse_send`**：声明与旗标解析本就正确，本轮的错在 `build_draft` 的**建立**。
2. **未改 `has_recipients`/`compose`/`send` 既有语义**：与"两列表合计非空"无关。
3. **判别证据止于 `build_draft` 产物**：直接读 `draft.to`/`draft.cc`，未做真 SMTP 投递复跑——但同一函数也是 `smtp_send_lines`（live）的构建入口，故 live 路径共享该修复。
4. **观察但本轮未修**：四个 live-SMTP 旗标（`--smtp`/`--smtp-user`/`--smtp-pass`/`--smtp-tls`）被 `parse_send` 接受且 `smtp_send_lines` 全实现，却**未出现在 `USAGE`**——把一条已建立的 live 能力从发现面上漏掉（方向与 F-SH-097 相反：那里是声明了不存在的路径，这里是路径没有声明），留作后续一轮。
5. **并发取号**：A620 已被另一轮（`amos-translate` gRPC 时间窗，F-TR-002）占用，A621 落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 重探（最高号 A620）后取 **A621 / F-SH-098**。

## 28. 第二十三轮：零 FMEA 盲区扫描（`amos-int-cli` 裸 `.lang` 静默无操作，REQ-A623 / F-SH-100，2026-09-20）

### 28.1 选面

在 §27 之后继续按「零 FMEA、且尚未审读」的清单扩面。前两轮都落在**面向人的 CLI 契约面**（`amos-appstore-cli` 的 `USAGE`、`amos-mail-cli` 的收件人分类），本轮继续这一邻域，选 `crates/amos-int-cli`——文本同声传译 CLI，其 REPL 的 `exec_line` 是纯接缝、由 `MockPipeline` 驱动，**可在宿主上判别测试**（这是本轮的先决条件：此前排除的 `amos-audio` 的 tinyalsa 缺陷虽真、却因 `#[cfg(target_os="android")]` 不可宿主测试，`amos-link-py` 的 `.pyi` 漂移虽真、却因非 Cargo 成员不可门测）。本轮撞见 F-SH 族的新变体：**一个被声明「跑不起来的命令绝不沉默」的性质，在「缺参」这一格没有任何代码路径建立它**。

### 28.2 发现与修法

**①声明**：`crates/amos-int-cli/src/lib.rs` 的 `USAGE` 写着 `.lang <LANG>  Hint / set the source language`——`.lang` 需要一参数；而 `report` 的文档明写本 REPL 的不变量「The REPL prints nothing when a command *works* … a command that could not run must therefore never be silent」，并列出三个曾被静默丢弃的情形（`.start` 忙、`.restart` 运行中、`.lang` 死会话）。

**②代码**：`exec_line` 的 `.lang` 分支原写成 `if let Some(l) = parts.next() { report(...) }`——**裸 `.lang` 落到 `if` 之外，什么都不推**（`out` 为空）。缺参是一条**跑不起来**的命令，却与「成功」一样安静，正是该文档要消灭的病；作者修了三个死会话/忙态情形，**漏了这一格**。

**③后果**：用户漏写语言标签时，屏幕毫无反应，无法区分「命令成功但无输出」与「命令根本没跑」。`report` 只处理「已进入分支后的 `Err`」，进不了分支的缺参情形从它旁边绕过去了——与 `.restart`/`.start` 的已修情形同类，只是漏了一格。

**④为什么没被测出来**：既有 `status_and_lang_commands` 只喂 `.lang ja`（带参数），从不喂裸 `.lang`；其余用例只断言「成功的命令不报错」与「被拒的命令要报错」，裸 `.lang` 这条**被拒却沉默**的路径在整排绿下存活（与 F-SH-092/F-SH-096 同族：声明了一个性质，代码里没有路径为缺参这一格建立它）。

**⑤修法**：`.lang` 分支改为 `match parts.next() { Some(l) => report(...), None => out.push("  [error] .lang: missing <LANG>") }`——与 `report` 对 `.restart`/`.start` 的具名拒绝同一形状（`  [error] .{cmd}: {e}`）。**不改 USAGE**：声明本就是 `.lang <LANG>`，修的是建立。

**⑥在产物面断言**：新增判别测试 `bare_lang_without_a_tag_is_reported_not_silently_ignored`——喂裸 `.lang`，断言 `out` 含恰为 `  [error] .lang: missing <LANG>` 的一行。

### 28.3 为什么算「真缺陷」而非整洁度

1. **一个被拒的命令不可观测**：用户漏写语言标签时屏幕毫无反应，无法区分「成功但无输出」与「没跑」。
2. **与既有契约自相矛盾**：同文件的 `report` 文档正宣称消灭这种病，而 `report` 结构上够不到「缺参」这一格。
3. **判别测试有真靶子**：把分支还原为修前的 `if let Some(...)` ⇒ 判别测试恰 1 红（`out` 为空，见 28.4 负控）——证明断言咬在「沉默 vs 报错」这一真差异上。

### 28.4 验证与负控（实测）

- `cargo test -p amos-int-cli` ⇒ **7 passed / 0 failed**（+1）。
- **负控（逐字节还原 + sha256）**：把 `.lang` 分支还原为修前的 `if let Some(l) = parts.next() { report(...) }`（缺参静默）⇒ **恰 1 红**（`bare_lang_without_a_tag_is_reported_not_silently_ignored`：`out` 为空），其余 6 绿；`cp /tmp/int_cli.rs.fixed` 逐字节还原（sha256 `b2b75a52ce433079fdd15c055f4e4bea89b7ac27396667e9250592012b19a170` 与快照一致）后复绿 7。

### 28.5 诚实边界

1. **未改 USAGE 与 `parse_from`**：声明与旗标解析本就正确，本轮的错在 `exec_line` 的**建立**。
2. **未改其余命令分支的既有行为**：它们已各自 `report` 或直接推送。
3. **未为顶层的空命令名（`.`）加具名拒绝**：它落在 `other` 分支、已产出 `unknown command: .`，与本缺陷不同。
4. **判别证据是 crate 级单测**：`exec_line` 是纯接缝、由 `MockPipeline` 驱动，**未做**真 `amos-translate` 守护进程端到端。
5. **并发取号**：A622 已被另一轮（`amos-tauri` display 桥，F-SH-099）占用，A623 落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 重探（最高号 A622）后取 **A623 / F-SH-100**。

## 29. 第二十四轮：零 FMEA 盲区扫描（`amos-clipboard`/`amos-tauri` 镜像文本上界不可达，REQ-A629 / F-SH-104，2026-09-20）

### 29.1 选面

本轮撞见 F-SH 族的新变体：**一个被声明为「单次镜像纯文本拷贝的上界」的常量，没有任何路径建立它——而且它宣称的上界恰恰落在一个不可达处**。这不是「声明了一条不存在的路径」（如 F-SH-097），也不是「路径没有声明」（如 F-SH-101），而是**声明与实现各说各话、且声明的数字比能到达的数字大**。选面来自对 `crates/amos-robot`（16.8k 行、零 FMEA、最大未覆盖面）的系统排查：其 `driver`/`slam`/`control`/`mrac`/`vision` 各模块已被前序审计写得极密（判决词多已自认边界、常数多已被生产路径读取），首轮可选缺陷偏弱；转而在 `amos-clipboard` 的 wire 契约面撞见一个更干净、**可宿主判别**的缺口（`encode`/`FrameDecoder`/`GuestSink` 都是纯接缝）。

### 29.2 发现与修法

**①声明**：`crates/amos-clipboard/src/proto.rs` 定义 `pub const MAX_MIRROR_TEXT: usize = 1 << 20;`，文档直书「Upper bound on a single mirrored plain-text copy」；内核自身的文本上界 `crates/amos-tauri/src/clipboard.rs:42` 的 `MAX_TEXT_LEN` 也是同一 `1 << 20`——主机接受的拷贝上界与 wire 声明的镜像上界**本是同一个数**。

**②代码**：`MAX_JSON_LEN` 旧值也是 `1 << 20`，文档还写「Matches the text cap」。但 `encode` 是长度前缀 JSON，`{"PushText":{"seq":N,"ts_ms":N,"text":"…"}}` 的外壳恒使 `json.len() > text.len()` ⇒ **恰好 `MAX_MIRROR_TEXT` 字节的文本的 JSON 必然越过 `MAX_JSON_LEN`**，被 `encode` 拒绝——声明的上界没有任何路径能建立，实际可镜像的最大文本比声明的**少一个外壳宽度**。

**③主机路径不作为**：`GuestSink::push_out`（`crates/amos-tauri/src/clipboard_guest.rs`）在镜像前既不比对 `MAX_MIRROR_TEXT`，文本落在 `(MAX_JSON_LEN − 外壳, 1 MiB]` 时只以一个答非所问的 `clipboard frame exceeds 1048576 bytes` 失败——本应报「镜像文本超限」的路径报的是「帧超限」。

**④为什么没被测出来**：既有 proto 用例 `encode_rejects_payload_over_max_json` 用 `"x".repeat(MAX_MIRROR_TEXT + 1)` 断言「拒绝」，而 `+1` 恰好**同时**越过了帧上界，于是「上界不可达」这一格从没被单独钉住；`MAX_MIRROR_TEXT == MAX_JSON_LEN` 又让 `decoder_buffer_stays_bounded_*` 一类测试照常绿。

**⑤修法**：`MAX_JSON_LEN = MAX_MIRROR_TEXT + JSON_ENVELOPE_HEADROOM`（新增私有常量 `JSON_ENVELOPE_HEADROOM: usize = 512`，文档写明它预留 `{"PushText":{…}}` 外壳、并**如实**注明不覆盖 JSON 转义膨胀），让上界**可达**；并在 `push_out` 里对 `text.len() > MAX_MIRROR_TEXT` 给出**具名**拒绝（`mirrored text is N bytes, over the …-byte cap`，与紧邻的 image-only 拒绝同一形状，且在武装 echo guard **之前**）。**不改** `MAX_MIRROR_TEXT` 的值——它与内核 `MAX_TEXT_LEN` 对齐是**声明**而非缺陷，改的是帧侧预留与路径侧检查。

**⑥在产物面断言**：`proto.rs` 新增 `a_mirror_text_at_the_declared_cap_fits_one_frame`（恰好 1 MiB 编码并原样解码回来）；`clipboard_guest.rs` 新增 `sink_mirrors_a_text_at_the_declared_mirror_cap`（整条主机路径：恰好 1 MiB 的 entry 写出恰一帧并解码回来）与 `sink_refuses_a_text_over_the_declared_mirror_cap`（超 1 字节以具名文案被拒、wire 为空、echo guard 未武装）。

### 29.3 为什么算「真缺陷」而非整洁度

1. **声明与实现分叉**：一个 `pub` 常量宣称的上界是**谎**——按它行事（镜像一个恰好 1 MiB 的拷贝）必被拒，且拒绝理由指向了错误的层（帧而非文本）。
2. **错误的诊断**：真正的原因（文本超限）被泛用的帧超限信息吸收，与 F-SH-102「更具体的码被泛用码吸收」同族。
3. **判别测试有真靶子**：两半注入各自只红对应的测试（见 29.4），证明断言咬在「可达/不可达」与「具名/泛用」这两处真差异上。

### 29.4 验证与负控（实测）

- `cargo test -p amos-clipboard` ⇒ **60 passed / 0 failed**（+1）；`cargo test -p amos-tauri --lib clipboard_guest` ⇒ **14 passed / 0 failed**（+2）；`cargo test -p amos-tauri --lib` ⇒ **652 passed / 0 failed**；`cargo clippy -p amos-clipboard -p amos-tauri --all-targets` ⇒ **0 告警**；`cargo fmt -p amos-clipboard -p amos-tauri -- --check` ⇒ **净**。
- **负控（两半，逐字节还原 + sha256）**：①把 `MAX_JSON_LEN` 还原为 `1 << 20`（修前语义）⇒ **恰 2 红**（`a_mirror_text_at_the_declared_cap_fits_one_frame`、`sink_mirrors_a_text_at_the_declared_mirror_cap`），而 `sink_refuses_a_text_over_the_declared_mirror_cap` **仍绿**（超 1 字节先在上界检查处被具名拒绝，够不着帧上界）——正是「两半各自判别一格」的实证；②删掉 `push_out` 的文本上界检查 ⇒ **恰 1 红**（`sink_refuses_a_text_over_the_declared_mirror_cap`），其余 13 绿。两次注入后均 `cp /tmp/proto.rs.fixed`／`/tmp/clipboard_guest.rs.fixed` 逐字节还原（sha256 `d8ebcef554aa7b9ef94b63d68f6ae90e12ce48836b00fefb455df73546b5c9d6`／`a04f57d086c439d188e846640072ac229375250fa09474aac234f7b652bd0707` 与快照一致，`diff -q` 净）后复绿。

### 29.5 诚实边界

1. **未改** `MAX_MIRROR_TEXT` 的值与内核 `MAX_TEXT_LEN`——两者对齐是**声明**，缺陷在帧侧预留与路径侧检查。
2. **未**为 JSON 转义膨胀预留：纯引号的「1 MiB 文本」仍是 2 MiB 帧，`JSON_ENVELOPE_HEADROOM` 的文档**如实**写明此限。
3. **未改** 解码侧：`FrameDecoder` 引用的仍是 `MAX_JSON_LEN`，随常量自动跟进。
4. **判别证据是 crate 级单测**：`encode`/`FrameDecoder`/`GuestSink` 都是纯接缝，**未做** 真机 Waydroid 端到端。
5. **并发取号**：A628／F-SH-103 落笔时**已被另一轮**（`amos-tauri` BLE/NFC 事件名）占用，A629／F-SH-104 于重探（最高号 A628／F-SH-103）后取用。

## 30. 第二十五轮：零 FMEA 盲区扫描（`amos-tauri` host_fs 写侧默认上限无路径建立，REQ-A633 / F-SH-106，2026-09-20）

### 30.1 选面

本轮延续 F-SH 族：**一条被声明的度量（写侧「默认 8 MiB 上限」）在代码里没有任何路径建立它**。选面用两种口径收敛：①零 FMEA 覆盖的 crate 只剩 `amos-audio`／`amos-jni`／`amos-proto`／`amos-tts`（皆已在前序轮被合理排除：Android-only `#[cfg]`、需 JVM、宏／协议壳）；②于是改用全仓启发式——找「只有定义、无引用」的 `pub const`。`grep` 出多个 count-1 常量后，`crates/amos-tauri/src/host_fs.rs` 的 `DEFAULT_WRITE_CAP` 最干净：模块边界表**明写**「Write cap | 8 MiB default, `bytes` parameter up to 64 MiB」，读侧确实有对应的 `cap_check(args.cap, DEFAULT_READ_CAP, MAX_READ_CAP)`，而写侧**连 `cap` 字段都没有**——声明的默认档无人建立。判别接缝是纯函数（`cap_check`）与无 I/O 依赖的命令入口（临时根 + 小负载即可），可宿主判别。

### 30.2 发现与修法

**①声明**：`host_fs.rs` 模块文档的边界表写着「Write cap | 8 MiB default, `bytes` parameter up to 64 MiB」；`pub const DEFAULT_WRITE_CAP: usize = 8 * 1024 * 1024;` 的文档旧值写「Same ceiling for writes — anything bigger should chunk via `host_fs_write_bytes` calls with the caller-side loop.」

**②代码**：读侧 `Args { path, cap: Option<usize> }`，`host_fs_read_text`/`host_fs_read_bytes` 走 `cap_check(args.cap, DEFAULT_READ_CAP, MAX_READ_CAP)`——缺省回落 8 MiB、封顶 64 MiB。写侧的 `WriteArgs { path, content }` 与 `WriteBytesArgs { path, data_b64 }` **没有 `cap`**，两个写命令各自只判 `> MAX_WRITE_CAP` ⇒ `DEFAULT_WRITE_CAP` 是**死常量**（全仓零引用），一次 8 MiB+1…63 MiB 的写**静默通过**。

**③为什么没被测出来**：唯一的写上限测试 `write_text_refuses_oversized_content` 用 `MAX_WRITE_CAP + 1`，恰好**只**钉到天花板；「默认档」这一整段行为无人问（读侧的 `read_text_truncates_at_cap` 只覆盖读）。

**④修法**：给 `WriteArgs`／`WriteBytesArgs` 各加 `#[serde(default)] pub cap: Option<usize>`，两个写命令改走与读侧**同一个** `cap_check(args.cap, DEFAULT_WRITE_CAP, MAX_WRITE_CAP)`——默认 8 MiB、可显式抬到 64 MiB 天花板，写读对称；`write_bytes` 判在**解码后**的 `bytes.len()`（base64 文本膨胀 ~4/3，绝不能对 base64 串判长）；删掉「chunk via `host_fs_write_bytes`」旧说（`write_bytes` 是整文件原子替换，chunk 并不成立）。`hostFs.ts` 两个写包装补 `cap?: number` 形参（`cap: cap ?? null`）并订正文档。

**⑤不改值**：`MAX_WRITE_CAP`／`DEFAULT_WRITE_CAP` 的值（8 MiB／64 MiB）**不动**——缺陷在「写侧是否真的用上默认值」，不在数值本身。

**⑥在产物面断言**：新增 4 条判别／配套测试（见 30.4），既有 6 处 `WriteArgs`/`WriteBytesArgs` 字面量补 `cap: None`；前端 `hostFs.test.ts` 两条 args 断言加 `cap: null`，并新增 `write_text forwards an explicit cap`。

### 30.3 为什么算「真缺陷」而非整洁度

1. **声明与实现分叉**：模块边界表与常量文档都宣称写侧默认 8 MiB，代码却把整档默认交给 64 MiB 天花板——按文档行事（以为 8 MiB 默认）会误判内核对大写的态度。
2. **限流少了一档**：读有 8 MiB 默认、写一律放到 64 MiB，一个本该在默认档被拒的粘贴型大写入直落 I/O 路径。
3. **判别测试有真靶子**：两条判别测试在修前树**必红**（8 MiB+1 无 `cap` 不被拒），而另两条配套测试（抬 `cap`／夹 `cap`）在修前树**仍绿**——证明断言咬在「默认档是否存在」这一处真差异上，且不误伤。

### 30.4 验证与负控（实测）

- `cargo test -p amos-tauri --lib host_fs` ⇒ **31 passed / 0 failed**（+4：`write_text_refuses_content_over_the_default_cap_with_no_cap_arg`、`write_bytes_refuses_decoded_content_over_the_default_cap`、`write_text_admits_over_default_when_cap_is_raised_to_the_ceiling`、`write_text_clamps_a_cap_above_the_ceiling`）；`bun test src/lib/__tests__/hostFs.test.ts` ⇒ **19 passed / 0 failed**（+1）；`cargo clippy -p amos-tauri --all-targets -- -D warnings` ⇒ **0 告警**；`cargo fmt -p amos-tauri -- --check` ⇒ **净**。
- **负控（逐字节还原 + sha256）**：把两处 `if … > cap` 改回 `> MAX_WRITE_CAP`（修前语义）⇒ **恰 2 红**（`write_text_refuses_content_over_the_default_cap_with_no_cap_arg`、`write_bytes_refuses_decoded_content_over_the_default_cap`），而 `write_text_admits_over_default_when_cap_is_raised_to_the_ceiling` 与 `write_text_clamps_a_cap_above_the_ceiling` **仍绿**——正是「判别测试各自单判一格、配套测试不误伤」的实证；注入后 `cp /tmp/host_fs.rs.fixed` 逐字节还原（sha256 `a68dadba4031f45cd65c296e4b7366ea6cc0816d4273a1fe0b859231ff1a809e` 与快照一致，`diff -q` 净）后复绿 31。

### 30.5 诚实边界

1. **未改** `MAX_WRITE_CAP`／`DEFAULT_WRITE_CAP` 的**值**（8 MiB／64 MiB）；改的是「写侧是否真的用上默认值」。
2. **未**在 TS 层加「自动分块」：分块与整文件原子替换语义冲突，故文档改为「抬 `cap` 而非分块」。
3. **未做** 真机端到端：证据是 crate 级单测（`cap_check` 与两个写命令都是纯接缝）+ 前端 wire-arg 单测。
4. **无生产前端调用** `host_fs_write_*`（`FilesApp.svelte` 只导入 `hostFsReadDir`/`hostFsReadText`），故默认档收紧**不影响**现有 UI 路径——这也是本轮把默认收紧当作安全改动的前提。
5. **并发取号**：A630／F-MDM-001、A631／F-SH-105、A632／F-DEV-089 均**已被其他轮**占用，A633／F-SH-106 于落笔前重探（最高号 A632／F-SH-105）后取用。

## 31. 第二十六轮：零 FMEA 盲区扫描（`amos-tauri` 两条声明了触发条件却无人发射的拒绝码，REQ-A637 / F-SH-109，2026-09-20）

### 31.1 选面

本轮把「被声明的属性」推向**错误码词汇表本身**：`ErrorCode` 枚举（`crates/amos-tauri/src/error.rs`）声明了 78 条 wire code，每条都带一句「何时该发它」的文档。审计口径换成「每个**枚举变体**在 `error.rs` 之外是否至少有一处构造（`ErrorCode::X`）」——这属 F-SH 族（「声明与建立之间没有路径」）的一个新切面：statement 的不是一个常量/度量，而是一条**具名拒绝**。前序轮已扫过零 FMEA 的 crate（只剩 `amos-audio`／`amos-jni`／`amos-proto`／`amos-tts`，皆已合理排除）与「只有定义无引用」的 `pub const`，本轮改扫「只有声明无人构造」的枚举变体。

### 31.2 发现与修法

**①声明**：`NfcNotInitialized`（`error.rs:143`，`"amos.nfc.not_initialized"`）——「`nfc_status` / `nfc_write_message` / etc. was called before the NFC glue was initialized (no Activity has run `onStart` to hand up the Context)」；`BiometricNoActivity`（`error.rs:146`，`"amos.biometric.no_activity"`）——「`biometric_authenticate` was called without an Activity-bound prompt (the Kotlin glue requires a `FragmentActivity` to host `BiometricPrompt`)」。

**②代码（修前）**：解析 `as_str()` 的 78 个变体、数每个变体在 `error.rs` 之外的构造——**恰两条为 0**。而**孪生的 `BleConnectFailed` 是被发射的**：`ble_connect`（`ble.rs:214`）在 `with_context` 返回 `None`（`android_jni::BINDING` 未装 = 没有 Activity 调过 `onStart` 的 `install`）时 `Err(AmosError::new(BleConnectFailed, "BluetoothGattGlue not bound"))`。NFC／生物识别的孪生路径把**同一个**「绑定不存在」条件降级成 `Ok(payload { ok: false, error: "NfcGlue not bound" | "biometric not initialized" })`——一个**成功**信封携带一句自由文本。

**③为什么没被测出来**：`error.rs` 自身的测试只遍历 `as_str()` 的**字符串**（`wire_codes_are_frozen` / `codes_are_distinct_stability_keys`），不要求任何变体有**构造点**；`rust-unwired-scan` 扫的是 `pub fn` 而非枚举变体；NFC／生物识别命令在 host 侧也没有任何测试钉住返回形状。于是「声明了却无人发」既不被编译期发现（变体是 `pub` 枚举的一部分，`dead_code` 不响）也不被任何门禁发现。

**④修法（一处构造 + 两条命令共用）**：新增 `fn nfc_not_initialized() -> AmosError` 与 `fn biometric_no_activity() -> AmosError`（feature-independent——JNI 调用只在 `--features android` 下编译，但「绑定缺失」这个**决定**与 feature 无关），把 `nfc_write_message` 的 `with_context` `None` 与 `not(android)` 分支、`biometric_authenticate` 的 `BIOMETRIC_STATE.get()` `None` / `!fired` / `not(android)` 分支全部改指这两个 helper：宿主侧既无 Activity 也无 glue，正是所声明条件的 **a fortiori** 实例，且 off-device 是唯一能 `cargo test` 触达该判定的形态。与 `ble_connect`→`BleConnectFailed` 的既有范式对齐。

**⑤不改值**：`error.rs` 的两条字符串与 `as_str()` 映射逐字未动（**无 wire 变更**）；`nfc_status`（探针，按文档返回 `NfcStatusResult` data）与 `nfc_format_tag`／`nfc_read_bytes` 亦未改——本轮只把文档明确点名的**写**路径接上具名拒绝。为了不误报，前端两个包装（`nfc.ts` 的 `nfcWriteMessage`、`biometric.ts` 的 `biometricAuthenticate`）在 `Err` 下走各自的 `r ?? { ok: false, error: "not bridged" }` 回落，仍按 `ok:false` 渲染错误。

**⑥在产物面断言**：新增 `#[cfg(test)] mod tests`（3 条，见 31.4）。

### 31.3 为什么算「真缺陷」而非整洁度

1. **声明与实现分叉**：`error.rs` 以文档承诺「unbound glue ⇒ 具名拒绝」，代码却把它降级成 `Ok{ok:false}` 携带自由文本——调用方无法区分「没初始化」与「能力不存在」「标签自己拒绝了写」。
2. **孪生路径行为分叉**：同文件的 `ble_connect` 对**同一条件**发具名 `Err`，NFC／生物识别却发 `Ok`——一致性被打破且无人钉住。
3. **判别测试有真靶子**：两条判别测试在修前树**必红**（`expect_err` 直接 panic，panic 消息里可见注入后的 `Ok(payload)`），配套的 `the_two_wired_refusals_are_distinct` 在修前树**仍绿**——证明断言咬在「是否发具名拒绝」这一处真差异上。

### 31.4 验证与负控（实测）

- `cargo test -p amos-tauri --lib` ⇒ **660 passed / 0 failed**（657 + 3 新增）；`cargo test -p amos-tauri --lib ble::tests` ⇒ **3 passed**（`nfc_write_message_refuses_an_unbound_glue_with_the_declared_code`、`biometric_authenticate_refuses_without_an_activity_bound_prompt`、`the_two_wired_refusals_are_distinct`）。
- `cargo clippy -p amos-tauri --all-targets` ⇒ **0 warning**；`cargo check -p amos-tauri --features android` ⇒ **净**（android 分支的改动同样编译——这是「host 侧接缝与 on-device 路径同修」的证据）；`cargo fmt`（amos-tauri）⇒ **净**。
- **负控（逐字节还原 + sha256）**：把 host 两分支改回 `Ok(...)`（修前语义）⇒ **恰 2 红**——`nfc_write_message_refuses_an_unbound_glue_with_the_declared_code`（panic：`an unbound NFC glue must refuse, not return an Ok payload: NfcWriteResult { ok: false, bytes_written: None, error: Some("NFC not available") }`）与 `biometric_authenticate_refuses_without_an_activity_bound_prompt`（panic：`…: BiometricResult { ok: false, result: None, error: Some("biometric not available") }`），而 `the_two_wired_refusals_are_distinct` **仍绿**；注入后 `cp /tmp/round26/ble.rs.fixed` 逐字节还原（sha256 `669f0619569e69158f2a55c5c734d7500be32533adf4feb985028ba2c6104f44` 与快照一致、`diff -q` 净）后复绿 3。

### 31.5 诚实边界

1. **未**新增 wire code、**未**改任何现有 code 的**值**与 `as_str()` 映射——故**无 wire 变更**，`error.rs` 的 78 条冻结测试不受影响。
2. **未**改 `nfc_status`（探针，按文档返回 `NfcStatusResult` data）、`nfc_format_tag`、`nfc_read_bytes`——文档点名的「`nfc_status` / `nfc_write_message` / etc.」中本轮只把**写**路径接上具名拒绝，其余留待后续轮（同一族的下一条候选）。
3. host 分支 `Ok{ok:false}` → `Err` 是**形状**变更；前端 `nfcWriteMessage`／`biometricAuthenticate` 均按 `ok:false` 分支渲染错误，无崩溃、无「按了没反应」。
4. **未**区分 `with_context` 的两种 `None`（绑定缺失 vs 内层 JNI 调用失败，二者都被映射为绑定缺失）——与 `ble_connect` 对 `None` 的既有处置一致（那里同样只发 `BleConnectFailed`）。
5. **未做** 真机端到端：证据是 host 单测 + clippy + `--features android` 类型检查 + `fmea-gen --check`；**未**做全仓 `cargo test --workspace`。
6. **并发取号**：编号 A635 已被并发的 `rust-discard-scan` 轮在其 A636 条目里声明占用（该 FMEA 号在仓库中零足迹但已被声称），故本轮于落笔前重探后改用 A637／F-SH-109。
7. **并发导致的瞬时不可构建（非本轮改动）**：本轮收尾时 `crates/amos-tauri/src/webman_download.rs`（REQ-A636 轮的文件，非本轮触碰）处于**未配平的括号**中间态——`rustfmt`/`cargo` 报 `unexpected closing delimiter`（452–460 行），致 `cargo test -p amos-tauri` 整体无法编译。上文 31.4 的 **660 passed** 实测于该文件被改坏**之前**（同一会话内先绿后红）；`ble.rs` 自身 `rustfmt --edition 2021 --check` **净**、`cargo clippy` 与 `cargo check --features android` 亦在该中间态之前完成。**未**去改动/修复他轮的在写文件（避免覆盖其进行中的工作），如实记录该树状态。

## 32. 第二十七轮：零 FMEA 盲区扫描（`amos-audio` 设备 seam 的 `pcm.h` 漂移哨兵，REQ-A642 / F-SH-112，2026-09-20）

### 32.1 选面

第二十六轮把「被声明的属性」推到错误码词汇表之后，剩下的零 FMEA 面是**只在一个 target 上编译的代码**：`crates/amos-audio/src/android/` 整块被 `#[cfg(all(any(feature = "tinyalsa", feature = "aaudio"), target_os = "android"))]` 关在门外——`cargo test` 在 host 上从不构建它。本轮挑 `android/tinyalsa.rs`（AOSP TinyALSA 的 `pcm.h` FFI 绑定）：它自己没有一条逻辑缺口，但它**声明**了一条「bring-up 测试可断言 header 未漂移」的属性，而可断言的载体活在 host 够不着的 cfg 后面——这正是 F-SH 族（「一条被声明的属性/能力，代码里没有任何路径建立它」）在**设备侧**的化身。

### 32.2 发现与修法

**①声明**：`header_layout_notes()` 的文档说这些是把 `pcm.h` 事实「surfaced so Android bring-up tests can assert the header has not drifted」。「has not drifted」是一条**被声明为可断言**的属性。

**②代码（修前）**：`pcm.h` 的契约在 seam 里是**三处彼此独立的拼写**——`header_layout_notes()` 返回的字面串、`mod fmt`／`mod flags` 的常量、`#[repr(C)] struct PcmConfig` 的字段序与 `PcmConfig::new` 的周期算式。`grep` 全仓 `header_layout_notes`，**唯一**出现处就是它自己的定义：零测试、零消费者——该函数是纯装饰。又因为整个 `android` 模块只在 `target_os = "android"` 下编译，host 上连这个符号都不存在，`cargo test -p amos-audio` 对它零覆盖。

**③为什么没被测出来**：三个拼写没有任何一处互校。一处转写失误——`PcmConfig` 两字段换位、或 `PCM_MONO` 写成 `2`——**全平台编译通过**，只在设备上以错误的 flags 字交给 `pcm_open`、或以垃圾 `period_size` 现形；没有任何 host 测试或门禁能看见。

**④修法（一处声明 + host 可测）**：把**纯 Rust 事实**抽到新的 host 编译模块 `crates/amos-audio/src/tinyalsa_layout.rs`（无 `extern "C"`、无 android cfg）——`fmt`／`flags` 模块、`#[repr(C)] PcmConfig`、`PcmConfig::new`、`header_layout_notes` 全数迁入并在 `lib.rs` 里 `pub mod tinyalsa_layout;`。设备 seam 改为 `use crate::tinyalsa_layout::{flags, PcmConfig};` 并 `pub use crate::tinyalsa_layout::header_layout_notes;`——于是只剩**一处**拼写要维持真值，而这条真值现在被 host 测试钉住。

**⑤不改值、不改形状**：所有常量值逐字未动；`open()`／`ready_or_err()`／`pcm_read`／`pcm_write` 及 capture/sink 的实现与 FFI 调用形状原样保留（只是常量来源从私有副本改为共享模块）。设备行为零变更。

**⑥在产物面断言**：`tinyalsa_layout.rs` 附带 4 条 host 可跑单测（见 32.4）。

### 32.3 为什么算「真缺陷」而非整洁度

1. **声明与可执行的载体分叉**：文档承诺「bring-up 测试**能**断言」，但被声明的载体（该函数）在 host 上不编译、零调用——属性「header 未漂移」没有任何路径被建立。
2. **三处拼写互不校验**：同一组 `pcm.h` 事实写在 notes 串、常量、结构体字段序里，任一处漂移都全绿。
3. **判别测试有真靶子**：两条负控注入（字段换位、`PCM_MONO` 改值）在修后树分别**恰 1 红**与**恰 2 红**（见 32.4），证明断言咬在「三处拼写是否一致」这一处真差异上；修前树对该漂移零保护。

### 32.4 验证与负控（实测）

- `cargo test -p amos-audio` ⇒ **28 passed / 0 failed**（24 + 4 新增）；新增 4 条：`pcm_config_layout_matches_the_header`、`enum_values_match_the_header`、`period_sizing_is_the_documented_shape`、`header_layout_notes_agree_with_the_constants`。
- `cargo check -p amos-audio --features tinyalsa,aaudio --target aarch64-linux-android` ⇒ **净**——Android seam 仍类型检查通过，证明 `use` 重定向在设备 cfg 下同样成立（host 的 `cargo test` 与设备的 `cargo check` 两侧都覆盖到）。
- `cargo clippy -p amos-audio --all-targets -- -D warnings` ⇒ **0 warning**；`cargo fmt -p amos-audio --check` ⇒ **净**。
- **负控（两半，逐字节还原 + sha256）**：①（判别力·字段换位）把 `PcmConfig` 的 `rate`／`period_size` 两行对调 ⇒ **恰 1 红**（`pcm_config_layout_matches_the_header`，其余 27 绿）；②（判别力·转写失误）把 `flags::PCM_MONO` `0x1`→`0x2` ⇒ **恰 2 红**（`enum_values_match_the_header` ＋ `header_layout_notes_agree_with_the_constants`）。两次注入后均 `cp /tmp/round27/tinyalsa_layout.good` 逐字节还原（sha256 `d6ddb08ec16524adc31a3a06aa90fc8947bb9d8a4ec251877d87e1e87c1ecb8b`、`diff -q` 净）后复绿 4。

### 32.5 诚实边界

1. 断言的是 **AmOS 侧的 Rust 拼写彼此一致**（notes 串 / 枚举常量 / 字段序 / 周期算式四方对齐），**不是**与真实 AOSP `external/tinyalsa/include/tinyalsa/pcm.h` 的逐字节比对——本机无该头文件，「header 是否漂移」在离线仓内只能证到「我们自己的三处拼写不再互相矛盾」。
2. `offset_of!` 断言的是 `#[repr(C)]` 的内存布局（C ABI 读的正是它），但不覆盖真实 `pcm_open` 对 flags **语义**的接受。
3. **未**改任何常量值、**未**改 `open()`／`pcm_read`／`pcm_write` 的 FFI 形状——设备行为零变更。
4. **未做**真机端到端（无 audio HAL / DSP）；证据是 host 单测 ＋ Android target 类型检查 ＋ clippy ＋ fmt。
5. **未**跑全仓 `cargo test --workspace`。
6. **并发取号**：本轮原计划 A639 / F-SH-111，落笔期间被并发的 frontend `vocab-mirror-scan` 轮取用（A641 / F-SH-111），A643 / F-DEV-092、A639 / F-WEB-001 亦被其他轮占用；故于落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 与 `F-SH-[0-9]{3}` 重探后改用 **A642 / F-SH-112**。

## 33. 第二十八轮：零 FMEA 盲区扫描（`amos-ai` 审计 `Outcome` 的盘/线词汇单源化，REQ-A646 / F-SH-115，2026-09-20）

### 33.1 选面与声明

- **选面**：`crates/amos-ai` 的统一审计模型 `audit.rs`（FMEA 无该面条目）——它把安全层的 `AuditResult`（`Success/Rejected/Error`）与隐私层的 `AccessDecision`（`Granted/Denied`）折成一个 `Outcome`，既写**盘上 JSON-lines trail**，又经 `privacy_service` 上 **gRPC 线**。
- **被声明的属性**：`Outcome` 的文档注释——「Serialization is **lowercase** (`"rejected"`), identical to the gRPC wire form (`proto/privacy.proto`: `granted|denied|success|rejected|error`) — the on-disk JSON-lines trail and the RPC answer the *same* tag for the same record, so an external consumer (SIEM export, log parser) cannot be tripped by a casing mismatch.」

### 33.2 缺陷（代码里没有任何路径建立它）

「盘/线同标签」意味着：对任一条记录，写进 trail 的标签与线上回复的标签必须出自**同一份词汇**。修前：

1. **写盘侧**：`#[serde(rename_all = "lowercase")]`（外加 PascalCase `alias`）——标签集由 serde derive 决定。
2. **写线侧**：`privacy_service::proto_audit`／`recent_trail` 用 `outcome.to_string().to_ascii_lowercase()`——依赖 `Display` 的 PascalCase 拼写再小写化。
3. **读线侧**：`privacy_service::parse_outcome` 是**另写一遍**的手工 `match`（`"success"/"granted"/"denied"/"rejected"/"error"` 五臂）。

三处**拼写同一词汇**，但彼此之间**无任何绑定**：`Outcome` 的变体集与 `parse_outcome` 的接受集是两份可各自漂移的列表。于是给 `Outcome` 加一个变体（或改 `Display`），该变体会被序列化进 trail 与线上回复，却在**读回**时被 RPC 以 `invalid_argument` 拒绝——一条被声明为「盘/线同标签」的属性，无代码建立「它们是同一份」。

### 33.3 为什么没被测出来

`audit.rs` 的既有 `outcome_has_one_canonical_spelling_but_reads_the_legacy_one` 用的是**硬编码**的五对字面量（断言 serde 标签 == 硬编码），`parse_outcome` 只在测试里被 `"success"`/`"rejected"` 探过。**没有一处**把 serde 标签与 `parse_outcome` 的接受集相互约束——这正是 F-SH-110/111/113 一族在 `amos-ai` 的化身（声明的镜像，测试只钉本地副本）。

### 33.4 修法与证据

- **单一来源**：`Outcome` 新增 `pub const ALL: [Outcome; 5]`（声明顺序的唯一变体列表）与 `pub const fn tag(&self) -> &'static str`（**穷尽 match**——加变体不补标签即**编译不过**）。
- **写线点改用 `tag()`**：`proto_audit`、`recent_trail` 不再依赖 `Display` 再小写化。
- **读线点改为派生**：`parse_outcome` 改为 `Outcome::ALL.into_iter().find(|o| o.tag() == k)`——接受集从 `ALL`/`tag()` **派生**，不再手写第二份，加变体即自动可读。
- **绑定测试**：`the_outcome_vocabulary_has_one_declaration_for_disk_and_wire`——排序后断言 `Outcome::ALL` 的 `tag()` 集 == proto 的五词汇；对每个变体断言 `serde_json` 标签 == `tag()`、`Display` 小写 == `tag()`、`parse_outcome(tag)` 与 `parse_outcome(TAG 大写)` 均 `Ok`；断言 `parse_outcome("deferred")`/`parse_outcome("")` 均 `Err`。
- **证据**：`cargo test -p amos-ai --lib` ⇒ **367 passed / 0 failed**（新用例 1 条，既有 `outcome_has_one_canonical_spelling_but_reads_the_legacy_one` 仍绿）；`cargo clippy -p amos-ai --all-targets -- -D warnings` ⇒ **0 告警**；`cargo fmt -p amos-ai -- --check` ⇒ **净**。
- **负控（逐字节还原 + sha256，两半）**：①（判别力）从 `Outcome::ALL` 拿掉 `Error`（数组 5→4）⇒ 新用例**恰 1 红**（`Outcome::tag set drifted from the proto vocabulary`），其余 366 绿；②（缺陷确实存在）把 `parse_outcome` 还原成**缺 `"error"` 臂**的手工 match ⇒ 新用例**恰 1 红**（`wire rejects its own tag`），而**既有 366 全绿**——证明修前树对该漂移零保护。两次注入后均 `cp` 逐字节还原并用 `shasum -a 256` 校验（`audit.rs` `0528e96c0876fac36e773b6014eb34cfce9ef9c83f045c3e01559a31c9e23a08`、`privacy_service.rs` `5b29c8e4e39f732c535856bc8ca63ceaa5445429581a98f79f04dc307ac4d310`，`diff -q` 净）后复绿 367。

### 33.5 诚实边界

1. **未改**任何词汇的值——修前两侧逐字一致，补的是**绑定**不是**纠正**。
2. **未**把 serde derive 换成手写 `Serialize`——新测试把 serde 输出与 `tag()` 相互钉住（若二者漂移即红），故不必改生产序列化路径。
3. **未改** proto（`AuditRecord.outcome` 仍是 `string`，不是 proto enum）。
4. `Display` 仍写 PascalCase（供人读/日志），只断言其小写形式 == `tag()`，不改 `Display`。
5. **未做**真机/RPC 端到端，证据是 lib 单测 ＋ 负控。
6. **并发取号**：本轮原计划 REQ-A645 / F-SH-114，落笔期间被另一轮（前端 declared-mirrors sweep）取用；故于落笔前 `grep -rhoE "REQ-A[0-9]{3,4}"` 与 `F-SH-[0-9]{3,4}` 重探（最高号 A645／F-SH-114）后改用 **A646 / F-SH-115**。

## 34. 第二十九轮：零 FMEA 盲区扫描（telemetry-spy 线词汇单源化，REQ-A650 / F-SH-118，2026-09-20）

### 34.1 选面与声明

- **选面**：`crates/amos-tauri/src/telemetry_spy.rs`——把守护进程 `TelemetrySpyService.Watch` 的 `EgressHit` 转成 WebView 可序列化的 `SpyHitPayload` 的桥，承载**隐私/泄漏告警**的 UI 面。
- **被声明的属性**：域核心 `amos-telemetry-spy` 的 `IdentifierKind::as_str`（`identifier.rs`）、`Protocol::as_str`（`signal.rs`）、`Confidence::as_str`（`scanner.rs`）——每个都注释为「Stable machine key for logs / **a future wire mapping**」，即这三个 `as_str()` 词表就是线上拼写的**权威**。

### 34.2 缺陷（代码里没有任何路径建立它）

「域 `as_str()` 是线上拼写的权威」意味着桥必须**引用**那份词汇，而不是另写一份。修前：

1. `telemetry_spy.rs` 的 `kind_str`/`protocol_str`/`confidence_str` 是**三个独立的手写 `match`**，逐字写出 `"serial"`/`"imei"`/`"cell_id"`/`"tcp"`…；
2. 三个函数与 `amos-telemetry-spy` **无任何引用关系**（`use amos_telemetry_spy` 不存在，`Cargo.toml` 无该依赖）；
3. 前端 `telemetrySpy.ts::kindKey` 又映射这批字面量。

于是桥/UI 的拼写与域权威之间**无任何绑定**：把域侧权威改名（**同时同步改它的 `parse_key` 臂**以保住自身往返）⇒ 桥照旧吐**旧**拼写、域声明与线上拼写**静默分叉**，UI 碰巧仍标得对，而「a future wire mapping」这句声明变成了假话。反过来改桥（臂互换/字面量笔误）同样无人绑定。**没有代码路径建立「桥/UI 拼写 == 域权威」这个属性**——F-SH-110/111/113/115/116 一族。

### 34.3 为什么没被测出来

- 域侧 `identifier::tests::kind_keys_round_trip` 只绑 `as_str ↔ parse_key`（**内部**往返），完全不涉桥；
- `telemetry_spy::tests::maps_a_hit_to_serializable_payload` 只钉了 `"imei"` **一个字面量**（用 Imei 命中），故 `Serial` 的拼写**零覆盖**；
- 前端 `declaredMirrors.test.ts` 只绑 `SpyHitPayload` 的**字段名**，不涉**取值词汇**。

### 34.4 修法与证据

- **单一来源**：`Cargo.toml` 加 `amos-telemetry-spy.workspace = true`；`telemetry_spy.rs` 新增 `domain_kind`/`domain_protocol`/`domain_confidence`（proto 位 → 域枚举）与统一 `wire_key(Option<&'static str>)`，三个 `*_str` 改取 `map(DomainKind::as_str)`。
- **哨兵**：未识别的位 → `"unknown"`（域枚举无此变体，故**刻意**不来自域 crate，是桥的本地哨兵）。
- **Rust 绑定测试**：`the_wire_vocabularies_are_the_domain_as_str_keys`——断言三组映射逐位得 `serial`/`imei`/`cell_id`、`tcp`/`udp`/`icmp`/`other`、`low`/`medium`/`high`，未知位得 `"unknown"`。
- **前端绑定测试**：新增 `src/__tests__/wireVocab.test.ts`——`readFileSync` 读 `amos-telemetry-spy/src/identifier.rs` 的 `as_str` 臂（正则抽 `=> "…"`、先断言臂数 `=== 3` 防空过），把 `kindKey` 逐个绑到 `spy.kind.*` 上。（`declaredMirrors.test.ts` 因并发轮占用而**未改**，改为新增独立文件。）
- **证据**：`cargo test -p amos-telemetry-spy --lib` ⇒ **25 passed / 0 failed**；`cargo test -p amos-tauri --lib telemetry_spy` ⇒ **6 passed / 0 failed**；`bun test src/__tests__/wireVocab.test.ts` ⇒ **1 passed / 0 failed / 9 expect()**。
- **负控（逐字节还原 + sha256）**：①（判别力·桥侧）把 `domain_confidence` 的 `Medium` 臂误标为 `Some(DomainConfidence::Low)` ⇒ 新用例**恰 1 红**（其余 5 绿）；②（**缺陷确实存在**·修前世界）桥还原为 HEAD 版手写 `match`、移走 `wireVocab.test.ts`，再把权威 `IdentifierKind::as_str` 的 `Serial` 改为 `"serial_no"` **并同步改 `parse_key` 的 `"serial"` 臂**（保住往返）⇒ 域 **25 全绿**、桥 **5 全绿**、前端 `declaredMirrors.test.ts` **8 全绿**——证明修前树对此漂移零保护；③（两侧联绑）修后树做同一改名 ⇒ 新 Rust 用例 **+** `wireVocab.test.ts` **恰 2 红**，域 25 与既有用例全绿。三次注入后均 `cp` 逐字节还原并 `shasum -a 256` 校验（`identifier.rs` `f96a36bc85d007bf51a810545c28c99139664af46f6c3835c5cece311f4f6cca`、`telemetry_spy.rs` `05253401a63684f45effb29729b768d25fadab408101e1d01e38a20c1656261d`、`wireVocab.test.ts` `ff0be19a38c72b89c3d4a6e1008f55e9d62f637ddb1e497159c5b22269241f6b`，`diff -q` 净）后复绿。

### 34.5 诚实边界

1. **未改**域 crate 的任何拼写/行为——只让桥**引用**它；`identifier.rs` 在本轮仅作**被读的权威**与负控注入对象，已逐字节还原。
2. 绑定读的是 Rust **源码里的 `as_str` 臂**（不是运行时）——Rust 的**实现**由编译期穷尽 `match` 与域侧 `kind_keys_round_trip` 各守一段。
3. `"unknown"` **不是**域词汇（域枚举无此变体），是桥刻意保留的本地哨兵，故**不**从权威派生。
4. 本轮**只**把 `IdentifierKind` 的**取值词汇**绑到前端（`wireVocab.test.ts`），`Protocol`/`Confidence` 的前端取值映射不在 `kindKey` 的职责内，故未在前端再绑。
5. **未做**真机端到端，证据是 Rust 单测 + 前端 bun 单测 + 负控。
6. **并发取号**：REQ-A649 / F-SH-117 为本轮上一段（前端字节标签镜像）占用，本段落笔前后经 `grep -rhoE` 重探（最高号 A649／F-SH-117）后取 **A650 / F-SH-118**。

## 35. 第三十轮：零 FMEA 盲区扫描（amos-android 容器能力键集未绑主机隐私权威，REQ-A653 / F-SH-120，2026-09-20）

### 35.1 选面与声明

- **选面**：`crates/amos-android/src/capability.rs`——容器内第三方 APK 的**能力台账**（`CapabilityLedger`），主机侧策略钩子 / HAL 策略读取的决策数据面。
- **被声明的属性**：`SENSITIVE_RESOURCES` 的文档注释——「The sensitive-resource wire keys a container app may hold — **1:1 with the host `PrivacyManager::Resource::key()`** / `proto/privacy.proto`」。权威是 `crates/amos-ai/src/privacy.rs` 的 `Resource::key()`（`microphone`/`camera`/`contacts`/`location`/`storage`）。

### 35.2 缺陷（代码里没有任何路径建立它）

「1:1 with the host `PrivacyManager::Resource::key()`」意味着容器键集必须与主机权威**同一份**。修前：

1. `SENSITIVE_RESOURCES` 是一个手写的 `["microphone", "camera", "contacts", "location", "storage"]`；
2. 其唯一用例 `resource_keys_align_with_the_host_wire_keys` 的正文是 `assert_eq!(SENSITIVE_RESOURCES, [同一份字面量])`——**与常量自身逐字相同**，且**不读** `amos-ai`（`amos-android` 甚至不依赖 `amos-ai`）；
3. 于是主机权威 `Resource::key()` 新增/改名一个资源（如 `storage→files`，并同步 `from_key` 臂）后，容器侧 `valid_resource_key` 仍只认旧的五个键——容器策略钩子要么拒绝主机承认的键、要么（更危险的 **fail-open** 方向）继续接受主机已不认的旧键，而那条以「align with the host wire keys」命名的用例照旧全绿。**没有代码路径建立「容器键集 == 主机权威键集」这个属性**——F-SH-105/110/111/113/116/117/119 一族。

### 35.3 为什么没被测出来

- 那个用例**名字**声称「align with the host wire keys」，正文却只是字面量自比；
- 主机侧 `privacy.rs::resource_keys_round_trip_and_reject_unknown` 只绑 `key ↔ from_key`（主机**内部**往返），不涉容器；
- 全仓再无第二处读 `SENSITIVE_RESOURCES` 的测试。

### 35.4 修法与证据

- **绑定而非复制**：用例改 `const HOST: &str = include_str!("../../amos-ai/src/privacy.rs")`，切片到 `pub const fn key(self)` 的 `match` 体、用 `match_indices("=> \"")` 抽出五条键字面量；先 `assert_eq!(host.len(), 5)`（空读守卫，防臂移出扫描窗后拿空集比空集），再排序后与 `SENSITIVE_RESOURCES` 集合相等。
- **不加依赖**：`amos-android` 的模块文档明确「no cross-crate dependency on `amos-ai`」，故以 `include_str!` 读源（`cargo` 会跟踪该文件的改动触发重编），而非新增工作区依赖。
- **证据**：`cargo test -p amos-android --lib capability` ⇒ **5 passed / 0 failed**。
- **负控（逐字节还原 + sha256）**：①（判别力·容器侧）`SENSITIVE_RESOURCES` 的 `storage→files` ⇒ 目标用例 1 红（另有既存 `granted_is_sorted_and_stable` 因硬编码 `"storage"` 同红，属真依赖）；②（判别力·主机侧）`crates/amos-ai/src/privacy.rs` 的 `Self::Storage => "storage"` 改 `"files"` ⇒ **恰**目标用例 1 红（4 passed / 1 failed），证明用例真读权威而非自比；两处注入后均 `cp` 逐字节还原、`diff -q` 净、`shasum -a 256` 校验（`privacy.rs` `2d36ea502fd74341efeb380b9c957c87526a5666561d06d09a46f55d8b2c2dee`、`capability.rs` `4246d98026490a8c2d45cdcc32c5d9f1e121545434cc79cb1aa66c15671790f2`）后复绿 5。

### 35.5 诚实边界

1. **只**重写**绑定测试**，**未改** `SENSITIVE_RESOURCES` 的值，也**未改** `amos-ai` 的 `Resource` 任何内容——后者仅作被读权威与负控注入对象，已逐字节还原。
2. 绑定读的是**源码里的声明**（`key()` 的 `match` 臂字面量），不是运行时——两侧各自的**实现**漂移不由本用例负责。
3. `amos-android` 刻意不依赖 `amos-ai`（模块文档原文），故以 `include_str!` 读源而非加依赖。
4. **未做**真机端到端，证据是 Rust 单测 + 负控。
5. **并发取号**：落笔前经 `grep -rhoE` 重探，最高号 **A652／F-SH-119**（前端分隔符/设备端封顶镜像）已被并发轮占用，故取 **A653 / F-SH-120**。

## 36. 第三十一轮：零 FMEA 盲区扫描（amos-devocare 内存加速可回收档集未绑生命周期内核，REQ-A655 / F-SH-122，2026-09-20）

### 36.1 选面与声明

- **选面**：`crates/amos-devocare/src/boost.rs`——设备管家「内存加速」的**策略层**：决定一次 one-tap 内存加速允许回收哪些生命周期档（`reclaim_plan` 的选档规则）。
- **被声明的属性**：模块头把安全性写成「the safety property holds **by construction** — only the two reclaimable tiers of `docs/app-lifecycle.md` are ever named, so no bug can select the app the user is looking at」；`RECLAIMABLE_STATES = ["cached", "background"]` 的文档「The governor lifecycle keys a boost treats as reclaimable」。这两档的**代码权威**是应用生命周期内核 `crates/amos-applife/src/spec.rs` 的 `AppState::is_reclaimable()`（`Background | Cached`）与 wire 键 `AppState::key()`。

### 36.2 缺陷（代码里没有任何路径建立它）

「only the two reclaimable tiers of `docs/app-lifecycle.md`」意味着 boost 的可回收档集必须与生命周期内核**同一份**。修前：

1. `RECLAIMABLE_STATES` 是一个手写的 `["cached", "background"]`；
2. 其用例 `only_cached_and_background_are_reclaimable` 只用 `"cached"`／`"background"` 字面量钉 `is_reclaimable`，`the_protected_tiers_are_never_reclaimable` 只用 `"foreground"` 等字面量——**没有一处读 `amos-applife` 的 `spec.rs`**（`amos-devocare` 甚至不依赖 `amos-applife`）；
3. 于是内核侧把 `AppState::Cached` 改名、或把某档加入/移出 `is_reclaimable()`（如 `Cached` 拆成两档、或让 `Stopped` 可回收）后，boost 策略照旧与**本地副本**相等而全绿：轻则拒绝内核已释放的档（该回收的没回收），重则回收内核**保护**的档——即「杀掉用户正在看的 App」，正是这条策略宣称「by construction」绝不可能发生的方向。**没有代码路径建立「boost 可回收档集 == 内核 `is_reclaimable()` 档集」这个属性**——F-SH-105/110/111/113/116/117/119/120/121 一族。

### 36.3 为什么没被测出来

- 两个既有用例都只把常量与**自身字面量**比较，从不引用内核；
- 内核侧 `amos-applife` 自己的用例只绑自身（`is_reclaimable` 与 `rank`/`key` 的一致性），不涉 boost；
- 全仓再无第二处读 `RECLAIMABLE_STATES` 的测试。

### 36.4 修法与证据

- **绑定而非复制**：新增用例 `reclaimable_states_equal_the_app_lifecycle_kernel_tiers`，`const SPEC: &str = include_str!("../../amos-applife/src/spec.rs")`：先解析 `pub fn key(self) -> &'static str` 的 `match` 臂得「变体名 → wire 键」映射（`assert_eq!(key_of.len(), 6)` 空读守卫）；再从 `pub fn is_reclaimable(self) -> bool` 体里 `match_indices("AppState::")` 取被 admit 的变体名，映射成键集合（`assert_eq!(expected.len(), 2)` 空读守卫）；排序后与 `RECLAIMABLE_STATES` 集合相等。
- **不加依赖**：`amos-devocare` 刻意保持纯 `std`（仅 `thiserror`/`serde`），故以 `include_str!` 读源（`cargo` 会跟踪该文件的改动触发重编），而非新增跨 crate 依赖。
- **证据**：`cargo test -p amos-devocare --lib boost` ⇒ **12 passed / 0 failed**（+1）。
- **负控（逐字节还原 + sha256）**：内核侧把 `crates/amos-applife/src/spec.rs` 的 `AppState::Cached => "cached"` 改 `"cached_tombstone"` ⇒ **恰**目标用例 1 红（11 passed / 1 failed，`left: ["background","cached"] / right: ["background","cached_tombstone"]`），其余 11 绿（证明用例真读权威、且其余用例不误伤）；注入后 `cp` 逐字节还原、`diff -q` 净、`shasum -a 256`（`crates/amos-applife/src/spec.rs` `6af0d0747c9931b037dc5344dc61f2ada0c88a15956c5b79fd8f9d54cdfaf162`）后复绿 12。

### 36.5 诚实边界

1. **只**新增**绑定测试**，**未改** `RECLAIMABLE_STATES` 的值，也**未改** `amos-applife` 的 `AppState` 任何内容——后者仅作被读权威与负控注入对象，已逐字节还原。
2. 绑定读的是**源码里的声明**（`key()` 与 `is_reclaimable()` 的字面量/变体名），不是运行时——两侧各自的**实现**漂移不由本用例负责。
3. `amos-devocare` 刻意保持纯 `std`（仅 `thiserror`/`serde`），故以 `include_str!` 读源而非加依赖。
4. **未做**真机端到端，证据是 Rust 单测 + 负控。
5. **并发取号**：落笔前经 `grep -rhoE` 重探，最高号 **A654／F-SH-121**（前端窗口吸附表镜像）已被并发轮占用，故取 **A655 / F-SH-122**。

## 37. 第三十二轮：零 FMEA 盲区扫描（手机管家前端词汇表未绑域权威，REQ-A658 / F-SH-124，2026-09-20）

### 37.1 选面与声明

- **选面**：`crates/amos-tauri/frontend-ts/src/lib/devcare.ts`——手机管家（设备管家）前端的**词汇表**：垃圾分类标签、敏感资源标签，以及把 wire tag 映到 i18n 键的两张表。
- **被声明的属性**：`JUNK_KINDS` 注释「The junk categories the domain models (**mirror of the Rust `JunkKind` tags**)」；`SENSITIVE_RESOURCES` 注释「The sensitive resources the review can mention (**mirror of `SensitiveResource`**)」；`JUNK_I18N`/`RESOURCE_I18N` 的值分别是 Rust `JunkKind::label_key()`／`SensitiveResource::label_key()` 的逐字副本。权威都在 `crates/amos-devocare/src/spec.rs`。

### 37.2 缺陷（代码里没有任何路径建立它）

「mirror of the Rust `JunkKind` tags」意味着前端标签集必须与域权威**同一份**。修前：

1. `JUNK_KINDS`/`SENSITIVE_RESOURCES` 是手写字面量数组，`JUNK_I18N`/`RESOURCE_I18N` 是手抄的 i18n 映射；
2. `declaredMirrors.test.ts`（REQ-A644/A648 建立的「声明镜像」绑定扫描）**只**绑了 `CARE_AREAS` ↔ `CareArea::key()`，没有绑 junk/resource 的键集或标签；
3. `devcare.test.ts` 对它们只断言前缀（`junkKindLabelKey(k).startsWith("care.junk.")`／`resourceLabelKey(r).startsWith("perm.cap.")`）——前缀对、值错也绿；
4. 于是域侧把一个 `JunkKind`（连同 serde tag）改名/增删，前端 `JUNK_KINDS` 照旧列旧 tag：该分类既不能被选中，`junkKindLabelKey` 也落到 `care.junk.unknown` 兜底；把某 `JunkKind` 的 `label_key` 改名，前端仍发旧 i18n 键（显示错误/通用标签）——全绿。**没有代码路径建立「前端词汇表 == 域权威」这个属性**——F-SH-105/110/111/113/116/117/119/120/121/122/123 一族。

### 37.3 为什么没被测出来

- `declaredMirrors.test.ts` 的扫描**覆盖了** `CARE_AREAS` 却漏了同一文件里 junk/resource 两处同族声明；
- `devcare.test.ts` 的标签用例只查前缀，不查具体值；
- 域侧 `amos-devocare` 自己的用例只绑 `key ↔ from_key`（内部往返），不涉前端。

### 37.4 修法与证据

- **绑定而非复制**：`declaredMirrors.test.ts` 新增两个 describe，`readRust("amos-devocare/src/spec.rs")` 后按 `impl JunkKind {`／`impl SensitiveResource {` 锚定，分别从 `pub const fn key(self)` 窗口取 wire tag 集、从 `pub const fn label_key` 窗口取 i18n 键集，先断言「8/8」「7/7」（空读守卫，防 Rust 重写把臂移出扫描窗后拿空集比空集），再断言 `JUNK_KINDS`/`SENSITIVE_RESOURCES` **顺序**相等，以及对每个键 `junkKindLabelKey`/`resourceLabelKey` 返回的 i18n 与权威逐条相等。
- **不加依赖**：前端以 `readFileSync` 读 Rust 源（REQ-A644/A648 建立的既有模式）。
- **证据**：`bun test src/__tests__/declaredMirrors.test.ts` ⇒ **10 passed / 0 failed / 94 expect()**（+2）；`bunx tsc --noEmit` ⇒ **净（exit 0）**。
- **负控（逐字节还原 + `shasum -a 256` / `diff -q`）**：①`spec.rs` 的 `JunkKind::LogFile => "log_file"` 改 `"logfile"` ⇒ **恰** JUNK_KINDS 用例 1 红（9 passed / 1 failed）；②`JunkKind::Thumbnail => "care.junk.thumbnail"` 改 `"care.junk.thumb"`（只改标签）⇒ **恰**该用例 1 红；③`SensitiveResource::Phone => "phone"` 改 `"telephone"` ⇒ **恰** resource 用例 1 红；④（**缺陷确实存在**·修前世界）移走两个新 describe、施加同一变异 ⇒ **8 passed / 0 failed**。四处注入后均 `cp` 逐字节还原、`diff -q` 净、`shasum -a 256`（`crates/amos-devocare/src/spec.rs` `039c2b459034c1fbc1565e831a6f678a6d1fbbcd596805ca811435157e5adc51`，`crates/amos-tauri/frontend-ts/src/__tests__/declaredMirrors.test.ts` `dd76caa52ee7e11587ff130908998d8b8de6bda4d0034bbd67fa1327d6096b06`）后复绿 10。

### 37.5 诚实边界

1. **只**新增**绑定测试**，**未改** `devcare.ts` 的任何词汇表值，也**未改** `amos-devocare/src/spec.rs` 任何内容——后者仅作被读权威与负控注入对象，已逐字节还原。
2. 绑定读的是**源码里的声明**（`key()`/`label_key()` 的 `match` 臂字面量），不是运行时——两侧各自的**实现**漂移不由本用例负责。
3. 本轮**只**绑 `JunkKind`/`SensitiveResource` 的键集与标签；`devcare.ts` 的 `AREA_I18N`/`SEVERITY_I18N`/`OP_I18N`/`OUTCOME_I18N` 映射的是其它权威（`CareArea::label_key`/`Severity::key` 等），不在本条范围内。
4. **未做**真机端到端，证据是前端 bun 单测 + TS 类型检查 + 负控。
5. **并发取号**：落笔前经 `grep -rhoE` 重探，最高号 **A657／F-SH-123**（机器人指挥台词汇表 / WebInstaller）已被并发轮占用，故取 **A658 / F-SH-124**。

## 38. 第三十三轮：零 FMEA 盲区扫描（amos-timesync 的 NTP 网络源时间窗未绑墙钟权威，REQ-A664 / F-SH-129，2026-09-20）

### 38.1 选面与声明

- **选面**：`crates/amos-timesync`——本仓唯一的「网络校准墙钟」crate（`clock.rs` 685 行 / `timekeeper.rs` 264 / `ntp.rs` 176 / `time_source.rs` 123），既有 FMEA 仅 `F-SH-069` 一条（REQ-A539，绑的是 `staleness`/`is_fresh`）。
- **被声明的属性**：`ntp.rs` 模块注释——拒绝「一个合理的 epoch 窗口（years 2000–2100）」的答复「right at the network source — **before `SyncedClock` runs its own check**」，即声明它用的是与 `SyncedClock` **同一个**窗口。权威是 `clock.rs::Plausibility::default()`（`DEFAULT_MIN_EPOCH_SECS`/`DEFAULT_MAX_EPOCH_SECS`）。

### 38.2 缺陷（代码里没有任何路径建立它）

「before `SyncedClock` runs its own check」意味着 NTP 早期守卫的窗口必须与时钟权威**同一份**。修前：

1. 该窗口在 `ntp.rs` 是**两个手抄私有常量** `MIN_ACCEPTED_EPOCH_SECS = 946_684_800` / `MAX_ACCEPTED_EPOCH_SECS = 4_102_444_800`，与 `clock.rs` 的 `DEFAULT_MIN/MAX_EPOCH_SECS` **无任何代码路径相连**；
2. `ntp.rs` 自带用例（`resolve_handles_…`、`numeric_ip_without_port_…`、`unreachable_server_…`）只测 `resolve` 与「连接失败不 panic」，**窗口本身一条测试都没有**；
3. `clock.rs` 的窗口用例用宽窗 `wide()`（`0..u64::MAX`）或只测 1980 被拒——走的是 `SyncedClock` 自己的检查，**从不读 `ntp.rs`**。
4. 于是把时钟窗口放宽（例如为某台设备的历史时间设 1990–2200）——时钟 `apply` 接受，NTP 早期守卫仍按旧下界 `Implausible` 拒掉；或把下界收到 2010——NTP 放行一个时钟会拒的时间。两侧对「同一份契约」各自作答，**没有代码路径建立「NTP 守卫的窗口 == 时钟权威的窗口」这个属性**——F-SH-105/110/111/113/116/117/119/120/121/122/123/124/125/126/127 一族，且发生在**同一个 crate 内、feature 门两侧**。

### 38.3 为什么没被测出来

- `ntp.rs` 只覆盖 `resolve`/连接失败，**窗口零覆盖**；
- `clock.rs` 覆盖窗口行为，但用宽窗或只测下界，且**不读 `ntp.rs`**；
- 两侧都在同一 crate 里，看似「就近」——但 `ntp` 是**非默认 feature**，默认构建根本编不到它，日常 `cargo test --workspace` 也看不到它。

### 38.4 修法与证据

- **绑定而非复制**：`ntp.rs` 删除两个手抄常量，新增 `fn within_window(secs: u64) -> bool { let w = crate::clock::Plausibility::default(); (w.min_epoch_secs..w.max_epoch_secs).contains(&secs) }`，`query_one` 的窗口检查改调它——属性**由构造成立**（全 crate 只有一份窗口）。
- **判别测试**：`clock.rs` 新增 `ntp_guard_consults_the_clock_window_not_a_copy`——`include_str!("ntp.rs")` 读源，断言其引用 `Plausibility` 且**不**再出现权威窗口的字面量（先去 `_` 再比对，故 `946_684_800` 也逃不掉）；`ntp.rs` 新增 `accepted_window_is_the_clock_window_and_is_half_open`（覆盖此前无任何用例的守卫本身，含半开区间 `[min, max)` 的边界）。
- **证据**：`cargo test -p amos-timesync --lib` ⇒ **20 passed / 0 failed**（+1）；`cargo test -p amos-timesync --features amos-timesync/ntp --lib` ⇒ **24 passed / 0 failed**（+2）；`cargo clippy -p amos-timesync --all-targets --features amos-timesync/ntp -- -D warnings` ⇒ **0 告警**；`cargo fmt --all -- --check` ⇒ **净**。
- **负控（`cp` 逐字节还原 + `sha256` / `cmp`）**：把 `within_window` 体还原为**手抄常量 + 字面量范围**（修前世界）⇒ **恰好 1 条红 / 19 绿**（`ntp_guard_consults_the_clock_window_not_a_copy`，报字面量 `946684800` 出现），`cp` 逐字节还原、`sha256`（`crates/amos-timesync/src/ntp.rs` `0e720fbf7eaab963a97783e8bc79f655366a76e481271d0f679c48657a1ca9ee`）+ `cmp` 净后复绿。

### 38.5 诚实边界

1. **只**消除 `ntp.rs` 的重复常量并新增绑定/行为用例，**未改** `clock.rs` 的 `Plausibility`/`DEFAULT_MIN/MAX_EPOCH_SECS` 任何值（`crates/amos-timesync/src/clock.rs` `7274c7d9b4c3d2dd7501819f9ec215a54834bcc1a5b768491d7ea697c971b5dc`，仅新增一个测试）。
2. `clock.rs` 的绑定用例读的是 **`ntp.rs` 源码文本**（`include_str!` + 去 `_` 比对字面量），不是运行时——能挡住「把窗口字面量重新写回 `ntp.rs`」，但换一种数字表示（十六进制等）可绕过，非平凡守卫会让这类改动**报错**而非静默空过。
3. `ntp` 是**非默认 feature**，其行为用例仅由 Makefile 的 `cargo test -p amos-timesync --features amos-timesync/ntp --lib` 跑到；而 `clock.rs` 的绑定用例在**默认** `cargo test --workspace` 下始终跑到。
4. **未**给该窗口加任何新的合理性语义，只把它收口到唯一权威；`MAX_OFFSET_NS`（持久化 offset 的合理性）与 `SyncedClock` 的其它检查无关，不在本条范围内。
5. **未做**真机端到端（真机 NTP 需真实网络），证据是 Rust 单测 + clippy + fmt + 负控。
6. **并发取号**：落笔前经 `grep -rhoE` 重探，最高号 **A663／F-SH-128**（WebMan 下载上限）已被并发轮占用，故取 **A664 / F-SH-129**。

## 39. 第三十四轮：零 FMEA 盲区扫描（NetGuard 前端接口未绑 `netguard.rs` serde 结构，REQ-A666 / F-SH-131，2026-09-20）

### 39.1 选面与声明

- **选面**：`crates/amos-tauri/src/netguard.rs`（出网防火墙的 Tauri 桥）+ `crates/amos-tauri/frontend-ts/src/lib/netguard.ts`（设置页「网络防护」读的 TS 侧）。权威是 Rust 的三个 serde 结构：`NetGuardToggle{enabled,message}`、`NetGuardEgressSample{domain,bytes}`、`NetGuardStatus{enabled,backend,enforced,policy_rules,top_egress}`——字段名即线上 JSON 键。
- **被声明的属性**：`netguard.ts` 三个接口分别注释「Serializable mirror of the daemon `ToggleReply` (matches the Rust serde keys)」「…EgressSample…」「Serializable mirror of the daemon `StatusReply`」——声明与 Rust serde 结构**同形**。

### 39.2 缺陷（代码里没有任何路径建立它）

「mirror of the daemon … (matches the Rust serde keys)」意味着两侧字段名必须**同一份**。修前：

1. `netguard.ts` 的 `NetGuardToggle`/`NetGuardEgressSample`/`NetGuardStatus` 是**手写的** TS 接口，与 `netguard.rs` 的 serde 结构**无任何代码路径相连**；
2. `netguard.test.ts` 的**每个**用例都用**本地字面量**造 fixture（`{ enabled: true, message: "…" }`），`grep` 确认**零**个测试引用 `netguard.rs`；
3. 于是把 Rust `message` 改名 `msg`——前端 `t.message` 变 `undefined`，「已启用（意图）」的确认串**静默消失**；`status.policy_rules`/`top_egress` 同理变 `undefined`，设置页「网络防护」的审计表**静默渲染成空**（`undefined` 落到模板里只渲染成空），**无任何报错路径**；
4. **没有代码路径建立「TS 接口的字段 == Rust serde 结构的字段」这个属性**——F-SH-105/110/…/130 一族（声明的跨语言镜像、用例只钉本地副本）。

### 39.3 为什么没被测出来

- `netguard.test.ts` 覆盖 `canEnforce`/`guardLevel` 等**行为**，但所有 fixture 都是本地字面量，**从不读 Rust**；
- Rust 侧也没有反向读 TS 的用例；
- 两侧字段名肉眼一致，看似「就近」——但改一处没人拦。

### 39.4 修法与证据

- **绑定测试**：`declaredMirrors.test.ts` 新增 describe，`readRust("amos-tauri/src/netguard.rs")` 用 `/pub (\w+):/g` 抽每个 `pub struct` 的字段体（先断言体不含 `rename`，故字段名＝线上键），`readLib("netguard.ts")` 用 `/^\s{2}(\w+)\??:/gm` 抽接口顶层字段；三结构先 `toHaveLength(2/2/5)` 漏读守卫，再 `toEqual` **双向等值**比对。
- **证据**：`bun test src/__tests__/declaredMirrors.test.ts -t netguard` ⇒ **1 passed / 0 failed / 12 expect()**；`bunx tsc --noEmit` ⇒ **净（exit 0）**。
- **负控（`cp` 逐字节还原 + `shasum -a 256` / `cmp`）**：`netguard.rs` 的 `pub message: String,`→`pub msg: String,`（连同 `to_toggle` 映射与 `maps_toggle_reply` 断言各一处）⇒ **恰**目标用例 1 红（`17 passed / 1 failed`，报 `NetGuardToggle` 字段不等；无注入时整文件 `18 passed / 0 failed / 153 expect()`），其余全绿；注入后 `cp` 逐字节还原、`shasum -a 256`（`crates/amos-tauri/src/netguard.rs` `d8abf46ebe6d9614137a610c2db0df72bc05a52e9c81b2fae2f2ee4276f7fb97`）+ `cmp` 净后复绿。

### 39.5 诚实边界

1. **只**新增绑定测试，**未改** `netguard.rs` 任何内容（仅作被读权威与负控注入对象，已逐字节还原），也**未改** `netguard.ts` 的三个接口。
2. 绑定读的是**源码里的 `pub struct` 字段声明**，不是运行时 JSON——两侧各自的**实现/序列化**漂移不由本用例负责；`rustFields` 断言体不含 `rename`（`netguard.rs` 三个结构无 `#[serde(rename)]`，故字段名＝线上键）。
3. **只**绑 `netguard.ts` 里被文档点名镜像 Rust 的三个接口；`canEnforce`/`guardLevel` 是行为辅助、非镜像，不绑。
4. **未做**真机端到端，证据是前端 bun 单测 + TS 类型检查 + 负控。
5. **并发告警**：同文件内 REQ-A667（`wm.ts`↔`wm.rs`）用例在落笔时因并发轮正在改 `wm.rs`（工作树 +1542 行）而红，与本轮无关。
6. **并发取号**：落笔前经 `grep -rhoE` 重探，最高号 **A668／F-SH-130**（推送通知词表）已被并发轮占用，故取 **A666 / F-SH-131**（A666 仅为本轮测试注释所占用）。

## 40. 第三十五轮：平板功能补全（主屏小组件从「写死的一行」变成可编排的栈，REQ-A673 / F-SH-138，2026-09-20）

**起点**：「作为平板电脑操作系统，我们还缺少什么功能？帮助我审计与补全，完善功能」。用户从审计出的四处平板缺口里**全选**：主屏小组件、Slide Over 悬浮第三窗格、跨 app 拖放、旋转锁 + 方向控制。本条是第一处（其余三处见后续轮次）。

### 40.1 审计起点：读出来的真实状态（不是"没有小组件"）

`HomeDock.svelte` 里**确实有**一个"小组件头"：一块时钟 tile + 一块天气 tile，写在模板里（`grid grid-cols-[1fr_auto] gap-3`），**硬编码**、不可增删、不可排序、无画廊，且时钟的 1 Hz `setInterval` **无条件**跑。所以诚实说法是：**小组件存在，但是写死的一行**——缺的是"用户可编排的栈 + 图库 + 每块的实时数据"。

### 40.2 修法与结构

- **纯模型** `src/lib/homeWidgets.ts`：`WIDGET_KINDS`（`clock/weather/battery/calendar`）、`WIDGET_CATALOG`（每项 `size: small|large` + `appId` + `labelKey`）、`DEFAULT_WIDGET_KINDS = ["clock","weather"]`、`normalizeWidgets`（缺键/坏值 ⇒ **默认栈**；数组 ⇒ 过滤未知、按首现去重、封顶）、`canAddWidget/addWidget/removeWidget/moveWidget/canMoveWidget`、`widgetRows`（small 两枚一行、large 独占一行）。
- **渲染** `src/svelte/HomeWidgets.svelte`：把列表变行。**默认 `["clock","weather"]` 与环境旧写的头一模一样**（同一字面类 `grid-cols-[1fr_auto]`）——手机路径逐字节不变。
- **实时 tile 拆子组件**：`widgets/WidgetBattery.svelte`（复用 `batterySources` 那一路 5 s 宿主采样）、`widgets/WidgetCalendar.svelte`（读 `amos.calendar`，复用 `lib/calendar` 的 `expandOccurrences`）。放 `{#if}` 里 ⇒ **没放该小组件时不订阅、不轮询**（时钟的 1 Hz tick 同样按 `has("clock")` 门控）。这是本轮特意避免的能量回归：不能在"没有电池小组件"的主屏上每 5 s 问一次宿主。
- **日历域新增** `lib/calendar.ts::nextEvent`（放在日历域而非小组件模块）：复用既有 `expandOccurrences`，重复日程显示**下一次发生**，窗口 `[now, now+30d)`。
- **编辑器** `EditHome.svelte`：新增小组件段（`data-testid="widget-editor"`），每枚 chip 带 ‹ › ✕，未放置的目录项作 ＋；写入走 `writeStoreValueChecked`，**失败经共享 `StoreErrorBar` 如实报告**（不谎称已保存）。
- **i18n**：en/zh 各 8 个新键（`widget.title/hint/add/remove/moveEarlier/moveLater/full/battery/calendar/calendarNone`）。
- **store 分类**：`scripts/store-allowlist.json` 新增 `amos.home.widgets` = `configuration`。

### 40.3 一处**真缺陷**（本轮既有用例抓出来的）

小组件 chip 的 ‹ › 初版复用了 app tile 的 `edit.moveEarlier`/`edit.moveLater`。同一个屏幕里，小组件 chip「天气」与 app tile「天气」于是有**同一个无障碍名**——对读屏用户是两个不同控件一个名字，对查询是"A 的名字找到了 B"。既有 `edit-home.svelte.test.ts` 的 3 条用例因之红（这是好事：它把歧义当场暴露）。修法：新增独立的 `widget.moveEarlier/moveLater` 键，并给隐藏区加 `data-testid="edit-hidden"`，让既有用例把"＋ 恢复 chip"的查询**限定在自己的区**（此前"任意 ＋ 开头的按钮"这个隐含假设，在加上小组件图库的那一刻就不成立了）。

### 40.4 测试与证据（实测）

- `src/__tests__/homeWidgets.test.ts`（纯模型，**20 passed**）：目录每项的 `appId` 都有 `appTitleKey`（**点下去真的有 app**，不是死 tile）、`labelKey` 都是真字典键、目录与 kind 联合一一对应；缺键/坏值 ⇒ 默认栈（**缺一个键不能变成"获得一项能力"**），`[]` ⇒ `[]`（"我全删了"是真实意图）、未知被丢、重复按首现去重、封顶；编辑三函数对未知/重复/满/两端/不存在都是**全函数**且不改入参；行排布 small 两枚/large 独占、单行不超上限、未知不产生空格。
- `svelte-tests/home-widgets.svelte.test.ts`（DOM，**13 passed**）：无键 ⇒ 默认 clock+weather 且仍是 `[1fr_auto]` 一行；显式列表 ⇒ 只画那些 tile；`[]` ⇒ 无栈但**网格照旧**；时钟/电池 tile 的点击都走**与图标同一条 `open` 通道**；日历 tile 显示 `amos.calendar` 里的下一个日程标题；`HomeWidgets` 的 large 独占行；`EditHome` 加/删/改序真写进共享键，首尾禁用。
- `bun run test`（bun-iso 全量）⇒ **OK**；`bun run teststrict` ⇒ **133 files / 1558 tests passed**；`bun run check`（typecheck + svelte-check + 全部 selftest/scan）⇒ **exit 0**（`svelte-check` 1408 files / 0 error / 0 warning）。

### 40.5 诚实边界

1. **未做真机 GUI 验证**：断言是 bun 单测 + vitest DOM + 类型检查 + 扫描门；小组件的**视觉/触感**（毛玻璃卡片在真机 WebView 的对比度、`active:scale-95` 手感）未在设备上看过。
2. **未做小组件尺寸系统**：`size` 只有 `small|large`，没有 iPadOS 的中号/多列跨格；`large` 语义是"独占一行"。
3. 电池/日历 tile 的**读数正确性**依赖各自已存在的宿主 seam（`batterySources`、`amos.calendar`），本轮不重验那些 seam；只验"没放就不订阅"。
4. `nextEvent` 的窗口固定 30 天，**不**跟随用户偏好。
5. **并发取号**：落笔前经 `grep -rhoE` 重探，最高号 **A670／F-SH-135、F-SH-136**（Dock 徽标跨侧绑定、容器层级词汇）已被并发轮占用；落笔**后**再探，发现并发轮又占了 **A671（`amos-ota` 自更新决策层）/ A672（机器人 DWA 反应层）** 与 **F-SH-137**，故本轮改取 **REQ-A673 / F-SH-138**。并发扰动告警：本轮 `bun run test` 曾短暂红在 `dockBadge.test.ts`（其"前导整数"源码锚点读到 `label?.trim().parse::<i64>().ok()`）——那正是并发轮在 `dock_badge.rs` 上跑 F-SH-136 的**负控注入**（该文件工作树 md5 在此期间稳定为本仓自己的版本），与本轮无关，扰动撤除后复绿。

## 41. 第三十六轮：平板功能补全（悬浮的「第三块面板」——Slide Over，REQ-A675 / F-SH-140，2026-09-20）

**起点**：同 §40 的「作为平板电脑操作系统，我们还缺少什么功能？帮助我审计与补全，完善功能」。用户从审计出的四处平板缺口里**全选**，本条是第二处（主屏小组件见 §40；跨 app 拖放、旋转锁见后续轮次）。

### 41.1 审计起点：读出来的真实状态（不是"没有面板"）

平板的触摸壳里**根本没有**一块「浮在应用**之上**的窄面板」。`SplitSurface` 的二分之一/三分之一把屏幕**分**给两块（`SplitAxis` 的几何断言是「两块之和 == 内嵌矩形」），而 iPadOS 式的 Slide Over——一块**不参与分割、叠在**应用上的面板——无处安放。全树 `grep` 无任何「overlay pane」几何：`amos-wm` 只有 `split_panes`，`amos-tauri` 只有 `wm_pane_rects`。所以诚实说法是：**分屏有，悬浮第三面板没有**。

### 41.2 修法与结构（与分屏 REQ-A512 **同一套纪律**）

壳**不**重算几何，只画宿主回的矩形：

- **纯几何** `crates/amos-wm/src/layout.rs::slide_over_pane(screen, axis, percent, min, margin)`：算**内嵌矩形**（四周留 `margin`）里贴**尾边**的一块，`Vertical` 靠右、`Horizontal` 靠下；宽/高 = 内嵌尺寸 × `percent/100` 但**不小于 `min_pane`**；不可行（小于最小、或内嵌装不下）⇒ `None`。
- **会话域** `crates/amos-wm/src/slide.rs::SlideOver`：`new` 建一块**显示**的面板、`bounds`/`offscreen_bounds`/`current_bounds`（跟随隐藏位）、`hide`/`show`、`resize_to`/`resize_by`、`set_screen`（**仅在仍放得下时**应用）、`contains`。`offscreen_bounds` 的前沿锚在 `screen.right()`/`screen.bottom()`（**屏幕**尾边，而非面板自身宽度）——否则会在屏上留 `margin` 宽的一条。
- **策略** `form.rs`：`LayoutPolicy` 新增 `slide_over_margin`（Phone 8 / Tablet 12 / Desktop 8 / Robot 0）。
- **宿主** `crates/amos-tauri/src/wm.rs::wm_slide_over_rect(axis, percent, w, h)` 委托 `slide_over_pane`（`axis="auto"` ⇒ 用 `policy.split_axis`，使**开面板后旋转**仍正确），注册进 `invoke_handler`。
- **前端纯解码** `src/lib/slideOver.ts`：`SurfaceSlideOverAxis`（`vertical|horizontal|auto`）、`SLIDE_OVER_KEY="amos.slideOver"`、`clampSlidePercent` 是**唯一**一把夹（**故意窄于**分屏的 1..=99：`SLIDE_PERCENT_MIN=15`/`MAX=60`——低于 ~15% 是读不了的细条，高于 ~60% 就不再是"浮在应用**之上**"而成了第二块面板，那是 `enterSplit` 的活；把这条拒绝掉，两种手势才不互相吞）、`parseSlideOver(raw, available)`（app **仍装着**才返回，否则 `null`，同 `parseSplit` 的诚实边界）、`encodeSlideOver`。
- **意图 + 持久化** `shellState.svelte.ts`：持 id/axis/percent/hidden，250 ms 去抖写盘；`openSlideOver`/`closeSlideOver`/`restoreSlideOver`（**总是恢复为显示**，即便存的是 hidden）/`setSlideOverPercent`/`hideSlideOver`/`showSlideOver`（**幂等、不持久化**：一眼的临看不属于布局）。
- **渲染** `src/svelte/SlideOverSurface.svelte`：**只画宿主回的矩形**。外层测量壳**常驻挂载**（否则 `bind:this` 永不绑定 ⇒ 量不到 ⇒ 矩形的鸡生蛋），只有**被画的面板** `{#if rect}`；宿主回 `null` ⇒ 不画（**绝不**编一个矩形），`amosWarn` 后保留上一帧；隐藏 = 单一 derived 样式串里的 `translateX(宿主宽 − 面板 x)`；`AppPane` 带 `返回`+`»` 收起，`‹` 抓取条唤回，resize 手柄支持指针与 `Home`/`End`（经**同一把** `clampSlidePercent`）。
- **入口** `Shell.svelte`：`slideOverAvailable = canSlideOver() && shellForm !== "desktop"`（手机列 < 2 **从不**给这个入口）、recents 面板的 `pick` 通道路由到 `pickSlideOver`、开机 `restoreSlideOver()`。
- **store 分类**：`scripts/store-allowlist.json` 新增 `amos.slideOver` = `configuration`。

### 41.3 两处**真缺陷**（本轮既有门当场抓出）

1. `setSlideOverAxis`/`toggleSlideOver` 初版**无生产调用点** ⇒ 既有 `unwired-scan` 拒（已删）。
2. 3 个 i18n 键（`slide.title`/`slide.hint`/`a11y.slideOverClose`）**无人引用** ⇒ 既有 `i18n-scan` 拒（已删）。

### 41.4 测试与证据（实测）

- `cargo test -p amos-wm --lib` ⇒ **90 passed / 0 failed**（`layout.rs` +4、`slide.rs` +8）。
- `cargo test -p amos-tauri --lib slide_over` ⇒ **2 passed / 0 failed**（委托相等 + 贴尾边且拒绝过小屏）。
- `bun test src/__tests__/slideOver.test.ts` ⇒ **11 passed / 0 failed / 49 expect()**（band、key、轴白名单、clamp、parse/encode）。
- `bunx vitest run svelte-tests/slide-over.svelte.test.ts` ⇒ **9 passed / 0 failed**（壳状态转换 4 + 组件 5：画宿主矩形、`null` 不画、隐藏/唤回往返、返回关闭、resize `End→60`/`Home→15`）。
- `bun run test`（bun-iso 全量）⇒ **OK**；`bun run teststrict` ⇒ **134 files / 1567 tests passed**；`bun run check`（typecheck + svelte-check + 全部 selftest/scan）⇒ **exit 0**（`svelte-check` **1411 files / 0 error / 0 warning**）。
- **负控（判别力，实测）**：①`SlideOver::offscreen_bounds` 改用**面板自身宽度**平移（最初的写法）⇒ `slide.rs` **2 条红**（`hidden_is_fully_off_screen_and_reversible` 实测 `off.x=988` 期望 `1000`、`horizontal_hidden_translates_downward` 同理），即"隐藏后屏上仍留 `margin` 宽一条"当场被抓住；改回锚**屏幕**尾边后复绿。②`SlideOverSurface` 的面板初版**不**按 `{#if rect}` 门控（外层 `{#if s}` 恒真）⇒ "宿主回 `null` 就不画"那条红（DOM 里出现了空样式的 `slide-over-panel`），即"编造一个矩形"被发现；门控后复绿。

### 41.5 诚实边界

1. **未做真机 GUI 验证**：断言是 Rust 单测 + bun 单测 + vitest DOM + 类型检查 + 扫描门；悬浮面板在真机 WebView 的**层次/毛玻璃/触摸命中**未在设备上看过。
2. 面板几何是**纯整数**矩形，`percent` 为整数、`margin` 以像素计，**无**亚像素/DPR 处理（沿用 `split_panes` 的同一取舍）。
3. 隐藏用的是**平移出屏**（`translateX/Y`）而非卸载，面板 DOM 与其中的 app 仍**挂着**——这符合"临看一眼就唤回"的意图，但**未**做省电卸载路径。
4. `restoreSlideOver` 的"app 仍装着"判据复用壳当前可用 app 清单，**不**重验安装态的持久化正确性。
5. `percent` 的默认 33 与 `amos_wm::slide::DEFAULT_SLIDE_PERCENT` 各自字面持有（未跨语言共享常量），一致性靠单测而非类型。
6. **并发取号**：落笔前经 `grep -rhoE` 重探，最高号 **A674／F-SH-139**（机器人 DWA 穿墙）已被并发轮占用，故取 **REQ-A675 / F-SH-140**。

## 42. 第三十七轮：平板功能补全（旋转锁 / 方向控制，REQ-A677 / F-SH-142，2026-09-20）

### 42.1 审计起点：读出来的真实状态（不是"开关没生效"）

平板的快速设置里有一个「旋转锁定」按钮——但它在整棵树里**只有意图、没有决策、没有设备调用**：全树 `grep` 无任何 rotation 域内核、无 `Activity#setRequestedOrientation` 的 JNI 调用点、无 `amos.rotation` store key。四个 mode 的**词表**、Android `ActivityInfo` requested-orientation 码的**映射**、以及「设备拒绝了 / 桌面本就无事可做」的**诚实回话**，三层全缺。诚实说法是：**意图存得下，显示转不过去。**

### 42.2 修法与结构（与 `alarm_sched` / 手电**同一套纪律**：纯内核定决策、宿主只搬运、结果从不向上取整）

- **纯内核** `crates/amos-display/src/orientation.rs`：`RotationMode{Auto,Locked,Portrait,Landscape}` + `ROTATION_MODES` 是**唯一**词表；`requested_orientation()` 把 key 映成 Android 码（`SCREEN_ORIENTATION_LANDSCAPE=0` / `PORTRAIT=1` / `UNSPECIFIED=-1` / `LOCKED=14`）；`key()`/`from_key()`/`all()`/`freezes()`/`settled_orientation()`；`ScreenOrientation` + `orientation_of(width,height)`（**严格更宽**才算横，正方形算竖）；`normalize(raw)`——未知 / 损坏 ⇒ `Auto`，**绝不**把显示冻死。
- **宿主桥** `crates/amos-tauri/src/rotation.rs`：`ROTATION_KEY="amos.rotation"`；`RotationOutcome` 是**类型化 serde 枚举**（`tag="state"` / `content="detail"`：`HostOnly` / `Applied` / `Unattached` / `Unavailable` / `Denied` / `Unknown(String)`），**从不**把拒绝向上取整成 `Applied`；`rotation_outcome_from_status(&str)` 是**唯一**的分类器（未识别的词 ⇒ `Unknown`，因为分类不了的 status 对「显示是否照办」什么都没说）；`platform_available()`；`rotation_get` / `rotation_set`（未知 mode key ⇒ **拒绝**而非猜成 auto）；`apply_persisted(store)` 在开机**重放**存储的锁。
- **Android seam** 照 `alarm_sched` 的形状：`OnceLock<JavaVM>` + `amos_jni::attached` + `env.call_static_method(GLUE_CLASS, "setOrientation", "(I)Ljava/lang/String;", …)` + `clear_pending`，Kotlin `RotationGlue.setOrientation(code)` 回一个 `STATUS_*` 词；`Java_com_amos_ai_glue_RotationGlue_attach` 收 JavaVM。桌面 / CI 的 `set_orientation` 恒答 `HostOnly`。
- **前端纯镜像** `src/lib/rotation.ts`：`ROTATION_MODES` / `isRotationMode` / `normalizeRotation` / `rotationLabelKey` / `rotationFreezes` / `orientationOf` / `classifyRotationOutcome`——UI 只持**意图**。`NotificationCenter.svelte` 的四键 tile（`data-testid="nc-rotation"`、`data-frozen`、`aria-pressed`）经 `classifyRotationOutcome` 把结果分成「已应用 / 本宿主无能为力 / 设备拒绝」，**只**在拒绝时显示 `rotation.notApplied`；`formLayout.ts::homeGrid` 的平板分支改走 `orientationOf`（语义等价于原 `height >= width`）。
- **store 分类**：`scripts/store-allowlist.json` 新增 `amos.rotation` = `configuration`。

### 42.3 四条会「静默地说谎」的失败面（F-SH-142 的判据，逐条闭合）

| 失败面 | 闭合方式 |
|---|---|
| 壳里长出**第二套** mode 词表 / Android 码映射 | 内核独占映射；`rotation.test.ts` 读 `orientation.rs` 的 `RotationMode::X => "str"` 分支与 `ROTATION_MODES` 双向等值，并断言 `NotificationCenter.svelte` 里**没有** `"portrait"`/`"landscape"` 字面量 |
| `setRequestedOrientation` 被吞掉却报成 applied | `RotationOutcome` **从不**向上取整；JNI 抛异常 / null / 非字符串 ⇒ `Unknown(…)` 原样上抛 |
| 桌面宿主假装已应用 | 无 `android` feature 时 `set_orientation` 恒答 `HostOnly`，`platform_available()` 恒 `false` |
| 锁在重启后**丢失**（显示静默解锁） | `apply_persisted(store)` 开机重放存储的 intent |

### 42.4 测试与证据（实测）

- `cargo test -p amos-display` ⇒ **11 passed / 0 failed**（`orientation.rs` 词表 / 映射 / 几何 / `normalize`）。
- `cargo test -p amos-tauri --lib rotation` ⇒ **8 passed / 0 failed**（默认 feature 与 `--features amos-tauri/android` 皆绿）；含 `include_str!` 读 `RotationGlue.kt` 的**跨语言绑定**用例 `the_glue_status_words_are_the_ones_the_host_parses`——宿主分类的每个 `STATUS_*` 词必须在 Kotlin 里仍被声明，反之亦然。
- `bun test src/lib/__tests__/rotation.test.ts` ⇒ **16 passed / 0 failed / 50 expect()**（词表 / `normalizeRotation` / 语义 / `classifyRotationOutcome` / 结构负控 / 跨语言镜像）。
- `bunx vitest run svelte-tests/notification-center.svelte.test.ts` ⇒ **22 passed / 0 failed**（新增 4：四键渲染 + 离线落盘 + `data-frozen`；本宿主不可旋转显示 `rotation.unavailable`；设备 `host_only` 不报错；设备拒绝显示 `rotation.notApplied`）。
- `bash scripts/android-activity-wiring-check.sh` ⇒ **18 glue 入口点**（`RotationGlue.bind(` 已入 REQUIRED）。
- `bun run test`（bun-iso 全量）⇒ **OK**；`bun run test:svelte` ⇒ **134 files / 1571 tests passed**；`bun run typecheck` / `typecheck:svelte` ⇒ **0 error / 0 warning**（1413 files）；`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 365 条**，`--self-test` ⇒ **12/12**。
- **负控（逐字节还原 + `shasum -a 256`，两半）**：①`orientation.rs` 把 `Landscape` 的 `key()` 改错 ⇒ **恰 1 条红**；还原后复绿（sha256 `131a0c93…6d16`）。②`RotationGlue.kt` 把 `STATUS_DENIED` 改成 `"refused"` ⇒ 跨语言绑定用例**恰 1 条红**（宿主不再分类该词，会被当成 `Unknown` 显示为"设备没应用"）；还原后复绿（sha256 `d3cf43d3…4e66`）。

### 42.5 诚实边界

1. **未做真机 GUI / 方向验证**：断言是 Rust 单测 + bun 单测 + vitest DOM + 类型检查 + 扫描门 + 跨语言 `include_str!` 绑定；`setRequestedOrientation` 的**设备侧效果**（Activity 真的转了）**未**在设备上看过。
2. Android seam 只在 `--features android` 下**编译检查**，JNI 路径在设备时执行。
3. `platform_available()` 在 Android 上以 `RotationGlue` 是否 attach 为准，**不**探测前台 Activity 是否真的可定向——那是 `setRequestedOrientation` 的运行时答案，由 `RotationOutcome` 如实回。
4. `rotation_set` 对未知 mode key **拒绝**（不静默回落 auto），UI 只发它镜像的四个 key。
5. `amos.rotation` 的持久化与内核 key 的一致性靠前端跨语言镜像用例而非类型。
6. **并发取号**：落笔前经 `grep -rhoE` 重探，最高号 **A676／F-SH-141**（机器人文档-代码一致性）已被并发轮占用，故取 **REQ-A677 / F-SH-142**。

## 43. 第三十八轮：平板功能补全（跨 app 拖放，REQ-A683 / F-SH-145，2026-09-20）

### 43.1 审计起点：读出来的真实状态（不是"没有拖放 UI"）

触摸壳里此前**没有**「把一个条目拖到另一个应用」这条路径：全树 `grep` 无任何 `DragPayload` / drop-capability 概念。跨应用交接**唯一**的既有路径是 `appLinks.ts` 的深链（写 props 频道 + `open(app)`），而**没有**一条规则说「哪种载荷能被哪个应用接收」。诚实说法是：**交接的管子有，但没有一张写着"谁能收什么"的桌子。**

### 43.2 修法与结构（纯内核定决策、壳只持意图、交接复用既有深链）

- **纯内核** `src/lib/dragDrop.ts`（**唯一**决策源）：`DRAG_KINDS=["text","phone"]`；`makeTextPayload` / `makePhonePayload`（空白 ⇒ `null`，文本截断到 `MAX_DRAG_TEXT=2000`）；`payloadDetail`（芯片一行，`MAX_DRAG_DETAIL=48`）；`DROP_CAPABILITIES`（**四行**：`text→ai[ai-context]`、`text→notes[new-note]`、`phone→messages[compose-sms]`、`phone→phone[dial]`）；`dropVerb`；`resolveDrop`（空目标 ⇒ `no-target`；目标 == 来源 ⇒ `same-app`；无能力 ⇒ `unsupported`；否则 `accept+verb`）；`rejectionKey`。
- **会话** `src/svelte/dragSession.svelte.ts`：模块级 `$state` 单一全局会话，`startDrag`（已有会话则忽略）/ `moveDrag`（重算 resolution）/ `endDrag` / `cancelDrag`。
- **适配器** `src/svelte/dropActions.ts::performDrop`：每个 `verb` 一个 `case`，**复用**既有深链 `sendToAi` / `openNoteDraft` / `composeSmsTo` / `dialNumber`——**不新增第二条 hand-off 路径**。
- **壳** `src/svelte/DragGhost.svelte`：壳里**唯一**的窗口级指针监听（`elementFromPoint(x,y)?.closest("[data-drop-app]")` → `resolveDrop`，画芯片、松手执行）；`src/svelte/dragGesture.ts` 用长按（`HOLD_MS=400`）+ 位移（`THRESHOLD_PX=10`）触发，`dragged()` 抑制随后那次 click。
- **投放目标** `src/svelte/AppPane.svelte`：挂 `data-drop-app={id}`，并按 resolution 分 `accept`（`ring-2 ring-inset ring-accent`）/ `reject`（`ring-danger/60`）两档描边——**松手什么都不会发生**的拖拽绝不长得像会发生的。
- **源** `ContactsApp.svelte`（电话号 ⇒ `makePhonePayload`）、`NotesApp.svelte`（笔记文本 ⇒ `makeTextPayload`）；`NotesApp` 的 props 频道新增 `draftText` 分支：**预填 compose 草稿**而非建笔记（drop 是交接文本，不是替用户写一条笔记）。
- **i18n**：`drag.text` / `drag.phone` / `drag.dropHint` / `drag.dropOn` / `drag.rejectSameApp` / `drag.rejectUnsupported`（zh/en 各六键）。

### 43.3 四条会「静默地说谎 / 造物」的失败面（F-SH-145 的判据，逐条闭合）

| 失败面 | 闭合方式 |
|---|---|
| 壳 / 屏内联 `kind: "text"` 或自写能力表（第二条规则） | 词表与能力表**只**在 `lib/dragDrop.ts`；结构测断言 `svelte/` 里没有第二份 `DROP_CAPABILITIES`、两个源不内联 `kind:` 字面量 |
| 表里有行而 `performDrop` **无**对应 `case`（松手成功假象） | 结构测断言每个能力行的 `verb` 在 `dropActions.ts` 出现为 `case "<verb>"`（表与执行双向绑定） |
| `same-app` 静默复制（静默造出第二个笔记 / 草稿） | `resolveDrop` 对目标 == 来源返回 `reject/same-app`；svelte 测断言松回原应用后 `messagesChannel` 仍 `undefined` |
| 多处窗口监听致拖拽生命周期分裂 | 壳里**只有** `DragGhost` 拥窗口级指针监听（结构测） |

### 43.4 测试与证据（实测）

- `bun test src/lib/__tests__/dragDrop.test.ts` ⇒ **18 passed / 0 failed / 61 expect()**（词表 / 构造器 / 能力表 / `resolveDrop` 矩阵 / 结构性负控）。
- `bunx vitest run svelte-tests/drag-drop.svelte.test.ts` ⇒ **7 passed / 0 failed**（合成 pointer 事件 + `elementFromPoint` 桩：号→Messages 预填并切换；笔记文本→AI 附加上下文；松回原应用拒绝且不交接；不能收的目标拒绝并给出理由；指针下无目标显示提示且 Escape 中止；笔记文本→Notes 设 `draftText` 不建笔记）。
- `bun run check` ⇒ **EXIT 0**（`tsc` + `svelte-check --fail-on-warnings` + unwired/i18n/store/write/svelte-ignore/hover/lifetime/react-free/vocab-mirror/orphan-test/idgen/a11y 等扫描全绿）。
- `bun run test`（bun-iso 全量）⇒ **OK**；`bun run test:svelte` ⇒ **135 files / 1578 tests passed**；`node scripts/fmea-gen.mjs --check` ⇒ **[OK] 370 条**，`--self-test` ⇒ **12/12**；`node scripts/trace-scan.mjs` ⇒ **EXIT 0**。
- **负控（逐字节还原 + `shasum -a 256`，三半）**：①删除 `dropActions.ts` 的 phone→compose-sms 分支 ⇒ **恰 1 红**（「每个 verb 都在 dropActions 的执行分支里出现」）；②把 `resolveDrop` 的 `same-app` 改成静默 accept ⇒ **恰 1 红**（「松回原应用 ⇒ same-app（拒绝，不静默复制）」）；③把能力表某行 `app` 改成不存在的 id ⇒ **恰 1 红**（「每个 app 都是真实 APP_META id」）；每处 `cp` 还原后 `shasum -a 256` 校验一致复绿。

### 43.5 诚实边界

1. **未做真机 / 浏览器 GUI 验证**：证据是纯函数测 + vitest DOM（合成 pointer 事件 + `elementFromPoint` 桩）+ 类型检查 + 扫描门；真机上「长按拖起、指针下的描边、松手交接」的**触感与视觉**未在设备上看过。
2. 拖拽**触发**只交付 `text` / `phone` 两种载荷（`image` 等未做，能力表也无对应行 ⇒ 不存在「表里有行无执行」的谎）。
3. `DragGhost` 的窗口监听在会话活跃时挂、`endDrag` / `cancelDrag` 时卸，但**未**做多指针 / 多点触控的并发用例。
4. `data-drop-state` 的描边只作结构测试钩子，未做动画验证。
5. **并发取号**：落笔前经 `grep -rhoE` 重探，**A682／F-SH-144 已被并发轮占用**（amos-robot 计划树轮，`crates/amos-robot/AEROSPACE_PLAN.md:30`），故取 **REQ-A683 / F-SH-145**。

## 44. 第三十九轮：平板功能补全（自动勿扰时段，REQ-A684 / F-SH-148，2026-09-20）

### 44.1 审计起点：读出来的真实状态（不是"没有定时静音"）

`lib/focusPrefs.ts` 的模块头早已诚实地写下 `a scenario scheduling engine isn't wired yet`：`工作` / `睡眠` 两个场景只存**意图**（`amos.focus`），**没有任何**到点静音。勿扰本身是**唯一**一处静音通知的 bit——`amos.settings.dnd`（`lib/settings::dndActive`），壳、控制中心、到达横幅、通知页都读它（REQ-A206 立下的「只有一个勿扰」）。诚实说法是：**有一个真的勿扰开关，但没有一张写着"它该在什么时候自己翻"的时间表。**

### 44.2 修法与结构（一处纯内核决策 + 壳层唯一执行者）

- **纯内核** `src/lib/focusSchedule.ts`（**唯一**决策源）：
  - `windowContains(w, day, minute)`：半开区间 `[start, end)`；`start === end` 是**零长度空窗口**、**从不生效**（绝不读成「整天」）；`start > end` 表示跨午夜，同日尾段 + 次日头段都覆盖；没有星期 ⇒ 从不生效。
  - `advanceDnd(desired, currentDnd, auto)`：**所有权状态机**。窗口内 ⇒ DND 开并声明 `{auto:true}`；窗口外且 `auto` ⇒ 释放（关）；窗口外且非 `auto` ⇒ **原样保持**（用户手动开的勿扰**绝不动**）。
  - `activeScenario(schedule, day, minute)`：重叠时取**最近开始**的（最小 elapsed），平手按声明序，保证每 tick 读数确定。
  - `normalizeSchedule`（损坏守卫：越界/非整数时间 ⇒ 该场景回默认、**不夹取**；`enabled` 只认 `=== true`；星期去重排序）+ `normalizeFocusAuto` + `defaultSchedule` + `minutesOfDay` / `dayOfWeek` / `formatMinutes` / `parseMinutes`。
- **壳层唯一执行者** `src/svelte/osFocusWatcher.ts`：`focusWatcherTick(now)` 读（日程 + 所有权 + 真实 bit）→ 决策 → 只经 `SETTINGS_KEY` 写那**一个** DND bit，并把所有权落盘 `FOCUS_AUTO_KEY`（重载跨窗口不丢责任人）；**只在真变化时**写，以免与自身 store 事件乒乓。`startFocusWatcher()` 先 tick 一次（编辑立即生效）、再挂 30s 间隔与 store 事件订阅、返回 stop。`Shell.svelte` 把 `startFocusWatcher()` 加入 `stopWatchers`。
- **意图编辑器** `src/svelte/settings/FocusSchedule.svelte`：只写 `FOCUS_SCHEDULE_KEY`（场景开关 / 星期 chips（周一为首）/ 两个 `<input type="time">`），**不碰** DND bit；给出「正在生效：{name}，{end} 结束」的活读数。`FocusPage.svelte` 保留既有「勿扰（真 bit）+ 工作/睡眠（意图）」两行，并挂上本编辑器；`focusPrefs.ts` 抽出 `focusLabelKey` 让页与编辑器共用同一标签键。
- **i18n**：`settings.focusSchedule` / `focusScheduleHint` / `focusActive` / `focusStartAria` / `focusEndAria` / `focusDayAria` / `focusAutoAria`（zh/en 各七键）。
- **持久化登记**：`scripts/store-allowlist.json` 把 `amos.focus.schedule` / `amos.focus.auto` 登记为 `configuration`。

### 44.3 四条会「替用户说话」的失败面（F-SH-148 的判据，逐条闭合）

| 失败面 | 闭合方式 |
|---|---|
| 只写 `dnd = 窗口是否生效` ⇒ 窗口外关掉**手动**勿扰 | `advanceDnd` 的非 `auto` 臂返回 `{ dnd: currentDnd }`（原样）；内核测「窗口外 + 用户自己开 ⇒ 绝不动它」+ DOM 测「用户自己开的 DND，窗口外绝不被关掉」 |
| 只管开不管释放 ⇒ 窗口结束后勿扰**一直粘着** | `FOCUS_AUTO_KEY` 记录所有权，窗口外且 `auto` ⇒ 释放；DOM 测「窗口结束后 ⇒ 释放日程自己开的 DND」 |
| 设置页直接写 DND ⇒ **第二条静音路径** | 结构测断言 `FocusSchedule.svelte` **没有** `SETTINGS_KEY` / `dnd` 字面量；watcher **没有**自造 `amos.` key、没有第二条 `NOTIF_KEY`；壳里只有一处 `startFocusWatcher` |
| `start === end` 的空窗口读成整天 ⇒ **永久静音** | `windowContains` 对 `start === end` 恒 `false`；内核测「零长度…绝不读成整天」 |

### 44.4 测试与证据（实测）

- `bun test src/lib/__tests__/focusSchedule.test.ts` ⇒ **25 passed / 0 failed / 63 expect()**（词表 / 默认 / `normalizeSchedule` 损坏守卫 / `windowContains`（半开、禁用、零长度、空星期、跨午夜两段）/ `activeScenario`（重叠取最近开始）/ `advanceDnd` 所有权矩阵 / `normalizeFocusAuto` / 时间工具 + 三条结构性负控）。
- `bunx vitest run svelte-tests/focus-schedule.svelte.test.ts` ⇒ **9 passed / 0 failed**（假定时器 `vi.setSystemTime`：窗口内翻 bit 并声明所有权；窗口结束释放；手动勿扰不动；`startFocusWatcher` 编辑即时生效；`stop()` 清定时器 + 监听；设置页只写意图、星期切换、「正在生效」读数）。
- 既有 `svelte-tests/settings-pages-uncovered.svelte.test.ts` 的 FocusPage 两处断言原本按**开关索引/总数**选择（现在日程编辑器合法地多出两个同名场景的开关），改为**按可及名**（`controlByName`）选择意图页的三个开关。
- `bun run check` ⇒ **EXIT 0**（`tsc` + `svelte-check --fail-on-warnings` + 全扫描门）；`bun run test`（bun-iso）⇒ **OK**；`bun run test:svelte` ⇒ **136 files / 1587 tests passed**；`node scripts/fmea-gen.mjs --check` ⇒ **OK（+1）**、`--self-test` ⇒ **12/12**；`node scripts/trace-scan.mjs` ⇒ 无 duplicate/missing。
- **负控（判别力，实测，逐字节还原 + `shasum -a 256`）**：①把 `advanceDnd` 的手动勿扰臂 `currentDnd`→`false` ⇒ 内核**恰 1 红** + DOM **恰 1 红**；②把 `osFocusWatcher` 传给 `advanceDnd` 的 `auto` 改成常量 `{ auto: false }` ⇒ DOM **恰 1 红**（释放失效），内核 25 全绿；③把 `windowContains` 的空窗口判据 `false`→`days.includes(day)` ⇒ 内核**恰 1 红**；每处 `cp` 还原后 `shasum -a 256` 与扰动前一致复绿。

### 44.5 诚实边界

1. **未做真机 / 浏览器 GUI 验证**：证据是纯函数测 + vitest DOM（合成事件 + 假定时器 `vi.setSystemTime`）+ 类型检查 + 扫描门；真机上「到点翻 bit、设置页星期/时间控件的触感」未在设备上看过。
2. `startFocusWatcher` 的 30s 间隔与真实时钟只用 `focusWatcherTick(now)` 传入的 Date 测逻辑、用 `startFocusWatcher` 测「编辑即时生效」与「`stop()` 清定时器 + 监听」，**未做**真实的「跨窗口边界自动翻」长跑。
3. **已知取舍（写在模块 header）**：一个**恰好在窗口内**的手动勿扰会被日程**认领**、并在窗口结束时关闭——不是隐藏缺陷，是写明的边界。
4. 只交付 `工作` / `睡眠` **两个**场景各**一个**窗口（刻意不引入 id 列表这种没人用的泛化）；重叠窗口的「最近开始」排序有测，但真机上两窗口同时生效的视觉读数未看。
5. **并发取号**：REQ 号沿用**本模块代码头已写死**的 **REQ-A684**（该号由一个并发的机器人轮在收尾时**让号**给本轮，见 `CHANGELOG.md` 的 REQ-A686 条；本轮 `focusSchedule.ts` / `osFocusWatcher.ts` / `FocusSchedule.svelte` / `Shell.svelte` 代码头都写 `REQ-A684`），FMEA 号 `grep -rn 'F-SH-148'` **零命中**后取 **F-SH-148**。

## 45. 第四十轮：审计与补全（合规审计记录的构建版本与操作主体，REQ-A695 / F-SH-155，2026-09-20）

### 45.1 审计起点：读出来的真实状态（不是"没有审计"）

`lib/enterprise/audit.ts` 是一座**完整的**合规审计系统（缓冲 / 刷新 / 级别过滤 / 脱敏 / 签名 / 归档 / 同步队列），每条记录都带 `userId` / `userName` / `userEmail` / `deviceId` / `organizationId` 与 `metadata.appVersion`。但「哪个构建产出它」「归属谁」这两栏**都是编造的**：`getAppVersion()` 回落 `audit.ts` **自己那份**字面量 `"0.1.0"`，`getCurrentUserId()`→`"user-default"`、`getCurrentUserName()`→`"Default User"`，`templates.ts` 的 `installedBy` 又抄了同一处。诚实说法是：**有一座能跑的审计台账，但它的构建/主体字段在撒谎。**

### 45.2 修法与结构（一处纯模块收敛两个真源）

- **纯模块** `src/lib/buildIdentity.ts`（**唯一**真源）：
  - `currentAppVersion()`：读 host 覆盖键 `amos.app.version`，否则回**真实构建常量** `AMOS_UI_VERSION`（已由 `version.test.ts` 钉在 `package.json` 上）——**再无第二份字面量**。
  - `resolveAuditIdentity()`：逐字段判定 `amos.user.{id,name,email}`，缺席写显式自描述的 `unattributed` / `Unattributed` 标记（email 保持 `undefined`）——**绝不冒充真人**。
  - 常量：`APP_VERSION_KEY` / `USER_ID_KEY` / `USER_NAME_KEY` / `USER_EMAIL_KEY` / `UNATTRIBUTED_USER_ID` / `UNATTRIBUTED_USER_NAME`。
- **委托**：`audit.ts` 的 `getAppVersion` / `getCurrentUserId` / `getCurrentUserName` / `getCurrentUserEmail` 四个 getter 与 `templates.ts::getCurrentUserId`（`installedBy`）一律改为调用本模块——**一处拼写**。
- **不写任何这些键**：本构建**故意不写** `amos.app.version`，以免覆盖 host 可能提供的设备真实版本（host 覆盖缝保留、本构建只读）。
- **持久化登记**：`scripts/store-allowlist.json` 的 `device-expectation` 理由改写为如实描述（版本 = host 覆盖缝 + 真实常量回落；主体 = 无登录 ⇒ `unattributed`）。

### 45.3 两条会「骗合规读者」的失败面（F-SH-155 的判据，逐条闭合）

| 失败面 | 闭合方式 |
|---|---|
| `audit.ts` 持有**第二份**版本字面量 ⇒ 升版本后每条审计静默谎报构建 | `getAppVersion()` 委托 `currentAppVersion()`，回落**唯一真源** `AMOS_UI_VERSION`；测「空 store 回落 == `AMOS_UI_VERSION`」（版本一升、忘了这里就红） |
| 缺席身份写成 `"Default User"` ⇒ 合规读者读成一个**真实账号** | `resolveAuditIdentity()` 缺席写 `unattributed`；测「三者皆空 ⇒ unattributed」「逐字段独立」「空白视同缺席」；`installedBy` 期望值改 `unattributed` |

### 45.4 测试与证据（实测）

- `bun test src/lib/__tests__/{buildIdentity,enterprise-audit,enterprise-templates}.test.ts` ⇒ **66 pass / 0 fail**（`buildIdentity.test.ts` 新增 11 用例：键拼写 / 回落常量 / host 覆盖 / 空白视同缺席 / 逐字段独立 / 读操作零副作用）。
- 审计套件新增一条「条目上的操作主体在缺席时如实标记 `unattributed`」并把既有 `metadata.appVersion` 断言由 `toBeTruthy()` 收紧为 `=== AMOS_UI_VERSION`。
- **负控（判别力，实测，逐字节还原 + `shasum -a 256`）**：①令 `currentAppVersion()` 回落改回字面量 `"0.1.0-hardcoded"` ⇒ **恰 3 红**（`currentAppVersion` 两条 + 审计 `metadata.appVersion` 一条），身份断言全绿；②令 `resolveAuditIdentity().userId` 回落改回 `"user-default"` ⇒ **恰 4 红**（`resolveAuditIdentity` 两条 + `installedBy` 一条 + 审计主体一条），版本断言全绿。`cp` 还原后 `shasum -a 256` 与扰动前一致（`dba0f3cd76eda3192bbb7507c1641e2aeda41527c072a2b21f00a10a593267b3`）、`cmp` 净、复绿。
- `node scripts/fmea-gen.mjs --check` ⇒ 本行 OK（F-SH-155）；`bun run check` / `bun run test` 见本轮收尾。

### 45.5 诚实边界

1. **没有真实用户登录**：本 shell 就没有登录态，故主体只能是 `unattributed`——这是**如实标记**，**不是**补齐了一个用户系统；真要用户身份得由 MDM/host 写入 `amos.user.*`（host 覆盖缝已留）。
2. `amos.app.version` 仍是 `device-expectation`（本构建**读而不写**）：前端已知自己的构建常量，无需物化进 store，且**故意不写**以免覆盖 host 可能提供的设备真实版本。
3. `getCurrentUserId` 每次读 3 次 store——localStorage 读，代价可忽略，且**读操作零副作用**（审计只被查询不会"落下"一个版本值，已断言）。
4. **并发取号**：落笔前 `grep -rn` 重探最高号为 **REQ-A692 / F-SH-151**，但 `F-SH-152/153/154` 与 `REQ-A693` 均已被并发轮占用（`F-SH-153`/`F-SH-154` 行、`REQ-A692` 行都在其边界里点名 F-SH-152 = 本 `buildIdentity` 轮），故取 **REQ-A695 / F-SH-155**（`grep -rn` 零命中）。

## 46. 第四十一轮：平板功能补全（分屏的持久意图与活的表面分岔，REQ-A700 / F-SH-160，2026-09-20）

### 46.1 审计起点：读出来的真实状态（不是"没有持久化"）

平板的双窗格（`kind:"split"`）**已经**跨重启持久化：`lib/splitPersist.ts` 是纯解码层，`amos.split` 存**意图**（哪两个 app / 轴向 / 比例），`shellState.restoreSplit()` 在宿主报出实测屏幕后恢复**一次**。问题不在"没有恢复"，而在**恢复所依据的那份意图，会和壳当前的表面分岔**——两处：

1. `goHome()` / `lock()` 把分屏表面**换掉**（`_surface = {kind:"home"}` / `{kind:"lock"}`），却**不清** `amos.split`。清它的**只有** `exitSplit()`。于是用户按 Home / 锁屏 / 息屏丢掉的这段分屏，会在**下次启动被 `restoreSplit` 复活**——会话内已经回不去，键却还留着。Home 键（`startOsWakeHome`）、硬件 nav（`startOsHardwarePoll`）与息屏（`startOsAutoOff`）都是真实通路。
2. 进入 `kind:"split"` 的两扇活门——`enterSplit()` 与 `open()` 的**窗格重定向**——**都不检查两窗格是否同一个 app**，能写下 `encodeSplit` 会写、而 `parseSplit` 会拒的 `primary === secondary`。即壳提交了一段**自己的解码层拒绝读回**的分屏，下次启动被**静默丢弃**。`pickSecond` 早已有 `if (id === cur.id) return;`，可见"同一 app 不成对"是既定意图，只是两扇活门没守住。

### 46.2 修法与结构（一条纯谓词 + 一条唯一收尾）

- **纯谓词**（`lib/splitPersist.ts`）：`isSplittablePair(primary, secondary)` = 非空 **且** 互异。它是这个规则的**唯一**描述：`parseSplit` 与两扇活门**全部委托**它，不再各写一遍。
- **唯一收尾**（`svelte/shellState.svelte.ts`）：`clearSplitIntent()`（取消待写的比例防抖 + `removeStoreValue(SPLIT_KEY)`）成为**每一处永久离开分屏表面**的收尾，`exitSplit` / `goHome` / `lock` / `resetShellState` 一律走它——将来新增一处离开通道，也只需调用同一个函数。
- **两扇活门**：`enterSplit` 在 `canSplit()` 之外增加 `isSplittablePair` 前置拒绝；`open()` 的分屏分支若非可成对则**直接返回**（不重定向、不 announce）。
- **未改**：分屏几何仍全部归宿主（`amos_wm::layout::split_panes` 一行未动），不新增功能。

### 46.3 两条「写下的意图 ≠ 能读回的意图」失败面（F-SH-160 的判据，逐条闭合）

| 失败面 | 闭合方式 |
|---|---|
| **已丢弃的状态被复活**：`goHome`/`lock` 换掉分屏表面却不清键 ⇒ 下次启动 `restoreSplit` 复活一段用户丢掉的布局 | `clearSplitIntent()` 在 `goHome`/`lock` 落地（并取消待写，避免拖拽在离开后落笔） |
| **已提交的状态被丢弃**：两扇活门写下 `primary === secondary` ⇒ 下次启动 `parseSplit` 静默丢弃 | `enterSplit`/`open()` 一律经 `isSplittablePair` 守卫，与 `parseSplit` 同一规则 |

### 46.4 测试与证据（实测）

- `bun test src/__tests__/splitPersist.test.ts` ⇒ **17 pass / 0 fail**（含 `isSplittablePair` 四条，其中一条断言"它恰是 `parseSplit` 对解码对施加的规则"）。
- `vitest svelte-tests/shell-state.svelte.test.ts` ⇒ **29 pass / 0 fail**（新增 goHome / lock 丢弃意图、`enterSplit` 拒绝同 app 对、`open()` 取主窗格 app 不成对四条）。
- **负控（判别力，实测，逐字节还原 + `shasum -a 256`）**：①删 `goHome`/`lock` 里的 `clearSplitIntent()` ⇒ **恰 2 红**（两条持久意图用例），余 27 绿；②把 `isSplittablePair` 的互异项删掉 ⇒ **恰 5 红**，余 24 绿。`cp` 还原后 `shasum -a 256` 与扰动前一致。
- `node scripts/fmea-gen.mjs --check` ⇒ 本行 F-SH-160 OK；`node scripts/trace-scan.mjs` ⇒ OK；`bun run check` ⇒ **EXIT 0**。

### 46.5 诚实边界

1. **不新增功能**：只修"写下的意图"与"能读回的意图"不一致，分屏的持久化语义（哪两个 app / 轴向 / 比例）一字未改。
2. **Home 丢弃分屏是既定语义**，不是本轮的发明：`goHome` 早就把 `kind:"split"` 换成 `home`（会话内已回不去），本轮只是让**磁盘上的意图**与这个事实一致。
3. **未动 Rust 侧**：`amos-wm` 的几何、`enter_split` 的意图层语义均未改。
4. **并发取号**：落笔前 `grep -rn` 重探，`REQ-A700` / `F-SH-160` 零命中（`REQ-A699` / `F-SH-159` 已被并发轮占用）。

## 47. 第四十二轮：审计与补全（窗口列表的跨语言镜像两侧谁也不读谁，REQ-A704 / F-SH-164，2026-09-20）

### 47.1 审计起点：一条**自述**的跨语言镜像，没有任何测试跨语言读它

`lib/wm.ts` 的两个窗口列表形状**自述**为 Rust 的镜像——`WmWindowInfo` 的注释写着「One window in the host's `wm_windows` snapshot (Rust `wm::WindowInfo`)」，`WmWindowsSnapshot` 写着「The host's whole windowing state (Rust `wm::WmSnapshot`)」。但把两侧的测试摊开看，**谁也不读谁**：

1. Rust 侧：`amos-tauri/src/wm.rs` 的 `WindowInfo` / `WmSnapshot` **没有任何** wire-shape 钉。（对照同文件的 `LayoutSnapshot`——它至少有 `the_layout_snapshot_wire_shape_is_pinned` 钉住 Rust 本地的 `vec!` 键集。）
2. TS 侧：`wm.test.ts` 的 `normalizeWindows` 用例用 `toEqual` 与一个 **TS 本地字面量**比较——它对 Rust 侧一无所知。

于是「两侧同形」这件事**没有任何一条测试在证明**：改一侧字段名、只在那一侧的字面量里跟着改，两侧测试**全绿**，而 `windowOf` 读到 `undefined` 就**逐字段退化**（id `0`、按 label 猜 app、kind `"Unknown"`）——依赖它的 Dock 运行圆点、AppExpose、SpacesPanel 会**悄悄**降级，不会响亮失败。

`wm_windows` 经 `lib/wm.ts` 的动态 `invoke(command, args)` 抵达，`scripts/tauri-reply-scan.mjs` 按既定边界（只查静态可命名的 `invoke<T>("cmd")`）**看不见**它。这正是 REQ-A667 为布局形状绑过的同一种 SMS-trash 形状——只是窗口列表这一对当时没一起绑。

### 47.2 修法与结构（读权威、逐序比较、先数个数）

- **读权威而不是本地字面量**：新增描述块「wm.ts window-list wire shapes == the amos-tauri::wm serde structs」（`declaredMirrors.test.ts`），读 `amos-tauri/src/wm.rs`，用与布局块同款的 `rustFields(name)` 按**声明序**抽 `pub <name>:`。
- **先数个数**：`WindowInfo` 先断言 **8** 个、`WmSnapshot` 先断言 **2** 个——一个把结构移出扫描窗口的重写会**响亮**失败，而不是比较两个空列表。
- **逐序比较**：与 `Object.keys(normalizeWindows(...))` 比较（`windowOf`/`normalizeWindows` 是按 Rust 声明序构对象的，`Object.keys` 保序）。
- **不许改名**：断言结构体体**不**含 `rename`——`#[serde(rename…)]` 会让「字段名 = 线上键」这个前提失效，解析就会比错东西。
- **标注绑定**：`wm.rs` 的 `WmSnapshot` 文档加 NOTE 指向该绑定；`wm.ts` 两个接口文档加 REQ-A704 标记。
- **未改运行时代码**：`windowOf` / `normalizeWindows` 一字未动（两侧字段实测本就一致，**无现存漂移**）。

### 47.3 判据（「两侧同形」从自述变成会跑的断言，逐条闭合）

| 失败面 | 闭合方式 |
|---|---|
| **Rust 侧字段换序**：`id`/`label` 互换 ⇒ 有 window 的解析按位置错位 | `rustFields` 按声明序比较 `Object.keys`，换序即红 |
| **Rust 侧字段改名**：`windows` → `win_list` ⇒ 壳读 `undefined`，窗口列表恒空 | 同上，且先断言的个数把「结构搬走」也变红 |
| **任一侧 `#[serde(rename…)]`**：字段名与线上键脱钩 | 体 `not.toContain("rename")` |

### 47.4 测试与证据（实测）

- `bun test src/__tests__/declaredMirrors.test.ts` ⇒ **23 pass / 0 fail**（新增 1 条），211 expect。
- **负控（判别力，实测，逐字节还原 + `shasum -a 256`）**：①把 `WindowInfo` 的 `id`/`label` 在 Rust 里**换序** ⇒ **恰 1 红**（新绑定），余 22 绿；②把 `WmSnapshot.windows` 改名 `win_list` ⇒ **恰 1 红**，余 22 绿。`cp` 还原后 `shasum -a 256` 与扰动前一致（`45bf4960…`）。
- `node scripts/fmea-gen.mjs --check` ⇒ **388 failure modes documented**（含 `F-SH-164`）；`node scripts/trace-scan.mjs` ⇒ OK；`bun run check` ⇒ **EXIT 0**。

### 47.5 诚实边界

1. **无现存漂移**：两侧字段此刻一致，本轮补的是「两侧同形」的**证据**，不是修一个坏值（与 REQ-A667 / A690 / A692 同族）。
2. **同一族还剩一处未绑**：`spaces.ts` 的 `SpaceSwitchReport` / `SwitchFailure` 自称与 `spaces_commands` 一一对应，尚未有跨语言钉，留待后续轮。
3. **`tauri-reply-scan.mjs` 看不见动态 invoke 命令**，是该门既定边界——正是需要这层跨语言钉的原因。
4. **并发取号**：落笔前 `grep -rn` 重探，`REQ-A704` / `F-SH-164` 零命中（`REQ-A703` / `F-SH-163` 已被并发轮占用）。

## 48. 第四十三轮：平板功能补全（文件 app 采纳 iPadOS 主从侧栏，REQ-A739 / F-SH-196，2026-09-21）

**起点**：「继续完善平板电脑的功能，全面测试」。本轮收窄 `docs/multi-window.md` §1.5② 记下的**已知边界**——「其余 app 仍未采纳」`masterDetail`。

### 48.1 为什么是 Files

- iPadOS 的主从侧栏是一条**已测过的复用决策** `lib/formLayout.ts::masterDetail(form, columns, width)`（`form === "tablet" && columns >= 2 && measured && width >= TABLET_SIDEBAR_MIN_WIDTH` ⇒ `{ sidebar, sidebarWidth }`）。
- 到本轮为止**只有** `SettingsApp.svelte` 一处消费它。Files 有**真正的导航模型**（`folderTree(list)` 给出层级），是第二个**该**采纳的 app。
- 最省事的采纳是让 FilesApp **各写一遍**「够宽了吗」：阈值／phone 判据／measured 守卫就会有两处，改一处另一处不会跟；把 `form` 判据误用成宽度判据会让横屏手机冒出侧栏——而**没有一条测试**在两条路径之间对照（与 F-SH-186／F-SH-187 域漂移同型）。

### 48.2 改动

- `FilesApp.svelte` **消费**同一个纯决策：`const md = $derived(masterDetail(snap?.form ?? "phone", snap?.columns ?? 0, snap?.screen_w ?? 0)); const wide = $derived(md.sidebar);`——**不重写**任何阈值／判据（一条规则一处实现）。
- `{#if wide}` 渲染 `<aside data-testid="files-sidebar">`，只列 `folderTree(list)` 的文件夹行（`files-side-root` / `files-side-<id>`），行点击经 `selectCwd` 复用 `openFolder` 的**同一组**重置（`mode`/`globalSearch`/`query`/`spotId`/`focusedId`）。
- **phone 路径零回归**：明细包裹层在 `!wide` 时 `class="contents"`（`display:contents`，**有包裹层、无布局盒**），只有 `wide` 才换 `flex`。
- i18n 两语各补 `files.locations`（侧栏可及名）。
- **未改** `formLayout.ts` 的 `masterDetail` 一行、**未改** SettingsApp。

### 48.3 测试（`svelte-tests/files-sidebar.svelte.test.ts`，7 条）

`bunx vitest run svelte-tests/files-sidebar.svelte.test.ts` ⇒ **7 passed / 0 fail**；与既有 Files 套件同跑 ⇒ `files-sidebar(7)+files(34)+files-share(10)+settings-sidebar(8)` = **51 passed / 0 fail**。

七条钉住的接线：①phone→无侧栏且明细 `className==="contents"`；②unmeasured→保守无侧栏；③窄平板（`screen_w:600`）→单列；④真平板→`files-sidebar`+`files-side-root`+`files-side-doc` 且列表不变；⑤选文件夹 → `aria-current` 迁移且 `说明.txt` 离开列表、root 行回退；⑥host 重测 → 无重挂翻面；⑦侧栏可及名 == `zh["files.locations"]`。

### 48.4 负控（判别力，实测，逐字节还原 + `shasum -a 256`）

把 `const wide = $derived(md.sidebar)` 强制为 `$derived(false && md.sidebar)`（侧栏永不渲染）⇒ **恰 4 条**平板路径用例红（真平板渲染／选文件夹／host 重测翻面／可及名），**3 条** phone 路径用例**全绿**——证明这 4 条真依赖侧栏接线、且 phone 路径与侧栏解耦。逐字节还原后 `shasum -a 256 crates/amos-tauri/frontend-ts/src/svelte/FilesApp.svelte` = `458902bd8b5c2a004cc9c494c320404cf499f29c241f7647342de947f9d3caba`（与扰动前一致），复绿 7。

### 48.5 诚实边界

1. **能力采纳**而非修坏值：`masterDetail` 与 Settings 路径本就正确，本轮让**第二个** app 消费它并钉住接线。
2. DOM 测用合成 `LayoutSnapshot` 与假 host 状态，**未做**真机／浏览器 GUI 验证。
3. `docs/multi-window.md` §1.5② 的「其余 app 仍未采纳」由本轮**部分**收窄：Files 已采纳；Notes／其它 app 仍待。
4. **并发取号**：落笔前 `grep -rl` 重探，`REQ-A739` / `F-SH-196` 双向零命中（`REQ-A738` / `F-SH-194` 与在途 `F-SH-195` 已被并发轮占用）。

## 49. 第四十四轮：审计与补全（旋转锁的跨语言镜像两侧谁也不读谁，REQ-A765 / F-SH-222，2026-09-21）

**起点**：「继续审计，继续补全代码」。本轮在**平板方向（rotation lock）**这条线上续审，收窄的是 REQ-A677 那条线上**已声明却无人核对**的镜像。

### 49.1 缺陷

`lib/rotation.ts` 的 doc 自陈三组跨语言镜像：①宿主应答形状 `RotationSnapshot`／`RotationApplied`（来自 `crates/amos-tauri/src/rotation.rs`）；②`outcome` 的 tagged 状态词表 `RotationOutcome`；③两个**行为**镜像 `orientationOf`（与 Rust `orientation_of` 同义）与 `rotationFreezes`（与 `RotationMode::freezes` 同义）。

但 `rotation.test.ts` 只在 `:152` 把 `ROTATION_MODES` 绑到 `RotationMode::key()`——**其余每个值／行为都是测试文件里的本地字面量**（前端自证前端）；Rust 侧只钉自己的 `serde_json::json!` 字面量，**从不读 TS**。`tauri-reply-scan.mjs` 看不见动态 `invoke(command, args)`，故这条缝无人补。

**实测盲区**：把 `RotationSnapshot.available` 改名为 `can_apply`（连带构造器）后，前端 `applied.available` 静默变 `undefined`，而 `rotation.test.ts` 仍 **16/16 全绿**。两个真实后果——桌面／CI 的诚实 `host_only` 与「真的不可用」在状态词漂移后不可分；`orientationOf` 若从 `>` 漂成 `>=`，正方形视口在 home grid 与朝向读取之间分岔。

### 49.2 改动（未改任何 Rust 生产代码）

- `declaredMirrors.test.ts` 新增 describe「rotation.ts reply shapes == the amos-tauri `rotation.rs` serializable structs」四用例：
  1. `RotationSnapshot`（2 字段）／`RotationApplied`（3 字段）字段名**逐序**与 TS interface 相等；
  2. `RotationOutcome` 头含 `rename_all = "snake_case"`／`tag = "state"`／`content = "detail"`，六变体 snake-cased 后含 `applied`／`host_only`，且 TS 确有 `state === "applied"`／`state === "host_only"` 两处显式分支；
  3. `orientation_of` 用严格 `>`（正方形算竖屏），三组宽高断言一致；
  4. `freezes()` 唯 `auto` 不冻结，逐模式与 `rotationFreezes` 等价。
- `rotation.ts` 相应 doc 点名绑定；`orientation.rs` 的 `orientation_of` 文档由不存在的 `formLayout.ts::tabletHomeGrid` 改为真源 `homeGrid`（仅 doc）。
- **未改** `rotation.rs`（一行未改）。

### 49.3 门禁

`bun test src/__tests__/declaredMirrors.test.ts` ⇒ **38 passed**（+4，修前 34）；与 `rotation.test.ts` 同跑 ⇒ **54 passed**；`cargo test -p amos-display` ⇒ 11 passed；`cargo test -p amos-tauri rotation::` ⇒ 8 passed；clippy 净；`bunx tsc --noEmit` 净；`node scripts/fmea-gen.mjs --check` ⇒ 444 失效模式 GREEN、`--self-test` ⇒ 12/12；`node scripts/trace-scan.mjs` ⇒ OK。

### 49.4 负控（判别力，实测，逐字节还原 + `shasum -a 256`，四条各恰 1 红）

①`available`→`can_apply` ⇒ 用例⑴恰 1 红（`rotation.test.ts` 仍 16/16 绿，盲区实证）；②`tag = "state"`→`"kind"` ⇒ 用例⑵恰 1 红；③`>`→`>=` ⇒ 用例⑶恰 1 红；④`!matches!(Auto)`→`matches!(Locked)` ⇒ 用例⑷恰 1 红；逐字节还原后复绿。

### 49.5 诚实边界

1. 这是**被声明却无人核对的跨语言镜像**（可静默漂移）而非当下坏值——今日两侧逐字一致。
2. **未改**任何 Rust 生产代码（`rotation.rs` 逐字未动，`orientation.rs` 只改一处 doc 注释），前端只加测试与 doc 注释。
3. 只绑 `rotation.rs`／`orientation.rs` 这一处镜像；`ROTATION_MODES`↔`key()` 已由 `rotation.test.ts:152` 单独钉住，本轮不重复。
4. `RotationOutcome` 的 `Unattached/Unavailable/Denied` 三态前端归入 `unapplied` 兜底，故只钉 `applied`／`host_only` 两处显式分支。
5. 证据为前端 bun 单测 + tsc + cargo 单测 + 四条活负控，**未做**真机旋转复跑。
6. **并发取号**：落笔前 `grep -rhoE` 重探（根目录），高水位 REQ-A764 / F-SH-221，取 **REQ-A765 / F-SH-222**（双向零命中）。

## 50. 第四十五轮：审计与补全（AI 屏幕把「宿主接受」读成「宿主离线」，REQ-A898 / F-SH-288，2026-09-22）

**起点**：「继续审计与补全代码」。本轮落在 AI 助手屏幕上——`lib/backend.invoke` 的 `null` 语义对一个**不返回载荷**的命令不成立。

### 50.1 缺陷

`crates/amos-tauri/src/ai_bridge.rs` 的 `chat_agent`（`:1017`）与 `cancel_ai_session`（`:1124`）都是 `Result<(), AmosError>`：前者 spawn 后台消费者后**立刻** `Ok(())`，后者无条件 `Ok(())`。`Ok(())` 经 serde 序列化成 `null`，而 `lib/backend.ts::invoke`（`:166`）在「未桥接 / 命令抛错」时**也**回 `null`。于是 `AiApp.svelte` 的两处判据 `if (r == null)`（发送）与 `if (res == null)`（停止）**永远为真**。

**后果**：宿主**接受**一次发送后，界面立刻 `busy=false`（「⏹ 停止」按钮随之消失）、`curId=null`（`patchCur` 丢弃每一枚 token，agent 气泡永远空）并显示 `backend.offline`（「未连接守护进程：需 Tauri + 本地 daemon 才能真实对话/翻译」）——而守护进程正在流式回话。

**为什么全绿**：唯一的 AI DOM 测试 `ai.svelte.test.ts` 跑的是**离线**路径（无 `__TAURI_INTERNALS__`），那里 `null` 确实等于「没守护进程」；两盏既有闸门也都在其外——`void-cmd-scan` 的清单只收 `Promise<null|void>` 包装（这两个是 `Promise<unknown>`），`void-rejection-scan` 只管能 reject 的 callee。

### 50.2 改动（未改任何 Rust）

- `AiApp.svelte` 新增 `refusalDetail(command)`：读 `bridgeDiag(command)`（REQ-A297 的 typed-error 纪律，与 `DesktopShell.windowMenuAction` 同一读法），`command-failed` 时取 typed `code`、否则退回 `kind`。
- 发送判据 `r == null` → `!bridgeDiag("chat_agent").ok`；停止判据同样改读台账，且**无论成败都在本地结束本轮**（停在「取笔记上下文」那一段时没有可取消的流、不会有 `ai-chat-complete`，等事件会把 UI 卡在「⏹ 停止」）。
- i18n 两语各补 `ai.sendRefused`／`ai.stopRefused`（各带 `{code}`）。
- 新增 `svelte-tests/ai-online.svelte.test.ts`（4 条**已桥接**用例：busy 保持／token 落进气泡／停止不说离线／拒绝带 code）。

### 50.3 门禁与负控

`bunx vitest run svelte-tests/ai-online.svelte.test.ts` ⇒ **4 passed**；与 `ai.svelte.test.ts`（12）／`voice-buttons.svelte.test.ts`（13）同跑 ⇒ **29 passed**；`i18n:scan`／`void:scan`／`voidrej:scan`／`readfold:scan`／`diag:scan`／`deadcatch:scan`／`testreach:scan` OK；`fmea-gen --check` 556 模式 GREEN、`--self-test` 12/12；`trace-scan` OK。

负控（逐字节还原 + `shasum -a 256`）：①发送判据忠实还原 ⇒ **恰 4 红**；②只还原停止判据 ⇒ **恰 1 红**；③两条都改成永不成立 ⇒ **恰 1 红**（拒绝被静默那条）。还原后 sha `469e3144…` 复绿 4。

### 50.4 诚实边界

1. 这是**当下真实的功能缺陷**（真机上流式对话不显示 token、且假称离线），不是可静默漂移的镜像。
2. **改了**一处生产代码（`AiApp.svelte`）与两份 i18n；**未改** Rust（两条命令的形状与语义逐字不变）与 `lib/backend.ts`。
3. `send()` 的「未桥接」分支实际不可达（进入发送前已 `if (!online) return`），故该判据只保留「命令被拒」一种解释。
4. 证据为前端 vitest（真 DOM 渲染）+ tsc + 六盏扫描 + 三条活负控，**未做**真守护进程端到端复跑。
5. **并发取号**：落笔前 `grep -rhoE` 重探（根目录），高水位 REQ-A897 / F-SH-287，取 **REQ-A898 / F-SH-288**（双向零命中）。

## 51. 第四十六轮：审计与补全（口译屏幕把「宿主拒绝」读成「已完成」，REQ-A1054 / F-SH-369，2026-09-22）

**起点**：「继续帮助我审计与补全代码， 完善平板电脑功能， 全面测试」。本轮是 §50 的**同一族、同一份结构盲区**，落在口译屏幕上——而这一次，正确读法**就在同一个文件里**。

### 51.1 缺陷

`crates/amos-tauri/src/interpret.rs` 的 `interpret_text`（`:344`）、`interpret_pause`（`:415`）、`interpret_resume`（`:433`）、`interpret_stop`（`:452`）都是 `Result<(), String>`，可拒于 `check_id` 不匹配 / `no active session` / `session.pause()`／`resume()`／`stop()` 报错 / 文本超长。`Ok(())` 经 serde 就是 `null`，与 `lib/backend.invoke` 拒绝时回的 `null` **同值**。`InterpApp.svelte` 三处把它们当成「已完成」：

- `togglePause()`：**读都不读**就 `paused = true`／`false` —— 拒绝的暂停让按钮立刻显示「继续」，而守护进程**仍在翻译**：屏幕宣称了一个它从未进入的状态（乐观写）。
- `endSession()`：先 `sid = null` 再 `await interpretStop(id)` —— 拒绝时界面宣称「已结束」，而守护进程里的会话**还活着**，且**句柄已经丢了**（再无入口能停它）。
- `send()`：先 `text = ""` 再 `await interpretText(id, v)` —— 拒绝时**用户刚打的字被静默吞掉**，而这正是上方离线分支存在的理由（它写着「keep the typed text and explain instead of clearing it into a silent no-op」）。

**为什么全绿**：四个包装声明为 `Promise<unknown>`，而 `scripts/void-cmd-scan.mjs:309` 的普查正则只收 `Promise<null>` / `Promise<void>`（`--json` 实测查无 InterpApp）；既有的两套 mock 解析的是真值（`async () => true`）而非 `null`，没有一条测试走拒绝方向；离线套件无桥。**同一个文件里的 `endUtterance()` 早已写着正确读法**（`bridgeDiag("interpret_end_of_speech")`，REQ-A297），`interp-end-sentence.svelte.test.ts` 也已证明这族可被覆盖——只是没覆盖到这三处。

### 51.2 改动（未改任何 Rust）

- `togglePause()` 改读 `bridgeDiag(resuming ? "interpret_resume" : "interpret_pause")`，仅 `ok` 时翻转 `paused`；拒绝时写 `interp.resumeFailed` / `interp.pauseFailed`。
- `endSession()` 改为**先在宿主结束**：`interpretStop` 被拒则 `status = interp.stopFailed` 并 `return`（保留 `sid`/`running`，可重试），成功才清 `sid` 并收尾。
- `send()` 改为**先发后清**：`interpretText` 被拒则写 `interp.sendFailed` 并保留 `text`。
- i18n 两语各补 `interp.pauseFailed` / `interp.resumeFailed` / `interp.stopFailed` / `interp.sendFailed`。
- 新增 `svelte-tests/interp-refusal.svelte.test.ts`（5 条**已桥接**用例）。

### 51.3 门禁与负控

`bunx vitest run svelte-tests/interp-refusal.svelte.test.ts` ⇒ **5 passed**；与 `interp.svelte.test.ts`（8）／`interp-end-sentence`（3）／`interp-state`（1）同跑 ⇒ **17 passed**；`tsc --noEmit` 与 `svelte-check` **0 error / 0 warning**；`i18n:scan`／`void:scan`／`voidrej:scan`／`readfold:scan`／`diag:scan`／`deadcatch:scan`／`testreach:scan` OK；`fmea-gen --check` 636 模式 GREEN、`--self-test` 12/12；`trace-scan` OK。

负控（`cp` 逐字节还原 + `shasum -a 256`）：①三处判据忠实还原为改动前的乐观写 ⇒ **恰 3 红**（拒绝的暂停/结束/发送各一），两条回归仍绿；②再**只**还原暂停一处 ⇒ **恰 1 红**（暂停那条）。还原后 sha `e3fc57ec…` 复绿 5。

### 51.4 诚实边界

1. 这是当下**真实的**一致性／可用性缺陷（拒绝的暂停谎称已暂停；拒绝的结束留下不可达的孤儿会话；拒绝的发送吞掉用户输入），不是可静默漂移的镜像。
2. **改了**一处生产代码（`InterpApp.svelte`）与两份 i18n；**未改** Rust（四条命令逐字不变）与 `lib/backend.ts`。
3. `togglePause()` 的拒绝需宿主真的拒（`check_id` 不匹配 / `session.pause()` 报错），测试用台账驱动，**未做**真守护进程端到端复跑。
4. `interpretAudio()`（每次 2048 样本的 `void` 推流）仍是「发了不问」——逐帧报告会刷屏，且守护进程的 `error`／`session_ended` 事件才是它的诚实出口，本轮**未动**并在此注明。
5. **并发取号**：落笔前 `grep -rhoE` 重探，高水位 REQ-A1053 / F-SH-368（并发轮），取 **REQ-A1054 / F-SH-369**（双向零命中）。

---

## 52. 第四十七轮：审计与补全（按住说话的麦克风把「宿主拒绝」读成「已完成」，还先推了一条假「你说话了」气泡，REQ-A1061 / F-SH-376，2026-09-22）

### 52.1 缺陷

`crates/amos-tauri/frontend-ts/src/svelte/StreamVoiceButton.svelte`（按住说话）是这个「返回 `()` 的宿主命令被读成成功」族（**F-SH-288** → **REQ-A1054**／**F-SH-369**）在**语音按钮**上的最后一处，且是唯一一处同时有**两个**后果的：

1. **两处拒绝被吞**。`crates/amos-tauri/src/assistant_voice.rs` 的 `assistant_voice_start`（`:302`，`Result<(), AmosError>`，失败于 `MAX_VOICE_SESSION_ID_BYTES` 或 `VoiceLink::open` —— 后者在守护进程不可达时失败，`:140`）与 `assistant_voice_end`（`:361` → `end_utterance()` `:277`，`Result<(), String>`，经 `active_tx()?`「no active voice session; start it first」或 mpsc 发送失败拒绝）的 `Ok(())`，到桥上序列化成与拒绝**同一个 `null`**（`lib/backend.invoke` 在未桥接／抛出时也返回 `null`）—— 只能由 `bridgeDiag(command)` 分辨（REQ-A297）。`start()` 与 `stop()` **两处都没读它**：宿主从未打开的监听器看起来与已打开的一模一样，本地采集照常启动、每一帧发向虚空、回复永不到来、而用户什么也听不到。
2. **更坏的第二半**：`onStart?.()`（它在 `AiApp` 里推入 `pushMsg("user", t("ai.voicePrompt"))` 这条用户气泡）原本在守卫**之前**执行 —— 屏幕主动陈述了一件它并没有做的事，用户据此以为在等一个答案，而根本没有那一轮。

**为什么全绿**：`crates/amos-tauri/frontend-ts/scripts/void-cmd-scan.mjs` 的语料正则（`:309` 附近）只收 `Promise<null>`／`Promise<void>`（含其联合）的包装器，而这两个包装器声明为 `Promise<unknown>`，**结构上就在语料之外**（`--json` 无 `StreamVoiceButton` 条目）；根 `scripts/tauri-reply-scan.mjs` 有 unit 侧（`Result<(), _>` ↔ `null`）但**跳过 `unknown`**；既有用例的宿主 mock 解析出真值而非 `null`，没有一条走拒绝方向。

### 52.2 改动（未改任何 Rust）

1. `StreamVoiceButton.svelte`：`start()` 在 `await assistantVoiceStart(sid)` 之后补 `if (!bridgeDiag("assistant_voice_start").ok) { recording = false; onError?.("assistant_voice_start"); return; }`，并把 `onStart?.()` 移到验收之后；`stop()` 在 `await assistantVoiceEnd()` 之后补 `if (!bridgeDiag("assistant_voice_end").ok) onError?.("assistant_voice_end");`。
2. `StreamVoiceButton.svelte` 新增 `onError?: (command: string) => void` 属性（由拥有状态行的屏幕拥有文案）。
3. `AiApp.svelte`：把 `onError` 接进它自己拥有的状态行 `meta` —— `meta = t("ai.voiceRefused", { code: refusalDetail(cmd) })`（`refusalDetail` 读 `bridgeDiag`，`command-failed` 时取出类型化 `code`）。
4. `src/i18n/locales/{zh,en}.ts`：新增 `ai.voiceRefused`（带 `{code}` 占位）。
5. **未改**任何 Rust —— `assistant_voice.rs` 的两处 `Result` 语义已正确，缺陷全在前端读取；`onDestroy` 里的 `assistant_voice_stop` 保持 fire-and-forget 是**有据的**（该命令无条件 `Ok(())`、`VoiceSession::stop` 连 mpsc 结果都丢弃），非本轮遗漏。

### 52.3 门禁与负控

- `bunx vitest run svelte-tests/voice-buttons.svelte.test.ts svelte-tests/ai-online.svelte.test.ts` ⇒ **21 passed**（16+5）。新用例：`voice-buttons`（拒启 ⇒ `errors === ["assistant_voice_start"]`、`starts === []`、`aria-pressed === "false"`；接受 ⇒ `starts === [1]`、`errors === []`；拒终 ⇒ `errors === ["assistant_voice_end"]`）＋ `ai-online`（拒启 ⇒ 状态行含 `ai.voiceRefused` 前缀与 `amos.ai.rpc_failed`，且**不含** `ai.voicePrompt`）。
- 未改前三处新用例各有对应红：`voice-buttons` 拒启 ⇒ 谎报已开始；`ai-online` 拒启 ⇒ 状态行无 `ai.voiceRefused` 且含 `ai.voicePrompt`。
- **负控（实测，`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）**：**NC-A** `start()` 与 `stop()` 两处守卫一并拆 ⇒ **恰 2 红**；**NC-B** 只拆 `start()` 守卫 ⇒ **恰 1 红**（正是 `AiApp` 那条新用例）—— 守卫在「拒绝」与「接受」两向都承重，非装饰。还原后 `StreamVoiceButton.svelte` = `834c222c81acd0a08027a78fc38aea31f6e41bf87a55a2b1d2e6b9b0b79a5b7b`。

### 52.4 诚实边界

1. 当下**真实缺陷**，非可静默漂移的镜像。
2. **改了**两个生产组件（三处守卫 + 一个 `onStart` 位置 + 一个 `onError` 回调）与两个 i18n 文件。
3. **未改**任何 Rust（`assistant_voice.rs` 的两处 `Result` 语义已正确）。
4. `assistant_voice_stop` 保持 fire-and-forget 是**有据的**，非本轮遗漏。
5. 拒绝需宿主真的拒（守护进程不可达 ⇒ `VoiceLink::open` 失败；或活动会话缺失），测试用宿主 mock 抛出驱动，**未做**真守护进程端到端复跑。
6. **并发取号**：落笔前 `grep -rhoE` 重探，高水位已至 **REQ-A1060 / F-SH-375**（并行轮），原拟的 REQ-A1055 / F-SH-370 已被占用，故取 **REQ-A1061 / F-SH-376**（双向零命中）。

---

## 53. 第四十八轮：审计与补全（「取消收藏」把写入判决丢了 —— 同一函数里兄弟分支读了、它没读，REQ-A1064 / F-SH-379，2026-09-22）

### 53.1 缺陷

`crates/amos-tauri/frontend-ts/src/lib/webman.ts:705` 的 `removeBookmark(id): boolean` 是**返回判决**的写入：它经 `saveBookmarkStore`（`:612`）调 `writeStoreValueChecked`，版本冲突 / 存储写不进 / 抛错都回 `false`。`WebManApp.svelte` 的 `toggleBookmark()`：

1. **移除分支丢判决**。添加分支读了 `addBookmark` 的 `null`（⇒ 报 `bookmarkFailed`），移除分支却是 `removeBookmark(bookmark.id); showToast(t("webman.toast.bookmarkRemoved"));` —— 无条件播报「已取消收藏」。而 ★ 星形是**重读存储**画的（`isBookmarked(activeTab.url)`），于是拒绝时屏幕自相矛盾：toast 说取消了、★ 还是 ★。
2. **列表 ✕ 更糟**。书签列表每行的 ✕（`:846`）也丢判决，且**什么也不说** —— 行还在、无提示，一次没生效的删除看起来像按了个空按钮（静默 no-op）。

**为什么全绿**：`crates/amos-tauri/frontend-ts/scripts/write-scan.mjs` 的判决链 `writeAnswerFns`（`:248`）只认 `export function X(...): boolean` 且函数体**直接** `return writeStoreValueChecked(`（或 `return <已知判决函数>(`）的形状。本仓惯用的 `if (!checked(...)) { return false } … return true`、以及**非导出**的中间层 `saveBookmarkStore`，都让链在私有链接处断掉 ⇒ `removeBookmark` 从未被判为判决函数，其调用点对门禁不可见（`void-cmd-scan` 只看桥命令，`write:scan` 报 0 丢弃）。**实测**：把门禁放宽到该形状后，全仓新露出 **11 个**被丢弃的判决点 —— `WebManApp.svelte` 的 `removeBookmark` ×2 与 `updateDownload` ×8、`shortcuts.ts` 的 `updateShortcut` ×2。

### 53.2 改动（未改任何 Rust，未改 `lib/webman.ts`）

1. `WebManApp.svelte` `toggleBookmark()` 移除分支：`const removed = removeBookmark(bookmark.id); showToast(t(removed ? "webman.toast.bookmarkRemoved" : "webman.toast.bookmarkRemoveFailed"));`。
2. `WebManApp.svelte` 书签列表行内 ✕：`if (!removeBookmark(bookmark.id)) showToast(t("webman.toast.bookmarkRemoveFailed"));`。
3. `src/i18n/locales/{zh,en}.ts`：新增 `webman.toast.bookmarkRemoveFailed`（zh「取消收藏失败——书签仍在」／en「Failed to remove the bookmark — it is still saved」）。
4. **未改** `lib/webman.ts`（`removeBookmark` 的布尔语义已正确，缺陷全在调用方读取）。

### 53.3 门禁与负控

- `bunx vitest run svelte-tests/webman-bookmark-refusal.svelte.test.ts` ⇒ **3 passed**；连同既有 webman 四套 ⇒ **21 passed**。
- 未改前：★ 拒 ⇒ 播报 `bookmarkRemoved`（谎）；✕ 拒 ⇒ 无任何提示。
- `tsc --noEmit` 0 错；`svelte-check` 0 错 0 警（1457 文件）；`i18n:scan` / `write:scan` / `store:scan` / `void:scan` / `readfold:scan` / `diag:scan` / `deadcatch:scan` / `testreach:scan` 均 OK。
- **负控（实测，`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）**：**NC-A** 两处一并回退 ⇒ **恰 2 红**（两条「拒绝向」；「★ 收」那条**保持绿** —— 它是防「一律报失败」假绿的反向半边，故诚实读数是 2 红而非 3）；**NC-B** 只回退 ★ ⇒ **恰 1 红**；**NC-C** 只回退 ✕ ⇒ **恰 1 红**。还原后 `WebManApp.svelte` = `4a686744e60171e5f24a4711abd76de954be42484b2680d0343d5ffe9e4e531b`。

### 53.4 诚实边界

1. 当下**真实缺陷**，非可静默漂移的镜像。
2. **改了**一处生产组件（两处读取）与两个 i18n 文件。
3. **未改**任何 Rust 与 `lib/webman.ts`。
4. **门禁盲区未修** —— 本轮只修**站点**，未改 `write-scan.mjs` 的判决链；放宽它会新露出 **11 个**被丢弃的判决点（已列出），那是一个**独立议程**（改的是共享门禁、影响其余所有轮次）。
5. **未主张**「查找键不匹配」那半（`isBookmarked` 用 sanitize 后的 URL、`find` 用原始 URL）：实测 `tab.url` 落盘时已是 sanitize 后的形式且 `sanitizeUrl` 幂等，该路径**不可达**。
6. **并发取号**：落笔前 `grep -rhoE` 重探，高水位已至 **REQ-A1063 / F-SH-378**（并行轮），原拟的 REQ-A1062 / F-SH-377 已被占用，故取 **REQ-A1064 / F-SH-379**（双向零命中）。

---

## 54. 第四十九轮：审计与补全（「清除已完成」的判定签成 `void` —— 调用方无从知道清没清掉；同一颗 🧹 又比它做的事宽，REQ-A1068 / F-SH-383，2026-09-22）

起点：「继续帮助我审计与补全代码， 完善平板电脑功能， 全面测试」。

### 54.1 缺陷（先证）

`crates/amos-tauri/frontend-ts/src/lib/webman.ts:1123` 的 `clearCompletedDownloads()` 经
`saveDownloadStore` → `writeStoreValueChecked` 问过存储才动手（版本冲突 ／ 存储拒写 ／ 抛错都
耗完 3 次重试，`logger.error('Failed to clear completed downloads')` 之后再返回），但签名是
`: void`。调用方 `crates/amos-tauri/frontend-ts/src/svelte/WebManApp.svelte::clearFinishedDownloads`
于是**无从知道**清没清掉，无条件播报成功：

```ts
function clearFinishedDownloads() {
  clearCompletedDownloads();      // 判定无从读（void）
  downloadsTick++;
  showToast(t("webman.download.clearCompleted"));   // 无论存储收没收，都说「清除已完成」
}
```

两半各自独立成错：

1. **判决签成 `void`**：`saveDownloadStore` 会**拒写**（`normalizedVersion(current.version) !== expectedVersion`
   或 `writeStoreValueChecked` 为假）。此时列表**一行未少**，toast 却说「清除已完成」—— 屏幕自相矛盾
   （说清了、行还在）。这与上一轮 `F-SH-379` 同族，但落点不同：那条是**读了又丢**，本条是**根本无从读**。
2. **开关比操作宽**：同一颗 🧹 的 `disabled` 是 `!downloads.some((d) => d.status === "completed" || d.status === "failed")`
   —— `completed` 或 `failed` 皆可点亮；而函数只 `filter((d) => d.status !== "completed")`。⇒ 一个**只剩
   failed 行**的列表：按钮可点、点下去什么都不清、还播报清完了。

**为什么不能靠「清更多」来消解**：`failed` ／ `canceled` 的行各自带着「重试」入口，是**可恢复**的状态，
不是垃圾。把它们一并扫走才会丢用户的东西。所以正确的修法是**收窄开关**，而不是放宽操作。

### 54.2 改动

1. `src/lib/webman.ts`：`clearCompletedDownloads(): boolean` —— 成功路径 `return true`，耗尽重试 `return false`
   （注释写明与 `removeDownload` ／ `updateDownload` 同一条判定链，以及「只清 `completed`」的理由）。
2. `src/svelte/WebManApp.svelte`：`clearFinishedDownloads` → `onClearCompleted`，读判定分两路播报。
3. `disabled` 收窄到 `status === "completed"`。
4. `src/i18n/locales/{zh.ts,en.ts}`：新增 `webman.download.clearFailed`
   （zh「清除失败——已完成的下载仍在」／en "Failed to clear — the completed downloads are still listed"）。

### 54.3 门禁与负控

- `bunx vitest run svelte-tests/webman-clear-completed-refusal.svelte.test.ts` ⇒ **3 passed**（新文件）：
  拒写 ⇒ 说 `clearFailed` 且**不说** `clearCompleted`；收下 ⇒ 反之（反向半边，防「一律报失败」假绿）；
  只剩失败行 ⇒ 🧹 `disabled` 为真、且该行的「重试」入口仍在。
- `bun test src/lib/__tests__/webman-persistence.test.ts` ⇒ **63 passed**：把原来只验「没落盘」的 `void` 断言
  升级为**双向**（`failWrites` 时 `toBe(false)`、放行后 `toBe(true)`）。
- 全套 `bun run test:svelte` ⇒ **164 文件 / 1975 passed**；`bun run test` ⇒ `[bun-iso] test OK`；
  `typecheck` ／ `typecheck:svelte` ⇒ 0 errors。
- **负控（实测，`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）**：
  **NC-A** 调用方丢掉判定 ⇒ **恰 1 红**；**NC-B** `disabled` 改回 `completed 或 failed` ⇒ **恰 1 红**；
  **NC-C** 库内 `return false` 改成 `return true` ⇒ webman-persistence **恰 1 红** —— 三条各自独立承重。
  还原后 `WebManApp.svelte` = `109a173b0d140fe2aa057b1956b19dd344adce73034f03a07cbc4bec09210c5f`、
  `webman.ts` = `0c89b245d518cf621ec8b15336b71540ac2b58c0bf27f121e9031c3f7efaf1af`。

### 54.4 诚实边界

1. **改**一个库函数签名（`void` → `boolean`，无既有调用方依赖 void）、一处生产组件、两份 i18n 与两处测试。
2. **未改**任何 Rust。
3. `write-scan.mjs` 的盲区（`void` 签名的写入函数 + 非导出中间助手 + `if (!checked(...)) return false` 形状）
   **未推宽** —— 动共享门禁会波及并行轮；本轮只修它藏住的**这一处**，其余站点（`updateDownload` ／ `updateShortcut` 等）
   仍是独立议程。
4. **未**放宽 `filter` 去连带清 `failed` ／ `canceled`（那会删掉可恢复的行）。
5. **并发取号**：落笔前重探高水位，原拟的 **REQ-A1067 ／ F-SH-382** 已归并行轮（DTMF 键盘），故取
   **REQ-A1068 ／ F-SH-383**（双向零命中）。
6. `unwired:scan` 本轮为红，但红的是**并行轮的** `src/lib/pushNotifications.ts::PUSH_STATUS_FIELDS`
   （本轮未触碰该文件），不是本轮。

## 55. 第五十轮：审计与补全（下载「重试」一次按键开跑两次 —— 宿主另铸 id，那次传输没有行，REQ-A1072 / F-SH-387，2026-09-22）

**本轮起点**：「继续帮助我审计与补全代码， 完善平板电脑功能， 全面测试」。

### 55.1 缺陷（实测）

WebMan 下载面板的失败行带一颗「重试」。它有两处独立的问题，而两处合在一起才是完整的一条：

1. **重入窗口**：失败行是从存储重读画出来的（`downloadsTick` → `$derived`），状态要等 Svelte 冲一次才
   落到 DOM —— 从「点下重试」到「重试按钮消失」之间有一个窗口，第二次点会落到**同一行**上。
2. **宿主另铸 id**：`crates/amos-tauri/src/webman_download.rs::begin`（`:216`）对**已在传输中的 id**
   不照用、而是**另铸一个新 id**（只有 `!cancel.contains_key(candidate)` 才照用调用方给的 id；
   见其单测 `a_caller_supplied_id_is_used_verbatim_and_a_blank_one_is_minted`）。而进度事件按
   `event.id` 折进存储行（`applyProgress` → `updateDownload(event.id, …)`），新 id 落不到任何一行
   ⇒ 那次传输**没有行**：网络上多跑一趟、盘上多一个文件、完成事件被无声丢掉（`Download not found`）。

**第二半（独立）**：`updateDownload(id, 0, "pending")` 有返回值（存储会**拒写**，见
`src/lib/webman.ts` 的 `updateDownload(): boolean`），`retryDownload` 丢掉它 ⇒ 行仍停在 `failed`、
重试按钮仍挂在屏幕上，而传输已经真的开跑 —— 用户以为没动，再点一次就撞上第一件事。

**为什么全绿**：既有 WebMan 下载用例没有一条**双击同一行**（也不会在「第一次还在飞时」再点），
更没有一例让「重试中」写入**被拒**；`scripts/write-scan.mjs` 的判决链只认
`export function X(...): boolean { return writeStoreValueChecked(...) }` 这一种形状，
看不到组件里这类丢弃。

### 55.2 修法

1. `src/svelte/WebManApp.svelte`：`retryDownload` 顶部加组件实例级
   `const starting = new Set<string>()` —— 入口 `if (starting.has(id)) return;`、起跑前
   `starting.add(id)`、`finally { starting.delete(id) }`（**只覆盖在飞窗口，不是永久锁死**）。
2. 读判定：`if (!updateDownload(id, 0, "pending")) { showToast(t("webman.download.retryNotRecorded")); return; }`
   —— 写不进「重试中」就不许开跑。
3. `src/i18n/locales/{zh.ts,en.ts}`：新增 `webman.download.retryNotRecorded`
   （zh「无法记录这次重试——下载未开始」／en "Could not record the retry — the download was not started"）。

### 55.3 门禁与负控

- `bunx vitest run svelte-tests/webman-retry-single-flight.svelte.test.ts` ⇒ **4 passed**（新文件），
  **两向都钉**：重入被挡（同一 tick 内两次 `fireEvent.click`，第一次停在 `await` 上
  ⇒ `startDownload` **恰 1 次**且入参 `(FAILED.url, FAILED.filename, FAILED.id)`）／窗口过后仍可再点
  （不是永久锁死 ⇒ 2 次）；写不进就不开跑（`updateDownload` 回 `false` ⇒ `startDownload` **零调用**、
  屏幕出现 `retryNotRecorded` 且**不**出现 `downloadAddedFailed`）／写进就照常开跑（happy path ⇒ 1 次、不误报）。
- 全套 `bun run test:svelte` ⇒ **165 文件 / 1982 passed**；`bun run test` ⇒ `[bun-iso] test OK`；
  `typecheck` ／ `typecheck:svelte` ⇒ 0 错 0 警。
- **负控（实测，`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）**：
  **NC-A** 删掉 `if (starting.has(id)) return;` 这一行 ⇒ **恰 1 红**（重入向）；
  **NC-B** 去掉读判定（无条件 `downloadsTick++` 后开跑）⇒ **恰 1 红**（拒写向）——
  两条各自独立承重，互不代偿。还原后 `WebManApp.svelte` = `a06ab5fe00140215c12729a51279854eb4402c27e4d5dad199ec355f2320e16f`。

### 55.4 诚实边界（本轮**没有**做到的）

1. **改**一处生产组件（一个重入守卫 + 一次判定读取）、两份 i18n、一处新测试。
2. **未改**任何 Rust ∕ 宿主 `begin` 的 id 铸造契约 —— 本条修的是前端**不去制造**同 id 重入，
   不是让宿主改变契约（契约本身有单测，且行为正确）。
3. `downloadCurrentPage` 仍丢弃 `DownloadStarted.id`（同类，另一条路径），本轮**不**借它主张已修；
   它是独立议程。
4. `write-scan.mjs` 的盲区**未推宽**（动共享门禁会波及并行轮）。
5. **并发取号**：落笔前重探高水位，**REQ-A1072 ∕ F-SH-387** 双向零命中
   （唯一命中即新测试自身的文档注释）。

## 56. 第五十一轮：审计与补全（下载「取消」把宿主的答复丢了 —— 一条不可能在跑的下载永远「下载中」，REQ-A1074 / F-SH-389，2026-09-22）

**本轮起点**：「继续帮助我审计与补全代码， 完善平板电脑功能， 全面测试」。

### 56.1 缺陷（实测）

WebMan 下载面板的下载中行带一颗「取消」，`onclick={() => void cancelDownload(download.id)}` ——
宿主的答复被**整个丢掉**。

1. **`false` 是一句事实**：`cancelDownload` → `crates/amos-tauri/src/webman_download.rs::webman_download_cancel`，
   宿主对**它没有的 id** 回 `false`。取消标志的**存续期 == 传输的存续期**（`begin` 里 `cancel.insert` :236、
   `webman_download_start` 的作业结束时 `take_cancel` :485），所以 `false` 意味着：这次传输不在跑。
2. **为什么可达（不是理论）**：传输只活在宿主的**内存**里（`WebmanDownloads::cancel`），而下载行是从
   **存储**重画的（`loadDownloads`，`localStorage`）。于是**进程一重启**（用户在下载中关掉 AmOS 再打开），
   存储里那条 `downloading` 行照旧渲染成「下载中」＋进度条，而宿主**没有任何**该 id 的传输 ——
   那颗「取消」是用户唯一的出口，它静默失败，剩下的路只有「删除」（把记录连同盘上那半截文件的线索一起抹掉）。

**为什么全绿**：既有 WebMan 下载用例没有一条让 `cancelDownload` 回 `false`；`void-cmd-scan` 判的是
`void` 包装的命令**有没有问过**（这里只是 `void` 一个返回 `Promise<boolean>` 的调用），
看不到「答案被丢之后行为不变」。

### 56.2 修法

1. `src/svelte/WebManApp.svelte`：新增 `onCancelDownload(id)` —— `if (await cancelDownload(id)) return;`
   （宿主收下了 ⇒ 终态事件会把行改成 `canceled`，无需多话）；否则 `const noted = updateDownload(id, 0, "failed");`
   （收尾成**可恢复**的 `failed` ⇒ 长出「重试」），`if (noted) downloadsTick++`，并按 `noted` 播报。
2. 模板里 `onclick` 改指 `onCancelDownload`。
3. `src/i18n/locales/{zh.ts,en.ts}`：新增 `webman.download.cancelInterrupted`
   （zh「这次下载已不在运行（已中断）」／en "This download is no longer running (interrupted)"）与
   `webman.download.cancelFailed`（zh「取消失败——这条下载记录也未能更新」／en "Cancel failed — the download record could not be updated either"）。

### 56.3 门禁与负控

- `bunx vitest run svelte-tests/webman-cancel-refused.svelte.test.ts` ⇒ **3 passed**，**两向都钉**：
  宿主回 `false` ⇒ 行不再是「下载中」（cancel 按钮消失、retry 按钮出现）且说 `cancelInterrupted`；
  回 `true` ⇒ 行**不动**、**不**说 `cancelInterrupted` 也**不**说 `cancelFailed`（终态事件才是权威）；
  回 `false` 而收尾写入也被存储拒 ⇒ 说 `cancelFailed` 且**不**说 `cancelInterrupted`。
- 全套 `bun run test:svelte` ⇒ **166 文件 / 1985 passed**；`bun run test` ⇒ `[bun-iso] test OK`；
  `typecheck` ／ `typecheck:svelte` ⇒ 0 错 0 警（1457 文件）；`i18n:scan` OK（两枚新键均被生产引用）。
- **负控（实测，`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）**：
  **NC-A** 把 `onclick` 退回修前的 `() => void cancelDownload(download.id)` ⇒ **恰 2 红**（第 1、3 例），
  第 2 例仍绿；**NC-B** 保留读判定但把播报写死成 `cancelInterrupted`（丢掉 `noted` 的分岔）⇒ **恰 1 红**（第 3 例）
  —— 两条各自独立承重。还原后 `WebManApp.svelte` = `793868866dbc74c14619266c25f611852997d565f1b69c1c40f765e5420792e9`。

### 56.4 诚实边界（本轮**没有**做到的）

1. **改**一处生产组件（一处处理器 + 一处 `onclick`）、两份 i18n、一处新测试。
2. **未改**任何 Rust ∕ 宿主 `webman_download_cancel` —— 它回 `false` 是对的，本条修的是前端**不听**。
3. **未**做挂载时批量收尾（把持久化的 `downloading` 行在 `onMount` 里改成 `failed`）：
   `AppPane` 以 `{#key id}` 装载应用，离开再回来会**重新挂载** `WebManApp` 而后台传输仍在跑，
   挂载时收尾会误杀**在跑**的行。要做对，需先有「宿主列出存活传输」的命令，而 `webman_download.rs`
   只有 start ∕ cancel 与两枚 cookies 命令，**没有 list** —— 那是独立议程。
4. `downloadCurrentPage` 仍丢弃 `DownloadStarted.id`；`write-scan.mjs` 的盲区**未推宽** —— 均为独立议程。
5. **并发取号**：落笔前重探高水位，原拟的 **REQ-A1073 / F-SH-388** 被并行轮（`amos-robot` 定位）
   在写作期间占去，故取 **REQ-A1074 / F-SH-389**（双向零命中）。
6. `unwired:scan` 本轮为红，但红的是**并行轮的** `src/lib/pushNotifications.ts::PUSH_STATUS_FIELDS`
   （本轮未触碰该文件），不是本轮。

## 57. 第五十二轮：审计与补全（iPad Dock 的「最近使用」区是对一个它不在其中的列表的落点与拖动源，REQ-A1079 / F-SH-394，2026-09-22）

起点：「继续帮助我审计与补全代码， 完善平板电脑功能， 全面测试」。本轮扫过平板外壳的一圈表面
（`shellState.svelte.ts`、`Shell.svelte`、`AppPane`、`SplitSurface`、`SlideOverSurface`、
`lib/formLayout`、`lib/wm.ts`、`RecentsPanel`、`EditHome`、`AppLibrary`）——都清白了，
只有 `HomeDock.svelte` 的 `tile` 片段交出一个真缺陷。

### 57.1 缺陷（实测）

`HomeDock.svelte` 的 `tile` 片段只有**一个**布尔 `inDock`，五个拖拽／排序处理器
（`draggable`、`ondragstart`、`ondragend`、`ondragover`、`ondrop`）与两个纯视觉位
（图标宽度、`data-tile`）全挂在它上面。而 iPad Dock 的「最近使用」区
（`lib/formLayout::dockRecents` 读 recents store，只对**已钉住的 id** 去重）**画在 dock 栏里**
（`inDock === true`）却**不是 `layout.dock` 的成员** —— 于是它被装上了那套处理器，成为
「对一个自己不在其中的列表」的落点与拖动源：

* 把一个**已钉住**的图标拖到某个**最近**图标上 ⇒ `dockDrop` 发
  `move {drag: pinned, over: recent}`，shell 的 `moveBefore(layout, drag, over)` 在 `page` 与
  `dock` 里都找不到 `over`，落到末行 `page.push(drag)` —— **落点在 Dock 内部，应用却被逐出
  Dock、追加到主页**；
* 拖动一个**最近**图标 ⇒ 一个看起来可排序、能拖、却什么也不做的控件
  （`moveBefore` 在两侧都找不到被拖 id 时原样返回）。

实测（未改前，探针）：`P1 emitted: [{"drag":"mail","over":"notes"}]`、
`P2 recents tile draggable attr: true`、`P3 next: {"page":["mail"],"dock":[],"hidden":[]}`。

**为什么全绿**：既有补全用例只测**已钉住 → 已钉住**的重排，从不把落点或拖动源放在最近区上。
**平板专属**：`dockRecentSlots(form)` 只在 `form === "tablet"` 时为 3，手机形态该区
（连同分隔线）根本不画（`home-dock.svelte.test.ts` 已钉）。

### 57.2 修法

`tile` 片段把两个事实拆开——`inDock`（**视觉**：「画在栏里吗」）与 `orderable`
（**可交互**：「是这个顺序的成员吗」）：

* 签名扩为 `{#snippet tile(id: string, inDock = false, orderable = false)}`；
* `draggable` 与五个处理器全部改挂 `orderable`，`inDock` 只继续管图标宽度与 `data-tile`；
* 已钉住的调用点传 `{@render tile(id, true, true)}`，最近区只传 `{@render tile(id, true)}`。

**未做**：不在 `dockDrop` 里加防御性的 `dockIds.includes(over)` 守卫 —— 结构修复后它不可达，
会成为无人能变红的死分支（避免 unreachable-guard 气味）。`dockDrop`「发 `move` 给 shell」
的契约刻意不动（修的是**谁有资格触发它**）。

### 57.3 门禁与负控

新增 `crates/amos-tauri/frontend-ts/svelte-tests/dock-recents-not-reorderable.svelte.test.ts`
（4 例）：钉住 `mail` → 最近 `notes` 不 emit `move`；最近 tile 无 `draggable` 属性且在其上拖动无 emit；
钉住 `mail` → 钉住 `phone` 正常 emit `move {drag, over}`；纯函数
`moveBefore(layout, "mail", "notes")` ⇒ `{page:["mail"],dock:[],hidden:[]}`（钉住项被逐出）。

* `bunx vitest run svelte-tests/dock-recents-not-reorderable.svelte.test.ts` ⇒ **4 passed**；
* `bun run test:svelte` ⇒ **167 files / 1996 passed**；
* `bun run typecheck:svelte` ⇒ **1457 files / 0 errors / 0 warnings**；
* `bun test src/__tests__/amosStore.test.ts src/__tests__/core.test.ts` ⇒ **48 passed**。

**先证后修（实测）**：见 57.1 的 P1/P2/P3。
**负控（实测，`cp` 到 /tmp 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）**：

* **NC-A** 让最近区调用点重新传 `orderable`（`tile(id, true, true)`）⇒ **恰 2 红**（新用例 1、2）；
* **NC-B** 让处理器仍挂 `inDock` ⇒ **恰 3 红**（新用例 2 的 `draggable` 断言、用例 3，以及既有的
  `home-dock.svelte.test.ts` 重排例），其余 23 绿。

还原后 `HomeDock.svelte = 4530f653535f535a3f6dd44696c7932298c7a43b1ffb9dd733a97bdd43fa43cc`、
`dock-recents-not-reorderable.svelte.test.ts = 9d6d7f4883fb8984c6797387ed08820550a35b7e29c8d3fe70ebbe9d9461194e`。

### 57.4 诚实边界（本轮**没有**做到的）

1. **改**一处生产组件（一个片段签名 + 五个处理器挂点 + 两个调用点）与一处新测试文件。
2. **未改**任何 Rust ∕ 后端，**未**新增 store 键，**不动** `dockDrop` 的 `move` 契约。
3. **未**加 `dockDrop` 里的防御性守卫（见 57.2 末）—— 刻意留空，避免死分支。
4. 手机形态不受影响（`dockRecentSlots` 为 0，该区连同分隔线都不画）。
5. **并发取号**：落笔前重探高水位，REQ-A1080 已被另一轮（`i18n-scan.mjs`）占用，
   REQ-A1081 ∕ F-SH-395 亦属另一轮；故取 **REQ-A1079 ∕ F-SH-394**（双向零命中）。
6. `unwired:scan` 本轮仍为红，但红的是**并行轮的** `src/lib/pushNotifications.ts::PUSH_STATUS_FIELDS`
   （本轮未触碰该文件），不是本轮。

## 58. 第五十三轮：审计与补全（平板上从商店装的应用，在 App Library 里「加入程序坞」后重启就没了 —— 布局修复用同一个参数答了两个问题，REQ-A1090 / F-SH-404，2026-09-22）

### 58.1 缺陷（实测）

`crates/amos-tauri/frontend-ts/src/lib/amosStore.ts` 的 `getLayout(available)` 用**同一个**
`available` 回答了两个不同的问题：

- 三行过滤（`page` ∕ `dock` ∕ `hidden`）问的是「这个 id 还**指向一个存在的 app** 吗」——
  校验用户**已经存下**的落位；
- 末尾的合并循环问的是「哪些 id 要**自动摆上一页**」—— 那是内建注册表的事（新装一个内建必须
  有落点，这才是合并循环存在的唯一理由）。

而在内建以外的世界，`appIds()` 是空的。于是**从商店安装的 app** 在校验里等于幽灵。
App Library 却明确把商店 app 当作 `available` 提供给用户「加入程序坞」
（`AppLibrary.svelte` 的 `available = [...appIds(), ...ext]`），`addAppsToDock` 也真的把 id
写进了盘。**实测**（先在 `svelte-tests/` 写一支临时探针，验完即删）：

```
持久化 amos.home.layout = {"page":["clock"],"dock":["phone","store:org.amos.demo"],"hidden":[]}
经 resetShellState()（= 引导种子 seededHome()）之后
layout().dock = ["phone"]          // store:org.amos.demo 被滤掉
```

于是**平板**上的路径是：装一个商店应用 → 在 App Library 里加进程序坞 → 重启 ⇒ 那块瓷砖
**静默消失**；下一次布局写入还会把持久化的落位一并丢掉。既无提示也无回滚入口，观感同
「应用自己卸载了」，用户只能去 App Library 重新加一次，而下次重启再丢一次。

### 58.2 根因

**引导种子跑在瓷片到达之前。** 种子 `seededHome()` 在模块初始化时执行，而
`loadStoreTiles()` 是**异步**的、且只有 `Shell` 启动它 —— 种子那一刻商店瓷砖缓存是**冷的**。
两个问题共用一个参数时，「哪些 app 存在」被「哪些 app 要自动摆位」的答案替用户回答了。

**为什么全绿**：既有的 `an installed store app appears on the home screen` 用例用
`applyLayout` **手工**把 id 塞进布局，绕开了引导路径；而它的注释
「as the App Library's add to dock would」恰好描述了它唯一没走的那条路。

**为什么是缺陷而不是设计**：`lib/storeApps.ts` 的模块注释写着
「lets the shell resolve name∕icon + **merge them into the persisted home layout**」，
`Shell.svelte` 的注释也写着「an installed app never appears on the home screen / App Library」
—— 两处都承诺了这条合并，而实现从没存在。

### 58.3 修法

1. `getLayout(available, known)`：**两个问题两个参数**。`available` 决定自动摆位，
   `known` 决定校验；`known` 默认 = 内建 + 已装商店瓷砖（`knownAppIds(available)` 一处拥有
   这个知识，不在调用点重复）。
2. `restoreStorePlacements(current, available)`：只把被**冷启动**误删的落位**按原序并回**
   —— 它重读**持久化**的值（所以瓷砖加载期间落下的那次拖动会被读到，不会被覆盖），与内存中
   的清单求并，但**不重跑合并循环**（否则会把用户刚清空的页面重新塞满 —— 这正是同一次修复的
   负控，见 58.4）。
3. `shellState.reseatHomeLayout()` 持久化这次修复（先比较，无变化则不写盘、不广播）；
   `Shell.refreshStoreTiles()` 在瓷砖到达后调用它，并且它已经挂在 `subscribeStoreTiles` 上
   —— 于是每次安装／卸载也会走一遍，卸载那条路径同时把真被删掉的落位对账出去。

### 58.4 门禁与负控

新增两条用例：

- `svelte-tests/shell.svelte.test.ts::Shell.svelte (store tiles)::a store app placed on the dock survives the next launch`
  —— 清空瓷砖缓存（模拟冷启动）+ 写入带 `store:org.amos.demo` 的持久化布局 +
  `resetShellState()` 走引导种子 + `render(Shell)`；断言 `layout().dock` 含该 id **且**程序坞
  真的画出了它以 `aria-label="Demo"` 命名的瓷砖（程序坞是纯图标条，名字只以无障碍名存在，
  所以断的是 `aria-label`）。
- `src/__tests__/amosStore.test.ts::getLayout keeps a store placement that still names an installed app, and drops one that does not`
  —— **两向**：装着的落位保留、卸掉的（`setStoreTiles([])`）对账掉；两向都断言它**不会**被
  自动摆到页面上（证明修复没有顺手把「商店 app 自动上主页」塞进来）。

**负控**（三组均 `cp` 到 `/tmp/nc6` 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）：

| 负控 | 扰动 | 结果 |
| --- | --- | --- |
| NC-A | 删掉 `Shell.refreshStoreTiles` 里的 `reseatHomeLayout()` | 恰 1 红（引导那条） |
| NC-B | 把 `getLayout` 的 `known` 折回 `available` | 恰 1 红（纯逻辑那条） |
| NC-C | 让 `restoreStorePlacements` 用 `available`（「恢复」是商店盲的） | 恰 1 红（引导那条） |

三组各只红它该红的那一条，证明修复的**两半**（校验用宽集合、恢复对商店有意识）都在承重。

关键 sha（还原后）：

- `Shell.svelte = 90c0745357df2b6cc15891a19d79a6ab73ee70299b2d6ac842fcd6d3aacc40d7`
- `amosStore.ts = 02599d31486a04991f62ef617e582644dd26fc3a3a15d75ecf0e45667a2d1352`
- `shellState.svelte.ts = d734918ae91a751005cb518331a8ecaefaa1f22a1b2da9cb474134b630c30d94`

结果：`bunx vitest run` 相关 6 套 **116 例**全绿（含修复后 `shell.svelte.test.ts` 61 例）；
`bun test` 相关 3 套 **55 例**全绿；`tsc --noEmit` 0 error；`svelte-check` 1457 档 0 error 0 warning；
`bun run check` 退出码 **0**（`i18n-scan` ∕ `store-scan` ∕ `write-scan` ∕ `unwired-scan` 等全部 OK）。

### 58.5 诚实边界（本轮**没有**做到的）

1. **改**三处生产文件（`lib/amosStore.ts` 的校验参数与恢复函数、`src/svelte/shellState.svelte.ts`
   的一个导出、`src/svelte/Shell.svelte` 的一次调用）与两处测试文件。
2. **未改**任何 Rust ∕ 后端点、未新增 store 键、未改 `amos.home.layout` 的数据格式。
3. 桌面形态的 `Dock.svelte` ∕ `Launchpad.svelte` ∕ `SpotlightOverlay.svelte` ∕ `DesktopStage.svelte`
   直接调 `getLayout(APP_META…)`，同样受益于 `known` 的新默认值（它们的瓷砖缓存一旦变暖，
   多窗口下的落位就不会再被误删），但**各自窗口里的异步重算**没有接线 —— 本轮的修复落在
   触屏外壳这一条生产路径上，桌面形态的对应接线属另一条工作项，如实留在原地。
4. 商店 app **不会**被自动摆上主页（`available` 仍只有内建）—— 这是刻意的：App Library 才是
   「提供给你加」的那一面，`storeApps.ts` 的注释也这么写；58.4 的第二条用例两向都钉住了这一点。
5. **并发取号**：落笔前重探高水位，`REQ-A1089 ∕ F-SH-403` 在本轮写入的**同一瞬间**被另一轮
   （`amos-robot` 的 EKF 两叶守卫）占用，`REQ-A1088 ∕ F-SH-402`、`REQ-A1083 ∕ F-SH-401` 亦属
   别的轮；故改取 **REQ-A1090 ∕ F-SH-404**（双向零命中后立即落笔）。

## 59. 第五十四轮：平板功能补全（分屏的恢复把面板用「只有内建」的集合校验，于是平板上一块商店应用的分屏重启就没了 —— 同一个「一个参数答两个问题」在分屏意图上的第二处落点，REQ-A1111 / F-SH-425，2026-09-22）

### 59.1 缺陷（实测）

上一轮（§58，F-SH-404）刚把「一个参数答两个问题」从**主页布局**里拔掉。同一个模块里那处
**同形**的还留着：`crates/amos-tauri/frontend-ts/src/lib/splitPersist.ts` 的
`parseSplit(raw, available)` —— 它唯一的**生产**调用点是
`src/svelte/shellState.svelte.ts::restoreSplit` —— 拿 `available` 校验分屏的两块面板，而
分屏**活着的**两个门都不做内建限制：

- `enterSplit(primary, secondary, axis, percent)` 只要求 `isSplittablePair`（非空、且两块不同）；
- `open(id)` 在 `kind === "split"` 时对**副面板**的重定向同样只要求它。

于是**从商店安装的 app** 是合法面板：它在 `AppPane` 里走 `ExtAppHost`，是一块真能渲染的屏幕。
**实测**（先在 `svelte-tests/` 写一支临时探针，验完即删）：

```
A  平板上 enterSplit("notes","clock") 后 await open("store:org.amos.demo")
   surface()          = {kind:"split",primary:"notes",secondary:"store:org.amos.demo",axis:"auto",percent:50}
   amos.split（盘上） = 逐字相同                       // 活着的门接受它，并真的持久化了
B  装上同一块商店瓷砖后 restoreSplit()
   → false，surface() = {kind:"home"}                   // 缺陷：整块分屏被静默丢弃
C  对照（两块内建面板）→ true                            // 拒绝确实只针对商店 id
D  对照 open("store:org.amos.demo") → {kind:"app",…}     // 那只应用真的存在
```

于是**平板**上的路径是：分屏里放一块商店应用 → 重启 ⇒ **整块分屏**静默消失、退回单应用主页。
用户以为分屏没保存，只能重摆一次，而下次重启再丢一次。

### 59.2 根因

**`available` 只被内建填充。** `restoreSplit` 的调用是 `parseSplit(raw, appIds())`，而
`appIds()`（`src/lib/appMeta.ts`）只有内建。这正是 §58 那一句的重复：问「这个 id 还指向一个
存在的 app 吗」的东西，和问「哪些 id 属于内建 / 会被自动摆位」的东西，不是一个集合。

**冷缓存的第二半（与 §58 同形）**：引导种子与 `restoreSplit` 都跑在**异步**的
`loadStoreTiles()` 之前（只有 `Shell` 启动它），所以那一刻商店瓷砖缓存是冷的 —— 即便把谓词
改对，缓存冷时那一瞬仍然会拒。

**为什么全绿**：既有 `shell-state` 用例只覆盖「`ghost`（一个**已不存在**的 id）被拒」，
**没有任何一条**走过「面板是**装着的商店应用**」这条路径。

### 59.3 修法

1. `restoreSplit` 的校验谓词由 `appIds()` 改为 `knownAppIds(appIds())`。`knownAppIds`
   （内建 + 已装商店瓷砖，`src/lib/amosStore.ts`）是**一处**拥有「这个 id 还指向一个存在的
   app 吗」的知识，与 `getLayout` 的 `known` 默认值同源，故不会漂移。
2. **冷缓存的第二半**：`Shell.refreshStoreTiles` 在瓷砖到达后紧接 `reseatHomeLayout()`
   **再调一次** `restoreSplit()`。`restoreSplit` 自己的 `kind !== "home"` 守卫让这次重试在
   第一次已成功处成为 no-op，不会覆写用户随后的导航。
3. 未新增 store 键、未改 `amos.split` 数据格式、未改 Rust 侧。

### 59.4 门禁与负控

新增两条用例：

- `svelte-tests/shell-state.svelte.test.ts::restoreSplit() keeps a pane that is an installed store app, and drops one that is not`
  —— **两向**：装着 ⇒ `true` 且表面=那块分屏；`resetShellState()` 之后**重新**写入快照与键、
  再 `setStoreTiles([])` 卸掉 ⇒ `false`。（重写是必要的：`resetShellState` 会同时清掉快照与
  键，不重写的话拒绝会来自 `canSplit()` 或「键不存在」，断言就永远碰不到被测规则 —— 这一点是
  负控 NC-C 实测出来的：规则停用时该用例仍绿。）
- `svelte-tests/shell.svelte.test.ts::Shell.svelte — the tablet split entry (REQ-A512)::a split closed on an installed store app comes back on the next launch`
  —— **引导路径**：把 `appstore_installed` 延迟 40 ms 制造真实的冷缓存竞态，`wm_pane_rects`
  给出两块真矩形，`render(Shell)` 后断言 `surface().kind === "split"` **且**
  `[data-pane-app="store:org.amos.demo"]` 真的被画出、正文含 "Demo"。

**负控**（三组均 `cp` 到 `/tmp/nc7` 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）：

| 负控 | 扰动 | 结果 |
| --- | --- | --- |
| NC-A | 删掉 `Shell.refreshStoreTiles` 里的 `restoreSplit()` 重试 | 恰 1 红（引导那条） |
| NC-B | 把 `knownAppIds(appIds())` 折回 `appIds()` | 恰 2 红（纯逻辑那条 + 引导那条） |
| NC-C | 停掉 `parseSplit` 的面板剪枝行（`if (false) return null`） | 3 红（纯逻辑那条 + 既有幽灵那条 + 引导那条） |

三组各只红它该红的，证明修复的**两半**（校验用宽集合、冷缓存后重试）都在承重。

关键 sha（还原后）：

- `Shell.svelte = 71b4ed6d79044d073ba6d242b5e87a48e3333cadaecd85ac47370cfbb47d6978`
- `shellState.svelte.ts = ecded8eefae3e73bb9f1e79d72f4321872521887ac50fe26534a0bb87dc0ac0c`
- `splitPersist.ts = 1f6dd40db06432f89e66ef9c5cde808d683eb109965d9ee3630e47574c7b12b9`

结果：`bunx vitest run svelte-tests/shell.svelte.test.ts` ⇒ **62 passed（连续 3 次）**；
`svelte-tests/shell-state.svelte.test.ts` ⇒ **30 passed**；
`svelte-tests/split-surface.svelte.test.ts` ⇒ **4 passed**；
`node scripts/fmea-gen.mjs --check` ⇒ OK（683 条失效模式）；`--self-test` ⇒ 12/12；
`node scripts/trace-scan.mjs` ⇒ OK。

### 59.5 诚实边界（本轮**没有**做到的）

1. **改**两处生产文件（`shellState.svelte.ts` 的一个谓词、`Shell.svelte` 的一次重试）与两处测试
   文件；未改任何命令面、Rust 侧、store 键或 `amos.split` 数据格式。
2. `restoreSlideOver` 的**同形**校验（同样用 `appIds()`）**未改**：它今天**不可达** —— 唯一的门
   `pickSlideOver` 被 `RecentsPanel` 的 `appTitleKey(x) !== null` 过滤成只有内建。改它就是加一条
   **无法被证伪**的代码（没有测试能走到），故如实留在原地，作为已知边界。
3. 同一文件里修掉一处**测试自身的**缺陷（非生产代码）：新用例的 `finally` 曾 `delete` 掉
   happy-dom 在共享原型上定义的 `ResizeObserver` ∕ `clientWidth` ∕ `clientHeight`，把它后面的
   用例打成 `ResizeObserver is not defined`（实测：全量运行报 `Errors 1`）。改为**逐项还原**原先
   的描述符/值。
4. 另修一处**测试稳定性**问题（非生产代码，且**非本轮旧有**）：`shell.svelte.test.ts` 的
   REQ-A416 桌面用例用 `vi.waitFor` 等一个**惰性动态 import** 的判词，却用默认的 1 s 上限；而
   另一轮的在飞工作把 `SettingsApp.svelte` 从 24.8 KB 长到 34.9 KB，冷 transform 实测约 2.3 s ⇒
   全量运行时约 **2/3** 的概率变红（单独运行恒绿）。给该 `vi.waitFor` 一个显式的 5 s 上限并注明
   实测依据。**这不是本轮的缺陷**，如实标注为在飞工作带来的既有抖动。
5. **并发取号**：落笔前重探高水位 —— `REQ-A1105 ∕ F-SH-419` 已被别的轮占用（`REQ-A1110 ∕
   F-SH-424`、`REQ-A1104 ∕ F-SH-418` 亦属别轮），故改取 **REQ-A1111 ∕ F-SH-425**（双向零命中后
   立即落笔）。

## 60. 第五十五轮：平板功能补全（平板的多应用选择器永远列不出一个装好的商店应用 —— 门比门后的房间窄，REQ-A1137 / F-SH-443，2026-09-23）

### 60.1 缺陷实测（先证后修，对未改前的工作树）

平板上要有**两块面板**才有分屏与 Slide Over，而第二块面板是从 `RecentsPanel.svelte` 里选的。
该面板的候选集（`src/svelte/RecentsPanel.svelte` 的 `ids`）是「`amos.recents` 过滤掉
`appTitleKey(x) === null` 的项」。而 `amos.recents` 的**唯一生产写入者**是 `shellState.open()`，
它带一行前置：

```ts
if (appTitleKey(id) !== null) pushRecent(id); // 只内建；注释：third-party ids don't pollute the frequently-used set
```

于是**从商店装好的应用在两个选择器里都不会出现**。用探针（`svelte-tests/` 里一个 `zz_` 前缀的
临时文件，跑完即删）实测：装一块 `store:org.amos.demo` 瓷砖、写入内建 recents `["phone","notes"]`，
再以 `{pick:"split", exclude:"notes"}` 与 `{pick:"slide", exclude:null}` 打开面板 ——

| 模式 | 候选（实测） |
| --- | --- |
| `pick:"split"` | `["电话"]` —— **没有 "Demo"** |
| `pick:"slide"` | `["电话","备忘录"]` —— **没有 "Demo"** |
| `pick:null`（普通 recents） | `["电话","备忘录"]` |

对照组：把已装瓷砖列表 `ext` 推下去之后，同一条探针得到 `["电话","Demo"]` 与
`["电话","备忘录","Demo"]`，而普通 recents 模式**仍是** `["电话","备忘录"]`（边界没被推倒）。

### 60.2 根因：收敛了校验，没收敛出口

选择器**背后的每一层都接受 `store:` id**：

* `Shell.pickSecond` ∕ `Shell.pickSlideOver` 的落点是 `enterSplit` ∕ `openSlideOver`，二者的门只是
  `isSplittablePair`（非空且互异）与 `canSplit()`（`columns >= 2`）；
* `splitPersist.parseSplit` ∕ `lib/slideOver` 的校验在 REQ-A1111 之后已是 `knownAppIds`（内建 +
  已装商店瓷砖）；
* `AppPane` 对 `isExtId(id)` 真的走 `ExtAppHost`，把商店应用渲染成一块真面板。

也就是说：上一轮（REQ-A1111 / F-SH-425）刚把「校验用的 id 集合」放宽，却把**唯一能产出商店面板
的门**留成内建 —— 收敛的是校验而不是入口，于是这扇门比它后面的房间窄。同一个 id 直接调
`open("store:org.amos.demo")` 返回 `{kind:"app"}`（应用真的存在），可用户**没有任何操作**能让它进
分屏或 Slide Over；唯一能出现商店面板的路径是「上一轮持久化的旧意图在重启时被恢复」。

**为什么全绿**：既有选择器用例只种内建 recents；`amos.recents` 的写入面只有 `open()` 那一处；
没有任何断言问过「已装的商店应用是否可被选中」。

### 60.3 修法

与仓库既有的受控覆盖层约定一致 —— `RecentsPanel` 的模块注释原文就是「a CONTROLLED chrome
overlay. The shell owns whether it is open and pushes props down」，所以**不**在面板里新增第二处
订阅源（那会造出第二个真相），而是让 `Shell` 把它**已经**为 home 持有的已装瓷砖列表 `ext`
（`$state` 数组，由 `refreshStoreTiles()` 填充）沿同一条 `"recents"` 通道推下去：

* `Shell.svelte`：`"recents"` 通道的 props 类型加 `ext: StoreTile[]`，值就是既有的 `ext`；
* `RecentsPanel.svelte`：`RecentsProps` 加 `ext?: StoreTile[]`，`ids` 由「recents 过滤」改为
  「`recents ∪（pick 模式下的 ext id）`」再统一 `.filter(id => id !== exclude)`；
* 行的名字与字模取自瓷砖：`tile?.name ?? (key ? t(key) : id)`、`tile?.icon ?? appIcon(id)`
  —— 与 `AppPane.appTitle` ∕ `HomeDock.iconOf` 同一规则，所以一个没有 i18n 键的第三方行不会退化成
  裸 `store:` id 和 🧩；
* **普通 recents 模式一行未动**（`pick === null` 时 `ext` 的 id 不并入），App Library 的
  「经常使用」不会被第三方 id 污染。

未改 `open()` ∕ `amos.recents` 的写入规则 ∕ `enterSplit` ∕ `openSlideOver` ∕ Rust ∕ proto ∕ i18n 键。

### 60.4 门禁与负控

* `crates/amos-tauri/frontend-ts/svelte-tests/recents-panel.svelte.test.ts` +5：
  分屏模式列出已装商店应用（且用 manifest 名与字模，不是 `store:` id）、Slide Over 模式同样列出、
  点它 emit 的是 `store:` id 而非显示名、主面板已是该商店应用时被 `exclude` 滤掉、
  **普通 recents 模式仍只有内建**（边界）。
* `crates/amos-tauri/frontend-ts/svelte-tests/shell.svelte.test.ts` +1（端到端）：
  桥只答内建布局 + `appstore_installed` 返回一块 Demo ⇒ `render(Shell)` ⇒ 点
  `[data-testid="split-enter"]` ⇒ 从「shell 推下去的 ext」里找到 `aria-label="Demo"` 的行 ⇒
  点它 ⇒ `surface()` 为 `{kind:"split", primary:"settings", secondary:"store:org.amos.demo"}`；
  随后 `openSlideOver("store:org.amos.demo")` ⇒ `true` 且 `slideOver()` 为该面板。
* **负控**（三组均 `cp` 到 `/tmp/nc8` 后 `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）：

  | 负控 | 扰动 | 红数 |
  | --- | --- | --- |
  | NC-A | 把 `pick ? ext.map(e => e.id) : []` 折叠成 `[]` | 恰 **4 红**（面板 3 + 端到端 1） |
  | NC-B | 行名折回 `key ? t(key) : id`（丢掉瓷砖名） | 恰 **4 红**（同一组） |
  | NC-C | `Shell` 把 `ext` 推成 `[]`（退回改前接线） | 恰 **1 红**（只有端到端那条） |

  三组各只红它该红的；NC-C 只有端到端那条红，正说明**端到端那条才是承重的接线守卫**
  （面板单测直接推 `ext`，因而在接线被退回时依然全绿）。

* 修复后 `bunx vitest run svelte-tests/recents-panel.svelte.test.ts svelte-tests/shell.svelte.test.ts`
  ⇒ **73 passed**（10 + 63）；同轮另取 `shell-state` ∕ `split-surface` ⇒ 4 文件 **107 passed**。
* 定稿 sha：`RecentsPanel.svelte` `a09cad6fb3a511657b9a9785078f4b4a04fe27dd535d5e2669c1e9e54bf9e295`、
  `Shell.svelte` `7169b760ac19e1029fb133b8c2e79509e13f7d505dd772a30ba31fcdc1e5b31f`、
  `recents-panel.svelte.test.ts` `f9119344ebf4240a8c5089e4f45418d710df44743ad418a9ed0d28b414a21e50`、
  `shell.svelte.test.ts` `bf7a5903bb9f98081c16e95423b14660cc76a82f4abbbfb73e491a3b11845027`。

### 60.5 诚实边界（本轮**没有**做到的）

1. **改**两处生产文件（`RecentsPanel.svelte` 的候选集与行渲染、`Shell.svelte` 的通道 props）与两处
   测试文件；未改任何命令面、Rust 侧、store 键、i18n 键。
2. **未做真机复核**：结论来自 DOM 测试（happy-dom）与状态断言，未在真实平板上手验。
3. `RecentsPanel` 的候选集仍**只**在 pick 模式下并入商店瓷砖；普通 recents（用户从底部上滑唤出的
   「最近使用」）**刻意**保持只有内建 —— 这是设计边界，不是遗漏：`amos.recents` 的语义是
   「经常使用」，而第三方应用的常用度不在本轮议题内。
4. **并发取号**：落笔前重探高水位（`REQ-A1136 ∕ F-SH-442` 已被别的轮占用，高水位 REQ-A1136 ∕
   F-SH-442），故改取 **REQ-A1137 ∕ F-SH-443**（双向零命中后立即落笔）。测试文件里最初写下的
   `REQ-A1112` 是**误引用**（该号属机器人轮），已改正为本轮的两处编号。
5. 本轮**未**动手的更外围缺口（如实列出、不在本窗口内）：外接显示器 ∕ 第二屏、Stage Manager 式自由
   窗口、系统级手写笔、触控板/指针层、系统级录屏、AirDrop ∕ Handoff ∕ 通用控制、RKNN NPU 与
   进程内 llama.cpp 绑定 —— 均为多周工程或仅真机可验。

---

## 61. 第五十六轮：桌面功能补全（桌面壳的四个面各自回答「这个 app id 画成什么」，对**已安装的商店应用**三个面各错一种 —— 一个事实、四个答案，REQ-A1179 / F-SH-472，2026-09-23）

一句话：触屏主屏（`HomeDock`）画一个已安装的商店应用，桌面 Dock ∕ 启动台把它**整个滤掉**、桌面舞台按
raw wire id 命名它、Spotlight **搜不到**它 —— 而四者读的是**同一份** `amos.home.layout`。

### 61.1 缺陷实测（先证后修，对未改前的工作树）

一个 app id 只有两种：**编译期注册表行**（`lib/appMeta::APP_META`，36 个内置 app；
`appTitleKey(id): MessageKey | null`）或**已安装的商店应用**（`store:<manifest.id>`，运行时数据
`lib/storeApps`；`installedToTiles` ∕ `setStoreTiles` ∕ `getStoreTiles`）。两者都能被放上主屏、
拖进 Dock、分配窗格。用一个临时探针 `svelte-tests/zz_probe_store_dock.svelte.test.ts` 把四个面在同一份
布局下的 label 转储出来（布局 `{page:["store:org.amos.demo"], dock:["clock","store:org.amos.demo"]}`，
商店瓷砖 `{id:"store:org.amos.demo", name:"Demo", icon:"D"}`）：

| 面 | 实测 label | 对不对 |
|---|---|---|
| `HomeDock`（触屏主屏） | `["时钟","Demo"]` | ✅ 对 |
| `Dock`（桌面） | `["时钟"]` | ❌ 商店应用**整个消失** |
| `Launchpad`（桌面） | 网格里没有 `Demo` | ❌ 同上 |
| `DesktopStage`（桌面舞台） | `store:org.amos.demo`（raw id） | ❌ 名字与字形都错 |
| `SpotlightOverlay`（桌面 ⌘Space） | 输入 `demo` 后列表为空 | ❌ 搜不到 |

`DesktopShell` 传 `ext` 的探针分支则显示：**只要把瓷砖表推下去，Dock 就画 `Demo`** —— 缺陷是「没推」
加上「四个面各自回答」。

### 61.2 根因

三个不同的旧判据，各自为政：

1. `Dock.svelte` ∕ `Launchpad.svelte` —— 过滤条件 `appTitleKey(id) !== null`（只认内置）。
   Dock 里紧跟其后的 `label: key ? t(key) : id` 回退**正是为商店应用写的**，却因过滤已保证
   `key !== null` 而**不可达**：死代码就是缺陷的脚印。
2. `DesktopStage.svelte` —— `appIcon(id)` + `appTitleKey(id) ? t(...) : id`，对商店 id 回退成 raw id
   与兜底字形。
3. `SpotlightOverlay.svelte::allApps` —— 逐字 `if (!titleKey) continue; // 跳过未注册的 id（如 store tile
   占位）`。可它**不是占位**：同一 `wm_open` 路径能打开它，触屏侧 `HomeDock` 画的是同一份布局且答对，
   App 资源库也列它。macOS 的 Dock ∕ 启动台 ∕ Spotlight 同样列每一个已安装的应用。

还有一个**载荷为什么不能靠模块缓存**的原因：`loadStoreTiles()` 只被 `Shell.svelte` 调用（异步、开机时 +
`subscribeStoreTiles` 的 poke），而 `setStoreTiles` **不通知** —— 任何在挂载时读缓存的面都可能永远读到
空表（boot race，第八轮在平板上遇到过同一件事，当时的解法是把 `ext` 当作 prop 推下去）。

### 61.3 修法

- 新增唯一属主 `lib/appLookup.ts`：`storeTileFor` ∕ `isDrawableApp` ∕ `iconForId` ∕ `nameForId`。
  **刻意把瓷砖表当参数传**，不自己读模块缓存 —— 于是答案只是组件已跟踪状态的一个函数，不会在
  非响应式的模块读取背后变陈。`nameForId` 的 `translate` 也由调用方传入，正是为了让名字跟着 locale 活。
- `ShellChromeApi` 增 `storeTiles: readonly StoreTile[]`，实现是 **getter**（`get storeTiles() { return ext; }`），
  跟着 `ext` 走而不是快照。
- `DesktopShell` 新增 prop `ext`，从 `Shell` 用**已有的** `ext`（`refreshStoreTiles()` 填）推下去 ——
  单装载者 ∕ 单推送链：`Shell` → `DesktopShell` → `SHELL_CHROME_API.storeTiles` → 四个面。
- 四个面的过滤与命名全部改走该属主；Spotlight 的补充循环也改走属主（否则它对该属主不敏感）。
- **未改** `lib/storeApps.ts` ∕ `lib/appMeta.ts` ∕ Rust ∕ proto ∕ i18n 键（无新键）∕ 布局。

### 61.4 门禁与负控

新增测试：`src/__tests__/appLookup.test.ts`（新，4 例，纯函数）+ `svelte-tests/desktop-shell.svelte.test.ts`（+2）
+ `launchpad.svelte.test.ts`（+4）+ `spotlight-overlay.svelte.test.ts`（+1）+ `shell.svelte.test.ts`（+1）。

最后那一例是**壳级接线**测试：桌面壳的 push 链（`Shell` → `DesktopShell` → context getter）是其它测试
**看不见**的一半 —— `desktop-shell.svelte.test.ts` 的两例直接渲染 `DesktopShell` 并把 `ext` 当 prop 传，
`Shell` 就算不再转发它也照样绿。所以新增一例渲染**真的** `Shell`、由假宿主答 `appstore_installed`、让壳
自己的 loader 填 `ext`，断言落在 Dock 渲染出的 label 上（整条链，而不是一个 prop）。

**红先证**：修复前探针实测 Dock ∕ 启动台 label 不含 `Demo`（见 61.1 表）。

**负控 6 组**（各自原地扰动，`cp` 逐字节还原 + `shasum -a 256` 复核，**绝不**用 `git checkout --`）：

| # | 扰动 | 结果 |
|---|---|---|
| A | `Dock` 过滤折回 `appTitleKey(id) !== null` | 恰 **1 红 ∕ 78 绿**（放置态那例） |
| B | `Dock` 命名折回注册表（`appTitleKey` + `t`） | 恰 **2 红 ∕ 77 绿**（两例都断言「manifest 名、非 wire id」） |
| C | `Shell.svelte` 的 `<DesktopShell {ext} />` → `<DesktopShell />` | 壳级接线例 **1 红 ∕ 64 绿**；DesktopShell 级两例全绿 —— 正是这层看不见的那半 |
| D | `Launchpad` 过滤 + 补充循环一起折回 | 恰 **4 红 ∕ 7 绿**（四条 REQ-A1179 例） |
| E | `SpotlightOverlay::allApps` 折回 `if (!titleKey) continue` | 恰 **1 红 ∕ 3 绿** |
| F | `storeTileFor` 恒返回 `undefined` | appLookup **2 红 ∕ 2 绿** + desktop-shell **2 红 ∕ 77 绿** + launchpad **4 红 ∕ 7 绿** + spotlight **1 红 ∕ 3 绿** |

基线 shasum（负控前 `cp` 进 `/tmp/nc9` 的逐字节读数）：`Dock.svelte` = `7ea14127…`、
`Launchpad.svelte` = `4a1d87cb…`、`Shell.svelte` = `9babf853…`、`DesktopShell.svelte` = `5c02e53d…`、
`DesktopStage.svelte` = `e95f3f57…`、`appLookup.ts` = `9d98fa36…`、`shellModule.ts` = `2dd84dc1…`、
`SpotlightOverlay.svelte` 负控后为 `762bad2e…`（E 之后我把它的补充循环也改走属主，故与 `/tmp/nc9` 的
`62507e29…` 不同 —— 这是本轮**有意**的改动，不是漂移）。

门禁：`node scripts/fmea-gen.mjs --check`、`node scripts/fmea-gen.mjs --self-test`、`node scripts/trace-scan.mjs`
全过；`bun run typecheck` 0 错、`bun run typecheck:svelte` 0 错 0 警；四个受影响测试文件 159 例全绿
（`appLookup` 4 + `desktop-shell` 79 + `launchpad` 11 + `spotlight-overlay` 4 + `shell` 65 中的本次相关部分）。

**负控过程中的两个真实发现**（不是「走形式」）：

1. **NC-D 第一次是绿的**。只把 Launchpad 的过滤折回不够 —— 它末尾那个「已安装但没被放上去」的补充循环
   会**无条件**把每块 `ext` 瓷砖追加回来，于是放置态那例仍然通过。真正的修复前形态是「过滤窄 **且** 没有
   补充循环」，两者一起折回才红。这条本身就是「同一个面里两条路径，只钉一条等于没钉」的又一例。
2. **NC-F 最初对 Spotlight 是绿的**。在那里 store 应用走的是补充循环（直接 `tile.icon/tile.name`），
   不经过 `storeTileFor` —— 也就是说 Spotlight 当时对「唯一属主」并不敏感。已把该循环改为走
   `iconForId ∕ nameForId`，再跑 NC-F 得 **1 红 ∕ 3 绿**。

### 61.5 诚实边界（本轮**没有**做到的）

1. 只改前端（6 个生产文件 + 5 个测试文件）；**未**改 `lib/storeApps.ts` ∕ `lib/appMeta.ts` ∕ Rust ∕ proto ∕
   store 键 ∕ i18n 键 ∕ 布局。
2. **未做真机复核**：结论来自 DOM 测试（happy-dom）与探针转储，未在真实桌面上手验。
3. 手机形态的 `SpotlightPanel` **未**纳入本轮。它的动作是 `softLaunch(id)`（=`clearOverlays(); surface="home";
   pulseId=id`），语义是「回到主屏并脉冲那一块瓷砖」，而 `getLayout` 只把**内置** app 追加进 page、
   `restoreStorePlacements` 只恢复**持久化**的放置 —— 所以给一个从未被放上主屏的商店应用提供入口，会是一个
   **静默 no-op**：那是另一个缺陷（入口承诺了一个做不到的动作），本轮不假装已修。
4. **并发取号**：落笔前重探高水位，`REQ-A1179 ∕ F-SH-472` 双向零命中（全仓 `REQ-A` 最大值 = 1179、
   `F-SH-` 最大值 = 472，均只出现在本轮的改动里），故取该号并立即落笔。
5. `DesktopStage` 的 store 瓷砖**没有**被点击打开过测试覆盖 —— 它的打开路径复用既有的 `wm_open(label)` 面
   （REQ-A416 已钉），本轮只钉了它的**命名与字形**。若要连同打开一起钉，需要一条桌面舞台的点击端到端。
6. 本轮**未**动手的更外围缺口（如实列出、不在本窗口内）：外接显示器 ∕ 第二屏、Stage Manager 式自由窗口、
   系统级手写笔、触控板/指针层、系统级录屏、AirDrop ∕ Handoff ∕ 通用控制、RKNN NPU 与进程内 llama.cpp
   绑定 —— 均为多周工程或仅真机可验。

## 62. 第五十七轮：桌面功能补全（一扇「窗口」的名字与图标 —— 已安装商店应用在**四个列窗口的面**上都按内置注册表解析，名字回落成 raw wire id、字形回落成兜底，REQ-A1185 / F-SH-476，2026-09-23）

### 62.1 缺陷实测（先证后修，对未改前的工作树）

上一轮（§61，REQ-A1179 ∕ F-SH-472）给「这个 app id 画成什么」立了唯一属主 `lib/appLookup.ts`，修的是**桌面壳的四个面**（Dock ∕ 启动台 ∕ 桌面舞台 ∕ Spotlight）。本轮查的是**列窗口的四个面**——它们问的是另一个问题「这一扇**窗口**叫什么、画什么字形」，走的是另一个共享解析器 `windowName`（REQ-A473 立、`locale.svelte.ts` 里的唯一实现）：

| 面 | 文件 | 旧形取名字的方式 | 旧形取字形的方式 |
|---|---|---|---|
| 应用窗自己的标题栏 | `DesktopAppWindow.svelte` | `windowName(id).text` | 无（只画名字） |
| Mission Control | `MissionControl.svelte` | `windowName(w.label, w.app).text` | `appIcon(appId)` |
| App Exposé | `AppExpose.svelte` | `windowName(w.label, w.app).text` | `appIcon(appId)` |
| Spaces 窗口列表 | `SpacesPanel.svelte` | `windowName(w.label, w.app).text` | 无 |

`windowName` 只问 `appTitleKey(appId)` —— 编译期那 36 行**内置** app 注册表。已安装商店应用的名字活在**另一本账**里（`lib/storeApps.ts` 的瓷砖表），`appTitleKey` 对它恒返回 `null` ⇒ 旧形必然回落到 `appId ∕ label`。字形同理：`appIcon` 对未知 id 返回兜底 🧩。

**探针实测**（临时文件 `svelte-tests/zz_probe_store_window_name.svelte.test.ts`，跑完即删；`wm_windows` 返回一扇 `store:org.amos.demo` 与一扇内置 `files`）：

```
APPWINDOW title text:          "store:org.amos.demo"
APPWINDOW titlebar aria-label: "store:org.amos.demo"
MISSIONCONTROL text:           "🧩 store:org.amos.demo📁 文件  选择应用窗口切换"
```

同一个面板里，商店应用的窗口读作 wire id 加兜底字形，而**紧挨着的内置窗口**读作「文件」。

### 62.2 根因：同一份注册表缺失，在四个面上各漏一次

1. **既有纯测试把这条缺陷钉成了期望**。`src/__tests__/windowName.test.ts` 有一条用例名为「an app with no localized name is shown as its id — never prettified」，断言 `windowName("store:org.amos.pomodoro").text === "store:org.amos.pomodoro"`。它在旧形下**为真**——但只是因为它**从没把瓷砖表传进来过**：解析器根本没有第二个来源可问，测试量到的是「没有数据时的回退」，却被读成了「规格要求回退」。
2. **四个面的 DOM 测试此前只渲染内置 app**（`settings` ∕ `files` ∕ `notes`），没有一条用例把**已安装应用**的窗口放进去过 ⇒ 「名字是 raw id」这件事对每一条既有断言都不可见。这正是 memory 的 `project_unfailable_assertion_matches_default`：断言里的期望值等于坏掉的默认值，负控就永远红不了。
3. **`appTitleKey` 的契约本身没错**——它答的是「内置注册表里有行吗」。错的是**拿它去回答一个它没被写来回答的问题**（memory 的 `project_shared_predicate_answers_its_own_question`）。唯一属主 `lib/appLookup.ts` 上轮已经建好，四个窗口面只是还没接过去。

### 62.3 修法

1. **`windowName` 收第二个来源**：`windowName(label, app?, tiles?)`，经 `lib/appLookup::storeTileFor` 解析 —— `tile ? tile.name : key ? t(key) : appId ∕ label`。两层注册表都答不出来时**仍如实显示 id**（不美化、不大写），这条边界本轮继续钉住。
2. **`tiles` 是参数而不是模块缓存读**。这是一个刻意的取舍：`$derived(windowName(id))` 里若去读 `getStoreTiles()`，一个**早于瓷砖落地就挂载**的 app 窗会把 raw id 冻住，之后再也不会更新（REQ-A1179 的 `project_long_lived_component_snapshots_store_at_init` 教训）。参数化之后，名字是**调用方所持响应式状态的函数**，自己不会过期。
3. **四个调用方各自把表送到**：
   - `MissionControl` ∕ `AppExpose` ∕ `SpacesPanel`：`getContext(SHELL_CHROME_API)?.storeTiles ?? getStoreTiles()`。`storeTiles` 在 `DesktopShell` 里是 **getter**（跟着 `ext` 走，不是快照），所以推送链一路是活的；单独渲染这些组件时回落到模块缓存。
   - `DesktopAppWindow`：走**显式 `ext` prop**。REQ-A416 让桌面形态下每个 app 窗渲染它自己那个应用、**绕开 `DesktopShell`**，因此它取不到 `SHELL_CHROME_API` 的 context —— 表只能当 prop 传。由 `Shell.svelte` 把 `ext` 转发进去。
4. 顺带把 `SpacesPanel` 的那条**源码钉**（`spaces.svelte.test.ts` 断言文件里含 `windowName(w.label, w.app)`）更新为新调用形 —— 它是一条「存在性」断言，改签名会让它红，但红的原因与行为无关。

### 62.4 门禁与负控

**测试**（新增 / 改写）：
- `src/__tests__/windowName.test.ts`：那条「钉成期望」的用例**重写**为「REQ-A1185: an installed store app's window is named from the tiles it is given」（含实例号 `Pomodoro — 2`），并补一条「an id in no registry is still shown as its id」的边界（含「瓷砖表里是**别的** app ⇒ 仍显示 id」）。
- `svelte-tests/store-app-window-name.svelte.test.ts`（新，4 例）：四个面各一条，逐条断言名字**与字形**，并断言 `textContent` 不含 raw id。
- `svelte-tests/shell.svelte.test.ts`：新增 REQ-A1185 wiring 用例，渲染真实的 `Shell`，让宿主回答 `appstore_installed`，断言整条 `Shell → DesktopAppWindow` 链 —— 因为 `store-app-window-name` 直接传 `ext`，即使 `Shell` 停止转发它也照绿。
- `svelte-tests/spaces.svelte.test.ts`：源码钉更新。
- 受影响 8 个 svelte 测试文件 **126 例全绿**；纯测试 `windowName.test.ts` **7 例全绿**。

**负控 ×6**（每条各 `cp` 到 `/tmp/nc10` 快照、改完跑完、再 `shasum -a 256` 逐字节还原）：

| # | 扰动（折回修复前形态） | 红数 |
|---|---|---|
| A | `windowName` 去掉瓷砖分支（`base = key ? t(key) : appId ∕ label`） | **恰 6 红**（纯测试 1 + 四个面的 DOM 4 + Shell 链 1） |
| B | `MissionControl.iconOf` 传 `[]` | **恰 1 红** |
| C | `AppExpose.iconOf` 传 `[]` | **恰 1 红** |
| D | `SpacesPanel` 不传 `ext` | **恰 2 红**（DOM 1 + 源码钉 1） |
| E | `Shell` 不转发 `ext` | **恰 1 红** |
| F | `DesktopAppWindow` 不传 tiles（`windowName(id)`） | **恰 1 红** |

**两条负控在首轮是绿的，各自暴露了同一个错误**——「断言写松了」：
1. **NC-B 首轮绿**：断言写成 `expect(storeTile?.textContent).toContain("D")`，而瓷砖的名字是 **"Demo"，本身含一个 `D`** ⇒ 兜底字形 🧩 在场时它照样通过。改为读**图标元素本身**（`querySelector("div")?.textContent?.trim() === "D"`）后，NC-B 得 **1 红**。
2. **NC-C 首轮绿**（同一个原因，且 App Exposé 那条原本**根本没有**字形断言）⇒ 补上字形断言后得 **1 红**。

**三个门禁**：`node scripts/fmea-gen.mjs --check` ✅（745 条登记、表格形状正确）／`--self-test` ✅（12 ∕ 12）／`node scripts/trace-scan.mjs` ✅（EXIT=0）。`bun run typecheck` ＋ `bun run typecheck:svelte`（1468 文件 / 0 error）干净。

### 62.5 诚实边界（本轮**没有**做到的）

1. **未做真机复核**：结论来自 happy-dom 下的 DOM 断言与纯函数断言，未在真实 macOS 宿主上截图核对。
2. **缩略图仍不存在**：本轮只修「名字与字形」；瓷砖依旧是应用图标，与 Mission Control ∕ App Exposé 一直写明的边界相同（真缩略图需要宿主把每扇窗的像素交出来，本仓没有这条路）。
3. **`EditHome`（REQ-A1182）与手机形态的 `SpotlightPanel` 不在范围内**：前者上一轮已修；后者按设计只列内置应用，不假装已修。
4. **并发取号与一次碰撞**：落笔前重探高水位，`REQ-A1185 ∕ F-SH-476` 双向零命中（`REQ-A` 最大值已到 1187、`F-SH-` 到 477，均属其他在飞轮次），故取该号并立即落笔。落笔过程中观察到 `docs/FMEA.md` 第 670 行与 `docs/TRACEABILITY_MATRIX.md` 的一条既有行被**并成一行**（F-DEV-137 的 `| F-DEV-137 | **测试…` 前导被吞掉）—— 已按原前缀逐字拼回，`fmea-gen --check` 与 `trace-scan` 复跑皆绿；这类「前缀锚定的编辑会悄悄焊行」的坑，memory 里 `project_fmea_changelog_single_line_rows` 已有记录，本轮又撞上一次。
5. 本轮**未**动手的更外围缺口（如实列出、不在本窗口内）：外接显示器 ∕ 第二屏、Stage Manager 式自由窗口、系统级手写笔、触控板/指针层、系统级录屏、AirDrop ∕ Handoff ∕ 通用控制、RKNN NPU 与进程内 llama.cpp 绑定 —— 均为多周工程或仅真机可验。

## 63. 第五十八轮：快捷指令编辑器（「应用」选择器 —— 一半不存在，另一半只认内置：必填的 `app` 参数没有任何控件，而唯一存在的应用下拉只列内置应用，REQ-A1190 / F-SH-482，2026-09-23）

起点是「继续审计与补全代码，完善功能」。承上一轮（§62，REQ-A1185 / F-SH-476）确立的事实：**已安装的商店应用也是一个 app id**（`store:<manifest.id>`），上一轮修的是**窗口的名字与图标**那四个面；本轮回到同一个 app-id 面的第三处，发现**同一块屏幕上的「应用」选择器**有两个互不重叠的缺口。

### 63.1 缺陷实测（先证后修，对未改前的工作树）

1. **必填参数没有任何控件**：内置动作 `open_app`（`src/lib/shortcuts.ts::BUILTIN_ACTIONS`）逐字声明 `parameters: [{ id: "app", type: "app", required: true }]`。编辑器 `src/svelte/ShortcutsApp.svelte` 的参数渲染分支逐字只有三段：`{#if param.type === "text"} … {:else if param.type === "number"} … {:else if param.type === "select"} … {/if}` —— **没有 `app` 分支**。探针（`bun test` 一条临时用例，跑完即删）在「加一条『打开 App』」后实测：
   - `loadShortcuts()[0].actions[0].parameters` ≙ `{}`（恒为空对象）；
   - `container.querySelectorAll('[id^="shortcut-param-"]').length` = **0**（一个控件都没有）；
   - `executeShortcut` 执行该步骤时抛 `throw new Error("打开 App 需要应用标识")`（`shortcuts.ts::executeShortcut` 的 `open_app` 分支逐字 `if (!appId) throw …`）。
   即：这条内置动作**可加、不可配、必抛**。
2. **唯一存在的应用下拉只认内置**：屏幕上**唯一**的应用选择器是应用触发器的 `<select data-testid="trigger-app-{trigger.id}">`，其选项逐字由 `{#each APP_META as app}` 生成（编译期 36 行内置注册表）。探针实测该下拉共 **37** 个选项（36 内置 + 一个「任意应用」占位），option value 不含已安装瓷砖 `store:org.amos.demo`。而运行时 `shortcuts.ts::triggerMatches` 的 `app` 分支逐字为 `const want = evStr(config, "appId"); if (want && want !== evStr(data, "appId")) return false;` —— **对 `store:<manifest.id>` 与内置 id 的匹配是同一个字符串相等的判据**；纯函数探针喂 `{ type:"app", config:{appId:"store:org.amos.demo"} }` 与事件 `{ type:"app", data:{appId:"store:org.amos.demo"} }` 实测答 `true`。即：这条自动化**跑得起来、编不出来** —— 门比屋窄（REQ-A1137 / F-SH-443 同族）。
3. **两个缺口是同一块屏幕的两半**：修第一半（补控件）若只列 `APP_META`，会把第二半的缺陷重建一遍；故当作**一个**内聚轮次（「快捷指令编辑器的应用选择器」）。

### 63.2 根因

- 第一半：一个**声明**（`required: true` + `type: "app"`）与它的**渲染实现**之间没有门禁。没有任何脚本读「`BUILTIN_ACTIONS` 里出现的每一个 `param.type` 是否都有渲染分支」——「声明的必填参数」与「能配的控件」是两张从不对账的表。
- 第二半：应用触发器下拉的**来源**（`APP_META`，编译期常量）与运行时 `triggerMatches` 的**判据**（字符串相等，注册表无关）不是同一个问题域。屏幕问的是「有哪些内置应用」，运行时问的是「这个 id 对不对得上」——后者的答案域包含 `store:` 前缀，前者的列表却不含，于是「已安装应用打开时」这条自动化在编辑器里不可达。
- 为什么全绿：屏幕测试此前对 `open_app` 的断言只到「不抛」，从不问它能否被**配置**（`parameters` 是否被填上、有没有控件）；触发器测试只查内置 id 的匹配，`store:` 前缀从未被测过。

### 63.3 修法

1. `ShortcutsApp.svelte` 补上缺失的 `{:else if param.type === "app"}` 分支：一个 `<select>`（`id="shortcut-param-{actionId}-{paramId}"`、`data-testid="action-param-app-{actionId}"`），含一个空占位选项（新键 `shortcuts.actionAppPlaceholder`）+ 全部内置 + 全部已装瓷砖，`onchange` 走既有 `handleUpdateActionParam`。
2. 让**两处**选择器读同一份来源：触发器下拉在 `APP_META` 循环之后追加 `{#each ext as tile (tile.id)}`。
3. 显示名走唯一属主 `lib/appLookup::nameForId(appId, tiles, t)`（`appDisplayName` 重写）—— 商店瓷砖显示**名字**而非裸 wire id（与 §62 同一属主）。
4. 本屏挂在 `AppPane` 里（**不在** `DesktopShell` 的 context 内、拿不到壳推下来的 `ext`），故读 `lib/storeApps` 的模块缓存并持一份 `$state` 副本，由 `subscribeStoreTiles` 喂 —— 缓存本身不通知响应式，否则编辑器在商店装完应用后仍列不出它（memory `project_long_lived_component_snapshots_store_at_init` 同族）。
5. i18n 双语补 `shortcuts.actionAppPlaceholder`（zh「选择应用」∕ en「Choose an app」）。

### 63.4 门禁与负控

新增 `svelte-tests/shortcuts-app-picker.svelte.test.ts`（3 例，全绿）：

| # | 用例 | 断言 |
|---|------|------|
| 1 | 必填 app 参数真的有控件，且能选中已装商店应用 | `[data-testid="action-param-app-{id}"]` 存在且为 `SELECT`；option values 含 `clock` 与 `store:org.amos.demo`；change 后 `parameters.app` == 该 id |
| 2 | 触发器下拉含商店应用、落盘、行摘要显示名字 | `trigger-app-{id}` 的 values 含 `store:org.amos.demo`；change 后 `config.appId` == 该 id；`trigger-row-{id}` 文本含 `"Demo"` 且**不含**裸 id |
| 3 | 选择器对「装完应用」是活的 | 挂载后不含 `store:org.amos.pomodoro`；`setStoreTiles([…, POMO]); notifyStoreTilesChanged();` 后（**不重挂载**）出现 |

**负控 ×5**（逐叶、互相独立；各 `cp` 到 `/tmp` 快照 + `shasum -a 256` 逐字节还原，绝不用 `git checkout --`）：

| 扰动 | 结果 |
|------|------|
| ① 去掉 `param.type === "app"` 分支 | 恰 **1 红 ∕ 2 绿** |
| ② 触发器不追加瓷砖循环 | 恰 **2 红 ∕ 1 绿** |
| ③ 动作下拉不追加瓷砖循环 | 恰 **1 红 ∕ 2 绿** |
| ④ `appDisplayName` 不返 `nameForId` | 恰 **1 红 ∕ 2 绿**（断言裸 wire id 出现） |
| ⑤ `ext` 不订阅 `subscribeStoreTiles` | 恰 **1 红 ∕ 2 绿**（「装完应用」那条） |

每处扰动均逐字节还原：`ShortcutsApp.svelte` = `0f144d3c6782ccb6c2232d6f45301be926da13d2ef6b677d6fa22d8095657991`、`zh.ts` = `08f9ace96c39fc4bbc6903704e01d4476dba0f0315d255e9c9c4fa93e2de8fea`、`en.ts` = `2fe343ae0b29e07132a5e76a89b5a51532b666143df4e58c70725e76f12d996a`（`shasum -a 256` 逐一比对）。

门禁：`node scripts/fmea-gen.mjs --check` 绿、`--self-test` 绿、`node scripts/trace-scan.mjs` 绿；`cd crates/amos-tauri/frontend-ts && bun run check`（typecheck + svelte-check + i18n 等）—— 本轮改动文件 0 错；链上 `typecheck:svelte` 的 1 条 warning 来自**另一个在飞轮次**的 `FilesApp.svelte`（其 `a11y_media_has_caption` 抑制 carrier 被中途移除），本轮**未**触碰该文件（`project_dirty_tree_is_ambient` 同向：不还原、不编辑他人 in-flight 工作）。

### 63.5 诚实边界（本轮**没有**做到的）

1. **未做真机复核**：结论来自 happy-dom 下的 DOM 断言与纯函数断言，未在真实 macOS 宿主上操作编辑器截图核对。
2. **装完又卸的孤儿 id 未清理**：若某自动化已把 `parameters.app` 存成 `store:<id>`，之后该应用被卸载，下拉里不再有该 option，但存盘值仍在 —— 呈现时会落到 `nameForId` 的最后一层（如实显示 id，不美化、不清空）。本轮只保证「装时列得出、选中落得盘」，不做「卸载后的引用清理」。
3. **其他 `type:"app"` 消费方未扫**：本轮只修编辑器；`BUILTIN_ACTIONS` 之外若还有声明 `type:"app"` 的参数（如未来的其他动作），未做全量对账。
4. **并发取号与一次碰撞（如实记录）**：落笔前重探高水位，我最初取的 **F-SH-479** 与在飞轮次 `REQ-A1192`（`settings/RadioPage.svelte` 的 Wi-Fi 扫描守卫）**撞号** —— 该轮在自己的代码注释里逐字写了 `(REQ-A1192 / F-SH-479)`。发现后即刻把我方的 FMEA 号改为 **F-SH-482**（重探高水位为 481），`REQ-A1190` 保留（另两个在飞轮次均以「上一轮 REQ-A1190」引用它，属我方）。教训：`grep -rl` 一个 id 的**命中文件集合**要逐个看清是「本轮的落盘」还是「他轮的引用」，不能只看命中数。
5. 本节**未**动手的更外围缺口：快捷指令的动作库（更多内置动作）、条件/循环控制流、跨设备同步 —— 均超出本轮窗口。

## 64. 第五十九轮：系统键盘（设置页的「触屏导航」是一个**写了没人读**的控制 —— 重绑「返回上一级」到 ⌘B 后 ⌘[ 照样返回、禁用后 ⌘[ 照样返回，而 ⌘-hold 面板一直在教的 ⌘, 根本没有可编辑的行，REQ-A1200 / F-SH-490，2026-09-23）

### 64.1 缺陷实测（先证后修，对 HEAD）

探针：`src/__tests__/` 下一个临时文件，用手写的 `window` ∕ `localStorage` 桩（**不** import happy-dom，以免被判为 DOM 文件而掉出 `pure` 批次 —— 与 `keyboardConfigHook.bindings.test.ts` 同一手法），按 `amos.keyboard.config` 播种 `touch` 覆盖，再调 `shellKeyIntent`。

| 播种 | 输入 | 期望（修后） | HEAD 实测 | |
|---|---|---|---|---|
| `{touch:{back:{key:"B",meta:true}}}` | ⌘B | `dismiss/via:cmd-bracket` | **`none`** | 红 |
| 同上 | ⌘[ | `none` | **`dismiss/via:cmd-bracket`** | 红（旧弦仍活） |
| `{touch:{back:null}}` | ⌘[ | `none` | **`dismiss/via:cmd-bracket`** | 红（禁用不生效） |
| `{touch:{dismiss:{key:"D",meta:true}}}` | ⌘D | `dismiss/via:escape` | **`none`** | 红 |
| 同上 | Escape | `none` | **`dismiss/via:escape`** | 红 |
| `{touch:{settings:{key:"P",meta:true}}}` | ⌘P | `settings` | **`none`** | 红 |
| 同上 | ⌘, | `none` | **`settings`** | 红 |
| （无配置，对照组） | ⌘[ ∕ Escape ∕ ⌘, | 三条默认 | 三条默认 | 绿 |

合计 **7 红 ∕ 1 绿**。另有镜像半场一条：`Object.keys(TOUCH_DEFAULTS)` 在 HEAD 只含 `["back","dismiss"]` —— 面板一直教的 ⌘, 不在其中。

### 64.2 根因

**同一条规则在两处各写一份，而且两处住在不同的模块层。** 浮层域的合并早已统一到 `lib/keyboardConfig.ts::mergeOverlayBindings`，`lib/systemKeys.ts` 的注释逐字写着「一本规则书，两个调用方」。触屏域是唯一的例外：

- `KeyboardPage.svelte::buildTouchRows()` 渲染 `TOUCH_DEFAULTS`（住在 `keyboardConfigHook.svelte.ts`），每次编辑落盘到 `config.touch`；
- `lib/systemKeys.ts::shellKeyIntent`（`Shell.svelte:647` 的**唯一**准入）走的是硬编码的 `if (e.key === "Escape")` 与 `TOUCH_SYSTEM_SHORTCUTS`，**从不读** `config.touch`。

而 `resolveBindings` 其实**算对了** —— 它合并出 `bindings.touch`，但该字段的唯一读取者 `getTouchShortcut` **零生产调用者**。于是「有写入者、也有读取者」两句话都为真，功能仍然是死的（memory `project_setting_written_never_read` ∕ `project_live_guard_input_never_produced` 同族）。

**为什么它必然如此**：`shellKeyIntent` 在 `lib/` 里，`lib/` 不能 import `svelte/`（那会把整棵组件树拖进纯单元测试）；而 `TOUCH_DEFAULTS` 恰恰住在 `keyboardConfigHook.svelte.ts` —— 它 import 了 `svelte/shellModules`。**读不到表的根因是表的住址，不是疏忽。**

### 64.3 修法

1. `TOUCH_DEFAULTS` 移到纯模块 `lib/keyboardConfig.ts`（`keyboardConfigHook` 改为 import 并**转发**，设置页与既有边界测试仍从「引擎」模块取名）；新增 `settings: { key: ",", meta: true }` 行使被教的键可编辑。
2. 三态合并抽成 `mergeTouchBindings(defaults, config)`（与 `mergeOverlayBindings` 并列、同一本规则书），`resolveBindings` 与 `shellKeyIntent` **同源调用**。
3. `lib/systemKeys.ts`：`TOUCH_SYSTEM_SHORTCUTS` 换成 `TOUCH_INTENTS`（id→意图：`back`→`via:"cmd-bracket"`、`dismiss`→`via:"escape"`、`settings`→`kind:"settings"`）＋ `TOUCH_CATALOG_IDS`（面板该教哪几行）。`shellKeyIntent` 第 2 步改读**合并后**的触屏表。**关键性质**：`null` 行不在表里 ⇒ 天然惰性；硬编码表根本表达不了这件事。
4. Escape 从特例变成**一行普通的行**，于是 ⇧Escape ∕ ⌘Escape 不再被半吃掉（走同一 `shortcutMatches`）。
5. ⌘-hold 面板的键帽同读合并表 ⇒ 用户重绑后面板教的是用户自己的弦。
6. i18n 双语补 `settings.keyboard.settings`。

### 64.4 门禁与负控

- 新测试 `src/__tests__/touchKeyboardSettings.test.ts`，**13 例**，全绿。
- **红先证**：修法前 **7 红 ∕ 1 绿**。
- **负控 ×4（逐叶、互相独立）**：

  | # | 扰动 | 结果 |
  |---|---|---|
  | ① | `getMergedTouchBindings` 忽略配置（还原硬编码） | **7 红 ∕ 18 绿** —— 旧 12 例全绿 |
  | ② | 在循环前重加 `if (e.key === "Escape")` | 恰 **3 红**（三条 dismiss 用例） |
  | ③ | 从 `TOUCH_DEFAULTS` 删 `settings` | **3 红（新）+ 4 红（旧）** |
  | ④ | 目录读默认而非合并表 | 恰 **2 红**（两条目录用例） |

- 每处扰动 `cp` 到 `/tmp`、`shasum -a 256` 逐字节回改：`systemKeys.ts` = `c2c1b825a1bf0e1cfe0dec8771e63d5820e7bfbe49c41ef39d5dd5becd695e24`、`keyboardConfig.ts` = `765be999276941ba7f1c5be3c8787523e8231cba30e6abd9dd441f3a130ca52e`、`keyboardConfigHook.svelte.ts` = `3b6f3c93f61db5fd8b7751d410a04b01a9af264ba60bebe37f60040b5e1eada5`；**绝不用** `git checkout --`。
- 复跑：`systemKeys.test.ts` ∕ `keyboardConfigHook.bindings.test.ts` ∕ `keyboardConfig.test.ts` = **85 例全绿**；`keyboard-page.svelte.test.ts` ∕ `shell.svelte.test.ts` ∕ `ime-keyboard.svelte.test.ts` = **111 例全绿**。
- `tsc --noEmit` 0 错；`svelte-check` 1470 文件 0 错误 0 警告；20 个 scan 门禁全绿。

### 64.5 诚实边界

1. **负控 ① 的额外价值**：它同时证明了「旧套件对这条缺陷完全失明」—— 7 红**全部**落在新用例上，`systemKeys.test.ts` 的 12 例在硬编码还原下依然全绿。旧套件之所以看不见，是因为它的 13 例**全部**在空配置下跑，没有一例播种 `touch`。
2. **`via` 判别符仍无生产读取者**：`Shell.svelte` 对 `dismiss` 只按 `kind` 分派，`via`（`"escape"` ∕ `"cmd-bracket"`）自 REQ-A336 起就是**只被测试读**的字段。本轮**未**改这一点 —— 它与本轮缺陷无关，但按纪律继续记录，不声称它「被使用」。
3. **`settings`（⌘,）与窗口域的 `preferences`（同样是 ⌘,）是两个独立的行**：它们在设置页分属「窗口管理」与「触屏导航」两节、写进 `config.system` 与 `config.touch` 两个域、由桌面壳与触摸壳分别准入。因此编辑其中之一时，冲突面板会如实报「⌘, 也被另一行的功能占用」—— 那是**同一台设备上两个壳共用同一个弦**的事实，不是误报。本轮不合并这两行（合并会把两个域绑在一个 id 上，反而让冲突面板无法分别追踪）。
4. **`dismiss` 可被禁用 ⇒ Escape 可被关掉**：这是「设置了就该生效」的直接后果。平台自己的返回手势（`backActionAt`）不受影响，只有本壳的键盘准入会失去 Escape —— 这正是那个开关的语义。
5. **真机未复核**：证据是 bun 纯测试下的 `localStorage` 桩与纯函数裁决；触摸壳在真机上接上外接键盘的端到端行为未做设备验证。

## 65. 第六十轮：照片查看器（查看器里的 ♥ 是 `PhotosApp` 里唯一不看存储判决的写入，被拒时照常点亮，而唯一的否决通知渲染在整屏查看器之外，REQ-A1242 / F-SH-521，2026-09-23）

起点是「继续审计与补全代码，完善功能」。本轮只修一个缺陷：`PhotosApp.svelte::toggleFavSel` 丢弃了 `persist` 的判决。

### 65.1 缺陷实测

对工作树核实，修前逐字为：

```ts
const toggleFavSel = () => {
  if (!sel) return;
  const id = sel.id;
  const toggled = toggleFav(list, id);
  persist(toggled);
  sel = toggled.find((x) => x.id === id) ?? sel;
};
```

`persist` 的类型逐字是 `const persist = (l: Photo[]): boolean` —— 它内部走 `writeStoreValueChecked(key, l)`，在 `writeJson` 抛出（无痕模式配额 0 ∕ 磁盘满）时返回 `false` 并置 `storeErr = t("common.storeWriteFailed")`。`toggleFavSel` 把返回值丢掉了：先跑 `persist(toggled)` 图它对 `list` 的副作用，再把 `sel` 无条件指向「打算要的」那一行。

可达性：查看器里的 ♥ 是 `<button aria-label={t("photo.fav")} aria-pressed={!!sel.fav}>`，字形 `{sel.fav ? "♥" : "♡"}`。存储写入被拒时，`list` 与存储都没变，`sel` 却已经切到「已收藏」——**屏幕画出一颗存储从未接受的 ♥，`aria-pressed="true"`，而存储里仍是 `fav: false`**。

测得的证明（临时探针，用完即删）：`PROBE after-click glyph: ♥ aria-pressed: true stored fav: false banner present: true`。

**为什么反证不了它**：唯一的否决通知是顶层 `StoreErrorBar.svelte` 的 `role="status" data-testid="store-write-error"`，它渲染在**直接子级**，而查看器是 `<div class="fixed inset-0 z-20 flex flex-col bg-neutral-950/95">` —— 整屏 `fixed` 覆盖层把顶层横幅盖在下面，用户在查看器里既看不到它，也不会自己纠正。

### 65.2 根因

同文件的**兄弟写入全部**遵守「写入被拒即是命令未成功」这条纪律，逐字都能读到 `if (!persist(…)) return;`：

- `deleteSel`：`if (!persist(removePhoto(list, sel.id))) return;`
- `saveEdit`：`if (!persist([np, ...list])) return;`
- `setWallpaper` ∕ `favVideo` ∕ `deleteVideo`：同形。

只有 `toggleFavSel` 不读。这不是「控件没有判决可用」——判决就在手边、类型是 `boolean`、兄弟全在用；这是一处**漏读**。`persist` 那一次调用的**副作用**（`list` 的更新）被用到了，它的**答复**被丢掉了，而屏幕据以断言的是屏幕自己打算要的 `sel`，不是存储接受的那一份。

### 65.3 修法

```ts
const toggleFavSel = () => {
  if (!sel) return;
  const id = sel.id;
  const toggled = toggleFav(list, id);
  if (!persist(toggled)) return; // the refusal is already reported; do not paint it
  sel = toggled.find((x) => x.id === id) ?? sel;
};
```

被拒时查看器保持原状（♥ 不变、`aria-pressed` 不变），`StoreErrorBar` 的横幅仍是那条唯一的、诚实的通知。写入落地时才更新 `sel`。

改动范围：仅 `PhotosApp.svelte` 的 `toggleFavSel`。`toggleFav` ∕ `lib/photos.ts` ∕ Rust ∕ Kotlin ∕ i18n ∕ 布局一行未动。同文件的 `add` ∕ `batchFav` ∕ `deleteSelected` 同样丢弃判决，但它们不据以在屏幕上画出一句假话（既不切换共享的「当前项」，也无常驻的完成手势），按「一轮一缺陷」本轮不动 —— 如实记入 65.5。

### 65.4 门禁与负控

- **永久测试**：`svelte-tests/photos.svelte.test.ts` 新增「a refused write must not move the viewer's ♥ either」（插在既有 `multi-select can batch-delete` 之前）。它走真入口（`firstTile` → 打开查看器 → 点 `收藏` 按钮），用既有的 `failWritesFor("amos.photos")` 令 `setItem` 对该键抛错，断言：点击后 `aria-pressed` 仍 `"false"`、字形仍 `♡`、存储里 `fav` 仍 `false`、横幅在场、且横幅**不在** `.z-20` 查看器覆盖层之内。
- **红先证**：修前恰 **1 红 ∕ 57 绿**（红即本例）。
- **负控 ×2（逐叶、互相独立）**：
  - NC-A 把 `toggleFavSel` 回退成逐字 `persist(toggled);` ⇒ 恰 **1 红 ∕ 57 绿**（红即本例的 ♥ 叶子）。
  - NC-B 把 `StoreErrorBar` 搬进查看器覆盖层（并在 `{:else}` 之后补一份画廊副本）⇒ 恰 **1 红 ∕ 57 绿**，红只落在 `.z-20` 包含断言上 —— 证明「通知在覆盖层之外」这一叶也被独立钉住，而不是靠 ♥ 那一叶顺带变红。
  - 两次都用 `cp` 快照 + `shasum -a 256` 逐字节还原 `PhotosApp.svelte` = `7cf76c61a42af0ff31b05adf9429b5319d9cc0f439826c212e83ae4fae030ded`，绝不用 `git checkout --`。
- 全套 `photos.svelte.test.ts` **58 passed**（原 57）；`tsc --noEmit` 0 错；`svelte-check` 1471 文件 0 错误 0 警告；21 组 scan 门禁（共 42 个 `:selftest` ∕ `:scan` 阶段）全绿；`fmea-gen --check` ∕ `--self-test` ∕ `trace-scan` 全绿。

### 65.5 诚实边界

1. **同类残差如实记下、本轮未改**：`add` ∕ `batchFav` ∕ `deleteSelected` 也丢弃 `persist` 的判决。它们的差别在于**不画假话**：`add` ∕ `deleteSelected` 只调 `persist` 而不切 `sel`（存储没变则列表没变，屏幕与存储一致，只是没有解释），`batchFav` 同形。真正危险的是 `toggleFavSel` —— 它把「存储没接受的那一行」当成了查看器的当前项画出来。按「一轮一缺陷」，其余三处留待后续轮次，此处不声称它们「已修」或「无害」。
2. **横幅在覆盖层之下是布局事实，不是本轮的修法**：本轮没有把 `StoreErrorBar` 搬进查看器（NC-B 正是把这一点做成了一条会变红的假设）。修法是**不让查看器写下假话**，而非**让否决通知穿到覆盖层之上**。后者是另一个（可能的）缺陷，留待后续评估。
3. **真机未复核**：证据是 happy-dom 下的 DOM 断言与 `localStorage` 桩；「无痕模式配额 0」在真机 WebView 上的具体行为未做设备验证（用的是一条对该键抛错的 `setItem` 代理，等价于「写入被拒」这一事件，而非复现某个具体平台的配额策略）。

## 66. 第六十一轮：备忘录（「⇪ md 导入」是全文件唯一不看存储判决的写入 —— 被拒时销毁用户粘贴的 Markdown 并照常报「已导入」，REQ-A1259 / F-SH-530，2026-09-23）

起点是「继续审计与补全代码， 完善功能」。本轮只修一个缺陷：`NotesApp.svelte::importMd` 丢弃了 `persist` 的判决。

### 66.1 缺陷实测

对工作树核实，修前逐字为：

```ts
const importMd = () => {
  const parsed = parseMarkdownImport(text);
  if (!parsed) return;
  const now = Date.now();
  persist(prependNote(notes, parsed.body, now));
  text = "";
  exportMsg = t("note.imported", { title: parsed.title || t("note.untitled") });
};
```

`persist` 的签名逐字是 `const persist = (list: Note[]): boolean`，其文档逐字写着：

> `false` means nothing was written (full/unavailable storage): the caller must **not** apply the change to the in-memory list **or discard a draft**, or the UI would show/shed data that will not survive a reload.

`importMd` 既不读这个判决、也把 draft 丢掉了 —— 它正是那段文档点名禁止的两件事。

实测（临时探针，跑完即删）：在 `setItem("amos.notes")` 抛错、输入框里粘贴带 front-matter 的 Markdown 后点「⇪ md」，测得

```
PROBE: {"storedCount":0,"compose":"","status":"已导入「周报标题」","storeErr":"本机存储写入失败（不可用或已满）；本次改动未保存"}
```

- `storedCount: 0` —— 一行也没进存储。
- `compose: ""` —— 用户粘贴的正文（他的**唯一**副本）被清空。
- `status: "已导入「周报标题」"` —— 屏幕报告导入成功。
- `storeErr: "本机存储写入失败（不可用或已满）；本次改动未保存"` —— 同一块屏幕同时说它没保存。

两句话互相矛盾，而用户的内容已经没了。

### 66.2 根因

`persist` 返回布尔值**就是**为了让调用者知道写有没有落地；同文件的兄弟写全部照此设闸，并且各自把这条规则逐字写在注释里：

- `add`（第 245–254 行）：「the store rejected it — the user's typed text must never be cleared into a write that did not happen」
- `saveEdit`（第 265–271 行）：「Keep the inline editor open with the draft when the write was rejected, instead of closing over edits that were never stored」

只有 `importMd` 不读。这不是「没有判决可用」——判决就在手边、类型是 `boolean`、兄弟全在用；这是一处**漏读**，而且漏掉的正好是这个文件里唯一一处**销毁用户输入**的地方。

「清空输入框」是这次导入的成功手势（与 REQ-A1242 的查看器 ♥、REQ-A856 的分享面板收起同族），「已导入「{title}」」是它的成功报告。两个都不该越过一次被存储拒绝的写入。

### 66.3 修法

```ts
const importMd = () => {
  const parsed = parseMarkdownImport(text);
  if (!parsed) return;
  const now = Date.now();
  if (!persist(prependNote(notes, parsed.body, now))) return;
  text = "";
  exportMsg = t("note.imported", { title: parsed.title || t("note.untitled") });
};
```

被拒时输入框保持原样、不写成功行；`persist` 已把失败写进 `notesErr`，由既有的 `note-store-error` 结点渲染（两叶共用同一个渲染点）。

改动范围：仅 `NotesApp.svelte` 的 `importMd`。`lib/markdown.ts` ∕ i18n ∕ Rust ∕ Kotlin 一行未动。

### 66.4 门禁与负控

- **永久测试**：`svelte-tests/notes.svelte.test.ts` 新增「a refused write must not be reported as a successful import (REQ-A1259)」，插在既有的 «⇪ md imports the compose content…» 之后。它复用文件里已有的 `failWritesFor("amos.notes")`，走真入口（输入框 `note-compose` → 按钮 `note-import-md`），断言四件事：存储 0 条；`note-store-error` 含 `zh["note.saveFailed"]`；输入框内容**逐字未变**；屏上**不含**「已导入「周报标题」」。
- **红先证**：修前恰 **1 红 ∕ 45 绿**（红即本例）。
- **负控 ×3（逐叶、互相独立）**，每次都 `cp` 快照 + `shasum -a 256` 逐字节还原 `NotesApp.svelte`：
  - NC-A 整体还原成 `persist(...); text = ""; exportMsg = …` ⇒ 恰 **1 红 ∕ 45 绿**。
  - NC-B 只保住 draft、仍无条件画成功行（`const ok = persist(...); if (ok) text = ""; exportMsg = …`）⇒ 恰 **1 红 ∕ 45 绿**，红的恰是「不许报成功」那一叶（逐字 `not to contain '已导入「周报标题」'`）。
  - NC-C 只保住成功行、仍清空 draft（`if (!persist(...)) { text = ""; return; }`）⇒ 恰 **1 红 ∕ 45 绿**，红的恰是「draft 必须留下」那一叶（逐字 `expected '' to be '---\ntitle: 周报\n---\n# 周报标题\n\n正文内容'`）。
  - 三叶互不遮蔽：整体还原红两叶，两次局部还原各自红一叶。
- 全套 `notes.svelte.test.ts` **46 passed**（原 45）。

### 66.5 诚实边界

1. **证据形式**：happy-dom 下的 DOM 断言，配一条对该键抛 `QuotaExceededError` 的 `setItem` 代理；**未做真机 ∕ 截图复核**，也未复现某个具体平台的配额策略 —— 代理等价于「写入被拒」这一事件。
2. **负控所对的版本**：三次负控跑在与本轮最终提交**仅注释不同**的版本上（此后只把注释里的 `REQ-A1252` 改成 `REQ-A1259`，因为该 id 已被并发的通知轮占用）。行为代码逐字节相同，故负控结论不变；还原后文件哈希为 `93c0d328fe211e4132ea2cc8f741336e65e0ae2c5ac2495f9f588562b344caab`。
3. **同类残差如实记下、本轮未改**：同文件仍有两处批量写入丢掉判决 —— `runBatch`（第 368–371 行 `persist(fn(selInView)); exitSel();`，被拒时用户手工攒起来的多选仍被清空，与 REQ-A1247 的 `PhotosApp` 批量叶同族）与空垃圾桶确认（`persist(removeMany(...))`，被拒时列表不变、屏上无假话）。按「一轮一缺陷」本轮只修**会销毁用户输入并同时报成功**的那一处；其余两处在此写明，不声称「已修」或「无害」。

## 67. 第六十二轮：语音备忘录（删除先删字节、后看索引判决 —— 被存储拒绝时留下一条「列得出、放不了」的备忘录，录音不可恢复，REQ-A1263 / F-SH-541，2026-09-23）

起点是「继续审计与补全代码， 完善功能」。本轮只修一个缺陷：`VoiceMemosApp.svelte::deleteMemo` 丢弃了 `persist` 的判决，并不管判决地删掉了音频字节。

### 67.1 缺陷实测

对工作树核实，修前逐字为：

```ts
const deleteMemo = (m: VoiceMemo): void => {
  persist(removeMemo(memos, m.id));
  if (m.audio.kind === "recorded") void defaultMediaStore().del(m.id);
};
```

`persist` 与上一轮 `NotesApp` 的同名函数形状一致 —— `const persist = (next: VoiceMemo[]): boolean`，被拒时写 `storeErr` 并 `return false`。这里它同样被丢弃了。

实测（临时探针，跑完即删）：先往 `amos.vmemos` 种一条 `audio.kind: "recorded"` 的备忘录，并往 `defaultMediaStore()` 里放进它的字节；再令 `setItem("amos.vmemos")` 抛错，点该行的「删除」，测得

```
PROBE: {"seededBefore":true,"storedIds":["rec1"],"bytesAfterRefusal":"DELETED"}
```

- `storedIds: ["rec1"]` —— 索引（正确地）保留了这一行：写入被拒，什么都没落盘。
- `bytesAfterRefusal: "DELETED"` —— 但它的音频字节已经从 MediaStore 抹掉了。

于是列表里留下一条**列得出、放不了**的备忘录：重启后它仍在，点开播放无声，而字节是唯一副本 —— **录音不可恢复**。

### 67.2 根因

音频字节存在**独立的** MediaStore（IndexedDB ∕ 内存），索引 `amos.vmemos` 是另一次写入 —— 两次写入互相独立，所以**先后次序**在这里是有意义的：只能在索引不再列出这一行之后才删字节。同族的 `removeVideoCapture`（`lib/cameraCapture.ts`）把这条规则逐字写在文档里：

> the bytes are only deleted once the index no longer lists them, so a rejected write cannot leave a listed-but-unplayable video

而 `deleteMemo` 写的正是相反的顺序。这不是「没有判决可用」——同文件的其它写入全部照此设闸：`endRename` 逐字 `if (save && editingId && !persist(renameMemo(memos, editingId, draftTitle))) return;`，转写写入也走同一道门。只有 `deleteMemo` 不读。

### 67.3 修法

```ts
const deleteMemo = (m: VoiceMemo): void => {
  // The bytes are only removed once the index no longer lists the memo — the same
  // ordering `removeVideoCapture` (lib/cameraCapture.ts) applies. …
  if (!persist(removeMemo(memos, m.id))) return;
  if (m.audio.kind === "recorded") void defaultMediaStore().del(m.id);
};
```

写没落地，字节一步也不许动（`persist` 已把失败写进 `storeErr`，由既有的 `StoreErrorBar` 渲染）。

### 67.4 门禁与负控

`crates/amos-tauri/frontend-ts/svelte-tests/vmemos.svelte.test.ts` 新增 2 例：

1. 「a refused delete must not remove the memo's bytes (REQ-A1263)」（被拒叶）—— `failWritesFor("amos.vmemos")` 下，先给一条 `audio.kind: "recorded"` 备忘录放进 `defaultMediaStore()` 字节，点 `aria-label="删除"`，断言：索引仍含该 id、`defaultMediaStore().get(id)` **非空**、屏上含「本机存储写入失败」。
2. 「a successful delete removes the memo's bytes too (REQ-A1263)」（正向叶）—— 断言成功时索引空且字节为 `null`。这一叶是为了**不让闸被买成「永不删」**：只看被拒叶的话，一个把 `del` 整条删掉的实现也会全绿。

全套 **14 passed**（原 12）。**红先证**：修前恰 **1 红 ∕ 13 绿**（逐字 `expected null not to be null`）。

**负控 ×3（逐叶隔离、`cp` 快照 + `shasum -a 256` 逐字节还原，绝不 `git checkout --`）**：

1. 整体还原成 `persist(...); …del(...)` ⇒ 恰 **1 红 ∕ 13 绿**（字节叶）。
2. 把删除挪到被拒分支（`if (!persist(...)) { …del…; return; }`）⇒ 恰 **1 红 ∕ 13 绿**（同一字节叶）—— 证明闸的**极性**被钉住，不只是「有没有闸」。
3. 整条 `del` 去掉 ⇒ 恰 **1 红 ∕ 13 绿**，而红的恰是**另一叶**（正向，逐字 `expected Blob{…} to be null`）—— 两叶互不遮蔽。

修后（**仅含本轮这一处改动**）`VoiceMemosApp.svelte` 哈希 `dc818efc4b65056f70f157e74c732878ad9ed587b1e69cc1a36e3d5bdc028eb9` —— 三次负控前后均以此快照 `cp` 还原。注：本轮期间一个并发轮在同一文件上落了它自己的一处修复（`stop()` 的字节回收，REQ-A1264 / F-SH-542，见 `vmemos.svelte.test.ts` 第 167 行起），故文件当前头哈希已是 `cc4c77f9…`；并发改动只增不删本轮的 `deleteMemo` 闸，`bun run check` 在两者并存下 EXIT=0。三件门禁：`node scripts/fmea-gen.mjs --check` OK（**802** failure modes）、`node scripts/fmea-gen.mjs --self-test` 12/12、`node scripts/trace-scan.mjs` OK。语音相关三套（`vmemos` ∕ `voice-buttons` ∕ `voice-mic-state`）共 33 passed。

### 67.5 诚实边界

1. **证据形式**：happy-dom 下的 DOM 断言，配一条对该键抛 `QuotaExceededError` 的 `setItem` 代理与一个**内存** MediaStore；**未走真实配额耗尽、未走 IndexedDB，也未做真机 ∕ 截图复核** —— 代理等价于「索引写入被拒」这一事件，内存 store 等价于「字节删除成功」。
2. **影响面的边界**：本条只修 `deleteMemo`。同文件另有几处写入丢弃判决（`stop` 里录制落库、`deleteMemo` 之外的转写写入等），但它们**不删任何字节**：被拒时 `persist` 不更新 `memos`、只画失败条，屏上无假话、无数据丢失 —— 属「闸不全」而非「数据销毁」，本轮不声称已修。

## 68. 第六十三轮：快速设置（「旋转锁定」磁贴把「宿主没回答」读成「宿主不能旋转」—— 同一个 `null` 应答又把一次点击变成无声的空操作，REQ-A1274 / F-SH-548，2026-09-23）

起点：**「继续审计与补全代码， 完善功能」**。承上一条纪律（`DeviceMicButton` 的 `osMic` 三值状态，REQ-A787 / F-AND-010）：**一次失败的读取，永远不得被措辞成关于用户自己设备的事实**。

### 68.1 缺陷实测（先证后修，对工作树）

**第一叶 —— 假的能力断言。** `crates/amos-tauri/frontend-ts/src/svelte/NotificationCenter.svelte` 逐字：

```ts
let rotationAvailable = $state(false);
…
void (async () => { const snap = await rotationGet(); if (snap) rotationAvailable = snap.available; })();
```

而 `lib/backend.ts` 逐字 `export async function rotationGet(): Promise<RotationSnapshotPayload | null> { return invoke<RotationSnapshotPayload>("rotation_get"); }`。**`invoke` 从不 reject** —— 一次失败的命令把原因写进 `bridgeDiag(command)` 槽，并 resolve `null`。于是「宿主没回答」与「宿主答 `available:false`」落进同一个 `false`。

用一段临时探针（桥在、`invoke` 对每个命令都 resolve `null` —— 正是失败时的形状）实测挂载后：

```
{"rotation_getCalled":true,"headerText":"旋转锁定 此宿主无法旋转","claimsUnavailable":true}
```

表头画出的是 `rotation.unavailable`「**此宿主无法旋转**」—— 一句关于用户自己设备的事实断言，而那个 `null` 什么都没建立。

**第二叶 —— 无声的空操作。** 同一文件 `tapRotation` 逐字：

```ts
const reply = await rotationSet(mode);
if (!reply) return;
```

探针实测一次点击后：

```
{"rotation_setCalled":true,"storeBefore":null,"storeAfter":null,"pressedAfterTap":"false","note":null}
```

改了零、说了零 —— 正是磁贴自己注释里拒绝成为的那种「silently does nothing」的开关。

**为什么全绿**：套件里的桥桩（`installBridge`）都至少对 `rotation_get` 给出应答，「**有桥但宿主不回话**」这一组合从未被执行。

### 68.2 根因

三值状态被压成二值。`rotationAvailable` 这个 `boolean` 无法同时表示三件事：①宿主答「能」；②宿主答「不能」；③宿主**没答**。`false` 被两个事实共用，`rotation.unavailable` 的文案只对第二个事实成立。同一个 `null` 在 `tapRotation` 里又被当成「用户没点」的等价物，于是失败与「什么都没发生」不可分辨。

### 68.3 修法

1. `rotationAvailable` 改为 `boolean | null`（`null` = 没问到）；渲染改三臂：`false` → 「此宿主无法旋转」；`null` → 新增 `rotation.readFailed`「未能确认本机支持情况」（带 `data-testid="nc-rotation-read-failed"`）；否则显示 `t(rotationLabelKey(rotation))`。
2. `tapRotation` 在 `!reply` 时写 `rotationNote = "rotation.setFailed"`（新增键「未能联系到宿主，方向没有改变。」），并在每次点击开头 `rotationNote = ""` 清上一次的判词。
3. i18n 两键进 `zh.ts` / `en.ts`。`lib/rotation.ts` ∕ `lib/backend.ts` ∕ Rust **一行未动**。

### 68.4 门禁与负控

**新增 3 例**（`svelte-tests/notification-center.svelte.test.ts`，`installDeadBridge`：有桥、每个命令都 resolve `null`）：

1. 死桥下**不得**出现 `rotation.unavailable`，须出现 `nc-rotation-read-failed` 且文本等于 `zh["rotation.readFailed"]`；
2. 活桥下该节点不存在、表头含 `zh["rotation.auto"]`；
3. 死桥上点击后判词含 `zh["rotation.setFailed"]`、`aria-pressed` 仍 `"false"`、`readStoreValue(ROTATION_KEY, null)` 仍为 `null`。

**负控 ×3（逐条扰动、`cp` 快照 + `shasum -a 256` 逐字节还原，绝不 `git checkout --`）**：

1. 三值改回 `boolean`（只还原「读失败」叶）⇒ 恰 **1 红 ∕ 32 绿**；
2. 去掉 `tapRotation` 的失败判词 ⇒ 恰 **1 红 ∕ 32 绿**；
3. 去掉开场 `rotationNote = ""` ⇒ 恰 **0 红 ∕ 33 绿** —— **如实记录**：该清除**不被任何测试钉住**，它是对「判词槽需要开场清除器」的对齐，不是本轮证明的缺陷。

修后（**仅含本轮改动**）`NotificationCenter.svelte` 哈希 `75634f4cbbdda72fa88656637cb43566a6a68265635fc48e66470532c10e9d8a`。目标文件 **33 passed ∕ 0 failed**；svelte 全套 **2288 passed ∕ 0 failed**（195 文件）；`bun run typecheck` ∕ `typecheck:svelte` EXIT=0（1471 文件，0 error ∕ 0 warning）；`i18n-scan` ∕ `write-scan` ∕ `store-scan` ∕ `read-fold-scan` ∕ `diag-render-scan` ∕ `void-cmd-scan` 全绿。三件门禁：`fmea-gen --check` OK（**809** failure modes）、`fmea-gen --self-test` 12/12、`trace-scan` EXIT=0。

### 68.5 诚实边界

1. **可达性**：`rotation_get` ∕ `rotation_set` 在 `crates/amos-tauri/src/lib.rs` **无条件注册**，所以这条 `null` 路径需要一次**真实的桥调用失败**，或 Android glue attach 之前那个窗口（`crates/amos-tauri/src/rotation.rs::RotationOutcome::Unattached` 自己记录的 boot-ordering window，此时 `platform_available()` 为假）。
2. **本修不触碰判定**：只让界面停止把「没回答」说成「不能」，并让一次失败的点击说出来；**不改 Rust ∕ 桥 ∕ `lib/rotation` 的任何判定**。
3. **证据形式**：happy-dom 下的 DOM 断言，`installDeadBridge` 用「有桥、命令 resolve `null`」如实建模一次失败的调用；**未做真机 ∕ 截图复核**。

## 69. 第六十四轮：指南针（把「没有磁力计」读成了「没有方向传感器」—— `alpha` 为 `null` 的那一帧丢掉了同帧的倾角，水平仪在能测倾角的设备上永远打不开，REQ-A1275 / F-SH-550，2026-09-23）

起点：「继续审计与补全代码， 完善平板电脑操作系统的功能」。缺陷站点：`crates/amos-tauri/frontend-ts/src/svelte/CompassApp.svelte::handleOrientation`。这是**同一个 `null` 折叠进一个断言**（F-SH-548 ∕ REQ-A1274）之后的下一处，也是「一次失败的读取不得被措辞成关于用户设备的事实」这条纪律的又一次落地。

### 69.1 缺陷实测（先证后修）

修前 `handleOrientation` 逐字：

```ts
const alpha = event.alpha; const beta = event.beta; const gamma = event.gamma;
if (alpha === null) { reading = { ...reading, available: false }; return; }
const heading = normalizeHeading(360 - alpha);
reading = { heading, tilt: { x: gamma ?? 0, y: beta ?? 0 }, available: true, accuracy: … };
```

临时探针（`cp` 逐字节还原）派发一帧 `{alpha: null, beta: 30, gamma: 5}`，读数：

```json
{ "compassText": "指南针 水平仪 设备方向传感器不可用", "levelText": "…设备方向传感器不可用", "showsTilt30": false }
```

**后果**：没有磁力计的平板上，水平仪 tab 画出「设备方向传感器不可用」，气泡与两个倾角数字一个都不出现 —— 一个能正常工作的功能被一句**关于用户自己设备的假话**关掉（不是崩溃、不丢数据、不越权）。

### 69.2 根因

W3C DeviceOrientation 语义里 `alpha`（方位）**需要磁力计**，而 `beta` ∕ `gamma`（倾角）来自**加速度计**并继续到达 —— `alpha: null` 是「本机不提供绝对方位」，不是「本机没有方向传感器」。可 `reading.available` 这一个布尔同时喂着两个面：罗盘 tab 的 `{:else if !reading.available}` 与水平仪 tab 的 `{#if !reading.available}`。一句话把两个不同的问题（有倾角吗？有方位吗？）折叠成一个标志，于是缺方位的设备连倾角也没了。**为什么全绿**：既有 compass 用例要么不派发真帧，要么只派发带 `alpha` 的帧，「`alpha` 为 `null` 而倾角在流」这个组合从未被执行过。

### 69.3 修法

把「有方向数据」与「有方位数据」拆成**两个事实**：

1. `lib/compass.ts::CompassReading` 新增 `headingKnown: boolean`；`available` 保留为「倾角在流」。
2. handler 逐字 `const tiltKnown = beta !== null || gamma !== null; const headingKnown = alpha !== null;`，并**总是**写下 `tilt: { x: gamma ?? 0, y: beta ?? 0 }`（那一帧的倾角不再被丢）。
3. 渲染新增第三臂：`!anySensorData`（`available || headingKnown`）⇒ `compass.unavailable`；`!reading.headingKnown` ⇒ 新增键 `compass.noHeading`「未收到方位数据」；否则画方位。水平仪 tab 继续只看 `available`（它要的正是倾角）。

### 69.4 门禁与负控

`svelte-tests/compass.svelte.test.ts` 新增 3 例（`stubOrientationSupport` + `fireOrientation(alpha,beta,gamma)` 派发真帧）：

1. `alpha:null` ⇒ 罗盘画 `compass.noHeading` 且**不**画 `compass.unavailable`；
2. `alpha:null` ⇒ 水平仪画出 `30.0` ∕ `5.0` 与 `compass.levelAdjust`；
3. 一帧都没有 ⇒ 两个 tab 都说 `compass.unavailable`。

**红先证**：见 69.1 的探针 JSON。**负控 ×3 逐叶独立**（`cp` + `shasum -a 256` 逐字节还原，修后 `CompassApp.svelte` 哈希 `3ee2ae50bc45e1611b01084e78e0b97b5a4425f69dda863585601ecefe03a0a8`，绝不用 `git checkout --`）：

1. handler 在 `alpha===null` 时提前返回 ⇒ 恰 **1 红 ∕ 4 绿**（水平仪叶）；
2. 罗盘那一臂退回 `!reading.available` ⇒ 恰 **1 红 ∕ 4 绿**（罗盘叶）；
3. 删掉 `!anySensorData` 那一臂 ⇒ 恰 **1 红 ∕ 4 绿**（「一帧都没有」叶）。

三叶互不遮蔽。目标文件 **5 passed ∕ 0 failed**；`compass` ∕ `compass-cache` 纯件 **91 passed ∕ 0 failed**；`bun run typecheck` ∕ `typecheck:svelte` EXIT=0（1471 文件，0 error ∕ 0 warning）；`i18n-scan` 全绿。

### 69.5 诚实边界

1. **建模**：`alpha: null` 是 W3C 定义的「本机不提供绝对方位」信号，探针用 `Object.assign(new Event("deviceorientation"), {alpha, beta, gamma})` **如实建模**该帧。
2. **未复核的机器**：**未在真机 ∕ 无磁力计设备上复核**；证据是 happy-dom 下的 DOM 断言。
3. **不改的东西**：不改 Rust ∕ 桥的任何判定，`lib/compass.ts` 只新增一个字段。

## 70. 第六十五轮：测距仪（相机启动是个死循环 —— 设 `cameraActive` 要 `videoEl`，绑定 `videoEl` 的 `<video>` 又要 `cameraActive`，整个 App 永远停在「无法访问相机」，REQ-A1280 / F-SH-554，2026-09-23）

起点：「继续审计与补全代码， 完善平板电脑操作系统的功能」。缺陷站点：`crates/amos-tauri/frontend-ts/src/svelte/MeasureApp.svelte::startCamera`。是本轮指南针（**F-SH-550**／REQ-A1275）的姊妹传感器屏 —— 同一个应用族、同一次审计。

### 70.1 缺陷实测（先证后修）

修前 `startCamera` 逐字：

```ts
stream = await navigator.mediaDevices.getUserMedia({ … });
if (videoEl) {
  videoEl.srcObject = stream;
  cameraActive = true;
  cameraError = "";
} else {
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  cameraError = "Video element not ready";
}
```

而渲染两处（`tab === "measure"` 与校准 `calibrateStep === "measure"`）都把 `<video bind:this={videoEl}>` 关在 `{#if cameraActive}` 内。临时探针（`cp` 逐字节还原）挂载并解析 `getUserMedia` 后，屏幕文本逐字：

```
测距 校准 历史 📹 无法访问相机 Video element not ready 重试
```

`document.querySelector("video")` 为 `null`。

**后果**：测距仪的相机**永远打不开**，重试按钮重跑同一条死路，点屏无法开始测量、无法校准 —— 整个 App 的主功能不可达（不是崩溃、不丢数据、不越权）。

### 70.2 根因

`videoEl` 是 `$state`，承载它的 `<video>` 只在 `cameraActive` 为真时存在，而 `cameraActive` 又只在 `if (videoEl)` 里置真 —— 二者互为前置，`else` 那一支是**唯一**能到达的分支。**第二半**：两个 tab 各自渲染**自己的** `<video>`，切换 tab 会把 `videoEl` 绑到一个全新的、没有 `srcObject` 的元素上，即便修好死循环，校准 tab 的取景框也会是黑的。**为什么全绿**：既有唯一那条 measure 用例只问 tab 栏的 `aria-selected`，从不驱动相机，`getUserMedia` 这条路一个用例都没有。

### 70.3 修法

1. `startCamera` 改为**由刚取到的流**置 `cameraActive = true`（不再依赖元素），并删除已经死掉的「Video element not ready」支。
2. 新增 `$effect`：元素一旦绑定且 `stream` 就绪即 `el.srcObject = stream`（`try/catch` 兼容非 MediaStream 运行时），在 `videoEl` 每次变化时重跑 —— 同时覆盖第二半的「每个 tab 一个元素」。

这正是 `CameraApp` 的流效果注释逐字记录的既有定式（「acquire can't wire srcObject synchronously — this effect does it as soon as videoEl binds」）。

### 70.4 门禁与负控

`measure.svelte.test.ts` 新增 3 例（`makeStream` ∕ `setupMedia` ∕ `setupDenied` ∕ `settle` 桩）：

1. 测距 tab 画出 `<video>` 且 `srcObject === stream`、不出现 `measure.cameraError`、出现 `measure.tapToStart`；
2. 切到校准 tab 并选一个参照物后，那个**新元素**也拿到同一条流；
3. 相机拒绝（`NotAllowedError`）仍画出 `measure.cameraPermissionDenied` 且无 `<video>`。

**红先证**：还原死循环后恰 **2 红 ∕ 2 绿**。**负控 ×3 逐叶独立**（`cp` + `shasum -a 256` 逐字节还原，修后 `MeasureApp.svelte` 哈希 `56fd189e5299d0270ee83719ddf578de85855062a6d076a760ce8ba65bb00b3c`，绝不用 `git checkout --`）：

1. 还原死循环（保留 `$effect`）⇒ 恰 **2 红 ∕ 2 绿**（两个取景叶；叶子 1 在构造上即是叶子 2 的前置 —— 元素不渲染就无从挂流，**如实记录这不是测试缺陷而是真实依赖**）；
2. `$effect` 加一次性闩（只挂第一个元素）⇒ 恰 **1 红 ∕ 3 绿**（校准 tab 叶）；
3. 把 `NotAllowedError` 的 `cameraError` 清空 ⇒ 恰 **1 红 ∕ 3 绿**（拒绝叶）。

目标文件 **4 passed ∕ 0 failed**（原 1）；`bun run typecheck:svelte` EXIT=0；`i18n-scan` 全绿。

### 70.5 诚实边界

1. **建模**：`MediaStream` 由 happy-dom 提供 —— happy-dom 对 `srcObject` 做类型校验，故不能用一个普通对象假流；其 `getTracks` 需补一个桩，以便 `stopCamera` 卸载时可用。
2. **未复核的机器**：**未在真机 ∕ 真摄像头上复核**；证据是 happy-dom 下的 DOM 断言。
3. **不改的东西**：`lib/measure.ts` 与 Rust 一行未动。

---

## 71. 第六十六轮：放大镜（取流的 `$effect` 读了响应式 locale —— 切换界面语言会把正在直播的镜头拆掉再重开，REQ-A1304 / F-SH-579，2026-09-23）

起点：「继续审计与补全代码， 完善平板电脑操作系统的功能」。缺陷站点：`crates/amos-tauri/frontend-ts/src/svelte/MagnifierApp.svelte` 的相机 `$effect`（第 78–118 行）。是上一轮测距仪（**F-SH-554**／REQ-A1280）的姊妹相机屏 —— 同一个无障碍族、同一种「相机取流」结构，但缺陷的机制完全不同：测距仪是**启动条件的死循环**，放大镜是**依赖集里多了一条不该有的响应式输入**。

### 71.1 缺陷实测（先证后修）

修前 effect 体内逐字（`git show HEAD` 与工作树一致）：

```ts
$effect(() => {
  if (!granted) return;
  const v = videoEl;
  …
  hint = t("magnifier.starting");
  navigator.mediaDevices!.getUserMedia({ video: { facingMode: "environment" } })…
  return () => {
    cancelled = true;
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
  };
});
```

`mark()` 同样在 effect 体内写译文：`hint = live ? t("magnifier.live") : t("magnifier.demo")`。

**根因**：`t()`（`src/svelte/locale.svelte.ts`）读的是模块级 `$state current`，所以在 `$effect` 体内调用 `t(...)` 就把 **locale 登记成该 effect 的依赖**。locale 一变 → effect 重跑 → 它的 cleanup 先 `tr.stop()` 停掉正在直播的 `MediaStream`，紧接着重新 `getUserMedia`。

临时探针（`cp` 逐字节还原）挂载、点「允许」、再 `setLocale("en")`，实测：

```
PROBE videoEl= true srcObjectSet= true calls= 1      ← 挂载后
PROBE after-locale calls= 2 srcObjectSet= true stops= 1   ← 切语言后
```

即 **`getUserMedia` 调用数 1 → 2、`track.stop()` 0 → 1**：镜头被拆掉又重开。

**为什么全绿**：本文件头自己写着 `real magnified view is device acceptance`；整套 suite 里 `getUserMedia` ∕ `mediaDevices` **零命中**（两处 `grep -rn` 皆空），没有任何用例钉过取流 effect 的依赖集。更讽刺的是唯一触及语言切换的既有用例 `a live locale switch re-keys the footer hint` **正是靠这个缺陷才绿** —— effect 重跑就是它把页脚那句译文重新写上的方式。

### 71.2 根因

**一句话：把「界面文案」和「副作用依赖」混在了同一个 effect 里。**

- `hint` 是一个持有**已翻译字符串**的 `$state`。译文要随语言改口，就必须有人重新写它；而唯一的写入者（effect 体内 + `mark()`）恰好就是取流 effect。
- 于是「文案随语言变化」这条需求，被实现成了「取流 effect 依赖 locale」。需求达成了，代价是每次换语言都重跑一次取流副作用 —— 而这次副作用的 cleanup 是**停掉用户的摄像头**。
- 这正是 memory 里 `project_localized_list_frozen_at_init` 那一族的**镜像**：那一族的病灶是「译文冻在 init」，修法是让它响应式；本轮是「为了让译文不冻，把整条副作用拖进了响应式」。

### 71.3 修法

**把那句话存成 key，不存译文。**

```ts
type HintKey = "starting" | "live" | "demo";
let hintKey = $state<HintKey>("starting");        // 取代 let hint = $state(t(…))
const mark = (live: boolean) => {
  mode = live ? "live" : "demo";
  hintKey = live ? "live" : "demo";               // 只写 key，不再调 t()
};
const hintText = $derived(                        // 译文在这里取，读 locale
  hintKey === "starting" ? t("magnifier.starting")
  : hintKey === "live"   ? t("magnifier.live")
  :                        t("magnifier.demo"),
);
```

effect 体内 `hint = t("magnifier.starting")` → `hintKey = "starting"`；渲染侧 `{hint}` → `{hintText}`。

结果：页脚照旧随语言即时改口（`$derived` 读 `t()`），而 **`t()` 从 effect 里彻底消失，locale 不再落在取流 effect 的依赖集里**。三条 `t("magnifier.*")` 字面量仍在，`i18n-scan` 照常解析。

### 71.4 门禁与负控

`crates/amos-tauri/frontend-ts/svelte-tests/magnifier.svelte.test.ts` 新增一例 **「switching the UI language does not tear down the live camera」**，四叶同时钉住：

1. `getUserMedia` 调用数 == 1（**不重开**）；
2. `track.stop()` 计数 == 0（**不拆**）；
3. `video.srcObject` 仍指同一个 `MediaStream`（**没断线**）；
4. 页脚**确实**改口（`en["magnifier.starting"]` 在、`zh["magnifier.starting"]` 不在）—— 防止「把页脚删掉」也算修好。

该套件 **7 passed**（原 6）。

**红先**：把文件还原成修前版本 ⇒ 恰 **1 红 ∕ 6 绿**（只红本例）。

**负控 ×3（逐叶隔离，`cp` 逐字节还原 + `shasum -a 256`，绝不用 `git checkout --`）**：

| # | 扰动 | 结果 |
|---|------|------|
| ① | 修前文件全文还原 | 恰 **1 红 ∕ 6 绿** |
| ② | 只把 locale 依赖塞回 effect（体内加 `void t("magnifier.demo");`） | 恰 **1 红 ∕ 6 绿** |
| ③ | 把 `hintText` 冻成 `const hintText = t("magnifier.demo");` | **2 红 ∕ 5 绿**（本例的页脚叶 + 既有的语言切换例） |

②证明「红」确实由「effect 体内读 locale」这一条机制触发，而不是别的东西；③证明修复不是「把页脚删掉」。

修后 `MagnifierApp.svelte` = `26c3bb5cddda329f2b27724fdbb7056cae61f5a7d579da4f2aa7ba1fbed2fe88`。

**门禁**：`fmea-gen --check` OK（826 failure modes）；`fmea-gen --self-test` 12 ∕ 12；`trace-scan` EXIT=0。

### 71.5 诚实边界

1. **未复核的机器**：**未在真机 / 真摄像头上复核**；证据是 happy-dom 下的桩与 DOM 断言（`MediaStream` 由 happy-dom 提供，其 `getTracks` 需自行补上 —— happy-dom 对 `srcObject` 做类型校验，普通对象假流会抛 `TypeError`）。
2. **触发面**：本轮只钉了显式 `setLocale("en")` 这一条路径。同一根因在真机上的触发面更宽（任何改 locale 的路径都会重跑取流 effect），但它们走的是同一个依赖机制。
3. **不改的东西**：`lib/magnifier.ts`、样例场景绘制、`toneFilter`、滑块持久化与 Rust 一行未动。

