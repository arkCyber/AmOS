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
  import { bridgeDiag, onMenuEvent } from "../lib/backend";
  import {
    wmLayoutSnapshot,
    wmOpen,
    wmSnapWithDiag,
    wmZoom,
    wmFullscreen,
    onLayoutChanged,
    wmWindows,
    focusedAppOf,
    focusedWindowOf,
    missionControlWindows,
    windowsOfApp,
    menuSetShortcuts,
    type LayoutSnapshot,
    type WmWindowsSnapshot,
  } from "../lib/wm";
  import { snapRefusal, snapZoneFor, type SnapZone } from "../lib/snapZones";
  // REQ-A1568: the Stage Manager chord and its keycap. The commands are `lib/stage.ts`;
  // this is the front door that makes them reachable (the rail only exists once the mode
  // is on).
  import { isStageToggleChord, stageToggleRefusal } from "../lib/stageKeys";
  import { stageArrange, stageFailure, stageSetEnabled, stageSnapshot } from "../lib/stage";
  import { subscribeWmWindows } from "../lib/wmWindowsPoll";
  import { nativeAcceleratorPayload } from "../lib/desktopKeys";
  import {
    activeSpace,
    listSpaces,
    switchSpace,
    spacesFailure,
    announceSpacesChanged,
    prevSpaceIndex,
    nextSpaceIndex,
  } from "../lib/spaces";
  import { TrackpadSwipeTracker } from "../lib/trackpad";
  import {
    stageRect,
    DEFAULT_SCREEN,
    shouldShowAppExpose,
    shouldShowMissionControl,
  } from "../lib/desktopLayout";
  import { wallpaperFallbackColor } from "../lib/wallpaper";
  import {
    BRIGHTNESS_KEY,
    brightnessToAlpha,
    normalizeBrightness,
  } from "../lib/brightness";
  import {
    actionableLabelOf,
    appExposeRefusal,
    deadChordMessage,
    missionControlRefusal,
    refusedChordMessage,
    runSystemIntent,
    systemIntentFor,
    type DesktopSystemIntent,
    type SystemIntentOptions,
  } from "./desktopSystemKeys";
  import { amosWarn } from "../lib/debugLog";
  import { handOverSystemKeys } from "../lib/earlySystemKeys";
  // REQ-A869: File ▸ Print… / ⌘P. The *host* prints (see `lib/print.ts` for why a DOM-level
  // `window.print()` here would print the launcher — this component mounts in the launcher).
  import { printDocumentWithDiag, printRefusalMessage } from "../lib/print";
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
  import StageRail from "./StageRail.svelte";
  import DesktopNotificationBanner from "./DesktopNotificationBanner.svelte";
  import HotCornersListener from "./modules/HotCornersListener.svelte";
  import { createStoreValue } from "./store";
  import { t } from "./locale.svelte";
  import type { StoreTile } from "../lib/storeApps";

  // ─── 已安装的商店应用（REQ-A1179）─────────────────────────────────────────────
  // 桌面壳画的 `layout` 和触屏主屏是**同一份**，所以它也必须能画出商店应用的瓷砖：Dock、
  // 启动台、桌面图标区、Spotlight 都要。瓷砖列表由壳（`Shell.svelte`）**推下来**——它才是
  // `loadStoreTiles()` 的唯一调用者（见 `lib/storeApps` 的文件头），而加载是异步的：各面
  // 自己去读模块缓存就会在挂载时读到空表，此后再也不刷新（这正是 REQ-A1137 那一族）。
  let { ext = [] }: { ext?: readonly StoreTile[] } = $props();

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
  // The Stage Manager rail's width, in **one** reading: the host reports it on the layout
  // snapshot (`LayoutSnapshot::rail_width`) and this shell hands the same number to the
  // rail (`StageRail`) and to the desktop icon grid (`DesktopStage`). A second derivation
  // over here — re-reading `stage_snapshot` for it — is how the strip and the icons come
  // to disagree about where the stage starts. `0` until the host answers, and `0` forever
  // on a class with no rail.
  const railWidth = $derived(layoutSnap?.rail_width ?? 0);

  // ─── 浮层：注册表即清单 ─────────────────────────────────────────────────────
  const overlayModules = modulesFor("overlay", SHELL_MODULES);
  /** The registered overlay ids — what `topOverlay` filters the open stack by (REQ-A415). */
  const overlayIds = overlayModules.map((m) => m.id);
  /** 打开的浮层 id，**按打开顺序**——最后一个在最上面，Esc 关的也是它（macOS 语义）。 */
  let openOverlays = $state<string[]>([]);

  /**
   * Why an overlay may not be **opened** right now — or `null` when it may.
   *
   * One owner for the whole question, because **three doors** reach the same primitive: the
   * overlay chord (⌘Space / F4 / F3 / ⌘Tab), the ⌃↓ App Exposé chord, and the hot corners
   * (`HotCornersListener` → `ShellChromeApi.toggleOverlay`). A rule written at one *call site*
   * is a rule the other two bypass — which is exactly what happened: REQ-A1046 guarded the
   * **keyboard** path for Mission Control, and the default top-left hot corner kept opening the
   * same empty layer straight through `toggleOverlay` (F-SH-363).
   *
   * Only a layer whose component can draw **nothing** needs a rule; every other registered row
   * always draws, so it falls through as `null`. The refusal is returned (not warned here) so the
   * caller that has a name for the surface can report it in the ledger.
   */
  function openRefusal(id: string): { message: string; detail: Record<string, number> } | null {
    // Mission Control draws only with ≥2 application windows (`shouldShowMissionControl` is the
    // panel's own gate — the same rule, one owner) — below that it renders nothing, yet the id
    // would still enter `openOverlays`, and `topOverlay` counts every *declared* row as the top of
    // the stack, so that invisible layer swallows the next Escape (the REQ-A415 shape).
    if (id === "mission-control" && !shouldShowMissionControl(openWindowCount)) {
      return { message: missionControlRefusal(openWindowCount), detail: { windows: openWindowCount } };
    }
    // App Exposé tiles the focused **app**; with fewer than two of its windows there is nothing
    // to tile (REQ-A476 — macOS shows nothing here too, and we say so).
    if (id === "app-expose" && !shouldShowAppExpose(focusedAppWindowCount)) {
      return {
        message: appExposeRefusal(focusedAppWindowCount),
        detail: { windows: focusedAppWindowCount },
      };
    }
    return null;
  }

  /**
   * Push a layer — **the** one place that decides whether a layer may be pushed. Refuses (and
   * reports why) when `openRefusal` says there is nothing to show, so every door gets the same
   * answer. Returns whether the layer is now open.
   */
  function openOverlay(id: string): boolean {
    if (openOverlays.includes(id)) return true;
    const refusal = openRefusal(id);
    if (refusal) {
      amosWarn("shell", refusal.message, refusal.detail);
      return false;
    }
    openOverlays = [...openOverlays, id];
    return true;
  }
  function toggleOverlay(id: string): boolean {
    if (openOverlays.includes(id)) {
      closeOverlay(id);
      return true;
    }
    return openOverlay(id);
  }
  function closeOverlay(id: string) {
    openOverlays = openOverlays.filter((x) => x !== id);
  }

  // ─── 当前焦点 app 窗口（⌘W / ⌘M / ⌘H 这类"作用于焦点窗口"的快捷键要知道是哪个）──
  // 拉自 `wm_windows`：前端只读快照，不"猜"。刷新策略与 Dock 共用"读一次 + 5s 心跳"
  // 一致（避免新增一组定时器），且不阻塞键盘路径：键盘处理函数读一个 ref 而不是 await。
  let focusedWindowLabel = $state<string | null>(null);
  /**
   * How many windows the **focused application** has (REQ-A476).
   *
   * The per-app features need the *app's* count, not the total: ⌘` cycles within it and App
   * Exposé tiles it, and both are no-ops with fewer than two windows. Read from the same
   * snapshot as the label, so the two answers cannot come from different moments (a count
   * from one poll and a label from another is how ⌘N would target the previous app).
   */
  let focusedAppWindowCount = $state(0);
  /**
   * How many application windows are on screen in total (F-SH-361).
   *
   * Mission Control switches between *every* application's windows (unlike App Exposé, which
   * tiles the focused one), and with fewer than two there is nothing to switch between — so the
   * shell has to answer that question **before** opening the layer. Read from the same snapshot
   * as the two fields above, through the same predicate the panel draws with
   * ([`missionControlWindows`]): a second rule here is how a layer opens for a list the panel
   * then refuses to draw, leaving an invisible layer on top of the stack.
   */
  let openWindowCount = $state(0);

  /** Fold one window-list answer into the shell's focus state (a `null` snapshot keeps the
   *  last known focus rather than blanking it — the host simply could not answer). */
  function applyWindowsSnapshot(snap: WmWindowsSnapshot | null): void {
    if (!snap) return;
    const f = focusedWindowOf(snap);
    focusedWindowLabel = f ? f.label : null;
    const app = focusedAppOf(snap);
    focusedAppWindowCount = app ? windowsOfApp(snap, app).length : 0;
    openWindowCount = missionControlWindows(snap).length;
  }

  /** A **fresh** read, for the paths that cannot trust the shared poll's last tick (⌘W/⌘N
   *  pressed a moment after a window appeared — REQ-A424). The steady-state heartbeat is the
   *  shared one ([`subscribeWmWindows`]), so the desktop is not polled twice per 5 s. */
  async function refreshFocused(): Promise<void> {
    applyWindowsSnapshot(await wmWindows());
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

  /**
   * Tell the **host's menu bar** what the shell's bindings are (REQ-A485).
   *
   * The native bar is AppKit's, built with literal accelerators (`CmdOrCtrl+N` in `menu.rs`), so it
   * cannot see the user's config on its own — the same shape as the menu *language*, which the shell
   * pushes with `menuSetLocale` when it changes (REQ-A437). Without this, rebinding or disabling a
   * chord left the native row advertising a key the shell no longer matched: the defect the
   * in-window menus had (F-SH-038), on the surface a user reads first.
   *
   * Runs whenever the merged bindings change (and once at mount, so a config that was changed in an
   * earlier session is mirrored too). A host that applied fewer rows than it was given, or a call
   * that failed, is **reported** — a menu row keeping a stale chord is exactly the kind of thing
   * nobody would think to look at.
   */
  $effect(() => {
    const payload = nativeAcceleratorPayload(customSystemBindings);
    // **Rows asked about**, not rows carrying a chord (REQ-A487). A `null` is a *request to clear*:
    // the host counts the clearing as work done (`menu.rs::apply_accelerators` treats
    // `set_accelerator(None)` as applied, and its own warning compares against the payload's length),
    // so counting only the non-null entries made this comparison fire on a host that had done exactly
    // what it was asked — reported as `{"sent":4,"applied":5}`, i.e. "synced fewer" while syncing
    // more. One disabled binding was enough to trigger it on every mount, which is how a real stale
    // chord would come to be read as noise.
    const sent = Object.keys(payload).length;
    void menuSetShortcuts(payload)
      .then((applied) => {
        if (applied !== null && applied !== sent) {
          amosWarn("shell", "the host synced fewer menu accelerators than the shell sent", {
            sent,
            applied,
          });
        }
      })
      .catch((err: unknown) => {
        amosWarn("shell", "the host did not accept the shell's key bindings", { error: String(err) });
      });
  });

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
  async function resolveFocusedThen(
    intent: DesktopSystemIntent,
    options: SystemIntentOptions = {},
  ): Promise<void> {
    await refreshFocused();
    const outcome = await runSystemIntent(intent, actionableLabelOf(focusedWindowLabel), options);
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
  async function reportIntentOutcome(
    intent: DesktopSystemIntent,
    label: string | null,
    options: SystemIntentOptions = {},
  ): Promise<void> {
    const outcome = await runSystemIntent(intent, label, options);
    if (outcome.reason === "host-refused") {
      amosWarn("shell", refusedChordMessage(intent, label), { reason: outcome.reason });
    }
  }

  /**
   * Send one snapping chord: `wm_snap` on the focused window, and **say why** when the host
   * refuses (REQ-A430's discipline — a chord that silently does nothing is indistinguishable
   * from a broken one, and snapping has several refusal reasons a user cannot guess: a
   * non-desktop class, a window that was closed since the poll, a pane of the active split).
   */
  async function runSnap(label: string, zone: SnapZone): Promise<void> {
    const outcome = await wmSnapWithDiag(label, zone);
    if (outcome.ok) return;
    const diag = outcome.diag;
    // `WmReplyDiag` also carries an `{ ok: true }` member (the "the call truly returned, read
    // the ledger" shape `WindowPage` maps), so narrow before reading `kind` —
    // `wmSnapWithDiag` fills one of the three **failure** kinds itself.
    if (diag.ok) return;
    amosWarn("shell", snapRefusal(zone, "host-refused"), { label, reason: diag.kind });
  }

  /**
   * Snap the focused window to the region a `⌃⌥` chord named (`lib/snapZones.ts`).
   *
   * Same target rule as every other focused-window chord: the launcher is never a target
   * (F-SH-008), and an **empty** poll answer pays for one fresh read before the shell gives
   * up (REQ-A424) — a window that opened a moment ago is the normal case for a *snap* right
   * after launching an app. The key's own path never waits on IPC otherwise.
   */
  function snapFocused(zone: SnapZone): void {
    const target = actionableLabelOf(focusedWindowLabel);
    if (target) {
      void runSnap(target, zone);
      return;
    }
    void (async () => {
      await refreshFocused();
      const fresh = actionableLabelOf(focusedWindowLabel);
      if (fresh) void runSnap(fresh, zone);
      else amosWarn("shell", snapRefusal(zone, "no-window"), { zone });
    })();
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
        //
        // REQ-A473: ⌘` carries a direction — plain = next, with Shift = previous — read from
        // the event here, because this is the only layer that has it.
        const options = { forward: !e.shiftKey };
        if (target) void reportIntentOutcome(intent, target, options);
        else void resolveFocusedThen(intent, options);
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
   *
   * REQ-A1846: the report goes to the **ledger** (`amosWarn("shell", …)`), not to a bare
   * `console.warn` — which is what this function used to do, and it was the only refusal path
   * in this file that did. `debugLog.ts`'s header names the anti-pattern by name ("every
   * failure path inventing its own `console.warn` that nobody can retrieve later"): on a device
   * with no devtools console a `console.warn` is silence, and it is gone after a reload, while
   * the ring is what Settings ▸ AI reads back. The same intent's **chord** path already reports
   * there (`reportIntentOutcome` → `refusedChordMessage` → `amosWarn`), so one action must not
   * be described one way by the keyboard and another by the menu bar — and on macOS the menu
   * bar *is* the door: `menu.rs` gives the native Preferences item the `CmdOrCtrl+,`
   * accelerator, so `menu.preferences` is what fires and this reporter is the only one that ran.
   *
   * The sentence stays command-shaped (`wm_open(settings) refused`) rather than borrowing
   * `refusedChordMessage`, which names a **chord** the user did not press.
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
      amosWarn("shell", `${command}(${label}) did not land`, { surface: "menu" });
      return;
    }
    const code =
      diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    amosWarn("shell", `${command}(${label}) refused`, { reason: code ?? diag.kind });
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

  /**
   * Ask the host to print the **focused app window** (File ▸ Print… / ⌘P — REQ-A869).
   *
   * The shell does **not** resolve the window here, unlike [`applyWindowAction`]: the host
   * resolves it itself (`wm::focused_app_label`, the same rule ⌘W uses), so this is a plain
   * zero-argument command call. That is deliberate — the shell could not name the right window
   * even if it wanted to: `window.print()` acts on *this* document, and this component lives in
   * the launcher, so a DOM-level print from either menu surface would print the desktop.
   *
   * Only the **refusal** is logged here, with the sentence for the reason it carries
   * ([`printRefusalMessage`] names all three `amos.print.*` codes), on the same `amosWarn`
   * channel every other menu refusal uses. Success is deliberately silent, and it is not
   * silence by omission: `ok` means *the platform was asked*, never *a page printed*
   * (`print.rs` records why `print()` returning `Ok(())` is not a verdict), and the host
   * already writes that line itself. A shell-side "printed `files`" would be a claim neither
   * side can make, and it would put a success on a ledger whose reader is for warnings.
   */
  async function printFocused(): Promise<void> {
    const outcome = await printDocumentWithDiag();
    if (outcome.ok) return;
    const diag = outcome.diag;
    // `BridgeDiag` also carries an `{ ok: true }` member: the "the call truly returned, read
    // the ledger" shape, which is what `invoke` records when it resolves `null` **without**
    // throwing. For a command that answers an object (`print::PrintRequest`), that can only be
    // a wire violation — so it is named rather than dropped, which is the one thing an
    // early `return` here would do (`runSnap` may return quietly because its command *does*
    // answer `null` for a legitimate reason).
    if (diag.ok) {
      amosWarn(
        "shell",
        "the host answered the print command with null; `print_document` answers an object, so this is a wire violation (see the diagnostic log)",
      );
      return;
    }
    amosWarn("shell", printRefusalMessage(diag), { reason: diag.kind });
  }

  /**
   * Run a focused-window intent (File ▸ Close Window / Window ▸ Minimize) on the shell's
   * own path — the *same* one the ⌘W / ⌘M chords take, so the menu row and the key cannot
   * disagree about the target (this is what the two rows lost when they sent an empty label:
   * the host refuses `""`, so the row was dead while the chord worked).
   *
   * The poll's answer is used when it is actionable; only an empty answer pays for a fresh
   * read (REQ-A424), exactly as [`handleSystemShortcut`] does.
   */
  function focusedWindowIntent(intent: DesktopSystemIntent): void {
    const target = actionableLabelOf(focusedWindowLabel);
    if (target) void reportIntentOutcome(intent, target);
    else void resolveFocusedThen(intent);
  }

  /**
   * Toggle **Stage Manager** — the Window menu's row and the ⌃⌘S chord (REQ-A1568).
   *
   * The current state is read first, from the host, rather than from a copy the shell keeps:
   * the mode can also be changed from a second launcher-free path (the rail draws a toggle
   * of its own), and a local `boolean` would be the second ledger this feature was built
   * without — the first press after the other surface changed it would then move the mode
   * the wrong way.
   *
   * A refusal is reported and **nothing local moves**: the host owns the state, and a shell
   * that flipped its own copy on a refusal would draw a rail the host has not reserved a
   * strip for. `stage_snapshot` refusing (a `null`) is the `bridge` case — the shell could
   * not even ask, so it says that rather than blaming the form factor.
   *
   * A `stage_set_enabled` refusal is named through [`stageFailure`], like its sibling
   * [`tidyStage`] below and every other face of this family: that function is documented as
   * the **one** place an `amos.stage.*` code becomes a sentence, and this path used to write
   * its own — naming `no stage rail`, which the host cannot refuse with where a rail exists,
   * and unable to say `amos.stage.persist_failed`.
   *
   * Success needs no follow-up: `stage_set_enabled` ends in `finish_layout`, which emits
   * `layout-changed`, and the shell's own subscription re-reads the snapshot (the rail and
   * the new `rail_width` arrive that way).
   */
  async function toggleStage(): Promise<void> {
    const current = await stageSnapshot();
    if (current === null) {
      amosWarn("shell", stageToggleRefusal(), { command: "stage_snapshot" });
      return;
    }
    if (await stageSetEnabled(!current.enabled) !== null) return;
    const { key, hostMessage } = stageFailure("stage_set_enabled");
    amosWarn("shell", hostMessage ? `${t(key)}: ${hostMessage}` : t(key), {
      command: "stage_set_enabled",
    });
  }

  /**
   * Window ▸ Tidy — lay every on-stage window out in a grid (REQ-A1568).
   *
   * Straight to the command: unlike the focused-window rows there is no target to resolve
   * (the **host** owns the on-stage set, and it is the same `views_of` rule the rail draws),
   * so a shell-side resolution here could only disagree with the host about what is on stage.
   *
   * A refusal is reported and named per its typed code — `amos.stage.disabled` when the mode
   * is off, `amos.stage.arrange_impossible` when the stage cannot hold that many windows —
   * through [`stageFailure`] rather than one sentence for all of them.
   */
  async function tidyStage(): Promise<void> {
    if (await stageArrange() !== null) return;
    const { key, hostMessage } = stageFailure("stage_arrange");
    amosWarn("shell", hostMessage ? `${t(key)}: ${hostMessage}` : t(key), {
      command: "stage_arrange",
    });
  }

  // ─── 壳注入的把手（一次，给所有槽位）────────────────────────────────────────
  // ids 取自注册表（`shellModules.ts` 的 overlay 行）：`launchpad` / `spotlight` /
  // `control-center-panel`。
  setContext<ShellChromeApi>(SHELL_CHROME_API, {
    // 一个 **getter**，不是快照：瓷砖是壳异步加载后才到的，而这份 handle 在 init 期就建好
    // 了——写成普通字段等于把桌面 chrome 永远钉在"只有内置应用"的世界里（F-SH-472 的另一半）。
    get storeTiles() {
      return ext;
    },
    openLaunchpad: () => openOverlay("launchpad"),
    openSpotlight: () => openOverlay("spotlight"),
    lockScreen: () => lock(),
    // 提示与按键同源：`bindings.overlays` 就是 `onKeyDown` 里 `findMatchingBinding` 读的那一份
    // （注册表默认 + 用户覆盖 + `null` 禁用），所以改过键的人看到的正是自己那把键。
    overlayShortcut: (overlayId) => bindingHint(keyboardBindings.bindings.overlays.get(overlayId)),
    toggleOverlay: (overlayId) => toggleOverlay(overlayId),
    isOverlayOpen: (overlayId) => openOverlays.includes(overlayId),
    windowAction: (action) => applyWindowAction(action),
    focusedWindowIntent: (intent) => focusedWindowIntent(intent),
    // REQ-A816: the Window menu's zone rows take **the chord's own path** (`snapFocused`), so
    // the mouse and the keyboard reach `wm_snap` through one implementation — same target rule
    // (the launcher is never a target, F-SH-008), same stale-poll retry (REQ-A424), same
    // refusal report naming the region (`snapRefusal`). A second path written for the menu row
    // is exactly how this repo's earlier rows came to describe the same command differently.
    snapWindow: (zone) => snapFocused(zone),
    // REQ-A1568: the Window menu's Stage Manager rows take the **same** path the ⌃⌘S chord
    // and the rail's own Tidy button do, so all three describe one command one way — and none
    // of them keeps a local mode flag (see `toggleStage`).
    toggleStage: () => void toggleStage(),
    tidyStage: () => void tidyStage(),
    // REQ-A473: the focused app's app id is resolved **here** (the shell owns the poll), and
    // the refusal is reported through the same `refusedChordMessage` the chords use — one
    // description of a failure, not a second one written for the menu row.
    newWindow: () =>
      void reportIntentOutcome("new-window", actionableLabelOf(focusedWindowLabel)),
    // REQ-A869: the in-app File ▸ Print… row reaches the *same* host command the native menu
    // item and ⌘P do (`printFocused`), so the three surfaces cannot describe one command
    // differently — and none of them prints the launcher by mistake (see `lib/print.ts`).
    printDocument: () => void printFocused(),
  });

  // ─── Spaces：切一次，报**整个**答复（键盘与触控板的**同一条**路径）────────────
  //
  // REQ-A1825：`switchSpace` 的答复是 `SpaceSwitchReport`，它有**两半**——点名的拒绝
  // （`null` + `bridgeDiag("spaces_switch")` 里的 `amos.spaces.*` code）与「切了，但这些
  // 窗口没跟过来」（`hide_failed` ∕ `show_failed`）。壳从前只读第二半的成功位，把第一半
  // 写成一行为手写的英文（`Failed to switch to space N`），第三半干脆丢掉；而同一个命令的
  // 另外两个属主（`SpacesPanel.applySwitch`、`MissionControl.onSwitchSpace`）两半都读、
  // 都报 `spaces.switchPartial`。同一个命令一处描述 —— 这里补上壳这一份。
  //
  // 失败句子走 `lib/spaces.ts::spacesFailure`（**唯一**的 code→句子规则，F-SH-577），
  // 并按 `stageFailure` 的同一条约定拼 `hostMessage`；报进台账（`amosWarn`）而不是
  // `console.warn`，因为台账是壳其余每一处拒绝的去处（REQ-A853 的按 mark 窗口化读法）。
  async function runSpaceSwitch(index: number): Promise<void> {
    const report = await switchSpace(index);
    if (report === null) {
      const { key, hostMessage } = spacesFailure("spaces_switch");
      amosWarn("shell", hostMessage ? `${t(key)}: ${hostMessage}` : t(key), {
        command: "spaces_switch",
        index,
      });
      return;
    }
    // REQ-A1311：属主换了桌面，显示这条事实的面（开着的 Spaces 面板 ∕ Mission Control）
    // 必须跟着换 —— 壳在 capture 阶段消费这条弦，面板自己的监听器收不到。
    announceSpacesChanged();
    const missed = report.hide_failed.length + report.show_failed.length;
    if (missed > 0) {
      amosWarn("shell", t("spaces.switchPartial", { n: missed }), {
        command: "spaces_switch",
        index,
      });
    }
  }

  // REQ-A1586：`⌃←` ∕ `⌃→` 与触控板横扫要的是同一个动作，所以两者只留一条实现 ——
  // 谁先在别处加上另一份「读三个命令再切换」的拷贝，谁就制造了本仓反复出现的
  // 「同一个命令两处描述」缺陷。两个调用点传入的都是 ±1 的**步长**（不是下标）：
  // 下标的回绕 ∕ 单屏静止 ∕ 越界判断都交给 `lib/spaces.ts` 的纯函数。
  async function stepSpaces(step: number): Promise<void> {
    const spaces = await listSpaces();
    const current = await activeSpace();
    if (!spaces || current === null) return;

    const newIndex =
      step < 0 ? prevSpaceIndex(current, spaces.length) : nextSpaceIndex(current, spaces.length);
    if (newIndex === null || newIndex === current) return;

    await runSpaceSwitch(newIndex);
  }

  // ─── 触控板指针层（REQ-A1586）─────────────────────────────────────────────
  //
  // 桌面形态专属：在**未被任何应用窗口遮住**的桌面表面上两指横扫切换 Space。规则全在
  // `lib/trackpad.ts`（纯函数 + 累加器，无 DOM），这里只做三件事：把 `WheelEvent` 变成
  // 采样、喂给累加器、对答案调用上面那条**同一条** `stepSpaces`。
  //
  // 为什么挂在桌面根节点而不是 `window`：应用窗口是**独立的原生窗口**（见
  // `DesktopAppWindow` 的 `data-tauri-drag-region`），指针在窗口上时 wheel 事件进的是
  // 那扇窗口自己的 WebView，根本不到这里 —— 于是「在窗口里横向滚动」不会被误判成
  // 切桌面，这是**几何**保证的，不是靠 `preventDefault` 抢。
  const trackpad = new TrackpadSwipeTracker();

  function onWheel(e: WheelEvent): void {
    const step = trackpad.push(
      { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey },
      performance.now(),
    );
    if (step === null) return;
    void stepSpaces(step === "prev" ? -1 : 1);
  }

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
      // REQ-A555: 这里原先自己写了一条 `invoke<unknown>("spaces_switch")` —— 与 `lib/spaces.ts`
      // 里**同一个命令**的第二份调用，而且是没声明回复类型的那一份。命令的主人（`lib/spaces.ts`）
      // 已经有类型化的 `switchSpace`，壳就读那一个；REQ-A1825 起，「读整个答复」也只有
      // `runSpaceSwitch` 一处（拒绝的句子、没跟过来的窗口、通告全在里面），两个调用点不会
      // 再各自描述一遍同一个命令的结果。
      void runSpaceSwitch(index);
      return;
    }

    // 上一个 / 下一个桌面
    const spacesPrev = spacesBindings.get("spacesPrev");
    const spacesNext = spacesBindings.get("spacesNext");
    const step = spacesPrev && shortcutMatches(e, spacesPrev) ? -1 : spacesNext && shortcutMatches(e, spacesNext) ? 1 : 0;
    if (step !== 0) {
      e.preventDefault();
      e.stopPropagation();
      // REQ-A1586：与触控板横扫共用**同一条**实现（见上面的 `stepSpaces`）。
      void stepSpaces(step);
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

    // App Exposé（默认 ⌃↓）：把**焦点应用**的窗口铺开（REQ-A476）。
    //
    // 与 Spaces 面板同一形状（也是同一个键族）：注册表**故意**不给这一行 `shortcuts` —— 那条
    // 清单（`F3 / F4 / ⌘Space / ⌘Tab`）是文档化且被测试钉住的不变量 —— 键来自键盘配置的
    // `spaces` 域（`SPACES_DEFAULTS.appExpose`），于是它在设置里**可以改**。
    //
    // macOS 上"这个应用只有一扇窗"时 ⌃↓ **什么都不发生**；本仓的纪律是"按下去没反应"与
    // "坏了"必须能区分，所以我们不开一个空面板，而是把原因说出来（`appExposeRefusal`）——
    // 与 ⌘W/⌘N 那些死弦同一条处置。
    const appExpose = spacesBindings.get("appExpose");
    if (appExpose && shortcutMatches(e, appExpose)) {
      e.preventDefault();
      e.stopPropagation();
      // The "is there anything to tile?" rule lives in `openRefusal` now, next to Mission
      // Control's — the two chords are the same shape, so they must not each carry a copy.
      toggleOverlay("app-expose");
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
      // F-SH-361 / F-SH-363: the "is there anything to show?" rule is **not** written here — it
      // lives in `openRefusal`, which `toggleOverlay` consults. It used to be inline at this call
      // site, which is how the default top-left hot corner kept opening the same empty Mission
      // Control layer through `ShellChromeApi.toggleOverlay` (a second caller of the same
      // primitive). One rule, one place, every door.
      toggleOverlay(overlayHit.id);
      return;
    }

    // ─── 窗口吸附（⌃⌥ 一族，表在 `lib/snapZones.ts`）────────────────────────────
    // **放在最后，是有判据的**：这四行是壳**自有**的固定键（还不是键盘设置里的域），
    // 而上面每一域都是用户可改的。用户把某个 Spaces / 浮层行绑到 ⌃⌥← 时，用户显式配置
    // 必须赢 —— 先于 Spaces 判据会让他的绑定在桌面上静默失效，那正是 REQ-A394 修掉的
    // bug 形状（`svelte-tests/desktop-shell` 里那条 ⌃⌥← 的用例钉着它）。
    // 能力开关同系统域：`AMOS_DESKTOP_SHORTCUTS=disabled` 是"壳不接管桌面快捷键"，
    // 吸附正是一族桌面快捷键。修饰符是 ⌃⌥，与系统域（⌘…）、Spaces（⌃ + 方向/数字）
    // 和浮层（F3/F4/⌘Space/⌘Tab）的**默认值**都不相交（`shortcutMatches` 精确比修饰符）。
    if (isDesktopFeatureEnabled("shortcuts")) {
      const zone = snapZoneFor(e);
      if (zone) {
        e.preventDefault();
        e.stopPropagation();
        snapFocused(zone);
        return;
      }
    }

    // ─── Stage Manager（⌃⌘S，表在 `lib/stageKeys.ts`）────────────────────────────
    // 与吸附同族，放在这里的理由也相同：它是壳自有的固定键（还不是键盘设置里的域），
    // 而上面每一域都是用户可改的 —— 用户显式配置必须赢。修饰符 ⌃⌘ 与系统域（纯 ⌘…）、
    // Spaces（⌃ + 方向/数字）、浮层（F3/F4/⌘Space/⌘Tab）、吸附（⌃⌥）的默认值**都不相交**
    // （`shortcutMatches` 精确比修饰符），这一点由 `stageKeys.test.ts` 对着那四张表钉住。
    //
    // 也受 `AMOS_DESKTOP_SHORTCUTS` 门控：那是"壳不接管桌面快捷键"，而这是一把桌面快捷键。
    // **菜单行不受门控** —— 那是一次用户显式的点击，与邻居 Zoom / Minimize 一样（同
    // `snapWindow` 的诚实边界）。
    if (isDesktopFeatureEnabled("shortcuts") && isStageToggleChord(e)) {
      e.preventDefault();
      e.stopPropagation();
      void toggleStage();
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
    }).then((f) => {
      // REQ-A838: `null` = 推送订阅未建立。保持无操作默认值（释放"什么都没有"本就该是无操作），
      // 并**不要**把界面留成"布局一直没变"的样子 —— 判定在 `bridgeDiag(LAYOUT_CHANGED_EVENT)`。
      if (f === null) return;
      stopLayout = f;
    });

    // 当前焦点窗口（系统快捷键 ⌘W/⌘M/⌘H 的目标）。心跳与会读 `wm_windows` 的 Dock
    // **共用一次轮询**（`lib/wmWindowsPoll.ts`：引用计数，最后一个订阅者离开即停表），
    // 而不是像以前那样壳与 Dock 各开一组 5s 定时器、每 5 秒问宿主两遍同一个问题。
    const stopWindowsPoll = subscribeWmWindows(applyWindowsSnapshot);

    // Native macOS menu bar (Apple / File / Edit / View / Window / Help).
    // The Rust host installs the global menu at boot and forwards every item activation to
    // the WebView as a `menu-event` (`menu.rs::on_menu_event`) — **every** id except the ones
    // in its `TERMINAL_RUST` list, which it consumes and returns from (`quit`, `close-window`,
    // `hide-others`, `show-all`). So `menu.close-window` is NOT handled here: it is terminal in
    // Rust (`close_key_window`, which closes the OS-key window before any WebView sees ⌘W).
    //
    // The cases below are the shell-owned ids that actually arrive: Preferences / New Window /
    // Minimize / Zoom / Enter Full Screen / Search Help / Amos Help. The two Rust-handled ids
    // that are forwarded only as an echo (`about`, `hide-amos`) fall to `default` and are
    // deliberately ignored — their behavior lives in Rust, so a second implementation in the
    // shell cannot drift from the native one (REQ-A423 moved `show-all` there, which is also
    // where macOS defines it).
    //
    // REQ-A761: this list used to be prose ("Preferences / … / Close Window / …") and it had
    // already gone false — it named Close Window as a case that does not exist, and called
    // About / Hide Amos terminal when they are forwarded. Nothing bound the switch to
    // `menu.rs`'s id tables, so a new menu item added in Rust with no case here would be
    // swallowed by `default` and silently do nothing. That relation is now checked by
    // `desktopKeys.test.ts` ("every id the host forwards has a case here, and every case is
    // one the host forwards").
    const stopMenu = onMenuEvent((id) => {
      // Best-effort: log unknown ids but do not throw — a host-only id (e.g.
      // `menu.about`) arrives here too and is meant to be ignored.
      switch (id) {
        case "menu.preferences":
          void windowMenuAction(() => wmOpen("settings"), "wm_open", "settings");
          break;
        case "menu.new-window":
          // REQ-A473: a per-app "New Window" at last. Before the identity model this could
          // only open the **Files** window — the native item had to be renamed to "New Files
          // Window" (REQ-A434) because one label meant one window, so there was no "current
          // app" to duplicate. Now the focused app is duplicated, falling back to Files when
          // nothing app-shaped is focused (`newWindowTarget` states that rule once, for the
          // menu row, ⌘N and this native item alike).
          void reportIntentOutcome("new-window", actionableLabelOf(focusedWindowLabel));
          break;
        case "menu.minimize":
          // REQ-A714: ⌘M **minimizes** (the platform's own minimize — the window drops to
          // the Dock and the app stays visibly running) rather than hiding. The old
          // `wmHide` here made the window leave the model, so the Dock's running dot went
          // dark and every model reader reported the app as closed
          // (`docs/DESKTOP_GAP_ANALYSIS_2026_SEP20.md` §2 A1).
          //
          // REQ-A757: this branch used to call `wmMinimize(mlabel)` directly and drop its
          // boolean. That made it the *fourth* implementation of minimize: it silently lost
          // a host refusal (a split pane refuses with "window '{label}' is in a split — exit
          // the split before minimizing", `wm.rs::minimize_target`) and the no-target case,
          // while ⌘M and the in-app Window ▸ Minimize row both reported them. It also
          // re-stated the launcher-skip rule inline (`mlabel !== "main"`) that
          // `actionableLabelOf` already owns. Route through `focusedWindowIntent` — the
          // *same* path the ⌘M chord and the in-app row take — so the three surfaces cannot
          // describe the same command differently (the rule this file's own `menu.zoom`
          // branch states below).
          focusedWindowIntent("minimize-window");
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
        // REQ-A869: File ▸ Print… (⌘P). The **host** prints the focused app window; this branch
        // must not call `window.print()` — this component mounts in the *launcher* window
        // (`Shell.svelte`: `{#if s.kind === "app"} DesktopAppWindow {:else} DesktopShell`), so a
        // DOM-level print here would print the desktop while the user looks at a document. The
        // host owns "which window is focused" (`wm::focused_app_label`), and it is the only side
        // that can act on it — hence the zero-argument `print_document` (D2).
        case "menu.print":
          void printFocused();
          break;
        // REQ-A482: Help menu rows. "Search Help" opens the Spotlight overlay (⌘? is the
        // spotlight shortcut on this Mac), and "Amos Help" opens Settings.
        case "menu.search-help":
          openOverlay("spotlight");
          break;
        case "menu.amos-help":
          void windowMenuAction(() => wmOpen("settings"), "wm_open", "settings");
          break;
        default:
          // The Rust-handled ids that are still forwarded as an echo — `menu.about` and
          // `menu.hide-amos` (their behavior is in `menu.rs`; the echo keeps native chrome
          // and the shell in lockstep). The terminal ids (`quit`, `close-window`,
          // `hide-others`, `show-all`) never reach here at all. Nothing to do either way.
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
      stopWindowsPoll();
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
  onwheel={onWheel}
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
    <DesktopStage {railWidth} />
  </div>

  <!-- 顶部 TopBar -->
  <div class="absolute left-0 right-0 top-0 z-30">
    <TopBar />
  </div>

  <!-- Stage Manager 轨道栏（REQ-A1546）。画在**舞台矩形左侧**，宽度取自宿主
       （`LayoutSnapshot.rail_width`，模式关着或屏幕窄到放不下时是 0 ⇒ 不渲染），
       y / 高度与舞台同源（`stageRect`）。它不被应用窗口盖住是**几何**保证的
       （宿主把每个窗口的落点内缩了 rail_width），不是 z 序 —— 见 docs/stage-manager.md。
       z 与舞台同层：它在舞台矩形之外，Dock 与 TopBar（z-30）仍在它之上。 -->
  <StageRail {stage} {railWidth} />

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

