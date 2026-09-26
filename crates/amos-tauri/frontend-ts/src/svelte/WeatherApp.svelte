<script lang="ts">
  // WeatherApp.svelte — Svelte 5 (runes) implementation of the weather screen.
  // Logic is NOT reimplemented: it reuses lib/weather.ts (pure) and persists
  // through the shared amos.* store (lib/amosStore). The former React `Weather`
  // FC was removed in the subtraction phase — this is the only implementation,
  // mounted by `appRegistry`.
  // It demonstrates the Svelte infrastructure layer:
  //   • reactive i18n singleton (locale.svelte.ts) — `t()`/`locale()` update in
  //     place when the shell switches language (no remount/state loss);
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
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { locale, t } from "./locale.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";

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

  // Validate the remembered selection against the **persisted** city list
  // (`initialCities`), not against the default four — `normalizeWeatherCities(undefined)`
  // reads nothing and answers with `defaultWeatherCities()`, so a selection of a
  // user-added city (say Paris, the fifth) was judged "not in the list" and dropped;
  // the write-back effects below then erased it from the store.
  const savedSel = readStoreValue<string>(CITY_KEY, "");
  const initialSel = initialCities.some((c) => c.id === savedSel) ? savedSel : "";
  let selId = $state<string>(initialSel);
  let unit = $state<TempUnit>("c");
  let edit = $state(false);
  // A rejected `amos.weather.cities` write (full/unavailable storage): say so.
  let citiesErr = $state("");

  // Persist whenever they change (mirrors the React useEffect writers).
  //
  // The city list is **content the user set** (added and removed by hand, and the chips redraw
  // the moment they do), so its verdict is read — a refused write is exactly the case where the
  // screen shows the new city and a reload shows it never happened. The world-clock list is the
  // same fact and says so the same way (`ClockApp.svelte`, REQ-A1410). That round's sweep was
  // file-local, so this sibling key (`amos.weather.cities`) — classified `configuration` in
  // `scripts/store-allowlist.json` and absent from `lib/cloud.ts::SYNC_STORES`, so write-scan's
  // `classify` returns `non-content` — kept the `void` write (REQ-A1416 ∕ F-SH-674). The
  // remembered **selection** below is a preference, not content: a refused write there costs
  // "which city you were looking at" and is not reported.
  $effect(() => {
    citiesErr = writeStoreValueChecked(CITIES_KEY, cities) ? "" : t("common.storeWriteFailed");
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

  // Local chip/GROUP class helpers kept here (Svelte-only UI).
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
  <StoreErrorBar message={citiesErr} />
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
      <button onclick={() => (unit = "c")} aria-pressed={unit === "c"} class={chipCls(unit === "c")}>℃</button>
      <button onclick={() => (unit = "f")} aria-pressed={unit === "f"} class={chipCls(unit === "f")}>℉</button>
    </div>
  </div>

  {#if edit}
    <div class="mb-2 flex flex-wrap gap-1.5">
      {#each cities as c (c.id)}
        <button
          onclick={() => removeAt(c.id)}
          class="inline-flex items-center gap-1 rounded-full bg-danger/8 px-2 py-0.5 text-xs text-danger dark:bg-danger/20"
        >
          {t(`weather.city.${c.id}`)}<span data-icon="x" class="grid h-3 w-3 place-items-center">{@html iconSvg("x", "h-3 w-3")}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="py-4 text-center">
    <div class="text-6xl">{days[0]?.icon ?? ""}</div>
    <div class="text-5xl font-medium">{days[0] ? displayTemp(days[0].temp, unit) : ""}</div>
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
