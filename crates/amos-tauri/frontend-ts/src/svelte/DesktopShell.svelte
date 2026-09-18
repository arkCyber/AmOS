<script lang="ts">
  // DesktopShell.svelte — 桌面形态顶层 Shell（**浮层容器**，REQ-A262）。
  //
  // 由 Shell.svelte 在 `LayoutSnapshot.form === 'desktop'` 时挂载。
  // 渲染 macOS 风格桌面拓扑：
  //   - TopBar（毛玻璃顶栏，左/右槽位来自注册表）
  //   - DesktopStage（壁纸 + 桌面图标 + stage 槽位 + 右键菜单）
  //   - Dock（毛玻璃 + 放大镜，槽位来自注册表）
  //   - 浮层：**清单来自注册表**，快捷键也来自同一张表
  //
  // 本轮的两处结构性修正：
  //   1. 壳把自己的能力**一次**注入（`SHELL_CHROME_API`），所有槽位共享：挂件要做的
  //      事里有的只有壳能做（锁定屏幕要动 `shellState`），若每个容器各注入一份，
  //      同一套能力就会有两份实现，挂件的行为还会随它被放进哪个槽位而变。
  //   2. 浮层不再是一个 `{#if}` + 一个布尔量，而是 `modulesFor("overlay", …)` 的结果：
  //      **有什么浮层、什么键打开它**都在 `shellModules.ts` 一行里。此前 `⌘Space`
  //      与 `⌘Tab` 写在这个文件的一个 `switch` 里，而 `lib/shellChrome.ts` 的注释却
  //      声称 F4 也绑了——F4 从未绑定。现在那句话是真的，且由表决定。
  //
  // 数据流：
  //   - `LayoutSnapshot` 来自 wm.rs（host authoritative）
  //   - 焦点 app 状态来自 SharedStore（`amos.app_focused`，由顶栏的挂件自己订阅）
  //   - 已打开窗口列表来自 wm_windows 命令（Dock 的运行中指示 / Mission Control）
  //
  // Power of 10 #2：所有几何常量由 lib/desktopLayout.ts 提供；纯函数决策。
  import { onMount, setContext } from "svelte";
  import { bridgeDiag, invoke, onMenuEvent } from "../lib/backend";
  import {
    wmLayoutSnapshot,
    onLayoutChanged,
    wmWindows,
    type LayoutSnapshot,
  } from "../lib/wm";
  import {
    activeSpace,
    listSpaces,
    switchSpace,
    prevSpaceIndex,
    nextSpaceIndex,
  } from "../lib/spaces";
  import { stageRect, DEFAULT_SCREEN } from "../lib/desktopLayout";
  import {
    SHELL_CHROME_API,
    bindingHint,
    modulesFor,
    shortcutMatches,
    type ShellChromeApi,
  } from "../lib/shellModule";
  import { SHELL_MODULES } from "./shellModules";
  import { lock } from "./shellState.svelte";
  import { isDesktopFeatureEnabled, loadDesktopFeatures } from "../lib/desktopFeatures";
  import {
    createKeyboardBindings,
    findMatchingBinding,
    matchesShortcut,
  } from "../lib/keyboardConfigHook.svelte";
  import TopBar from "./TopBar.svelte";
  import Dock from "./Dock.svelte";
  import DesktopStage from "./DesktopStage.svelte";
  import HotCornersListener from "./modules/HotCornersListener.svelte";
  import { t } from "./locale.svelte";

  // ─── 布局状态 ───────────────────────────────────────────────────────────────
  let layoutSnap = $state<LayoutSnapshot | null>(null);
  // Until the host answers, the stage is the *documented* no-measurement screen —
  // `stageRect` already knows that fallback, so the component must not restate the
  // numbers (a second copy of 1440/796 is how a component starts "guessing" geometry
  // the host is supposed to own; `DEFAULT_SCREEN` is the one place they live).
  const stage = $derived(
    layoutSnap
      ? stageRect(layoutSnap.screen_w, layoutSnap.screen_h)
      : stageRect(DEFAULT_SCREEN.width, DEFAULT_SCREEN.height),
  );

  // ─── 浮层：注册表即清单 ─────────────────────────────────────────────────────
  const overlayModules = modulesFor("overlay", SHELL_MODULES);
  /** 打开的浮层 id，**按打开顺序**——最后一个在最上面，Esc 关的也是它（macOS 语义）。 */
  let openOverlays = $state<string[]>([]);

  function openOverlay(id: string) {
    if (!openOverlays.includes(id)) openOverlays = [...openOverlays, id];
  }
  function toggleOverlay(id: string) {
    openOverlays = openOverlays.includes(id)
      ? openOverlays.filter((x) => x !== id)
      : [...openOverlays, id];
  }
  function closeOverlay(id: string) {
    openOverlays = openOverlays.filter((x) => x !== id);
  }

  // ─── 当前焦点 app 窗口（⌘W / ⌘M / ⌘H 这类"作用于焦点窗口"的快捷键要知道是哪个）──
  // 拉自 `wm_windows`：前端只读快照，不"猜"。刷新策略与 Dock 共用"读一次 + 5s 心跳"
  // 一致（避免新增一组定时器），且不阻塞键盘路径：键盘处理函数读一个 ref 而不是 await。
  let focusedWindowLabel = $state<string | null>(null);
  async function refreshFocused() {
    try {
      const snap = await wmWindows();
      if (!snap) return;
      const f = snap.windows.find((w) => w.focused) ?? null;
      focusedWindowLabel = f ? f.label : null;
    } catch {
      /* non-desktop / offline: no focused window */
    }
  }

  // ─── 自定义快捷键绑定（Phase 3）────────────────────────────────────────────
  // 从 localStorage 读取用户配置，与系统默认值合并。注意：浮层快捷键的真源仍是
  // ─── 自定义快捷键绑定（Phase 3）────────────────────────────────────────────
  // 从 localStorage 读取用户配置，与系统默认值合并；**浮层的按键与提示都读这一份**
  // （见 `onKeyDown` 的浮层分支与下面的 `overlayShortcut`），所以"按钮说会开什么"与
  // "按下去开什么"永远同源 —— 这是 REQ-A394 补上的那一半（此前提示读合并结果、
  // 按键读注册表默认值，两者会在用户改过键之后互相矛盾）。
  const keyboardBindings = createKeyboardBindings();
  keyboardBindings.startListening();
  const customSystemBindings = $derived(keyboardBindings.bindings.system);

  // ─── 系统快捷键（macOS 作用于焦点窗口的那一组）────────────────────────
  // 故意与「浮层快捷键」分两层处理：
  //   1) 浮层快捷键走**合并后的** `bindings.overlays`（注册表默认 + 用户覆盖 + `null` 禁用）
  //   2) 系统快捷键（⌘W / ⌘M / ⌘H / ⌘,）走**合并后的** `customSystemBindings`
  //
  // 浮层域的规则书是 `keyboardConfig.mergeOverlayBindings`（触摸壳的准入
  // `systemKeys.ts` 与 ⌘-hold 面板读的也是它）；system / spaces / touch 三个域由
  // `keyboardConfigHook` 的 `resolveBindings` 一处合并（本文件不再自己写一套）。
  //
  // 这些键**仍然**在捕获阶段消费：浮层内若有表单元素拿到焦点，浏览器默认会拦下 ⌘W，
  // 但 Tauri WebView 不一定，而用户的肌肉记忆是"按了 = 关窗"，所以壳直接消费。
  function handleSystemShortcut(e: KeyboardEvent): boolean {
    // 关掉这个能力 ⇒ 与浮层快捷键无关,我们只放行(让 OS / WebView 接管)。这是
    // macOS 真机上 `⌘H` 的场景:用户希望系统"隐藏应用",而不是前端消费。
    if (!isDesktopFeatureEnabled("shortcuts")) return false;

    // 检查自定义绑定的系统快捷键
    for (const [id, shortcut] of customSystemBindings) {
      if (matchesShortcut(shortcut, e)) {
        e.preventDefault();
        e.stopPropagation();
        const label = focusedWindowLabel;
        switch (id) {
          case "closeWindow":
            if (label && label !== "main") void invoke("wm_close", { label });
            return true;
          case "minimizeWindow":
          case "hideApp":
            if (label && label !== "main") void invoke("wm_hide", { label });
            return true;
          case "preferences":
            void invoke("wm_open", { label: "settings" });
            return true;
        }
      }
    }

    return false;
  }

  // ─── 壳注入的把手（一次，给所有槽位）────────────────────────────────────────
  // ids 取自注册表（`shellModules.ts` 的 overlay 行）：`launchpad` / `spotlight` /
  // `control-center-panel`。
  setContext<ShellChromeApi>(SHELL_CHROME_API, {
    openLaunchpad: () => openOverlay("launchpad"),
    openSpotlight: () => openOverlay("spotlight"),
    lockScreen: () => lock(),
    // 提示与按键同源：`bindings.overlays` 就是 `onKeyDown` 里 `findMatchingBinding` 读的那一份
    // （注册表默认 + 用户覆盖 + `null` 禁用），所以改过键的人看到的正是自己那把键。
    overlayShortcut: (overlayId) => bindingHint(keyboardBindings.bindings.overlays.get(overlayId)),
    toggleOverlay: (overlayId) => toggleOverlay(overlayId),
    isOverlayOpen: (overlayId) => openOverlays.includes(overlayId),
  });

  // ─── 快捷键：**使用自定义绑定** ─────────────────────────────────────────────
  // `customSystemBindings`（`keyboardBindings.bindings.system`）是默认值 + 用户覆盖 +
  // `null` 禁用合并后的结果，所以系统域的用户自定义会生效；浮层域见上面的诚实边界。
  // 监听在**捕获阶段**，并且消费掉的键 `stopPropagation()`：浮层自己是可独立挂载的
  // 组件，各自也听 Esc（`Launchpad` / `MissionControl`），而键事件是同一个——
  // 不拦截的话一次 Esc 会把叠在一起的两层一起关掉。
  function onKeyDown(e: KeyboardEvent) {
    // 系统快捷键（⌘W 关窗 / ⌘M 最小化 / ⌘H 隐藏 / ⌘, 偏好）先于浮层快捷键
    if (handleSystemShortcut(e)) return;

    // ─── Spaces 快捷键（**合并后的绑定**）────────────────────────────────────
    // 与浮层 / 系统两域同源：`bindings.spaces` = `SPACES_DEFAULTS` + 用户覆盖 + `null` 禁用，
    // 判据用 `shortcutMatches`（触摸壳的准入与 ⌘-hold 面板读的是同一个匹配器）。
    //
    // 这里原来是**硬编码**（`e.ctrlKey && /^[1-9]$/`、`Ctrl+←/→`、`Ctrl+↑`），后果有三：
    //   • 键盘设置里改过的 Spaces 键在桌面上不生效（浮层域同族缺口，REQ-A394 已修）；
    //   • `Ctrl+↑`（`spacesPanel`）被 `preventDefault + stopPropagation` **吃掉却什么都不做**
    //     —— 注释写着"可以扩展为显示 Spaces 面板"，而注册表那边的注释更进一步，声称它
    //     "由 `DesktopShell` 在面板挂载时派发"。两句都不成立：这一支只有 `return`。
    // 现在按配置派发，`null` 即是"这个键不归壳管"（**不消费**，交给别处）。
    const spacesBindings = keyboardBindings.bindings.spaces;

    // Ctrl+1…9 是**一族**键：这一行给的是修饰符与代表键（`{ key: "1", ctrl: true }`），
    // 数字本身由事件提供 —— 用规范匹配器把代表键换成事件里的那个数字再比一次，
    // 于是用户把修饰符改成 ⌘⇧ 也只改一处，而不是在这里另写一套判断。
    const spacesDirect = spacesBindings.get("spacesDirect");
    if (spacesDirect && /^[1-9]$/.test(e.key) && shortcutMatches(e, { ...spacesDirect, key: e.key })) {
      e.preventDefault();
      e.stopPropagation();
      const index = parseInt(e.key, 10) - 1;
      void (async () => {
        const ok = await invoke<unknown>("spaces_switch", { index });
        if (ok === null) {
          const diag = bridgeDiag("spaces_switch");
          if (!diag.ok) {
            const code =
              diag.kind === "command-failed" &&
              diag.detail &&
              typeof diag.detail === "object"
                ? (diag.detail as { code?: string }).code
                : undefined;
            console.warn(
              `🛟 [DesktopShell] spaces_switch(${index}) refused`,
              code ?? diag.kind,
            );
          }
        }
      })();
      return;
    }

    // 上一个 / 下一个桌面
    const spacesPrev = spacesBindings.get("spacesPrev");
    const spacesNext = spacesBindings.get("spacesNext");
    const step = spacesPrev && shortcutMatches(e, spacesPrev) ? -1 : spacesNext && shortcutMatches(e, spacesNext) ? 1 : 0;
    if (step !== 0) {
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        const spaces = await listSpaces();
        const current = await activeSpace();
        if (!spaces || current === null) return;

        const newIndex =
          step < 0 ? prevSpaceIndex(current, spaces.length) : nextSpaceIndex(current, spaces.length);
        if (newIndex === null || newIndex === current) return;

        const ok = await switchSpace(newIndex);
        if (!ok) {
          console.warn(`[DesktopShell] Failed to switch to space ${newIndex}`);
        }
      })();
      return;
    }

    // 打开 / 关闭 Spaces 面板（默认 ⌃↑）。注册表**故意**不给这一行 `shortcuts`
    // （见 `shellModules.ts` 的 SpacesPanel 块注释：四个浮层启动键的清单是文档化的不变量），
    // 所以这个键来自键盘配置的 `spaces` 域，而不是注册表。
    const spacesPanel = spacesBindings.get("spacesPanel");
    if (spacesPanel && shortcutMatches(e, spacesPanel)) {
      e.preventDefault();
      e.stopPropagation();
      toggleOverlay("spaces-panel");
      return;
    }

    // 浮层快捷键（**合并后的绑定**）：⌘Space/F4/F3/⌘Tab 的默认值来自注册表
    // （`SHELL_MODULES.shortcuts`），用户覆盖与 `null` 禁用来自键盘设置。这里读
    // `keyboardBindings.bindings.overlays` —— 与触摸壳的准入（`systemKeys.ts`）、
    // ⌘-hold 面板都走 `mergeOverlayBindings` 这一本规则书；提示也读同一份
    // （见下面的 `overlayShortcut`），所以"按下会开什么"与"按钮说会开什么"同源。
    const overlayHit = findMatchingBinding(keyboardBindings.bindings.overlays, e);
    if (overlayHit) {
      e.preventDefault();
      e.stopPropagation();
      toggleOverlay(overlayHit.id);
      return;
    }

    // Esc → 关最上面那一层
    if (e.key === "Escape") {
      const top = openOverlays[openOverlays.length - 1];
      if (top) {
        e.preventDefault();
        e.stopPropagation();
        closeOverlay(top);
      }
    }
  }

  /**
   * The listener options: **capture**, so the shell sees a key before the widgets and the
   * focused element do (see `onKeyDown`). Same object for add and remove — a listener
   * removed with a different capture flag is not removed at all.
   */
  const KEY_LISTENER: AddEventListenerOptions = { capture: true };

  onMount(() => {
    window.addEventListener("keydown", onKeyDown, KEY_LISTENER);

    // The two documented shells capability switches (`AMOS_DESKTOP_SHORTCUTS` /
    // `AMOS_DOCK_CONTEXT_MENU`) are read by the **host** at startup — a WebView has no
    // environment of its own, which is why reading them here could never work before
    // (REQ-A287). Ask once, then `lib/desktopFeatures` holds the answer for the
    // shortcut handler below and for the Dock's right-click menu. Until it arrives each
    // capability keeps its documented default ("on"), i.e. what an unset environment means.
    void loadDesktopFeatures();

    // 读取初始 LayoutSnapshot
    void wmLayoutSnapshot().then((s) => {
      if (s) layoutSnap = s;
    });
    // 订阅 host 的 layout-changed 推送
    let stopLayout: () => void = () => {};
    void onLayoutChanged((s) => {
      layoutSnap = s;
    }).then((f) => { stopLayout = f; });

    // 当前焦点窗口（系统快捷键 ⌘W/⌘M/⌘H 的目标）：先读一次，再每 5s 心跳。
    // 心跳频率与 Dock 的"运行中白点"刷新一致——两组读 `wm_windows` 同步进行，
    // 避免再开第三组定时器。
    void refreshFocused();
    const pollId = setInterval(refreshFocused, 5000);

    // Native macOS menu bar (Apple / File / Edit / View / Window / Help).
    // The Rust host installs the global menu at boot and forwards every item
    // activation to the WebView as a `menu-event`.  We map a small subset here
    // (Preferences / New Window / Close Window / Enter Full Screen) so the menu
    // actually does something — items the host handles directly (About, Quit,
    // Hide Amos) only need to refresh the WebView's own UI.
    const stopMenu = onMenuEvent((id) => {
      // Best-effort: log unknown ids but do not throw — a host-only id (e.g.
      // `menu.about`) arrives here too and is meant to be ignored.
      switch (id) {
        case "menu.preferences":
          // ⌘, opens the Settings window (same as the existing ⌘, shortcut).
          void invoke("wm_open", { label: "settings" });
          break;
        case "menu.new-window":
          // New Window on macOS opens a fresh "Finder-like" surface.  We open
          // the Files app as a reasonable default (it's our closest analog).
          void invoke("wm_open", { label: "files" });
          break;
        case "menu.close-window":
          // Close Window closes the **focused** non-shell window.
          const label = focusedWindowLabel;
          if (label && label !== "main") void invoke("wm_close", { label });
          break;
        case "menu.minimize":
          // ⌘M hides the focused window (mirrors ⌘M on the focused window).
          const mlabel = focusedWindowLabel;
          if (mlabel && mlabel !== "main") void invoke("wm_hide", { label: mlabel });
          break;
        case "menu.zoom":
          // Tauri windows don't expose a "zoom" (toggle max size) call here;
          // fall back to maximize which is the closest platform-neutral analog.
          const zlabel = focusedWindowLabel;
          // No `wm_zoom` — leave as a no-op for now.
          if (zlabel) { /* intentional */ }
          break;
        case "menu.enter-fullscreen":
          // Toggle fullscreen on the focused window (the platform toggles).
          // Tauri's per-window toggle is `is_fullscreen` → not exposed as a
          // command yet; the user can still use macOS's native green button.
          break;
        case "menu.show-all":
          // "Show All" mirrors "unhide all" — unhide every hidden window.
          // `WmWindowInfo.state` is one of "Hidden" | "Shown" | "Focused"
          // (the host's own spelling — see lib/wm.ts).
          void wmWindows().then((snap) => {
            if (!snap) return;
            for (const w of snap.windows) {
              if (w.state === "Hidden") void invoke("wm_focus", { label: w.label });
            }
          });
          break;
        default:
          // Host-handled (about / quit / hide-amos) — nothing to do here.
          break;
      }
    });
    // Cleanup is returned from `onMount` (Svelte runs it on destroy) — the canonical
    // shape. The earlier version registered it with `onDestroy(...)` *inside* this
    // callback, which is a lifecycle call from outside the component's init phase;
    // measured in Svelte 5.57 that still runs (`onDestroy` is literally
    // `onMount(() => () => fn())`), so this is clarity, not a leaked listener. The
    // property itself is pinned by `desktop-shell.svelte.test.ts` ("unmount releases
    // EVERY window listener"), whose negative control — deleting this block — fails.
    //
    // The two `desktop:*` window events are gone (REQ-A262): the stage used to talk to
    // the shell through `desktop:placeholder` (which this file answered with an empty
    // handler) and the Dock/Dock's launchpad through `desktop:open-launchpad`. Both
    // became chrome-handle calls, so there is one channel instead of three.
    return () => {
      window.removeEventListener("keydown", onKeyDown, KEY_LISTENER);
      keyboardBindings.stopListening();
      stopLayout();
      clearInterval(pollId);
      stopMenu();
    };
  });
</script>

<!--
  桌面 Shell 容器：
  - 100vw × 100vh，深色背景
  - TopBar 在最上层（永远可见）
  - DesktopStage（壁纸 + 桌面图标 + stage 槽位 + 右键菜单）
  - Dock 在底部
  - 浮层按需叠加（清单与快捷键都来自注册表）
-->

<!-- 跳过导航链接 (WCAG 2.4.1) -->
<a
  href="#main-content"
  class="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[9999] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-white focus:shadow-lg focus:outline-none"
>
  {t("a11y.skipToMain")}
</a>

<div
  class="relative h-full w-full overflow-hidden font-system"
  style="
    background: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif;
  "
>
  <!-- 桌面舞台（壁纸 + 桌面图标 + stage 槽位 + 右键菜单） -->
  <div
    id="main-content"
    tabindex="-1"
    class="absolute"
    style="
      left:{stage.x}px;
      top:{stage.y}px;
      width:{stage.width}px;
      height:{stage.height}px;
    "
  >
    <DesktopStage />
  </div>

  <!-- 顶部 TopBar -->
  <div class="absolute left-0 right-0 top-0 z-30">
    <TopBar />
  </div>

  <!-- 底部 Dock -->
  <Dock />

  <!-- 浮层：每一层都是注册表里的一行（`onclose` 由壳交给它）
       z 序按**打开顺序**给：最后打开的在上。此前每个浮层自带写死的 z-index
       （launchpad z-50 / spotlight·mission z-100），于是"后开的在上面"只在恰好对上
       那对组合时成立——用户看到的层级取决于组件的 class，而不是他打开的顺序。 -->
  {#each openOverlays as id, index (id)}
    {@const overlay = overlayModules.find((m) => m.id === id)}
    {#if overlay}
      {@const Overlay = overlay.component}
      <div
        class="pointer-events-none absolute inset-0"
        style="z-index: {100 + index};"
        data-testid="overlay-layer"
        data-overlay={id}
      >
        <Overlay onclose={() => closeOverlay(id)} />
      </div>
    {/if}
  {/each}

  <!-- Hot Corners Listener (global mousemove handler) -->
  <HotCornersListener />
</div>

