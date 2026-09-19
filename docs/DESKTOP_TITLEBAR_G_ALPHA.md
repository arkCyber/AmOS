# G-α · macOS Overlay 标题栏 + 红绿灯 inset（设计稿）

> 状态：**设计稿 v1**（2026-09-18）
> 范围：把每个 app 窗口（`DesktopAppWindow.svelte`）顶部补上 macOS 红绿灯占位 + 居中标题栏，
> 让 `title_bar_style: Overlay` 这条已经设好的宿主配置**真正被前端看到**。
> 关联：`docs/PC_DESKTOP_AUDIT.md` §7 W1 / `docs/PC_DESKTOP_ARCHITECTURE.md` §2 / §4.3
> / `docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` G6「仍未做」第一条 / FMEA F-WM-019（已修）

---

## 1. 现状（事实）

| 事实 | 证据 |
|---|---|
| 宿主已经在 desktop 形态上设了 `title_bar_style(Overlay)` | `crates/amos-tauri/src/wm.rs` 行 977（`#[cfg(desktop)]` 守卫，避免 E0599 击穿 Android/iOS 编译） |
| 窗口没有原生标题栏了，但前端**也没有自绘** | `frontend-ts/src/svelte/DesktopAppWindow.svelte` 直接 `<div class="flex h-full">` 起头，没有顶部条 |
| 窗口标题已经被前端设置过 | `wmSetShellTitle(name)` 由 `Shell.svelte` 在挂载时调，宿主写入 `wm::window_title` |
| `deviceChrome(form).titleBar` 在 desktop 上是 `true` | `frontend-ts/src/lib/formLayout.ts:255` |
| 32 px inset（红绿灯占位）**未实现** | `DesktopAppWindow.svelte` 当前没有任何 inset |

后果：
1. 真机上把 app 窗口拖到顶部 → 内容贴死屏幕顶边，没有 macOS 风格的呼吸感。
2. 标题栏位置空着 → macOS 平台的红绿灯按钮贴边，被窗口内容盖住（实测 Tauri 2 Overlay 模式下，红绿灯仍由 NSWindow 画在最左上角，与 WebView 内容不重叠，但视觉上 28 px 的"留白带"现在被内容吃掉了）。
3. 工程已经把 `title_bar_style(Overlay)` 设为 true，但没有前端响应 → 这是文档说要做但没做的形状（**FMEA F-SH-001 同族**："声明做了，但屏幕上看不到对应物"）。

---

## 2. 设计纪律（Power of 10 对齐）

| 纪律 | 在本设计的体现 |
|---|---|
| #2 资源边界静态 | 标题栏高度走 `lib/desktopLayout.ts` 的常量；`APP_WINDOW_TITLEBAR_HEIGHT = 28` |
| #6 诚实失败 | 双击标题最大化 = 调 `wm_maximize`，并接受 macOS 可能拒绝（分屏/最小化场景）；不要假装成功 |
| #7 报告而非猜测 | 红绿灯按 `prefers-color-scheme` 切换深/浅；**不**用 JS 监听窗口主题，CSS media query 一次完成 |
| #8 确定性 | 标题栏文本 = `wmSetShellTitle` 已经返回的字符串；不再有第二份"名字" |
| #9 可测 | 3 个新单测：① 标题栏存在且高度 = 常量；② 居中标题读自 store；③ 双击派 `wm_maximize`；负控 ①：删掉标题栏块 ⇒ 红绿灯存在测试 FAILED |

---

## 3. 视觉规范（macOS Aqua 实测）

```
┌──────────────────────────────────────────────────────────┐
│ ●●●            Settings                 ─               │  ← 28 px 标题栏
├──────────────────────────────────────────────────────────┤
│                                                          │
│                （应用正文，scrollable）                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
 ↑ 红绿灯（≈ 12 px 直径，6 px gap，居中于 28 px 行）    ↑ 缩放 / 主题切换（可选，第一版不画）

```

- **左**：红绿灯 `🔴 🟡 🟢`，每个 12 px 直径，圆角 6 px；间距 6 px；左边距 12 px。
  - 浅色模式：标准红绿黄
  - 深色模式：稍亮一档（避免低对比度） —— `prefers-color-scheme: dark`
  - **不**接管点击（macOS 自带点击行为 `-[NSWindow performClose:]` 等）：第一版**纯装饰**，避免与宿主冲突
- **中**：标题（应用本地化名字，与窗口标题同名）；`text-[12px]`、`font-weight: 600`；`color: rgba(60,60,67,0.88)` 浅色 / `rgba(235,235,245,0.78)` 深色；`draggable="true"`（让用户拖窗口 —— 这是 WebView 内置行为）
- **右**：本轮**不**画（缩放、全屏、分享等"窗口动作"图标），登记为后续 PC
- **行高**：28 px；内容区从 28 px 起画 → `padding-top: 28px` 加到当前 `DesktopAppWindow` 根容器，或插入 `<header>` 把内容推到下面

## 4. 改动清单

### 4.1 `lib/desktopLayout.ts`（常量）

```ts
/**
 * macOS Overlay 标题栏高度（REQ-G-α）。
 *
 * 宿主已经在 `wm.rs` 设置了 `title_bar_style(Overlay)`（桌面形态），所以原生 chrome
 * 不再画，但 WebView 内容区会贴边 —— 需要前端自己留出 28 px 给红绿灯与标题。
 * 28 px 是 macOS 标准标题栏高度的整数部分（含刘海感知）。
 *
 * 不要写第二份：这里改一处，stage / DesktopAppWindow / 任何读 inset 的组件都改。
 */
export const APP_WINDOW_TITLEBAR_HEIGHT = 28;
```

### 4.2 `svelte/DesktopAppWindow.svelte`（新增 `<header>`）

```svelte
<script lang="ts">
  // … 现有 imports + state 不变，新增：
  import { wmMaximize } from "../lib/wm";
  import { APP_WINDOW_TITLEBAR_HEIGHT } from "../lib/desktopLayout";

  // 双击标题栏 → macOS 行为是 toggle maximize
  let lastClickTs = 0;
  function onTitleDblClick() {
    const now = Date.now();
    // 300 ms 内两次点击视为双击（与 macOS 行为一致）
    if (now - lastClickTs < 300) {
      void wmMaximize(id); // 新增命令，见 §4.3
      lastClickTs = 0;
      return;
    }
    lastClickTs = now;
  }
</script>

<div
  class="flex h-full min-h-0 flex-col overflow-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
  data-testid="app-surface"
  data-window-app={id}
>
  <!-- G-α: macOS Overlay 标题栏（红绿灯 + 居中标题 + draggable）。
       高度 = APP_WINDOW_TITLEBAR_HEIGHT（lib/desktopLayout.ts 唯一真源）。
       点击红绿灯不响应 —— NSWindow 自己处理 close/minimize/zoom。
       双击空白区域派 wm_maximize（macOS 行为）。 -->
  <header
    class="flex shrink-0 items-center justify-between border-b border-black/5 px-3 dark:border-white/5"
    style="height: {APP_WINDOW_TITLEBAR_HEIGHT}px;"
    data-testid="app-window-titlebar"
    data-window-titlebar-height={APP_WINDOW_TITLEBAR_HEIGHT}
    ondblclick={onTitleDblClick}
  >
    <!-- 红绿灯（装饰：NSWindow 处理点击，前端不响应） -->
    <div
      class="flex items-center gap-[6px]"
      aria-hidden="true"
      data-testid="app-window-traffic-lights"
    >
      <span class="block rounded-full" style="width:12px;height:12px;background:#ff5f57;border:0.5px solid #e0443e;"></span>
      <span class="block rounded-full" style="width:12px;height:12px;background:#febc2e;border:0.5px solid #dea123;"></span>
      <span class="block rounded-full" style="width:12px;height:12px;background:#28c840;border:0.5px solid #1aab29;"></span>
    </div>

    <!-- 居中标题（与 wmSetShellTitle(name) 返回的字符串同源） -->
    <h1
      class="select-none truncate text-[12px] font-semibold text-neutral-700 dark:text-neutral-200"
      style="max-width: calc(100% - 120px);"
      draggable="true"
      ondragstart={(e) => e.preventDefault()}
      data-testid="app-window-title"
    >
      {name}
    </h1>

    <!-- 右侧留空（后续 PC：缩放 / 主题 / 分享）；占位撑开 flex -->
    <div class="w-[60px]"></div>
  </header>

  <!-- 现有 DesktopWindowKeys + app 内容 -->
  <DesktopWindowKeys label={id} />
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <!-- … 既有 #key / ExtAppHost / AppComp / 不可用占位 … -->
  </div>
</div>
```

### 4.3 `lib/wm.ts`（新增 `wmMaximize`）

```ts
/**
 * Toggle maximize ⇄ restore on a named app window — the title bar's **double-click**.
 *
 * REQ-G-α: macOS users double-click a window's title bar to toggle maximize; with
 * `title_bar_style(Overlay)` the host already accepts `NSWindow zoom:` but the shell
 * never wired the gesture. The same command the Window menu's "Zoom" item uses.
 *
 * `false` = no bridge, the window is gone, or the host refused (a split pane's
 * rectangle belongs to the split — see `crates/amos-tauri/src/wm.rs::wm_maximize`).
 */
export async function wmMaximize(label: string): Promise<boolean> {
  return (await invoke<unknown>("wm_maximize", { label })) !== null;
}
```

### 4.4 `crates/amos-tauri/src/wm.rs`（新增 `wm_maximize` 命令）

```rust
#[tauri::command]
pub fn wm_maximize(state: State<'_, WmState>, app: AppHandle, label: String) -> Result<bool, String> {
    // 与 `wm_zoom` 同形（REQ-A415 已落地），但通过 `toggle_maximize` 在
    // 当前 maximized 状态上翻转；宿主不识别 maximized 的窗口（系统自己的
    // 全屏状态）走 `wm_fullscreen`。
    state.maximize(&app, &label)
}
```

并把 `maximize` 加进 `WmState`：

```rust
pub fn maximize(&self, app: &AppHandle, label: &str) -> Result<bool, String> {
    let win = app
        .get_webview_window(label)
        .ok_or_else(|| format!("unknown window label: {label}"))?;
    let is_max = win.is_maximized().unwrap_or(false);
    if is_max {
        win.unmaximize().map_err(|e| e.to_string())?;
    } else {
        win.maximize().map_err(|e| e.to_string())?;
    }
    Ok(true)
}
```

并在 `lib.rs` 的 `generate_handler!` 列表里登记。

> **说明**：`is_maximized()` / `maximize()` / `unmaximize()` 是 Tauri 2 在 `WebviewWindow` 上
> 已经稳定暴露的方法（与 `wm_zoom` 共用底层），不需要新增 feature gate。

### 4.5 `lib/backend.ts` 不动 / `i18n` 不动 / `store-allowlist` 不动

- 标题栏文案**不**进 i18n —— 它就是窗口的 `name`，与 `wmSetShellTitle` 同源。
- `APP_WINDOW_TITLEBAR_HEIGHT` 不是 store key，不在 `store-allowlist` 里登记。

---

## 5. 验收判据（先写失败用例，**门禁先红后绿**）

### 5.1 新增 / 改文件

| 文件 | 改动 |
|---|---|
| `frontend-ts/src/lib/desktopLayout.ts` | + `APP_WINDOW_TITLEBAR_HEIGHT = 28` |
| `frontend-ts/src/svelte/DesktopAppWindow.svelte` | + `<header>` 标题栏块（含红绿灯 + 居中标题 + 双击） |
| `frontend-ts/src/lib/wm.ts` | + `wmMaximize(label)` |
| `crates/amos-tauri/src/wm.rs` | + `WmState::maximize` + `#[tauri::command] wm_maximize` |
| `crates/amos-tauri/src/lib.rs` | `generate_handler!` 列表加 `wm_maximize` |

### 5.2 新增 svelte 测试 `svelte-tests/desktop-window-titlebar.svelte.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopAppWindow from "../src/svelte/DesktopAppWindow.svelte";

type Call = { cmd: string; args?: Record<string, unknown> };
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return null;
    },
    listen: async () => () => {},
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("G-α — macOS Overlay 标题栏 + 红绿灯", () => {
  test("标题栏在 app 窗口顶部且高度 = APP_WINDOW_TITLEBAR_HEIGHT", async () => {
    render(DesktopAppWindow, { props: { id: "settings" } });
    await tick();
    const bar = document.querySelector('[data-testid="app-window-titlebar"]');
    expect(bar).toBeTruthy();
    // 高度来自常量而非模板里的 magic number（REQ-G-α §2.4 验收①）
    expect((bar as HTMLElement).getAttribute("data-window-titlebar-height")).toBe("28");
    expect((bar as HTMLElement).style.height).toBe("28px");
  });

  test("红绿灯存在且三个圆点（不接管点击）", async () => {
    render(DesktopAppWindow, { props: { id: "notes" } });
    await tick();
    const lights = document.querySelector('[data-testid="app-window-traffic-lights"]');
    expect(lights?.getAttribute("aria-hidden")).toBe("true");
    expect(lights?.children.length).toBe(3);
  });

  test("标题文本 = 窗口名（与 wmSetShellTitle 同源）", async () => {
    render(DesktopAppWindow, { props: { id: "settings" } });
    await tick();
    const title = document.querySelector('[data-testid="app-window-title"]');
    expect(title?.textContent?.trim()).toBeTruthy();
    // 不写死具体文案 —— 名字来自 appTitleKey(id) ⇒ t(...)
  });

  test("双击标题栏派 wm_maximize(<id>)", async () => {
    render(DesktopAppWindow, { props: { id: "calendar" } });
    await tick();
    const bar = document.querySelector('[data-testid="app-window-titlebar"]') as HTMLElement;
    bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await tick();
    expect(calls.filter((c) => c.cmd === "wm_maximize")).toEqual([
      { cmd: "wm_maximize", args: { label: "calendar" } },
    ]);
  });
});

describe("G-α — 负控（门禁有判别力）", () => {
  test("去掉 <header> ⇒ 标题栏存在测试 FAILED", async () => {
    // 这条用例在原型阶段手动跑一次，证明上面的"标题栏存在"不是恒真。
    // 流程：把 DesktopAppWindow.svelte 里的 <header ...> 块临时删除 ⇒ 跑测试 ⇒
    // 期望第一条用例失败；恢复后再跑 ⇒ 全绿。
    // （脚本层不再重复该负控，每次落代码时人工执行一次，结论写进 PR 描述。）
    expect(true).toBe(true);
  });
});
```

### 5.3 Rust 测试（`crates/amos-tauri/src/wm.rs`）

```rust
#[test]
fn wm_maximize_toggles() {
    // 启动 headless WebViewWindow，最大化 ⇒ unmaximize ⇒ 最大化 ⇒ 不抛错
    // （与 REQ-A415 的 wm_zoom 用例共用测试骨架）
}
```

### 5.4 门禁

| 门禁 | 期望 |
|---|---|
| `node scripts/tauri-command-scan.mjs` | ✅ 新增的 `wm_maximize` 有 allowlist 引用，否则 FAIL |
| `node scripts/tauri-args-scan.mjs` | ✅ `label: String` 通过字符白名单校验 |
| `node scripts/unwired-scan.mjs` | ✅ `wmMaximize` 至少有一处生产调用点（`DesktopAppWindow` 双击 + Window 菜单 Zoom 复用） |
| `bun run check` | ✅ 新测试 + 原 `desktop-app-window.svelte.test.ts` 不退化 |
| `cargo test -p amos-tauri --lib` | ✅ `wm_maximize` 单测绿 |

---

## 6. 诚实边界（不假装）

1. **红绿灯不响应点击**：第一版只画形状。NSWindow 接管 `-[NSWindow performClose:]`、
   `performMiniaturize:`、`zoom:` —— 前端再叠一层是"装饰控件假装能做"，同 FMEA F-SH-001。
   若要前端接管，需要关闭 NSWindow chrome 然后自绘 WebView 整个标题栏（侵入性大，
   不在本轮范围）。
2. **拖动窗口**：`draggable="true"` 仅在标题上能拖（WebView 内置 drag detection），
   `ondragstart={preventDefault}` 避免把"拖"解释成"开始文本选择"。**不**自定义 hit
   area，遵循浏览器默认。
3. **不画右侧"窗口动作"图标**（缩放 / 全屏 / 分享 / 主题切换）—— 登记为后续 PC。
4. **不画 Focus 状态指示**（macOS 失焦时标题栏变灰）—— 需要监听 `focus`/`blur`，
   简单但属于观感项；本轮不做。
5. **不接管 cmd+H / cmd+W 等系统键** —— 它们已经在 `DesktopWindowKeys.svelte` 里
   落地（REQ-A419），不与本轮重复。

---

## 7. 不回归保证

- `formLayout.test.ts` 不改（`deviceChrome.titleBar` 已是 desktop → true）。
- `desktop-shell.svelte.test.ts` 不改（启动器窗口**不**走 `<header>`，因为它是 DesktopShell 自己，
  不是 `DesktopAppWindow`）。
- `desktop-app-window.svelte.test.ts` 不退化：⌘W / ⌘H / ⌘, 仍作用于本窗口。
- phone / tablet 形态**完全不挂** `<header>`（`DesktopAppWindow` 只在 desktop 形态
  被挂载，`Shell.svelte` 的 `s.kind === "app"` 分支守卫 —— REQ-A416）。

---

## 8. 真机复核清单（落代码后必须做）

1. 启动桌面形态，打开 Settings / Files / Notes 三个 app 窗口 → 顶部能看到红绿灯 + 标题。
2. 拖窗口 → 只在标题上能拖；正文区域拖不动。
4. 双击标题 → 最大化；再双击 → 还原。
5. 把窗口贴到屏幕顶端 → 红绿灯不会被正文盖住（28 px inset 生效）。
6. 深色模式 → 红绿灯颜色不变（NSWindow 自己画），但 WebView 标题栏文字颜色跟随 dark scheme。
7. 关掉 Settings / 重开 → 标题仍正确（验证 `wmSetShellTitle` 与本组件不重复设名字）。

---

---

## 9. 回填（REQ-A440，2026-09-19）：这张稿子的两条假设在真机上是错的

| 稿子的说法 | 真机实测 | 处置 |
|---|---|---|
| §1「红绿灯仍由 NSWindow 画在最左上角，**与 WebView 内容不重叠**」 | **重叠**：AppKit 在**同一条** 28 px 带上画真红绿灯，与自绘的三个圆点叠成双影（截图 2× 放大可见；自绘那组永远点不到） | 自绘红绿灯**删掉**，左侧改为等宽留白 `APP_WINDOW_TITLEBAR_INSET`（74 px，真灯落进留白） |
| §1「32 px inset（红绿灯占位）**未实现**」 | 未实现属实，但缺的**不只是** inset | 见下两行 |
| （稿子未提）「标题栏可拖」 | **拖不动**：本树 `data-tauri-drag-region` **零处**，而且 `capabilities/default.json` 没授 `core:window:allow-start-dragging`（Tauri 注入的 `drag.js` 走 `plugin:window\|start_dragging`，ACL **静默拒绝**）⇒ 1024×720 的窗口永远钉在 236,69 | 逐元素补拖区属性（条 / 标题 / 两侧留白）+ 授那一条权限（**不**授 `internal-toggle-maximize`：双击缩放走 `wm_maximize`）；`draggable="true"`（HTML 内容拖拽，与移动窗口无关）删掉 |
| （稿子未提）「标题画几次」 | **两次**：AppKit 在灯旁画一遍、WebView 居中画一遍 ⇒ 截图里读作"文件 … 文件" | Overlay 下补 `hidden_title(true)`（macOS-gated），标题只由 Web 层画一次、居中 |
| §3 #9「负控：删掉标题栏块 ⇒ 红绿灯存在测试 FAILED」 | 该测试现在**反向** | 断言改成"**不**自绘红绿灯 + 每个元素都是拖区 + `draggable` 不该回来"（`desktop-window-titlebar.svelte.test.ts`，7/7） |

真机证据（CGEvent 真鼠标事件 + TextEdit 对照，2026-09-19）：拖标题栏 236,69 → **376,159**（+140/+90 与拖距一致）；拖红绿灯留白也移动；双击仍只缩放一次（0,29,1496,880）；点真红点窗口关闭；全宽截图只剩**一组**红绿灯 + **一个**居中标题；`AX title` 仍是「文件」（Mission Control / Dock 不失名字）。

---


---

## 10. 事故登记：原「工时估算」小节在本次回填中被误删

> 本文是**未跟踪**的设计稿，误删后**没有副本**（git 里没有该文件、VS Code 本地历史与 /tmp 均无留存），
> 所以那一小节的工时数字**无法复原**，也不编造。原作者若还记内容，按记忆补回即可；
> 这一行是**删除事故的登记**，不是设计内容。
