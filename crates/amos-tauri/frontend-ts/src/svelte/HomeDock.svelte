<script lang="ts">
  // HomeDock.svelte — Svelte 5 (runes) implementation of the home screen
  // (widgets + paged icon grid + single-row bottom dock bar).
  //
  // It is a CONTROLLED leaf: the shell owns navigation + the home layout,
  // and pushes { layout, ext, pulseId } down reactively through the shared
  // propsBus channel "home" (in-place, no remount → the icon-grid page index is
  // preserved across reorders). One-shot actions (open / move / search) go back
  // up over the same channel.
  //
  // Pure logic is REUSED, not rewritten: model helpers from lib/settings,
  // i18n from locale.svelte.ts, notifications/DND reactively via createStoreValue
  // (src/svelte/store.ts).
  import { t, ALL_LABEL_DICTS } from "./locale.svelte";
  import { homeDownToSpotlight } from "../lib/edgeSwipe";
  import { onMount, untrack } from "svelte";
  import { appIcon, appTitleKey } from "../lib/appMeta";
  import type { HomeLayout } from "../lib/amosStore";
  import { RECENTS_KEY, normalizeRecents } from "../lib/amosStore";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    normalizeNotifs,
    normalizeQuick,
    type Notif,
  } from "../lib/settings";
  import { appUnread } from "../lib/dockBadge";
  import { onDockBounce } from "../lib/dockConfig";
  import { createStoreValue } from "./store";
  import type { StoreTile } from "../lib/storeApps";
  import { propsChannel } from "./propsBus";
  import {
    dockRecentSlots,
    dockRecents,
    pageCapacity,
    PHONE_GRID,
    type HomeGrid,
    type HomeTile,
  } from "../lib/formLayout";
  import type { FormFactor } from "../lib/wm";
  import AppIcon from "./AppIcon.svelte";
  import HomeWidgets from "./HomeWidgets.svelte";
  import { HOME_WIDGETS_KEY, normalizeWidgets } from "../lib/homeWidgets";
  import { amosLog, amosWarn } from "../lib/debugLog";

  interface HomeProps {
    layout: HomeLayout;
    ext: StoreTile[];
    pulseId: string | null;
    /**
     * The soft launch's event counter, pushed with `pulseId` (`shellState.pulseSeq`).
     * Optional for the same reason `grid` is: a payload that predates the field means
     * "no launch has been announced", which is the conservative answer — nothing pages.
     */
    pulseSeq?: number;
    /**
     * Home-screen grid geometry, decided by the shell from the host's **class**
     * (`lib/formLayout`). Optional on purpose: a channel payload that predates the
     * field (or a preview build with no host) degrades to the phone grid — the same
     * "never gain a capability from a missing payload" rule `lib/wm.ts` follows.
     */
    grid?: HomeGrid;
    /**
     * How big one tile is on this class (`lib/formLayout::homeTile`). Optional for the
     * same reason `grid` is: a payload without it keeps today's `regular` tiles.
     */
    tile?: HomeTile;
    /**
     * The device class, pushed by the shell from the host's authority. Optional: a
     * payload that predates the field (or a preview build with no host) is treated as
     * the phone, which is the **conservative** answer for every class-aware decision
     * here (`dockRecentSlots` ⇒ 0, i.e. today's Dock without a recents section).
     */
    form?: FormFactor;
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
  /** How many soft launches the shell has announced; the pulse's *event* identity
   * (see the reveal effect below — a repeated id is not a new launch). */
  const pulseSeq = $derived(incoming?.pulseSeq ?? 0);
  /** Icon-grid geometry for this device class (phone 4×3 unless the shell says otherwise). */
  const grid = $derived(incoming?.grid ?? PHONE_GRID);
  /** Tile size for this class; `regular` keeps the historical 56 px / dock 60 px icons. */
  const tileSize = $derived(incoming?.tile ?? "regular");
  const large = $derived(tileSize === "large");
  /** The host's class as the shell pushed it; absent ⇒ phone (the conservative plan). */
  const form = $derived(incoming?.form ?? "phone");

  // ---- Dock "recently used" section (iPadOS; see lib/formLayout::dockRecentSlots) ----
  // Same reactive store the Recents sheet reads, so the Dock and the switcher cannot
  // disagree about what "recent" means.
  const recentsStore = createStoreValue<unknown>(RECENTS_KEY, []);
  let rawRecents = $state<unknown>([]);
  $effect(() => {
    const un = recentsStore.subscribe((v) => (rawRecents = v));
    return un;
  });
  // The rule is named once in `lib/amosStore` — the same narrowing `getRecents()` applies, so
  // the Dock, the sheet, the App Library and the app-open path cannot drift apart.
  const recentIds = $derived(normalizeRecents(rawRecents));

  // ---- Reactive notifications + Do-Not-Disturb (live, cross-window) ----
  const notifStore = createStoreValue<unknown>(NOTIF_KEY, []);
  const quickStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  let notifs = $state<Notif[]>([]);
  let quick = $state<unknown>({});
  $effect(() => {
    const un = notifStore.subscribe((v) => (notifs = normalizeNotifs(v)));
    return un;
  });
  $effect(() => {
    const un = quickStore.subscribe((v) => (quick = v));
    return un;
  });
  const quiet = $derived(dndActive(normalizeQuick(quick)));

  // ---- Home widget stack (which tiles sit above the icon grid) ----
  // Read straight from the shared store, the way the notification/DND values above are: the
  // Edit-Home screen writes the same key, and the broadcast reloads this list in place.
  // `null` (no key at all) decodes to the default clock+weather stack — see
  // `lib/homeWidgets`, which owns that rule.
  const widgetStore = createStoreValue<unknown>(HOME_WIDGETS_KEY, null);
  let rawWidgets = $state<unknown>(null);
  $effect(() => {
    const un = widgetStore.subscribe((v) => (rawWidgets = v));
    return un;
  });
  const widgetKinds = $derived(normalizeWidgets(rawWidgets));

  // iOS-aligned: the icon *grid* has NO always-on drag-to-reorder (reordering there
  // happens in the Edit-Home surface); a mouse drag pages the grid left/right like
  // a touch swipe. The bottom **dock bar** is the exception: dragging one dock icon
  // onto another emits `move` so the shell can reorder the dock. State below is
  // shared by the mouse + touch paging handlers.
  let mousePanX: number | null = null;
  let mousePanned = false;

  // iOS's way *into* the Edit (jiggle) surface: press and hold any home-screen icon.
  // Until this, the only door was the Notification-Center pencil button (`nc` channel),
  // so the platform-standard arrange gesture did nothing on the home screen. The press
  // emits the same `"edit"` action that pencil does — the shell owns what it means.
  //
  // Cancelled by any movement (a paging swipe, a Dock drag) or by lifting early, so a
  // normal tap still opens the app. A press that *does* fire sets the same one-shot
  // flag `pageBy` uses, because the browser still synthesizes a `click` after the
  // touchend/mouseup — without it the app would open *and* the edit surface appear.
  // Long press is not reachable from a keyboard or screen reader; the pencil button
  // stays the accessible path (its `aria-label` is `a11y.editHome`).
  const LONG_PRESS_MS = 500;
  let pressTimer: number | null = null;
  function startPress(): void {
    cancelPress();
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      dragId = "__long_press__";
      window.setTimeout(() => {
        if (dragId === "__long_press__") dragId = null;
      }, 300);
      home.emit("edit");
    }, LONG_PRESS_MS);
  }
  function cancelPress(): void {
    if (pressTimer !== null) {
      window.clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  // ---- label / badge / icon resolution (pure lib reuse) ----
  const extById = $derived(new Map(ext.map((e) => [e.id, e])));
  const extName = (id: string): string | undefined => extById.get(id)?.name;
  const known = (id: string): boolean => appTitleKey(id) !== null || extById.has(id);
  const labelOf = (id: string): string => {
    const key = appTitleKey(id);
    return key ? t(key) : (extName(id) ?? id);
  };
  const iconOf = (id: string): string => extById.get(id)?.icon ?? appIcon(id);
  // The DND→0 rule and the per-app count are shared with the **desktop** Dock
  // (`lib/dockBadge.ts::appUnread`) so the two shells cannot show different numbers for
  // the same notification. Counted by **id** over every locale's dictionary
  // (`lib/notifApp.ts`), not by a resolved name: a row's `app` is the display string from
  // the locale active when it was pushed, so an English-written row would otherwise never
  // match. An external store app has no dictionary name, so it resolves to no app ⇒ 0.
  const unreadOf = (id: string): number => appUnread(notifs, id, ALL_LABEL_DICTS, quiet);

  // ─── Dock bounce（P2；REQ-A1128）─────────────────────────────────────────────
  // iOS 的「有新消息／来电时图标跳一下」。通道由 `lib/dockConfig` 提供，**两个**发射点
  // 都在触屏壳这边：`PhoneApp.svelte` 发 `"phone"`、`MessagesApp.svelte` 发 `"messages"`。
  // 此前唯一的订阅者在**桌面** `Dock.svelte`，而桌面 Dock 的瓦片集是
  // `withoutPhone(layout.dock)` —— `"phone"` 在那个壳里**永远不可能是**一块瓦片；触屏壳
  // 自己一个订阅者都没有。于是「来电时 Dock 跳一下」在它唯一说得通的那个壳里是画在纸上的：
  // 事件照发（发射端的测试因此一直是绿的），没有任何表面画它。
  //
  // 语义与 `Dock.svelte` 完全一致（通配订阅 + 600 ms 后清掉，且只在仍停在这条 app 上时清，
  // 否则一次新 bounce 会被前一次的定时器抹掉）；跳的是**瓦片自身**，所以只在 `tile` 片段
  // 里加一个 class —— 图标网格、固定 Dock、iPad 的「最近使用」三段共用同一块片段，命中哪
  // 一段都自动生效；不在这块表面上的 app（例如桌面专属的 id）自然什么都不画。
  let bouncingAppId = $state<string | null>(null);
  $effect(() => {
    return onDockBounce("*", (eventAppId) => {
      bouncingAppId = eventAppId;
      setTimeout(() => {
        if (bouncingAppId === eventAppId) bouncingAppId = null;
      }, 600);
    });
  });


  // ---- Main icon grid: horizontal multi-page (widgets fixed; dock single row) ----
  const pageIds = $derived(layout.page.filter(known));
  const dockIds = $derived(layout.dock.filter(known));
  /** Recently-used apps for the Dock section: tablet only (`dockRecentSlots`), never
   * duplicating a pinned icon, most-recent-first, capped. Empty on a phone ⇒ the Dock
   * renders exactly what it did before. */
  const dockRecent = $derived(dockRecents(recentIds, dockIds, dockRecentSlots(form)));

  function buildPages(ids: string[], per: number): string[][] {
    const pages: string[][] = [];
    for (let i = 0; i < ids.length; i += per) pages.push(ids.slice(i, i + per));
    return pages;
  }
  // `per` is the **class's** page capacity (phone 12 = 4×3 unchanged; tablet 24),
  // so a tablet pages its home screen at iPadOS's density instead of the phone's.
  const gridPages = $derived(buildPages(pageIds, pageCapacity(grid)));
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
  // Reveal the tile a Spotlight soft launch pulses. "Pulse the icon on home, stay home"
  // is only an answer if the icon is on the page being drawn, and this grid is **paged**
  // while Spotlight searches the whole registry — the default layout alone puts 33 apps
  // behind a 12-per-page phone grid (24 on a tablet), so a result on page 2 landed the
  // user on page 1 with the pulse off-screen: the sheet closed and visibly nothing
  // happened. The launch is an **event**, so this keys on `pulseSeq` (a repeated id is
  // still a new launch) and reads the id + grid untracked: a layout push, or the user's
  // own swipe, must never yank them back to a pulse they have already been shown.
  $effect(() => {
    if (pulseSeq === 0) return;
    const id = untrack(() => pulseId);
    if (!id) return;
    // -1 = not on any page (a dock icon is always on screen; a hidden app is drawn
    // nowhere, so there is no page to turn to).
    const at = untrack(() => gridPages.findIndex((page) => page.includes(id)));
    if (at >= 0) gridPage = at;
  });

  // Transient gesture state (non-reactive mirrors of the local refs).
  let dragId: string | null = null;
  let panX: number | null = null;
  let panned = false;

  // ---- Icon grid paging (shared page-turn logic) ----
  function handleTap(id: string): void {
    cancelPress(); // the press already ended; a tap must never also become a long press
    if (dragId) {
      dragId = null; // a click right after a page-swipe shouldn't open the app
      return;
    }
    home.emit("open", id);
  }
  // Dock drag-to-reorder on the home: dragging a dock icon onto another asks the
  // shell to move it there (the shell owns the layout). Only the dock bar's
  // **pinned members** are draggable — the icon grid keeps iOS-style page-turn drag,
  // and a plain click (no drag) still opens the app via handleTap.
  //
  // "Drawn in the dock bar" and "is a member of the dock's order" are two different
  // questions, and the iPad Dock's Recents section (below) is the case where they come
  // apart: it is rendered **in** the bar but is not in `layout.dock` at all. Attaching
  // the drag/reorder handlers to those tiles too made a drop **inside** the Dock evict an
  // app from it: `dockDrop` → the shell's `moveBefore(layout, drag, over)`, whose target
  // it cannot find in either list, falls through to `page.push(drag)` — so dropping a
  // pinned icon onto a recents icon silently moved it out of the Dock and onto the home
  // page. A Recents tile dragged onto a pinned one was the mirror-image lie: a tile that
  // looks orderable, drags, and does nothing (`moveBefore` returns its input unchanged
  // when the dragged id is in neither list). The `tile` snippet therefore takes the two
  // facts separately — `inDock` (visual) and `orderable` (interactive) — and only the
  // latter arms the handlers.
  let dockDrag: string | null = null;
  function dockDragStart(e: DragEvent, id: string): void {
    cancelPress(); // a Dock drag is a move, not a long press
    dockDrag = id;
    try {
      e.dataTransfer?.setData("text/plain", id);
    } catch {
      /* dataTransfer may be absent in headless tests — drag source is tracked anyway */
    }
  }
  function dockDragEnd(): void {
    dockDrag = null;
  }
  function dockAllowDrop(e: DragEvent): void {
    e.preventDefault();
  }
  function dockDrop(e: DragEvent, over: string): void {
    e.preventDefault();
    const drag = dockDrag;
    dockDrag = null;
    if (drag && drag !== over) home.emit("move", { drag, over });
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
</script>


<div
  class="flex h-full flex-col px-4 pb-3"
  role="group"
  aria-label={t("a11y.homeScreen")}
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
    aria-label={t("a11y.homePages")}
    style="touch-action: pan-y"
    ontouchstart={onGridStart}
    ontouchmove={onGridMove}
    ontouchend={onGridEnd}
    ontouchcancel={onGridEnd}
  >
    <!-- widget stack: the user's own list (`lib/homeWidgets`), rendered by HomeWidgets.
         The default `["clock", "weather"]` is the same one-row header this screen used to
         hard-code; `[]` (the user removed them) renders nothing at all. -->
    <div class="shrink-0 px-1 pt-[48px]">
      <HomeWidgets kinds={widgetKinds} onopen={(id) => home.emit("open", id)} />
    </div>

    <!-- paged icon grid: vertically centered in the space above the paging/search
         rows (dock is pinned at the bottom of the column). -->
    <div class="flex min-h-0 flex-1 flex-col justify-center">
      <!-- Grid geometry is the device class's (`lib/formLayout`): the phone keeps the
           historical 4×3, a tablet gets iPadOS's 4×6 portrait / 6×4 landscape. The
           column count is an **inline style**, not a `grid-cols-N` class, because
           Tailwind purges class names it cannot see statically; `grid-cols-4` stays
           as the static fallback so the layout is sane even without the style. -->
      <div
        class="grid grid-cols-4 place-content-center place-items-center gap-y-6"
        style="grid-template-columns: repeat({grid.cols}, minmax(0, 1fr))"
        data-testid="home-grid"
        data-cols={grid.cols}
        data-rows={grid.rows}
      >
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
              aria-label={t("a11y.pageOf", { n: i + 1, total: gridPages.length })}
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
        class="flex h-6 cursor-pointer items-center gap-1 rounded-full bg-white/70 px-2 text-[11px] font-medium text-neutral-800 shadow-sm ring-1 ring-black/10 transition hover:scale-105 active:scale-90 dark:bg-white/15 dark:text-neutral-100 dark:ring-white/15"
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
      {@render tile(id, true, true)}
    {/each}
    <!-- iPadOS Dock: up to three recently-used apps after a divider, so an app you
         just left is one tap away. Tablet only — `dockRecent` is empty elsewhere, so
         this branch and its divider never appear on a phone (byte-identical Dock). -->
    {#if dockRecent.length > 0}
      <span
        data-testid="dock-recents-divider"
        aria-hidden="true"
        class="mx-1 h-10 w-px self-center bg-black/10 dark:bg-white/15"
      ></span>
      <div data-testid="dock-recents" class="flex items-end gap-2">
        {#each dockRecent as id (id)}
          <!-- Drawn in the bar (`inDock`) but not a member of its order: no drag
               handlers, so neither a drop target nor an inert drag source (see the
               dockDrag comment in the script). -->
          {@render tile(id, true)}
        {/each}
      </div>
    {/if}
  </div>
</div>


{#snippet tile(id: string, inDock = false, orderable = false)}
  <button
    aria-label={labelOf(id)}
    title={labelOf(id)}
    onclick={() => handleTap(id)}
    ontouchstart={startPress}
    ontouchend={cancelPress}
    ontouchmove={cancelPress}
    ontouchcancel={cancelPress}
    onmousedown={startPress}
    onmouseup={cancelPress}
    onmouseleave={cancelPress}
    draggable={orderable || undefined}
    ondragstart={orderable ? (e) => dockDragStart(e, id) : undefined}
    ondragend={orderable ? dockDragEnd : undefined}
    ondragover={orderable ? dockAllowDrop : undefined}
    ondrop={orderable ? (e) => dockDrop(e, id) : undefined}
    class="group flex flex-col items-center gap-1 outline-none {inDock ? 'w-20' : 'w-16'}{bouncingAppId === id
      ? ' dock-bounce'
      : ''}"
    data-tile={tileSize}
  >
    <span class="relative">
      <!-- Sizes are **literal** class strings (one per class × dock/grid): Tailwind
           purges class names it cannot see statically, and a desktop Launcher wants
           Launchpad-class tiles rather than 56 px phone icons in a 183 px cell. -->
      <AppIcon
        id={id}
        icon={iconOf(id)}
        tileClassName={(inDock
          ? large
            ? "h-[76px] w-[76px] rounded-[26px]"
            : "h-[60px] w-[60px] rounded-[21px]"
          : large
            ? "h-20 w-20 rounded-[24px]"
            : "h-14 w-14 rounded-[19px]") +
          " group-hover:-translate-y-0.5 group-active:scale-90" +
          (pulseId === id ? " animate-pulse ring-2 ring-accent" : "")}
        glyphClassName={large ? "text-[3.2rem]" : inDock ? "text-[2.7rem]" : "text-[2.5rem]"}
      />
      {#if unreadOf(id) > 0}
        <span
          class="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-danger-solid px-1 text-[11px] font-bold text-white ring-2 ring-white dark:ring-neutral-900"
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

