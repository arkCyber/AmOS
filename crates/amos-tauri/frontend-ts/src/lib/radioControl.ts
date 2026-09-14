/**
 * Platform-managed radio switches (REQ-A202) — the pure half.
 *
 * On Android the app-facing switch for Wi-Fi was removed in API 29 and for Bluetooth in
 * API 33, and the authoritative airplane bit needs `WRITE_SECURE_SETTINGS` on every
 * version. Until this module existed the UI did not know any of that: `radio_set` failed,
 * `invoke` turned the failure into `null`, and a quick-settings tile tap simply did
 * nothing — the exact "the interface says nothing" defect this repo gates against.
 *
 * The Rust side answers with machine tokens (`app_controlled` / `"<reason>:<surface>"`);
 * this module turns that into what a screen needs: whether the switch is the app's, which
 * localised sentence explains it, and whether there is a system surface to open.
 *
 * **Honest rule encoded here**: an answer we did not get (`null` — unbridged, or the
 * command failed) is **not** "managed". A missing device answer must leave the switch as
 * it was (attempt it; the platform reports its own refusal), never grey it out on the
 * strength of a failed call.
 */

import type { RadioControlReply, RadioRefusal } from "./backend";
import type { RadioKey } from "./settings";
/** What a screen needs to render one radio's switch. */
export interface RadioManagedState {
  /** `true` only when the **device** said an app may not switch it. */
  managed: boolean;
  /**
   * i18n key explaining this radio's limit, or `""` when it is the app's own switch.
   * Per radio on purpose: the platforms differ (API 29 for Wi-Fi, API 33 for Bluetooth,
   * a signature permission for Airplane), so one shared sentence would be wrong twice.
   */
  noteKey: string;
  /** The system surface to open (`"wifi_panel"`, …), or `null` when there is none. */
  surface: string | null;
}

/** The radio keys the platform can take away (`RadioKey` minus the AP). */
const MANAGED_KEYS: Record<RadioKey, string> = {
  wifi: "radio.managed.wifi",
  bluetooth: "radio.managed.bluetooth",
  airplane: "radio.managed.airplane",
  // The Wi-Fi AP travels its own path (`TetheringGlue` reports the platform's answer
  // honestly), so there is no managed state to explain for it.
  hotspot: "",
};

/** Coerce one command reply into the screen's view model. */
export function radioManagedState(
  reply: RadioControlReply | null,
  key: RadioKey,
): RadioManagedState {
  // No answer (unbridged host, failed call) or an app-controlled switch: not managed.
  // `app_controlled: true` is the *only* thing a working switch needs to hear.
  if (reply == null || reply.app_controlled) {
    return { managed: false, noteKey: "", surface: null };
  }
  const surface = typeof reply.surface === "string" && reply.surface !== "" ? reply.surface : null;
  // A managed answer without a surface would be unexplainable *and* unactionable: the
  // screen could only say "you cannot" with nothing to offer. Keep the note (the fact is
  // still true) but leave the action off (`surface: null`).
  return { managed: true, noteKey: MANAGED_KEYS[key], surface };
}

/* ---- Structured `radio_set` refusals (REQ-A203) ------------------------------------------
 *
 * Before this, a refusal from `radio_set` travelled as a failed invoke and collapsed
 * into `null`: the only trace was the diagnostic ledger, and a tile tap looked like
 * nothing happened. Now the command answers `applied: false` plus machine tokens —
 * this module turns those into what a screen shows, with the same honesty rule as
 * above: tokens we do not understand produce **no** sentence, never an invented one.
 */

/** What a screen shows for one refused write. */
export interface RadioRefusalView {
  /** i18n key of the sentence, or `""` when nothing honest can be said. */
  noteKey: string;
  /** The system surface to offer (`"wifi_panel"`, …), or `null` when there is none. */
  surface: string | null;
}

/** Per-kind sentences for refusals that name no radio of their own. */
const REFUSAL_KEYS: Record<string, string> = {
  // The device said no to *this* attempt (device policy, rf-kill, a transient
  // backend failure). Retry may help; the system surface may help; the state did
  // not move.
  provider_refused: "radio.refused.device",
  // The airplane guard refused the request before anything was touched.
  airplane_active: "radio.refused.airplaneActive",
  // Nobody on this host could even serve the request (backend missing).
  unsupported: "radio.refused.unsupported",
};

/**
 * Coerce one `radio_set` refusal into the screen's view model.
 *
 * `platform_managed` gets the **refused radio's** own sentence (a cascade refusal
 * names the member, e.g. `radio: "wifi"` when airplane mode was asked) plus its
 * surface, so the screen can offer the real switch. Unknown or missing kinds give
 * `{ noteKey: "", surface: null }`: the screen may report that *something* was
 * refused (it has `applied: false`), but it must not invent a reason.
 */
export function radioRefusalView(
  refusal: RadioRefusal | null | undefined,
  requested: RadioKey,
): RadioRefusalView {
  if (!refusal || typeof refusal.kind !== "string") {
    return { noteKey: "", surface: null };
  }
  if (refusal.kind === "platform_managed") {
    // The refusal may name a different radio than the one asked (the airplane
    // cascade is refused on a member's behalf); fall back to the requested one.
    const radio = (
      typeof refusal.radio === "string" && refusal.radio in MANAGED_KEYS
        ? refusal.radio
        : requested
    ) as RadioKey;
    const surface =
      typeof refusal.surface === "string" && refusal.surface !== "" ? refusal.surface : null;
    return { noteKey: MANAGED_KEYS[radio], surface };
  }
  return { noteKey: REFUSAL_KEYS[refusal.kind] ?? "", surface: null };
}
