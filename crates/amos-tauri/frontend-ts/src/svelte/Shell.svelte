<script lang="ts">
  // Shell.svelte — Svelte top-level shell (Phase-3 ③a skeleton). Reads the
  // React-free shellState to decide which Svelte surface to render, and feeds the
  // controlled channels the Svelte screens read (HomeDock "home", EditHome
  // "editHome", LockScreen "lock"). ③b adds real app mounting; ③c adds overlays
  // (Recents/Spotlight/NC) + hardware/edge policies. React-free import graph.
  import { onMount } from "svelte";
  import { propsChannel } from "./propsBus";
  import { svelteAppLoader } from "./appRegistry";
  import { appTitleKey } from "../lib/appMeta";
  import { t } from "./locale.svelte";
  import type { HomeLayout } from "../lib/amosStore";
  import { moveBefore } from "../lib/amosStore";
  import {
    applyLayout,
    enterEdit,
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
  import HomeDock from "./HomeDock.svelte";
  import EditHome from "./EditHome.svelte";
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
    });
  });
  $effect(() => {
    return propsChannel<{ layout: HomeLayout }>("editHome").on((e, d) => {
      if (e === "change") applyLayout(d as HomeLayout);
      else if (e === "done") exitEdit();
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
  onMount(() => {
    ready = true;
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
      {:else if s.kind === "app"}
        <div class="flex h-full flex-col" data-testid="app-surface">
          <StatusBar />
          <div class="flex items-center justify-between border-b border-neutral-200/70 bg-white/50 px-3 py-2 backdrop-blur-md dark:border-neutral-800 dark:bg-white/5">
            <button onclick={goHome} aria-label="back" class="w-6 text-accent text-sm font-semibold">‹</button>
            <span class="flex-1 truncate text-center text-sm font-semibold">{appTitle(s.id)}</span>
            <span class="w-6"></span>
          </div>
          <div class="min-h-0 flex-1">
            {#key s.id}
              {#if AppComp}
                <AppComp />
              {/if}
            {/key}
          </div>
          <!-- Home indicator (matches the OS home gesture; returns to the shell home) -->
          <div class="flex justify-center pb-1 pt-1">
            <button
              aria-label="home"
              data-testid="home-indicator"
              onclick={goHome}
              class="grid h-6 w-6 place-items-center rounded-full bg-neutral-800/80 ring-1 ring-white/20"
            >⌂</button>
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
