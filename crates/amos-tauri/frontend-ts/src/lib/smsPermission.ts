// The SMS-grant refusal, mapped to the sentence the user should read.
//
// `sms_permission_request` answers with one of five states, and only **one** of them is
// "the user said no". Folding the rest into a denial would print a claim about the user's
// own system settings off an answer that never came from the settings screen (the
// F-AND-010 shape `mic_permission.rs` documents for the sibling grant). So the mapping is a
// pure, unit-tested function rather than an inline ternary in the component.

import type { SmsGrantStateWire } from "./backend";

/**
 * The i18n key for the sentence to show when `sms_permission_request` came back without the
 * grant. `granted` is not a refusal and maps to `null` — the caller clears the error instead.
 *
 * Every arm is the **statement of what happened**, never the remedy: the one state that has a
 * remedy the user can act on (`denied`) is also the one the caller flags, and the component
 * prints the settings pointer off that flag. Returning the pointer here too would print the
 * identical sentence twice — which is what the refused-*read* path, whose pair is
 * `message.smsDenied` over `message.smsDeniedHint`, never does.
 */
export function smsGrantRefusalKey(state: SmsGrantStateWire | undefined): string | null {
  switch (state) {
    // The OS answered "no" (or "not the whole set"): a denial, and the caller's `denied`
    // flag is what adds where to change it.
    case "denied":
      return "message.smsDenied";
    // Posted, no answer in time — the dialog may still be on screen.
    case "timed-out":
      return "message.smsGrantTimedOut";
    // The read itself failed; a sentence about the user's settings would be a fabrication.
    case "unreadable":
      return "message.smsGrantUnreadable";
    // No OS-grant concept here (desktop / glue not bound) — there is no dialog to post.
    case "host":
      return "message.smsGrantHost";
    default:
      return null;
  }
}
