<script lang="ts">
  // MapsApp.svelte — Svelte 5 (runes) single-source implementation of the maps
  // screen. Offline-capable map over pure lib/maps.ts:
  // slippy OSM tiles, city chips + search, drag/pan/zoom. "定位" (geolocation)
  // honours the system location master switch + per-app location grant; the real
  // device fix comes from the sensor host's `gnss` block (the same
  // `LocationManager` read the rest of the system reports, REQ-A772) and falls
  // back to the browser `navigator.geolocation` only on a host that has no GNSS
  // at all — which is the only path a desktop has. The master/grant/offline
  // gating stays fully testable.
  import { readStoreValue } from "../lib/amosStore";
  import { SETTINGS_KEY, locationEnabled, normalizeQuick } from "../lib/settings";
  import { readGnss, type GnssRead } from "../lib/gps";
  import { locationPermissionRequest } from "../lib/backend";
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
  import StoreErrorBar from "./StoreErrorBar.svelte";

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
  /** The ledger write's refusal, shown inside the still-open prompt (`StoreErrorBar`). */
  let storeErr = $state("");
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

  /** The WebView fallback: only reached when this host has **no GNSS at all** (a desktop) or no
   *  sensor bridge (a browser preview). On a device the sensor host answers, so this path is the
   *  one that would otherwise hide the real receiver's state behind a browser prompt. */
  const browserLocate = () => {
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

  /**
   * Map the sensor host's honest GNSS reading onto the map.
   *
   * The five outcomes are kept apart on purpose — a failed read is *not* "searching", and a
   * receiver that was switched off is a third thing again. `retried` bounds the permission round
   * to one attempt, so a denial cannot become a loop.
   */
  const locateFromGnss = async (read: GnssRead, retried = false): Promise<void> => {
    switch (read.kind) {
      case "fix":
        center = [read.location.latitude, read.location.longitude];
        zoom = 13;
        status = "";
        return;
      case "permission-required": {
        if (retried) {
          status = t("maps.locPermission");
          return;
        }
        // Post the **native** location dialog (not the WebView's — the two prompts are separate),
        // then read again. What the dialog answered is not the fact; whether the next snapshot
        // could reach the receiver is.
        await locationPermissionRequest();
        await locateFromGnss(await readGnss(), true);
        return;
      }
      case "no-fix":
        status = read.enabled ? t("maps.locSearching") : t("maps.locReceiverOff");
        return;
      case "read-failed":
        status = t("maps.locReadFailed");
        return;
      case "absent":
      case "unavailable":
        browserLocate();
        return;
    }
  };

  const locate = async () => {
    if (!locMaster()) {
      status = t("maps.locOff");
      return;
    }
    await locateFromGnss(await readGnss());
  };
  // `granted` is seeded from the persisted ledger (`capSet(loadLedger(), …)`), so it is a
  // *display of* `amos.permissions` — the ledger every OS capability gate reads back. The
  // prompt's answer must adopt the **write's own verdict**: on a refused write `grantCapability`
  // answers the ledger the store still holds, so drawing a granted location off the intent would
  // show a permission the next boot does not have (and `locate()` would run on it). The adopted
  // value decides whether the prompt may close; a still-ungranted ledger keeps it up and says why.
  const allowLoc = () => {
    const res = grantCapability("maps", "location");
    granted = capSet(res.ledger, "maps", "location");
    if (!granted) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    askLoc = false;
    void locate();
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
        <StoreErrorBar message={storeErr} />
      </div>
    {/if}
    <button
      onclick={() => {
        if (!locMaster()) status = t("maps.locOff");
        else if (!granted) askLoc = true;
        else void locate();
      }}
      class="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700"
    >
      {t("maps.locate")}
    </button>
    <button onclick={() => (zoom = zoomOut(zoom))} class="h-8 w-8 rounded-full bg-neutral-300 dark:bg-neutral-700" aria-label={t("a11y.zoomOut")}>
      −
    </button>
    <button onclick={() => (zoom = zoomIn(zoom))} class="h-8 w-8 rounded-full bg-neutral-300 dark:bg-neutral-700" aria-label={t("a11y.zoomIn")}>
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

