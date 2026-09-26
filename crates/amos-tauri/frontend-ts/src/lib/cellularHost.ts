/**
 * cellularHost.ts — the **producer** for the cellular bars seam.
 *
 * `svelte/cellularRadio.ts` owns the reactive store the Notification Center reads,
 * and until now nothing in production ever wrote it: `setCellularRadio` had **no
 * caller**, so the tile's `{#if radio.present}` could never be true even on a real
 * phone. The host has the answer now (`cellular_signal`, backed by
 * `TelephonyManager` on device), so this module is the one place that turns that
 * reply into the store's `RadioSignal` shape.
 *
 * The two halves are deliberately separate:
 *
 *   • [`radioSignalFrom`] is **pure** — it narrows the wire reply (a system
 *     boundary: JSON from Rust) into `RadioSignal | null`, so the mapping is
 *     testable without a host and the component keeps no shape knowledge.
 *   • [`installCellularSignal`] does the one effectful thing: read once and hand
 *     the result to the store. A `null` reply (no host, a failed command) leaves
 *     the store **untouched** — the honest default — rather than writing a
 *     "no modem" verdict the host never gave.
 *
 * That last clause is a rule about *this* function, and until REQ-A1539 it held
 * only here: the store it left alone was a two-state `RadioSignal`, whose
 * `{ present: false }` **is** the "no modem" verdict. So the two Settings pages
 * that *print* the store (rather than hiding on it, the way the tile does) said
 * 「未接入蜂窝网络（本机无 SIM / 调制解调器）」 about a question nobody had asked.
 * The store now carries a third state — `null` = "no reading" (see
 * `svelte/cellularRadio.ts`) — so "left untouched" and "answered: no modem" are
 * distinct values *everywhere* the store is read, not just in this file.
 */

import { cellularSignal } from "./backend";
import { defaultRadioSignal, type RadioSignal } from "./cellularService";
import { setCellularRadio } from "../svelte/cellularRadio";

/**
 * Narrow a `cellular_signal` reply into the store's [`RadioSignal`].
 *
 * Returns `null` when the reply carries no usable answer (not an object, or
 * missing the `present` boolean) — i.e. "**we did not learn** whether there is a
 * modem", which is *not* the same as the `{ present: false }` this returns for a
 * host that answered "no modem". The caller installs a reading only when this
 * gives one, so the two facts stay apart end to end (REQ-A1539).
 *
 * The `supported` flag folds into `present` here rather than travelling further:
 * "this device is not a phone" and "this phone has no SIM" are the same thing to
 * the UI — no radio to draw — and the host's own fold (`cellular_signal_from`)
 * already makes `!supported` imply `!present`.
 *
 * `signal` outside `1..=4` becomes `null` ("no usable reading"). The host already
 * refuses those, so this is the boundary's own copy of the rule, not a second
 * policy: a store holding `7` would draw seven bars.
 */
export function radioSignalFrom(reply: unknown): RadioSignal | null {
  if (typeof reply !== "object" || reply === null) return null;
  const r = reply as Record<string, unknown>;
  if (typeof r.present !== "boolean") return null;
  const present =
    r.present && (typeof r.supported === "boolean" ? r.supported : true);
  if (!present) return defaultRadioSignal();
  const raw = r.signal;
  const signal =
    typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 4
      ? raw
      : null;
  return { present: true, signal };
}

/**
 * Ask the host once and install the result into the reactive store.
 *
 * Returns whether a reading was installed: `false` only when the host gave **no
 * usable answer** (`radioSignalFrom` returned `null`), in which case the store is
 * left exactly as it was — `null` ("no reading") if nothing had been installed,
 * or the earlier answer if one had. `true` covers both "a radio is present" and
 * "the host answered that there is no modem": those are two *answered* readings
 * and the store tells them apart; "we could not ask" stays `null`.
 */
export async function installCellularSignal(): Promise<boolean> {
  const reply = await cellularSignal();
  const reading = radioSignalFrom(reply);
  if (reading === null) return false;
  setCellularRadio(reading);
  return true;
}
