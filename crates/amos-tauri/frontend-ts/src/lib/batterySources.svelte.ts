/**
 * batterySources.svelte.ts — the ONE place that subscribes to live battery data.
 *
 * WHY a shared rune module: two shell surfaces show a battery — the phone chrome's
 * `StatusBar.svelte` and the desktop top bar's `modules/BatteryWidget.svelte` — and
 * they must agree on the reading. Keeping the subscription here means the desktop
 * bar cannot drift back into a placeholder (it did: it hardcoded `{ levelPct: null }`
 * and showed "—" forever while the real reading was already one call away), and a
 * future fix lands once instead of in whichever copy someone happened to find.
 *
 * Precedence for the one shown reading (same rule the phone bar has always used):
 *   1. the daemon `system_health.battery_level_pct` (authoritative on an Android
 *      base, where amos-monitor samples the actual device battery),
 *   2. otherwise the desktop host's own OS battery via the Tauri
 *      `system_host_battery` command (macOS `pmset`, Linux sysfs),
 *   3. otherwise the browser Battery API (`navigator.getBattery`, event-driven),
 *   4. otherwise `null` → the caller renders an honest "—". Never fabricated.
 *
 * Each caller gets its own instance (each polls its own host); this module holds no
 * global state, so nothing couples the two surfaces beyond the shared logic.
 *
 * REQ-A519 / FMEA F-SH-056: before extraction the desktop top bar hardcoded an unknown
 * sample and showed "—" forever, while the real reading was already one command away.
 */
import {
  EMPTY_BATTERY,
  batteryTone,
  firstBattery,
  watchHostBattery,
  type BatterySample,
  type BatteryTone,
} from "./batteryStatus";
import { bridged } from "./backend";
import { hostBattery, systemHealth } from "./system";
import type { HostBatteryStatus, SystemStatus } from "./system";

/** How often the daemon/host reading is re-polled (the browser API is event-driven). */
export const BATTERY_POLL_MS = 5000;

/**
 * Map the daemon's `system_health` battery block onto a sample (wire → view).
 *
 * Extracted and exported so this mapping is **testable without a bridge**. The daemon
 * speaks `battery_level_pct` / `battery_charging` while a sample is `levelPct` /
 * `charging`: both are plain fields, so a rename or a unit change on either side is
 * invisible to every type checker across the IPC boundary — a pure function pins it,
 * and pins it where `bun test` can run it (a rune initialiser cannot).
 */
export function sampleFromSystemHealth(
  raw: Pick<SystemStatus, "battery_level_pct" | "battery_charging">,
): BatterySample {
  return { levelPct: raw.battery_level_pct, charging: raw.battery_charging };
}

/** Map the host OS battery reading (`system_host_battery`) onto a sample. */
export function sampleFromHostBattery(host: HostBatteryStatus): BatterySample {
  return { levelPct: host.level_pct, charging: host.charging };
}

export interface BatterySources {
  /** The resolved reading: daemon → host OS → browser API → unknown. */
  readonly batt: BatterySample;
  /** The tone to render it with (charging green, low amber, critical red, unknown). */
  readonly tone: BatteryTone;
}

/**
 * Subscribe to live battery data. Call once, during component initialisation (it
 * uses runes). The returned getters stay reactive for the lifetime of the owner.
 *
 * `pollMs` defaults to [`BATTERY_POLL_MS`]. A surface that can sit still for a long
 * time (the lock screen, which can stay up for hours) passes its own slower cadence
 * rather than keeping a second, drifted copy of this subscription — one copy is the
 * whole point of this module (REQ-A1926).
 */
export function createBatterySources(pollMs: number = BATTERY_POLL_MS): BatterySources {
  // Kept separate so the shown reading can be resolved with explicit precedence.
  let systemBatt = $state<BatterySample>(EMPTY_BATTERY);
  let tauriBatt = $state<BatterySample>(EMPTY_BATTERY);
  let hostBatt = $state<BatterySample>(EMPTY_BATTERY);

  // The browser Battery API needs no timer (it is event-driven); the daemon poll
  // only runs when actually bridged, so an unbridged preview pays nothing.
  $effect(() => {
    const stopHost = watchHostBattery((s) => {
      hostBatt = s;
    });
    const poll = async () => {
      if (!bridged()) return;
      const raw = await systemHealth();
      if (raw) {
        systemBatt = sampleFromSystemHealth(raw);
      }
      // The host OS battery (desktop dev / any host the daemon can't see).
      const host = await hostBattery();
      if (host) {
        tauriBatt = sampleFromHostBattery(host);
      }
    };
    void poll();
    const id = window.setInterval(poll, pollMs);
    return () => {
      if (stopHost) stopHost();
      window.clearInterval(id);
    };
  });

  const batt = $derived(firstBattery([systemBatt, tauriBatt, hostBatt]));
  const tone = $derived(batteryTone(batt));

  return {
    get batt() {
      return batt;
    },
    get tone() {
      return tone;
    },
  };
}
