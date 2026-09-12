<script lang="ts">
  // WallpaperCard.svelte — Svelte 5 (runes) port of the React WallpaperCard
  // (main/home wallpaper chooser shown in Settings). Persists to amos.settings
  // ({ wallpaper, background }) through pure lib/wallpaper + the shared store.
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import {
    BACKGROUND_MODES,
    DEFAULT_BG_MODE,
    WALLPAPER_PRESETS,
    isBgMode,
    isCustomWallpaper,
    type BgModeId,
  } from "../lib/wallpaper";
  import { t } from "./locale.svelte";

  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const pillCls = (active: boolean) =>
    "rounded-full px-3 py-1.5 text-xs transition " +
    (active ? "bg-accent text-white" : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300");

  const PRESET_LABEL: Record<(typeof WALLPAPER_PRESETS)[number], string> = {
    auto: "wp.auto",
    dark: "wp.dark",
    light: "wp.light",
    landscape: "wp.landscape",
    dawn: "wp.dawn",
    abyss: "wp.abyss",
  };
  const MODE_LABEL: Record<BgModeId, string> = {
    ghost: "bg.ghost",
    soft: "bg.soft",
    muted: "bg.muted",
    vivid: "bg.vivid",
  };

  function readPrefs(): Record<string, unknown> {
    return readStoreValue<Record<string, unknown>>("amos.settings", {});
  }
  const initial = readPrefs();
  const initialWall =
    typeof initial.wallpaper === "string" ? (initial.wallpaper as string) : undefined;
  let wall = $state<string | undefined>(initialWall);
  let url = $state(initialWall && isCustomWallpaper(initialWall) ? initialWall : "");
  // The domain owns "is this a known background mode" (`lib/wallpaper.isBgMode`).
  // The card must not re-derive it from its own label map with a cast: a mode added
  // to the domain but not mirrored here would silently fall back to the default.
  const storedBg = initial.background;
  const initialBg: BgModeId =
    typeof storedBg === "string" && isBgMode(storedBg) ? storedBg : DEFAULT_BG_MODE;
  let bgSel = $state<BgModeId>(initialBg);

  const writePref = (patch: Record<string, unknown>) => {
    writeStoreValue("amos.settings", { ...readPrefs(), ...patch });
  };
  const pick = (id: string) => {
    writePref({ wallpaper: id });
    wall = id;
    url = id;
  };
  const setCustom = () => {
    const v = url.trim();
    if (v) {
      writePref({ wallpaper: v });
      wall = v;
    }
  };
  const presetActive = (id: string) => wall === id || (!wall && id === "auto");
</script>

<section class={"p-4 " + GROUP}>
  <h3 class="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{t("wp.label")}</h3>
  <div class="mt-2 flex flex-wrap gap-2">
    {#each WALLPAPER_PRESETS as id (id)}
      <button onclick={() => pick(id)} class={pillCls(presetActive(id))}>
        {t(PRESET_LABEL[id])}
      </button>
    {/each}
  </div>
  <div class="mt-3 flex gap-2">
    <input
      bind:value={url}
      placeholder={t("wp.customPh")}
      class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-xs outline-none dark:bg-white/10"
    />
    <button onclick={setCustom} class={pillCls(false)}>
      {t("bg.customPh")}
    </button>
  </div>
  <h4 class="mt-4 text-xs opacity-70">{t("bg.label")}</h4>
  <div class="mt-1 flex flex-wrap gap-2">
    {#each BACKGROUND_MODES as m (m.id)}
      <button onclick={() => { writePref({ background: m.id }); bgSel = m.id; }} class={pillCls(bgSel === m.id)}>
        {t(MODE_LABEL[m.id])}
      </button>
    {/each}
  </div>
</section>
