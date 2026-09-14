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
- **形态必须落到「内容」上，否则平板只是"更大的手机"（REQ-A234，用户诉求驱动）**：`LayoutPolicy` 决定的是**窗口**能做什么（`multi_window` / `free_resize` / `divider_gap` / `columns`），但"这个类别里**内容**怎么排"是另一件事，此前**无人处理**：`HomeDock.svelte` 把 `per = 12`（4 列 × 3 行）与 `grid-cols-4` 写死，于是 900×1200 的平板窗口里仍是手机密度（iPadOS 竖屏 **4×6=24**、横屏 **6×4=24**），而 `Shell.svelte` **从不读形态**——壳层里没有"我是平板"这个概念。补全落在 `frontend-ts/src/lib/formLayout.ts`（纯函数，仿本 crate 的纪律）：`homeGrid(form, width, height)` —— **phone/robot/desktop 与"未测量屏幕"一律保持 4×3（phon​e 字节级不变）**，平板按 iPadOS 密度，正方形按竖屏（与 `split_axis` 同规则），`0`/NaN/∞ 的未测量屏幕**降级为手机栅格**（镜像 `columns_for(0) == 1` 的"未测量 ⇒ 最保守"）；`pageCapacity(grid)` 是"每页几个"的唯一答案。宿主权威的流向不变量不变：**类别只来自宿主**——`Shell.svelte` 读 `wmLayoutSnapshot` 一次并跟随 `layout-changed` 推送，**绝不从 WebView 宽度猜类别**；通道载荷里没有 `grid` 时降级为手机栅格（能力不因缺失载荷而被"获得"）。渲染侧用**内联 `grid-template-columns`**（Tailwind 会 purge 动态类名），`data-cols`/`data-rows` 是它的可测证据。**诚实边界**：①`desktop` **刻意排除**（它的窗口已是可自由缩放的 OS 窗口，REQ-A233 已与桌面对齐；改桌面启动器密度是另一件事，测试里明确钉住）；②本轮**没有做** iPad 式**侧栏**：壳层没有 per-app 导航模型，编一个假目录比不做更糟；③这是**内容**几何，不是分屏——分屏入口仍不可达（见 §1.5 上文 `wm_open` 无消费者）。
- **应用窗口必须以「自己的 app」开屏（REQ-A234）**：宿主创建每个应用窗口时用的是 `index.html#window=<label>`，注释写着 "so the boot script auto-navigates to that app's screen"（`crates/amos-tauri/src/wm.rs` 的 `WmEvent::Created` 分支），但**前端从未读过该 fragment**（`shell-entry.ts` 只认 `?surface=`）⇒ 每个应用窗口、以及**分屏的每个窗格**都显示**启动器**：`multi_window`（"两个 app 并排"是平板类别 `LayoutPolicy` 的全部意义）即便分屏成功，屏幕上也只是两份首页。补全：纯函数 `frontend-ts/src/lib/windowRoute.ts::appIdFromHash(hash)` —— 内置 app（`APP_META`）或 `store:<manifest.id>` 瓦片 ⇒ 该 id；**其余（含畸形 fragment、`legacy:*` 容器面、窗口 id、大小写不同）一律 `null`，绝不猜**（与 `FormFactor::parse` 的"unknown → None"同一条规则）；`shell-entry.ts` 在 `?surface=`（无头验收路径）之后调用它。**不复制** Rust 的 `LAUNCHER_LABEL`：启动器窗口本来就不带 fragment，且 `main` 不是任何 app id——多一份会漂移的常量换不到任何行为。
- **PC 窗口与桌面对齐 = "最大化"，而不是猜一个尺寸（REQ-A233，用户诉求驱动）**：用户要求"PC 窗口的界面与苹果电脑的桌面对齐，100% 对齐"。实测现状：桌面（Finder `window of desktop`）**1496×967**，而壳窗口是**固定 1024×720 放在 (508,45)**——**右边缘 1532 越出桌面**、只覆盖约一半面积。根因落在**领域规则**上：`LayoutPolicy::initial_window` 是**类别事实**（"PC 的窗口默认多大"），它**根本不知道**屏幕/菜单栏/Dock 能给出多少"可用区"，于是宿主只能照抄一个数字。补全：把该决策从"给一个 `Size`"升级为 `ShellFit{Leave|Resize(Size)|Maximize}`——**phone/robot ⇒ Leave**（手机本就是默认、无 UI 类别不碰几何）、**tablet ⇒ Resize(900×1200)**（真平板就是这个形状）、**desktop ⇒ Maximize**（PC 的壳**属于**它运行的那块桌面：**可用区由平台决定**——菜单栏、Dock、刘海——所以这里必须是"最大化"，而不是本 crate 自己猜一个尺寸，猜尺寸正是壳曾是"越出桌面右边的板子"的原因）。宿主侧：`shell_resize_reading` → `shell_fit_reading`（返回 `(was, ShellFit)`），`fit_shell_window` 对 `Maximize` 走 `window_maximize`、对 `Resize` 走 `set_size`（**只有精确请求才登记 REQ-A230 的"兑现/未兑现"比对**；最大化没有精确尺寸可比，实测报告可用区，**不多说一句**）。**实机实测（同一台 Mac）**：请求日志 `requested a desktop-aligned (maximized) shell window … was_width=480 was_height=820` → 实测 **`width=1496 height=881 scale=2.0 columns=4`**；窗口矩形 **`(0,29,1496,882)`** vs 桌面 `(0,0,1496,967)` ⇒ **x 相同、宽度 100.0%、右边缘齐平、上边贴菜单栏、下边贴 Dock**；内容侧 **10 010 种颜色、四条边缘都不是单色**（没有 letterbox/留白）⇒ 内容**边到边填满**窗口。对照：改动前是 `(508,45,1024,720)`。**诚实边界**：①`Maximize` 用的是平台的"缩放/最大化"语义（macOS 的绿键行为），**不**保证覆盖菜单栏/Dock（那才叫 fullscreen，是另一种模式）；②`columns` 因此从 3 变成 **4**（桌面策略上限），这是"对齐"的正确后果，不是回归；③平板/手机/机器人路径未被本改动影响（各自 `Resize`/`Leave`，手机字节级不变）。

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

> 现状(单窗口 Svelte shell)：**写路径**(`store_set`)与**读路径**(`store-updated`
> 订阅 + `store_snapshot` 水合)都已是真实命令;但当前 shell 一次只挂一个 app 屏
> (`wm_*` 尚未接线)，所以跨窗口**广播**暂时没有第二个接收者——**落盘副本**
> (水合来源)是真实的。历史版本里 `writeStoreValue` 镜像到一条**从未被注入**的
> `window.Amos.storeWrite` 桥，写透静默失效、而水合仍会用陈旧快照覆盖
> localStorage(REQ-A101 已修)。

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

