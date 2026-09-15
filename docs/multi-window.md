> **注（迁移）**：共享 store 现由 `frontend-ts/src/lib/amosStore.ts` 承载（**经真实 Tauri 命令** `store_set` / `store_snapshot` 与 Rust `SharedStore` 互通，见下 §3/§5）。下文 `core.js` / `main.js` 指早期 vanilla 实现，接口语义一致；历史版本里那条 `window.Amos.storeWrite` 注入桥**从来没有被任何一方提供**，故写透当时是静默死代码（REQ-A101 已修）。

# Amos Multi-Window Architecture (真·OS 阶段)

> 目标：从「单窗口 SPA（启动器 + 视图）」升级为「单应用 + 多窗口」——主窗口是
> **Launcher**，点击图标由 Rust 创建/聚焦一个全新 `WebviewWindow` 覆盖在最上层。
> 所有窗口共享同一个 Rust 后端与同一条 gRPC 管道去调用底层 AI 推理引擎。

## 1. 分层

```
[ WebView: Launcher ]   [ WebView: App A ]   [ WebView: App B ]   ... 多窗口
        │                     │                    │
        └──────────────┬──────┴────────────────────┘
                       ▼
        [ amos-tauri Rust: WindowManager 适配层 ]   ← 把 WmEvent 映射到 WebviewWindow
                       │        ▲
            事件总线/状态同步   │ 共享 AppState + gRPC 客户端
                       ▼        │
        [ amos-ai 守护进程 (UDS + gRPC) ]           ← 唯一 AI 管道
```

- **血脉相连**：每个窗口看似独立，但都运行在同一个 `amos-tauri` 进程里，共享
  `AiBridge`（复用缓存的 gRPC channel）与 `WindowManager`。
- **共享状态**：设置、通知、主屏布局等不再依赖各 WebView 独立的 `localStorage`，
  下沉到 Rust `State`（或共享 `tower`/事件总线），再广播给各窗口。

## 1.5 形态因子（Form factor）与运行时布局策略

AmOS 的窗口层要能跑在手机 / 平板 / PC / 机器人上，而**编译器只知道两件事**：Tauri
依据 target triple 注入的 `cfg(desktop)` / `cfg(mobile)`（`crates/amos-tauri/src/wm.rs`，
由 `tauri-build` 发出）。手机与平板是**同一个** `aarch64-linux-android` target ⇒
「手机 vs 平板」**不是**编译开关能表达的，只能是**运行时**判定。

判定逻辑下沉为 `amos-wm` 的形态域（纯 `std`、全 `Copy`、无分配、无 I/O、无
panic）：`crates/amos-wm/src/form.rs`。

| 类型 / 函数 | 作用 |
|---|---|
| `form::FormFactor{phone,tablet,desktop,robot}` | 设备类别。`as_str()` 是**唯一的线上键**（同时也是 `AMOS_FORM_FACTOR` 的取值），`parse()` 未知值返回 `None`（绝不猜）；`has_ui()` 对 `robot` 为 `false` |
| `form::resolve_hint(raw, from_build)` | 无提示 ⇒ 构建类别；已知名 ⇒ 采纳；**未知值 ⇒ `Err`**（携带原值）——调用方必须把它报告出来 |
| `form::LayoutPolicy::of(form)` | 该类别允许做什么（`const fn`）：`multi_window` / `free_resize` / `divider_gap` / `min_pane` / `max_columns` / `initial_window` |
| `LayoutPolicy::columns_for(width)` | 该宽度能放几列（1..=4，整数运算，宽度 0 也得 1 列）——**运行时**手机 vs 平板信号 |
| `LayoutPolicy::split_axis(screen)` | 宽屏左右分、竖屏上下分；正方形与 0×0 一律 `vertical`（确定性） |

| 形态 | multi_window | free_resize | divider | 最小窗格 | 列上限 | 新窗口初始尺寸 |
|---|---|---|---|---|---|---|
| phone | ✗ | ✗ | 8px | 360×480 | 1 | 480×820 |
| tablet | ✓ | ✗ | 12px | 320×480 | 2 | 900×1200 |
| desktop | ✓ | ✓ | 8px | 360×480 | 4 | 1024×720 |
| robot（无 UI） | ✗ | ✗ | 8px | 1×1 | 1 | 1×1（惰性） |

**phone 与 desktop 刻意沿用**该域引入前宿主写死的 `SPLIT_GAP = 8` / `SPLIT_MIN =
360×480` ⇒ 引入本模块在任一编译目标上**不改变一个像素**（回归用例
`phone_and_desktop_policies_keep_the_values_the_host_used_before` 钉住）。

### 旋钮与诚实边界

| 旋钮 | 取值 | 语义 |
|---|---|---|
| `AMOS_FORM_FACTOR` | `phone`\|`tablet`\|`desktop`\|`robot`（大小写不敏感、容忍首尾空白） | 覆盖构建类别。**未知值不改类别但会 `warn!` 上报**；启动时 `info!` 打印实际采用的 form 与来源（`env` / `build-default`） |

- 编译期只有 desktop / mobile 两类；**没有** `target_form_factor` 这类开关——它表达不了"同一 APK 在两种屏幕上"。
- **窗口面积是实测的，不是写死的**：`WmState::sync_window_layout()` 在启动（`lib.rs` 的 `setup`）以及**屏幕窗口**的 `Resized` / `ScaleFactorChanged` 事件上重新测量真实窗口，把面积与列信号同步过去，并把在线分屏重新铺到真实窗口；**只有 Launcher/`main` 窗口定义屏幕**（`wm::is_screen_window`）——应用窗口（含分屏窗格本身）只是被摆在它**内部**，否则写窗格的动作会把自己的 resize 事件喂回自己。读数一律换算成**逻辑像素**（与 `LogicalPosition/LogicalSize` 的落点一致；2× 屏若按物理像素算会把窗格放到窗口外），不可用的读数（NaN / ≤0 / 超大）宁可用旧值也**不编一个屏幕**。只有真的变化才回 (`sync_screen` 返回 `None` = 无变化)，避免每次 resize tick 都广播 `layout-changed`。
- 常量 `FALLBACK_SCREEN`（1080×1920）只是**尚未测量时**的占位，**不是**对屏幕的声明；启动时若读不到窗口，`debug` 会如实说明。
- 机器人形态**不构建** `amos-tauri`（`scripts/build-android.sh` 只构建 `amos-ai` + `amos-wm`），故 `FormFactor::Robot` 的窗口数字是**惰性**的；它们仍被保持在合法区间内，使忽略 `has_ui()` 的调用方也**算不出零尺寸窗格**。若在 UI 构建上强行 `AMOS_FORM_FACTOR=robot`，宿主会**拒绝**分屏（错误里点名类别），而不是返回一个"没人看得见"的分屏快照。
- 新应用窗口按类别的 `initial_window` 打开（此前一律 `480×820` 手机板；phone 保持该值不变）。
- `wm_split` 的 `axis` 新增 `auto`（空串同义）：由策略按屏幕宽高比选择，供会旋转 / 窗口可变的平板与桌面壳使用；其余取值仍逐一校验，未知值照旧拒绝。
- `LayoutSnapshot` 携带 `form` / `columns` / `multi_window` / `free_resize` / `divider_gap`，前端**从宿主读能力**而不是靠 WebView 宽度猜；`lib/wm.ts` 的 `normalizeLayout` 把读不懂的载荷降级为最保守的 phone / 1 列——**能力绝不因畸形载荷而被"获得"**。
- **线上契约（9 个键）由两个测试钉住**：`crates/amos-tauri/src/wm.rs` 的 `the_layout_snapshot_wire_shape_is_pinned`（快照 / `split` / `pane` 三层**精确键集** + 取值，含 `form` 走线上键、未测量时是占位屏）与 `frontend-ts/src/__tests__/wm.test.ts` 的镜像键集测试。为什么必须是测试：`lib/wm.ts` 经 `invoke(command, args)` 这个**变量命令名**的包装去调命令，`scripts/tauri-reply-scan.mjs` 按它的既定边界（只查静态可命名的 `invoke<T>("cmd")`）**看不见这一对**——不钉住的话，Rust 侧改个字段名只会在壳里读成 `undefined`，再由 `normalizeLayout` 静默降级为 phone 默认值（与 Round 47 的短信回收站缺陷同类）。
- **第一个真正的消费者**：设置 →「窗口与形态」（`frontend-ts/src/svelte/settings/WindowPage.svelte`）读宿主当前值并随 `layout-changed` **实时**更新：设备形态 / 内容列数 / 多窗口 / 自由缩放 / 分栏间距 / 当前分屏（`describeSplit`）。诚实规则：**无宿主 ⇒ 全部显示「—」并在页面上说明原因**；宿主答 `null` ⇒ 回到「—」，**不保留陈旧读数**；页面不轮询、不猜。
- **该页的状态判定是"订阅 + 有界重探 + 可见即重探"三条腿**：订阅负责即时（宿主只在真变化时发），重探（10 s、仅可见标签页）负责"**宿主消失**"——没有事件会为一个已经不存在的宿主而来，只看订阅就会把上一次读数永远留在屏上（REQ-A220 修的正是这个）；`visibilitychange` 负责"**回到页面**"——隐藏期间的重探被跳过，没有它用户回来会看到最多滞后 `PROBE_MS` 的读数（REQ-A221 补）。重探的 `null` 如实回到「—」，并把「**无桥**（浏览器预览）」与「**有桥但宿主不应答**」分开陈述（与权限面"读不到权威 vs 权威为空"同一区分）。
- **布局桥的失败语义**：`lib/wm.ts` 的封装一律走 `lib/backend.ts` 的 `invoke`（单一真源）——**命令失败时 resolve 成 `null` 并记入诊断账本**，绝不 reject（一个 reject 就会在不写 `.catch` 的消费者里变成 unhandled rejection，且失败对 UI 不可见）。这条契约由 `src/__tests__/wm.test.ts` 的失败用例钉住。
- **壳窗口也按类别定尺寸**：`tauri.conf.json` 给主窗口写死了 480×820（手机板），而**应用窗口**早就按 `initial_window` 开 ⇒「PC 上不要开出手机板」此前只做了一半，**壳自己**在 PC 上仍是手机板（REQ-A222 修）。规则故意很窄：`LayoutPolicy::shell_resize(current, handset_default)` **只替换那个写死的默认值**——用户拖过、OS 定过、或本来就是该类尺寸（含未测量的 0×0）一律 `None`，**别人选过的尺寸永不争夺**；无 UI 类别永不碰几何。比较在**逻辑像素**里做（config 是逻辑、`inner_size()` 是物理），失败如实 `warn!`。
- **那个常量不是手抄的第三份（REQ-A223）**：`SHELL_DEFAULT_WINDOW` **派生自** `LayoutPolicy::of(FormFactor::Phone).initial_window`，并由 `the_shell_default_is_the_phone_window_declared_in_tauri_conf` **读 `tauri.conf.json`** 钉死——一个抄错的常量只会让比较**永不相等**（于是永不 resize，缺陷静默复活），所以"config ↔ 常量"必须有一条会红的门。
- **读数→决策是一段纯函数（REQ-A223）**：宿主把生读数交给 `wm::shell_resize_reading(policy, 物理宽, 物理高, scale) -> Option<(Size /*was*/, Size /*now*/)>`，它做「物理 ⇒ 逻辑 ⇒ 问策略」这一段——REQ-A218 的 DPI 缺陷正是这段**组合**，而它此前内联在需要真 `AppHandle` 的 `fit_shell_window` 里、**无法单测**。它有两种**拒答**：坏尺寸（0×0 / NaN / 超大）在问策略**之前**就 `None`（绝不能长得像"默认值"而触发一次 resize），坏 scale（NaN / 0 / 负 / ∞）也 `None` 而不是按 1× 猜（`logical_size_of` 对**布局**路径仍按 1×，那是它自己的、被单测钉住的契约）。宿主侧 `scale_factor()` **读失败**时如实 `warn!` 并**不动作**（宁可不动，也不拿猜的因子去争一个 2× 用户自己选过的尺寸）。
- **日志说的是"请求了什么"**：`fit_shell_window` 返回 `(was, now)`，boot 日志同时打新旧两边，并写明这是**请求**——`set_size` 是交给平台的一条指令，**权威尺寸**由随后的 `sync_window_layout` 实测给出（`set_size` 的落点本身需真桌面确认，见诚实边界）。
- **分屏不再只是"看得见"（REQ-A224）**：设置 →「窗口与形态」在**宿主自报** `multi_window == true` 时渲染分屏控件——候选窗口（来自 `wm_split_candidates`，**不由页面编造**；不足两个时"进入分屏"按钮是 **inert** 的）、进入分屏（轴用 `auto`，交给宿主按真实屏幕宽高比选）、交换窗格、主窗格 ±5%、退出分屏。控件**不决定窗格怎么画**：宿主早已把窗格落到**真实 OS 窗口**（`apply_split_to_real`），控件只让用户能**提出请求**。诚实规则与页面读数一致——命令答 `null`（无宿主 / 宿主拒绝 / 失败）**绝不更新读数**（失败的动作不许看起来像成功），只多一行说明、明细在诊断账本；一次只跑一条命令且 `busy` 必被释放；**退出分屏后重读候选**（没有它"再次进入"会停在一份从未刷新的名单上）。点击前的闸门是**宿主自己的 `multi_window`**——手机类别答 `false`，页面就不提供这个请求（"先给你按、再被拒"是一种谎）。`scripts/unwired-scan.mjs` 的基线因此**缩减 5 条**（`wmSplit` / `wmSplitCandidates` / `wmSplitExit` / `wmSplitMove` / `wmSplitSwap` 从"已定义但未接"名单移除）；绝对百分比的 `wmSplitResize` 是同一操作的程序化形式、暂无界面采用，仍如实留在基线里。
- 仍未做（诚实边界）：**壳内渲染两个窗格**。宿主今天的 `apply_split_to_real` 是把窗格落到**真实 OS 窗口**上的，而本文档把"多真实窗口 vs 壳内单窗口渲染"留成**未决的设计选择**——在壳里再画一遍会与宿主重复。同样地，`columns`（内容列数）当前只被如实**展示**，还没有内置 app 采纳它做双栏/主从布局。
- **「窗口管理器 (调试)」卡片回来了（REQ-A225）**：`docs/multi-window.md` §4.2、`docs/gui-verify.md` A4、`docs/android-compat.md` W4 与 `docs/android-lmk-e2e.md` G1/G4 都要求用 `wm_windows` 的窗口列表做验收，但**没有任何 Svelte 界面读过 `wm_windows`**（只有 `lib/lmk.ts` 的内部对账用）——那几条人工验证在当前构建里**根本没法执行**（旧 React 宿主的卡片随宿主一起被删了，文档却还在指向它）。现在 设置 →「窗口与形态」页底部有这张卡片：按宿主自己的措辞逐条列出 `label [kind] state`，聚焦窗口标 `←聚焦`、**无 WebView 的容器合成表面**（`legacy:<window_id>`）标 `外部表面`；随 `layout-changed` 推送自动重读，并有「刷新」按钮；宿主未桥接 / 不应答 / 一个窗口都没有，三种情况各自如实陈述（**读失败时清空而不是保留上一份列表**——调试卡上显示一个已经不存在的窗口，比承认"不知道"更糟）。线格式的归一化收敛到 `lib/wm.ts` 的 `normalizeWindows`（无 `label` 的记录被**丢弃**，其余字段各自回落到最保守值），`lib/lmk.ts` 里那份重复的 `wmWindows` 封装与私有 `WmWindowInfo` 一并删除、改为复用同一份（单一真源）。
- **候选窗格必须是本宿主能摆位的窗口（REQ-A226）**：`wm_split_candidates` 命令与 `LayoutSnapshot.candidates` 字段现在由**同一个** `pane_candidates` 生成，并**剔除外部容器合成表面**（`legacy:*`，Waydroid 合成、没有 `WebviewWindow`）——`apply_split_to_real` 本来就跳过它们（几何归容器所有），把它们当候选，只会让设置页给出一个**屏幕上不存在的分屏**（正是那个函数文档里警告的"模型说分了、屏幕没动"）。摆位被跳过也不再是静默的 `continue`：现在会 `warn!` 点名那个窗格。**模型层刻意仍接受任意两个窗口**（`enter_split` 不拒绝容器表面）：那是"描述它们该在哪"的意图层（该函数的注释写着"geometry is owned elsewhere / **comes later**"），更严格的拒绝需要给集成测试开一个**只有测试用**的公共注册缝——那本身就是本仓 `rust-unwired-scan` 要抓的缺陷类。所以本轮收敛为**更窄但正确**的规则：**offer 层面过滤 + 摆位失败如实上报**（见 `enter_split` 里的 NOTE）。**可逆性**：将来容器若愿意服从窗格矩形，去掉 `pane_candidates` 这一处过滤即可。界面侧：设置页检测到外部表面存在时，会在「可分屏窗口」下方说明它为何不在候选里，而调试卡仍如实列出它（不隐藏）。
- **关窗必须留痕清零，且分屏不能比它的窗格活得久（REQ-A227）**：`wm_close`（LMK 拆除外部表面的路径：`lib/lmk.ts` → `wm_close` → `WmState::close`）此前只把窗口从 `amos-wm` 状态机里删掉，**却把 `label ⇄ id` 映射永久留着**——于是 `open_surface`（Android 启动 APK 的路径，`ai_bridge.rs`）在重开同一个 label 时短路进 `focus(已死 id)`，`WindowManager::focus` 对未知 id 返回空事件 ⇒ **重新启动该应用什么也没注册、也没有任何信号**（容器在跑、窗口管理器里没有它、调试卡也不显示）。现在 `close_core` 把该窗口从四张登记表（`by_label`/`labels`/`kinds`/`external`）**一起清掉**，因此"拆除 → 再次启动"会**真的重新注册**（新的 id、`Shown` + `Focused`，仍是 external System 表面）；同时**结束**引用它的分屏并把幸存窗格交回调用方（`close` 随即 `maximize` 它，与 `wm_split_exit` 同一恢复语义——否则幸存窗格会停在半屏、又没有任何分屏能解释它）。**刻意的不对称（`hide` 不结束分屏）**：隐藏是**可逆**的且窗口仍存在，`show` 之后窗格几何原样复原，所以模型继续描述这个排布是诚实的；只有"窗口已经不存在"才让分屏无法成立。
- **PC 实机验收（2026-09-14，macOS / 本机 Aqua 会话，REQ-A229 起可见）**：`bash scripts/run-ui-release.sh`（内嵌 dist 的 release 二进制）在本机跑通，宿主自己打出这条链——`form="desktop" source="build-default"` → `requested … shell window size was_width=480 was_height=820 width=1024 height=720` → 实测 `width=480 height=820 scale=2.0 columns=1`（**物理 960×1640 ÷ 2.0 = 逻辑 480×820**，Retina 换算在真机成立）→ 49 ms 后实测 `width=1024 height=720 scale=2.0 columns=3`（**`set_size` 真的生效**，`Resized` 路径把列信号纠正）。也就说本节里"真窗口未验"的三条（形态解析 / 壳窗口定尺寸 / 逻辑像素实测与列数）**已在本机被实测**：宿主日志给出 `was 480×820 → 请求 1024×720 → 实测 1024×720, columns=3`，而 **macOS 窗口服务器自己**（`System Events` 按新实例的 unix id 查询）报 **`size of window 1 = 1024, 720`**（对照：同机上 9 月 11 日留下的旧二进制实例窗口仍是 **480×820**）。**仍未验**的是"分屏窗格落到真实窗口"（需要第二个真实窗口，`wm_open` 尚无界面消费者）与 Android 路径。前置条件：这些日志**只有在宿主装了 `tracing` 订阅者时才打印**——桌面 sink 是 REQ-A229 才装上的（`host_log.rs`：Android→logcat，桌面→stderr，`RUST_LOG` 可覆盖）。**注（REQ-A233 之后的数值）**：桌面类别的请求已从"固定 1024×720"改为"**最大化以与桌面对齐**"，因此这条链现在实测为 `width=1496 height=881 columns=4`（见上表与下一条）。

- **"请求"与"落没落"分开说（REQ-A230，实机驱动）**：`set_size` 是**异步**的请求，真机日志实测到"紧随其后的 `sync_window_layout` **读到的仍是旧尺寸**"（`columns=1`），约 50 ms 后才由 `Resized` 事件路径读出 `1024×720 / columns=3` —— 所以宿主的真实做法是：**把请求记下来**（`WmCore::shell_fit`），由**事件路径**（其读数是"已应用"的）交给纯函数 `shell_fit_outcome(requested, applied)` 判定，并**明确**报出结果：兑现 ⇒ `INFO the requested shell window size was applied width=… height=…`；**没兑现** ⇒ `WARN the OS applied a different shell window size than requested requested_… applied_…`。这条 warn 不是推测：在**本机笔记本屏**（逻辑 1728×1117）上强制平板类别（`AMOS_FORM_FACTOR=tablet`，策略给 900×1200 竖屏）实测被 OS 压到 **900×881**，宿主如实报出两个尺寸（而**同一次运行的数值会变**：另一次是 882 —— 所以宿主**不猜**边距、也不替屏幕"适配"）。**同轮更正**：REQ-A222/A223 曾写"`setup` 在屏幕实测之前调用它，**随后 `sync_window_layout` 读到的就是新尺寸**"——真机证明这句话是**错的**（异步落地），已在追溯矩阵该行就地标注更正；正确说法是"请求先记下，权威尺寸来自随后的事件实测"。
- **PC 上"看得到窗口"本身是一条要修的链路（REQ-A232，实机驱动）**：`amos-wm` 断言"启动即 Launcher focused"，适配层文档也写着 `FocusChanged(Some(id)) → set_focus()`，但**启动路径从未把这件事告诉 OS** —— 于是从终端/脚本（后台进程）启动时，窗口**渲染正常却在别的 App 后面**，用户"看不到窗口内容"（本机实测：进程 `frontmost=false`，最前是编辑器）。补全：`WmState::focus_launcher()`（`show()` + `set_focus()`，**然后问平台** `is_focused()`——因为"调用返回 `Ok`"≠"用户看得见"；首版就踩了这个坑：日志写了"focused"而 `frontmost` 仍是 false）返回 `LauncherFocus{Focused|Refused|NoWindow}`；`setup` 里先按 macOS 请求 `ActivationPolicy::Regular`，再聚焦并**逐态如实上报**（`Refused` 会解释成因与出路）。**实测边界**：即便如此，**裸二进制**（`cargo build` 的产物、`make run-ui-release` 跑的那个）仍**不被 macOS 激活**——那需要一个 `.app` 包；`make app-open` 现在做这件事（`cargo tauri build --bundles app` + `open`，前置 dist 新鲜度门），**实测把窗口带到最前**（`frontmost=true`、窗口 1024×720、内容渲染 34 340 种颜色 vs 裸二进制时仅 3 078 种）。
- **形态必须落到「内容」上，否则平板只是"更大的手机"（REQ-A234，用户诉求驱动）**：`LayoutPolicy` 决定的是**窗口**能做什么（`multi_window` / `free_resize` / `divider_gap` / `columns`），但"这个类别里**内容**怎么排"是另一件事，此前**无人处理**：`HomeDock.svelte` 把 `per = 12`（4 列 × 3 行）与 `grid-cols-4` 写死，于是 900×1200 的平板窗口里仍是手机密度（iPadOS 竖屏 **4×6=24**、横屏 **6×4=24**），而 `Shell.svelte` **从不读形态**——壳层里没有"我是平板"这个概念。补全落在 `frontend-ts/src/lib/formLayout.ts`（纯函数，仿本 crate 的纪律）：`homeGrid(form, width, height)` —— **phone/robot/desktop 与"未测量屏幕"一律保持 4×3（phon​e 字节级不变）**，平板按 iPadOS 密度，正方形按竖屏（与 `split_axis` 同规则），`0`/NaN/∞ 的未测量屏幕**降级为手机栅格**（镜像 `columns_for(0) == 1` 的"未测量 ⇒ 最保守"）；`pageCapacity(grid)` 是"每页几个"的唯一答案。宿主权威的流向不变量不变：**类别只来自宿主**——`Shell.svelte` 读 `wmLayoutSnapshot` 一次并跟随 `layout-changed` 推送，**绝不从 WebView 宽度猜类别**；通道载荷里没有 `grid` 时降级为手机栅格（能力不因缺失载荷而被"获得"）。渲染侧用**内联 `grid-template-columns`**（Tailwind 会 purge 动态类名），`data-cols`/`data-rows` 是它的可测证据。**诚实边界**：①`desktop` 当时**刻意排除**（它的窗口已是可自由缩放的 OS 窗口，REQ-A233 已与桌面对齐；改桌面启动器密度是另一件事，测试里明确钉住）—— 该决定已被用户诉求推翻，处置见下下一条 **REQ-A249**，那条"刻意排除"的测试也随之下沉为桌面自己的规则；②本轮**没有做** iPad 式**侧栏**：壳层没有 per-app 导航模型，编一个假目录比不做更糟；③这是**内容**几何，不是分屏——分屏入口仍不可达（见 §1.5 上文 `wm_open` 无消费者）。
- **应用窗口必须以「自己的 app」开屏（REQ-A234）**：宿主创建每个应用窗口时用的是 `index.html#window=<label>`，注释写着 "so the boot script auto-navigates to that app's screen"（`crates/amos-tauri/src/wm.rs` 的 `WmEvent::Created` 分支），但**前端从未读过该 fragment**（`shell-entry.ts` 只认 `?surface=`）⇒ 每个应用窗口、以及**分屏的每个窗格**都显示**启动器**：`multi_window`（"两个 app 并排"是平板类别 `LayoutPolicy` 的全部意义）即便分屏成功，屏幕上也只是两份首页。补全：纯函数 `frontend-ts/src/lib/windowRoute.ts::appIdFromHash(hash)` —— 内置 app（`APP_META`）或 `store:<manifest.id>` 瓦片 ⇒ 该 id；**其余（含畸形 fragment、`legacy:*` 容器面、窗口 id、大小写不同）一律 `null`，绝不猜**（与 `FormFactor::parse` 的"unknown → None"同一条规则）；`shell-entry.ts` 在 `?surface=`（无头验收路径）之后调用它。**不复制** Rust 的 `LAUNCHER_LABEL`：启动器窗口本来就不带 fragment，且 `main` 不是任何 app id——多一份会漂移的常量换不到任何行为。
- **PC 窗口与桌面对齐 = "最大化"，而不是猜一个尺寸（REQ-A233，用户诉求驱动）**：用户要求"PC 窗口的界面与苹果电脑的桌面对齐，100% 对齐"。实测现状：桌面（Finder `window of desktop`）**1496×967**，而壳窗口是**固定 1024×720 放在 (508,45)**——**右边缘 1532 越出桌面**、只覆盖约一半面积。根因落在**领域规则**上：`LayoutPolicy::initial_window` 是**类别事实**（"PC 的窗口默认多大"），它**根本不知道**屏幕/菜单栏/Dock 能给出多少"可用区"，于是宿主只能照抄一个数字。补全：把该决策从"给一个 `Size`"升级为 `ShellFit{Leave|Resize(Size)|Maximize}`——**phone/robot ⇒ Leave**（手机本就是默认、无 UI 类别不碰几何）、**tablet ⇒ Resize(900×1200)**（真平板就是这个形状）、**desktop ⇒ Maximize**（PC 的壳**属于**它运行的那块桌面：**可用区由平台决定**——菜单栏、Dock、刘海——所以这里必须是"最大化"，而不是本 crate 自己猜一个尺寸，猜尺寸正是壳曾是"越出桌面右边的板子"的原因）。宿主侧：`shell_resize_reading` → `shell_fit_reading`（返回 `(was, ShellFit)`），`fit_shell_window` 对 `Maximize` 走 `window_maximize`、对 `Resize` 走 `set_size`（**只有精确请求才登记 REQ-A230 的"兑现/未兑现"比对**；最大化没有精确尺寸可比，实测报告可用区，**不多说一句**）。**实机实测（同一台 Mac）**：请求日志 `requested a desktop-aligned (maximized) shell window … was_width=480 was_height=820` → 实测 **`width=1496 height=881 scale=2.0 columns=4`**；窗口矩形 **`(0,29,1496,882)`** vs 桌面 `(0,0,1496,967)` ⇒ **x 相同、宽度 100.0%、右边缘齐平、上边贴菜单栏、下边贴 Dock**；内容侧 **10 010 种颜色、四条边缘都不是单色**（没有 letterbox/留白）⇒ 内容**边到边填满**窗口。对照：改动前是 `(508,45,1024,720)`。**诚实边界**：①`Maximize` 用的是平台的"缩放/最大化"语义（macOS 的绿键行为），**不**保证覆盖菜单栏/Dock（那才叫 fullscreen，是另一种模式）；②`columns` 因此从 3 变成 **4**（桌面策略上限），这是"对齐"的正确后果，不是回归；③平板/手机/机器人路径未被本改动影响（各自 `Resize`/`Leave`，手机字节级不变）。

- **桌面（macOS 窗口）第一次按 Mac 对齐「内容」：主屏仍是手机密度 + 窗口里画着 iPhone 硬件（REQ-A249，用户诉求驱动）**：用户要求"100% 对齐苹果电脑的界面"。取证分两处，都是**同一个根源**：`LayoutPolicy`/`ShellFit`（REQ-A233）把**窗口**摆对了（最大化、贴菜单栏与 Dock、内容边到边），但**内容**从未按 Mac 处理过 —— ①**主屏**仍是 4×3 = 12/页的手机密度，坐在一个 **1496×881** 的窗口里（REQ-A233 实测值），也就是"手机主屏被放大贴到 Mac 窗口上"；②更硬的一条：窗口里**画着 iPhone 的硬件与手势像素** —— 状态栏中央那颗 **Dynamic Island**（`StatusBar.svelte` 里一个绝对居中的黑色胶囊，代表 iPhone 的屏幕开孔）与 app 面底部的 **home indicator**（iOS 手势条），两者在 macOS 上**都不存在**（时间/无线/电量由 Mac 菜单栏回答；Mac 窗口没有手势条，它靠工具栏的返回控件 + Esc）。处置落在**同一个纯模块** `frontend-ts/src/lib/formLayout.ts`（它已经是"把宿主的类别变成具体内容决定"的唯一地方），新增三类纯函数并把消费点接上：**(a) `homeGrid` 的 desktop 分支** —— 由**实测窗口**按 pitch 算（`DESKTOP_COL_PITCH_PX = 170` / `DESKTOP_ROW_PITCH_PX = 140`，扣除状态行+组件头+分页点+Dock 的 `DESKTOP_CHROME_PX = 284` 与左右 `px-4`），并**双向夹紧**：`[phone, 8] × [phone, 6]`（小窗口**绝不比手机更少**、巨屏**绝不出现图标丢在格子里**）；1496×881 ⇒ **8×4 = 32/页**。**(b) `homeTile(form)`** —— 桌面用 Launchpad 级的**大图标**（栅格 80 px、Dock 76 px，字面类名两种各自写死，Tailwind 才看得见），因为 56 px 手机图标放进 183 px 的格子就是"手机截图"；**其余类别逐字节不变**（`regular` = 今天的样子）。**(c) `deviceChrome(form)`** —— `{dynamicIsland, homeIndicator}`：灵动岛**只**给 phone（只有 iPhone 有这个开孔；iPad 与 Mac 都没有），手势条只给**触屏类别**（phone/tablet），desktop/robot 两个都是 `false`。**接线**：`Shell.svelte` 由 `layoutSnap.form` 派生 `shellForm`（无宿主 ⇒ phone，与栅格同一条"缺失载荷不获得能力"规则）→ 传给 3 处 `<StatusBar form=…>`、`home` 通道多推一个 `tile`、app 面底部的手势条 `{#if chrome.homeIndicator}`；`StatusBar.svelte` 新增可选 `form` prop（默认 phone）并给灵动岛加 `data-testid`；`HomeDock.svelte` 的 `tile?` 可选（缺省 `regular`）。**证据**：`bun test src/__tests__/formLayout.test.ts` **15 例**（桌面 1496×881 ⇒ **8×4**、小窗口不比手机少、巨屏封顶 8×6、单调、未测量 ⇒ 手机栅格；`homeTile`；`deviceChrome` 四类别）；`vitest` 的 `svelte-tests/{shell,statusbar,home-dock}.svelte.test.ts`：桌面宿主 ⇒ app 面**没有** home-indicator、**没有**灵动岛，而**工具栏返回控件仍然回主屏**（"删掉的是不存在的硬件，不是回家的路"）；`layout-changed` 推一条 desktop ⇒ 两者**当场消失**（跟随推送，不是启动读一次）；iPad 也**不再**有灵动岛；缺 `tile` 的载荷仍是 `h-14`（不因缺字段而"获得"大图标）。**真机实测（同一台 Mac，debug 二进制 + 真 vite 服务，`RUST_LOG=info`）**：宿主自己打出 `windowing form factor resolved form="desktop" source="build-default" ui=true` → `requested a desktop-aligned (maximized) shell window` → `layout screen re-measured from the OS window width=1496 height=882 scale=2.0 columns=4`（**这就是 `homeGrid("desktop", 1496, 882) = 8×4` 的输入**）；屏幕截图（Retina 2×）按窗口矩形裁切后：**(a)** 整个屏幕的两张截图（修前行为注入 vs 修后）**只在 x=1382..1610、y=140..188（228×48 px）这一块不同** —— 正是灵动岛该在的位置（预期 w≈224、h≈44），修后运行的那张在该带里"最长纯黑连续run = **0 px**"，注入旧行为的**218 px**；**(b)** 同一张截图里的图标列聚类 = **8 列**，列心间距实测 ≈ **366 物理 px ≈ 183 逻辑 px** = `(1496−32)/8`，与 `homeGrid` 的桌面分支一致（旧代码走的是 `PHONE_GRID` 的 4 列 —— 这一点由单测与注入负控证明，**没有**在真机上回放旧版对比列数）。负控（真机 + 单元/DOM 共 4/4，每次注入后 `cmp` 还原**逐字节一致**）：`deviceChrome` 改回"两类都画" ⇒ 真机截图差异出现 228×48 黑块 + `statusbar`/`shell` 共 3 例 FAILED；删掉 `homeGrid` 的 desktop 分支 ⇒ `formLayout` 2 例 FAILED；`homeTile` 钉死 `regular` ⇒ `formLayout` 1 例 FAILED；`HomeDock` 忽略 `tile` ⇒ `home-dock` 1 例 FAILED。

**诚实边界**：①**"100% 对齐 macOS"字面上不可能也不该做**——菜单栏、Dock、窗口圆角与红绿灯属于**宿主**，这个应用是 macOS 里的一个窗口；本轮做的是"**窗口里不再出现 Mac 上不存在的像素**"，不是"把 macOS 重画一遍"；②桌面**状态行本身保留**（它显示 AmOS 自己的设备状态，且窗口已最大化）——"连它一起去掉（时间与菜单栏重复）"是另一个**可见决定**，未做、登记为候选；③pitch/pad/chrome 三个常量是**本仓的设计常量**（不是对 Apple Launchpad 的实测），测试钉的是规则的**形状** + 本机那个桌面上的**数字**；④桌面**侧栏/菜单栏镜像**仍未做（壳层没有 per-app 导航模型，编一个假目录比不做更糟）；⑤真机证据止于**渲染事实**（像素/几何/列数）：大图标的**观感**（80 px 在 183 px 列距里是否"够 Mac"）、Dock 磁吸放大在大图标下的手感、浅/暗两套主题下的对比度**仍属肉眼复核**（`docs/UI_APPLE_HIG_AUDIT.md` §7）；⑥真机验证走的是 **debug 二进制 + vite dev**（与 `make app-open` 的 `.app` 是两条链路），本轮没有重新打 `.app`。

- **接管说明（2026-09-15，REQ-A250 记录）**：**桌面类别的「内容」现在由另一套桌面壳渲染** —— `frontend-ts/src/svelte/DesktopShell.svelte`（+ `TopBar` / `Launchpad` / `Dock` / `SpotlightOverlay` / `MissionControl`）与它自己的几何模块 `frontend-ts/src/lib/desktopLayout.ts`，设计记录见 `docs/PC_DESKTOP_ARCHITECTURE.md`；`Shell.svelte` 现在在 launcher 分支**之前**判 `form === "desktop"` 并交给它。因此上一条（REQ-A249）里的桌面**几何**部分（`homeGrid` 的 desktop 分支、`homeTile` 的 `large`）在桌面上**已不可达**（只剩单测在跑，属本仓明令最忌的"defined + tested + 无生产调用点"），而**同一个类别现在有两套数字**：`desktopLayout.ts` 的 `LAUNCHPAD_COLS_DEFAULT=8` / `LAUNCHPAD_ROWS_DEFAULT=5` / `LAUNCHPAD_ICON_SIZE=80` / `DOCK_ICON_SIZE=56` 与本文在 1496×882 上算出的 **8×4** / 80 px 栅格图标 / **76 px** Dock 图标（列数与栅格图标恰好一致，**行数与 Dock 图标不一致**）。**处置登记（未擅自取舍）**：谁拥有桌面启动器几何必须由落地方决定——要么把「由实测窗口推导 + 双向夹紧（不低于手机 / 巨屏封顶）+ 未测量 ⇒ 最保守」这条规则搬进 `desktopLayout.ts`（并让本文的 desktop 分支与测试退场），要么反过来；**在此之前两条并存本身就是缺陷**。REQ-A249 中**仍然活着**的部分：`deviceChrome`（`dynamicIsland`/`homeIndicator` 对 phone/tablet 生效，桌面路径已不渲染 `StatusBar`）与 `homeTile`/`homeGrid` 的手机/平板行为（逐字节不变）。


## 2. 窗口状态机（Z-index / show / hide / focus）

已实现为独立、传输无关的 crate **`amos-wm`**（`crates/amos-wm`），纯逻辑、可单测：

- `WindowKind`：`Launcher`（唯一、不可销毁、永远在栈底）/ `App` / `System`
- `WindowState`：`Hidden / Shown / Focused`（同一时刻至多一个 `Focused`）
- 操作：`register / open / focus / hide / close / home`
- 每次操作返回 `Vec<WmEvent>`，由 `amos-tauri` 适配层映射到真实的
  `WebviewWindow::show() / hide() / set_focus()`，并同步给 UI。

关键规则（已被 9 个单测覆盖）：
- 打开 App → 旧焦点降级为 `Shown`，新窗口 `Focused`，Z 序置顶
- 隐藏/关闭当前焦点 → 焦点回退到最近使用的前一个窗口（recent 栈）
- `home()` → 聚焦 Launcher
- Launcher 不可 hide/close

`amos-tauri` 接入示例（后续落地）：
```rust
// 适配层：WmEvent -> 真实窗口
fn apply(&mut self, e: WmEvent) {
    match e {
        WmEvent::Shown(id)      => { self.windows[&id].show().ok(); }
        WmEvent::Hidden(id)     => { self.windows[&id].hide().ok(); }
        WmEvent::FocusChanged(Some(id)) => self.windows[&id].set_focus().ok(),
        WmEvent::FocusChanged(None)     => self.windows[&launcher].set_focus().ok(),
        WmEvent::Created(id)    => self.create_real_window(id),
        WmEvent::Closed(id)     => { /* destroy real window */ }
    }
}
```

## 3. 多窗口 AI 上下文共享（核心难题之一）

场景：用户在 **App A（浏览器）** 选中一段文字，希望后台的统一后端把它作为上下文，
喂给正在 **App B（AI 助手）** 运行的 Agent。

### 方案：System-Wide Clipboard/Selection → Rust 统一上下文 → gRPC 注入

1. **捕获**：App A 前端把选中的文本通过 Tauri command 上抛（或系统级剪贴板
   `ClipboardManager` 读取），携带来源 `windowId`。
2. **汇聚**：Rust 统一后端维护一个「系统上下文」缓冲区
   `SystemContext { source_window, text, ts }`（存在共享 `State`）。
3. **注入**：App B 发起 `ask_ai_agent` 时，后端把 `SystemContext` 合并进
   `AgentRequest.context` 的 map 字段（proto 已支持 `map<string,string>`），
   再经同一条 gRPC 管道发给 `amos-ai`：
   ```rust
   let mut req = AgentRequest { prompt, ..Default::default() };
   if let Some(ctx) = system_context.take_for(&target_window) {
       req.context.insert("system_selection".into(), ctx.text);
   }
   client.stream_chat(req).await?;
   ```
4. **权限**：上下文传递走 Rust 层，可加「信任窗口」白名单，避免任意 App 偷读。

> 这正好发挥已有 `AgentRequest.context`（`map<string,string>`）与「统一 gRPC 管道」
> 的架构红利——无需新协议，只是把上下文从「单窗口内直接读」改为「多窗口经后端注入」。

### 3.5 实现状态（已落地，2026-09-05）

> 该方案已落地为 `crates/amos-tauri/src/clipboard.rs` 的**全局剪贴板服务**
> `GlobalClipboard`（多格式 `ClipboardPayload`：`text/html/image/uris`；有界历史
> `HISTORY_LIMIT=32`、seq 单调、同内容合并）。配套：
>
> * 命令 `clipboard_write / clipboard_read / clipboard_history / clipboard_clear`，
>   已注册进 `lib.rs` 并托管 `Arc<GlobalClipboard>`；
> * **前台读取权限** `require_foreground`：paste/history/clear 仅允许当前焦点窗口
>   （对照 `WmState`），后台窗口可写不可偷读（OS 剪贴板隐私规则）；
> * 写后广播 `clipboard-changed`；TS 封装 `frontend-ts/src/lib/clipboard.ts`；
>   广播仅发**元数据通知 `ClipboardNotice`**（seq/时间/来源），不含内容——后台窗口
>   无法靠订阅拿到正文，真正粘贴走前台校验的 `clipboard_read(seq)`；
> * **历史浮层 UI**：`frontend-ts/src/components/ClipboardTray.tsx`——`clipboardHistory`
>   列出最近条目、每次 `clipboard-changed` 通知自动重取、点按把前台 `clipboardRead`
>   到的条目回填粘贴；Notes 编辑器已接 **⧉ 复制 / 📋 粘贴 / 🕘 历史浮层**（共 6 项
>   前端单测：3 纯逻辑 + 3 DOM）；
> * **Android 容器桥**：`clipboard_glue.rs`（feature `android`，JNI）+
>   `ClipboardGlue.kt`（`attach`/`pushTextClipboard`/`onContainerCopy`）把
>   Webview↔容器双向打通（容器桥为真机 bring-up，Rust 侧已 compile-check）。
>
> AI 侧做了**兼容回退**：`ai_bridge::ask_ai_agent / chat_agent` 仍优先注入指向本
> 窗口的 `SystemContext` 条目；无该条目时回退取全局剪贴板最新文本，均落在
> `AgentRequest.context["system_selection"]`，协议不变。原 `SystemContext` 保留
> 为“选区→AI”的定向通道，与全局剪贴板并行。

## 4. 落地步骤（建议顺序）

1. ✅ **窗口状态机**：`amos-wm` 已建（可单测；`register` 现在也会发出 `Created` 事件，适配层可据此创建真实窗口）。
2. ✅ **Tauri 适配层**：`crates/amos-tauri/src/wm.rs` 用 `tauri::WebviewWindow` 实现
   `apply(&WmEvent)`，Launcher（label `main`）为主窗口，App 窗口按需创建/复用；
   已暴露命令 `wm_open / wm_focus / wm_hide / wm_close / wm_home / wm_windows`。
   设置应用内置「窗口管理器 (调试)」卡片（**REQ-A225 重新落位**：在当前 Svelte 壳里它是
   设置 →「窗口与形态」页的底部卡片，旧 React 宿主里的那一版已随宿主一起移除），
   列出 `wm_windows` 快照：`label [kind] state`，聚焦窗口标 `←聚焦`、容器合成表面
   （无 WebView 的 `legacy:<window_id>`）标 `外部表面`；随 `layout-changed` 自动重读，
   并有「刷新」按钮（`docs/gui-verify.md` A4 / `docs/android-compat.md` W4 就靠它）。
3. ✅ **共享存储下沉**：新增 `crates/amos-tauri/src/store.rs` 的 `SharedStore`
   (Rust `State`),设置/通知写入时**透写**镜像到 Rust 并广播 `store-updated` 事件。
   **当前 Svelte shell 的真实接线**：写路径 = `lib/amosStore.writeStoreValue`
   → `lib/backend.systemStoreSet`（`store_set`；`lib/themeCore.writeStored` 与
   `svelte/locale.svelte.setLocale` 共用同一条）；读路径 = `svelte/store.ts`
   `createStoreValue` 订阅 `store-updated` 并应用 `{key,value}`。每个窗口启动时
   `shell-entry.ts` 的 `boot()` `await hydrateFromSystemStore()` 拉取
   `store_snapshot` 覆盖本地缓存(Rust 对 store 管理的键是**权威真源**),其他窗口收到
   事件后刷新本地缓存与 UI,实现跨窗口状态同步(localStorage 仍作为同步缓存与
   headless 测试回退)。历史迁移期文档写的 `core.js` `storeWrite/storeRemove/…`
   属于早期 vanilla 实现，且其中的 `window.Amos.storeWrite` 桥**从未被任何一方提供**
   （写透静默失效，REQ-A101 已修）；下文 `core.js` / `main.js` 均指该历史实现。
4. ✅ **AI 上下文共享**：`SystemContext`（`wm.rs`）+ `ask_ai_agent`/`chat_agent` 注入
   `AgentRequest.context["system_selection"]`；命令 `system_set_context` /
   `system_clear_context` / `system_peek_context`。注意：注入默认面向 label `ai` 的窗口。
   **前端接线**（2026-09-12, REQ-A100）：`svelte/appLinks.sendToAi(source, text)`
   （备忘录编辑工具条的「✦ 发送到 AI」）调 `system_set_context` 并切到 AI 屏；
   `AiApp` 挂载时与每次发送后用 `system_peek_context` 显示/清除「已附加系统上下文」提示
   （`AI_TARGET_WINDOW = "ai"` 与 `sendChat` 的 `targetWindow` 单一常量，杜绝漂移）。
   在此之前这三个命令**没有任何前端调用点**，D1/D2 描述的流程在当前 Svelte UI 中不可执行。
5. ✅ **后端路由**：前端由「路由切换视图」改为「`invoke('wm_open', appId)`」，由
   `WindowManager` 决定 open/focus/hide。Rust 命令 `wm_open/wm_home/...` 已就绪；
   前端 `core.js` 新增 `openApp()/systemHome()/routeFromUrl()`：启动器图标走
   `wm_open`(新建 `#window=<id>` 窗口),App 窗口按 URL 片段自动渲染对应应用;
   无 Tauri 环境自动回退到原 SPA 路由(既有 bun 测试保持通过)。

## 5. 跨窗口状态同步(端到端示例)

所有窗口共享同一个 `amos-tauri` 进程、同一条 gRPC 管道;状态通过 `SharedStore`
(Rust `State`)作为**跨窗口总线**收敛。下面是「设置窗口改 WiFi → 启动器通知中心
快速开关实时更新」的完整链路(**当前 Svelte shell 的真实实现**)：

```
[ 设置窗口 (WebView) ]
  用户切 WiFi 开关
    │  设置页 → lib/amosStore.writeStoreValue("amos.settings", {...wifi:true})
    │    ├─ localStorage.setItem(key, json)          ← 本窗口即时真源 + headless 测试回退
    │    └─ void lib/backend.systemStoreSet(key, json)
    │         └─ invoke("store_set", {key, value})   ← 透写(fire-and-forget;失败不阻断写)
    │          （lib/themeCore.writeStored / svelte/locale.svelte.setLocale 走同一条）
    ▼
[ Rust SharedStore (crates/amos-tauri/src/store.rs) ]
  SharedStore::set() → 写内存 + app.emit("store-updated", {key, value})
    │
    ▼ (广播给所有窗口)
[ 启动器窗口 (WebView) ]
  svelte/store.ts createStoreValue(key) 已订阅 subscribe("store-updated", …)
    ├─ value == null → localStorage.removeItem(key); set(fallback)   ← 删除分支
    └─ 否则 JSON.parse(value) → localStorage.setItem(key, value); set(parsed)
       （同窗口另有 STORE_CHANGED_EVENT、跨标签页 "storage" 两条刷新路径）
```

> 现状(**已接线的多窗口 shell**)：**写路径**(`store_set`)与**读路径**(`store-updated`
> 订阅 + `store_snapshot` 水合)都是真实命令,而且**广播现在真的有第二个接收者**了:
> 桌面形态下每个 app 都是自己的 `WebviewWindow`(`DesktopShell` + `Dock`/`Launchpad`/
> `Spotlight` 都走 `wm_open`),所以「设置窗口改 WiFi ⇒ 启动器通知中心实时更新」这条
> 链路是两个真实窗口之间的。
>
> **本节曾经是陈旧的**(REQ-A254 更正):它写着「`wm_*` 尚未接线、跨窗口广播暂时没有
> 第二个接收者」,而那时 `wm_open`/`wm_focus` 早已被生产代码调用——`scripts/
> tauri-command-allowlist.json` 里那两条为它们写的"无消费者"理由也一直挂着,直到
> `scripts/tauri-command-scan.mjs` 自己把它们报成 *stale*(门禁比文档先发现)。
> 历史版本里 `writeStoreValue` 镜像到一条**从未被注入**的 `window.Amos.storeWrite`
> 桥，写透静默失效、而水合仍会用陈旧快照覆盖 localStorage(REQ-A101 已修)。

**新窗口打开时(水合)**：
```
[ 任意窗口启动 ]
  shell-entry.ts boot(): await hydrateFromSystemStore()
    └─ lib/amosStore.hydrateFromSystemStore()
       └─ invoke("store_snapshot") → 把 Rust 当前全部键写回 localStorage
          → 即使该窗口之前从未见过这些键,也能拿到其他窗口已写入的权威状态
```

**参与方一览**

| 层 | 组件 | 职责 |
|---|---|---|
| Rust | `store.rs` `SharedStore` | 权威真源 + `store-updated` 广播 |
| Rust | 命令 `store_get/set/remove/snapshot` | 前端访问入口（`get`/`remove` 目前无 UI 消费者，属允许清单，见 `scripts/tauri-command-allowlist.json`） |
| 前端 | `lib/amosStore.writeStoreValue` → `lib/backend.systemStoreSet` | 写路径: 本地缓存 + 透写 Rust（`store_set`） |
| 前端 | `lib/themeCore.writeStored` / `svelte/locale.svelte.setLocale` | 主题 / 语言键走同一条透写 |
| 前端 | `svelte/store.ts` `createStoreValue` | 订阅 `store-updated`（+ 同窗口 `STORE_CHANGED_EVENT` / 跨标签 `storage`）并应用远端变更，含 `value == null` 删除分支 |
| 前端 | `lib/amosStore.hydrateFromSystemStore`（`shell-entry.ts` `boot()`） | 启动水合（`store_snapshot`） |
| 数据 | `amos.settings` `amos.notifications` `amos.home.layout` `amos.notes` `amos.wifi` … | 已纳入 store 的键（写路径统一经 `writeStoreValue` 透写） |

> 说明：`localStorage` 保留为同步缓存与 headless 测试回退；Rust `SharedStore`
> 对上述键是权威真源(每次启动水合覆盖本地)。若要把某个键移出 store,只需把对应
> 写路径从 `writeStoreValue` 改回直接 `localStorage.setItem` 即可。


## 6. 桌面形态的完整壳层（macOS-aligned Shell）

> 详细架构 / 接线表 / 边界见 [`docs/PC_DESKTOP_ARCHITECTURE.md`](./PC_DESKTOP_ARCHITECTURE.md)；
> 完整审计与候选清单见 [`docs/PC_DESKTOP_AUDIT.md`](./PC_DESKTOP_AUDIT.md)。本节是
> 在多窗口上下文里的**衔接点**。

### 6.1 为什么桌面形态需要一张不同的壳

`Shell.svelte` 在 `form === "desktop"` 走原 phone/tablet 渲染时，窗口里只剩"被放大的
手机主屏"。`PC_DESKTOP_AUDIT.md` 已经把 macOS 桌面**不应出现**的像素挑出来（Dynamic
Island、home indicator、手机密度的主屏），但**桌面形态本身**需要的那些 macOS 元素
（顶栏 / Dock / 启动台 / Spotlight / Mission Control / 多窗口舞台）**从未被实现**。

本节实现的是：**宿主为桌面形态放行后，应用层终于有人接**。

### 6.2 `DesktopShell` 与分流

`Shell.svelte` 仅在 `{#if isDesktop && !isExternalApp}` 分支挂载 `DesktopShell.svelte`
（其余形态走原 phone/tablet 路径，**逐字节不变**）。`DesktopShell` 是窗口内的
**macOS 桌面壳**，独占渲染：

| 层 | 组件 | 职责 |
|---|---|---|
| 顶 | `TopBar.svelte` | 左侧 Apple 菜单 + 中间当前 app 名（读共享 store 的 `amos.app_focused`）+ 右侧状态组（时间 / Spotlight / Launchpad / 通知）+ 键盘 `⌘Space` / `F4` 触发器 |
| 底 | `Dock.svelte` | 启动台（开 Launchpad）+ 已固定 app + 运行中 app + `dockIconScale` 鼠标悬停放大 |
| 中 | 舞台（`DesktopShell` 内联） | 多窗口容器：每个 `WebviewWindow` 对应一个 app；Tauri 多窗口已在第 5 节落地 |
| 覆盖 | `Launchpad` / `SpotlightOverlay` / `MissionControl` | 全屏或中心覆盖层；由 `DesktopShell` 协调键盘与生命周期 |

### 6.3 多窗口 app 启动的 `#window=` 片段

`wm.rs::apply()` 在 `WmEvent::Created` 分支对**非 launcher 窗口**改用
`WebviewUrl::App(format!("{APP_ENTRY}#window={label}"))` 启动；`windowRoute.ts`
已有的 `#window=<label>` 解析路径据此把新窗口**直接进入该 app**，而不是显示 launcher。
`DesktopShell` 因此能正确地把"开 app"映射为"开一个属于该 app 的多窗口舞台成员"。

### 6.4 当前 app 的焦点同步

`SharedStore` 已知键列表新增 `APP_FOCUSED_KEY = "amos.app_focused"`；`wm.rs::apply()` 在
`WmEvent::FocusChanged(Some(id))` 分支（外源焦点变化已过滤）**写该键**，由 `SharedStore::set`
已有的 `store-updated` 广播送达每个窗口。`TopBar` 用 `createStoreValue(APP_FOCUSED_KEY)`
订阅它、更新中间区域显示的 app 名 —— 与"System UI 写设置、桌面读设置"是同一条模型。

> **只保留一条通道**（REQ-A254 更正）：这里原本**同时**发一条专用事件
> `APP_FOCUSED_EVENT = "app-focused-changed"`，而前端从第一天起就**故意**只读 store
> （`lib/wm.ts` 的注释写着理由）。`scripts/tauri-event-scan.mjs` 因此把它报成
> *emitted by the host but no screen subscribes to it*——一个「发出去没人听」的事件正是本仓
> 最忌讳的形状，于是本轮**删掉了这条事件**（连同 `store.rs` 里的常量），只留 store 这一条真源。

### 6.5 真机候选（本节未做、登记给下一轮）

- 顶栏玻璃感 / Dock 磁吸曲线 / Launchpad 翻页 / Spotlight 模糊背景——肉眼复核项
- 桌面形态的**状态行去留**（与 macOS 系统菜单栏重复）
- **per-app 菜单模型**（顶栏当前只显示 app 名，菜单项需 app 注册）
- Tauri 多窗口在桌面形态下的端到端真机 e2e（开窗 → Dock 出现运行指示 → 切焦点 → 顶栏 app 名变化）

### 6.6 形态策略**已经落地到窗口层**（G5 收口，REQ-A257）

上一节登记时，`LayoutPolicy` 的 `multi_window` / `free_resize` / `min_pane` 只被 `snapshot()`
（给设置页看）与分屏数学消费，`Bounds::enforce_min` / `clamp_into` 更是**零生产调用点**。
现在三条规则都落在真实窗口上，而且**每条只有一个实现处**：

| 规则 | 唯一实现处 | 宿主怎么用 |
|---|---|---|
| **该类最多几个 app 窗口**（`multi_window`） | `amos_wm::form::LayoutPolicy::check_app_window(open)` → `AppWindowRefusal { form, open }`（`Display` 给出可执行的一句话：类别 + 已有几个） | `WmState::check_new_app_window()` 同时服务生产路径 `open()` 与测试缝 `register_app()`。**在注册之前**问：被拒的窗口在模型里**不留任何痕迹**（早先的写法是"先注册再拒绝"，于是状态机留下一个没有真实窗口在身后的 app 窗口——正是 REQ-A227 那类形状） |
| **新窗口的几何** | `LayoutPolicy::initial_window_in(screen)`：`initial_window` → `enforce_min(min_pane)`（不能小于本类自己的最小窗格）→ 按 `screen` 封顶 → `clamp_into(screen)`（屏幕是物理事实，比 `min_pane` 权威：屏幕更小时屏幕赢） | `apply()` 的 `Created` 分支用它算 `inner_size`（1024×720 的桌面 slab 不会再挂到小屏外） |
| **可自由缩放 / 最小尺寸** | `LayoutPolicy::{free_resize, min_pane}` | 建窗时 `.resizable(policy.free_resize)` + `.min_inner_size(policy.min_pane)`；分屏落位前再跑一次 `Bounds::enforce_min(policy.min_pane)`（REQ-A256） |

`enforce_min` 与 `clamp_into` 从此都在生产路径上（并被 `form.rs` 的领域单测与 `wm.rs` 的宿主单测
两端钉住），`amos-wm/src/layout.rs` 的 `right`/`bottom`/`enforce_min`/`clamp_into` 一并改为
`const fn`（`Ord::max` 尚未 const 稳定，故用 `at_least()` 写显式比较），使整条策略算术保持编译期。

**屏幕变小会把窗口拉回来**（`WmState::reclamp_windows`，REQ-A257）：宿主在每次**真实**屏幕变化后
（`lib.rs` 的 `Resized` 事件路径，`sync_from_pixels` 确认变化之后）读**平台上的真实几何**
（`outer_position` / `inner_size` / `scale_factor`），按同一条领域规则
（`LayoutPolicy::fit_window`：不低于 `min_pane`、不超过屏幕、完全落在屏幕内）算出目标矩形，
**只对真正需要动的窗口**下发 `set_position`/`set_size`，并统计移动了几个。

- **不维护 per-window 账本**：用户自己会拖动/缩放窗口，宿主记的矩形从那一刻起就是第二真源。
  平台读数**本来就是对的**，这是"少一份状态、少一处漂移"的选择。
- **不动的东西**：Launcher（它就是屏幕）、外部容器表面（几何归容器）、隐藏窗口（屏幕上没有它）、
  以及**读不出来的几何**（NaN/超界）——后者**计数并 `warn!`**，不猜一个位置。
- 屏幕上已经放好的窗口（且在最小尺寸之上）**一次调用都不会发生**——否则每次 resize 都在
  和用户抢窗口。这条由 `reclamp_target` 的纯函数测试钉住（7 种情形：内部/边界/越界/负原点/
  过小/过大/屏幕比最小值还小）。

另外：手机上的第二次 `wm_open` 现在会拿到具名拒绝（"form factor 'phone' does not allow
multiple app windows …"），而手机自己的壳走的是单窗口 SPA 路由，不会走到那里。
**仍未做**：真机观感复核（把桌面壳拉小、看窗口是否被拉回）——属设备/肉眼项。

## 7. 相关文档

- [`PC_DESKTOP_ARCHITECTURE.md`](./PC_DESKTOP_ARCHITECTURE.md) —— 桌面壳层的架构与数据流。
- [`PC_DESKTOP_AUDIT.md`](./PC_DESKTOP_AUDIT.md) —— 桌面形态审计（注意 §3.2 的 P0-2 已被
  REQ-A250 的实现推翻：启动器**已经**走 `wm_open`、`#window=<label>` **已经**由宿主生成）。
- [`DESKTOP_ECOSYSTEM_GAP_AUDIT.md`](./DESKTOP_ECOSYSTEM_GAP_AUDIT.md) —— 与 FydeOS 的生态对照
  与逐条取证（含 G1–G7 未做清单）。
- [`desktop-native-apps.md`](./desktop-native-apps.md) —— 桌面原生应用（Wine / XDG）这一层。
- [`input-method.md`](./input-method.md) —— 输入法与多窗口的相互作用：**一个引擎、每窗口一条缓冲**
  （REQ-A258 收口，原「进程级单会话」缺口）。

