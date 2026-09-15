/**
 * desktopApps.ts — runtime form-factor reader for the Svelte app registry.
 *
 * The host pushes the form factor via `layout-changed` events (`lib/wm.ts`); the
 * shell exposes it via `LayoutSnapshot.form`. The app registry reads it here so a
 * loader resolution can be form-aware (e.g. `phone` is hidden on desktop).
 *
 * One source of truth: this module imports the same reactive store the shell
 * uses, so the registry answer matches the shell's surface within the same
 * `tick`. The store is best-effort: if no host is attached, `desktopFormActive()`
 * returns `false` (the conservative answer that keeps phone apps available —
 * identical to the host-failure rule `lib/formLayout` follows for the home grid).
 */
import { writable } from "svelte/store";

/** Form factor values, mirroring `lib/wm.ts` (`FormFactor`). */
export type FormFactor = "phone" | "tablet" | "desktop" | "robot";

// Internal on purpose: `setFormFactor` is the only writer (Shell.svelte) and
// `desktopFormActive()` the only reader (the app registry). Exporting the store
// itself would be a third way to answer the same question (unwired-scan).
const _formStore = writable<FormFactor | null>(null);

/** Test hook + `Shell.svelte` callsite: write the latest form factor. */
export function setFormFactor(form: FormFactor | null): void {
  _formStore.set(form);
}

/** True when the current form factor is `desktop` (the only one with no SIM). */
export function desktopFormActive(): boolean {
  let current: FormFactor | null = null;
  _formStore.subscribe((v) => (current = v))();
  return current === "desktop";
}
