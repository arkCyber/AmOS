/**
 * cellularRadio.ts — reactive seam for a REAL cellular radio source.
 *
 * The store is **three-valued on purpose**, and the third state is the whole point:
 *
 *   • `null`                — **no reading**. We have not asked the host, or asking
 *                             it produced no answer. This is the initial value and
 *                             what `clearCellularRadio` restores.
 *   • `{ present: false }`  — the host **answered**: this device has no modem
 *                             (desktop/tablet `supported:false`, or an ejected SIM).
 *   • `{ present: true }`   — the host answered with a real radio, plus its `1..=4`
 *                             level or `null` ("no usable signal").
 *
 * `null` and `{ present: false }` are **different facts** and folding them into one
 * made the two Settings surfaces print a claim about the user's own device
 * (「未接入蜂窝网络（本机无 SIM / 调制解调器）」) on a question nothing had ever
 * established — while the Notification Center tile, reading the very same value,
 * honestly stayed silent. The sibling precedent sits a few lines above the cellular
 * read in `NotificationCenter.svelte`: `rotationAvailable` is `boolean | null`,
 * `null` gets its own sentence, and its comment states the rule — "folding the two
 * into one boolean made a failed read print 「此宿主无法旋转」 — a claim about the
 * user's own device that nothing had established" (REQ-A1274 ∕ F-SH-548). This seam
 * now carries the same third state (REQ-A1539 ∕ F-SH-780).
 *
 * **The source is wired (2026-09-25, A6):** `lib/cellularHost.ts::installCellularSignal`
 * asks the host's `cellular_signal` command (backed by Android `TelephonyManager`)
 * at Notification Center mount. On a desktop host that command *answers*
 * `supported: false`, which narrows to `{ present: false }` — so a desktop build
 * still shows no bars, now because the device was *asked* rather than because
 * nothing could ask. Tests can drive it directly via `setCellularRadio`.
 */
import { writable } from "svelte/store";
import { type RadioSignal } from "../lib/cellularService";

/** `null` = no reading. See the module doc: it is NOT the same as "no modem". */
export const cellularRadio = writable<RadioSignal | null>(null);

/** Install/replace a real radio+signal reading the host actually answered with. */
export function setCellularRadio(r: RadioSignal): void {
  cellularRadio.set(r);
}

/** Retract to the honest "no reading" state (teardown / reconnect / refused probe). */
export function clearCellularRadio(): void {
  cellularRadio.set(null);
}
