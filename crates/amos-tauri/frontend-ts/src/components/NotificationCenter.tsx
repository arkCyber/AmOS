import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { useStoreValue } from "../lib/useStoreValue";
import {
  bridged,
  flashlightSet,
  flashlightStatus,
  radioSet,
  radioStatus,
  type FlashlightPayload,
  type RadioPayload,
} from "../lib/backend";
import { useFocusTrap } from "../lib/useFocusTrap";
import {
  FLASHLIGHT_KEY,
  NOTIF_KEY,
  SETTINGS_KEY,
  dndActive,
  flipFlashlight,
  flipLocation,
  flipQuick,
  flipRadio,
  locationEnabled,
  normalizeFlashlight,
  normalizeNotifs,
  normalizeQuick,
  removeNotif,
  seedNotifs,
  type FlashlightStore,
  type Notif,
  type QuickKey,
  type QuickSettings,
  type RadioKey,
} from "../lib/settings";

const QUICK: { key: QuickKey; label: "q.wifi" | "q.bluetooth" | "q.airplane" | "q.dark" | "q.dnd" | "q.location"; icon: string }[] = [
  { key: "wifi", label: "q.wifi", icon: "📶" },
  { key: "bluetooth", label: "q.bluetooth", icon: "🅱" },
  { key: "airplane", label: "q.airplane", icon: "✈️" },
  { key: "darkmode", label: "q.dark", icon: "🌙" },
  { key: "dnd", label: "q.dnd", icon: "🌒" },
  { key: "location", label: "q.location", icon: "📍" },
];

export default function NotificationCenter({
  open,
  onClose,
  onSearch,
  onRecents,
  onEdit,
  onLock,
}: {
  open: boolean;
  onClose: () => void;
  /** Optional "control-center" actions (formerly the home top bar): reachable via
   *  this pull-down shade instead of a cluttered bar on the home page. */
  onSearch?: () => void;
  onRecents?: () => void;
  onEdit?: () => void;
  onLock?: () => void;
}) {
  const { t } = useI18n();
  // The "dark mode" quick tile drives the real theme (not just a cosmetic bit).
  const { dark, toggle: themeToggle } = useTheme();
  const [settings, setSettings] = useState<QuickSettings>(() =>
    normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {})),
  );
  const [notifs, setNotifs] = useState<Notif[]>(() => {
    const l = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
    if (l.length) return l;
    const s = seedNotifs(Date.now());
    writeStoreValue(NOTIF_KEY, s);
    return s;
  });
  // Torch is read reactively from the shared store so OS-driven changes pushed
  // via `store-updated` (from Rust: the status bar AND an open tile) reflect
  // live, without open-panel polling.
  const flash = normalizeFlashlight(useStoreValue<unknown>(FLASHLIGHT_KEY, {}));
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, rootRef, onClose);
  const quiet = dndActive(settings);

  // Merge an authoritative backend snapshot into the local quick-settings,
  // preserving the non-radio toggles (darkmode/dnd/location).
  const mergeRadio = (s: QuickSettings, r: RadioPayload): QuickSettings => ({
    ...s,
    wifi: r.wifi,
    bluetooth: r.bluetooth,
    airplane: r.airplane,
  });

  // Merge an authoritative torch snapshot into the local store mirror.
  const mergeFlash = (p: FlashlightPayload): FlashlightStore => ({
    on: p.on,
    torch_present: p.torch_present,
  });

  // When the panel opens inside Tauri, sync radio + torch tiles from the
  // authoritative backend snapshot (e.g. airplane mode or the torch was toggled
  // from another window). We only touch React state here — durability lives in
  // the shared store.
  useEffect(() => {
    if (!open || !bridged()) return;
    let cancelled = false;
    radioStatus().then((snap) => {
      if (!snap || cancelled) return;
      setSettings((prev) => mergeRadio(prev, snap));
    });
    flashlightStatus().then((snap) => {
      if (!snap || cancelled) return;
      // Mirror the authoritative snapshot into the shared store; the reactive
      // read (flash) adopts it and cross-window surfaces stay consistent.
      writeStoreValue(FLASHLIGHT_KEY, mergeFlash(snap));
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const toggle = async (key: QuickKey) => {
    if (key === "darkmode") {
      // Flip the *actual* theme and keep the quick-setting mirror in sync.
      const nextDark = !dark;
      const next = { ...settings, darkmode: nextDark };
      setSettings(next);
      writeStoreValue(SETTINGS_KEY, next);
      themeToggle();
      return;
    }
    if (key === "wifi" || key === "bluetooth" || key === "airplane") {
      await toggleRadio(key);
      return;
    }
    if (key === "location") {
      // System location-services master: defaults ON; tapping flips it OFF/ON.
      const next = flipLocation(settings);
      setSettings(next);
      writeStoreValue(SETTINGS_KEY, next);
      return;
    }
    const next = flipQuick(settings, key);
    setSettings(next);
    writeStoreValue(SETTINGS_KEY, next);
  };

  // Radio toggles go through the real `radio_*` backend when it is reachable
  // (authoritative snapshot incl. airplane cascade); outside Tauri we fall back
  // to the same policy locally so the UI still behaves identically.
  const toggleRadio = async (key: RadioKey) => {
    // wifi / bluetooth are disabled while airplane mode is on — mirror the
    // backend guard, so a gated tap is a clean no-op rather than an RPC error.
    if (key !== "airplane" && settings.airplane) return;
    const on = !!settings[key];
    if (bridged()) {
      const snap = await radioSet(key, !on);
      if (snap) {
        const merged = mergeRadio(settings, snap);
        setSettings(merged);
        writeStoreValue(SETTINGS_KEY, merged);
        return;
      }
      // Rejected/unavailable (e.g. daemon bridge down): don't keep stale tiles —
      // pull the authoritative state instead.
      const live = await radioStatus();
      if (live) setSettings((prev) => mergeRadio(prev, live));
      return;
    }
    const next = flipRadio(settings, key);
    setSettings(next);
    writeStoreValue(SETTINGS_KEY, next);
  };
  // Torch toggles go through the real `flashlight_*` backend when it is
  // reachable (authoritative snapshot); outside Tauri we fall back to the same
  // local flip so the UI still behaves identically. Durability lives in the
  // dedicated `amos.flashlight` store.
  const toggleFlash = async () => {
    const nextOn = !flash.on;
    if (bridged()) {
      const snap = await flashlightSet(nextOn);
      if (snap) {
        // Write the authoritative snapshot into the shared store; the reactive
        // read (flash) adopts it and cross-window surfaces stay in sync.
        writeStoreValue(FLASHLIGHT_KEY, mergeFlash(snap));
        return;
      }
      // Rejected/unavailable (e.g. no torch hardware): don't keep a stale tile —
      // pull the authoritative state instead.
      const live = await flashlightStatus();
      if (live) writeStoreValue(FLASHLIGHT_KEY, mergeFlash(live));
      return;
    }
    const next = flipFlashlight(flash);
    writeStoreValue(FLASHLIGHT_KEY, next);
  };
  const clear = () => {
    setNotifs([]);
    writeStoreValue(NOTIF_KEY, []);
  };
  const dismiss = (id: string) => {
    const next = removeNotif(notifs, id);
    setNotifs(next);
    writeStoreValue(NOTIF_KEY, next);
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("nc.title")}
      className="drop-in absolute inset-0 z-40 flex flex-col bg-white/45 p-4 backdrop-blur-2xl backdrop-saturate-150 dark:bg-neutral-950/60"
    >
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xl font-semibold tracking-tight">{t("nc.title")}</h2>
        <button
          onClick={onClose}
          className="rounded-full bg-neutral-200/80 px-4 py-1.5 text-sm font-medium text-accent transition active:scale-95 dark:bg-white/10"
        >
          {t("common.done")}
        </button>
      </div>

      {/* Control-center system actions (moved off the home top bar): each closes
          this shade and opens the target surface. */}
      {(() => {
        const acts: { icon: string; label: string; fn?: () => void }[] = [
          { icon: "🔍", label: "search", fn: onSearch },
          { icon: "⇤", label: "recents", fn: onRecents },
          { icon: "✎", label: "edit home", fn: onEdit },
          { icon: "🔒", label: "lock", fn: onLock },
        ].filter((a) => a.fn);
        if (!acts.length) return null;
        return (
          <div className="mt-2 flex items-center justify-end gap-2">
            {acts.map((a) => (
              <button
                key={a.label}
                aria-label={a.label}
                title={a.label}
                onClick={() => {
                  a.fn!();
                  onClose();
                }}
                className="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"
              >
                {a.icon}
              </button>
            ))}
          </div>
        );
      })()}

      {/* Torch / flashlight — illumination control (ephemeral hardware state).
          A dedicated full-width tile above the preference quick-settings. */}
      <button
        onClick={toggleFlash}
        aria-pressed={flash.on}
        disabled={!flash.torch_present}
        className={
          "mt-3 flex items-center justify-between rounded-3xl px-4 py-3 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-40 " +
          (flash.on
            ? "bg-amber-400 text-neutral-900 shadow-[0_6px_16px_rgba(245,158,11,0.45)]"
            : "bg-white/55 text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10")
        }
      >
        <span className="flex items-center gap-2.5">
          <span className="text-xl leading-none">{flash.on ? "🔦" : "🔆"}</span>
          {t("q.flashlight")}
        </span>
        {!flash.torch_present ? (
          <span className="text-xs font-medium opacity-50">{t("nc.torchNone")}</span>
        ) : (
          <span className={"text-xs font-medium " + (flash.on ? "opacity-80" : "opacity-50")}>
            {flash.on ? t("nc.torchOn") : t("nc.torchOff")}
          </span>
        )}
      </button>

      {/* Quick settings — iOS Control-Center style translucent tiles */}
      <div className="mt-4 grid grid-cols-3 gap-2.5">
        {QUICK.map((q) => {
          const on =
            q.key === "darkmode"
              ? dark
              : q.key === "location"
                ? locationEnabled(settings)
                : !!settings[q.key];
          return (
            <button
              key={q.key}
              onClick={() => toggle(q.key)}
              aria-pressed={on}
              className={
                "flex flex-col items-center justify-center gap-1.5 rounded-3xl py-4 text-[11px] font-medium backdrop-blur transition active:scale-95 " +
                (on
                  ? "bg-accent text-white shadow-[0_6px_16px_rgba(10,132,255,0.35)]"
                  : "bg-white/55 text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10")
              }
            >
              <span className="text-xl leading-none">{q.icon}</span>
              {t(q.label)}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase tracking-widest opacity-50">
          {quiet ? (
            <span className="normal-case tracking-normal text-accent">
              🌒 {t("nc.dnd")}
            </span>
          ) : (
            `${notifs.length} ·`
          )}
        </span>
        <button onClick={clear} className="text-xs font-medium text-accent hover:underline">
          {t("nc.clear")}
        </button>
      </div>

      <div className="mt-2 flex-1 space-y-2.5 overflow-auto pr-0.5">
        {notifs.length === 0 ? (
          <p className="py-12 text-center text-sm opacity-50">{t("nc.empty")}</p>
        ) : (
          notifs.map((n) => (
            <div
              key={n.id}
              className={
                "rounded-3xl p-3.5 shadow-sm ring-1 ring-black/5 dark:ring-white/10 " +
                (quiet
                  ? "bg-white/30 opacity-60 saturate-50 dark:bg-white/5"
                  : "bg-white/60 dark:bg-white/10")
              }
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold">
                  {n.icon} {n.app ?? n.title}
                </span>
                <button
                  onClick={() => dismiss(n.id)}
                  aria-label="dismiss"
                  className="grid h-6 w-6 place-items-center rounded-full opacity-60 transition hover:opacity-100"
                >
                  ✕
                </button>
              </div>
              {n.title && <div className="mt-1 text-sm font-medium">{n.title}</div>}
              {n.body && <div className="text-xs opacity-70">{n.body}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
