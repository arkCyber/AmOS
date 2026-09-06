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

  // Fine-pointer (mouse) → allow drag-to-reorder; coarse/touch disables native
  // drag so a horizontal swipe pages the grid instead. Fall back to draggable
  // when matchMedia is absent (SSR / happy-dom).
  const reorderable = (() => {
    try {
      return (
        typeof window === "undefined" ||
        !window.matchMedia ||
        window.matchMedia("(pointer: fine)").matches
      );
    } catch {
      return true;
    }
  })();

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

  function handleDragStart(id: string): void {
    dragId = id;
  }
  function handleDrop(id: string): void {
    const src = dragId;
    dragId = null;
    if (src && src !== id) home.emit("move", { drag: src, over: id });
  }
  function handleTap(id: string): void {
    if (dragId) {
      dragId = null; // a tap right after a drag shouldn't open the app
      return;
    }
    home.emit("open", id);
  }
  function onGridStart(e: TouchEvent): void {
    const x = e.touches[0]?.clientX;
    panX = x == null ? null : x;
    panned = false;
  }
  function onGridMove(e: TouchEvent): void {
    const x0 = panX;
    if (x0 == null || panned || gridPages.length <= 1) return;
    const x = e.touches[0]?.clientX;
    if (x == null) return;
    const dx = x - x0;
    if (Math.abs(dx) < 48) return;
    panned = true;
    panX = null;
    dragId = "__grid_pan__";
    window.setTimeout(() => {
      if (dragId === "__grid_pan__") dragId = null;
    }, 300);
    if (dx < 0) gridPage = Math.min(gridPage + 1, gridPages.length - 1);
    else gridPage = Math.max(gridPage - 1, 0);
  }
  function onGridEnd(): void {
    panX = null;
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


<div class="flex h-full flex-col px-4 pb-3">
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
          <div class="text-4xl font-thin leading-none tabular-nums">{fmtClock(now)}</div>
          <div class="mt-2 text-xs opacity-70">{dateStr}</div>
        </button>
{#if today}
          <button
            class="flex flex-col items-center justify-center rounded-3xl bg-white/40 p-4 px-5 text-left shadow-sm ring-1 ring-black/5 backdrop-blur-md transition active:scale-95 dark:bg-white/10 dark:ring-white/10"
            aria-label={t("app.weather")}
            onclick={() => home.emit("open", "weather")}
          >
            <div class="text-2xl">{today.icon}</div>
            <div class="text-xl font-thin tabular-nums">{today.temp}°</div>
            <div class="text-[10px] opacity-70">{t("weather.today")}</div>
          </button>
        {/if}
      </div>
    </div>

    <!-- paged icon grid -->
    <div class="flex min-h-0 flex-1 flex-col justify-center">
      <div class="grid grid-cols-4 place-content-center gap-y-5" data-testid="home-grid">
        {#each shownGrid as id (id)}
          {@render tile(id)}
        {/each}
      </div>
    </div>
    {#if gridPages.length > 1}
      <div data-testid="home-dots" class="mt-1 flex items-center justify-center gap-0.5">
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
  </div>

  <!-- search pill (the React shell always supplies onSearch on the home screen) -->
  <button
    type="button"
    aria-label="search"
    onclick={() => home.emit("search")}
    class="mx-auto mb-1.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-white/45 text-sm shadow-sm ring-1 ring-black/5 transition active:scale-90 dark:bg-white/10 dark:ring-white/10"
  >🔍</button>

  <!-- bottom dock bar: single fixed row (no paging) -->
  <div
    class="dock-mag flex items-end justify-around rounded-3xl bg-white/30 px-2 py-3 shadow-inner ring-1 ring-black/5 backdrop-blur-md dark:bg-neutral-900/40 dark:ring-white/10"
  >
    {#each dockIds as id (id)}
      {@render tile(id)}
    {/each}
  </div>
</div>


{#snippet tile(id: string)}
  <button
    aria-label={labelOf(id)}
    title={labelOf(id)}
    draggable={reorderable}
    onclick={() => handleTap(id)}
    ondragstart={(e) => {
      handleDragStart(id);
      e.dataTransfer?.setData("text/plain", id);
    }}
    ondragover={(e) => e.preventDefault()}
    ondrop={(e) => {
      e.preventDefault();
      handleDrop(id);
    }}
    class="group flex w-16 flex-col items-center gap-1 outline-none"
  >
    <span class="relative">
      <AppIcon
        id={id}
        icon={iconOf(id)}
        tileClassName={
          "h-14 w-14 rounded-[19px] group-hover:-translate-y-0.5 group-active:scale-90" +
          (pulseId === id ? " animate-pulse ring-2 ring-accent" : "")
        }
        glyphClassName="text-[2.5rem]"
      />
      {#if unreadOf(id) > 0}
        <span
          class="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[11px] font-bold text-white ring-2 ring-white dark:ring-neutral-900"
        >{unreadOf(id) > 99 ? "99+" : unreadOf(id)}</span>
      {/if}
    </span>
    <span
      class="max-w-full truncate text-xs font-medium text-neutral-800 transition-colors group-hover:text-accent dark:text-neutral-200"
    >{labelOf(id)}</span>
  </button>
{/snippet}

