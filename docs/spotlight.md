# Spotlight —— 一个框回答三个问题（应用 / 文件 / 计算）

> 状态：**已实现**（REQ-A458，2026-09-19）。本页是设计记录：每条判断后面都跟着可自跑的命令或
> 文件位置。相关：`docs/mac-menu.md`（菜单面）、`docs/files-trash.md`（文件域）、
> `docs/PC_DESKTOP_ARCHITECTURE.md`（壳的槽位）。

---

## 1. 两个 Spotlight 面，各自服务一种形态

| 形态 | 组件 | 通道 | 搜什么 |
|---|---|---|---|
| touch（手机/平板） | `svelte/SpotlightPanel.svelte` | propsBus `spotlight`（同窗口浮层） | 应用 + 备注 + 文件 + 联系人 + 拨号 |
| **桌面** | `svelte/SpotlightOverlay.svelte`（⌘Space） | 注册表浮层（`shellModules.ts`） | **应用 + 文件 + 计算**（本页） |

桌面的那一面此前**只搜应用**（`results: AppEntry[]`，名字/id 子串）—— 而 macOS 的 Spotlight 在同一个
框里回答三个问题：「这是什么？」「这值多少？」「它在哪？」。后两者本仓**早就有引擎**（计算器
app、文件域的 `searchFiles`），缺的只是"把三样东西放进一张列表"的**规则**。

## 2. 规则（纯函数、唯一真源）

`lib/spotlightSearch.ts::buildSpotlightResults(query, { apps, files, calculation })`：

1. **顺序是 macOS 的**：计算 → 应用 → 文件。计算排第一是因为它是**关于这次查询本身**的答案。
2. **空查询什么都不显示**（面板显示自己的提示，而不是一屏"全部"）。
3. **上界是边界不是口味**：`SPOTLIGHT_MAX_APPS = 6`、`SPOTLIGHT_MAX_FILES = 4`，被截掉的**数量**
   回给调用方（`hidden`），界面用一行「还有 N 项未显示」说出来 —— 有界列表不静默藏东西。
4. **搜索本身不在这里**：应用由调用方匹配（它才有本地化名字）、文件走 `searchFiles`、计算走
   `calcQuery` —— 三个来源各有一个所有者，本模块只**排序与定界**。

## 3. 计算行（复用计算器自己的引擎）

`lib/calculator.ts::calcQuery(raw)`：

- **同一个引擎**（`calcRun`），所以 Spotlight 的答案与「计算器」app 的答案**不可能不一致**——
  包括容易被误以为是 bug 的那部分：**从左到右、无运算优先级**（`2+3*4` = **20**），没有括号键
  （`((1+2))*3` ⇒ `ERR` ⇒ 不出行）。
- **两种拒答**：裸数字不是计算（回显查询的行是噪音）；`ERR`（除零、括号、未知字符）不是结果。
- **Enter 的行为**：把结果**拷进剪贴板**并保持面板打开。壳无法把值"喂"进计算器窗口
  （`wm_open` 只带一个标签），所以打开它反而会丢掉用户刚敲的数字 —— macOS 自己的答案（⌘C）
  既诚实又有用。剪贴板**拒绝**时如实说（`invoke` 解析成 `null`，不是 reject ⇒ 读值不读 `catch`）。

## 4. 文件行：两条揭示路径，各自服务一种窗口拓扑

| 路径 | 机制 | 服务谁 | 为什么不能只有一条 |
|---|---|---|---|
| 同窗口 | `propsBus` 的 `files` 通道（`appLinks.openFile`） | touch 形态：Spotlight 面板与 Files 屏在**同一页** | 桌面用它会**打给没人听**，是"多绕一步的死行" |
| **跨窗口** | 共享 store 的 `amos.files.reveal`（`appLinks.revealFileAcrossWindows`） | **桌面**：Spotlight 在启动器窗口、Files 在自己的 `WebviewWindow` | 共享 store 是壳唯一的跨窗口机制（`store-updated` 广播 + 每窗口重读） |

跨窗口那条的四条纪律（都有测试钉住）：

1. 它是**命令不是状态**：Files 读到后**清空**，所以第二个 Files 窗口开出来时拿到的是 `null`，
   不会重放一次几天前的揭示；
2. **写失败要说**：写不进去意味着"窗口开了但没定位到那一条" —— 不是那一行承诺的事；
3. **条目不在就什么都不做**（不发明幽灵行），但仍要清空自己；
4. Files 侧的两条路径**收敛到同一个 `reveal()`**（走到条目真正所在的文件夹并标记它），所以它们
   不可能给出两种"揭示"。

## 5. 可自跑的证据

```bash
cd crates/amos-tauri/frontend-ts
bun test src/__tests__/calculator.test.ts            # calcQuery：语义（含 2+3*4=20）与两种拒答
bun test src/__tests__/spotlightSearch.test.ts       # 顺序 / 唯一键 / 上界与回报 / 空查询
npx vitest run svelte-tests/spotlight-search.svelte.test.ts   # 计算行→剪贴板；文件行→揭示+开窗；裸数字无行
npx vitest run svelte-tests/files.svelte.test.ts     # 跨窗口揭示：落位、标记、消费、幽灵不出现
```

**负控**（构造 + 逐字节还原 `sha256sum -c`）：①去掉 Files 侧的"清空"⇒ 两条跨窗口用例红；
②去掉 `calcQuery` 的运算符要求 ⇒ 拒答用例红。

## 6. 诚实边界

1. **不做**：网页/词典/单位换算/系统设置项（macOS 的那些）—— 只做本仓真有引擎的三类。
2. **计算语义是 app 的**，不是数学的：`2+3*4` = 20（与「计算器」一致）。若将来给 app 加优先级，
   这条要**两边一起**改——`calcQuery` 的用例会先红。
3. **文件搜索是内容匹配的文本搜索**（`searchFiles(..., true)`），没有索引、没有模糊匹配、
   不搜宿主机的真实文件（那是 `media_*` 的领域，另有其 UI）。
4. **揭示**只在虚拟文件树内：它把 Files 窗口带到条目所在文件夹并标记该行，不是打开文件本身
   （Files 没有单文件查看器 —— 预览面板是另一个动作）。
5. **上界是固定的**（6 应用 / 4 文件），没有"更多结果"页。
6. **未做真机复核**（本轮无 Rust 改动；证据是上面四条命令与 `bun run check`）。
