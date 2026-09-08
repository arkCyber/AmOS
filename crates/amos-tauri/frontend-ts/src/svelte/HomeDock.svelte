<script lang="ts">
  // HomeDock.svelte — Svelte 5 (runes) port of the React `HomeDock` (the home
  // screen: widgets + paged icon grid + single-row bottom dock bar).
  //
  // It is a CONTROLLED leaf: the React shell owns navigation + the home layout,
  // and pushes { layout, ext, pulseId } down reactively through the shared
  // propsBus channel "home" (in-place, no remount → the icon-grid page index is
  // preserved across reorders). One-shot actions (open / move / search) go back
  // up over the same channel.
  //
  // Pure logic is REUSED, not rewritten: model helpers from lib/settings,
  // i18n from locale.svelte.ts, notifications/DND reactively via createStoreValue
  // (svelte/store) — the twin of React's useStoreValue.
  import { t, locale } from "./locale.svelte";
  import { homeDownToSpotlight } from "../lib/edgeSwipe";
  import { onMount } from "svelte";
  import { appIcon, appTitleKey } from "../lib/appMeta";
  import type { HomeLayout } from "../lib/amosStore";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    countForApp,
    dndActive,
    normalizeQuick,
    type Notif,
  } from "../lib/settings";
  import { createStoreValue } from "./store";
  import type { StoreTile } from "../lib/storeApps";
  import { propsChannel } from "./propsBus";
  import AppIcon from "./AppIcon.svelte";
  import { fmtClock } from "../lib/time";
  import { forecast } from "../lib/weather";
  import { zh, type MessageKey } from "../i18n/locales/zh";
  import { amosLog, amosWarn } from "../lib/debugLog";

  interface HomeProps {
    layout: HomeLayout;
    ext: StoreTile[];
    pulseId: string | null;
  }
  const home = propsChannel<HomeProps>("home");

  // ---- External props (host pushes in place; never remounts) ----
  let incoming = $state<HomeProps | null>(null);
  $effect(() => {
    const un = home.subscribe((v) => {
      if (v !== undefined) incoming = v;
    });
    return un;
  });

  const EMPTY_LAYOUT: HomeLayout = { page: [], dock: [], hidden: [] };
  const layout = $derived(incoming?.layout ?? EMPTY_LAYOUT);
  const ext = $derived(incoming?.ext ?? []);
  const pulseId = $derived(incoming?.pulseId ?? null);

  // ---- Reactive notifications + Do-Not-Disturb (live, cross-window) ----
  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  const quickStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  let notifs = $state<Notif[]>([]);
  let quick = $state<unknown>({});
  $effect(() => {
    const un = notifStore.subscribe((v) => (notifs = v));
    return un;
  });
  $effect(() => {
    const un = quickStore.subscribe((v) => (quick = v));
    return un;
  });
  const quiet = $derived(dndActive(normalizeQuick(quick)));

  // iOS-aligned: NO always-on drag-to-reorder on the home (reordering happens in
  // the Edit-Home surface). A mouse drag therefore pages the icon grid left/right
  // exactly like a touch swipe. State shared by the mouse + touch paging handlers.
  let mousePanX: number | null = null;
  let mousePanned = false;

  // ---- label / badge / icon resolution (pure lib reuse) ----
  const extById = $derived(new Map(ext.map((e) => [e.id, e])));
  const extName = (id: string): string | undefined => extById.get(id)?.name;
  const known = (id: string): boolean => appTitleKey(id) !== null || extById.has(id);
  const zhName = (id: string): string => {
    const key = appTitleKey(id) as MessageKey | null;
    return key ? zh[key] : (extName(id) ?? id);
  };
  const labelOf = (id: string): string => {
    const key = appTitleKey(id);
    return key ? t(key) : (extName(id) ?? id);
  };
  const iconOf = (id: string): string => extById.get(id)?.icon ?? appIcon(id);
  const unreadOf = (id: string): number =>
    quiet || extById.has(id) ? 0 : countForApp(notifs, zhName(id));


  // ---- Main icon grid: horizontal multi-page (widgets fixed; dock single row) ----
  const pageIds = $derived(layout.page.filter(known));
  const dockIds = $derived(layout.dock.filter(known));

  function buildPages(ids: string[]): string[][] {
    const pages: string[][] = [];
    const per = 12; // 4 cols x 3 rows
    for (let i = 0; i < ids.length; i += per) pages.push(ids.slice(i, i + per));
    return pages;
  }
  const gridPages = $derived(buildPages(pageIds));
  let gridPage = $state(0);
  const lastIndex = $derived(Math.max(0, gridPages.length - 1));
  const safePage = $derived(gridPage > lastIndex ? lastIndex : gridPage);
  const shownGrid = $derived(gridPages[safePage] ?? []);
  // Clamp the stored page index when the grid shrinks (parity with the React
  // `useEffect` clamp): a stale high index must not auto-jump back to a later
  // page if the grid is later expanded again.
  $effect(() => {
    if (gridPage > lastIndex) gridPage = lastIndex;
  });

  // Transient gesture state (non-reactive mirrors of the React refs).
  let dragId: string | null = null;
  let panX: number | null = null;
  let panned = false;

  // ---- Icon grid paging (shared page-turn logic) ----
  function handleTap(id: string): void {
    if (dragId) {
      dragId = null; // a click right after a page-swipe shouldn't open the app
      return;
    }
    home.emit("open", id);
  }
  function pageBy(dx: number): void {
    // Reset the click-suppression flag for the gesture that just happened.
    dragId = "__grid_pan__";
    window.setTimeout(() => {
      if (dragId === "__grid_pan__") dragId = null;
    }, 300);
    if (gridPages.length <= 1) {
      // A single page has nowhere to page to — a swipe to the left is the iOS
      // "keep going past the last page" gesture that opens the App Library.
      if (dx < 0) home.emit("library");
    } else if (gridPage >= gridPages.length - 1 && dx < 0) {
      // Past the last icon page → the trailing "App Library" page.
      home.emit("library");
    } else if (dx < 0) {
      gridPage = Math.min(gridPage + 1, gridPages.length - 1);
    } else {
      gridPage = Math.max(gridPage - 1, 0);
    }
  }

  function onGridStart(e: TouchEvent): void {
    const x = e.touches[0]?.clientX;
    panX = x == null ? null : x;
    panned = false;
  }
  function onGridMove(e: TouchEvent): void {
    const x0 = panX;
    if (x0 == null || panned) return;
    const x = e.touches[0]?.clientX;
    if (x == null) return;
    const dx = x - x0;
    if (Math.abs(dx) < 48) return;
    panned = true;
    panX = null;
    pageBy(dx);
  }
  function onGridEnd(): void {
    panX = null;
  }

  // ---- Mouse paging: drag anywhere on the home column with the mouse to page
  // (mouse/pen). Touch keeps its existing handlers; we only react to mouse here
  // so a mouse drag = page, aligned with iOS page swipes. Native HTML5
  // drag-reorder is disabled on the home (reorder lives in Edit-Home). -->
  function onMouseDown(e: PointerEvent): void {
    if (e.pointerType !== "mouse") return;
    mousePanX = e.clientX;
    mousePanned = false;
    // NOTE: deliberately NO setPointerCapture here — capturing the pointer onto
    // this container would redirect the synthesized `click` to the container too,
    // so tapping an app icon would stop opening the app. Mouse drags stay within
    // the full-width home column, so move events continue to bubble to us anyway.
    // A click (no >48px move) still opens the app; a big horizontal drag pages.
  }
  function onMouseMove(e: PointerEvent): void {
    if (e.pointerType !== "mouse") return;
    const x0 = mousePanX;
    if (x0 == null || mousePanned) return;
    const dx = e.clientX - x0;
    if (Math.abs(dx) < 48) return;
    mousePanned = true;
    mousePanX = null;
    pageBy(dx);
  }
  function onMouseUp(e: PointerEvent): void {
    if (e.pointerType !== "mouse") return;
    mousePanX = null;
    mousePanned = false;
  }
  function onMouseCancel(): void {
    mousePanX = null;
    mousePanned = false;
  }

  // ---- Home-body downward swipe → Spotlight (iPhone "swipe down on Home to
  // search"). The top status edge is reserved for the Notification Center, and
  // the bottom zone for the dock / Recents — see lib/edgeSwipe.ts. The gesture is
  // *vertically dominant* (down travel > |horizontal travel|) so an intentional
  // left/right page-swipe on the icon grid never also opens Spotlight.
  let swipeX: number | null = null;
  let swipeY: number | null = null;
  function onHomeTouchStart(e: TouchEvent): void {
    const t = e.touches[0];
    swipeX = t == null ? null : t.clientX;
    swipeY = t == null ? null : t.clientY;
  }
  function onHomeTouchEnd(e: TouchEvent): void {
    const x0 = swipeX;
    const y0 = swipeY;
    swipeX = null;
    swipeY = null;
    if (x0 == null || y0 == null) return;
    const t = e.changedTouches[0];
    if (t == null) return;
    const dy = t.clientY - y0;
    const dx = Math.abs(t.clientX - x0);
    // Vertically dominant downward swipe within the home body → Spotlight.
    if (dy > dx && homeDownToSpotlight(y0, t.clientY, window.innerHeight)) home.emit("search");
  }
  // A system/touch-cancel interrupts the gesture → never open Spotlight, just reset.
  function onHomeTouchCancel(): void {
    swipeX = null;
    swipeY = null;
  }

  // ---- on-device diagnosis for "dock not rendering" (parity with React) ----
  onMount(() => {
    amosLog("dock", "mounted", { gridPages: gridPages.length, pageIds, dockIds });
  });
  let lastEmpty: boolean | null = null;
  const emptyNow = $derived(dockIds.length === 0);
  $effect(() => {
    if (emptyNow && emptyNow !== lastEmpty) {
      amosWarn("dock", "dock icon list is empty", { dockIds });
    }
    lastEmpty = emptyNow;
  });

  // ---- widgets (clock + weather, live clock) ----
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
  const today = $derived(forecast()[0]);
  const dateStr = $derived(
    new Intl.DateTimeFormat(locale() === "zh" ? "zh-CN" : "en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(now),
  );
</script>


<div
  class="flex h-full flex-col px-4 pb-3"
  role="group"
  aria-label="home screen"
  style="touch-action: none"
  ontouchstart={onHomeTouchStart}
  ontouchend={onHomeTouchEnd}
  ontouchcancel={onHomeTouchCancel}
  onpointerdown={onMouseDown}
  onpointermove={onMouseMove}
  onpointerup={onMouseUp}
  onpointercancel={onMouseCancel}
>
  <!-- main paged region: a horizontal swipe ANYWHERE in this column pages the
       icon grid; widgets stay fixed above, bottom dock stays a single row below -->
  <div
    class="flex min-h-0 flex-1 flex-col overflow-hidden"
    role="group"
    aria-label="home pages"
    style="touch-action: pan-y"
    ontouchstart={onGridStart}
    ontouchmove={onGridMove}
    ontouchend={onGridEnd}
    ontouchcancel={onGridEnd}
  >
    <!-- fixed widgets header -->
    <div class="shrink-0 px-1 pt-[48px]">
      <div class="grid grid-cols-[1fr_auto] gap-3">
        <button
          class="flex flex-col justify-center rounded-3xl bg-white/40 p-4 text-left shadow-sm ring-1 ring-black/5 backdrop-blur-md transition active:scale-95 dark:bg-white/10 dark:ring-white/10"
          onclick={() => home.emit("open", "clock")}
        >
          <div class="text-4xl font-medium leading-none tabular-nums text-neutral-900 dark:text-white">{fmtClock(now)}</div>
          <div class="mt-2 text-xs text-neutral-600/90 dark:text-neutral-300/90">{dateStr}</div>
        </button>
{#if today}
          <button
            class="flex flex-col items-center justify-center rounded-3xl bg-white/40 p-4 px-5 text-left shadow-sm ring-1 ring-black/5 backdrop-blur-md transition active:scale-95 dark:bg-white/10 dark:ring-white/10"
            aria-label={t("app.weather")}
            onclick={() => home.emit("open", "weather")}
          >
            <div class="text-2xl">{today.icon}</div>
            <div class="text-xl font-medium tabular-nums text-neutral-900 dark:text-white">{today.temp}°</div>
            <div class="text-[10px] text-neutral-500 dark:text-neutral-300">{t("weather.today")}</div>
          </button>
        {/if}
      </div>
    </div>

    <!-- paged icon grid: vertically centered in the space above the paging/search
         rows (dock is pinned at the bottom of the column). -->
    <div class="flex min-h-0 flex-1 flex-col justify-center">
      <div class="grid grid-cols-4 place-content-center place-items-center gap-y-6" data-testid="home-grid">
        {#each shownGrid as id (id)}
          {@render tile(id)}
        {/each}
      </div>
    </div>
    <div class="mt-1 flex items-center justify-center gap-1">
      {#if gridPages.length > 1}
        <div data-testid="home-dots" class="flex items-center justify-center gap-0.5">
          {#each gridPages as _, i (i)}
            <button
              type="button"
              data-testid="home-dot"
              aria-label={`page ${i + 1} of ${gridPages.length}`}
              aria-current={i === safePage ? "true" : undefined}
              onclick={() => (gridPage = Math.min(i, lastIndex))}
              class="grid h-5 min-w-5 cursor-pointer place-items-center transition active:scale-90"
            >
              <span
                aria-hidden="true"
                class={
                  "block rounded-full transition-all " +
                  (i === safePage
                    ? "h-1.5 w-3.5 bg-neutral-500/80 dark:bg-neutral-300/80"
                    : "h-1.5 w-1.5 bg-neutral-400/40 dark:bg-neutral-600/60")
                }
              ></span>
            </button>
          {/each}
        </div>
      {/if}
      <!-- iOS-style "App Library" (分组图标) stays on the SAME line as the paging
           dots — the trailing-page group indicator of the home pager. -->
      <button
        type="button"
        data-testid="app-library-entry"
        aria-label={t("appLibrary.title")}
        title={t("appLibrary.title")}
        onclick={() => home.emit("library")}
        class="grid h-6 w-6 cursor-pointer place-items-center rounded-[7px] bg-white/45 shadow-sm ring-1 ring-black/5 transition hover:scale-105 active:scale-90 dark:bg-white/10 dark:ring-white/10"
      >
        <span aria-hidden="true" class="grid w-4 grid-cols-4 gap-px">
          {#each Array(16) as _, i (i)}
            <span class="h-[3px] w-[3px] rounded-[0.5px] bg-neutral-600/70 dark:bg-neutral-300/70"></span>
          {/each}
        </span>
      </button>
    </div>
    <!-- Spotlight search pill (🔍 + label) alone on its own line (below the pager row);
         mb keeps a comfortable gap above the dock bar. -->
    <div class="mb-[30px] mt-1 flex items-center justify-center">
      <button
        type="button"
        data-testid="home-search-entry"
        aria-label={t("shell.search")}
        title={t("shell.search")}
        onclick={() => home.emit("search")}
        class="flex h-6 cursor-pointer items-center gap-1 rounded-full bg-white/45 px-2 text-[11px] font-medium text-neutral-700 shadow-sm ring-1 ring-black/5 transition hover:scale-105 active:scale-90 dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10"
      >
        <span aria-hidden="true" class="text-[10px] leading-none">🔍</span>
        <span>{t("shell.search")}</span>
      </button>
    </div>
  </div>

  <!-- bottom dock bar: single fixed row (no paging) -->
  <div
    class="dock-mag flex items-end justify-around rounded-3xl bg-white/30 px-3 py-3.5 shadow-inner ring-1 ring-black/5 backdrop-blur-md dark:bg-neutral-900/40 dark:ring-white/10"
  >
    {#each dockIds as id (id)}
      {@render tile(id, true)}
    {/each}
  </div>
</div>


{#snippet tile(id: string, inDock = false)}
  <button
    aria-label={labelOf(id)}
    title={labelOf(id)}
    onclick={() => handleTap(id)}
    class="group flex flex-col items-center gap-1 outline-none {inDock ? 'w-20' : 'w-16'}"
  >
    <span class="relative">
      <AppIcon
        id={id}
        icon={iconOf(id)}
        tileClassName={
          (inDock
            ? "h-[60px] w-[60px] rounded-[21px]"
            : "h-14 w-14 rounded-[19px]") +
          " group-hover:-translate-y-0.5 group-active:scale-90" +
          (pulseId === id ? " animate-pulse ring-2 ring-accent" : "")
        }
        glyphClassName={inDock ? "text-[2.7rem]" : "text-[2.5rem]"}
      />
      {#if unreadOf(id) > 0}
        <span
          class="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[11px] font-bold text-white ring-2 ring-white dark:ring-neutral-900"
        >{unreadOf(id) > 99 ? "99+" : unreadOf(id)}</span>
      {/if}
    </span>
    {#if !inDock}
      <span
        class="max-w-full truncate text-xs font-medium text-neutral-800 transition-colors group-hover:text-accent dark:text-neutral-200"
      >{labelOf(id)}</span>
    {/if}
  </button>
{/snippet}

