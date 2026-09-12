<script lang="ts">
  // Shell.svelte — Svelte top-level shell (Phase-3 ③a skeleton). Reads the
  // React-free shellState to decide which Svelte surface to render, and feeds the
  // controlled channels the Svelte screens read (HomeDock "home", EditHome
  // "editHome", LockScreen "lock"). ③b adds real app mounting; ③c adds overlays
  // (Recents/Spotlight/NC) + hardware/edge policies. React-free import graph.
  import { onMount, onDestroy } from "svelte";
  import { propsChannel, disposePropsChannel } from "./propsBus";
  import { svelteAppLoader } from "./appRegistry";
  import { appTitleKey, isKnownApp } from "../lib/appMeta";
  import { t } from "./locale.svelte";
  import type { HomeLayout } from "../lib/amosStore";
  import { moveBefore, addAppsToDock, readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { CONTACTS_KEY, seedContacts } from "../lib/contacts";
  import {
    applyLayout,
    enterEdit,
    enterLibrary,
    exitEdit,
    goHome,
    layout,
    lock,
    ncOpen,
    open,
    pulseId,
    recentsOpen,
    setNc,
    setRecents,
    setSpot,
    softLaunch,
    spotOpen,
    surface,
    unlock,
  } from "./shellState.svelte";
  import LockScreen from "./LockScreen.svelte";
  import { startTimerWatcher } from "./osTimerWatcher";
  import { startAlarmWatcher } from "./osAlarmWatcher";
  import { startReminderWatcher } from "./osReminderWatcher";
  import { startCalendarWatcher } from "./osCalendarWatcher";
  import { startOsAutoOff } from "./osAutoOff";
  import { startOsTelephonyHold } from "./osTelephonyHold";
  import { startOsWakeHome } from "./osWakeHome";
  import { reassertScreenOnUnlocked, reportScreenOff, reportScreenOn } from "./osScreenState";
  import { edgeAtY, pastEdgeThreshold, type Edge } from "../lib/edgeSwipe";
  import { startOsInputBridge, startOsHardwarePoll } from "./osInputBridge";
  import { startLmkSurfaceWatcher, startPeriodicReconcile } from "../lib/lmk";
  import { recordSpyHit, startTelemetrySpyWatcher } from "../lib/telemetrySpy";
  import {
    getStoreTiles,
    isExtId,
    loadStoreTiles,
    midOf,
    subscribeStoreTiles,
    tileById,
    type StoreTile,
  } from "../lib/storeApps";
  import HomeDock from "./HomeDock.svelte";
  import EditHome from "./EditHome.svelte";
  import AppLibrary from "./AppLibrary.svelte";
  import StatusBar from "./StatusBar.svelte";
  import Backdrop from "./Backdrop.svelte";
  import NotificationBanner from "./NotificationBanner.svelte";
  import IncomingCall from "./IncomingCall.svelte";
  import RecentsPanel from "./RecentsPanel.svelte";
  import SpotlightPanel from "./SpotlightPanel.svelte";
  import NotificationCenter from "./NotificationCenter.svelte";
  import ClipboardAnnounce from "./ClipboardAnnounce.svelte";

  interface HomeProps {
    layout: HomeLayout;
    ext: StoreTile[];
    pulseId: string | null;
  }

  // Store-installed (third-party) tiles live in the module cache in
  // `lib/storeApps`, which only `loadStoreTiles` ever populates — and the Store
  // page pokes `notifyStoreTilesChanged()` after install/uninstall. So the shell
  // loads the tiles once and re-loads on every poke; without this the cache stays
  // empty, and an installed app never appears on the home screen / App Library.
  let ext = $state<StoreTile[]>(getStoreTiles());
  const refreshStoreTiles = () => {
    void loadStoreTiles().then((tiles) => (ext = tiles));
  };

  // Feed the controlled screens from shellState whenever the visible surface is
  // one that reads that channel (no remount — reactive channel set).
  $effect(() => {
    if (surface().kind === "home") {
      propsChannel<HomeProps>("home").set({
        layout: layout(),
        ext,
        pulseId: pulseId(),
      });
    }
  });
  // Feed the App Library screen (layout + any store-installed tiles) whenever that
  // surface is shown — the ext tiles make an installed store app addable to the
  // home screen / dock.
  $effect(() => {
    if (surface().kind === "library") {
      propsChannel<{ layout: HomeLayout; ext: StoreTile[] }>("appLibrary").set({
        layout: layout(),
        ext,
      });
    }
  });
  $effect(() => {
    if (surface().kind === "edit") {
      propsChannel<{ layout: HomeLayout }>("editHome").set({ layout: layout() });
    }
  });

  // ③c: feed overlay open flags from shellState (home & app surfaces).
  $effect(() => propsChannel<{ open: boolean }>("recents").set({ open: shellRecents() }));
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
      if (e === "open" && typeof d === "string") open(d);
      else if (e === "move") {
        const m = d as { drag: string; over: string };
        applyLayout(moveBefore(layout(), m.drag, m.over));
      } else if (e === "search") setSpot(true);
      else if (e === "library") enterLibrary();
    });
  });
  $effect(() => {
    return propsChannel<{ layout: HomeLayout }>("editHome").on((e, d) => {
      if (e === "change") applyLayout(d as HomeLayout);
      else if (e === "done") exitEdit();
    });
  });
  $effect(() => {
    return propsChannel<{ layout: HomeLayout; ext: StoreTile[] }>("appLibrary").on((e, d) => {
      if (e === "open" && typeof d === "string") open(d);
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
      if (e === "open" && typeof d === "string") open(d);
      else if (e === "close") setRecents(false);
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
      startOsAutoOff({ onSleep: lock }),
      startOsTelephonyHold(),
      startOsWakeHome({ onHome: goHome }),
      startOsHardwarePoll({
        onNav: (a) => (a === "home" ? goHome() : open("ai")),
      }),
      startOsInputBridge({
        onNav: (a) => (a === "home" ? goHome() : open("ai")),
      }),
      // Store tiles: load once, then re-load whenever the Store page pokes
      // (install / uninstall / upgrade). In the watcher list so unmount unsubscribes.
      subscribeStoreTiles(refreshStoreTiles),
    ];
    refreshStoreTiles();
    void startLmkSurfaceWatcher().then((stop) => {
      if (lmkDisposed) stop();
      else stopLmkWatch = stop;
    });
    // Passive telemetry-spy egress audit: forward each high `telemetry-spy-hit`
    // from the daemon into a durable notification (the NC / banner render it).
    // Metadata-only by construction (see lib/telemetrySpy); no-op without Tauri.
    void startTelemetrySpyWatcher((hit) => recordSpyHit(hit, t)).then((stop) => {
      if (spyDisposed) stop();
      else stopSpyWatch = stop;
    });
  });
  onDestroy(() => {
    lmkDisposed = true;
    stopLmkWatch();
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
  });

  const s = $derived(surface());

  // ③b: load + mount the active app screen by id (React-free registry).
  let AppComp = $state<any>(null);
  $effect(() => {
    if (s.kind !== "app") {
      AppComp = null;
      return;
    }
    const load = svelteAppLoader(s.id);
    if (!load) {
      AppComp = null;
      return;
    }
    let alive = true;
    load().then((m) => {
      if (alive) AppComp = m.default;
    });
    return () => {
      alive = false;
    };
  });

  // ③c-ext (device-independent): Esc closes any open overlay.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNc(false);
        setRecents(false);
        setSpot(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    {:else}
      {#if s.kind === "edit"}
        <EditHome />
      {:else if s.kind === "library"}
        <div class="flex h-full flex-col">
          <Backdrop />
          <div class="relative z-10 flex h-full flex-col">
            <StatusBar />
            <div class="min-h-0 flex-1">
              <AppLibrary />
            </div>
          </div>
        </div>
      {:else if s.kind === "app"}
        <div
          class="flex h-full flex-col text-neutral-900 dark:text-neutral-100"
          data-testid="app-surface"
        >
          <StatusBar />
          <div class="flex items-center justify-between border-b border-neutral-200/70 bg-white/50 px-3 py-3 backdrop-blur-md dark:border-neutral-800 dark:bg-white/5">
            <button
              onclick={goHome}
              aria-label="back"
              class="-ml-1 grid h-10 w-10 cursor-pointer place-items-center rounded-full text-accent text-[17px] font-semibold transition active:bg-black/5 dark:active:bg-white/10"
            >‹</button>
            <span class="flex-1 truncate text-center text-[17px] font-semibold tracking-tight">{appTitle(s.id)}</span>
            <span class="w-10"></span>
          </div>
          <!-- The app host is the ScrollView: content-flow apps (Settings, Phone,
               Photos, Clock…) grow past the viewport and scroll here. Without
               overflow-y-auto they'd clip on device (content below unreachable). -->
          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {#key s.id}
              {#if isExtId(s.id)}
                <!-- A store-installed app has a tile + manifest but no local Svelte
                     screen: its web-bundle runtime host is not built yet. Say so
                     honestly instead of showing a blank app frame. -->
                <div
                  data-testid="ext-app-pending"
                  class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
                >
                  <span class="text-3xl" aria-hidden="true">🧩</span>
                  <p class="text-sm font-semibold">{appTitle(s.id)}</p>
                  <p class="text-xs opacity-60">{t("store.extPending", { id: midOf(s.id) })}</p>
                </div>
              {:else if AppComp}
                <AppComp />
              {:else}
                <!-- An id with no mounted screen (a built-in whose loader is absent
                     in this build, or an unknown id from a link/layout): never a
                     blank frame. `isKnownApp` separates the two honestly. -->
                <div
                  data-testid="app-unavailable"
                  class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
                >
                  <span class="text-3xl" aria-hidden="true">❓</span>
                  <p class="text-sm font-semibold">{appTitle(s.id)}</p>
                  <p class="text-xs opacity-60">
                    {isKnownApp(s.id)
                      ? t("app.screenMissing", { id: s.id })
                      : t("app.unknown", { id: s.id })}
                  </p>
                </div>
              {/if}
            {/key}
          </div>
          <!-- Home indicator: a horizontal bar (iOS-style); tapping returns to the
               shell home. The whole strip is the touch target (44px tall for touch). -->
          <div class="flex justify-center pb-2 pt-1">
            <button
              aria-label="home"
              data-testid="home-indicator"
              title="Home"
              onclick={goHome}
              class="grid w-40 cursor-pointer place-items-center py-2"
            >
              <span class="block h-1.5 w-16 rounded-full bg-neutral-800/80 ring-1 ring-white/10 dark:bg-neutral-200/90 dark:ring-black/10"></span>
            </button>
          </div>
        </div>
      {:else}
        <!-- home surface -->
        <div class="flex h-full flex-col">
          <Backdrop />
          <div class="relative z-10 flex h-full flex-col">
            <StatusBar />
            <div class="min-h-0 flex-1">
              <HomeDock />
            </div>
          </div>
        </div>
      {/if}

      <!-- ③c: always-on chrome + overlays above home/app/edit -->
      <NotificationBanner />
      <IncomingCall />
      <RecentsPanel />
      <SpotlightPanel />
      <NotificationCenter />
      <ClipboardAnnounce />
    {/if}
  {/if}
</div>
