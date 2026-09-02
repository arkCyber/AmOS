import { useEffect, useState, type FC } from "react";
import FilesApp from "./components/FilesApp";
import AndroidApp from "./components/AndroidApp";
import { MessagesApp, PhoneApp, MusicApp } from "./components/CommsApps";
import MapsApp from "./components/MapsApp";
import CameraApp from "./components/CameraApp";
import { AiApp, InterpApp } from "./components/BackendApps";
import type { MessageKey } from "./i18n/locales/zh";
import { useI18n } from "./i18n";
import { useTheme, type ThemeMode } from "./theme";
import Segmented from "./components/Segmented";
import { WallpaperCard } from "./components/Wallpaper";
import LockSettings from "./components/LockSettings";
import type { Locale } from "./i18n/types";
import { calcDisplay, calcInit, calcPress, ERR } from "./lib/calculator";
import { readStoreValue, writeStoreValue } from "./lib/amosStore";
import { NOTES_KEY, prependNote, removeNote, fmtTime, normalizeNotes, type Note } from "./lib/notes";
import { forecast, dayLabel } from "./lib/weather";
import {
  PHOTOS_KEY,
  seedPhotos,
  newPhoto,
  removePhoto,
  type Photo,
} from "./lib/photos";

export interface AppMeta {
  id: string;
  /** i18n key for the app's display name (also used as its title bar). */
  titleKey: MessageKey;
  icon: string;
}

/** The set of apps currently ported to React/TS. Grows as each app migrates. */
export const APPS: AppMeta[] = [
  { id: "clock", titleKey: "app.clock", icon: "🕐" },
  { id: "settings", titleKey: "app.settings", icon: "⚙️" },
  { id: "calculator", titleKey: "app.calculator", icon: "🧮" },
  { id: "weather", titleKey: "app.weather", icon: "🌤️" },
  { id: "notes", titleKey: "app.notes", icon: "📝" },
  { id: "photos", titleKey: "app.photos", icon: "🖼️" },
  { id: "files", titleKey: "app.files", icon: "📁" },
  { id: "android", titleKey: "app.android", icon: "🤖" },
  { id: "messages", titleKey: "app.messages", icon: "💬" },
  { id: "phone", titleKey: "app.phone", icon: "📞" },
  { id: "music", titleKey: "app.music", icon: "🎵" },
  { id: "maps", titleKey: "app.maps", icon: "🗺️" },
  { id: "camera", titleKey: "app.camera", icon: "📷" },
  { id: "ai", titleKey: "app.ai", icon: "🤖" },
  { id: "interpreter", titleKey: "app.interpreter", icon: "🌐" },
];

export function appTitleKey(id: string): MessageKey | null {
  return APPS.find((a) => a.id === id)?.titleKey ?? null;
}

/** Single source of truth for an app's tile icon (emoji). */
export function appIcon(id: string): string {
  return APPS.find((a) => a.id === id)?.icon ?? "🧩";
}

/* ---- Clock (world clock + live now) ---- */
const Clock: FC = () => {
  const { t } = useI18n();
  const fmt = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const fmtDate = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="p-6 text-center">
      <div className="text-5xl font-thin tabular-nums">{fmt(now)}</div>
      <div className="mt-1 text-sm opacity-60">{fmtDate(now)}</div>
      <div className="mt-4 text-xs uppercase tracking-wide opacity-50">{t("clock.now")}</div>
    </div>
  );
};

/* ---- Settings: first-class light/dark + language ---- */
const Settings: FC = () => {
  const { t, locale, setLocale } = useI18n();
  const { mode, dark, setMode } = useTheme();

  const themeOpts: { value: ThemeMode; label: string }[] = [
    { value: "light", label: t("theme.light") },
    { value: "dark", label: t("theme.dark") },
    { value: "auto", label: t("theme.auto") },
  ];
  const langOpts: { value: Locale; label: string }[] = [
    { value: "zh", label: "中文" },
    { value: "en", label: "English" },
  ];
  return (
    <div className="space-y-4 p-4">
      <section className="flex items-center justify-between rounded-2xl bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
        <span className="text-sm">{t("settings.appearance")}</span>
        <Segmented value={mode} options={themeOpts} onChange={setMode} ariaLabel="appearance" />
      </section>
      <section className="flex items-center justify-between rounded-2xl bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
        <span className="text-sm">{t("settings.language")}</span>
        <Segmented value={locale} options={langOpts} onChange={setLocale} ariaLabel="language" />
      </section>
      <WallpaperCard />
      <LockSettings />
      <p className="px-1 text-xs opacity-50">mode={mode} · dark={String(dark)} · locale={locale}</p>
    </div>
  );
};

/* ---- Calculator (pure logic in lib/calculator.ts, UI here) ---- */
const Calculator: FC = () => {
  const { t } = useI18n();
  const [st, setSt] = useState(() => calcInit());
  const press = (k: string) => setSt((s) => calcPress(s, k));
  const shown = calcDisplay(st).split(ERR).join(t("calc.error"));
  const ROWS: string[][] = [
    ["C", "⌫", "%", "÷"],
    ["7", "8", "9", "×"],
    ["4", "5", "6", "−"],
    ["1", "2", "3", "+"],
    ["0", ".", "=", ""],
  ];
  const isOp = (k: string) => /[÷×−+%]/.test(k) || k === "=";
  return (
    <div className="flex h-full flex-col p-3">
      <div className="px-3 pb-3 text-right text-4xl font-thin tabular-nums">{shown}</div>
      <div className="grid flex-1 grid-cols-4 gap-2">
        {ROWS.flat()
          .filter(Boolean)
          .map((k) => (
            <button
              key={k}
              onClick={() => press(k)}
              aria-label={k}
              className={
                "rounded-full text-2xl transition active:scale-90 " +
                (isOp(k)
                  ? "bg-orange-500 text-white"
                  : k === "C" || k === "⌫"
                    ? "bg-neutral-400 text-black dark:bg-neutral-500"
                    : "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-white")
              }
            >
              {k}
            </button>
          ))}
      </div>
    </div>
  );
};

/* ---- Weather (localized 5-day forecast; data in lib/weather.ts) ---- */
const Weather: FC = () => {
  const { t, locale } = useI18n();
  const base = new Date();
  const days = forecast();
  return (
    <div className="p-4">
      <div className="py-4 text-center">
        <div className="text-6xl">{days[0].icon}</div>
        <div className="text-5xl font-thin">{days[0].temp}°</div>
        <div className="text-sm opacity-60">{days[0].range}</div>
      </div>
      <div className="space-y-2">
        {days.map((d) => {
          const label = d.daysFromNow === 0 ? t("weather.today") : dayLabel(locale, base, d.daysFromNow);
          return (
            <div key={d.daysFromNow} className="flex items-center justify-between rounded-2xl bg-neutral-200/60 px-3 py-2 dark:bg-neutral-800/60">
              <span className="text-sm">{label}</span>
              <span className="text-2xl">{d.icon}</span>
              <span className="w-24 text-right text-sm font-semibold tabular-nums">{d.range}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ---- Notes (persisted via the shared amos.notes store) ---- */
const Notes: FC = () => {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [notes, setNotes] = useState<Note[]>(() =>
    normalizeNotes(readStoreValue<unknown>(NOTES_KEY, [])),
  );
  const persist = (list: Note[]) => {
    writeStoreValue(NOTES_KEY, list);
    setNotes(list);
  };
  const add = () => {
    const v = text.trim();
    if (!v) return;
    persist(prependNote(notes, v, Date.now()));
    setText("");
  };
  return (
    <div className="p-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={t("note.placeholder")}
        className="mb-2 w-full resize-none rounded-2xl bg-neutral-200/70 p-3 text-sm outline-none dark:bg-neutral-800/70"
      />
      <button onClick={add} className="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">
        {t("note.add")}
      </button>
      <div className="mt-4 space-y-2">
        {notes.length === 0 ? (
          <p className="py-6 text-center text-sm opacity-60">{t("note.empty")}</p>
        ) : (
          notes.map((n) => (
            <div key={n.id} className="rounded-2xl bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
              <p className="whitespace-pre-wrap text-sm">{n.text}</p>
              <div className="mt-2 flex items-center justify-between text-[11px] opacity-60">
                <span>{fmtTime(n.ts)}</span>
                <button onClick={() => persist(removeNote(notes, n.id))} className="text-danger hover:underline">
                  {t("note.delete")}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/* ---- Photos (grid album persisted via amos.photos + simple viewer) ---- */
const Photos: FC = () => {
  const { t } = useI18n();
  const [list, setList] = useState<Photo[]>(() => {
    const existing = readStoreValue<Photo[]>(PHOTOS_KEY, []);
    if (existing.length) return existing;
    const seed = seedPhotos(8, Date.now());
    writeStoreValue(PHOTOS_KEY, seed);
    return seed;
  });
  const [sel, setSel] = useState<Photo | null>(null);
  const persist = (l: Photo[]) => {
    writeStoreValue(PHOTOS_KEY, l);
    setList(l);
  };
  const add = () => persist([newPhoto(`p${Date.now()}`, Date.now()), ...list]);

  const grad = (p: Photo): string | undefined =>
    p.a && p.b ? `linear-gradient(135deg, ${p.a}, ${p.b})` : undefined;

  if (sel) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <div
          className="grid h-40 w-40 place-items-center overflow-hidden rounded-3xl text-7xl"
          style={{ background: grad(sel) ?? "#14161d" }}
        >
          {sel.data ? (
            <img src={sel.data} alt="" className="h-full w-full object-cover" />
          ) : (
            (sel.emoji ?? "")
          )}
        </div>
        <p className="text-xs opacity-60">{fmtTime(sel.ts)}</p>
        <div className="flex gap-3">
          <button onClick={() => setSel(null)} className="rounded-full bg-neutral-300 px-4 py-1.5 text-sm dark:bg-neutral-700">
            {t("photo.close")}
          </button>
          <button
            onClick={() => {
              persist(removePhoto(list, sel.id));
              setSel(null);
            }}
            className="rounded-full bg-danger px-4 py-1.5 text-sm text-white"
          >
            {t("photo.delete")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2">
      <button onClick={add} className="mx-2 mb-2 rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">
        {t("photo.add")}
      </button>
      {list.length === 0 ? (
        <p className="py-10 text-center text-sm opacity-60">{t("photo.empty")}</p>
      ) : (
        <div className="grid grid-cols-3 gap-1">
          {list.map((p) => (
            <button
              key={p.id}
              onClick={() => setSel(p)}
              aria-label={p.emoji ?? p.id}
              className="relative grid aspect-square place-items-center overflow-hidden text-3xl"
              style={{ background: grad(p) ?? "#1c1c1e" }}
            >
              {p.data ? (
                <img src={p.data} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                (p.emoji ?? "")
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** Map of ported app id → React component. Unported ids fall back to a stub. */
const COMPONENTS: Record<string, FC> = {
  clock: Clock,
  settings: Settings,
  calculator: Calculator,
  weather: Weather,
  notes: Notes,
  photos: Photos,
  files: FilesApp,
  android: AndroidApp,
  messages: MessagesApp,
  phone: PhoneApp,
  music: MusicApp,
  maps: MapsApp,
  camera: CameraApp,
  ai: AiApp,
  interpreter: InterpApp,
};

/** Get the component for an app id, or a "not ported yet" placeholder. */
export function AppComponent({ id }: { id: string }): ReturnType<FC> {
  const Comp = COMPONENTS[id] ?? NotFound;
  return <Comp />;
}

const NotFound: FC = () => {
  const { t } = useI18n();
  return <div className="p-8 text-center text-sm opacity-60">{t("app.notFound")}</div>;
};
