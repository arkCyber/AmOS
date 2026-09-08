import { useTheme } from "../theme";
import { readStoreValue } from "../lib/amosStore";
import { bgMode, isBgMode, isCustomWallpaper, resolveWallpaper } from "../lib/wallpaper";

/**
 * React chrome leaf: the full-screen wallpaper backdrop rendered by the shell
 * (App.tsx). The wallpaper/lock-wallpaper *picker* cards are single-source in
 * Svelte (settings/…); this file only ships Backdrop for the React chrome path.
 */
interface Prefs {
  wallpaper?: string;
  background?: string;
  lockWallpaper?: string;
}

function readPrefs(): Prefs {
  return readStoreValue<Prefs>("amos.settings", {});
}

export function Backdrop() {
  const { dark } = useTheme();
  const prefs = readPrefs();
  const style = bgMode(prefs.background);
  const file = resolveWallpaper(dark, prefs.wallpaper);
  const bg = isCustomWallpaper(file) ? file : `wallpapers/${file}`;
  return (
    <div
      aria-hidden
      className="absolute inset-0 bg-cover bg-center"
      style={{
        backgroundImage: `url(${bg})`,
        opacity: style.alpha,
        filter: `blur(${style.blur}px) saturate(${style.sat}) brightness(${style.bright})`,
      }}
    />
  );
}

export { isBgMode };
