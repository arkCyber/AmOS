<script lang="ts">
  // Backdrop.svelte — Svelte 5 (runes) port of the React `Wallpaper.Backdrop`
  // shell chrome. Pure presentational island mounted behind every screen: reads
  // the reactive theme (dark?) and the shared amos.settings wallpaper prefs, then
  // paints the resolved wallpaper with the bg-mode filter. Same lib/wallpaper
  // helpers as React.
  import { themeDark } from "./theme.svelte";
  import { SETTINGS_KEY } from "../lib/settings";
  import { createStoreValue } from "./store";
  import {
    bgMode,
    isCustomWallpaper,
    resolveWallpaper,
  } from "../lib/wallpaper";

  const settingsStore = createStoreValue<{ wallpaper?: string; background?: string }>(
    SETTINGS_KEY,
    {},
  );
  let settings = $state<{ wallpaper?: string; background?: string }>({});
  $effect(() => {
    const un = settingsStore.subscribe((v) => (settings = v ?? {}));
    return un;
  });

  const dark = $derived(themeDark());
  const style = $derived(bgMode(settings.background));
  const file = $derived(resolveWallpaper(dark, settings.wallpaper));
  const bg = $derived(isCustomWallpaper(file) ? file : `wallpapers/${file}`);
</script>

<div
  aria-hidden="true"
  class="absolute inset-0 bg-cover bg-center"
  style={`background-image:url(${bg});opacity:${style.alpha};filter:blur(${style.blur}px) saturate(${style.sat}) brightness(${style.bright})`}
></div>
