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
   设置应用内置「窗口管理器 (调试)」卡片，实时展示 `wm_windows` 快照。
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

