# G5 形态策略强制实施报告

> **REQ-A256**: 形态策略从"仅上报"改为"真正强制执行"
> 
> 日期: 2026-09-15  
> 状态: ✅ **已完成**  
> 优先级: 中（航空航天纪律：约束必须被验证）

---

## 1. 问题陈述

### 1.1 审计发现（来自 `docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` §G5）

**现状**：
- ✅ `LayoutPolicy` 已定义三个约束：`multi_window`、`free_resize`、`min_pane`
- ✅ 纯函数已存在：`Bounds::enforce_min`、`Bounds::clamp_into`
- ❌ **窗口层不遵守**：零生产调用点（`grep -rn 'enforce_min\|clamp_into' crates/ --include='*.rs'` 只命中自身与其测试）
- ❌ `WmState::open` 不检查 `multi_window`

**影响**：
- 手机形态（`multi_window=false`）可以打开多个 app 窗口 → 违反策略语义
- 桌面/平板窗口没有 `resizable()` / `min_inner_size()` → 用户可以缩放到策略禁止的尺寸
- 分屏窗格不遵守 `min_pane` → 可能出现无法使用的微小窗格

---

## 2. 设计原则（DO-178C 对齐）

| 航空航天原则 | 本设计的体现 |
|---|---|
| **强制约束** | 策略在窗口创建时强制执行，不符合时拒绝（诚实错误） |
| **可验证性** | 每条约束都有单元测试验证 |
| **明确失败** | `multi_window=false` 时尝试打开第二个窗口 → 返回 `Err` 并说明原因 |
| **纯函数优先** | `enforce_min` / `clamp_into` 是纯函数，在 `amos-wm` crate 中有独立测试 |
| **单一真源** | `LayoutPolicy::of(form)` 是策略唯一来源，编译期确定 |

---

## 3. 实施内容

> ⚠️ **本节记录的是 REQ-A256 的原始实现**（"把策略强制到真实窗口"的主体）。它对了两件事的
> **位置**（`apply()` 的 `Created` 分支、`register_app()`），但那正是**两处真缺陷**的所在：
> 先注册后拒绝、同一条规则写两遍。**机制、修法与测试表见 §11**；下面引用的 `wm.rs` 行号是
> 当时的值，已随后续改动漂移——**以 §11 与代码为准**。

### 3.1 多窗口策略强制（`multi_window`）

**位置**: `crates/amos-tauri/src/wm.rs:690-704`

```rust
// G5: enforce multi_window policy — if multi_window=false,
// refuse to open a second app window (REQ-A256).
if !policy.multi_window {
    let app_count = {
        let core = self.lock()?;
        core.kinds
            .values()
            .filter(|k| *k == &WindowKind::App.to_string())
            .count()
    };
    if app_count >= 1 {
        return Err(format!(
            "form factor '{}' does not allow multiple app windows \
             (multi_window=false); {} app window(s) already open",
            policy.form.as_str(),
            app_count
        ));
    }
}
```

**规则**：
- `multi_window=false` 的形态（Phone）只允许一个 app 窗口
- 尝试打开第二个窗口时返回 `Err`，消息包含：
  - 形态名称（`phone`）
  - 策略值（`multi_window=false`）
  - 当前已打开的窗口数

**应用点**：
1. `WmState::apply` 中的 `WmEvent::Created` 分支（真实窗口创建）
2. `WmState::register_app`（测试辅助函数）

### 3.2 自由缩放策略强制（`free_resize`）

**位置**: `crates/amos-tauri/src/wm.rs:717`

```rust
let mut builder = WebviewWindowBuilder::new(app, label.clone(), url)
    .title(app_window_title(&label))
    .inner_size(f64::from(policy.initial_window.width), f64::from(policy.initial_window.height))
    .resizable(policy.free_resize) // G5: enforce free_resize policy
    .min_inner_size(f64::from(policy.min_pane.width), f64::from(policy.min_pane.height)); // G5: enforce min_pane
```

**规则**：
- `free_resize=false` 的形态（Phone、Tablet）的窗口设置 `.resizable(false)` → 用户无法拖动窗口边缘
- `free_resize=true` 的形态（Desktop）设置 `.resizable(true)` → 用户可以自由缩放

**策略值**（来自 `amos-wm/src/form.rs:LayoutPolicy::of`）：
- Phone: `free_resize=false`
- Tablet: `free_resize=false`（触摸设备无拖动缩放交互）
- Desktop: `free_resize=true`

### 3.3 最小窗格策略强制（`min_pane`）

**位置 1**: 窗口创建时（`wm.rs:718`）

```rust
.min_inner_size(f64::from(policy.min_pane.width), f64::from(policy.min_pane.height))
```

→ Tauri 原生约束：用户无法将窗口缩小到此尺寸以下

**位置 2**: 分屏布局应用到真实窗口时（`wm.rs:1163-1166`）

```rust
// G5: enforce minimum pane size (REQ-A256)
let bounds = amos_wm::layout::Bounds::new(pane.x, pane.y, pane.width, pane.height);
let enforced = bounds.enforce_min(min_pane);
// 使用 enforced 而非原始 pane 尺寸设置窗口
```

→ 保证分屏计算出的窗格尺寸即使低于最小值，实际应用时也会被提升到最小值

**策略值**：
- Phone / Desktop: `min_pane = 360×480`
- Tablet: `min_pane = 320×480`

---

## 4. 测试覆盖

### 4.1 多窗口策略测试

| 测试用例 | 位置 | 验证内容 |
|---|---|---|
| `phone_form_factor_refuses_second_app_window` | `wm.rs:2790` | Phone 形态拒绝第二个 app 窗口，错误包含 `phone` / `multi_window=false` / 窗口计数 |
| `desktop_form_factor_allows_multiple_app_windows` | `wm.rs:2819` | Desktop 形态允许 3 个 app 窗口同时存在 |
| `tablet_form_factor_allows_multiple_app_windows` | `wm.rs:2838` | Tablet 形态允许 2 个 app 窗口同时存在 |

> 上面三条**都在测试缝 `register_app()` 上跑**——它与生产路径 `open()` 共用
> `check_new_app_window()`，所以"测试用的门"和"真门的门"是同一扇（§11.1）。

### 4.2 最小窗格策略测试

| 测试用例 | 位置 | 验证内容 |
|---|---|---|
| `enforce_min_is_applied_to_split_panes` | `wm.rs:2855` | `Bounds::enforce_min` 将小窗格提升到最小尺寸，大窗格不变，零尺寸被保护到至少 1×1 |
| `enforce_min_never_shrinks_below_minimum` | `amos-wm/src/layout.rs:233` | 纯函数测试：`enforce_min` 永不返回零尺寸窗口 |
| `clamp_into_keeps_a_window_on_screen` | `amos-wm/src/layout.rs:246` | 纯函数测试：`clamp_into` 将窗口移动到屏幕内（尺寸不变）|

**测试命令**：
```bash
# 所有 G5 相关测试
cargo test -p amos-tauri --lib wm::tests::phone_form_factor_refuses_second_app_window
cargo test -p amos-tauri --lib wm::tests::desktop_form_factor_allows_multiple_app_windows
cargo test -p amos-tauri --lib wm::tests::tablet_form_factor_allows_multiple_app_windows
cargo test -p amos-tauri --lib wm::tests::enforce_min_is_applied_to_split_panes

# 纯函数测试（amos-wm crate）
cargo test -p amos-wm --lib layout::tests::enforce_min_never_shrinks_below_minimum
cargo test -p amos-wm --lib layout::tests::clamp_into_keeps_a_window_on_screen
```

---

## 5. 影响面与兼容性

### 5.1 行为变化

| 场景 | 修复前 | 修复后 |
|---|---|---|
| Phone 形态打开第二个 app | ✅ 成功（违反策略） | ❌ 拒绝并返回错误 |
| Desktop 窗口用户尝试缩放 | ✅ 可以缩放到任意尺寸 | ✅ 可以缩放，但不低于 360×480 |
| Tablet 窗口用户尝试缩放 | ✅ 可以缩放（意外行为） | ❌ 窗口不可缩放（符合触摸设备语义）|
| 分屏窗格低于最小值 | ⚠️ 应用原始尺寸（可能无法使用）| ✅ 自动提升到最小值 |

### 5.2 兼容性保证

✅ **零破坏性变更**：
- Desktop / Tablet 在本修复前已经允许多窗口 → 行为不变
- Phone 在生产中只有一个主窗口（Shell） → 修复强化了已有语义，不影响正常流程
- 最小窗格策略是**新增保护**，不改变正常尺寸的窗口

⚠️ **潜在边界情况**（需人工验证）：
- 如果测试代码或脚本依赖"Phone 形态可以打开多个 app"的行为 → 需要改为 Desktop 形态
- 如果 Tablet 用户期望拖动缩放窗口 → 需要产品决策是否改为 `free_resize=true`

---

## 6. FMEA 更新

**新增失效模式**：

| ID | 失效模式 | 影响 | S | P | D | RPN | 当前缓解 | 测试保护 |
|----|----------|------|---|---|---|-----|-----------|----------|
| F-WM-014 | Phone 形态打开多个 app 窗口 | 布局混乱，与手机语义不符 | 3 | ~~4~~ → 1 | 2 | ~~24~~ → **6** | `multi_window=false` 在窗口创建时强制拒绝 | `phone_form_factor_refuses_second_app_window` |
| F-WM-015 | 分屏窗格尺寸低于可用值 | 用户无法点击或看清内容 | 3 | ~~3~~ → 1 | 2 | ~~18~~ → **6** | `enforce_min` 在应用布局时自动提升 | `enforce_min_is_applied_to_split_panes` |
| F-WM-016 | Tablet 窗口意外可缩放 | 触摸设备无缩放交互，行为意外 | 2 | ~~4~~ → 1 | 2 | ~~16~~ → **4** | `.resizable(policy.free_resize)` 强制应用 | （隐式：Tauri 原生行为）|

**RPN 降低**：所有策略违反场景从"中等风险"降至"可忽略"（< 20）

---

## 7. 文档更新

需要同步更新的文档：

1. **`docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` §G5**  
   - 将"缺口"改为"已完成"  
   - 更新证据：`grep -rn 'enforce_min' crates/ --include='*.rs'` 现在有 2 处生产调用点

2. **`docs/COMPLETION_SUMMARY.md`**  
   - 推荐下一步从 G5 改为 G1（输入法跨窗口共享会话）

3. **`docs/FMEA.md`**  
   - 添加 F-WM-014 / F-WM-015 / F-WM-016 三条新增失效模式

4. **`docs/multi-window.md` §策略强制**  
   - 新增章节说明策略在何处被强制执行

---

## 8. 验收标准（航空航天级）

| # | 判据 | 状态 |
|---|---|---|
| ✅ V1 | Phone 形态拒绝第二个 app 窗口 | 已测试通过（`phone_form_factor_refuses_second_app_window`；并在 §11 修正为"拒绝不留痕"）|
| ✅ V2 | Desktop 形态允许多个 app 窗口 | 已测试通过 |
| ✅ V3 | Tablet 形态允许多个 app 窗口 | 已测试通过 |
| ✅ V4 | 分屏窗格应用 `enforce_min` | 已测试通过 |
| ✅ V5 | 窗口创建时应用 `resizable()` | 代码审查通过（`wm.rs:875`，§11.3 复核）|
| ✅ V6 | 窗口创建时应用 `min_inner_size()` | 代码审查通过（`wm.rs:876-879`）|
| ✅ V7 | 所有修改通过 `clippy -D warnings` | **已实测**（REQ-A257）：`cargo clippy -p amos-wm -p amos-tauri --all-targets -- -D warnings` 干净 |
| ✅ V8 | 工作区测试全部通过 | **已实测**（REQ-A257）：`cargo test -p amos-wm` 46 + 2 e2e、`cargo test -p amos-tauri --lib` 341，0 failed |

---

## 9. 部署检查清单

- [x] 运行工作区测试：`cargo test -p amos-tauri --lib`（341 passed；`cargo test -p amos-wm` 46 + 2）
- [x] 运行 lint：`cargo clippy -p amos-tauri -p amos-wm --all-targets -- -D warnings`
- [ ] 手动验证 Desktop 形态可以打开多个 app
- [ ] 手动验证 Phone 形态只能打开一个 app
- [ ] 手动验证分屏布局的窗格尺寸合理（不会出现微小窗格）
- [x] 更新 `docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` §G5 状态
- [x] 更新 `docs/FMEA.md` 新增失效模式（F-WM-014/015/016 + REQ-A257 的 F-WM-017/018；
      机读 inventory 同步在 `scripts/fmea-gen.mjs`，`node scripts/fmea-gen.mjs --check` = EXIT 0）
- [x] 提交时引用 REQ-A256 / REQ-A257

---

## 10. 下一步推荐

按照航空航天级标准，继续补全缺口（按 RPN / 影响面排序）：

1. **G1 输入法跨窗口共享会话** - 影响：中，RPN: 中等（用户可感知）
2. **G3 系统级 IME** - 影响：大，需要新 APK + 真机验证
3. **G4 联想/下一词** - 影响：小，需要量二进制体积
4. **G2 PWA 远程 URL 启动** - 影响：大，需要新能力 + 安全评审
5. **G8 macOS 上的 Android 运行时** - 影响：大，产品决策（VM / 远程设备 / 如实为空）

**G5 已完成** ✅ — 策略从"仅上报"升级为"真正强制执行"，符合 DO-178C "约束必须被验证" 要求。

---

## 11. REQ-A257 复核：两处真缺陷与收口（2026-09-15）

对上一节（REQ-A256）的在建实现做对抗式复核时，**树的实测状态是红的**：
`cargo test -p amos-tauri --lib wm::` 报 `a_headless_class_refuses_to_split ... FAILED`。
顺着这条红查下去，落到两个真缺陷（都不是样式问题）：

### 11.1 「先注册、后拒绝」——拒绝会留下一个没有窗口在身后的 app 窗口

上一版的 `multi_window` 检查写在 `apply()` 的 `WmEvent::Created` 分支里。可**注册先发生**：
`open()` 已经把窗口写进 `core.wm` / `labels` / `by_label` / `kinds`，`apply()` 才去数
`kinds` 里的 app 窗口——**数到的是刚注册的那一个自己**。后果有两层：

1. 判定其实变成"某个 app 窗口都不能有"，数出来的 `1 app window(s) already open` 说的就是
   它自己；而在 `multi_window=false` 的类别上，除了空表以外**任何一次** app 开窗都会返回 `Err`；
2. 更糟的是**状态已经改了**：模型里留下一个 app 窗口（参与焦点/z 序、出现在 `wm_windows`）
   而屏幕上**没有**真实窗口——正是 REQ-A227 记录过的形状（"容器在跑、表面不在窗口管理器里"）。

**收口**：把问题提到注册**之前**，做成宿主的一个私有函数
`WmState::check_new_app_window(&WmCore) -> Result<(), String>`，被 `open()` 与测试缝
`register_app()` **共同调用**（一处实现，不会漂移）。被拒的窗口从此在模型里**不留痕**。

### 11.2 同一条规则写了两遍（且各数一遍）

上一版在 `register_app`（测试缝）与 `apply()`（生产）各写了一份
`!policy.multi_window && count(app) >= 1` 的判定，**两处各数一遍** `kinds`。两份判定意味着
两次漂移机会——本仓库反复出现的那个形状。

**收口**：判定下沉到领域，成为**纯函数**：

```rust
// amos-wm/src/form.rs
pub struct AppWindowRefusal { pub form: FormFactor, pub open: usize }   // Display = 可执行的一句话
impl LayoutPolicy {
    pub const fn check_app_window(self, open_app_windows: usize) -> Result<(), AppWindowRefusal>
    pub const fn initial_window_in(self, screen: Bounds) -> Bounds       // enforce_min → 屏幕封顶 → clamp_into
}
```

`AppWindowRefusal` 是**数据**不是字符串：宿主用 `Display` 得到操作员能照做的一句话
（类别 + 已有几个），而需要"自己决定"的调用方可以 `match`。宿主的 `app_window_count()` 也只剩
一处（并且明确**不含** Launcher 与外部容器表面——见 11.4 的测试）。

### 11.3 `initial_window_in`：把 `initial_window` 也纳入策略（顺带救活 `clamp_into`）

上一版只在建窗时用 `policy.initial_window` 原值。屏幕比它小时，一块 1024×720 的桌面 slab 会
**挂到屏幕外**。现在新窗口的几何由领域算：`initial_window` → **`enforce_min(min_pane)`**（不能小于
本类自己的最小窗格）→ **按 `screen` 封顶** → **`clamp_into(screen)`**（屏幕是物理事实：
屏幕比 `min_pane` 还小时**屏幕赢**）。三条规则连同权威顺序都写在函数文档里，并有领域单测
（大屏保偏好 / 小屏封顶 / 极小屏挤压 / **未测量屏 0×0 ⇒ 1×1** / 偏移屏滑入 / `min_pane` 生效）。

顺带把 `amos-wm/src/layout.rs` 的 `right` / `bottom` / `enforce_min` / `clamp_into` 改成 `const fn`：
`Ord::max` 在该工具链上**尚未 const 稳定**，因此用新的 `at_least()` 写显式比较——整条策略算术
（`columns_for` / `split_axis` / `check_app_window` / `initial_window_in`）因此都是编译期可求值。

### 11.4 测试（红 → 绿，且补上被漏掉的两条性质）

| 层 | 新增 / 修正 | 说明 |
|---|---|---|
| 领域 `amos-wm` | `a_new_window_opens_on_screen_and_at_least_min_pane` | 六种屏幕（大 / 小 / 极小 / 未测量 / 偏移 / 宽屏）逐一钉住权威顺序 |
| 领域 `amos-wm` | `a_class_without_multi_window_refuses_the_second_app_window` | 夹具类/无 UI 类拒绝第二个；多窗口类**任意**数量都放行（含 1000） |
| 宿主 `amos-tauri` | `a_refused_app_window_leaves_no_trace_in_the_model` | **修掉的那个缺陷**：被拒后模型里只有 `main` + `a` |
| 宿主 `amos-tauri` | `closing_the_single_app_window_frees_the_slot` | 关掉唯一 app 窗口后，单窗口类别又能开一个 |
| 宿主 `amos-tauri` | `container_surfaces_do_not_consume_an_app_window_slot` | 外部容器表面（`System`）不吃 app 窗口名额 |
| 宿主 `amos-tauri` | ~~`a_headless_class_refuses_to_split`~~ → 改为 1 个 app 窗口 + 1 个外部表面 | 原用例在无 UI 类别上注册**两个** app 窗口，与新规则冲突；改用真实世界里那一对，类别拒绝的理由（`no user interface`）仍然被钉住 |

**实测**（REQ-A257 收口轮，2026-09-15，本机 macOS）：
`cargo test -p amos-wm` **46 + 2**（e2e）、`cargo test -p amos-tauri --lib` **341**、
`cargo clippy -p amos-wm -p amos-tauri --all-targets -- -D warnings` 干净。
（341 = 上一轮实测基线 **332** + REQ-A256 的四条宿主用例 + 本轮的 **5** 条：无痕拒绝 / 释放名额 /
表面不吃名额 / 回夹 7 情形 / 位置读数。）

**当前代码位置**（行号会漂移，类型与函数名不会）：`WmState::check_new_app_window` `wm.rs:547`；
`open()` 在注册**之前**问它 `wm.rs:666-691`；`reclamp_windows` `wm.rs:568`；`reclamp_target`
`wm.rs:320`；`sane_signed_edge` `wm.rs:329`；领域侧 `AppWindowRefusal` `form.rs:159`、
`check_app_window` `form.rs:339`、`fit_window` `form.rs:360`、`initial_window_in` `form.rs:377`。

### 11.5 顺带补上的那条缺口：屏幕变小回夹（本轮已实现）

上一节登记的"宿主不跟踪矩形 ⇒ 不回夹"**不需要** per-window 账本：平台上的真实几何就是真源。
新增 `WmState::reclamp_windows(&AppHandle) -> Result<usize, String>`：

* 取每次**真实**屏幕变化之后（`lib.rs` 的 `Resized` 路径、`sync_from_pixels` 已确认变化）；
* 逐个窗口读 `outer_position` / `inner_size` / `scale_factor`（换算成逻辑像素，与
  `LogicalPosition`/`LogicalSize` 的落点一致）——读不出来就**计数 + `warn!`**，绝不猜位置；
* 目标矩形由**同一条领域规则**算：`LayoutPolicy::fit_window(current_size, screen)`
  （不低于 `min_pane`、不超过屏幕、完全落在屏幕内），**位置保留用户放的**；
* 只有 `reclamp_target(policy, current, screen)` 返回 `Some`（即真的需要动）才下发
  `set_position`/`set_size`——`None` 意味着连一次窗口调用都不发生，这是"不跟用户抢窗口"的保证；
* 跳过 Launcher（它就是屏幕）、外部容器表面（几何归容器）、隐藏窗口；返回移动了几个并 `info!`。

因此 `initial_window_in`（新窗口开在哪）与 `reclamp_target`（旧窗口拉回哪）**共用 `fit_window`**，
两者不可能给出互相矛盾的答案——这正是"多窗口策略"最容易腐坏的地方。测试：
`reclamp_target_moves_only_windows_that_need_it`（7 情形）+ `only_a_believable_reading_becomes_a_window_position`
（`sane_signed_edge`：取值与 6 种垃圾读数）。

### 11.6 顺带修掉的第二处红：FMEA 门禁的 `--check`（同一轮实测发现）

`docs/FMEA.md` 在 §2.2 已经登记了 F-WM-014/015/016，但**机读 inventory**
（`scripts/fmea-gen.mjs` 的 `KNOWN_FAILURES`）里没有任何 `F-WM-*`——于是仓库自己的门禁是红的：

```text
$ node scripts/fmea-gen.mjs --check
[FAIL] fmea-doc: doc lists IDs not in inventory:
       - F-WM-014
       - F-WM-015
       - F-WM-016
EXIT=1
```

这正是"文档说已做、机器说没做"的形状：**门禁只认可被代码证实的缓解**。收口（本轮）：

* inventory 新增窗口管理组：F-WM-014/015/016（markers 指向真实存在的
  `check_new_app_window` / `fit_window` / `enforce_min` / `resizable(policy.free_resize)`）；
* 把本轮**发现并修掉的两类失效模式**也登记进去（这才是 FMEA 该干的事）：
  * **F-WM-017** 屏幕变小后 app 窗口挂在屏幕外 → 缓解 `reclamp_windows` + `fit_window`，
    测试 `reclamp_target_moves_only_windows_that_need_it`；
  * **F-WM-018** 被拒的 app 窗口在状态机里留痕 → 缓解"判定在注册之前"
    （`check_new_app_window`，拒绝是数据 `AppWindowRefusal`），
    测试 `a_refused_app_window_leaves_no_trace_in_the_model`。
* `node scripts/fmea-gen.mjs --check` **EXIT 0**、`--self-test` 通过（ID 唯一、markers 可证）。

### 11.7 顺带修掉的第三、四处红：一个没 `git add` 的进度草稿 + 一个不存在的 `make` 目标；并把"三份 G5 报告谁是真源"说清

REQ-A256 这一轮在 `docs/` 里留下了**三份**描述同一件事的文件：

| 文件 | 性质 | 处置 |
|---|---|---|
| `docs/G5_POLICY_ENFORCEMENT.md` | 实施文档 + **本轮补上 §11 复核** | **唯一真源**（保留） |
| `docs/G5_POLICY_ENFORCEMENT_COMPLETE.md` | 实施过程中的中间快照，正文引用的是**被判缺陷的** `register_app` 写法，并声称"336/336" | 保留为记录，**加了顶部的降级横幅**（写明真源、缺陷所在、数字已过期） |
| `docs/G5_PROGRESS.md` | 进度草稿，**未 `git add`**，且建议"删掉 `G5_POLICY_ENFORCEMENT.md`、保留 `_COMPLETE`"（与最终结论相反） | 保留为记录 + 降级横幅 + 更正，并 **`git add`**（见下） |

后两者触发了两个仓库门禁（**都是红的**，不是样式问题）：

```text
$ node scripts/untracked-source-scan.mjs
[untracked-source-scan] UNTRACKED docs/G5_PROGRESS.md — a clean checkout will not have
this file (stage it, or excuse it in scripts/untracked-allowlist.json).            EXIT=1

$ node scripts/make-target-doc-scan.mjs
[make-target-doc-scan] 131 doc(s), 45 Makefile target(s); "1" reference(s) to a missing target.
[make-target-doc-scan] FAIL — docs/G5_PROGRESS.md:66 names `make ci-local-gate`,
                       which is not a Makefile target                             EXIT=1
```

第二处是**真的写错了命令**（本地 CI 门禁是 `make ci-local` / `bash scripts/ci-local-gate.sh`）。
处置原则和 §11.1 一样——**不删、不假装**：文件保留为历史记录，但顶部必须写明"这不是真源"，
命令必须改对，未跟踪的必须入库（`git add`；`untracked-allowlist.json` 保持 `[]`，不留例外）。
两个门禁现在都 **EXIT 0**。

**仍然没做的**：真机观感复核（把桌面壳拉小、看窗口是否被拉回），以及
`WmState::new_for_test(form)` —— 它是 `with_form_factor(form)` 的 `#[cfg(test)]` 别名
（同一件事两个名字）。本轮**未删**（它在另一轮的在建改动里），登记给下一轮。
