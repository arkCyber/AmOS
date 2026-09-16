<script lang="ts">
  // PhotosApp.svelte — Svelte 5 (runes) implementation of the photo library.
  // Still-photo logic reuses pure lib/photos.ts; camera video tiles use
  // lib/cameraCapture (no React VideoThumb thumbnail here → 🎬 tile with
  // duration/res; playback overlay still streams the MediaStore blob).
  // (WIP Photos port: compilable, NOT yet wired into COMPONENTS.)
  import {
    PHOTOS_KEY,
    favsOf,
    groupDays,
    isRealPhoto,
    neighborOf,
    newPhoto,
    normalizePhotos,
    removePhoto,
    removePhotos,
    seedPhotos,
    setFavs,
    shareCaption,
    toggleFav,
  } from "../lib/photos";
  import type { Photo } from "../lib/photos";
  import { captureBlob, listCaptures, removeVideoCapture, resLabelOf, toggleCaptureFav } from "../lib/cameraCapture";
  import type { VideoCapture } from "../lib/cameraCapture";
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { iconSvg } from "../lib/sysIcons";
  import { fmtTime } from "../lib/notes";
  import {
    cursorOf,
    hasMediaBridge,
    mediaList,
    mediaGrantRead,
    mediaStreamBase,
  } from "../lib/media";
  import type { MediaCursor, MediaListing } from "../lib/media";
  import {
    canLoadMore,
    emptyPaging,
    fetchInto,
    remainingTotal,
    type PagingState,
  } from "../lib/mediaPaging";
  import {
    nativePhotoFromItem,
    nativeStreamUrl,
    nativeTileKind,
  } from "../lib/photoLibrary";
  import type { NativePhoto } from "../lib/photoLibrary";
  import { t } from "./locale.svelte";
  import { currentFormFactor } from "../lib/desktopApps";
  import { photosCols } from "../lib/formLayout";

  // Demo seed — **only when the key is absent**: an emptied library stays empty.
  const seed = ((): Photo[] => {
    const raw = readStoreValue<unknown>(PHOTOS_KEY, undefined);
    if (raw !== undefined) return normalizePhotos(raw);
    const s = seedPhotos(8, Date.now());
    writeStoreValue(PHOTOS_KEY, s);
    return s;
  })();

  let list = $state<Photo[]>(seed);
  let sel = $state<Photo | null>(null);
  let wallMsg = $state("");
  let slide = $state(false);
  let favOnly = $state(false);
  let vidsOnly = $state(false);
  let vids = $state<VideoCapture[]>(listCaptures());
  // The store refused a write (full/unavailable): say so and keep showing the truth.
  let storeErr = $state("");
  let playId = $state<string | null>(null);
  let playUrl = $state("");
  let selecting = $state(false);
  let selected = $state<ReadonlySet<string>>(new Set());
  // Native (real external-storage) stills from the media_* bridge, shown as a
  // read-only strip above the local grid (only when a bridge is present). The
  // list itself is **derived** from `nativePage.items` — the merge / dedup /
  // ordering lives in `lib/mediaPaging`, so the screen never has to write the
  // paged-list math itself.
  const nativeShown = $derived(
    !favOnly && !vidsOnly && !selecting && native.length > 0,
  );

  // The gallery grid scales with the device class (REQ-A292): iOS keeps 3 columns
  // on the phone; iPadOS Photos uses 5 columns in My Photos; the desktop class
  // widens further to `DESKTOP_MAX_COLS` so a Mac window does not look like an
  // iPad stretched out. We do NOT poll: the shell owns `form` and updates this
  // store on every `layout-changed` push (the host emits only on a real change).
  // `null` from `currentFormFactor()` is the "no host yet" state — we keep the
  // most conservative answer (the phone's 3) so a preview build stays usable.
  const form = $derived(currentFormFactor());
  const cols = $derived(photosCols(form ?? "phone"));

  // The two standard collections the gallery reads stills from.
  const NATIVE_COLLECTIONS = ["camera", "screenshots"] as const;
  // Load real stills from the bridge. Offline (no bridge) → the strip stays hidden.
  // A **real** backend error (the Rust `Unauthorized` that `media_list` surfaces as
  // a rejection) is NOT "no photos": it becomes an honest grant prompt. The pre-fix
  // code swallowed it in `allSettled`, so a permission denial looked exactly like
  // an empty gallery. Native tiles are read-only.
  let nativeLoaded = false;
  let nativeBlocked = $state(false);
  let nativeBusy = $state(false);
  // The host's streaming base for native bytes (`media_stream_base_url`,
  // REQ-A303). `null` = no host / an unusable answer → tiles keep their kind
  // glyph (the honest fallback); the actual photo is *not* shown and we never
  // pretend a broken image is the photo. Resolved **once** per `loadNative`
  // because the engine's base form is a build-time fact, not a per-tile fact.
  let nativeBase = $state<string | null>(null);
  // Native items whose bytes this engine could not decode (e.g. HEIC): fall
  // back to the glyph and stay there, instead of leaving a permanently
  // broken tile.
  let nativeFailed = $state<ReadonlySet<string>>(new Set());

  // The host caps each listing (REQ-A314) and the strip pulls one page per call,
  // so the merge / dedup / cursor logic lives in `lib/mediaPaging` and the screen
  // just consumes the resulting state. `cursors` is per-collection (a merged
  // view's order is ours, not the host's — only the host's own last item sets the
  // next cursor).
  let nativePage = $state<PagingState>(emptyPaging(NATIVE_COLLECTIONS));
  const native = $derived(nativePage.items.map(nativePhotoFromItem));
  // The host's "M of M total" answer, summed across collections, drives the
  // "showing the newest part of the library" notice (REQ-A314). When the
  // `remainingTotal` is zero the listing really is everything, and the notice
  // disappears.
  const nativeRemaining = $derived(remainingTotal(nativePage, NATIVE_COLLECTIONS));
  const nativeHasMore = $derived(canLoadMore(nativePage, NATIVE_COLLECTIONS));
  // "M of N" — how many we hold vs. how many the host says exist. The truncated
  // notice (`native-truncated`) reads `native.length` for the M and
  // `native.length + nativeRemaining` for the N: the pager subtracts the
  // current page once, so the screen only has to add and never worry about
  // double-counting.
  const nativeTruncated = $derived(nativeRemaining > 0);

  const loadNative = async () => {
    if (!hasMediaBridge()) return;
    nativeBusy = true;
    // Resolve the streaming base **once** per load — its form is a build-time
    // fact, and the same answer covers every page.
    nativeBase = await mediaStreamBase();
    nativeFailed = new Set();
    // One round of paging (the first call = the first page; later calls resume
    // from the cursors the host handed back). `failed` is a denial / refused /
    // host error — never rendered as "you have no photos".
    const { state, failed } = await fetchInto(
      nativePage,
      NATIVE_COLLECTIONS,
      (dir, after) => mediaList(dir, after),
    );
    nativePage = state;
    nativeBlocked = failed.length > 0;
    nativeBusy = false;
  };

  /** Pull the next page from every collection that still owes one. */
  const loadMoreNative = async () => {
    if (!hasMediaBridge() || nativeBusy) return;
    nativeBusy = true;
    const { state, failed } = await fetchInto(
      nativePage,
      NATIVE_COLLECTIONS,
      (dir, after) => mediaList(dir, after),
    );
    nativePage = state;
    // Loading more after a denial: the strip keeps the prompt up so the user
    // can grant and retry — we don't replace the denial with "no more photos".
    nativeBlocked = nativeBlocked || failed.length > 0;
    nativeBusy = false;
  };

  /** Grant read access to the collections we list, then reload. */
  const grantNative = async () => {
    if (!hasMediaBridge() || nativeBusy) return;
    nativeBusy = true;
    await Promise.allSettled(NATIVE_COLLECTIONS.map((c) => mediaGrantRead(c)));
    await loadNative(); // the prompt clears only if the grant actually took
  };

  $effect(() => {
    if (nativeLoaded) return;
    nativeLoaded = true;
    if (!hasMediaBridge()) return;
    void loadNative();
  });

  const persist = (l: Photo[]): boolean => {
    if (!writeStoreValueChecked(PHOTOS_KEY, l)) {
      storeErr = t("common.storeWriteFailed");
      return false;
    }
    storeErr = "";
    list = l;
    return true;
  };
  /** Favourite a video — only a landed write may move the heart (and `vids`). */
  const favVideo = (id: string) => {
    const r = toggleCaptureFav(id);
    if (!r.ok) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    vids = r.list;
  };
  const shown = $derived(favOnly ? favsOf(list) : list);
  const add = () => persist([newPhoto(`p${Date.now()}`, Date.now()), ...list]);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  };
  const toggleSelectMode = () => {
    if (vidsOnly) return; // video tiles aren't multi-selectable (their own fav)
    selected = new Set();
    selecting = !selecting;
  };
  // iOS-like Library filter: All / Favourites / Videos (smart "albums").
  const setFilter = (v: "all" | "fav" | "videos") => {
    favOnly = v === "fav";
    vidsOnly = v === "videos";
    if (selecting) {
      selected = new Set();
      selecting = false;
    }
  };
  const viewIs = (v: "all" | "fav" | "videos"): boolean =>
    v === "fav" ? favOnly : v === "videos" ? vidsOnly : !favOnly && !vidsOnly;
  const deleteSelected = () => {
    if (selected.size === 0) return;
    persist(removePhotos(list, selected));
    selected = new Set();
    selecting = false;
  };
  // iOS multi-select "Favourite": mark every selected photo favourited, exit.
  const batchFav = (on: boolean) => {
    if (selected.size === 0) return;
    persist(setFavs(list, selected, on));
    selected = new Set();
    selecting = false;
  };
  // Select All / Deselect All over the currently-shown photos (respects the
  // active ♥ filter), mirroring iOS's in-selection "Select All".
  const allShownSelected = $derived(
    selecting && shown.length > 0 && selected.size === shown.length,
  );
  const toggleSelectAll = () => {
    if (!selecting || shown.length === 0) return;
    selected = allShownSelected ? new Set() : new Set(shown.map((p) => p.id));
  };

  // Interleave stills + camera videos newest-first.
  const gallery = $derived(
    (() => {
      const out: ({ kind: "photo"; p: Photo } | { kind: "video"; v: VideoCapture })[] = [];
      // "Videos" shows only camera videos; every other view shows (filtered) stills.
      if (!vidsOnly) {
        for (const p of shown) out.push({ kind: "photo", p });
      }
      // Favourites keeps stills only; All and Videos mix in the camera library.
      const showVideos = vids.length > 0 && !selecting && !favOnly;
      if (showVideos) for (const v of vids) out.push({ kind: "video", v });
      out.sort(
        (a, b) =>
          (b.kind === "photo" ? b.p.ts : b.v.ts) - (a.kind === "photo" ? a.p.ts : a.v.ts),
      );
      return out;
    })(),
  );

  // iOS "Days" grouping: the grid is split into local-day sections with relative
  // headers (今天/昨天/日期). Pure via lib/photos groupDays; `t` keeps the labels
  // reactive to a mid-session locale switch.
  const dateLabel = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  };
  const sections = $derived.by(() => {
    const now = Date.now();
    return groupDays(
      gallery.map((it) => ({ ts: it.kind === "photo" ? it.p.ts : it.v.ts, it })),
      now,
      {
        today: t("photo.today"),
        yesterday: t("photo.yesterday"),
        date: dateLabel,
      },
    ).map((s) => ({ key: s.key, label: s.label, items: s.items.map((x) => x.it) }));
  });

  const grad = (p: Photo): string | undefined =>
    p.a && p.b ? `linear-gradient(135deg, ${p.a}, ${p.b})` : undefined;
  const fmtLen = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  // Arrow-key navigation inside the viewer.
  $effect(() => {
    if (!sel) return;
    const cur = sel;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        const p = neighborOf(shown, cur.id, -1);
        if (p) sel = p;
      } else if (e.key === "ArrowRight") {
        const n = neighborOf(shown, cur.id, 1);
        if (n) sel = n;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Slideshow while active.
  $effect(() => {
    if (!slide || !sel) return;
    const id = setInterval(() => {
      sel = neighborOf(shown, sel?.id ?? "", 1) ?? sel;
    }, 2500);
    return () => clearInterval(id);
  });

  const toggleSlide = () => (slide = !slide);
  const closeSel = () => {
    slide = false;
    sel = null;
  };
  const toggleFavSel = () => {
    if (!sel) return;
    const id = sel.id;
    const toggled = toggleFav(list, id);
    persist(toggled);
    sel = toggled.find((x) => x.id === id) ?? sel;
  };
  const shareSel = async () => {
    if (!sel) return;
    const txt = shareCaption(sel, fmtTime(sel.ts));
    try {
      await navigator.clipboard?.writeText(txt);
    } catch {
      /* clipboard unavailable */
    }
    wallMsg = t("photo.shared");
  };
  const setWallpaper = () => {
    if (!sel) return;
    const cur = readStoreValue<Record<string, unknown>>("amos.settings", {});
    writeStoreValue("amos.settings", { ...cur, wallpaper: sel.data ?? "" });
    wallMsg = t("photo.setWallpaperDone");
  };
  const deleteSel = () => {
    if (!sel) return;
    if (!persist(removePhoto(list, sel.id))) return;
    sel = null;
  };

  const openVideo = async (id: string) => {
    playId = id;
    const blob = await captureBlob(id);
    if (blob) {
      try {
        if (typeof URL !== "undefined" && URL.createObjectURL) playUrl = URL.createObjectURL(blob);
      } catch {
        /* object URLs unavailable */
      }
    }
  };
  const closeVideo = () => {
    if (playUrl) URL.revokeObjectURL(playUrl);
    playUrl = "";
    playId = null;
  };
  const deleteVideo = async (id: string) => {
    // Only claim the delete when the library index really dropped the row.
    if (!(await removeVideoCapture(id))) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    vids = listCaptures();
    closeVideo();
  };
  const shareVideo = (id: string) => {
    const cap = vids.find((x) => x.id === id);
    if (!cap) return;
    try {
      navigator.clipboard?.writeText(`🎬 ${fmtLen(cap.durationMs)} · ${new Date(cap.ts).toLocaleString()}`);
    } catch {
      /* clipboard unavailable */
    }
    wallMsg = t("photo.shared");
  };

  const chip = (on: boolean, size: "xs" | "md" | "lg" = "xs") =>
    `rounded-full ${size === "lg" ? "px-4 py-1.5 text-sm" : size === "md" ? "px-3 py-1 text-sm" : "px-3 py-1 text-xs"} ${on ? "bg-accent text-white" : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"}`;
  const btn = (kind: "accent" | "neutral" | "danger", size: "xs" | "md" | "lg" = "md") =>
    `${size === "lg" ? "px-4 py-1.5 text-sm" : "px-3 py-1 text-sm"} rounded-full transition active:scale-95 ${
      kind === "accent"
        ? "bg-accent text-white"
        : kind === "danger"
          ? "bg-danger text-white"
          : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
    }`;
</script>

<StoreErrorBar message={storeErr} />
{#if sel}
  {@const prevP = neighborOf(shown, sel?.id ?? "", -1)}
  {@const nextP = neighborOf(shown, sel?.id ?? "", 1)}
  {@const idx = shown.findIndex((p) => p.id === sel?.id) + 1}
  <div class="flex h-full flex-col items-center justify-center gap-3 p-4">
    <div class="grid h-40 w-40 place-items-center overflow-hidden rounded-3xl text-7xl" style:background={grad(sel) ?? "#14161d"}>
      {#if sel.data}
        <img src={sel.data} alt="" class="h-full w-full object-cover" />
      {:else}
        {sel.emoji ?? ""}
      {/if}
    </div>
    <p class="text-xs opacity-60">{fmtTime(sel.ts)}</p>
    <div class="flex items-center gap-4">
      <button onclick={() => { if (prevP) sel = prevP; }} disabled={!prevP} aria-label={t("photo.prev")}
        class="h-9 w-9 rounded-full bg-neutral-300 text-lg dark:bg-neutral-700 disabled:opacity-30">‹</button>
      <span class="min-w-[3rem] text-center text-xs tabular-nums opacity-60">{idx} / {list.length}</span>
      <button onclick={() => { if (nextP) sel = nextP; }} disabled={!nextP} aria-label={t("photo.next")}
        class="h-9 w-9 rounded-full bg-neutral-300 text-lg dark:bg-neutral-700 disabled:opacity-30">›</button>
    </div>
    <div class="flex flex-wrap items-center justify-center gap-3">
      <button onclick={toggleFavSel} aria-label={t("photo.fav")} title={t("photo.fav")} class={chip(!!sel.fav, "lg")}>
        {sel.fav ? "♥" : "♡"}
      </button>
      {#if list.length > 1}
        <button onclick={toggleSlide} class={chip(slide, "lg")}>{slide ? t("photo.slideStop") : t("photo.slidePlay")}</button>
      {/if}
      <button onclick={() => void shareSel()} class={btn("neutral", "lg")}>{t("photo.share")}</button>
      <button onclick={closeSel} class={btn("neutral", "lg")}>{t("photo.close")}</button>
      {#if isRealPhoto(sel)}
        <button onclick={setWallpaper} class={btn("neutral", "lg")}>{t("photo.setWallpaper")}</button>
      {/if}
      <button onclick={deleteSel} class={btn("danger", "lg")}>{t("photo.delete")}</button>
    </div>
    {#if wallMsg}
      <p role="status" class="text-xs opacity-70">{wallMsg}</p>
    {/if}
  </div>
{:else}


  <div class="p-2">
    <div class="mb-2 flex flex-wrap items-center gap-2 px-1">
      <button onclick={add} class={btn("accent", "lg")}>{t("photo.add")}</button>
      {#if list.length > 0}
        <button onclick={toggleSelectMode} class={chip(selecting, "lg")}>{selecting ? t("photo.cancel") : t("photo.select")}</button>
      {/if}
      <div class="ml-auto flex gap-1">
        <button onclick={() => setFilter("all")} aria-pressed={viewIs("all")} class={chip(viewIs("all"), "md")}>{t("photo.all")} ({list.length})</button>
        {#if favsOf(list).length > 0}
          <button onclick={() => setFilter("fav")} aria-pressed={viewIs("fav")} class={chip(viewIs("fav"), "md")}>♥ ({favsOf(list).length})</button>
        {/if}
        {#if vids.length > 0}
          <button onclick={() => setFilter("videos")} aria-pressed={viewIs("videos")} class={chip(viewIs("videos"), "md")}>🎬 ({vids.length})</button>
        {/if}
      </div>
      {#if selecting && list.length > 0}
        <button onclick={toggleSelectAll} class={chip(allShownSelected, "md")}>{allShownSelected ? t("photo.selectNone") : t("photo.selectAll")}</button>
      {/if}
      {#if selecting && selected.size > 0}
        <button onclick={() => batchFav(true)} class={btn("accent", "lg")}>{t("photo.favSelected", { n: selected.size })}</button>
        <button onclick={deleteSelected} class={btn("danger", "lg")}>{t("photo.deleteSelected", { n: selected.size })}</button>
      {/if}
    </div>

    {#if nativeBlocked}
      <div
        role="status"
        data-testid="native-blocked"
        class="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/15 px-3 py-2 text-xs text-amber-100 ring-1 ring-amber-400/30"
      >
        <span aria-hidden="true">🔒</span>
        <span class="min-w-0 flex-1">{t("photo.nativeBlocked")}</span>
        <button
          onclick={() => void grantNative()}
          disabled={nativeBusy}
          aria-label={t("photo.nativeGrant")}
          class="rounded-full bg-amber-400/90 px-2.5 py-1 font-medium text-neutral-900 active:scale-95 disabled:opacity-50"
        >{t("photo.nativeGrant")}</button>
      </div>
    {/if}

    {#if list.length === 0 && !vidsOnly}
      <p class="py-10 text-center text-sm opacity-60">{t("photo.empty")}</p>
    {:else if shown.length === 0 && !vidsOnly}
      <p class="py-10 text-center text-sm opacity-60">{t("photo.favEmpty")}</p>
    {:else}
      {#if nativeShown}
        <div class="mb-2" role="region" aria-label={t("a11y.nativePhotos")}>
          {#if nativeTruncated}
            <p
              data-testid="native-truncated"
              role="status"
              class="mb-1 px-1 text-[11px] text-white/60"
            >
              {t("photo.nativePartial", {
                shown: native.length,
                total: native.length + nativeRemaining,
              })}
            </p>
          {/if}
          <div class="flex gap-1 overflow-x-auto px-1">
            {#each native as n (n.id)}
              {@const url = nativeStreamUrl(n, nativeBase)}
              {@const kind = nativeTileKind(n.kind)}
              {@const failed = nativeFailed.has(n.id)}
              <div
                class="relative grid aspect-square w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-black/20 text-2xl ring-1 ring-white/10"
                title={n.name}
              >
                {#if url && kind === "image" && !failed}
                  <img
                    src={url}
                    alt={n.name}
                    class="absolute inset-0 h-full w-full object-cover"
                    onerror={() => (nativeFailed = new Set([...nativeFailed, n.id]))}
                  />
                {:else if url && kind === "video" && !failed}
                  <video
                    src={url}
                    muted
                    playsinline
                    preload="metadata"
                    aria-label={n.name}
                    class="absolute inset-0 h-full w-full object-cover"
                    onerror={() => (nativeFailed = new Set([...nativeFailed, n.id]))}
                  />
                {/if}
                {#if !url || failed}
                  <span aria-hidden="true">{n.emoji ?? "🗂"}</span>
                {/if}
              </div>
            {/each}
          </div>
          {#if nativeHasMore && !nativeBlocked}
            <button
              data-testid="native-load-more"
              type="button"
              disabled={nativeBusy}
              onclick={() => void loadMoreNative()}
              aria-label={t("a11y.nativeLoadMore")}
              class="mt-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/90 active:scale-95 disabled:opacity-50"
            >
              {t("photo.nativeLoadMore", { n: nativeRemaining })}
            </button>
          {/if}
        </div>
      {/if}
      {#each sections as sec (sec.key)}
        <p role="heading" aria-level="2"
          class="mb-1 mt-2 flex items-baseline gap-2 px-1 text-[13px] font-semibold text-white/90">
          <span>{sec.label}</span>
          {#if sec.items.length > 1}
            <span class="text-xs font-normal text-white/50">{sec.items.length}</span>
          {/if}
        </p>
        <div class="grid gap-1" style={`grid-template-columns: repeat(${cols}, minmax(0, 1fr));`}>
          {#each sec.items as it (it.kind === "photo" ? it.p.id : it.v.id)}
          {#if it.kind === "video"}
            {@const v = it.v}
            <div class="relative aspect-square overflow-hidden bg-black text-4xl">
              <button aria-label={t("a11y.video")} onclick={() => void openVideo(v.id)}
                class="absolute inset-0 grid h-full w-full place-items-center">
                <span class="opacity-90">🎬</span>
                <span class="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-xs tabular-nums text-white">{fmtLen(v.durationMs)}</span>
                {#if resLabelOf(v)}
                  <span class="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-xs font-medium text-white">{resLabelOf(v)}</span>
                {/if}
              </button>
              <button aria-label={t("a11y.favouriteVideo")} onclick={() => favVideo(v.id)}
                class="absolute right-1 top-1 z-10 grid h-6 w-6 place-items-center rounded-full bg-black/45 text-xs text-white">{v.fav ? "♥" : "♡"}</button>
            </div>
          {:else}
            {@const p = it.p}
            {@const isSel = selecting && selected.has(p.id)}
            <button
              onclick={() => (selecting ? toggleSelect(p.id) : (sel = p))}
              aria-label={p.emoji ?? p.id}
              class={"relative grid aspect-square place-items-center overflow-hidden text-3xl " + (isSel ? "ring-2 ring-accent ring-inset" : "")}
              style:background={grad(p) ?? "#1c1c1e"}
            >
              {#if p.data}
                <img src={p.data} alt="" class="absolute inset-0 h-full w-full object-cover" />
              {:else}
                {p.emoji ?? ""}
              {/if}
              {#if p.fav && !selecting}
                <span class="absolute left-1 top-1 text-xs drop-shadow">♥</span>
              {/if}
              {#if selecting}
                <span class={"absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full text-xs font-bold " +
                  (isSel ? "bg-accent text-white" : "bg-black/40 text-white/90")}>{isSel ? "✓" : ""}</span>
              {/if}
            </button>
          {/if}
          {/each}
        </div>
      {/each}
    {/if}

    {#if playId}
      {@const cap = vids.find((x) => x.id === playId)}
      <div class="fixed inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 px-4">
        <div class="w-full max-w-lg">
          {#if playUrl}
            <video src={playUrl} controls autoplay playsinline class="max-h-[70vh] w-full rounded-xl"><track kind="captions" /></video>
          {:else}
            <div class="grid h-40 w-full place-items-center text-white/50">…</div>
          {/if}
          {#if cap}
            <div class="mt-2 text-center text-xs text-white/80">{fmtLen(cap.durationMs)}{resLabelOf(cap) ? ` · ${resLabelOf(cap)}` : ""}</div>
          {/if}
          <div class="mt-3 flex flex-col items-center gap-2">
            {#if wallMsg}
              <p role="status" class="text-xs text-white/80">{wallMsg}</p>
            {/if}
            <div class="flex items-center justify-between gap-3 self-stretch">
              <button onclick={closeVideo} aria-label={t("a11y.closeVideo")} data-icon="x" class="grid h-11 w-11 place-items-center rounded-full bg-white/15 text-white ring-1 ring-white/25">{@html iconSvg("x", "h-4 w-4")}</button>
              <button onclick={() => playId && shareVideo(playId)} class="rounded-full bg-white/15 px-4 py-1.5 text-sm text-white ring-1 ring-white/25">{t("photo.share")}</button>
              <button onclick={() => playId && void deleteVideo(playId)} class="rounded-full bg-danger/90 px-4 py-1.5 text-sm text-white">{t("photo.delete")}</button>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

