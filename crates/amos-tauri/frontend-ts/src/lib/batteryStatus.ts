/**
 * batteryStatus.ts — real battery view model for the Svelte status bar (and any
 * surface that wants an honest reading).
 *
 * WHY: the legacy status bar drew a *cosmetic* battery that counted down with the
 * wall-clock seconds (`100 - second`). This module replaces that with REAL data,
 * following the repo's honesty rule ("unknown is never fabricated"):
 *
 *   precedence for the one shown reading:
 *     1. the daemon `system_health.battery_level_pct` block (authoritative on an
 *        Android base where amos-monitor samples the actual device battery),
 *     2. otherwise the host OS Battery API (`navigator.getBattery`, which on a
 *        laptop / WebView host reports the REAL machine battery & charging),
 *     3. otherwise level is `null` → the UI renders an honest empty glyph + "—".
 *
 * Everything here is pure / host-agnostic except the guarded `navigator.getBattery`
 * subscription at the bottom, so the logic is unit-testable headlessly.
 */

/** One battery reading. `null` = unknown (never invented). */
export interface BatterySample {
  /** State of charge 0..100. */
  levelPct: number | null;
  /** True while charging; false while draining; null when unknown. */
  charging: boolean | null;
}

/** Empty/unknown reading — the honest starting state. */
export const EMPTY_BATTERY: BatterySample = { levelPct: null, charging: null };

/** iOS-style visual tone of a battery reading (drives glyph colour). */
export type BatteryTone = "unknown" | "ok" | "low" | "critical" | "charging";

/** Level below which a draining battery is "low" (amber on iOS). */
export const LOW_PCT = 20;
/** Level at/below which a draining battery is "critical" (red on iOS). */
export const CRITICAL_PCT = 10;

/** Clamp any (possibly bogus) reading into the valid 0..100 model range. */
export function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

/** The tone to render a battery reading with. Charging is always its own tone
 * (iOS tints the glyph green); while draining, ≤10% is critical and ≤20% low so
 * the user notices before the device cuts out. Unknown → "unknown". */
export function batteryTone(s: BatterySample): BatteryTone {
  if (s.levelPct === null) return "unknown";
  if (s.charging === true) return "charging";
  if (s.levelPct <= CRITICAL_PCT) return "critical";
  if (s.levelPct <= LOW_PCT) return "low";
  return "ok";
}

/** The dictionary key naming a battery read-out: charging is its own sentence
 * (`{pct}` filled in), draining the plain level. */
export type BatteryReadoutKey = "a11y.battery" | "a11y.batteryCharging";

/** What a surface must SAY about a battery reading. */
export interface BatteryReadout {
  key: BatteryReadoutKey;
  /** The `{pct}` parameter, already rounded (`"80%"`). */
  pct: string;
}

/**
 * The ONE spoken read-out for a battery sample, or `null` when the level is
 * unknown (never invent a number).
 *
 * Four surfaces show a battery — the home widget, the desktop top bar, the phone
 * chrome and the lock screen — and each had hand-copied the same `{pct}` sentence
 * into a `title` while naming itself with a *constant* `aria-label`. That loses the
 * reading outright: `aria-label` overrides both the element's own content and
 * `title` when the accessible name is computed, so a screen-reader user heard
 * "Battery level" and never the level. Callers must put this in the ACCESSIBLE NAME
 * (and may mirror it into `title`); the per-surface unknown fallback stays the
 * caller's choice, because the honest name for "no reading" differs ("Battery
 * level" in the chrome, the widget's own title on the home screen).
 */
export function batteryReadout(s: BatterySample): BatteryReadout | null {
  if (s.levelPct === null) return null;
  return {
    key: s.charging === true ? "a11y.batteryCharging" : "a11y.battery",
    pct: `${Math.round(s.levelPct)}%`,
  };
}

/** Normalise a half-open shape from `system_health` / host into a sample. */
export function normalizeSample(raw: {
  levelPct?: unknown;
  charging?: unknown;
}): BatterySample {
  const lvl = typeof raw?.levelPct === "number" ? clampPct(raw.levelPct) : null;
  return {
    levelPct: lvl,
    charging: typeof raw?.charging === "boolean" ? raw.charging : null,
  };
}

/** Structural "maybe battery" — any source that carries optional level/charging. */
export type BatteryLike = { levelPct?: number | null; charging?: boolean | null };

/**
 * Pick the first source that actually carries a usable level (explicit order =
 * authority). Later sources are only a fallback, never a replacement. Pure.
 */
export function firstBattery(
  sources: ReadonlyArray<BatteryLike | null | undefined>,
): BatterySample {
  for (const s of sources) {
    if (s && typeof s.levelPct === "number" && Number.isFinite(s.levelPct)) {
      return normalizeSample(s);
    }
  }
  return EMPTY_BATTERY;
}

/* ---- host Battery API (navigator.getBattery) — REAL OS battery, guarded ---- */

interface HostBatteryManager {
  /** 0..1 fraction of charge. */
  level: number;
  charging: boolean;
  addEventListener(type: "levelchange" | "chargingchange", cb: () => void): void;
  removeEventListener(type: "levelchange" | "chargingchange", cb: () => void): void;
}
interface NavigatorWithBattery {
  getBattery?: () => Promise<HostBatteryManager>;
}

function hostBatteryApi(): Promise<HostBatteryManager> | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as NavigatorWithBattery;
  if (typeof nav?.getBattery !== "function") return null;
  try {
    return nav.getBattery();
  } catch {
    return null;
  }
}

/** A host battery reading source needs only these two fields to be sampled. */
export interface HostBatteryReading {
  level: number;
  charging: boolean;
}

/** Map a BatteryManager (level 0..1) onto a 0..100 BatterySample. A real 0
 * (fully drained) is kept as 0 rather than being confused with "unknown". */
export function sampleHostBattery(
  b: HostBatteryReading | null | undefined,
): BatterySample {
  if (!b) return EMPTY_BATTERY;
  const lvl = b.level;
  const levelPct =
    typeof lvl === "number" && Number.isFinite(lvl) ? clampPct(Math.round(lvl * 100)) : null;
  return { levelPct, charging: typeof b.charging === "boolean" ? b.charging : null };
}

/**
 * Subscribe to the host OS battery. `cb` fires immediately with the current
 * sample and again on every level/charging change. Returns a `stop()` to detach
 * (or `null` when the host has no Battery API — SSR, happy-dom, Safari, …).
 * Guarded: never throws, no listeners when the API is absent.
 *
 * Detach means **detach**: the `BatteryManager` is a page-singleton, so a
 * `stop()` that only muted the callback would leave every mount's two listeners
 * (and the `cb` they close over) attached for the life of the document — the
 * exact leak the `stop()` contract exists to prevent. `stop()` therefore removes
 * both listeners, and a `stop()` that lands **before** the `getBattery()` promise
 * resolves attaches nothing at all rather than subscribing into a dead owner.
 */
export function watchHostBattery(cb: (s: BatterySample) => void): (() => void) | null {
  const p = hostBatteryApi();
  if (!p) return null;
  let stopped = false;
  let attached: { manager: HostBatteryManager; onChange: () => void } | null = null;
  void p
    .then((b) => {
      if (stopped) return; // detached before the API resolved — never subscribe
      const onChange = () => {
        if (!stopped) cb(sampleHostBattery(b));
      };
      b.addEventListener("levelchange", onChange);
      b.addEventListener("chargingchange", onChange);
      attached = { manager: b, onChange };
      onChange(); // initial sample
    })
    .catch(() => {
      /* API present but rejected → honest unknown; never throw into the UI */
    });
  return () => {
    stopped = true;
    if (attached) {
      attached.manager.removeEventListener("levelchange", attached.onChange);
      attached.manager.removeEventListener("chargingchange", attached.onChange);
      attached = null;
    }
  };
}
