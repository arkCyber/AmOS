<script lang="ts">
  // Shell.svelte — Svelte top-level shell (Phase-3 ③a skeleton). Reads the
  // React-free shellState to decide which Svelte surface to render, and feeds the
  // controlled channels the Svelte screens read (HomeDock "home", EditHome
  // "editHome", LockScreen "lock"). ③b adds real app mounting; ③c adds overlays
  // (Recents/Spotlight/NC) + hardware/edge policies. React-free import graph.
  import { onMount, onDestroy } from "svelte";
  import { propsChannel } from "./propsBus";
  import { svelteAppLoader } from "./appRegistry";
  import { appTitleKey } from "../lib/appMeta";
  import { t } from "./locale.svelte";
  import type { HomeLayout } from "../lib/amosStore";
  import { moveBefore, addAppsToDock } from "../lib/amosStore";
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
  import { startOsInputBridge, startOsHardwarePoll } from "./osInputBridge";
  import { startLmkSurfaceWatcher, startPeriodicReconcile } from "../lib/lmk";
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

  interface HomeProps {
    layout: HomeLayout;
    ext: never[];
    pulseId: string | null;
  }

  // Feed the controlled screens from shellState whenever the visible surface is
  // one that reads that channel (no remount — reactive channel set).
  $effect(() => {
    if (surface().kind === "home") {
      propsChannel<HomeProps>("home").set({
        layout: layout(),
        ext: [],
        pulseId: pulseId(),
      });
    }
  });
  // Feed the App Library screen (layout + any store-installed tiles) whenever that
  // surface is shown. The standalone Svelte shell hosts no store apps yet.
  $effect(() => {
    if (surface().kind === "library") {
      propsChannel<{ layout: HomeLayout; ext: never[] }>("appLibrary").set({
        layout: layout(),
        ext: [],
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
    return propsChannel<{ layout: HomeLayout; ext: never[] }>("appLibrary").on((e, d) => {
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
  // Async LMK surface-watch unsubscribe (resolved after onMount returns), released
  // in onDestroy — also released immediately if unmount beats the resolution.
  let stopLmkWatch = () => {};
  let lmkDisposed = false;
  onMount(() => {
    ready = true;
    // Pure-Svelte host: surface a running countdown's "time's up" and a due alarm
    // even when the Clock app isn't the focused surface (suppressed while focused).
    const getActive = () => {
      const s = surface();
      return s.kind === "app" ? s.id : null;
    };
    // Keep `legacy:*` external surfaces consistent with the daemon's authoritative
    // container LMK snapshot (parity with the React shell's startup wiring): tear
    // down surfaces the container reclaimed/destroyed and reconcile periodically.
    stopWatchers = [
      startPeriodicReconcile(),
      startTimerWatcher(getActive),
      startAlarmWatcher(getActive),
      startReminderWatcher(getActive),
      startCalendarWatcher(getActive),
      startOsAutoOff({ onSleep: lock }),
      startOsHardwarePoll({
        onNav: (a) => (a === "home" ? goHome() : open("ai")),
      }),
      startOsInputBridge({
        onNav: (a) => (a === "home" ? goHome() : open("ai")),
      }),
    ];
    void startLmkSurfaceWatcher().then((stop) => {
      if (lmkDisposed) stop();
      else stopLmkWatch = stop;
    });
  });
  onDestroy(() => {
    lmkDisposed = true;
    stopLmkWatch();
    stopWatchers.forEach((stop) => stop());
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

  // ③c-ext (device-independent): Esc closes any open overlay — same as React shell.
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
    const key = appTitleKey(id);
    return key ? t(key) : id;
  }
</script>

<div class="relative h-full w-full overflow-hidden">
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
              {#if AppComp}
                <AppComp />
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
    {/if}
  {/if}
</div>
