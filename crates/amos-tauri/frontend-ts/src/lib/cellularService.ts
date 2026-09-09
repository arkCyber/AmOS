/**
 * cellularService.ts — honest cellular *service state*, derived only from REAL,
 * non-fabricated inputs.
 *
 * This OS deliberately never invents a signal/carrier (see `lib/cellular.ts`):
 * there is no real modem on the host path. So instead of fake bars we model the
 * truth we can actually assert:
 *
 *   • no radio  — this build has no real SIM/modem source (`RadioSignal.present`
 *                 is false today; a future Android telephony signal source would
 *                 flip it to true with a real `signal`).  → "no cellular service".
 *   • data off  — cellular data is switched off (real persisted preference).
 *   • no signal — a radio is present but reports no usable signal yet → honest
 *                 "no signal", never a made-up dBm.
 *   • connected — a real radio reports a real signal. (Only reachable once a real
 *                 modem source is wired; never synthesized here.)
 *
 * Pure + headlessly testable.
 */

import type { CellularPrefs } from "./cellular";

export type CellularService =
  | "no-radio" // 本机无 SIM / 调制解调器（无真源）
  | "off" // 蜂窝数据关闭
  | "no-signal" // 有 radio 但拿不到真实信号
  | "connected"; // 有真源且真有信号（需接线真机）

/** The honest radio/signal seam. Defaults to "no modem" because none exists yet;
 *  wiring a real Android signal source replaces it with a real reading. */
export interface RadioSignal {
  /** Whether a real cellular radio + SIM source is present on this host. */
  present: boolean;
  /** Real 0..4 signal if the source reported one; else null (unknown). */
  signal: number | null;
}

/** The truth on this build: no modem is attached → no cellular service. */
export function defaultRadioSignal(): RadioSignal {
  return { present: false, signal: null };
}

/** Derive the honest service state from the real inputs. Pure. */
export function cellularService(
  prefs: CellularPrefs,
  radio: RadioSignal,
): CellularService {
  if (!radio.present) return "no-radio";
  if (!prefs.data) return "off";
  if (radio.signal === null) return "no-signal";
  return "connected";
}

/**
 * Which i18n key describes a state for a UI value (both locales already carry
 * the key set). Returns a `settings.*` message key to render.
 */
export function cellularStateKey(state: CellularService): string {
  switch (state) {
    case "no-radio":
      return "settings.cellularNone";
    case "off":
      return "settings.cellularDataOff";
    case "no-signal":
      return "settings.cellularNoSignal";
    case "connected":
      return "settings.cellularConnected";
  }
}
