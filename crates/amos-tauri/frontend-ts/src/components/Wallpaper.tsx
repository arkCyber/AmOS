import { useState } from "react";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { GROUP, pillCls } from "./ui";
import {
  BACKGROUND_MODES,
  DEFAULT_BG_MODE,
  WALLPAPER_PRESETS,
  bgMode,
  isBgMode,
  isCustomWallpaper,
  resolveWallpaper,
  type BgModeId,
} from "../lib/wallpaper";

interface Prefs {
  wallpaper?: string;
  background?: string;
}

function readPrefs(): Prefs {
  return readStoreValue<Prefs>("amos.settings", {});
}
function writePref(patch: Prefs) {
  writeStoreValue("amos.settings", { ...readPrefs(), ...patch });
}

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

export function WallpaperCard() {
  const { t } = useI18n();
  const prefs = readPrefs();
  const [url, setUrl] = useState(
    prefs.wallpaper && isCustomWallpaper(prefs.wallpaper) ? prefs.wallpaper : "",
  );
  const mode = prefs.background ?? DEFAULT_BG_MODE;
  const pick = (id: string) => {
    writePref({ wallpaper: id });
    setUrl(id);
  };
  const setCustom = () => {
    const v = url.trim();
    if (v) writePref({ wallpaper: v });
  };
  return (
    <section className={"p-4 " + GROUP}>
      <h3 className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{t("wp.label")}</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {WALLPAPER_PRESETS.map((id) => (
          <button
            key={id}
            onClick={() => pick(id)}
            className={pillCls(prefs.wallpaper === id || (!prefs.wallpaper && id === "auto"))}
          >
            {t(PRESET_LABEL[id])}
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("wp.customPh")}
          className="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-xs outline-none dark:bg-white/10"
        />
        <button onClick={setCustom} className={pillCls(false)}>
          {t("bg.customPh")}
        </button>
      </div>
      <h4 className="mt-4 text-xs opacity-70">{t("bg.label")}</h4>
      <div className="mt-1 flex flex-wrap gap-2">
        {BACKGROUND_MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => writePref({ background: m.id })}
            className={pillCls(mode === m.id)}
          >
            {t(MODE_LABEL[m.id])}
          </button>
        ))}
      </div>
    </section>
  );
}

export { isBgMode };
