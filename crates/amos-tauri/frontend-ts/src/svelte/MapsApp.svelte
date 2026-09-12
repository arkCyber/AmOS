<script lang="ts">
  // MapsApp.svelte — Svelte 5 (runes) single-source implementation of the maps
  // screen. Offline-capable map over pure lib/maps.ts:
  // slippy OSM tiles, city chips + search, drag/pan/zoom. "定位" (geolocation)
  // honours the system location master switch + per-app location grant; real
  // device fix is the same browser `navigator.geolocation`
  // (device acceptance), while the master/grant/offline gating is fully testable.
  import { readStoreValue } from "../lib/amosStore";
  import { SETTINGS_KEY, locationEnabled, normalizeQuick } from "../lib/settings";
  import {
    PLACES,
    latLonToTile,
    tileUrl,
    panTiles,
    shiftCenter,
    cityLabel,
    cityKey,
    zoomIn,
    zoomOut,
    type LatLon,
  } from "../lib/maps";
  import { capSet, loadLedger } from "../lib/permissions";
  import { grantCapability } from "./osPermissions";
  import { t, locale } from "./locale.svelte";

  const PX = 256;
  const SPAN = 3;
  const chipCls = (active: boolean) =>
    "px-3 py-1 text-xs rounded-full transition " +
    (active ? "bg-accent text-white" : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200");

  let center = $state<LatLon>([39.9042, 116.4074]);
  let zoom = $state(12);
  let label = $state("北京");
  let query = $state("");
  let status = $state("");
  let askLoc = $state(false);
  let granted = $state(capSet(loadLedger(), "maps", "location"));
  let online = $state(typeof navigator === "undefined" || navigator.onLine !== false);

  $effect(() => {
    if (typeof window === "undefined") return;
    const on = () => (online = true);
    const off = () => (online = false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    online = navigator.onLine !== false;
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  });

  // System location master switch: default ON; explicit OFF blocks all apps.
  const locMaster = () =>
    locationEnabled(normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {})));

  const locate = () => {
    if (!locMaster()) {
      status = t("maps.locOff");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          center = [pos.coords.latitude, pos.coords.longitude];
          zoom = 13;
          status = "";
        },
        () => (status = t("maps.notFound")),
      );
    } else {
      status = t("maps.offline");
    }
  };
  const allowLoc = () => {
    grantCapability("maps", "location");
    granted = true;
    askLoc = false;
    locate();
  };
  const denyLoc = () => {
    askLoc = false;
  };

  /* ---- drag / pan ---- */
  let drag: { sx: number; sy: number; center: LatLon } | null = null;
  const onPointerDown = (e: PointerEvent) => {
    if (!online) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag = { sx: e.clientX, sy: e.clientY, center };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (dx || dy) {
      center = shiftCenter(d.center, zoom, dx, dy);
      label = "";
    }
  };
  const endDrag = (e: PointerEvent) => {
    drag = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const nudge = (dxTiles: number, dyTiles: number) => {
    center = panTiles(center, zoom, dxTiles, dyTiles);
    label = "";
  };

  const tile = $derived(latLonToTile(center[0], center[1], zoom));
  const tx = $derived(Math.floor(tile.x));
  const ty = $derived(Math.floor(tile.y));

  const search = () => {
    const key = cityKey(query, locale());
    const c = key ? PLACES[key] : undefined;
    if (c && key) {
      center = c;
      label = key;
      status = "";
    } else {
      status = t("maps.notFound");
    }
  };
  const pickCity = (name: string) => {
    const c = PLACES[name];
    if (!c) return;
    center = c;
    label = name;
    query = "";
    status = "";
  };
</script>

<div class="p-3">
  <div class="flex items-center justify-between text-xs opacity-70">
    <span>{cityLabel(label, locale())}</span>
    <span>{status}</span>
  </div>

  <div
    role="application"
    aria-label={t("app.maps")}
    class="relative mt-2 h-64 touch-none overflow-hidden rounded-2xl bg-neutral-200 dark:bg-neutral-800"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={endDrag}
    onpointercancel={endDrag}
    onpointerleave={endDrag}
    title={online ? t("maps.dragHint") : undefined}
  >
    {#if !online}
      <div class="grid h-full w-full place-items-center text-4xl">{t("maps.offline")}</div>
    {:else}
      <div class="absolute" style="width: {SPAN * PX}px; height: {SPAN * PX}px;">
        {#each Array.from({ length: SPAN * SPAN }) as _, i (i)}
          {@const dx = i % SPAN}
          {@const dy = Math.floor(i / SPAN)}
          {@const ox = tx + dx - 1}
          {@const oy = ty + dy - 1}
          <img
            alt=""
            src={tileUrl(zoom, ox, oy)}
            class="absolute"
            style="left: {dx * PX}px; top: {dy * PX}px; width: {PX}px; height: {PX}px;"
          />
        {/each}
      </div>
    {/if}
    <div class="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full text-2xl">
      📍
    </div>
  </div>

  <div class="mt-2 flex flex-wrap items-center gap-2">
    {#if askLoc}
      <div class="flex w-full flex-wrap items-center gap-2 rounded-2xl bg-white/70 px-3 py-2 text-xs ring-1 ring-black/10 dark:bg-white/[0.06] dark:ring-white/10">
        <span class="opacity-80">
          {t("perm.askAllow", { app: t("app.maps"), cap: t("perm.cap.location") })}
        </span>
        <button onclick={allowLoc} class="rounded-full bg-accent px-3 py-1 text-white">
          {t("perm.allow")}
        </button>
        <button onclick={denyLoc} class="rounded-full bg-neutral-300 px-3 py-1 dark:bg-neutral-700">
          {t("perm.deny")}
        </button>
      </div>
    {/if}
    <button
      onclick={() => {
        if (!locMaster()) status = t("maps.locOff");
        else if (!granted) askLoc = true;
        else locate();
      }}
      class="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700"
    >
      {t("maps.locate")}
    </button>
    <button onclick={() => (zoom = zoomOut(zoom))} class="h-8 w-8 rounded-full bg-neutral-300 dark:bg-neutral-700" aria-label="zoom out">
      −
    </button>
    <button onclick={() => (zoom = zoomIn(zoom))} class="h-8 w-8 rounded-full bg-neutral-300 dark:bg-neutral-700" aria-label="zoom in">
      +
    </button>
    <div class="flex items-center gap-1">
      <button onclick={() => nudge(0, -1)} class="h-7 w-7 rounded-full bg-neutral-300 text-xs dark:bg-neutral-700" aria-label={t("maps.panUp")}>▲</button>
      <button onclick={() => nudge(-1, 0)} class="h-7 w-7 rounded-full bg-neutral-300 text-xs dark:bg-neutral-700" aria-label={t("maps.panLeft")}>◀</button>
      <button onclick={() => nudge(1, 0)} class="h-7 w-7 rounded-full bg-neutral-300 text-xs dark:bg-neutral-700" aria-label={t("maps.panRight")}>▶</button>
      <button onclick={() => nudge(0, 1)} class="h-7 w-7 rounded-full bg-neutral-300 text-xs dark:bg-neutral-700" aria-label={t("maps.panDown")}>▼</button>
    </div>
    <input
      bind:value={query}
      onkeydown={(e) => {
        if (e.key === "Enter") search();
      }}
      placeholder={t("maps.search")}
      class="min-w-0 flex-1 rounded-full bg-black/5 px-3.5 py-1.5 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:text-white dark:ring-white/10 dark:placeholder:text-white/30"
    />
  </div>
  <div class="mt-2 flex flex-wrap gap-1.5">
    {#each Object.keys(PLACES) as name (name)}
      <button onclick={() => pickCity(name)} class={chipCls(label === name)}>
        {cityLabel(name, locale())}
      </button>
    {/each}
  </div>
</div>

