<script lang="ts">
  // Backdrop.svelte — Svelte 5 (runes) port of the React `Wallpaper.Backdrop`
  // shell chrome. Pure presentational island mounted behind every screen: reads
  // the reactive theme (dark?) and the shared amos.settings wallpaper prefs, then
  // paints the resolved wallpaper with the bg-mode filter. Same lib/wallpaper
  // helpers as React.
  //
  // REQ-A275: when `amos.settings.view.showWallpaper` is false (View → Toggle
  // Wallpaper), the Backdrop renders nothing — the desktop shows a flat fill
  // colour instead.
  import { themeDark } from "./theme.svelte";
  import { SETTINGS_KEY } from "../lib/settings";
  import { createStoreValue } from "./store";
  import {
    DEFAULT_DESKTOP_VIEW,
    DESKTOP_VIEW_KEY,
    type DesktopView,
  } from "../lib/desktopView";
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

  // View toggles: Backdrop is only painted when the user has not hidden it.
  const viewStore = createStoreValue<DesktopView>(
    DESKTOP_VIEW_KEY,
    DEFAULT_DESKTOP_VIEW,
  );
  let view = $state<DesktopView>(DEFAULT_DESKTOP_VIEW);
  $effect(() => {
    const un = viewStore.subscribe((v) => (view = v ?? DEFAULT_DESKTOP_VIEW));
    return un;
  });

  const dark = $derived(themeDark());
  const style = $derived(bgMode(settings.background));
  const file = $derived(resolveWallpaper(dark, settings.wallpaper));
  const bg = $derived(isCustomWallpaper(file) ? file : `wallpapers/${file}`);
</script>

{#if view.showWallpaper}
<div
  data-testid="stage-backdrop"
  aria-hidden="true"
  class="absolute inset-0 bg-cover bg-center"
  style={`background-image:url(${bg});opacity:${style.alpha};filter:blur(${style.blur}px) saturate(${style.sat}) brightness(${style.bright})`}
></div>
{/if}
