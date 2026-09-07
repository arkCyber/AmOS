<script lang="ts">
  // PhotosApp.svelte — Svelte 5 (runes) port of the React `Photos` in apps.tsx.
  // Still-photo logic reuses pure lib/photos.ts; camera video tiles use
  // lib/cameraCapture (no React VideoThumb thumbnail here → 🎬 tile with
  // duration/res; playback overlay still streams the MediaStore blob).
  // (WIP Photos port: compilable, NOT yet wired into COMPONENTS.)
  import {
    PHOTOS_KEY,
    favsOf,
    isRealPhoto,
    neighborOf,
    newPhoto,
    normalizePhotos,
    removePhoto,
    removePhotos,
    seedPhotos,
    shareCaption,
    toggleFav,
  } from "../lib/photos";
  import type { Photo } from "../lib/photos";
  import { captureBlob, listCaptures, removeVideoCapture, resLabelOf, toggleCaptureFav } from "../lib/cameraCapture";
  import type { VideoCapture } from "../lib/cameraCapture";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { fmtTime } from "../lib/notes";
  import { t } from "./locale.svelte";

  const seed = ((): Photo[] => {
    const existing = normalizePhotos(readStoreValue<unknown>(PHOTOS_KEY, []));
    if (existing.length) return existing;
    const s = seedPhotos(8, Date.now());
    writeStoreValue(PHOTOS_KEY, s);
    return s;
  })();

  let list = $state<Photo[]>(seed);
  let sel = $state<Photo | null>(null);
  let wallMsg = $state("");
  let slide = $state(false);
  let favOnly = $state(false);
  let vids = $state<VideoCapture[]>(listCaptures());
  let playId = $state<string | null>(null);
  let playUrl = $state("");
  let selecting = $state(false);
  let selected = $state<ReadonlySet<string>>(new Set());

  const persist = (l: Photo[]) => {
    writeStoreValue(PHOTOS_KEY, l);
    list = l;
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
    selected = new Set();
    selecting = !selecting;
  };
  const deleteSelected = () => {
    if (selected.size === 0) return;
    persist(removePhotos(list, selected));
    selected = new Set();
    selecting = false;
  };

  // Interleave stills + camera videos newest-first.
  const gallery = $derived(
    (() => {
      const out: ({ kind: "photo"; p: Photo } | { kind: "video"; v: VideoCapture })[] = [];
      for (const p of shown) out.push({ kind: "photo", p });
      const showVideos = vids.length > 0 && !selecting && !favOnly;
      if (showVideos) for (const v of vids) out.push({ kind: "video", v });
      out.sort(
        (a, b) =>
          (b.kind === "photo" ? b.p.ts : b.v.ts) - (a.kind === "photo" ? a.p.ts : a.v.ts),
      );
      return out;
    })(),
  );

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
        const p = neighborOf(list, cur.id, -1);
        if (p) sel = p;
      } else if (e.key === "ArrowRight") {
        const n = neighborOf(list, cur.id, 1);
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
      sel = neighborOf(list, sel?.id ?? "", 1) ?? sel;
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
    persist(removePhoto(list, sel.id));
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
    await removeVideoCapture(id);
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

{#if sel}
  {@const prevP = neighborOf(list, sel?.id ?? "", -1)}
  {@const nextP = neighborOf(list, sel?.id ?? "", 1)}
  {@const idx = list.findIndex((p) => p.id === sel?.id) + 1}
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
      {#if favsOf(list).length > 0}
        <div class="ml-auto flex gap-1">
          <button onclick={() => (favOnly = false)} aria-pressed={!favOnly} class={chip(!favOnly, "md")}>{t("photo.all")} ({list.length})</button>
          <button onclick={() => (favOnly = true)} aria-pressed={favOnly} class={chip(favOnly, "md")}>♥ ({favsOf(list).length})</button>
        </div>
      {/if}
      {#if selecting && selected.size > 0}
        <button onclick={deleteSelected} class={btn("danger", "lg")}>{t("photo.deleteSelected", { n: selected.size })}</button>
      {/if}
    </div>

    {#if list.length === 0}
      <p class="py-10 text-center text-sm opacity-60">{t("photo.empty")}</p>
    {:else if shown.length === 0}
      <p class="py-10 text-center text-sm opacity-60">{t("photo.favEmpty")}</p>
    {:else}
      <div class="grid grid-cols-3 gap-1">
        {#each gallery as it (it.kind === "photo" ? it.p.id : it.v.id)}
          {#if it.kind === "video"}
            {@const v = it.v}
            <div class="relative aspect-square overflow-hidden bg-black text-4xl">
              <button aria-label="video" onclick={() => void openVideo(v.id)}
                class="absolute inset-0 grid h-full w-full place-items-center">
                <span class="opacity-90">🎬</span>
                <span class="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-xs tabular-nums text-white">{fmtLen(v.durationMs)}</span>
                {#if resLabelOf(v)}
                  <span class="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-xs font-medium text-white">{resLabelOf(v)}</span>
                {/if}
              </button>
              <button aria-label="favourite video" onclick={() => (vids = toggleCaptureFav(v.id))}
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
              <button onclick={closeVideo} aria-label="close video" data-icon="x" class="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-white ring-1 ring-white/25">{@html iconSvg("x", "h-4 w-4")}</button>
              <button onclick={() => playId && shareVideo(playId)} class="rounded-full bg-white/15 px-4 py-1.5 text-sm text-white ring-1 ring-white/25">{t("photo.share")}</button>
              <button onclick={() => playId && void deleteVideo(playId)} class="rounded-full bg-danger/90 px-4 py-1.5 text-sm text-white">{t("photo.delete")}</button>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

