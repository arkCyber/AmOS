/**
 * formAuthority.svelte.ts — the **one** runtime device-class reader.
 *
 * The host resolves the device class (phone / tablet / desktop / robot) at startup
 * and re-reports it on every `layout-changed`; the shell turns that into this value.
 * Everything that needs to know "what device am I on" reads it *here* — the app
 * registry (`desktopFormActive`, which hides a SIM-only dialer on a Mac), the
 * form-aware app screens (`currentFormFactor()`: Photos, PWA hub, Settings), and any
 * future consumer — so there is exactly one answer to that question.
 *
 * It is a **rune** (module-level `$state`) rather than a manual `writable` subscribe
 * snapshot for one concrete reason: a component that derives from it
 * (`const cols = $derived(photosCols(currentFormFactor() ?? "phone"))`) must actually
 * re-derive when the host pushes a new class. A snapshot read inside `$derived` does
 * not register a reactive dependency — it computes once and goes stale, which is the
 * bug this module's rune form fixes.
 *
 * Two writers, deliberately:
 *   * `setFormFactor` — tests / previews that want to force a class, and the shell's
 *     boot path (`Shell.svelte`) which writes the host's answer;
 *   * `shellState.setLayoutSnapshot` — the production path re-asserts the class from
 *     the very snapshot it just stored, so the class can never disagree with the
 *     measured screen it came with.
 *
 * A `null` value is the honest "no host has answered yet" state: every reader must
 * treat it as the conservative phone plan (mirroring `lib/formLayout`'s "an
 * unmeasured screen gets the most conservative layout" rule).
 */
import type { FormFactor } from "./wm";

let _form = $state<FormFactor | null>(null);

/** Force the class (tests / previews / the shell's boot write). */
export function setFormFactor(form: FormFactor | null): void {
  _form = form;
}

/** The current class as the host reported it, or `null` until the host answers. */
export function currentFormFactor(): FormFactor | null {
  return _form;
}

/** True when the current class is `desktop` (the only one with no SIM). */
export function desktopFormActive(): boolean {
  return _form === "desktop";
}
