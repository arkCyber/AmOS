<script lang="ts">
  // Shell.svelte — Svelte top-level shell (Phase-3 ③a skeleton). Reads the
  // React-free shellState to decide which Svelte surface to render, and feeds the
  // controlled channels the Svelte screens read (HomeDock "home", EditHome
  // "editHome", LockScreen "lock"). ③b adds real app mounting; ③c adds overlays
  // (Recents/Spotlight/NC) + hardware/edge policies. React-free import graph.
  import { onMount, onDestroy } from "svelte";
  import { propsChannel, disposePropsChannel } from "./propsBus";
  import { appTitleKey } from "../lib/appMeta";
  import { t, windowName } from "./locale.svelte";
  import type { HomeLayout } from "../lib/amosStore";
  import { moveBefore, addAppsToDock, readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { amosWarn } from "../lib/debugLog";
  import { homeGrid, homeTile, deviceChrome, PHONE_GRID, type HomeGrid, type HomeTile } from "../lib/formLayout";
  import { onLayoutChanged, wmLayoutSnapshot, wmOpenReported, wmSetShellTitle, type LayoutSnapshot, type FormFactor } from "../lib/wm";
  import { windowOwnsShellNav } from "../lib/shellNav";
  import { windowLabelFromHash } from "../lib/windowRoute";
  import { CONTACTS_KEY, seedContacts } from "../lib/contacts";
  import { BRIGHTNESS_KEY, brightnessToAlpha, normalizeBrightness } from "../lib/brightness";
  import { createStoreValue } from "./store";
  import { desktopFormActive } from "../lib/formAuthority.svelte";
  import {
    applyLayout,
    canSlideOver,
    canSplit,
    enterEdit,
    enterLibrary,
    enterSplit,
    exitEdit,
    exitSplit,
    goHome,
    layout,
    layoutRefused,
    lock,
    ncOpen,
    open,
    openSlideOver,
    pulseId,
    pulseSeq,
    recentsOpen,
    reseatHomeLayout,
    restoreSlideOver,
    setNc,
    setRecents,
    setSpot,
    setLayoutSnapshot,
    restoreSplit,
    softLaunch,
    spotOpen,
    surface,
    sysInkOpen,
    closeSysInk,
    openSysInk,
    unlock,
  } from "./shellState.svelte";
  import LockScreen from "./LockScreen.svelte";
  import DesktopShell from "./DesktopShell.svelte";
  import DesktopAppWindow from "./DesktopAppWindow.svelte";
  import { startTimerWatcher } from "./osTimerWatcher";
  import { startAlarmWatcher } from "./osAlarmWatcher";
  import { startReminderWatcher } from "./osReminderWatcher";
  import { startPushWatcher } from "./osPushWatcher";
  import { startOtaWatcher } from "./osOtaWatcher";
  import { startShortcutTriggers } from "./osShortcutTriggers";
  import { startCalendarWatcher } from "./osCalendarWatcher";
  import { startFocusWatcher } from "./osFocusWatcher";
  import { startOsAutoOff } from "./osAutoOff";
  import { startOsTelephonyHold } from "./osTelephonyHold";
  import { startOsWakeHome } from "./osWakeHome";
  import { ensureDefaultCapabilitiesSeeded } from "./osCapabilities";
  import { reassertScreenOnUnlocked, reportScreenOff, reportScreenOn } from "./osScreenState";
  import { edgeAtY, pastEdgeThreshold, type Edge } from "../lib/edgeSwipe";
  import { startOsInputBridge, startOsHardwarePoll } from "./osInputBridge";
  import { startLmkSurfaceWatcher, startPeriodicReconcile } from "../lib/lmk";
  import { recordSpyHit, startTelemetrySpyWatcher } from "../lib/telemetrySpy";
  import {
    getStoreTiles,
    loadStoreTiles,
    subscribeStoreTiles,
    tileById,
    type StoreTile,
  } from "../lib/storeApps";
  import HomeDock from "./HomeDock.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import EditHome from "./EditHome.svelte";
  import AppLibrary from "./AppLibrary.svelte";
  import StatusBar from "./StatusBar.svelte";
  import AppPane from "./AppPane.svelte";
  import SplitSurface from "./SplitSurface.svelte";
  import SlideOverSurface from "./SlideOverSurface.svelte";
  import Backdrop from "./Backdrop.svelte";
  import NotificationBanner from "./NotificationBanner.svelte";
  import IncomingCall from "./IncomingCall.svelte";
  import RecentsPanel from "./RecentsPanel.svelte";
  import SpotlightPanel from "./SpotlightPanel.svelte";
  import NotificationCenter from "./NotificationCenter.svelte";
  import ClipboardAnnounce from "./ClipboardAnnounce.svelte";
  import ShareSheet from "./ShareSheet.svelte";
  import ImeOverlay from "./ImeOverlay.svelte";
  import DragGhost from "./DragGhost.svelte";
  // Keyboard admission for the touch shell (re-wired after the rollback that lost REQ-A335/336/338):
  // the *registry* is the one table that knows "which key opens which surface", `shellKeyIntent` is
  // the pure decision (its unit tests survived), and the panel is generated from the same table.
  import { SHELL_MODULES } from "./shellModules";
  import { shellKeyIntent } from "../lib/systemKeys";
  // System-back admission (REQ-A321): a single `backActionAt` decides what a
  // dismiss intent means, so the keyboard handler and the platform back gesture
  // (and any future consumer — accessibility shortcut, etc.) cannot disagree.
  import { backActionAt, levelOf, pushDecision, rewindCount, type BackPosition, type BackSurface } from "../lib/backNav";
  import ShortcutHud from "./ShortcutHud.svelte";
  import SystemInkLayer from "./SystemInkLayer.svelte";

  interface HomeProps {
    layout: HomeLayout;
    ext: StoreTile[];
    pulseId: string | null;
    /** The soft launch's event counter (`shellState.pulseSeq`). `pulseId` is the value to
     * highlight; this says a launch *happened*, which is what reveals a tile that lives
     * on a page the grid is not currently showing. */
    pulseSeq: number;
    /** Home-screen grid geometry for this device's **class** (see lib/formLayout).
     * The shell owns it because the shell is what reads the host's authority; the
     * grid is pushed down the same reactive channel as the layout, in place. */
    grid: HomeGrid;
    /** How big one tile is on this class (`lib/formLayout::homeTile`). Pushed with the
     * grid for the same reason: it is the host's class, not the component's guess. */
    tile: HomeTile;
    /** The device class itself, for the class-aware Dock decisions the home screen
     * makes on its own (`lib/formLayout::dockRecentSlots` — the iPad Dock's
     * recently-used section). Pushed like `grid`/`tile`: the shell owns the host read. */
    form: FormFactor;
  }

  // The host's layout authority (`form` + the **measured** screen). The shell reads
  // it once and then on every `layout-changed` push (the host only emits on a real
  // change), exactly like the 窗口与形态 settings page does — the UI must never infer
  // the device class from its own viewport (a phone and a tablet are one build,
  // `docs/multi-window.md` §1.5). No host (browser preview) ⇒ stays `null` ⇒ the
  // phone grid, the most conservative plan.
  let layoutSnap = $state<LayoutSnapshot | null>(null);
  const homeGridPlan = $derived(
    layoutSnap ? homeGrid(layoutSnap.form, layoutSnap.screen_w, layoutSnap.screen_h) : PHONE_GRID,
  );
  // The class itself, for the chrome decisions below. No host ⇒ phone, the
  // conservative default (the same rule the grid follows).
  const shellForm = $derived(layoutSnap?.form ?? "phone");
  // Device chrome (REQ-A249): the Dynamic Island is iPhone hardware and the home
  // indicator is an iOS gesture bar — neither exists on a Mac, and both used to be
  // drawn in a maximized macOS window (`lib/formLayout::deviceChrome`).
  const chrome = $derived(deviceChrome(shellForm));
  // Tile size for the launcher: a Mac window's Launcher wants Launchpad-class tiles
  // (a 56 px tile in a 183 px cell reads as a phone screenshot pasted onto a desktop).
  const homeTilePlan = $derived(homeTile(shellForm));

  /**
   * Run a shell-level **navigation** action only when this window owns navigation
   * (`lib/shellNav.ts`, REQ-A429). On a phone the shell has one window and its surfaces are
   * that window's modes, so a wake / idle-lock / nav key moves it. On a desktop an app
   * window **is** one app (REQ-A416): navigating it would render the desktop inside an app
   * window (measured — a focus change did exactly that), so those actions are skipped there.
   *
   * Read at **call** time on purpose: the layout snapshot that decides `shellForm` arrives
   * after the watcher list is built, so deciding once at mount would answer "phone" for
   * every window and this guard would never fire in a real launch.
   */
  function navigateSelf(action: () => void): void {
    if (windowOwnsShellNav(shellForm, surface().kind === "app")) action();
  }
  /**
   * Open an app by id. On the desktop shell a launcher / App-Library tap is **the**
   * place to drive `wm_open`: each app lives in its own real `WebviewWindow`
   * (`docs/PC_DESKTOP_AUDIT.md` §3.2 + REQ-A416/REQ-A419), and the SPA fallback
   * would render the *desktop* inside the launcher, not the app. Every other form
   * factor keeps the legacy surface switch — phones/tablets/robots run a single
   * window and the launcher is that window's mode.
   *
   * Read at call time on purpose: `shellForm` is `$derived` from the host snapshot,
   * which arrives a tick after mount. A captured-at-mount answer would say "phone"
   * for every real launch and the desktop branch would never run.
   */
  function launchApp(id: string): void {
    if (desktopFormActive()) void wmOpenReported(id, "Shell");
    else open(id);
  }

  // The window's own name (REQ-A250). On a class with an OS title bar, the bar answers
  // "what am I looking at": the app that is on screen, or — via `null` — the title the
  // host was configured with, for the surfaces that are the shell itself. Nothing is
  // sent where there is no such chrome (a mobile app is fullscreen; renaming an Android
  // activity's label would rename the app in the task switcher instead).
  $effect(() => {
    if (!chrome.titleBar) return;
    const s = surface();
    // REQ-A478: the window names **itself**, and a window of an app is not just that app.
    // Measured on this machine 2026-09-19: three `⌘N` Files windows came back from AX as
    // `文件`, `文件`, `文件` — while each window's own titlebar drew `文件`, `文件 — 2`,
    // `文件 — 3`. Two names for one window, on screen at the same time, is exactly the
    // "名字只有一份" rule this effect exists to keep (and a screen reader read three
    // identical window names). The label comes from the same fragment the surface did.
    const label = windowLabelFromHash(typeof location === "undefined" ? null : location.hash);
    const asked = s.kind === "app" ? (label ? windowName(label, null, ext).text : appTitle(s.id)) : null;
    void wmSetShellTitle(asked).then((applied) => {
      // The host bounds what it hands the OS (a third-party display name is truncated
      // with a visible `…`). Report a difference instead of hiding it — a title bar
      // that silently says something else is the class of thing this crate surfaces.
      if (asked !== null && applied !== null && applied !== asked) {
        amosWarn("wm", "the host applied a different window title", { asked, applied });
      }
    });
  });

  // Store-installed (third-party) tiles live in the module cache in
  // `lib/storeApps`, which only `loadStoreTiles` ever populates — and the Store
  // page pokes `notifyStoreTilesChanged()` after install/uninstall. So the shell
  // loads the tiles once and re-loads on every poke; without this the cache stays
  // empty, and an installed app never appears on the home screen / App Library.
  let ext = $state<StoreTile[]>(getStoreTiles());
  const refreshStoreTiles = () => {
    void loadStoreTiles().then((tiles) => {
      ext = tiles;
      // The home layout was repaired at boot, before this load — while the tile
      // cache was still cold, a store app the user had already placed on a page /
      // the dock read as a ghost and was filtered out. Re-derive it now that the
      // installed set is known (and, via the subscribe below, on every install /
      // uninstall, so a removed app's placement is reconciled out too).
      reseatHomeLayout();
      // Same cold-cache half for the persisted **split** (a tablet's two-pane layout).
      // `restoreSplit` at boot validated its panes before this load resolved, so a pane
      // holding an installed store app read as a ghost and the whole split was dropped.
      // Re-attempting here is a no-op once a split is on screen (the function's own
      // `kind !== "home"` guard), so this cannot override a later user navigation.
      restoreSplit();
      // …and the same for the floating Slide Over panel, whose stored app is validated the
      // same way (`restoreSlideOver` → `parseSlideOver`): a panel on an installed store app
      // read as a ghost at boot and never came back. The no-op-once-shown guard is the
      // function's own (`_slideOver !== null`).
      restoreSlideOver();
    });
  };

  // Feed the controlled screens from shellState whenever the visible surface is
  // one that reads that channel (no remount — reactive channel set).
  $effect(() => {
    if (surface().kind === "home") {
      propsChannel<HomeProps>("home").set({
        layout: layout(),
        ext,
        pulseId: pulseId(),
        pulseSeq: pulseSeq(),
        grid: homeGridPlan,
        tile: homeTilePlan,
        form: shellForm,
      });
    }
  });
  // Feed the App Library screen (layout + any store-installed tiles) whenever that
  // surface is shown — the ext tiles make an installed store app addable to the
  // home screen / dock.
  $effect(() => {
    if (surface().kind === "library") {
      propsChannel<{ layout: HomeLayout; ext: StoreTile[]; form?: FormFactor }>("appLibrary").set({
        layout: layout(),
        ext,
        form: shellForm,
      });
    }
  });
  // 编辑主屏 draws the same tiles the home screen does, so it needs the same store-installed
  // list: without `ext` a store app on the page has no chip to remove or reorder, and a hidden
  // one has no way back (REQ-A1182). Fed exactly like `appLibrary` just above.
  $effect(() => {
    if (surface().kind === "edit") {
      propsChannel<{ layout: HomeLayout; ext: StoreTile[] }>("editHome").set({
        layout: layout(),
        ext,
      });
    }
  });

  // ③c: feed overlay open flags from shellState (home & app surfaces).
  $effect(() =>
    propsChannel<{
      open: boolean;
      pick: "split" | "slide" | null;
      exclude: string | null;
      ext: StoreTile[];
    }>("recents").set({
      open: shellRecents(),
      pick: splitPicking ? "split" : slidePicking ? "slide" : null,
      // A split pane may not repeat the primary app; a Slide Over panel may.
      exclude: splitPicking && s.kind === "app" ? s.id : null,
      // The picker offers installed store apps alongside the (built-in-only) recents —
      // the shell already owns the tile list for the home screen, so the controlled
      // overlay gets it the same way: pushed, not re-sourced.
      ext,
    }),
  );
  $effect(() => propsChannel<{ open: boolean }>("spotlight").set({ open: shellSpot() }));
  $effect(() => propsChannel<{ open: boolean }>("nc").set({ open: shellNc() }));

  function shellRecents() {
    return recentsOpen();
  }
  function shellSpot() {
    return spotOpen();
  }
  function shellNc() {
    return ncOpen();
  }

  // Listen for one-shot actions the Svelte screens emit back.
  $effect(() => {
    return propsChannel<HomeProps>("home").on((e, d) => {
      if (e === "open" && typeof d === "string") launchApp(d);
      else if (e === "move") {
        const m = d as { drag: string; over: string };
        applyLayout(moveBefore(layout(), m.drag, m.over));
      } else if (e === "search") setSpot(true);
      else if (e === "library") enterLibrary();
      else if (e === "edit") enterEdit();
    });
  });
  $effect(() => {
    return propsChannel<{ layout: HomeLayout; ext: StoreTile[] }>("editHome").on((e, d) => {
      if (e === "change") applyLayout(d as HomeLayout);
      else if (e === "done") exitEdit();
    });
  });
  $effect(() => {
    return propsChannel<{ layout: HomeLayout; ext: StoreTile[] }>("appLibrary").on((e, d) => {
      if (e === "open" && typeof d === "string") launchApp(d);
      else if (e === "back") goHome();
      else if (e === "dockAdd" && Array.isArray(d)) {
        applyLayout(addAppsToDock(layout(), d.filter((x) => typeof x === "string")));
      }
    });
  });
  $effect(() => {
    return propsChannel<{ ready?: boolean }>("lock").on((e) => {
      if (e === "unlock") unlock();
    });
  });
  // Overlay one-shot actions → shellState.
  $effect(() => {
    return propsChannel<{ open: boolean }>("recents").on((e, d) => {
      if (e === "open" && typeof d === "string") {
        if (splitPicking) pickSecond(d);
        else if (slidePicking) pickSlideOver(d);
        else void open(d);
      } else if (e === "close") {
        setRecents(false);
        splitPicking = false;
        slidePicking = false;
      }
    });
  });
  $effect(() => {
    return propsChannel<{ open: boolean }>("spotlight").on((e, d) => {
      if (e === "open" && typeof d === "string") softLaunch(d);
      else if (e === "close") setSpot(false);
    });
  });
  $effect(() => {
    return propsChannel<{ open: boolean }>("nc").on((e) => {
      if (e === "close") setNc(false);
      else if (e === "search") setSpot(true);
      else if (e === "recents") setRecents(true);
      else if (e === "edit") enterEdit();
      else if (e === "lock") lock();
      // The system ink layer's door on touch (REQ-A1590): the Control Center is reachable from
      // the top edge over *any* app, so this is what makes the stylus system-wide. `openSysInk`
      // dismisses the sheet itself (`clearOverlays`), so the sheet needs no second "close" emit.
      else if (e === "ink") openSysInk();
    });
  });

  let ready = $state(false);
  let stopWatchers: Array<() => void> = [];
  // Screen-state reporting (docs/display-idle.md §4): the daemon reads the shared
  // file to decide whether to defer background work / freeze apps, so **every**
  // off/on transition must be reported. `lock()` is the single screen-off entry
  // (NC 🔒 button + the idle auto-off watcher), unlock/`goHome` the wake path —
  // hooking the surface transition covers all of them with one edge detector.
  let screenWasLocked = false;
  $effect(() => {
    const locked = surface().kind === "lock";
    if (locked === screenWasLocked) return;
    screenWasLocked = locked;
    if (locked) reportScreenOff();
    else reportScreenOn();
  });
  // Async LMK surface-watch unsubscribe (resolved after onMount returns), released
  // in onDestroy — also released immediately if unmount beats the resolution.
  let stopLmkWatch = () => {};
  let lmkDisposed = false;
  // Async form-factor (`layout-changed`) unsubscribe — same lifecycle pattern.
  let stopLayoutWatch = () => {};
  let layoutDisposed = false;
  // Async telemetry-spy Watch unsubscribe (same lifecycle pattern as the LMK one).
  let stopSpyWatch = () => {};
  let spyDisposed = false;

  /**
   * First run only: seed the address book so Contacts/Phone show the documented
   * "starter list for the first run" (mirrors the Messages/VoiceMemos demo seeds).
   * Seeds ONLY when the key is *absent* — an intentionally emptied address book
   * must stay empty, so `readStoreValue(..., undefined)` (not `[]`) is the test.
   */
  function seedContactsOnce(): void {
    if (readStoreValue<unknown>(CONTACTS_KEY, undefined) === undefined) {
      writeStoreValue(CONTACTS_KEY, seedContacts());
    }
  }

  onMount(() => {
    ready = true;
    // Seed the address book before any app surface can read it (Contacts / Phone /
    // IncomingCall all hydrate `amos.contacts` at component init).
    seedContactsOnce();
    // Seed default-on capabilities (REQ-A380): camera + microphone for the
    // built-in apps so the Camera / Voice Memos screens open straight into a
    // usable viewfinder without an in-app "allow?" prompt. The seed writes
    // only when a key is missing — explicit Privacy revokes are kept.
    ensureDefaultCapabilitiesSeeded();
    // Form-factor authority for the home grid: read the host's snapshot once, then
    // follow its `layout-changed` pushes (the host emits only on a real change, so
    // this is not a poll). A `null` answer (no bridge, or a failed command — recorded
    // in the diagnostics ledger by `lib/backend`) leaves the phone plan in place
    // rather than keeping a stale tablet reading (`WindowPage`'s honesty rule).
    // `setLayoutSnapshot` also re-asserts the device class from the very snapshot
    // it stores (see its doc), so the app registry hides phone-only apps
    // (e.g. the `phone` dialer) on desktop — one writer, no second call to forget.
    void wmLayoutSnapshot().then((s) => {
      if (s) {
        layoutSnap = s;
        setLayoutSnapshot(s); // Initialize shellState with layout snapshot
        // Bring back a split the last run was closed on, now that the measured
        // screen (the `columns` gate) has actually answered. `restoreSplit` owns
        // every refusal — no host at all (s is null) simply leaves the home surface.
        restoreSplit();
        // Same for the floating Slide Over panel. `restoreSlideOver` owns every
        // refusal and always restores it *shown* (see its doc) — a restored panel the
        // user could not see would look like a failed restore.
        restoreSlideOver();
      }
    });
    // Desktop-shell capability switches (`AMOS_DESKTOP_SHORTCUTS` /
    // `AMOS_DOCK_CONTEXT_MENU`) are NOT asked here: they gate the shell's shortcut
    // handler and the Dock's right-click menu, so `DesktopShell` — which owns both —
    // fetches them when it mounts (REQ-A287).
    void onLayoutChanged((s) => {
      layoutSnap = s;
      setLayoutSnapshot(s); // Update shellState on layout changes
    }).then((stop) => {
      // REQ-A838: `null` = the `layout-changed` listen was refused, so no push will ever
      // arrive and there is nothing to release. `stopLayoutWatch` keeps its no-op default —
      // which is *correct* here, because a no-op is exactly what releasing nothing is. What
      // must not happen is the shell reporting a live layout subscription; that answer is
      // `bridgeDiag(LAYOUT_CHANGED_EVENT)`, and the push is an optimization — the snapshot
      // above is already read once at mount.
      if (stop === null) return;
      if (layoutDisposed) stop();
      else stopLayoutWatch = stop;
    });
    // Boot re-assert (docs/display-idle.md §4): a previous run may have left
    // `off` on disk, which would make the daemon defer as if the display were
    // still dark. Clear it when the shell starts unlocked (best-effort, no-op
    // without a bridge).
    void reassertScreenOnUnlocked(surface().kind === "lock");
    // Pure-Svelte host: surface a running countdown's "time's up" and a due alarm
    // even when the Clock app isn't the focused surface (suppressed while focused).
    const getActive = () => {
      const s = surface();
      return s.kind === "app" ? s.id : null;
    };
    // Keep `legacy:*` external surfaces consistent with the daemon's authoritative
    // container LMK snapshot (startup parity): tear
    // down surfaces the container reclaimed/destroyed and reconcile periodically.
    stopWatchers = [
      startPeriodicReconcile(),
      startTimerWatcher(getActive),
      startAlarmWatcher(getActive),
      startReminderWatcher(getActive),
      startCalendarWatcher(getActive),
      // Scheduled Do-Not-Disturb windows (REQ-A684): the shell is the host that
      // owns the real DND bit, so it reconciles it — the decision is pure
      // (`lib/focusSchedule`), and this only flips the one `amos.settings.dnd`.
      startFocusWatcher(),
      // Remote push deliveries land in the same notification store the NC/banner
      // already render (the mapping is pure: `lib/pushNotifBridge`).
      startPushWatcher(),
      // System-update check (REQ-A1457): the About page can check on demand, but a
      // user who never opens it would never learn an update exists. This only
      // *checks* — staging/flashing stays behind the page's explicit button.
      startOtaWatcher(),
      // User automations (shortcut triggers): the Rust ledger owns *when* they fire
      // (so a time trigger survives "no window open"), this watcher owns the signals
      // the WebView can see (connectivity / battery / app-open) and runs the actions.
      //
      // `isLocked` is a **proxy** (REQ-A412): AmOS's own lock screen, not the device
      // keyguard (that is not visible from the WebView until a host command exists).
      // See `ShortcutTriggerHostOptions.isLocked` for which direction the proxy can
      // under-refuse, so nobody reads this line as "the phone is locked".
      startShortcutTriggers({ isLocked: () => surface().kind === "lock" }),
      // REQ-A429: the four navigation actions below move **this window**, which is the
      // shell's job — but on a desktop an app window *is* one app (REQ-A416) and must not
      // navigate itself (measured: a focus change sent the Settings window home, i.e. it
      // rendered the desktop inside an app window). The predicate is read at **fire** time,
      // not at mount: the host's layout snapshot (which decides `shellForm`) arrives a beat
      // after this list is built, so a start-time decision would answer "phone" for every
      // window and the guard would be dead code on a real launch.
      // `isLocked` is what keeps 「自动息屏」 working past its first fire: this watcher
      // is started once here and the lock it triggers is a *surface* change inside
      // this same component, so without it the loop stopped at the first sleep and
      // the display never auto-off again for the rest of the launch (REQ-A1401).
      startOsAutoOff({
        onSleep: () => navigateSelf(lock),
        isLocked: () => surface().kind === "lock",
      }),
      startOsTelephonyHold(),
      startOsWakeHome({ onHome: () => navigateSelf(goHome) }),
      startOsHardwarePoll({
        onNav: (a) => navigateSelf(a === "home" ? goHome : () => void open("ai")),
      }),
      startOsInputBridge({
        onNav: (a) => navigateSelf(a === "home" ? goHome : () => void open("ai")),
      }),
      // Store tiles: load once, then re-load whenever the Store page pokes
      // (install / uninstall / upgrade). In the watcher list so unmount unsubscribes.
      subscribeStoreTiles(refreshStoreTiles),
    ];
    refreshStoreTiles();
    void startLmkSurfaceWatcher().then((stop) => {
      // REQ-A838: a refused `lmk-surface` listen means the container's kill/reclaim decisions
      // will never reach us — the watcher is a pure event feed with no poll behind it, so the
      // no-op default must stay and `bridgeDiag(LMK_SURFACE_EVENT)` is what says the shell is
      // not watching rather than that the container is calm.
      if (stop === null) return;
      if (lmkDisposed) stop();
      else stopLmkWatch = stop;
    });
    // Passive telemetry-spy egress audit: forward each high `telemetry-spy-hit`
    // from the daemon into a durable notification (the NC / banner render it).
    // Metadata-only by construction (see lib/telemetrySpy); no-op without Tauri.
    void startTelemetrySpyWatcher((hit) => recordSpyHit(hit, t)).then((stop) => {
      // REQ-A838: this one is the sharpest of the three — it is an *audit* surface, and a
      // refused listen leaves it reporting nothing at all while the shell keeps running. An
      // empty egress audit and an audit that is not running are opposite claims;
      // `bridgeDiag(SPY_HIT_EVENT)` is the only place that distinguishes them.
      if (stop === null) return;
      if (spyDisposed) stop();
      else stopSpyWatch = stop;
    });
  });
  onDestroy(() => {
    lmkDisposed = true;
    stopLmkWatch();
    layoutDisposed = true;
    stopLayoutWatch();
    spyDisposed = true;
    stopSpyWatch();
    stopWatchers.forEach((stop) => stop());
    // The shell is the host that OWNS these controlled channels: every surface it
    // drives reads its external props from one of them, and the one-shot UP
    // listeners it registered above are dropped with the component. Disposing the
    // channels here means a re-mounted shell (or a screen that left and comes back)
    // starts from a clean snapshot instead of inheriting the previous mount's state.
    for (const name of ["home", "editHome", "appLibrary", "lock", "recents", "spotlight", "nc"]) {
      disposePropsChannel(name);
    }
    // Clear the snapshot — and with it the form-factor signal — so a torn-down
    // shell can never leave a stale `desktop` answer in the app registry (which
    // would hide phone-only apps on the next mount if the next shell booted on a
    // phone/tablet).
    setLayoutSnapshot(null);
  });

  const s = $derived(surface());

  // Split-screen entry (REQ-A512). The header's affordance only exists where two
  // panes can actually fit (`canSplit()` = the host's measured `columns >= 2`), and
  // the pick itself goes through `enterSplit`, whose **gate is the same one** — so
  // the button's visibility and the transition's admission cannot disagree.
  let splitPicking = $state(false);
  const splitAvailable = $derived(canSplit() && shellForm !== "desktop");

  function startSplitPick(): void {
    splitPicking = true;
    slidePicking = false;
    setRecents(true);
  }

  // Slide Over entry (REQ-A675). Same gate shape as the split's: the affordance only
  // exists where a panel can actually float (`canSlideOver()`), and the pick goes
  // through `openSlideOver`, whose **gate is the same one** — so the button's
  // visibility and the transition's admission cannot disagree.
  let slidePicking = $state(false);
  const slideOverAvailable = $derived(canSlideOver() && shellForm !== "desktop");

  function startSlideOverPick(): void {
    slidePicking = true;
    splitPicking = false;
    setRecents(true);
  }

  /** A pick from the sheet while in "choose a Slide Over app" mode. */
  function pickSlideOver(id: string): void {
    if (!openSlideOver(id)) {
      // Reachable if the screen narrowed between the tap and the pick. Say so and
      // stay put rather than open a panel the class cannot show.
      amosWarn("shell", `slide over refused: the screen no longer fits a panel (${id})`);
    }
  }

  /** A pick from the sheet while in "choose a second app" mode. */
  function pickSecond(id: string): void {
    const cur = s;
    if (cur.kind !== "app") {
      void open(id);
      return;
    }
    if (id === cur.id) return; // the sheet already excludes it; belt and braces
    if (!enterSplit(cur.id, id)) {
      // Reachable if the screen narrowed between the tap and the pick. Say so and
      // stay put rather than enter a split the class cannot show.
      amosWarn("shell", `split refused: the screen no longer fits two panes (${cur.id})`);
    }
  }

  // ③b: the app screen itself is mounted by `AppPane` (REQ-A512), which owns loading
  // its screen by id. It used to live here as a single `AppComp` state, which is also
  // why a split had nowhere to put its second app: one state can hold one screen.
  //
  // ③c-ext (device-independent): the touch shell's **keyboard admission** (re-wired).
  //
  // Before this: one hard-coded "Escape closes the three overlays". It reached *less* than the
  // platform back gesture (never left an app or edit mode) and the registry's four documented
  // launches (⌘Space / F3 / ⌘Tab / F4) had no touch counterpart at all — a device with a keyboard
  // could open nothing. Now the decision comes from `lib/systemKeys` (the registry is the one table
  // that knows the keys; its unit tests survived the rollback) and "up one level" is the same intent
  // as the platform gesture.
  //
  // Two behaviours that took care to get right:
  //   * **Escape belongs to the innermost consumer.** `AppLibrary` clears its search box on Escape
  //     *and* calls `preventDefault()`; registration order puts this listener first, so the home
  //     step is deferred one tick and yields if someone claimed the keystroke.
  //   * **No surface opens over the lock screen** — otherwise a keyboard is a way *around* the lock.
  const overlayTop = $derived(ncOpen() ? "nc" : recentsOpen() ? "recents" : spotOpen() ? "spot" : null);
  const overlayOpen = $derived(overlayTop !== null);

  // G-β-1 · 屏幕降亮遮罩（仅**非桌面**形态）。桌面形态由 `DesktopShell` 画同一层
  // （同一个 `amos.brightness` key、同一个 `brightnessToAlpha`），两条分支互斥，
  // 所以永远不会叠成两层黑。手机 / 平板上整个设备 UI 就是这一个 WebView，遮罩覆盖
  // 的就是整屏内容。z=[85] 高于控制中心 / 最近使用 / Spotlight（=40）与通知条（=70），
  // **低于**来电全屏（=90）—— 压低亮度时来电界面仍清晰可辨。`pointer-events:none`
  // 不抢事件；alpha=0 时不渲染。
  const brightnessStore = createStoreValue<unknown>(BRIGHTNESS_KEY, {});
  let brightnessPct = $state<number>(100);
  $effect(() => {
    const un = brightnessStore.subscribe((v) => {
      brightnessPct = normalizeBrightness(v).pct;
    });
    return un;
  });
  const brightnessAlpha = $derived(brightnessToAlpha(brightnessPct));

  function closeTopOverlay() {
    if (overlayTop === "nc") setNc(false);
    else if (overlayTop === "recents") setRecents(false);
    else if (overlayTop === "spot") setSpot(false);
  }

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The ink layer is modal (REQ-A1590): while it is up it owns the keyboard, and a dismiss
      // lowers *it* — the surface underneath must not also navigate. It is deliberately not part
      // of `overlayTop`/`backActionAt`: those model the shell's *navigation* position (which key
      // opens which surface, how deep the history is), and a scratch drawing is neither.
      if (sysInkOpen()) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeSysInk();
        }
        return;
      }

      const intent = shellKeyIntent(e, SHELL_MODULES);
      if (intent.kind === "none") return;

      if (intent.kind === "toggle" || intent.kind === "settings") {
        // Opening a surface is a capability: the desktop form owns its own chrome (menus), an
        // unknown form must not gain anything, and a locked device must teach nothing.
        if (shellForm === "desktop" || layoutSnap === null) return;
        if (s.kind === "lock") return;
        e.preventDefault();
        if (intent.kind === "settings") void open("settings");
        else if (intent.target === "spot") setSpot(!spotOpen());
        else if (intent.target === "recents") setRecents(!recentsOpen());
        else if (s.kind === "library") goHome();
        else enterLibrary();
        return;
      }

      // Dismiss: route through `backActionAt` (REQ-A321) so the keyboard handler
      // agrees with the platform back gesture and any future consumer. The
      // pure decision tree:
      //   * overlay open   → close it
      //   * split          → collapse to the primary app (REQ-A512)
      //   * app / library  → go home (deferred one tick so an inner consumer
      //                      — the library's search box — can claim the keystroke
      //                      via `preventDefault()` first)
      //   * home / lock    → fall through to the platform ("back at root")
      const overlays = { nc: ncOpen(), recents: recentsOpen(), spot: spotOpen() };
      const action = backActionAt({ surface: s.kind as BackSurface, overlays });
      if (action === "none") return; // at home / locked — let the platform decide
      e.preventDefault();
      if (action === "close-overlay") {
        closeTopOverlay();
        return;
      }
      if (action === "exit-split") {
        // Back inside a split collapses it to the primary app (REQ-A512) — the same
        // step the hardware back gesture takes, from the same decision.
        exitSplit();
        return;
      }
      // action === "home"
      setTimeout(() => {
        if (e.defaultPrevented) return; // an inner consumer (the library's search box) claimed it
        goHome();
      }, 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /**
   * System-back admission, history half (REQ-A321, re-wired in REQ-A347).
   *
   * The host turns the platform back gesture into
   * `if (webView.canGoBack()) goBack() else exit()` (Tauri's generated `WryActivity`). Nothing in
   * this app ever pushed a history entry, so `canGoBack()` was **always false**: pressing back
   * inside an app — or in the App Library, edit mode, or with a sheet open — left AmOS entirely.
   * One entry **per level** is what makes the host's own question agree with what the user sees,
   * and `lib/backNav` (whose 12 unit tests survived the rollback) is the decision tree.
   *
   * Both directions are covered and each half is **idempotent**, so neither can double-step:
   *   * the shell moves deeper  → push an entry (the host now has somewhere to go);
   *   * the shell moves back by itself (home indicator, an in-app back control) → pop the entry it
   *     no longer needs; the resulting `popstate` finds the shell already at that depth and does
   *     nothing;
   *   * a real back press → `popstate` reconciles the shell to the browser's own depth, one level
   *     at a time. At the root nothing happens here **on purpose**: the platform's "back at the
   *     root" (= leave the app) is the correct behaviour there, not something the shell swallows.
   *
   * Desktop is deliberately excluded: the macOS shell has real windows and its own close semantics.
   */
  const backPosition = $derived<BackPosition>({
    surface: s.kind as BackPosition["surface"],
    overlays: { nc: ncOpen(), recents: recentsOpen(), spot: spotOpen() },
  });
  /** How many of our own entries the browser is above the shell's root entry. */
  let historyDepth = 0;
  /**
   * The previous position, so "deeper" and "how many pops" are pure decisions. It starts at the
   * **root**: the page load is the browser's first entry, so a shell that mounts already inside an
   * app (the host boots app windows at `index.html#window=<label>`) still gets an entry for that
   * level — otherwise back would leave AmOS from an app the user never opened from the launcher.
   */
  let lastPosition: BackPosition = {
    surface: "home",
    overlays: { nc: false, recents: false, spot: false },
  };
  /** The position read fresh — the reconciler must see every setter's effect. */
  const readBackPosition = (): BackPosition => ({
    surface: s.kind as BackPosition["surface"],
    overlays: { nc: ncOpen(), recents: recentsOpen(), spot: spotOpen() },
  });
  /** Apply back presses until the shell is at the browser's depth (idempotent). */
  function reconcileBackTo(target: number): void {
    // A platform back gesture with the ink layer up lowers the layer, not the surface underneath
    // — the same rule the Escape branch follows. The ink layer is modal and is not a navigation
    // level (`levelOf` does not count it), so this is where the gesture's meaning is intercepted.
    if (sysInkOpen()) {
      closeSysInk();
      return;
    }
    let guard = 0;
    while (levelOf(readBackPosition()) > target && guard++ < 8) {
      const here = readBackPosition();
      const action = backActionAt(here);
      if (action === "close-overlay") {
        const top = here.overlays;
        if (top.nc) setNc(false);
        else if (top.recents) setRecents(false);
        else setSpot(false);
      } else if (action === "exit-split") {
        exitSplit();
      } else if (action === "home") {
        goHome();
      } else break; // nothing left inside the shell — the platform may exit
    }
  }
  $effect(() => {
    const to = backPosition;
    if (layoutSnap === null || shellForm === "desktop") return;
    if (pushDecision(lastPosition, to) === "push") {
      // **One entry per level**, never one per transition: the shell can jump two levels at once
      // (home → an app with a sheet over it), and a single entry there would make one back press
      // undo both.
      let d = levelOf(lastPosition);
      while (d < levelOf(to)) {
        d += 1;
        historyDepth = d;
        history.pushState({ amosDepth: d }, "");
      }
    } else {
      const back = rewindCount(lastPosition, to);
      if (back > 0) {
        historyDepth = levelOf(to);
        history.go(-back);
      }
    }
    lastPosition = to;
  });
  $effect(() => {
    if (layoutSnap === null || shellForm === "desktop") return;
    const onPop = (e: PopStateEvent) => {
      const state = e.state as { amosDepth?: number } | null;
      historyDepth = typeof state?.amosDepth === "number" ? state.amosDepth : 0;
      reconcileBackTo(historyDepth);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });

  function appTitle(id: string): string {
    // A store-installed tile carries its own (manifest) name; it has no i18n key.
    const tile = tileById(id);
    if (tile) return tile.name;
    const key = appTitleKey(id);
    return key ? t(key) : id;
  }

  // Edge gestures (pure decisions in lib/edgeSwipe): pull DOWN from the top edge
  // opens the Notification Center; pull UP from the bottom edge opens Recents.
  // Only a drag that *starts* inside a thin edge zone counts, so app scrolling
  // and the HomeDock body swipe (→ Spotlight) are never stolen. Suppressed on
  // the lock screen.
  let edgeDrag = $state<{ edge: Edge; startY: number; fired: boolean } | null>(null);
  let shellEl = $state<HTMLDivElement | null>(null);
  function onEdgeDown(e: PointerEvent) {
    if (s.kind === "lock") return;
    const edge = edgeAtY(e.clientY, window.innerHeight);
    edgeDrag = edge ? { edge, startY: e.clientY, fired: false } : null;
  }
  function onEdgeMove(e: PointerEvent) {
    const d = edgeDrag;
    if (!d || d.fired) return;
    if (!pastEdgeThreshold(d.edge, d.startY, e.clientY)) return;
    d.fired = true; // fire once per gesture
    if (d.edge === "top") setNc(true);
    else setRecents(true);
  }
  function onEdgeUp() {
    edgeDrag = null;
  }
  // Registered imperatively: an edge pull is an OS-level gesture (raw pointer
  // tracking), not an element interaction, so the root must not advertise an
  // interactive ARIA role just to satisfy the a11y lint.
  $effect(() => {
    const el = shellEl;
    if (!el) return;
    el.addEventListener("pointerdown", onEdgeDown);
    el.addEventListener("pointermove", onEdgeMove);
    el.addEventListener("pointerup", onEdgeUp);
    el.addEventListener("pointercancel", onEdgeUp);
    return () => {
      el.removeEventListener("pointerdown", onEdgeDown);
      el.removeEventListener("pointermove", onEdgeMove);
      el.removeEventListener("pointerup", onEdgeUp);
      el.removeEventListener("pointercancel", onEdgeUp);
    };
  });
</script>

<div class="relative h-full w-full overflow-hidden" bind:this={shellEl}>
  {#if ready}
    {#if s.kind === "lock"}
      <LockScreen />
    {:else if layoutSnap?.form === "desktop"}
      <!-- 桌面形态（PC / macOS）：UI 拓扑走 DesktopShell，顶栏 + Dock + 舞台 + 浮层。
           手机/平板形态保持原 shell 不变。

           REQ-A416：**只有启动器窗口**画那套 chrome。宿主为每个 app 建的窗口都带
           `index.html#window=<label>`，`shell-entry.ts` 把它变成 `surface = app(id)`
           —— 此前桌面分支无条件渲染 `DesktopShell`，于是 PC 上每一个"应用窗口"都是
           另一份桌面（舞台 + Dock + 菜单栏），**没有任何窗口画出过 app 本身**
           （`docs/PC_DESKTOP_ARCHITECTURE.md` §2.2 写的却是 `app — 聚焦 app 窗口`）。
           现在：`s.kind === "app"` ⇒ 这个窗口画它自己那个应用，其余（启动器 / 锁屏 /
           片段无法解析成 app 的窗口）仍是桌面壳。 -->
      {#if s.kind === "app"}
        <DesktopAppWindow id={s.id} {ext} />
      {:else}
        <!-- REQ-A1179: the desktop chrome draws the *same* layout the touch home draws, so it
             gets the same tile list the same way — pushed, from the one component that loads it. -->
        <DesktopShell {ext} />
      {/if}

      <!-- 系统级手写层（REQ-A1590；桌面挂载点补于 REQ-A1670）：桌面形态下也画。
           控制中心（桌面浮层 `control-center-panel`，ControlCenter.svelte）的
           「系统级手写」按钮调 `openSysInk()`，此前本分支没有挂载它 —— 于是那个按钮
           在 PC 上**静默无效**（`_sysInkOpen` 被置真，屏幕上什么都不出现）。
           每个桌面窗口是独立 WebView，所以它盖住的是唤起它的那个窗口（边界写在组件头）。 -->
      <SystemInkLayer />
    {:else}
      {#if s.kind === "edit"}
        <EditHome />
      {:else if s.kind === "library"}
        <div class="flex h-full flex-col" inert={overlayOpen}>
          <Backdrop />
          <div class="relative z-10 flex h-full flex-col">
            <StatusBar form={shellForm} />
            <div class="min-h-0 flex-1">
              <AppLibrary />
            </div>
          </div>
        </div>
      {:else if s.kind === "app"}
        <div class="h-full" inert={overlayOpen}>
          <AppPane id={s.id} form={shellForm} onback={goHome}>
            {#snippet trailing()}
              <!-- Split entry (REQ-A512): only where two panes can actually fit — the
                   host's *measured* `columns` (phone ⇒ 1 ⇒ no entry at all, so a phone
                   never offers a control that could not work). -->
              {#if splitAvailable}
                <button
                  onclick={startSplitPick}
                  aria-label={t("a11y.splitEnter")}
                  title={t("a11y.splitEnter")}
                  data-testid="split-enter"
                  class="grid h-11 w-11 cursor-pointer place-items-center rounded-full text-accent transition active:bg-black/5 dark:active:bg-white/10"
                >
                  <span class="block h-6 w-6" aria-hidden="true">▥</span>
                </button>
              {:else}
                <span class="w-10"></span>
              {/if}
              <!-- Slide Over entry (REQ-A675): a floating panel needs the same room a
                   split does, so it shares the measured gate. -->
              {#if slideOverAvailable}
                <button
                  onclick={startSlideOverPick}
                  aria-label={t("a11y.slideOverEnter")}
                  title={t("a11y.slideOverEnter")}
                  data-testid="slide-over-enter"
                  class="grid h-11 w-11 cursor-pointer place-items-center rounded-full text-accent transition active:bg-black/5 dark:active:bg-white/10"
                >
                  <span class="block h-6 w-6" aria-hidden="true">▤</span>
                </button>
              {/if}
            {/snippet}
          </AppPane>
        </div>
      {:else if s.kind === "split"}
        <div class="flex h-full flex-col" inert={overlayOpen}>
          <StatusBar form={shellForm} />
          <div class="min-h-0 flex-1">
            <SplitSurface form={shellForm} />
          </div>
        </div>
      {:else}
        <!-- home surface -->
        <div class="flex h-full flex-col" inert={overlayOpen}>
          <Backdrop />
          <div class="relative z-10 flex h-full flex-col">
            <StatusBar form={shellForm} />
            <!-- The home grid is drawn from `_layout`; a refused layout write keeps that
                 memory where it was, and this is the one line that says so. -->
            {#if layoutRefused()}
              <div class="px-4 pt-2"><StoreErrorBar message={t("common.storeWriteFailed")} /></div>
            {/if}
            <div class="min-h-0 flex-1">
              <HomeDock />
            </div>
          </div>
        </div>
      {/if}

      <!-- The floating Slide Over panel (REQ-A675): above the surface it overlays,
           below the system sheets so Notification Center etc. still cover it. -->
      <SlideOverSurface form={shellForm} />

      <!-- ③c: always-on chrome + overlays above home/app/edit -->
      <NotificationBanner />
      <IncomingCall />
      <RecentsPanel />
      <SpotlightPanel />
      <NotificationCenter />
      <ClipboardAnnounce />
      <!-- System share sheet (REQ-A703): renders nothing while closed. -->
      <ShareSheet />
      <!-- Input method: the pinyin keyboard for whichever text field is focused. -->
      <ImeOverlay />
      <!-- Cross-app drag & drop (REQ-A683): the chip that follows the pointer while
           an item is dragged between panes. Renders nothing when no drag is live. -->
      <DragGhost />
      {#if layoutSnap !== null}
        <ShortcutHud />
      {/if}

      <!-- 系统级手写层（REQ-A1590）：浮在整个 shell 之上、画在任意界面上。控制中心
           两处都能唤起；桌面形态下它盖住的是**唤起它的那个窗口**（应用窗口是独立原生
           窗口，WebView 里的浮层盖不到别的窗口 —— 边界写在组件头）。 -->
      <SystemInkLayer />

      <!-- G-β-1 · 屏幕降亮遮罩（仅非桌面形态；桌面形态由 DesktopShell 画同一层）。
           slider 在控制中心（NotificationCenter），两边共用 lib/brightness.ts 的
           `brightnessToAlpha`。pointer-events:none 不抢事件；alpha=0 时不渲染。 -->
      {#if brightnessAlpha > 0}
        <div
          class="pointer-events-none absolute inset-0 z-[85] bg-black"
          style="opacity: {brightnessAlpha}"
          data-testid="brightness-overlay"
          data-brightness-pct={brightnessPct}
          aria-hidden="true"
        ></div>
      {/if}
    {/if}
  {/if}
</div>
