/**
 * Reactive, framework-free i18n singleton for Svelte 5 apps — implemented as a
 * runes module (`.svelte.ts`) so `locale` is a shared `$state`.
 *
 * Why this exists alongside `./i18n.ts`: `./i18n.ts` holds the pure, one-shot
 * helpers (`translate`, `currentLocale`) that read the locale once and that this
 * module builds on. This module is the REACTIVE variant: components call
 * `t(key)`/`locale()` inside markup and Svelte re-renders them the instant
 * `setLocale()` is called (fine-grained signal tracking works through function
 * calls during render).
 *
 * Cross-window sync: the shell owns locale switching and calls `setLocale()`
 * whenever the UI locale changes, so every mounted Svelte app updates in place
 * — no remount, no state loss. It persists to the same key the shell writes
 * (`amos-ui.locale`).
 */
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";
import type { Locale } from "../i18n/types";
import { isLocale } from "../i18n/types";
import { currentLocale, translate, LOCALE_KEY } from "./i18n";
import { appTitleKey } from "../lib/appMeta";
import { storeTileFor } from "../lib/appLookup";
import type { StoreTile } from "../lib/storeApps";
import { splitWindowLabel } from "../lib/windowRoute";
import { systemStoreSet } from "../lib/backend";
import { amosWarn } from "../lib/debugLog";
import { menuSetLocale } from "../lib/wm";
import { SVELTE_LOCALE_EVENT } from "./locale-events";
import { AMOS_LOCALE_CHANGED_EVENT } from "./ui-events";

export { LOCALE_KEY };

const DICTS: Record<Locale, Record<string, string>> = {
  zh: zh as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
};

/**
 * **Every** locale's dictionary, for reverse lookups — not just the active one.
 *
 * A stored notification names its sender as a display string resolved at push time
 * (`bgText.ts::bgT`), so a row written while the UI was Chinese keeps its Chinese name
 * after a switch to English. `lib/appMeta.ts::appIdForDisplayName` is the consumer, and it
 * must try every locale: resolving against the active one alone would stop finding older
 * rows, and an unresolved row is a notification that can no longer be opened (or a Dock
 * badge that silently reads zero).
 */
export const ALL_LABEL_DICTS: readonly Record<string, string>[] = Object.values(DICTS);

// Shared reactive locale (module-level rune). All Svelte apps share one instance.
let current = $state<Locale>(currentLocale());

/** Reactive read of the active locale — safe to call inside markup/$derived. */
export function locale(): Locale {
  return current;
}

/**
 * Reactive `t()` — re-evaluates when the shared locale changes.
 *
 * Delegates the lookup + `{param}` interpolation to the pure `translate()`
 * helper so there is exactly ONE interpolation implementation for the whole UI
 * (a second private copy here could drift from it).
 */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(DICTS[current], key, params);
}

/** Set + persist the locale (mirrors the shell's persistence behaviour). */
export function setLocale(l: Locale): void {
  const changed = l !== current;
  if (changed) current = l;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem("amos-ui.locale", l);
    if (typeof document !== "undefined") document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
    // Mirror to the Rust shared store (the locale is stored *raw*, like the theme,
    // not JSON-encoded — `currentLocale()` reads the same raw string back).
    void systemStoreSet(LOCALE_KEY, l);
    // REQ-A437: the **native menu bar** is drawn by the host, so it has to be told which
    // language the shell is in — otherwise a Chinese UI keeps an English File / Edit / View
    // (measured on this machine 2026-09-18). The host rebuilds the tree and answers with the
    // locale it applied; a failure is reported, not swallowed: an unlocalized menu bar is
    // exactly the surface nobody would think to look at.
    void menuSetLocale(l).then((applied) => {
      if (applied !== null && applied !== l) {
        amosWarn("shell", "the host drew the menu bar in a different language", {
          asked: l,
          applied,
        });
      }
    });
  } catch {
    /* ignore */
  }
  if (changed) {
    try {
      window.dispatchEvent(new CustomEvent(AMOS_LOCALE_CHANGED_EVENT, { detail: l }));
    } catch {
      /* ignore */
    }
  }
}

/** Guarded setter for callers that only hold a raw string (validates to Locale). */
export function setLocaleSafe(v: string | null | undefined): void {
  if (v != null && isLocale(v)) setLocale(v);
}

/**
 * How a **window** is named on screen — the app's localized name, plus which instance of
 * it the window is (REQ-A473).
 *
 * The identity model made `label ≠ app id` (`files_2` is a window of Files), so every
 * surface that lists *windows* has to resolve the label to an app before it can be
 * localized. Three of them need exactly this (Mission Control's switcher, the Spaces
 * panel's window list, an app window's own title bar) and each one deriving it separately
 * is how they would start disagreeing — so this is the single implementation, in the
 * module that already owns "how the UI says things".
 *
 * `label` is a window label (the host's own identifier, e.g. from `wm_windows`); `app` is
 * the host's answer for which app that window shows, when the caller has it. The label is
 * the fallback — a caller that only holds a label still gets a usable name, and the
 * instance number comes from the label in both cases (the host reports `instance` too,
 * but the label *is* its canonical spelling).
 *
 * `tiles` is the caller's **installed store apps** (`REQ-A1185`) — the second of the two
 * places an app name can live, which `appTitleKey` cannot see. It is a parameter rather than
 * a module-cache read for the same reason `lib/appLookup`'s helpers take it: the read must be
 * reactive, or a window that mounts before the tiles land keeps its raw id forever.
 *
 * Boundaries, stated rather than hidden: an app this build does not know at all (neither a
 * registry row nor an installed tile) is shown as its **id** — not capitalized, not prettified,
 * because a made-up name is worse than the identifier the host actually uses. And a window
 * that names no app at all (the launcher, a container surface) keeps its raw label.
 */
export interface WindowName {
  /** The app the window shows (`""` when it shows none). */
  appId: string;
  /** 1 for the app's first window, 2.. for the ones after; 0 when there is no app. */
  instance: number;
  /** The **app's** own name, no instance marker: `文件` (`""` when there is no app). */
  app: string;
  /** **This window's** name: `文件` / `文件 — 2` / `files_2` (the last for a window with no app). */
  text: string;
}

export function windowName(
  label: string,
  app?: string | null,
  tiles: readonly StoreTile[] = [],
): WindowName {
  const parts = splitWindowLabel(label);
  const appId = app && app !== "" ? app : (parts?.app ?? "");
  const instance = parts?.instance ?? (appId ? 1 : 0);
  // REQ-A1185: an installed store app's name lives in the **store registry**, not the i18n
  // dictionary — asking `appTitleKey` alone answered `null` and fell through to `appId || label`,
  // so every window of an installed app was named by its raw wire id (`store:org.amos.demo`) on
  // its own titlebar, in Mission Control, in App Exposé and in the Spaces panel. The tile list is
  // passed in, not read from the module cache: the read has to be reactive (an app window that
  // mounts before the tiles land would otherwise keep the raw id forever).
  const tile = appId ? storeTileFor(appId, tiles) : undefined;
  const key = appId ? appTitleKey(appId) : null;
  const base = tile ? tile.name : key ? t(key) : (appId || label);
  if (instance > 1) {
    return {
      appId,
      instance,
      app: base,
      text: t("desktop.windowInstance", { name: base, n: String(instance) }),
    };
  }
  return { appId, instance, app: appId ? base : "", text: base };
}


// Shell → Svelte locale bridge: `Shell.svelte` broadcasts the shell locale as a
// window event; apply it here so already-mounted Svelte apps re-key in place.
// (First mount needs no event — the host already persisted the locale to
// localStorage, which `currentLocale()` reads at module load.) The same guarded
// setter the tests exercise is used here, so the "raw string → Locale" validation
// has one implementation.
if (typeof window !== "undefined") {
  window.addEventListener(SVELTE_LOCALE_EVENT, (e) => {
    setLocaleSafe((e as CustomEvent<string | null | undefined>).detail);
  });
}
