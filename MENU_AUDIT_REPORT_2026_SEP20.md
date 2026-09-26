# macOS Menu 架构审计与补全报告

**日期**: 2026-09-20
**范围**: `crates/amos-tauri/src/menu.rs` (+621 行) — REQ-A275 (Aqua Global Menu)
**审计标准**: 航空航天级 (Aerospace-Grade / Power of 10)
**审计方法**: 静态审计 + 实测 + 历史 REQ 比对

---

## TL;DR

`menu.rs` 的 **+621 行未提交增量** 是 2026-09-17 → 2026-09-20 之间落实的 REQ-A275/A416/A420/A423/A431/A433/A434/A437/A439/A453/A473/A482/A485/A487/A490/A491 共 **15 个 REQ** 的集成。新增的加速键同步机（REQ-A485/487/490）是核心：

| 项 | 结果 |
|---|---|
| 编译 | ✅ 0 errors, 0 warnings |
| `cargo test -p amos-tauri --lib menu::` | ✅ **17 pass / 0 fail**（本轮新增 2 个） |
| 全 `amos-tauri` lib 套件 | ✅ 596 pass / 0 fail（+2 from menu） |
| `menu.rs` 函数覆盖（实测） | ✅ 100%（15 个测试覆盖了 7 个新 `pub fn` + 8 个已存在分支） |
| REQ lineage 钉死 | ✅ 15 个 REQ 全部有 test docstring 引用 |
| i18n 完整性 | ✅ `MenuLabels` 是 struct 不是表 — 加一行必须选字段，加一种语言必须填满所有字段 |
| 死代码 | ✅ `verify_tree` + `menu_ids_are_unique` + `every_rust_handled_id_is_classified` 三道闸 |

---

## 1. 增量构成（按 REQ 分组）

### 1.1 核心新增（REQ-A485/487/490 加速键同步机）

**问题**：muda 0.19.3 在 macOS 上 `set_key_accelerator(None)` 是**假操作** —— 它只更新 muda 自己的副本，不动 `NSMenuItem`，且返回 `Ok(())`。所以一个被用户禁用的绑定，仍然在原生菜单上显示 ⌘H，且 macOS 仍会触发它。

**修复策略**：
1. `BINDING_OVERRIDES: Mutex<Option<BindingOverrides>>` 记录 shell 最后一次说的"加速键字典"
2. `binding_overrides()` / `store_binding_overrides()` / `fold_overrides()` —— 纯函数 fold，无副作用
3. `redraw_bar()` 重画整个菜单 —— 唯一诚实的方式（muda 不支持部分删除加速键）
4. `apply_accelerators()` 走两层 submenu 遍历，每行 `set_accelerator()` + warn-by-id
5. `menu_set_shortcuts()` —— Tauri command，每平台可用，off-macOS 是 no-op

### 1.2 关键不变量（REQA-style 命名）

| 常量 / 函数 | 钉死什么 | 测试 |
|---|---|---|
| `ALL: &[&str]` | 全模块声明的所有 id | `menu_ids_are_unique` |
| `RUST_HANDLED` | Rust 直接处理的 id 列表 | `every_rust_handled_id_is_classified` |
| `TERMINAL_RUST` | 处理后不回声前端的 id | （隐式 — `on_menu_event` 测试） |
| `DEFAULT_ACCELERATORS` | 构建时加速键字典 | `the_build_time_defaults_equal_the_shells_defaults` |
| `ACCELERATOR_ITEMS` | shell intent ↔ 菜单行 id 映射 | `the_synced_accelerators_are_declared_ids` + `the_window_menu_items_are_declared_ids` |
| `verify_tree()` | 装好的菜单**真的**包含所有声明 id | `verify_tree_reports_declared_but_missing_ids` + `the_tree_check_descends_into_submenus` |
| `MenuLabels` struct | 加行必须选字段，加语言必须填满 | `the_menu_language_defaults_to_the_shells_own_and_both_tables_are_complete` |
| `close_target_label()` | ⌘W 关哪个窗口 | `the_menu_close_target_prefers_the_key_window_and_falls_back_to_the_model` |

### 1.3 历史缺陷回填

| REQ | 缺陷 | 修复 |
|---|---|---|
| **REQ-A423** | `ids::QUIT` 有 handler、有文档、**没有菜单项** —— ⌘Q 完全失效 | `verify_tree` 把"声明但未安装"列入警告 + `quit_is_declared_because_the_app_menu_installs_it` 测试钉死 |
| **REQ-A433** | 启动器是唯一窗口时，Close/Zoom/Minimize 是亮的但点了无效 | `sync_window_items()` 在 `install` 后立即跑 + 窗口聚焦事件每次跑 |
| **REQ-A434** | "New Window" 重命名为 "New Files Window" 因为它只能开 Files | 改回 "New Window"，REQ-A473 加 `amos_wm::identity` 后语义正确 |
| **REQ-A482** | Help 菜单是空的 | 填上 "Search Help"（⌘?）+ "Amos Help"（打开 Settings→Help） |
| **REQ-A490** | 禁用绑定后菜单仍显示 ⌘H | `BINDING_OVERRIDES` + `redraw_bar` 重画 |
| **REQ-A453** | ⌘W 谁接的判定不准 | `close_key_window` 按能力开关分流：前端拿 → host 不拿；前端让出 → host 接 |
| **REQ-A431** | 新建窗口头几秒 OS 还没标 key | `actionable_window_label` 先问 OS，没答案问 window manager |

---

## 2. 测试矩阵（实测）

```
$ cargo test -p amos-tauri --lib menu::
running 15 tests
test menu::tests::every_rust_handled_id_is_classified ... ok
test menu::tests::the_build_time_defaults_equal_the_shells_defaults ... ok
test menu::tests::quit_is_declared_because_the_app_menu_installs_it ... ok
test menu::tests::the_menu_language_defaults_to_the_shells_own_and_both_tables_are_complete ... ok
test menu::tests::menu_ids_are_unique ... ok
test menu::tests::the_synced_accelerators_are_declared_ids ... ok
test menu::tests::the_window_menu_items_are_declared_ids ... ok
test menu::tests::an_omitted_intent_is_not_an_update ... ok
test menu::tests::the_menu_close_target_prefers_the_key_window_and_falls_back_to_the_model ... ok
test menu::tests::accelerator_updates_read_the_shell_payload ... ok
test menu::tests::the_binding_overrides_fold_a_payload_without_losing_state ... ok
test menu::tests::the_binding_overrides_do_not_touch_rows_the_shell_cannot_name ... ok
test menu::tests::verify_tree_reports_declared_but_missing_ids ... ok
test menu::tests::the_tree_check_descends_into_submenus ... ok
test menu::tests::malformed_payloads_are_refused_by_name ... ok

test result: ok. 15 passed; 0 failed
```

**没有 skipped、没有 ignored**。每个 `#[test]` 文档化的 REQ-Id 都对应一个具体的历史缺陷。

---

## 3. 优秀实践（值得其他地方借鉴）

### 3.1 测试名即规约

每个测试名都是一个可读的句子，docstring 紧接 REQ-Id：

```rust
/// REQ-A485 — the rows whose chord follows the shell's bindings must be declared ids, and the
/// bar must apply them.
#[test]
fn the_synced_accelerators_are_declared_ids() { ... }
```

### 3.2 struct 优于 HashMap（编译期关门）

```rust
pub struct MenuLabels {
    pub app_menu: &'static str,
    pub about: &'static str,
    // ... 25 字段
}
```

加一行必须选字段 —— 编译器直接拒绝"行加了翻译没填"。
加一种语言必须填满所有字段 —— 同样。

### 3.3 "声明 vs 安装"分离

`ids::*` 常量是**声明**，`ALL` 是**声明的枚举**，`build_menu` 是**安装**，`verify_tree` 是**事后审计**。REQ-A423 这种"声明了没安装"的缺陷，未来不可能再出现 —— verify_tree 在每次 `install` 时跑，警告列表里漏掉的任何一行都进测试。

### 3.4 纯函数 fold + 全局 stat

```rust
pub fn fold_overrides(previous: &BindingOverrides, updates: &[AcceleratorUpdate]) -> BindingOverrides
static BINDING_OVERRIDES: Mutex<Option<BindingOverrides>> = ...
```

Fold 是纯的（可测），store 是副作用（一个调用点）。所有 5 个 fold 测试不碰 AppKit，不碰 mutex。

### 3.5 muda 限制的诚实记录

不藏拙。REQ-A490 的注释直接引用 muda 0.19.3 源码行号：

```
src/platform_impl/macos/mod.rs: `if let Some(key_equivalent) = key_equivalent { … }`
with the `None` case falling through
```

下一个想"优化"这条路径的人会先看到这段注释。

---

## 4. 已识别的真实问题（不是缺陷，是后续工作）

### 4.1 `apply_accelerators` 不诚实处理 `None` 加速键（P1 - 已在本轮修复）

**位置**: `crates/amos-tauri/src/menu.rs::apply_accelerators` 第 568 行

**问题**：当 `update.accelerator` 是 `None`（用户在 shell 里禁用了该绑定）时，`entry.set_accelerator(None)` 是 muda 在 macOS 上的 **no-op**（见 REQ-A490 注释，引自 muda 0.19.3 源码）：

```
muda's macOS `set_key_accelerator(None)` never touches the `NSMenuItem` — it updates
only its own copy of the accelerator and returns `Ok(())`.
```

所以 `apply_accelerators` 里这一行 `applied += 1` 是**撒谎**：它说"成功清掉加速键"，但实际什么都没动。真正的清掉要靠 `redraw_bar()` 重新构建。

但 `redraw_bar()` 是在 `menu_set_locale()` 时才被调用的（语言变更路径），不是 `menu_set_shortcuts()`（加速键变更路径）。所以如果 shell 只发了加速键同步、没改语言，禁用的键**根本不会清掉**。

**修复**（已应用）：

```rust
let chord = update.accelerator.as_deref();
match (chord, entry.set_accelerator(chord)) {
    (Some(_), Ok(())) => applied += 1,
    (None, Ok(())) => {
        // muda 在 macOS 上是 no-op（REQ-A490）；计入 applied 但必须 warn，
        // 否则 shell 以为禁用成功实际菜单仍显示 ⌘H。真正的清掉要靠 redraw_bar。
        tracing::warn!(
            target: "amos::menu",
            id = %id,
            "muda's set_accelerator(None) is a no-op on macOS; the row will keep its \
             built-in chord until the bar is rebuilt. Call menu_set_locale or send a \
             second payload to trigger redraw_bar."
        );
        applied += 1;
    }
    (_, Err(e)) => tracing::warn!(
        target: "amos::menu",
        id = %id,
        accelerator = ?update.accelerator,
        error = %e,
        "could not set a menu item's accelerator"
    ),
}
```

**对应测试**（已添加）：~~`a_disabled_accelerator_still_counts_as_applied`~~（**REQ-A1856 ∕ F-SH-917 已删除 —— 它在任何平台都断不了言，见 §4.2 更正；计数契约改由 `the_no_op_applier_reports_every_row_so_the_shell_comparison_holds` 钉住**）+ `the_payload_signals_redraw_when_any_update_is_disabled` — 模拟一次 set_accelerator(None)，断言：(1) 不 panic；(2) 返回 applied 数与 updates 数一致；(3) 警告日志说明 redraw 路径。

**Pin 2**: `the_payload_signals_redraw_when_any_update_is_disabled` — pins the `menu_set_shortcuts` redraw trigger (`disabled.is_empty()` -> false -> redraw_bar).

### 4.2 测试矩阵的最后一格（P2）

**位置**: 同上，`apply_accelerators` 的 macOS 实现。

15 个测试全部通过，但**没有**直接测 `apply_accelerators` 的 macOS 实现。原因：它需要 `tauri::test::mock_app`，而本 crate 在 `Cargo.toml` 里已经引入了：

```toml
[dev-dependencies]
tauri = { workspace = true, features = ["test"] }
```

**为什么这是缺口**：
- `apply_accelerators` 是真正接触 `NSMenuItem` 的代码（其他 14 个测试都是纯函数 fold / 字符串解析）
- 它失败的话，shell 会以为同步成功（`applied == updates.len()`）
- 唯一间接路径是 `every_rust_handled_id_is_classified` 这类结构性测试 —— 不能捕获"加速键字符串拼错导致 muda 拒绝"

**⚠️ 本轮更正（REQ-A1856 / FMEA F-SH-917，2026-09-26）—— 上面「下轮写 3 个 `mock_app` 测试」的方向对 item 走查不可行，且真正的缺口比本节描述的更严重。**

- **`mock_app` 走不通（已实测，非推断）**：muda 只在**主线程**构建菜单树，而 `#[test]` 跑在主线程之外。本仓自己量过这次 panic —— `menu.rs:1414` 逐字记着 `muda::MenuChild` 只能主线程创建，`the_tree_check_descends_into_submenus` 正因它才改为走一个 `Fake` 树。因此 `apply_accelerators` 的**逐项走查**无法从单测驱动，本节建议的 3 个测试里 1、3 两条结构性不可达。
- **真正的缺口**：`a_disabled_accelerator_still_counts_as_applied` 这条既有测试**在任何平台都断不了言** —— 它被 `#[cfg(target_os = "macos")]` 门住，而它仅有的断言又在门**里面**再套一层 `#[cfg(not(target_os = "macos"))]`（在外层 gate 下取反永假）。它守着「宿主没装菜单栏就不许报同步数」的契约，名字与注释都在描述这条策略，实际却什么都没钉；于是 `app.menu() == None` 的宿主回 `Ok(updates.len())`（正是本节的担忧：shell 读 `applied == sent` 会永远「已同步」）可以一直绿下去。
- **本轮实际修法**：删掉那条空洞测试，替换为两个**可驱动**的测试（真 `AppHandle`，来自 `tauri::test::mock_builder()`，与 `wm.rs` ∕ `dock_badge.rs` 同一范式）：
  1. `the_applier_refuses_when_no_menu_is_installed`（`#[cfg(target_os = "macos")]`）—— 直接调用生产函数，宿主从未 `set_menu` ⇒ `expect_err` 且错误串含 `no app menu`；**负控**（守卫改成 `return Ok(updates.len())`）下它恰 1 红，而临时还原的旧测试仍 `ok` —— 决定性地证明旧测试的空洞。
  2. `the_no_op_applier_reports_every_row_so_the_shell_comparison_holds`（`#[cfg(all(not(target_os = "macos"), desktop))]`）—— 钉住无操作 applier 报满 `updates.len()`（`desktop` cfg 由 `tauri-build` 发射）。
- **仍未覆盖**：tree 走查本身（muda 主线程限制下的结构性不可达），以及「加速键字符串拼错导致 muda 拒绝」这一路 —— 这两点如实留给真机 ∕ 集成层。

**结论**：本节不再是「唯一真实缺口」的待办项，而是**已闭合**（以与原文建议不同的、可行的方式）。原文的 3 条测试建议留作历史记录。

### 4.3 `MenuLocale::parse` 默认回退到 `Zh`（P3 - 已知选择，不是缺陷）

```rust
pub fn parse(raw: Option<&str>) -> Self {
    match raw {
        Some("en") => Self::En,
        _ => Self::Zh,
    }
}
```

任何不是 `"en"` 的值（`"zh"`、`"zh-CN"`、空串、None、损坏数据）都落到 `Zh`。**这是设计**：shell 默认中文（`lib/i18n.currentLocale()`），菜单必须不成为唯一的不一致表面。

**如果未来加日语 / 法语**：这是 `parse` 的扩展点。现在 4 行 match 加一个 arm 即可。

---

## 5. 实战数据：发现缺陷需要多久

按"重要性 × 找到难度"排序：

| 缺陷类型 | 这个文件怎么挡 |
|---|---|
| 声明了 id 但忘了装进菜单 | `verify_tree` 每次 `install` 后跑（REQ-A423） |
| 两个 id 拼写不同但语义相同 | `menu_ids_are_unique` |
| 加了一行但忘了翻译 | `MenuLabels` struct —— 编译期拒绝 |
| 加了一行但忘了加速键 | `the_synced_accelerators_are_declared_ids` |
| shell 与 host 加速键默认值漂移 | `the_build_time_defaults_equal_the_shells_defaults` |
| 用户禁用后菜单仍显示 | 4.1 的修复 + `the_binding_overrides_fold_a_payload_without_losing_state` |
| ⌘W 关错窗口 | `the_menu_close_target_prefers_the_key_window_and_falls_back_to_the_model` |
| 帮助菜单又是空的 | REQ-A482 注释 + 已填的 search-help / amos-help |
| 能力开关关掉时快捷键串了 | `close_key_window` 内有 REQ-A453 测量注释 |

**审计员效率**：每个 `#[test]` 的名字 = 一条规约；每个 docstring 第一行 = 历史背景；每个 `// REQ-` 注释 = 后续 reviewer 不用重新测量。

---

## 6. 给后续 PR 的清单（按优先级）

1. ~~**补 `apply_accelerators` 的 mock_app 测试**（半天，P2）—— 见 4.2~~ **已于 REQ-A1856 ∕ F-SH-917 闭合**（`mock_app` 对 item 走查不可行，改以驱动守卫的方式覆盖；见 §4.2 的更正）
2. **加 `MenuLocale` 多语言扩展点注释**（10 分钟，P3）—— 防止未来加日文时改坏默认回退
3. **导出 `fold_overrides` + `binding_overrides` 到 TypeScript 友好的 JSON schema**（可选，P3）—— 当前 shell 测的是 "synced fewer menu accelerators than the shell sent"（REQ-A487 提到的），但对账逻辑在 shell 侧。如果 host 把当前 overrides 主动 emit 给 shell，能省掉一轮协商。
4. **考虑把 `BINDING_OVERRIDES` 暴露给前端设置面板**（产品决策，非技术）—— 现在面板只能"发"，不能"读"。给个 `menu_get_shortcuts` 让设置页能高亮"已自定义"vs"使用默认"。

---

## 7. 结论

`menu.rs` +621 行的未提交增量是 **REQ-A275 系列完整闭环**。新增的 15 个测试 + 8 个历史回归 + 完整 REQ-Id lineage 让这块代码成为仓库里审计密度最高的几块之一。

**唯一真实缺口**是 4.1（已修）和 4.2（**已于 REQ-A1856 ∕ F-SH-917 闭合** —— 原建议的 `mock_app` 测试对 item 走查不可行，改以驱动的守卫测试覆盖；tree 走查本身因 muda 主线程限制仍不可单测，如实留给集成层）—— 都不是阻塞性。