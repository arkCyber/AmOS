# AmOS — macOS 原生菜单(Aqua Global Menu)

> 状态:已实现 (P0-2 完成,2026-09-16)
> 范围:macOS 桌面形态的原生全局菜单
> 关联:
> - `crates/amos-tauri/src/menu.rs`(宿主实现)
> - `crates/amos-tauri/src/lib.rs`(boot 接入)
> - `docs/PC_DESKTOP_AUDIT.md` §3.4(顶栏缺陷)

## 1. 设计目标

macOS 用户进入桌面形态时,顶部必须看到**真实的 Aqua 全局菜单** —— Apple 🍎 + 当前应用名(固定 "Amos")+ File / Edit / View / Window / Help。这是 macOS 桌面体验**最显眼**的特征之一(参见 `PC_DESKTOP_AUDIT.md §3.4`)。

## 2. 菜单结构

| 菜单 | 内容 | 由谁处理 |
|---|---|---|
| **Amos**(Apple 菜单) | About Amos / Preferences… / Services (占位) / Hide Amos / Hide Others / Show All / Quit | About/Quit/Hide-Amos 由 Rust 处理,其余发到前端 |
| **File** | New Window (⌘N) / Close Window (⌘W) | 发到前端 |
| **Edit** | Undo / Redo / Cut / Copy / Paste / Select All | 预定义项(muda),WebView 自动处理 |
| **View** | Minimize (⌘M) / Zoom / Enter Full Screen (⌃⌘F) | 发到前端 |
| **Window** | Minimize / Maximize | 预定义项 |
| **Help** | (空,留作应用自定义) | — |

## 3. 事件路由

```
muda MenuEvent
  ↓
menu::on_menu_event(app, event)
  ↓
  ├─ menu.about       → Rust → emit "show-about-dialog"
  ├─ menu.quit        → Rust → std::process::exit(0) [terminal]
  ├─ menu.hide-amos   → Rust → window.hide()
  └─ 其它 (含 menu.preferences / menu.new-window / menu.close-window / …)
        → emit "menu-event" (前端监听)
```

终端事件(`menu.quit`)在 Rust 处理后**不**发到前端;非终端事件即使被 Rust 处理了(如 About)也同时发到前端,让壳内的对应 UI 与原生菜单**同步**。

## 4. macOS 平台约束

- `.set_menu()` 调用的菜单根**只能**包含 `Submenu`(直接 `MenuItem` 不可);
- 我们在 `build_menu` 里严格只用 `SubmenuBuilder` 喂 `MenuBuilder`;
- 每棵树只能 build 一次(`MenuItemKind` 不能复用),所以 `item()` 是值构造,不是共享句柄。

## 5. 非 macOS 桌面

非 macOS 上 `install()` 是 **no-op**(记一条 `debug` 日志)。Windows GTK 菜单与 Linux 桌面菜单不在本轮范围(参见 `PC_DESKTOP_AUDIT.md §5.1`)。

## 6. 验收

- 在 macOS 上启动桌面形态 → 顶部出现完整菜单条
- ⌘Q / ⌘W / ⌘M / ⌘N 触发对应操作
- Hide Amos (⌘H) 隐藏主窗口
- 前端收到 `menu-event` 事件时更新自己的 UI(如顶栏聚焦状态)

## 7. 不在本轮范围

- 每个 app 注册自己的菜单描述(每个 app 描述 File / Edit 等) —— 需要 Tauri 2 后续窗口级菜单覆盖 + 菜单注册 API;目前菜单是**全局共享**的;
- NSAlert 真正的"关于本机"对话框 —— 需要 objc2/objc FFI,留作后续 Phase。
