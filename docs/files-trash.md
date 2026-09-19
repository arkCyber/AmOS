# 文件与废纸篓（Files / Trash）—— 删除必须有退路

> 状态：**已实现**（REQ-A455，2026-09-19）。本页是这条工作的设计记录，每条判断后面都跟着
> 可自跑的命令或文件位置。

---

## 1. 缺陷（Why）

`FilesApp` 的删除是**永久**的：`lib/files.ts` 只提供 `deleteEntry`/`deleteEntries`（纯列表过滤），
界面直接把结果写回 `amos.files` —— 没有确认、没有撤销、没有「放回原处」。
Dock 上的废纸篓瓦片因此只能是**灰的**，而且它的理由写得很直白：

> There is no Trash to open: the Files screen has no trash view and the desktop has no
> filesystem view, so an "empty the trash" action would have nothing to act on.
> —— `modules/DockTrashItem.svelte`（REQ-A455 之前的原文）

macOS 的 Finder 把废纸篓当作**第一道保险**：误删是常态，所以删除是"移动"，不是"销毁"。
AmOS 此前没有这道保险（SMS 有"视图层 trash"，文件层完全没有）。

## 2. 设计（What）

### 2.1 账本与树分开

| 键 | 内容 | 归属 |
|---|---|---|
| `amos.files` | 文件树（`FEntry[]`） | 用户内容 |
| `amos.files.trash` | 废纸篓账本（`TrashItem[]`） | 用户内容（**与树一起备份**） |

账本**不**塞进 `FEntry[]`（不做 `trashed: true` 标记）：那样每个既有操作
（`sortChildren`/`searchFiles`/`folderTree`/`recentFiles`…）都要学会忽略它 —— 本仓一贯的做法是
**去掉这种形状**，而不是给每个调用点加一个过滤器。

`TrashItem` 存的是**整棵被删的子树**（`members`，**根在第一个**）加它的来源（`fromParent`）与
删除时刻：文件夹必须能**整个**回来，而"根"是界面用来命名、`restoreFromTrash` 用来查的那个 id。
行只按 **id** 寻址（根 id 一旦进账本就空出来了），**不按名字** —— 名字正是用户会撞的东西。

### 2.2 三个纯函数 + 一个上界

`lib/files.ts`（全部是纯函数，时钟由调用方注入，所以"最旧的先出局"可离线测）：

| 函数 | 语义 |
|---|---|
| `moveToTrash(list, trash, ids, now)` | 删 = **移动**；一选多个时"最上层"的那些各自成为一行（选了文件夹又选它里面的东西 ⇒ **一行**，不是两行） |
| `restoreFromTrash(list, trash, id)` | 放回；**返回具名结果**（`restored` / `restored-to-root` / `not-found` / `name-conflict` / `id-conflict`） |
| `purgeFromTrash(trash, ids)` | 唯一真正的销毁；空集原样返回（所以"清空"就是一行调用） |
| `normalizeTrash(raw)` | 防损坏：根不在 `members` 里的行丢弃、坏的时钟归 0、`members` 重排为根在前、按根 id 去重、应用上界 |

**上界是安全属性**（`MAX_TRASH_ITEMS = 100`）：账本无界增长会把共享 store 撑到写失败，而
"安全网自己写不进去"正是它最不能有的失败。到顶时丢弃**最旧**的一项，并把这个数量**报给调用方**
（`MoveToTrashResult.dropped`），由界面说出来 —— 不静默丢。

### 2.3 提交顺序：先账本，后树（**这是本页最重要的一行**）

两个 store 键无法原子写入，所以必须有一种失败顺序。`FilesApp.commitTrash` **先写账本、再写树**：

| 顺序 | 第二步失败时 | 后果 |
|---|---|---|
| **账本 → 树**（采用） | 文件**同时**在树里和废纸篓里 | 重复，**看得见、可修** |
| 树 → 账本 | 文件**两处都没有** | **数据丢失** —— 安全网最不能有的结果 |

`src/__tests__/…` 与 `svelte-tests/files.svelte.test.ts` 各有一条用例钉这个顺序
（后者构造 `amos.files.trash` 写失败 ⇒ 文件**必须仍在树里**）；把 `commitTrash` 里两行对调，
测试立刻红。

### 2.4 界面

- 列表里的「删除」现在叫**「移到废纸篓」**（`files.delete`），行为与名字一致。
- 视图切换条多一个 **废纸篓 (n)** 页签；那一页只有两个动作：**放回原处**（每行）与
  **清空废纸篓**（顶部）。破坏性动作只在这一页里，且要第二次点击 —— 列表页永远没有"销毁"。
- 放回被拒（同名 / id 冲突）与"原文件夹已不在、已放回根目录"都用**一个 live region** 说出来
  （`role="status"`，`data-testid="files-trash-note"`），不是一闪而过的 toast。
- Dock 上的废纸篓瓦片**仍然灰**，但理由换了（旧理由已经变成假话）：宿主只有
  `wm_open(label)`（只带一个窗口标签），所以瓦片打不开**另一个窗口里的那一页** ——
  它现在的名字直接说清在哪看（`desktop.trashInFiles`）。

## 3. 可自跑的证据

```bash
cd crates/amos-tauri/frontend-ts
bun test src/__tests__/files.test.ts            # 31（含 13 条废纸篓：往返恒等 / 子树 / 上界 / 冲突 / 防损坏）
npx vitest run svelte-tests/files.svelte.test.ts  # 27（含 5 条废纸篓 DOM：移动 / 放回 / 永久删除 / 失败回退 / 同名拒绝）
node scripts/store-scan.mjs                      # 每个 store 键要么进备份、要么带理由被登记
```

**负控**：把 `FilesApp` 的 `commitTrash` 两行对调 ⇒ "a refused ledger write leaves the file IN
THE TREE" 红；把 `restoreFromTrash` 的同名检查删掉 ⇒ `name-conflict` 用例红。

## 4. 诚实边界（登记，不假装）

1. **放回后排在兄弟之后**：`FEntry` 不带顺序，硬造一个位置就是编一个没量过的数 ——
   所以"放回原处"恢复的是**位置所在的文件夹**，不是原来的第几行。
2. **同名冲突是拒绝，不是自动改名**：macOS 会弹出"保留两者/替换"，本仓这一轮**不动用户的
   东西**：拒绝并把名字说出来，由用户决定。
3. **上界之外的最旧项被永久删除**（有回报）：废纸篓是安全网，不是归档（macOS 同样按时间清理）。
4. **跨窗口**：账本走共享 store，所以另一个窗口的删除/清空会通过 `store-updated` 生效；
   本窗口若正停在废纸篓页，会看到它消失（`not-found` 路径）。
5. **Dock 瓦片仍未接线**（上面 §2.4 的理由）；它现在的名字指向「文件」。
6. **不动宿主**：这一层没有文件系统调用（`amos.files` 是 WebView 侧的虚拟树），所以没有
   信任边界变化；真正的宿主路径（相机/相册/下载）走 `media_*`，不在本轮范围。
