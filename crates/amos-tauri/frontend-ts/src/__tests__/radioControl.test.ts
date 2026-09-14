/**
 * Pure tests for the radio view models (lib/radioControl.ts).
 *
 * REQ-A202: turn a device's machine-token "who owns this switch" answer into what a
 * screen may claim — and *not* claim anything when there was no answer at all.
 * REQ-A203: the same honesty for refused writes — tokens become a sentence, and a
 * token nobody understands produces no sentence, never an invented one.
 */
import { describe, expect, test } from "bun:test";
import { radioManagedState, radioRefusalView } from "../lib/radioControl";
import type { RadioControlReply, RadioRefusal } from "../lib/backend";

const managed = (radio: string, surface: string, reason = "switch_removed"): RadioControlReply => ({
  radio,
  app_controlled: false,
  surface,
  reason,
});
const own = (radio: string): RadioControlReply => ({
  radio,
  app_controlled: true,
  surface: null,
  reason: null,
});

describe("radioManagedState (REQ-A202)", () => {
  test("a device answer of 'platform-managed' carries the note for THAT radio", () => {
    // One shared sentence would be wrong: the platform removed Wi-Fi in API 29 and
    // Bluetooth in API 33, and the airplane bit is a permission matter.
    expect(radioManagedState(managed("wifi", "wifi_panel"), "wifi")).toEqual({
      managed: true,
      noteKey: "radio.managed.wifi",
      surface: "wifi_panel",
    });
    expect(radioManagedState(managed("bluetooth", "bluetooth_settings"), "bluetooth")).toEqual({
      managed: true,
      noteKey: "radio.managed.bluetooth",
      surface: "bluetooth_settings",
    });
    expect(
      radioManagedState(managed("airplane", "airplane_settings", "privileged_only"), "airplane"),
    ).toEqual({
      managed: true,
      noteKey: "radio.managed.airplane",
      surface: "airplane_settings",
    });
  });

  test("the Wi-Fi AP is never presented as platform-managed", () => {
    // Its seam (`TetheringGlue`) reports the platform's own answer, so there is no
    // "you cannot" state to explain on the hotspot page.
    expect(radioManagedState(managed("hotspot", "wireless_settings"), "hotspot").noteKey).toBe("");
  });

  test("no answer is NOT 'managed': the switch keeps working as before", () => {
    // `null` means unbridged, or a command that failed. Greying a switch out on the
    // strength of a failed call would disable a working radio — the answer must be
    // "attempt it" (and let the platform report its own refusal).
    expect(radioManagedState(null, "wifi")).toEqual({
      managed: false,
      noteKey: "",
      surface: null,
    });
    expect(radioManagedState(own("wifi"), "wifi").managed).toBe(false);
  });

  test("a managed answer without a surface still explains but offers no action", () => {
    // A broken contract (no surface token) must not become a button that opens nothing:
    // the fact is still true and is still stated, the action is dropped.
    const state = radioManagedState(managed("wifi", ""), "wifi");
    expect(state.managed).toBe(true);
    expect(state.noteKey).toBe("radio.managed.wifi");
    expect(state.surface).toBe(null);
  });
});

describe("radioRefusalView (REQ-A203)", () => {
  const refused = (kind: string, extra: Partial<RadioRefusal> = {}): RadioRefusal => ({
    kind,
    ...extra,
  });

  test("a provider refusal gets the device sentence and invents no surface", () => {
    // Wi-Fi said no to *this* attempt (device policy, rf-kill): there is no system
    // screen that fixes that, so none may be offered — retry or the plain sentence.
    expect(
      radioRefusalView(refused("provider_refused", { detail: "setWifiEnabled(false) failed" }), "wifi"),
    ).toEqual({ noteKey: "radio.refused.device", surface: null });
  });

  test("the airplane guard and an absent backend each speak for themselves", () => {
    expect(radioRefusalView(refused("airplane_active"), "bluetooth")).toEqual({
      noteKey: "radio.refused.airplaneActive",
      surface: null,
    });
    expect(radioRefusalView(refused("unsupported"), "hotspot")).toEqual({
      noteKey: "radio.refused.unsupported",
      surface: null,
    });
  });

  test("a platform-managed refusal carries the refused radio's sentence and its surface", () => {
    // `radio_control` can come back empty (a failed mount read); the write attempt is
    // then refused and the answer must still offer the way out here.
    expect(
      radioRefusalView(refused("platform_managed", { radio: "wifi", surface: "wifi_panel", reason: "switch_removed" }), "wifi"),
    ).toEqual({ noteKey: "radio.managed.wifi", surface: "wifi_panel" });
  });

  test("a cascade refusal names the member it was refused on, not the radio that was asked", () => {
    // Airplane ON was requested; the manager refused on Wi-Fi's behalf. The sentence
    // must be Wi-Fi's — that is the switch the user is being told is not theirs.
    expect(
      radioRefusalView(refused("platform_managed", { radio: "wifi", surface: "wifi_panel" }), "airplane"),
    ).toEqual({ noteKey: "radio.managed.wifi", surface: "wifi_panel" });
  });

  test("a platform-managed refusal that names nothing falls back to the requested radio", () => {
    // A token-only answer is still a real refusal: the requested radio's own sentence
    // is the honest default, not an invention.
    expect(radioRefusalView(refused("platform_managed"), "airplane")).toEqual({
      noteKey: "radio.managed.airplane",
      surface: null,
    });
  });

  test("a token nobody understands produces no sentence — never an invented one", () => {
    // The screen may say "refused, reason unknown" (it has `applied: false`), but the
    // view model must not dress the answer up as a reason it was never given.
    expect(radioRefusalView(refused("brain_lock"), "wifi")).toEqual({ noteKey: "", surface: null });
    expect(radioRefusalView(refused(""), "wifi")).toEqual({ noteKey: "", surface: null });
  });

  test("no refusal is no view at all", () => {
    // `applied: false` without a refusal is a broken bridge answer; the screen can
    // only fall back to its own wording, which this `""` signals.
    expect(radioRefusalView(null, "wifi")).toEqual({ noteKey: "", surface: null });
    expect(radioRefusalView(undefined, "wifi")).toEqual({ noteKey: "", surface: null });
  });

  test("a broken surface token is dropped, not turned into a dead button", () => {
    expect(
      radioRefusalView(refused("platform_managed", { radio: "wifi", surface: "", reason: "" }), "wifi"),
    ).toEqual({ noteKey: "radio.managed.wifi", surface: null });
  });
});
