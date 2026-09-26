<script lang="ts">
  // CompassApp.svelte — Svelte 5 (runes) implementation of the compass screen.
  // Features: magnetic/true north heading, cardinal directions, level indicator,
  // and iOS-style circular compass rose. Uses DeviceOrientation API with
  // permission handling for iOS 13+.
  
  import { onMount, onDestroy } from "svelte";
  import { t, locale } from "./locale.svelte";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import {
    COMPASS_SETTINGS_KEY,
    normalizeCompassSettings,
    cardinalDirection,
    normalizeHeading,
    applyDeclination,
    isOrientationSupported,
    requestOrientationPermission,
    fetchDeclinationWithCache,
    levelPercentage,
    isLevel,
  } from "../lib/compass";
  import type { CompassSettings, CompassReading } from "../lib/compass";

  // --- state ---
  const initialSettings = normalizeCompassSettings(
    readStoreValue<unknown>(COMPASS_SETTINGS_KEY, undefined)
  );
  let settings = $state<CompassSettings>(initialSettings);
  let reading = $state<CompassReading>({
    heading: 0,
    // 没测到 ≠ 0°：两个轴各自可空，`null` 是「这一帧没给这个轴」（见 lib/compass.ts）。
    tilt: { x: null, y: null },
    available: false,
    headingKnown: false,
  });
  let tab = $state<"compass" | "level">("compass");
  let permissionGranted = $state(false);
  let locationGranted = $state(false);
  /**
   * Whether the platform has the orientation **API** at all — a capability fact, not
   * a permission one.
   *
   * Without `DeviceOrientationEvent`, `requestOrientationPermission()` answers `false`
   * forever, so the permission panel was asking the user to grant something that cannot
   * be granted, and its 「启用传感器」 button reloads straight back into the same panel.
   * `lib/compass.isOrientationSupported()` states this fact; the render has to read it
   * rather than collapse it into "not yet granted" (REQ-A1519 ∕ F-SH-761).
   */
  let supported = $state(isOrientationSupported());

  // Persist settings
  $effect(() => {
    writeStoreValue(COMPASS_SETTINGS_KEY, settings);
  });

  // Computed values
  //
  // "True north" is only a claim we can make when a declination was actually
  // obtained. A cached site is exactly that proof (`fetchDeclinationWithCache`
  // mints one only on a successful look-up), so its presence is the known bit —
  // and a real declination of 0°/unknown must not be conflated.
  const declinationKnown = $derived(settings.cachedLocation != null);
  const trueNorthApplied = $derived(settings.useTrueNorth && declinationKnown);
  /**
   * Any orientation data at all — tilt *or* a heading. Distinguishes "the sensor
   * has said nothing yet / does not exist" from "it is reporting, but not a
   * heading".
   */
  const anySensorData = $derived(reading.available || reading.headingKnown);
  const displayHeading = $derived(
    trueNorthApplied
      ? applyDeclination(reading.heading, settings.declination)
      : reading.heading
  );
  const cardinal = $derived(cardinalDirection(displayHeading, locale()));
  /**
   * Both tilt axes were measured in the current frame. The bubble, the numeric
   * readouts and the level verdict need **both**: a one-axis frame is a partial
   * reading, and the missing axis may not be drawn as 0° (F-SH-755).
   */
  const tiltComplete = $derived(reading.tilt.x !== null && reading.tilt.y !== null);
  /** `null` = some axis was not measured ⇒ no bar; the caller renders 「—」. */
  const levelPct = $derived(
    reading.tilt.x !== null && reading.tilt.y !== null
      ? levelPercentage(reading.tilt.x, reading.tilt.y)
      : null,
  );
  const deviceLevel = $derived(isLevel(reading.tilt.x, reading.tilt.y));

  // --- lifecycle ---
  let cleanupOrientation: (() => void) | null = null;

  onMount(async () => {
    if (!isOrientationSupported()) {
      reading = { ...reading, available: false };
      return;
    }

    // Request permission for iOS 13+
    const granted = await requestOrientationPermission();
    permissionGranted = granted;
    
    if (!granted) return;

    // Try to fetch magnetic declination using geolocation (with caching)
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          locationGranted = true;
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          
          // Fetch with cache support
          const result = await fetchDeclinationWithCache(
            lat,
            lon,
            settings.declination,
            settings.cachedLocation
          );

          // Only a known value updates settings: writing a `null` through would
          // erase a good cached declination (and dropping the cache site would
          // make the UI forget it ever knew one) just because one look-up missed.
          if (!result.fromCache && result.declination !== null) {
            settings = {
              ...settings,
              declination: result.declination,
              cachedLocation: result.cachedLocation,
            };
          }
        },
        () => {
          // Location denied or unavailable - use 0 declination
          locationGranted = false;
        },
        { timeout: 5000, maximumAge: 600000 }
      );
    }

    // Set up orientation listener
    const handleOrientation = (event: DeviceOrientationEvent) => {
      const alpha = event.alpha; // 0-360, 0 = north
      const beta = event.beta;   // -180 to 180, tilt front-back
      const gamma = event.gamma; // -90 to 90, tilt left-right

      // `alpha` (the heading) needs a magnetometer; `beta`/`gamma` (tilt) come
      // from the accelerometer and keep arriving without one. Two facts, kept
      // apart: the level tab reads tilt, the compass tab reads the heading. The
      // old single flag marked the whole reading unavailable the moment `alpha`
      // was null, so a device with no magnetometer lost its bubble level too —
      // and the tilt in that very event was discarded (REQ-A1275 / F-SH-550).
      const tiltKnown = beta !== null || gamma !== null;
      const headingKnown = alpha !== null;

      reading = {
        // Convert alpha (0 = north, increases clockwise) to compass heading.
        heading: headingKnown ? normalizeHeading(360 - alpha) : reading.heading,
        // 两个轴各自可空：`?!0` 会把「这一帧没量这个轴」折成 0°，于是气泡落在中线上、
        // 读数印 `0.0°`，而且当另一个轴在 2° 带内时还会报「已水平」——一次没人量过的
        // 水平（F-SH-755）。原始 `null` 一路带到渲染层，由它决定说「—」。
        tilt: { x: gamma, y: beta },
        available: tiltKnown,
        headingKnown,
        accuracy: (event as any).webkitCompassAccuracy ?? undefined,
      };
    };

    window.addEventListener("deviceorientation", handleOrientation, true);
    cleanupOrientation = () => {
      window.removeEventListener("deviceorientation", handleOrientation, true);
    };
  });

  onDestroy(() => {
    cleanupOrientation?.();
  });

  // --- UI helpers ---
  const toggleNorth = () => {
    settings = { ...settings, useTrueNorth: !settings.useTrueNorth };
  };

  const btnCls = (active: boolean) =>
    `px-3 py-1.5 text-sm rounded-lg transition ${
      active
        ? "bg-accent text-white"
        : "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
    }`;

  const tabCls = (active: boolean) =>
    `flex-1 py-2 text-sm font-medium transition ${
      active
        ? "text-accent border-b-2 border-accent"
        : "text-neutral-500 border-b border-neutral-300 dark:border-neutral-700"
    }`;
</script>

<div class="flex h-full flex-col">
  <!-- Tab Bar -->
  <div class="flex border-b border-neutral-200 dark:border-neutral-800" role="tablist">
    <button
      role="tab"
      aria-selected={tab === "compass"}
      onclick={() => (tab = "compass")}
      class={tabCls(tab === "compass")}
    >
      {t("compass.compass")}
    </button>
    <button
      role="tab"
      aria-selected={tab === "level"}
      onclick={() => (tab = "level")}
      class={tabCls(tab === "level")}
    >
      {t("compass.level")}
    </button>
  </div>

  <!-- Compass Tab -->
  {#if tab === "compass"}
    <div class="flex flex-1 flex-col items-center justify-center p-4">
      {#if !supported}
        <!-- No orientation API on this platform at all: there is nothing to grant.
             Say 「传感器不可用」 — the permission panel below would ask for a
             permission that cannot exist and its button would reload back into
             itself. -->
        <div class="text-center" data-testid="compass-unsupported">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {t("compass.unavailable")}
          </p>
        </div>
      {:else if !permissionGranted}
        <div class="text-center">
          <p class="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
            {t("compass.permissionRequired")}
          </p>
          <button
            onclick={async () => {
              const granted = await requestOrientationPermission();
              permissionGranted = granted;
              window.location.reload();
            }}
            class="rounded-lg bg-accent px-4 py-2 text-sm text-white"
          >
            {t("compass.enableSensor")}
          </button>
        </div>
      {:else if !anySensorData}
        <div class="text-center">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {t("compass.unavailable")}
          </p>
        </div>
      {:else if !reading.headingKnown}
        <!-- Tilt is flowing but no heading was reported: a device with no
             magnetometer. Say that — do not fold it into "sensor not
             available" (the level tab beside this one still works). -->
        <div class="text-center" data-testid="compass-no-heading">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {t("compass.noHeading")}
          </p>
        </div>
      {:else}
        <!-- Heading Display -->
        <div class="mb-8 text-center">
          <div class="text-7xl font-light tabular-nums tracking-tight">
            {Math.round(displayHeading)}°
          </div>
          <div class="mt-2 text-2xl font-medium">{cardinal}</div>
          <div class="mt-1 text-sm text-neutral-500">
            {trueNorthApplied ? t("compass.trueNorth") : t("compass.magneticNorth")}
          </div>
        </div>

        <!-- Compass Rose -->
        <div class="relative mb-8" style="width: 280px; height: 280px;">
          <!-- Rotating compass dial -->
          <div
            class="absolute inset-0 transition-transform duration-100 ease-out"
            style="transform: rotate({-displayHeading}deg);"
          >
            <svg viewBox="0 0 280 280" class="h-full w-full">
              <!-- Outer circle -->
              <circle
                cx="140"
                cy="140"
                r="135"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                class="text-neutral-300 dark:text-neutral-700"
              />
              
              <!-- Cardinal markers -->
              {#each [0, 90, 180, 270] as angle, i}
                <g transform="rotate({angle} 140 140)">
                  <line
                    x1="140"
                    y1="15"
                    x2="140"
                    y2="35"
                    stroke="currentColor"
                    stroke-width="3"
                    class="text-accent"
                  />
                  <text
                    x="140"
                    y="55"
                    text-anchor="middle"
                    class="fill-current text-xl font-bold"
                    class:text-accent={i === 0}
                  >
                    {["N", "E", "S", "W"][i]}
                  </text>
                </g>
              {/each}

              <!-- Degree markers (every 30°) -->
              {#each Array(12) as _, i}
                {@const angle = i * 30}
                {#if ![0, 90, 180, 270].includes(angle)}
                  <g transform="rotate({angle} 140 140)">
                    <line
                      x1="140"
                      y1="15"
                      x2="140"
                      y2="30"
                      stroke="currentColor"
                      stroke-width="2"
                      class="text-neutral-400 dark:text-neutral-600"
                    />
                    <text
                      x="140"
                      y="55"
                      text-anchor="middle"
                      class="fill-current text-sm text-neutral-500"
                    >
                      {angle}
                    </text>
                  </g>
                {/if}
              {/each}

              <!-- Minor ticks (every 10°) -->
              {#each Array(36) as _, i}
                {@const angle = i * 10}
                {#if angle % 30 !== 0}
                  <g transform="rotate({angle} 140 140)">
                    <line
                      x1="140"
                      y1="15"
                      x2="140"
                      y2="25"
                      stroke="currentColor"
                      stroke-width="1"
                      class="text-neutral-300 dark:text-neutral-700"
                    />
                  </g>
                {/if}
              {/each}
            </svg>
          </div>

          <!-- Fixed north pointer -->
          <div class="absolute inset-0 flex items-center justify-center">
            <svg width="60" height="80" viewBox="0 0 60 80" class="drop-shadow-lg">
              <path
                d="M30 0 L15 60 L30 50 L45 60 Z"
                fill="currentColor"
                class="text-accent"
              />
              <path
                d="M30 50 L15 60 L30 80 Z"
                fill="currentColor"
                class="text-neutral-400"
              />
            </svg>
          </div>
        </div>

        <!-- Controls -->
        <div class="flex items-center gap-2">
          <button onclick={toggleNorth} class={btnCls(settings.useTrueNorth)}>
            {settings.useTrueNorth ? t("compass.trueNorth") : t("compass.magneticNorth")}
          </button>
          {#if settings.useTrueNorth && !declinationKnown}
            <span class="text-xs text-neutral-500">
              ({locationGranted ? t("compass.declinationUnknown") : t("compass.declinationUnavailable")})
            </span>
          {/if}
        </div>

        {#if trueNorthApplied}
          <div class="mt-2 text-xs text-neutral-500">
            {t("compass.declination")}: {settings.declination.toFixed(1)}°
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Level Tab -->
  {#if tab === "level"}
    <div class="flex flex-1 flex-col items-center justify-center p-4">
      {#if !reading.available}
        <div class="text-center">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {t("compass.unavailable")}
          </p>
        </div>
      {:else}
        <!-- Level Display. Both axes are required: with one axis missing there is
             no level to report and no bubble to place — say which, rather than
             drawing the missing axis on the centre line (F-SH-755). -->
        {#if tiltComplete}
          <div class="mb-8 text-center">
            <div class="text-5xl font-light">
              {deviceLevel ? "✓" : "○"}
            </div>
            <div class="mt-2 text-lg font-medium">
              {deviceLevel ? t("compass.levelAchieved") : t("compass.levelAdjust")}
            </div>
          </div>
        {:else}
          <div class="mb-8 text-center" data-testid="compass-partial-tilt">
            <div class="text-5xl font-light">—</div>
            <div class="mt-2 text-lg font-medium">{t("compass.tiltIncomplete")}</div>
          </div>
        {/if}

        <!-- Bubble Level -->
        <div class="relative mb-8" style="width: 280px; height: 280px;">
          <!-- Outer circle (level boundary) -->
          <svg viewBox="0 0 280 280" class="absolute inset-0">
            <circle
              cx="140"
              cy="140"
              r="130"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="text-neutral-300 dark:text-neutral-700"
            />
            <!-- Center target -->
            <circle
              cx="140"
              cy="140"
              r="10"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="text-accent"
            />
            <circle
              cx="140"
              cy="140"
              r="20"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              class="text-neutral-400 dark:text-neutral-600"
            />
            <!-- Crosshair -->
            <line
              x1="140"
              y1="120"
              x2="140"
              y2="160"
              stroke="currentColor"
              stroke-width="1"
              class="text-neutral-400 dark:text-neutral-600"
            />
            <line
              x1="120"
              y1="140"
              x2="160"
              y2="140"
              stroke="currentColor"
              stroke-width="1"
              class="text-neutral-400 dark:text-neutral-600"
            />
          </svg>

          <!-- Bubble (responds to tilt). Drawn only when both axes were measured: a
               missing axis has no position on this 2-D plane. -->
          {#if reading.tilt.x !== null && reading.tilt.y !== null}
            <div
              class="absolute rounded-full bg-accent shadow-lg transition-all duration-100"
              style="
                width: 40px;
                height: 40px;
                left: {140 + (reading.tilt.x / 90) * 130 - 20}px;
                top: {140 + (reading.tilt.y / 90) * 130 - 20}px;
                opacity: {deviceLevel ? 1 : 0.7};
              "
            ></div>
          {/if}
        </div>

        <!-- Tilt Angles. An unmeasured axis reads 「—」, never `0.0°`. -->
        <div class="grid grid-cols-2 gap-4 text-center">
          <div>
            <div class="text-xs text-neutral-500">{t("compass.tiltX")}</div>
            <div class="text-2xl font-light tabular-nums" data-testid="compass-tilt-x">
              {reading.tilt.x === null ? "—" : `${reading.tilt.x.toFixed(1)}°`}
            </div>
          </div>
          <div>
            <div class="text-xs text-neutral-500">{t("compass.tiltY")}</div>
            <div class="text-2xl font-light tabular-nums" data-testid="compass-tilt-y">
              {reading.tilt.y === null ? "—" : `${reading.tilt.y.toFixed(1)}°`}
            </div>
          </div>
        </div>

        <!-- Level Status (both axes measured ⇒ a bar; otherwise nothing to draw) -->
        {#if levelPct !== null}
          <div class="mt-4">
            <div class="h-2 w-64 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div
                class="h-full transition-all duration-300"
                class:bg-green-500={deviceLevel}
                class:bg-orange-500={!deviceLevel && levelPct < 50}
                class:bg-red-500={!deviceLevel && levelPct >= 50}
                style="width: {Math.min(100, levelPct)}%"
              ></div>
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
