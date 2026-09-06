import { useState, type ChangeEvent } from "react";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { GROUP, pillCls } from "./ui";
import {
  BACKGROUND_MODES,
  DEFAULT_BG_MODE,
  WALLPAPER_FILES,
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
  lockWallpaper?: string;
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

/**
 * Lock-screen background ("后台"配置): choose one of the built-in wallpapers or
 * add a custom image URL. Persisted as `amos.settings.lockWallpaper`; LockScreen
 * reads it and, when set, uses it as its backdrop (falls back to the default
 * gradient look otherwise). A "清除" button resets to the default.
 */
export function LockWallpaperCard() {
  const { t } = useI18n();
  const prefs = readPrefs();
  const [url, setUrl] = useState(
    prefs.lockWallpaper && isCustomWallpaper(prefs.lockWallpaper) ? prefs.lockWallpaper : "",
  );
  const [note, setNote] = useState<string | null>(null);
  const active = prefs.lockWallpaper;
  // Live preview of the currently chosen lock background (built-in file or custom src).
  const previewSrc = (() => {
    if (!active) return null;
    if (isCustomWallpaper(active)) return active;
    const f = WALLPAPER_FILES[active];
    return f ? `wallpapers/${f}` : null;
  })();
  const pick = (id: string) => {
    writePref({ lockWallpaper: id });
    setUrl("");
    setNote(null);
  };
  const setCustom = () => {
    const v = url.trim();
    if (v) {
      writePref({ lockWallpaper: v });
      setNote(null);
    }
  };
  const clear = () => {
    writePref({ lockWallpaper: "" });
    setUrl("");
    setNote(null);
  };
  // Cap uploaded files: the image is stored as a data: URL inside the (shared)
  // amos.settings store, whose backing localStorage has a ~5MB quota — a raw
  // multi-MB file would silently overflow it and break persistence.
  const MAX_UPLOAD_BYTES = 2.5 * 1024 * 1024;
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      setNote(t("wp.tooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result : "";
      if (data) {
        writePref({ lockWallpaper: data });
        setUrl("");
        setNote(null);
      }
    };
    reader.readAsDataURL(f);
  };
  return (
    <section className={"p-4 " + GROUP}>
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{t("wp.lockLabel")}</h3>
        {active && (
          <button onClick={clear} className={pillCls(false)}>
            {t("wp.clear")}
          </button>
        )}
      </div>
      {note && <p className="mt-1 text-xs text-danger">{note}</p>}
      {previewSrc && (
        <div className="mt-3 h-24 w-full overflow-hidden rounded-xl bg-black/10 ring-1 ring-black/10 dark:ring-white/10">
          <img
            src={previewSrc}
            alt={t("wp.lockLabel")}
            className="h-full w-full object-cover"
          />
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {WALLPAPER_PRESETS.map((id) => (
          <button key={id} onClick={() => pick(id)} className={pillCls(active === id)}>
            {t(PRESET_LABEL[id])}
          </button>
        ))}
        <label className={"cursor-pointer " + pillCls(false)}>
          {t("wp.upload")}
          <input type="file" accept="image/*" className="hidden" onChange={onFile} />
        </label>
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
    </section>
  );
}
