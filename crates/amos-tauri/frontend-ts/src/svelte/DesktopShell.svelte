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
    wmOpen,
    wmHide,
    wmZoom,
    wmFullscreen,
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
  import { wallpaperFallbackColor } from "../lib/wallpaper";
  import {
    BRIGHTNESS_KEY,
    brightnessToAlpha,
    normalizeBrightness,
  } from "../lib/brightness";
  import {
    actionableLabelOf,
    deadChordMessage,
    refusedChordMessage,
    runSystemIntent,
    systemIntentFor,
    type DesktopSystemIntent,
  } from "./desktopSystemKeys";
  import { amosWarn } from "../lib/debugLog";
  import { handOverSystemKeys } from "../lib/earlySystemKeys";
  import {
    SHELL_CHROME_API,
    bindingHint,
    modulesFor,
    shortcutMatches,
    topOverlay,
    type ShellChromeApi,
    type ShellWindowAction,
  } from "../lib/shellModule";
  import { SHELL_MODULES } from "./shellModules";
  import { lock } from "./shellState.svelte";
  import { isDesktopFeatureEnabled, loadDesktopFeatures } from "../lib/desktopFeatures";
  import { isSelectAllChord, selectAllInFocus } from "../lib/editKeys";
  import {
    createKeyboardBindings,
    findMatchingBinding,
    matchesShortcut,
  } from "../lib/keyboardConfigHook.svelte";
  import TopBar from "./TopBar.svelte";
  import Dock from "./Dock.svelte";
  import DesktopStage from "./DesktopStage.svelte";
  import DesktopNotificationBanner from "./DesktopNotificationBanner.svelte";
  import HotCornersListener from "./modules/HotCornersListener.svelte";
  import { createStoreValue } from "./store";
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
  /** The registered overlay ids — what `topOverlay` filters the open stack by (REQ-A415). */
  const overlayIds = overlayModules.map((m) => m.id);
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

  // ─── G-β-1 · 屏幕降亮（WebView 内）────────────────────────────────────────
  // 仓内**唯一**真源是 `lib/brightness.ts::brightnessToAlpha(pct)`：slider 写到
  // `amos.brightness` store，shell 订阅同一个 store 然后渲染一个黑色遮罩。
  // 遮罩是 `pointer-events: none` 不抢事件；z=80 在 stage / banner (90) / 浮层 (100+)
  // 之间 —— Mission Control / Spotlight / 控制中心 **不会**被暗化（用户开浮层时
  // 要看清内容，不该被压一层黑）。
  const brightnessStore = createStoreValue<unknown>(BRIGHTNESS_KEY, {});
  let brightnessPct = $state<number>(100);
  $effect(() => {
    const un = brightnessStore.subscribe((v) => {
      brightnessPct = normalizeBrightness(v).pct;
    });
    return un;
  });
  const brightnessAlpha = $derived(brightnessToAlpha(brightnessPct));

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
  /**
   * Re-ask the host for the focused window, then act — the fallback for a chord whose
   * target the 5 s poll did not know yet (REQ-A424).
   *
   * Measured on this machine, 2026-09-18: with the launcher focused, ⌘N opened the Files
   * window and ⌘W pressed a few seconds later closed **nothing** — the polled label was
   * read before that window existed. Invoking File ▸ Close Window by hand, a second later,
   * closed it immediately (same host code: `menu.rs::close_key_window`), which is what
   * proved the target was there to be found and the staleness was the whole defect. The
   * key's own path stays synchronous (the poll answer is used when it is actionable, so a
   * normal press never waits on IPC); only the empty answer pays for a fresh read.
   */
  async function resolveFocusedThen(intent: DesktopSystemIntent): Promise<void> {
    await refreshFocused();
    const outcome = await runSystemIntent(intent, actionableLabelOf(focusedWindowLabel));
    if (outcome.reason) {
      // Nothing to act on even after asking — or the host refused. Say which, instead of
      // leaving the user pressing a key that is silently a no-op (REQ-A424/REQ-A430).
      amosWarn(
        "shell",
        outcome.reason === "host-refused"
          ? refusedChordMessage(intent, actionableLabelOf(focusedWindowLabel))
          : deadChordMessage(intent),
        { reason: outcome.reason },
      );
    }
  }

  /**
   * Run a system intent for a target the poll already knew, and report a **refusal**
   * (`host-refused`) — the other way a chord can die (REQ-A430). The caller's key path stays
   * synchronous; only the reporting waits for the host's answer.
   */
  async function reportIntentOutcome(intent: DesktopSystemIntent, label: string): Promise<void> {
    const outcome = await runSystemIntent(intent, label);
    if (outcome.reason === "host-refused") {
      amosWarn("shell", refusedChordMessage(intent, label), { reason: outcome.reason });
    }
  }

  function handleSystemShortcut(e: KeyboardEvent): boolean {
    // 关掉这个能力 ⇒ 与浮层快捷键无关,我们只放行(让 OS / WebView 接管)。这是
    // macOS 真机上 `⌘H` 的场景:用户希望系统"隐藏应用",而不是前端消费。
    if (!isDesktopFeatureEnabled("shortcuts")) return false;

    // 检查自定义绑定的系统快捷键。**意图表与派发**住在 `svelte/desktopSystemKeys.ts`
    // ——应用窗口的 `DesktopWindowKeys` 读的是同一张表（REQ-A419：应用窗口在 A416 之后
    // 不再挂载本组件，⌘W 在它自己身上失效过）。
    for (const [id, shortcut] of customSystemBindings) {
      const intent = systemIntentFor(id);
      if (!intent) continue; // 不是"作用于焦点窗口"的键 ⇒ 不归这一层管
      if (matchesShortcut(shortcut, e)) {
        e.preventDefault();
        e.stopPropagation();
        // `main`（启动器）永远不是目标：关掉它等于关掉整个桌面（F-SH-008）。
        const target = actionableLabelOf(focusedWindowLabel);
        // The key's own path stays synchronous (a normal press never waits on IPC): the
        // polled answer is used when it is actionable, and only the **empty** answer pays for
        // a fresh read (REQ-A424). Both paths report a host refusal (REQ-A430).
        if (target) void reportIntentOutcome(intent, target);
        else void resolveFocusedThen(intent);
        return true;
      }
    }

    return false;
  }

  /**
   * Run a "acts on the focused window" menu action and **say so when the host refuses**.
   *
   * REQ-A415: `menu.zoom` / `menu.enter-fullscreen` used to be explicit no-ops (macOS
   * users press Zoom and nothing happened). Now they act — and a refusal is reported with
   * the host's own typed code instead of silence: the window may have been closed since
   * the 5 s `wm_windows` poll (a stale label is the normal case), and a split pane is
   * refused on purpose because its rectangle belongs to the split. A menu that closes
   * with nothing changing is exactly the shape the typed-error discipline removes.
   */
  async function windowMenuAction(
    run: () => Promise<boolean>,
    command: string,
    label: string,
  ): Promise<void> {
    if (await run()) return;
    const diag = bridgeDiag(command);
    if (diag.ok) {
      // The command reported a failure but the ledger's last word on it is "fine" — say
      // what is actually known instead of inventing a code we did not observe.
      console.warn(`🛟 [DesktopShell] ${command}(${label}) did not land`, diag);
      return;
    }
    const code =
      diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    console.warn(`🛟 [DesktopShell] ${command}(${label}) refused`, code ?? diag.kind);
  }

  /**
   * Zoom / Enter Full Screen on the **focused app window** — one implementation (REQ-A457).
   *
   * Both menu surfaces call this: the native macOS menu arrives as a `menu-event` from the host
   * (`menu.zoom` / `menu.enter-fullscreen`, REQ-A415) and the in-app topbar menu asks through
   * `SHELL_CHROME_API.windowAction`. They used to hold two copies of this decision — the same
   * command, two places to keep in step — which is exactly how the in-app menu ended up still
   * painting 缩放 / 进入全屏幕 as *unavailable* while the host command and the native item were
   * both live (and on a platform with no native menu bar, the in-app rows are the **only** menu,
   * so those commands were unreachable from any menu there).
   *
   * The target comes from the shell's own poll, and neither the launcher (`main` — it *is* the
   * desktop, F-SH-008) nor "nothing focused" is a target: nothing is sent, and no window is
   * resized as a guess.
   */
  function applyWindowAction(action: ShellWindowAction): void {
    const label = focusedWindowLabel;
    if (!label || label === "main") return;
    if (action === "zoom") {
      void windowMenuAction(() => wmZoom(label), "wm_zoom", label);
    } else {
      void windowMenuAction(() => wmFullscreen(label), "wm_fullscreen", label);
    }
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
    windowAction: (action) => applyWindowAction(action),
  });

  // ─── 快捷键：**使用自定义绑定** ─────────────────────────────────────────────
  // `customSystemBindings`（`keyboardBindings.bindings.system`）是默认值 + 用户覆盖 +
  // `null` 禁用合并后的结果，所以系统域的用户自定义会生效；浮层域见上面的诚实边界。
  // 监听在**捕获阶段**，并且消费掉的键 `stopPropagation()`：浮层自己是可独立挂载的
  // 组件，各自也听 Esc（`Launchpad` / `MissionControl`），而键事件是同一个——
  // 不拦截的话一次 Esc 会把叠在一起的两层一起关掉。
  function onKeyDown(e: KeyboardEvent) {
    // ⌘A first, and **outside** the shortcuts switch: this is a text-editing gesture the OS
    // never delivers here (see `lib/editKeys.ts` for the measurements), not one of our desktop
    // shortcuts — with `AMOS_DESKTOP_SHORTCUTS=disabled` a field must still be selectable.
    if (isSelectAllChord(e) && selectAllInFocus()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

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
      // REQ-A415: ask the registry which layer is really on top. `openOverlays` can hold
      // an id no row declares (a typo — the structural gate in `shellModule.test.ts` is
      // what stops new ones); such a layer draws nothing, so closing the raw last entry
      // would swallow the press and leave the *visible* panel up.
      const top = topOverlay(openOverlays, overlayIds);
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
    // REQ-A431: the shell owns the system chords from here on — the boot-time listener that
    // `shell-entry.ts` installed (covering the seconds before this component mounted) stands
    // down, so a chord is never double-handled.
    handOverSystemKeys();

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
    // (Preferences / New Window / Close Window / Zoom / Enter Full Screen) so the menu
    // actually does something — the items the **host** owns (About, Quit, Hide Amos,
    // Hide Others, Show All) never arrive here: they are terminal in `menu.rs`, so a
    // second implementation of them in the shell cannot drift from the native one
    // (REQ-A423 moved `show-all` there, which is also where macOS defines it).
    const stopMenu = onMenuEvent((id) => {
      // Best-effort: log unknown ids but do not throw — a host-only id (e.g.
      // `menu.about`) arrives here too and is meant to be ignored.
      switch (id) {
        case "menu.preferences":
          void wmOpen("settings");
          break;
        case "menu.new-window":
          // The **Files** window, and the native item's label says exactly that ("New Files
          // Window", REQ-A434) — the two must not drift: a shell has no "current app" window
          // to duplicate (the host keeps one window per label), so "New Window" was a promise
          // the item could not keep.
          void wmOpen("files");
          break;
        case "menu.minimize":
          const mlabel = focusedWindowLabel;
          if (mlabel && mlabel !== "main") void wmHide(mlabel);
          break;
        case "menu.zoom":
          // REQ-A415 wired this branch (it used to be an explicit no-op: "No `wm_zoom` —
          // leave as a no-op for now"). REQ-A457 moved the body into `applyWindowAction`,
          // which the in-app menu rows now call too — one implementation, so the two menu
          // surfaces cannot describe the same command differently.
          applyWindowAction("zoom");
          break;
        case "menu.enter-fullscreen":
          applyWindowAction("full-screen");
          break;
        default:
          // Host-owned and terminal in `menu.rs` (about / quit / hide-amos / hide-others
          // / show-all): it forwards them for symmetry, and there is nothing to do here.
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

<!--
  G-DesktopShell · 桌面背景 fallback 不再是死黑（`#1a1a1a` → macOS 中性灰）。

  颜色字面值的**唯一**真源是 lib/wallpaper.ts::wallpaperFallbackColor（被
  src/__tests__/wallpaper.test.ts 的两条结构性负控钉住）—— 不允许这里写第二份。
  Svelte 把 `{wallpaperFallbackColor(true)}` 渲染为 `background: #1e1e1e`
  （dark 默认 —— 仓内默认是 dark 主题，与 `lib/wallpaper.ts::resolveWallpaper`
  的默认分支一致）；light 值在下面的 `<style>` 块用 CSS 媒体查询覆盖 —— 跟随 OS
  的 prefers-color-scheme（与 Backdrop 用 `themeDark()` 跟随用户主题偏好同源
  语义：Backdrop 跟「用户的选择」，根容器跟「OS 级偏好」，二者产生同一 dark 值的
  判据，不重复计算同一件事）。这样**任何**时机整个屏幕都不会出死黑，包括：
    (1) Backdrop 还没挂载（首帧 / 切回桌面）
    (2) 壁纸图加载失败（离线 / 路径错）
    (3) stage 之外（理论上不存在 —— 但若 host 答 screen_w < 实际宽度时
        stage 之外也会出 fallback）
-->
<div
  class="relative h-full w-full overflow-hidden font-system"
  style="background: {wallpaperFallbackColor(true)}; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif;"
  data-testid="desktop-shell-root"
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

  <!-- G-γ · 桌面通知 banner（macOS 右上角 toast）
       z=90：高于 stage / topbar / dock（≤30），低于注册表浮层（=100+），且**不**进
       `{#each openOverlays}` —— banner 是 ambient 的（用户没主动叫起），浮层是
       modal 的（用户主动叫起），混进同一容器会让 "Esc 关最上" 的规则把 banner 也关掉。

       与 phone 形态的 `NotificationBanner` **完全同源**（同一份 `lib/settings.ts`
       纯函数），所以两条路径不会有「同一个通知在 PC 上停留 4.2s，在手机上停留别
       的时长」的 UX 分裂。详见 `docs/DESKTOP_NOTIFICATION_BANNER_G_GAMMA.md`。 -->
  <DesktopNotificationBanner />

  <!-- G-β-1 · 屏幕降亮遮罩（仅 WebView 内容；不控制系统亮度）
       z=80：高于 stage / topbar / dock（≤30），**低于** 通知 banner（=90）与
       注册表浮层（=100+）—— 用户开 Mission Control / Spotlight / 控制中心时**不**
       被压一层黑（浮层自己有自己的 backdrop 与深色玻璃，遮罩叠上去反而看不清）。
       `pointer-events: none` 不抢事件；alpha=0 时**不渲染**（避免无意义的额外层）。 -->
  {#if brightnessAlpha > 0}
    <div
      class="pointer-events-none fixed inset-0 z-[80] bg-black"
      style="opacity: {brightnessAlpha}"
      data-testid="brightness-overlay"
      data-brightness-pct={brightnessPct}
      aria-hidden="true"
    ></div>
  {/if}

  <!-- Hot Corners Listener (global mousemove handler) -->
  <HotCornersListener />
</div>

