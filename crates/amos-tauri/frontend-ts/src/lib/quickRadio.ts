/**
 * quickRadio.ts — **one** implementation of "the user tapped a radio switch".
 *
 * Why this module exists: that orchestration had been written **twice** — inline in
 * `svelte/NotificationCenter.svelte` (the quick-settings tiles) and again in
 * `svelte/SettingsApp.svelte` — with the same rules (the airplane gate, the refusal
 * branch, the re-read after a failed write) and one real divergence: only the
 * notification centre knew about a switch the **platform** owns (REQ-A202), so tapping
 * Wi-Fi there offered the system surface while tapping it in Settings attempted a write
 * that could not land. A third screen (the desktop's Control Center) would have made it
 * three copies, which is this repo's most repeated lesson: the failure mode is never one
 * wrong value, it is N copies of a value.
 *
 * What is shared is the **decision**, not the screen: the outcome below says what the
 * device answered, and each caller keeps its own wording, state and layout. The two rules
 * that matter are encoded here once:
 *
 *   • the device is authoritative — a reply's snapshot (`state`) beats the persisted
 *     intent, and a read that answers is believed;
 *   • a **refused** write leaves the user's intent in the store (the store must not
 *     silently adopt a state the device did not accept) while the screen still shows the
 *     device's current state, so no bit on screen lies (REQ-A203).
 *
 * The commands are a **port** (`RadioCommands`), not a direct import: every branch —
 * offline / gated / managed / applied / refused / unread — is therefore testable without
 * a Tauri host, which was impossible while this logic lived inside two components.
 */
import {
  radioControl,
  radioOpenSettings,
  radioSet,
  radioStatus,
  type RadioControlReply,
  type RadioPayload,
  type RadioSetReply,
} from "./backend";
import { radioRefusalView, type RadioManagedState, type RadioRefusalView } from "./radioControl";
import { flipRadio, type QuickSettings, type RadioKey } from "./settings";

/** The four radios a quick panel can switch (the AP included: it travels its own path). */
export const RADIO_KEYS: readonly RadioKey[] = ["wifi", "bluetooth", "airplane", "hotspot"];

/**
 * The commands this module needs, as a **port**. `HOST_RADIO_COMMANDS` is the real one;
 * a test passes a fake, and no branch of the rules below needs a host to be exercised.
 */
export interface RadioCommands {
  set(key: RadioKey, enabled: boolean): Promise<RadioSetReply | null>;
  status(): Promise<RadioPayload | null>;
  control(key: RadioKey): Promise<RadioControlReply | null>;
  openSettings(key: RadioKey): Promise<boolean | null>;
}

/** The real port: the `radio_*` Tauri commands, unchanged. */
export const HOST_RADIO_COMMANDS: RadioCommands = {
  set: (key, enabled) => radioSet(key, enabled),
  status: () => radioStatus(),
  control: (key) => radioControl(key),
  openSettings: (key) => radioOpenSettings(key),
};

/**
 * Does airplane mode own this radio **right now**? (REQ-A1082)
 *
 * Airplane mode owns the others: switching Wi-Fi on while the airplane bit is set is a
 * no-op in the Rust policy too, so it is not even attempted. This predicate is the gate
 * `tapRadio` applies below — exported so a *screen* can say the same thing **before** the
 * tap instead of guessing at it. It must be the same predicate for both: a view that
 * re-derives "is this gated?" from `settings` itself is a second answer that can drift
 * from the rule that decides what a tap does (and it did — the quick panels drew a live
 * Wi-Fi tile under airplane mode, which `tapRadio` then answered with `gated`, so the tap
 * did nothing at all and nothing said why).
 *
 * `key` is a `RadioKey`, not a `QuickKey`: every radio but `airplane` is gated, but a
 * non-radio tile (`darkmode`, `location`) is **not**, so a caller must first know it is
 * looking at a radio.
 */
export function radioGated(settings: QuickSettings, key: RadioKey): boolean {
  return key !== "airplane" && !!settings.airplane;
}

/**
 * What a radio switch should **read**: `on` only when the radio is really on (REQ-A1082,
 * REQ-A1143).
 *
 * The companion to `radioGated`, and for the same reason. Airplane mode cascades the other
 * radios off in the Rust policy, so a gated radio is **off** — not "on, but unusable". A
 * surface that drew the stored bit instead answered the same question a second way, and it
 * diverged: the quick settings' Wi-Fi tile and the Wi-Fi/Bluetooth settings rows read
 * *pressed* under airplane mode while the sentence rendered **on the same screen**
 * (`settings.airplaneBlocks`) says those radios are closed, and while the desktop Control
 * Center, the settings index rows and the status bar all said off. The stored bit is the
 * user's *intent*, and intent is exactly what survives airplane mode (REQ-A185 draws the
 * same line for the device read) — so the switch asks this predicate, and the fact has one
 * owner instead of one per screen.
 */
export function radioDisplayOn(settings: QuickSettings, key: RadioKey): boolean {
  return !radioGated(settings, key) && !!settings[key];
}

/** Pure: the device's radio snapshot written over the persisted quick settings. */
export function mergeRadioQuick(s: QuickSettings, r: RadioPayload): QuickSettings {
  return {
    ...s,
    wifi: r.wifi,
    bluetooth: r.bluetooth,
    airplane: r.airplane,
    hotspot: r.hotspot,
  };
}

/**
 * Read the device's radio state once and merge it into `settings` (REQ-A185: the tiles
 * otherwise show the user's *intent*, so "Wi-Fi off" could sit on screen while the
 * device's Wi-Fi is on).
 *
 * `null` when nobody answered — an unbridged host, or a failed call. The caller then
 * keeps the stored values, which is the honest offline behaviour (never a fabricated
 * state).
 */
export async function syncQuickRadios(
  settings: QuickSettings,
  cmds: RadioCommands = HOST_RADIO_COMMANDS,
): Promise<QuickSettings | null> {
  const live = await cmds.status();
  return live ? mergeRadioQuick(settings, live) : null;
}

/**
 * Ask the platform which switches it owns (REQ-A202), one call per radio.
 *
 * An answer we did not get is stored as `null` and read back by `radioManagedState` as
 * "not managed": a failed *question* must never grey out a working switch.
 */
export async function readManagedSwitches(
  cmds: RadioCommands = HOST_RADIO_COMMANDS,
): Promise<Record<RadioKey, RadioControlReply | null>> {
  const answers = await Promise.all(RADIO_KEYS.map((k) => cmds.control(k)));
  const out = {} as Record<RadioKey, RadioControlReply | null>;
  RADIO_KEYS.forEach((k, i) => (out[k] = answers[i] ?? null));
  return out;
}

/**
 * Open the system surface that owns a radio (REQ-A202 / REQ-A203).
 *
 * `true` **only** when a surface actually opened: a caller must report the other answers
 * (`false`, or `null` because nobody answered) instead of swallowing them — a tap that
 * silently does nothing is exactly the defect this path exists to remove.
 */
export async function openRadioSettings(
  key: RadioKey,
  cmds: RadioCommands = HOST_RADIO_COMMANDS,
): Promise<boolean> {
  return (await cmds.openSettings(key)) === true;
}

/**
 * What one tap did, as the **device** answered it.
 * `next` is always what the screen should show, and `persist` says whether writing it to
 * the shared store is honest. The rule is one line: **persist only what the device
 * confirmed** (or what the local policy decided when there is no device at all).
 *   • `applied` → the write landed and the reply carries the device's snapshot ⇒ persist;
 *   • `offline` → no host; the local policy *is* the intent ⇒ persist;
 *   • `refused` / `unread` → the device never confirmed ⇒ show its state, keep the intent
 *     (persisting a state the device did not accept erases the reason the screen explains,
 *     REQ-A203);
 *   • `gated` / `managed` → nothing changed at all.
 */
export type RadioTapOutcome =
  | { kind: "offline"; next: QuickSettings; persist: true }
  | { kind: "gated"; next: QuickSettings; persist: false }
  | { kind: "managed"; next: QuickSettings; persist: false; opened: boolean; key: RadioKey }
  | { kind: "applied"; next: QuickSettings; persist: true }
  | {
      kind: "refused";
      next: QuickSettings;
      persist: false;
      key: RadioKey;
      refusal: RadioRefusalView;
    }
  | { kind: "unread"; next: QuickSettings; persist: false };

/** One radio tap: the key, what the store held, whether a host is attached, the platform's answer. */
export interface RadioTapInput {
  key: RadioKey;
  settings: QuickSettings;
  /** `bridged()` in production — injected so the offline path is testable. */
  host: boolean;
  /**
   * What the platform said about **this** key (`radioManagedState(...)` at the call site
   * that asked). Omit it and the write is attempted: that is the older behaviour of the
   * Settings screen, kept as a caller's choice rather than a rule of this module.
   */
  managed?: RadioManagedState | null;
  cmds?: RadioCommands;
}

/**
 * Perform one radio tap and describe what happened. Never throws, never invents a state:
 * every branch answers with a `next` built from what the host actually said.
 */
export async function tapRadio(input: RadioTapInput): Promise<RadioTapOutcome> {
  const { key, settings, host } = input;
  const cmds = input.cmds ?? HOST_RADIO_COMMANDS;

  // Airplane mode owns the others: switching Wi-Fi on while the airplane bit is set is a
  // no-op in the Rust policy too, so it is not even attempted. The gate is the **same**
  // predicate the screens mark their tiles with (`radioGated`) — one rule, two readers.
  if (radioGated(settings, key)) {
    return { kind: "gated", next: settings, persist: false };
  }

  if (!host) {
    return { kind: "offline", next: flipRadio(settings, key), persist: true };
  }

  // A switch the platform owns must not be *attempted* (REQ-A202): `radio_set` would
  // refuse before touching the device and the caller would be left with a tile that did
  // not move and nothing explaining why. Hand the user to the system surface instead.
  if (input.managed?.managed) {
    const opened = await cmds.openSettings(key);
    return { kind: "managed", next: settings, persist: false, opened: opened === true, key };
  }

  const on = !!settings[key];
  const res = await cmds.set(key, !on);
  if (res) {
    const state = res.state ?? null;
    const next = state ? mergeRadioQuick(settings, state) : settings;
    if (res.applied) return { kind: "applied", next, persist: true };
    return {
      kind: "refused",
      next,
      persist: false,
      key,
      refusal: radioRefusalView(res.refusal, key),
    };
  }

  // The command failed (or never arrived): take a fresh read as the truth for the screen.
  // If even that fails, `next` is unchanged and the caller shows the state it had. Either
  // way the store keeps the user's intent — no write was confirmed.
  const live = await cmds.status();
  return {
    kind: "unread",
    next: live ? mergeRadioQuick(settings, live) : settings,
    persist: false,
  };
}
