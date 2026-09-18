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
    tilt: { x: 0, y: 0 },
    available: false,
  });
  let tab = $state<"compass" | "level">("compass");
  let permissionGranted = $state(false);
  let locationGranted = $state(false);

  // Persist settings
  $effect(() => {
    writeStoreValue(COMPASS_SETTINGS_KEY, settings);
  });

  // Computed values
  const displayHeading = $derived(
    settings.useTrueNorth && reading.available
      ? applyDeclination(reading.heading, settings.declination)
      : reading.heading
  );
  const cardinal = $derived(cardinalDirection(displayHeading, locale()));
  const levelPct = $derived(levelPercentage(reading.tilt.x, reading.tilt.y));
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
          
          if (result.fromCache) {
            // Using cached declination - no need to update
            console.log("Using cached magnetic declination");
          } else {
            // Update with fresh data
            console.log("Fetched new magnetic declination:", result.declination);
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

      if (alpha === null) {
        reading = { ...reading, available: false };
        return;
      }

      // Convert alpha (0 = north, increases clockwise) to compass heading
      const heading = normalizeHeading(360 - alpha);
      
      reading = {
        heading,
        tilt: {
          x: gamma ?? 0,
          y: beta ?? 0,
        },
        available: true,
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
  <div class="flex border-b border-neutral-200 dark:border-neutral-800">
    <button
      onclick={() => (tab = "compass")}
      class={tabCls(tab === "compass")}
    >
      {t("compass.compass")}
    </button>
    <button
      onclick={() => (tab = "level")}
      class={tabCls(tab === "level")}
    >
      {t("compass.level")}
    </button>
  </div>

  <!-- Compass Tab -->
  {#if tab === "compass"}
    <div class="flex flex-1 flex-col items-center justify-center p-4">
      {#if !permissionGranted}
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
      {:else if !reading.available}
        <div class="text-center">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {t("compass.unavailable")}
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
            {settings.useTrueNorth ? t("compass.trueNorth") : t("compass.magneticNorth")}
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
          {#if settings.useTrueNorth && !locationGranted}
            <span class="text-xs text-neutral-500">
              ({t("compass.declinationUnavailable")})
            </span>
          {/if}
        </div>

        {#if settings.useTrueNorth && settings.declination !== 0}
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
        <!-- Level Display -->
        <div class="mb-8 text-center">
          <div class="text-5xl font-light">
            {deviceLevel ? "✓" : "○"}
          </div>
          <div class="mt-2 text-lg font-medium">
            {deviceLevel ? t("compass.levelAchieved") : t("compass.levelAdjust")}
          </div>
        </div>

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

          <!-- Bubble (responds to tilt) -->
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
        </div>

        <!-- Tilt Angles -->
        <div class="grid grid-cols-2 gap-4 text-center">
          <div>
            <div class="text-xs text-neutral-500">{t("compass.tiltX")}</div>
            <div class="text-2xl font-light tabular-nums">
              {reading.tilt.x.toFixed(1)}°
            </div>
          </div>
          <div>
            <div class="text-xs text-neutral-500">{t("compass.tiltY")}</div>
            <div class="text-2xl font-light tabular-nums">
              {reading.tilt.y.toFixed(1)}°
            </div>
          </div>
        </div>

        <!-- Level Status -->
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
    </div>
  {/if}
</div>
