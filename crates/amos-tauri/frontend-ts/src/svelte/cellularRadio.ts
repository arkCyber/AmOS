/**
 * cellularRadio.ts — reactive seam for a REAL cellular radio source.
 *
 * The OS has no modem on the host path, so this store defaults to `absent`
 * (`defaultRadioSignal()`): NO cellular UI is shown, which is the honest,
 * non-misleading state (like iOS with no SIM → no bars). The Notification Center
 * only surfaces the cellular module when `radio.present` becomes true — i.e. when
 * a real Android telephony signal source is wired in on-device. Tests can drive
 * it directly via `setCellularRadio`.
 */
import { writable } from "svelte/store";
import { defaultRadioSignal, type RadioSignal } from "../lib/cellularService";

export const cellularRadio = writable<RadioSignal>(defaultRadioSignal());

/** Install/replace the real radio+signal reading (future device wiring, or tests). */
export function setCellularRadio(r: RadioSignal): void {
  cellularRadio.set(r);
}

/** Restore the honest "no modem" default (teardown / reconnect). */
export function clearCellularRadio(): void {
  cellularRadio.set(defaultRadioSignal());
}
