# AmOS Stage Manager（舞台管理器）——常驻窗口栏、舞台分组与一键整理

**日期**: 2026-09-25 · **范围**: `crates/amos-wm/src/stage.rs`（纯几何）、
`crates/amos-tauri/src/stage.rs`（宿主命令与派生视图）、
`crates/amos-tauri/frontend-ts/src/lib/stage.ts` + `lib/stageKeys.ts`（前端 seam）、
`src/svelte/StageRail.svelte`（轨道）与 `DesktopShell.svelte`（接线）

**关联**: 本文件由 `crates/amos-tauri/src/stage.rs`、`crates/amos-wm/src/form.rs`、
`StageRail.svelte`、`DesktopShell.svelte` 的注释在**八处**指名；
`docs/multi-window.md`（窗口模型与 launcher/应用窗口的分层）、
`docs/screen-recording.md`（同一个「先给纯规则、平台调用留在 seam」的写法）。

> 本文回答那些注释留下的指向：**轨道为什么画在 launcher 里而不是一个常驻原生窗口**、
> **「停在轨道上」为什么不是一份单独的账本**、**工作区内缩覆盖了哪些落点路径**、
> **拖动时怎么把窗口夹回工作区而不与系统拖拽打架**——以及每一条的代价。

---

## 1. 这个模块做什么

三个语义，五个命令（`crates/amos-tauri/src/lib.rs` 注册），前端一条 seam（`lib/stage.ts`）：

| 命令 | 语义 | 前端包装 |
|---|---|---|
| `stage_snapshot` | 当前视图：模式是否打开、谁在舞台上、谁停在轨道上 | `stageSnapshot()` |
| `stage_set_enabled` | 打开/关闭 Stage Manager | `stageSetEnabled(enabled)` |
| `stage_park` | 把一个窗口**停到轨道**（= 窗口管理器的 `hide`） | `stagePark(label)` |
| `stage_bring` | 把停在轨道上的窗口**拿回舞台**（= 窗口管理器的 `reveal`，**不是** `open`） | `stageBring(label)` |
| `stage_arrange` | **一键整理**：把舞台上的窗口排成不重叠的网格 | `stageArrange()` |

`StageSnapshot { enabled, on_stage: StageWindow[], parked: StageWindow[] }`，
`StageWindow { label, app, instance }`。

**为什么 `StageWindow` 里没有 `title`**：一个窗口的人类名字在 AmOS 里只有**一个**解析器
（`svelte/locale.svelte.ts::windowName`），由 i18n 层喂词。在这里用 Rust 造一个标题，
只可能是原始 app id——于是同一个窗口在界面上会有两个名字，且在任何非英文 locale 下都不一致。
这正是 `REQ-A473` 从窗口标题本身移除的那种漂移。

**为什么 `StageSnapshot` 里没有几何**：轨道要吃掉左边缘多少像素是一个**布局**事实，
它由 `LayoutSnapshot::rail_width` 报告（与 shell 已经据以绘制舞台的 `screen_w/h` 同源）。
在这里再报一次，会让轨道与桌面图标内缩对同一个数字有两份互相独立的读数——
那正是它们开始互相矛盾的方式。

---

## 2. 轨道画在 launcher 里，**不做**常驻置顶原生窗口（核心取舍）

**结论**：轨道是 **launcher 窗口里的 DOM**，它不被应用窗口盖住靠的是**几何约束**，
而不是 z 序。

- `LayoutPolicy::of(Desktop)` 的 `free_resize` 为真 ⇒ 桌面形态下应用窗口可以被用户自由移动；
- Stage 模式打开时，所有应用窗口的**落点**都在 `stage_work_area` 里（左边缘内缩 `rail_width`）；
- 因此轨道那条带里**永远没有应用窗口**，launcher 在该像素就是最上层窗口 ⇒ 轨道可见、可点。

另一个方案是把轨道做成一个独立的、`always_on_top` 的无装饰原生窗口。**没有采用**，因为它要：

1. 引入一个新的窗口 label ⇒ 必须逐一判定 `is_screen_window` 的**每一处**调用点
   （`wm.rs` 6 处、`spaces.rs` 3 处、`lib.rs` 1 处）以及 Dock / ⌘Tab / App Exposé 的成员资格；
2. 承担「一个置顶且非聚焦的原生窗口点击时到底会不会抢焦点」的行为风险——这条在本机
   **无法验证**，只能在一个真机会话里观察。

几何约束的代价是：**用户仍可能把窗口拖进那条带**（见 §6），以及若将来真机发现条带仍被覆盖，
就得升级为独立原生窗口并连带做上面第 1 条。这条升级路径被**明确保留**，不在本轮预先扩张。

---

## 3. 「停在轨道上」是**派生**的，不是第二份账本

`parked` 不是本模块维护的列表。它是 `WindowInfo.state == "Hidden"` 的**应用窗口**，
从 `WmState::snapshot` 读回来的——那是窗口管理器**已经在维护**的模型。

这正是轨道能**免费地**跟着真相走的原因：关闭一个停在轨道上的窗口会把它从窗口列表里移除，
轨道随即不再画它，**没有人需要通知轨道**。在本模块里再放一个 `parked: HashSet<label>`
就是经典的两份账本漂移（`crate::wm` 的 `bind`/`unbind` 注释警告的那种），它的第一个症状
会是「一个已经不存在了的窗口的轨道磁贴」。

### 3.1 停/取复用窗口管理器自己的状态迁移

`stage_park` 就是 `WmState::hide`，`stage_bring` 就是 `WmState::reveal`——**不是**新的状态迁移。
（取用的是 `reveal` 而**不是** `open`：`open` 是启动动词，其身份门禁拒绝任何不是某 app
**第一个**窗口的标签，而轨道为第二个实例（`notes_2`）也画一块瓷砖 —— 用 `open` 的话那样一块
瓷砖能被停却永远拿不回来，且拒绝会穿上 `StageLockFailed` 的句子；REQ-A1706。）
一个用第三种机制移动窗口的舞台，会需要它自己的一套事件流和聚焦规则；复用这两个意味着
Dock 的运行小点、⌘Tab 列表和 `wm-changed` 对一个「停着的」窗口的表现，与对一个 ⌘H 的窗口**完全一致**。
变更通知同样复用既有的 `WM_CHANGED_EVENT` ∕ `LAYOUT_CHANGED_EVENT`，**不新增事件**。

### 3.2 模式开关是一个偏好，不是账本

「Stage 模式开/关」是一个偏好（设置页 `WindowPage.svelte`），不是本模块的账本。

它落在 `SharedStore` 的 `STAGE_ENABLED_KEY`（`amos.wm.stage_enabled`，值 `"1"` ∕ `"0"`）上：
`stage_set_enabled` 在**模式移动之前**先拒绝一次存不下的**变更**（`ErrorCode::StagePersistFailed`），
成功后写入；`stage::apply_persisted` 在启动时把它读回来（`lib.rs` 的 setup，紧跟
`rotation::apply_persisted`，与 `rotation` 同一写法）。没有这两半，模式每次启动都会静默
复位为 OFF —— 正是 `StagePersistFailed` 命名的失败（REQ-A1755）。

---

## 4. 默认 **OFF**：今天的用户行为一个字不变

Stage 模式默认关闭。关闭时：

- 轨道不渲染；
- 工作区内缩为 **0**（`stage_work_area` 是恒等）；
- `Moved` 夹取直接返回 `Ok(0)` 且**零平台调用**。

因此引入这个域**不改变任何现有行为**——与 `LayoutPolicy::of` 里
"introducing the domain changes no behaviour" 的既有纪律一致。

---

## 5. 几何：轨道宽度、工作区内缩、整理网格

三者在 `crates/amos-wm/src/form.rs` 与 `src/stage.rs` 里，都是**纯函数**（无平台、无 IO）：

| 常量 ∕ 函数 | 值 ∕ 语义 |
|---|---|
| `STAGE_RAIL_WIDTH` | 180 px。只有**用户可以自由移动窗口**的类别才有舞台，所以这是 `FormFactor::Desktop` 的数、其余类别为 0 |
| `MAX_STAGE_WINDOWS` | 16。整理网格是**有界分配**（Power of 10 #3）：超过则**拒绝**，而不是造出第 N 条分不清的细缝 |
| `stage_rail_width(self)` | 无轨道类别返回 0 ⇒ 内缩成为 no-op |
| `stage_work_area(self, area)` | 左边缘内缩 `rail`；**不变量**：区域放得下时永远给 `min_pane` 留足空间（宁可缩轨道，不缩窗格） |
| `arrange_stage(self, stage, count)` | 1 扇居中、2 扇并排、3–4 扇 2×2，更多取 `ceil(sqrt)` 网格；每格 `enforce_min` 后夹进舞台 |
| `overlaps_rail(rect, area, rail)` | `rail == 0` 永远不重叠 ⇒ 关闭时所有调用者都是零平台工作的 no-op |
| `reflow_out_of_rail(rect, area, rail, min_pane)` | 已经不在带里 ⇒ `None`（「不调用、不派事件、不抖动」，对齐 `WmState::reclamp_target`） |

**内缩铺到所有会把窗口放到左边缘的路径**，而不只是创建与级联：
创建、级联（`initial_window_for` ∕ `cascade_from`）、`restored_geometry`（从持久化几何读回）、
`reclamp_windows`、`snap_work_area`、**maximize（Zoom）**、分屏应用。
漏掉任一条都会让某类窗口在 Stage 模式下开进轨道带。

---

## 6. 拖动：`Moved` 之后**先夹、后记**，并去抖

系统拖拽是**平台**在做。本模块在窗口的 `Moved` 事件之后把它夹回工作区
（`WmState::stage_clamp_moved` + 纯函数 `should_clamp`），三条纪律：

1. **先夹后记**。被夹之后的矩形才是被**记住**（`window_state.rs` 持久化）的那个。
   否则下次启动会从一个落在轨道带里的位置开窗。
2. **`None` ⇒ 不调用**。已经不在带里的矩形不动它——不 `set_position`、不派事件、不记忆。
   每次 `Moved` 都无界地 `set_position` 会与平台拖拽**打架**。
3. **去抖**（`STAGE_CLAMP_DEBOUNCE_MS = 120`）。拖动过程中条带可能被瞬时压住，由这个窗口界定；
   这是**视觉瑕疵**，不是正确性缺口。

---

## 7. 入口

- **Window 菜单**（`TopbarMainMenu.svelte`）：Stage 开关、整理；
- **弦**：`⌃⌘S`（`lib/stageKeys.ts::STAGE_TOGGLE_CHORD`，与菜单键帽**同源**，一个测试钉住弦位空闲）；
- **设置**：`settings/WindowPage.svelte` 的开关；
- **i18n**：`zh.ts` ∕ `en.ts` 同时存在且 `{param}` 名一致。

---

## 8. 诚实边界（不是未说明的缺陷）

- **轨道条带的真实遮挡 ∕ 点击行为未经真机验证**。本方案靠**几何约束**保证不被覆盖，但
  「把窗口拖进条带的瞬时遮挡」（§6 的去抖窗口）与「点击轨道会聚焦 launcher（而非保持前台 app）」
  是**已知差异**，如实写在这里而不是藏起来。
- **拖动时的短暂重叠**：夹取跑在 `Moved` 事件之后，因此拖拽过程中条带可被瞬时压住；
  由 120 ms 去抖界定，披露为视觉瑕疵而非正确性缺口。
- **Spaces × Stage 交叉：已结清（REQ-A1686）**。曾经因为「在轨道上」派生自 `Hidden`，
  被 Spaces 切走的窗口在 Stage 模式下会出现在轨道上——而点它会把一个属于别的桌面的窗口
  带到当前 Space。修法**不是**给每个隐藏窗口加原因标记（那是同一事实的第二份账本），
  而是让轨道读 Spaces 自己的答案：`SpaceManager::hidden_by_switch()` 返回
  `switch_plan()` 的 `hide` 一半，`stage.rs::views_of` 用它把这类窗口排除出 `parked`。
  锁序在读取处显式释放（`hidden_by_spaces` 返回 owned `Vec`），因为
  `spaces_switch` 走的是 spaces → window-manager 的顺序，反过来会死锁。
  边界仍在：`stage_bring` 本身不拒绝这类标签（它不拥有「这个窗口属于哪个桌面」的权威），
  但没有任何面会为它提供一个入口——轨道不再画那块瓷砖。
- **全屏 Space 下的轨道行为**未验证。
- **持久化拒绝只在「没有落盘文件」的 store 上可达（REQ-A1755）**。`SharedStore::new()`
  在既无 `AMOS_STATE_FILE` 又无 `HOME` 时退化成 `memory()`（`path()` 为 `None`），此时
  `stage_set_enabled` 会**拒绝**那次变更（`amos.stage.persist_failed`）而不是假装存下 ——
  这是本模块**唯一**能观测到的持久化失败，因为 `SharedStore::insert` 是无返回值的、磁盘写
  错误被 `warn!` 吞掉。于是这里有一个**刻意的兄弟分歧**：`SpaceManager::save` 等偏好在同一
  环境下是尽力而为地写、重启即失，舞台选择拒绝，因为「重启后不是用户要的那个模式」与
  「用户要的那个模式这一刻没生效」是两回事，本仓的纪律是宁可具名拒绝也不静默降级。
  代价：在那种退化环境里开关会报错（其它偏好不会），真机（`HOME` 存在）走不到这个分支。
- **启动重放未经真机验证**：`apply_persisted` 的种子路径只有单测覆盖，没有一次真实重启会话。
- **升级路径**：若真机发现条带仍被覆盖，则按 §2 升级为独立原生窗口，
  并连带做那 11 处 `is_screen_window` 的逐点判定——**留到那时再做**。

---

## 9. 与旧结论的关系

`AmOS缺失功能执行摘要.md` ∕ `AmOS与iOS功能对比分析_缺失功能清单.md` 曾把
「Stage Manager 式自由窗口」列为未交付。那一次判断读取的是「没有自由拖拽的多窗」，
而**自由拖拽 + 缩放早已存在**（`wm.rs` 的桌面形态 `.resizable(policy.free_resize)`，
`DesktopAppWindow.svelte` 的自绘标题栏逐元素 `data-tauri-drag-region`）。
真正缺的从来是 Stage Manager 的**语义**——常驻窗口栏、舞台分组、一键整理——即本文件所记的这三项。
两份旧文档已在 2026-09-25 就地更正。
