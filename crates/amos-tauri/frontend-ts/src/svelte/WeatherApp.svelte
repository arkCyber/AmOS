<script lang="ts">
  // WeatherApp.svelte — Svelte 5 (runes) implementation of the weather screen.
  // Logic is NOT reimplemented: it reuses lib/weather.ts (pure) and persists
  // through the shared amos.* store (lib/amosStore). The former React `Weather`
  // FC (src/apps.tsx) was removed in the subtraction phase — this is now the only
  // implementation, mounted directly by apps.tsx WeatherEntry (no React fallback).
  // It demonstrates the Svelte infrastructure layer:
  //   • reactive i18n singleton (locale.svelte.ts) — `t()`/`locale()` update in
  //     place when the React shell switches language (no remount/state loss);
  //   • store persistence via runes $state + $effect (mirrors useState+useEffect).
  import {
    addWeatherCity,
    adjustForecast,
    convertRange,
    dayLabel,
    displayTemp,
    forecast,
    normalizeWeatherCities,
    removeWeatherCity,
    WEATHER_CITIES,
  } from "../lib/weather";
  import type { TempUnit, WCity } from "../lib/weather";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { locale, t } from "./locale.svelte";

  const CITIES_KEY = "amos.weather.cities";
  const CITY_KEY = "amos.weather.city";

  const base = new Date();
  const baseDays = forecast();

  // Editable city subset (persisted) + remembered selection.
  // NOTE: $state does NOT lazily invoke a function initializer — compute the
  // value first, then store it (passing an arrow would store the function).
  const initialCities = normalizeWeatherCities(
    readStoreValue<unknown>(CITIES_KEY, undefined),
  );
  let cities = $state<WCity[]>(initialCities);

  const savedSel = readStoreValue<string>(CITY_KEY, "");
  const initialSel = normalizeWeatherCities(undefined).some((c) => c.id === savedSel)
    ? savedSel
    : "";
  let selId = $state<string>(initialSel);
  let unit = $state<TempUnit>("c");
  let edit = $state(false);

  // Persist whenever they change (mirrors the React useEffect writers).
  $effect(() => {
    writeStoreValue(CITIES_KEY, cities);
  });
  $effect(() => {
    writeStoreValue(CITY_KEY, selId);
  });

  const active = $derived(cities.find((c) => c.id === selId) ?? cities[0]);
  const days = $derived(adjustForecast(baseDays, active?.offset ?? 0));
  const missingCity = $derived(WEATHER_CITIES.find((c) => !cities.some((x) => x.id === c.id)));

  const select = (id: string) => (selId = id);
  const addNext = () => {
    if (missingCity) cities = addWeatherCity(cities, missingCity);
  };
  const removeAt = (id: string) => {
    const next = removeWeatherCity(cities, id);
    cities = next;
    if (active?.id === id) selId = next[0]?.id ?? "";
  };
  const dayName = (daysFromNow: number): string =>
    daysFromNow === 0 ? t("weather.today") : dayLabel(locale(), base, daysFromNow);

  // Local equivalents of the React-only helpers (chip / GROUP live in the React
  // components/ui.tsx — imported here they'd drag React into the Svelte chunk).
  function chipCls(on: boolean): string {
    return `px-3 py-1 text-xs rounded-full transition ${
      on ? "bg-accent text-white" : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
    }`;
  }
  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const smallBtn = "rounded-full bg-neutral-200 px-2 py-0.5 text-xs dark:bg-neutral-700";
</script>

<div class="p-4">
  <div class="mb-2 flex flex-wrap items-center gap-1.5">
    {#each cities as c (c.id)}
      <button
        onclick={() => select(c.id)}
        aria-pressed={active?.id === c.id}
        class={chipCls(active?.id === c.id)}
      >
        {t(`weather.city.${c.id}`)}
      </button>
    {/each}
    <div class="ml-auto flex items-center gap-1.5">
      {#if missingCity}
        <button onclick={addNext} class={smallBtn}>+ {t("weather.addCity")}</button>
      {/if}
      <button onclick={() => (edit = !edit)} class={smallBtn}>
        {edit ? t("common.done") : t("weather.edit")}
      </button>
      <button onclick={() => (unit = "c")} class={chipCls(unit === "c")}>℃</button>
      <button onclick={() => (unit = "f")} class={chipCls(unit === "f")}>℉</button>
    </div>
  </div>

  {#if edit}
    <div class="mb-2 flex flex-wrap gap-1.5">
      {#each cities as c (c.id)}
        <button
          onclick={() => removeAt(c.id)}
          class="rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-danger dark:bg-neutral-700"
        >
          {t(`weather.city.${c.id}`)} ✕
        </button>
      {/each}
    </div>
  {/if}

  <div class="py-4 text-center">
    <div class="text-6xl">{days[0]?.icon ?? ""}</div>
    <div class="text-5xl font-thin">{days[0] ? displayTemp(days[0].temp, unit) : ""}</div>
    <div class="text-sm opacity-60">{days[0] ? convertRange(days[0].range, unit) : ""}</div>
    <div class="mt-1 text-xs opacity-60">
      {t("weather.humidity")} {days[0]?.humidity ?? "—"}% · {t("weather.wind")} {days[0]?.wind ?? "—"}
    </div>
  </div>

  <div class="divide-y divide-black/5 dark:divide-white/10 {GROUP}">
    {#each days as d (d.daysFromNow)}
      <div class="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <span class="min-w-0 flex-1 truncate text-sm">{dayName(d.daysFromNow)}</span>
        <span class="text-xl">{d.icon}</span>
        <span class="flex w-16 flex-col items-end">
          <span class="text-sm font-semibold tabular-nums">{convertRange(d.range, unit)}</span>
          <span class="text-xs opacity-60">💧{d.humidity}%</span>
        </span>
      </div>
    {/each}
  </div>
</div>
