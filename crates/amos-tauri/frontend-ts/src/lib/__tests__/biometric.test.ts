import { describe, it, expect } from "vitest";
import {
  biometricHwUnavailable,
  biometricNeedsEnrollment,
  biometricNoHardware,
  biometricReady,
  biometricUnknown,
  type BiometricAvailability,
} from "../biometric";

/**
 * The fixtures are keyed on `state`, because that is what the host sends — `enrolled` and
 * `hardware_present` are *derived* from it on the Rust side (`biometric_availability_from`)
 * and only mirrored here. A fixture that set the booleans independently could describe a
 * reply the host cannot produce, which is how these tests used to be able to pass while the
 * shipped glue had its two answers exchanged (REQ-A779 / F-AND-008).
 */
const avail = (
  state: BiometricAvailability["state"],
  extra: Partial<BiometricAvailability> = {},
): BiometricAvailability => ({
  state,
  can_authenticate: 0,
  kind: state === "enrolled" ? "fingerprint" : "none",
  label: state === "enrolled" ? "指纹" : "生物识别",
  enrolled: state === "enrolled",
  hardware_present:
    state === "enrolled" || state === "not-enrolled" || state === "hw-unavailable"
      ? true
      : state === "no-hardware"
        ? false
        : null,
  ...extra,
});

const FINGERPRINT_AVAILABLE = avail("enrolled");

/**
 * The `biometricLabel()` cases that used to sit here are gone with the helper itself
 * (REQ-A528): it returned **hard-coded Chinese** (`面容 ID` / `指纹` / `虹膜`), and the screen that
 * renders an availability is locale-aware — an English UI would have shown Chinese. Naming a
 * biometric is copy, so it now lives in i18n (`lock.biometricKind*`, both locales) and the screen
 * prefers the label the **host** reports (the platform's own localized name) over any local list.
 */

describe("biometricReady", () => {
  it("true only when the state is `enrolled`", () => {
    expect(biometricReady(FINGERPRINT_AVAILABLE)).toBe(true);
  });
  it("false when nothing is enrolled — even though the sensor is there", () => {
    // The old form was `enrolled && hardware_present`, which was already false here; what
    // matters is that the *true* branch needs the sensor confirmed, not merely assumed.
    expect(biometricReady(avail("not-enrolled"))).toBe(false);
  });
  it("false when the sensor is busy", () => {
    expect(biometricReady(avail("hw-unavailable"))).toBe(false);
  });
  it("false when the device reports no sensor", () => {
    expect(biometricReady(avail("no-hardware"))).toBe(false);
  });
  it("false when the platform did not answer, and false for null", () => {
    expect(biometricReady(avail("unknown"))).toBe(false);
    expect(biometricReady(avail("unavailable"))).toBe(false);
    expect(biometricReady(null)).toBe(false);
  });
  it("is driven by `state`, not by the mirrored booleans", () => {
    // A reply whose booleans claim readiness while `state` says otherwise is not something
    // the host sends (it derives both from `state`); if one ever appears, the union wins.
    expect(biometricReady(avail("no-hardware", { enrolled: true, hardware_present: true }))).toBe(
      false,
    );
  });
});

describe("biometricNeedsEnrollment", () => {
  it("false when enrolled", () => {
    expect(biometricNeedsEnrollment(FINGERPRINT_AVAILABLE)).toBe(false);
  });
  it("true exactly when the sensor is there and nothing is enrolled", () => {
    expect(biometricNeedsEnrollment(avail("not-enrolled"))).toBe(true);
  });
  it("false when the device reports no sensor — 'enrol one' would be impossible advice", () => {
    // This is the sentence the shipped glue produced on a phone with no sensor at all,
    // because `BIOMETRIC_ERROR_NO_HARDWARE` sat on the hardware-present arm.
    expect(biometricNeedsEnrollment(avail("no-hardware"))).toBe(false);
  });
  it("false when we have no answer — 'enrol one' may also be impossible advice", () => {
    expect(biometricNeedsEnrollment(avail("unknown"))).toBe(false);
    expect(biometricNeedsEnrollment(avail("unavailable"))).toBe(false);
    expect(biometricNeedsEnrollment(null)).toBe(false);
  });
});

describe("the predicate family is exhaustive over the six states", () => {
  // One state must light exactly one predicate — the screen's five branches are only honest
  // if no state falls through two of them or none of them.
  const states = [
    "enrolled",
    "not-enrolled",
    "hw-unavailable",
    "no-hardware",
    "unknown",
    "unavailable",
  ] as const;
  const preds = [
    biometricReady,
    biometricNeedsEnrollment,
    biometricHwUnavailable,
    biometricNoHardware,
    biometricUnknown,
  ];
  for (const s of states) {
    it(`\`${s}\` lights exactly one branch`, () => {
      const lit = preds.filter((p) => p(avail(s)));
      expect(lit).toHaveLength(1);
    });
  }
  it("`null` (no bridge) reads as 'no answer', never as 'no sensor'", () => {
    expect(biometricUnknown(null)).toBe(true);
    expect(biometricNoHardware(null)).toBe(false);
  });
  it("`unavailable` is 'no answer' too, and is not 'no sensor'", () => {
    expect(biometricUnknown(avail("unavailable"))).toBe(true);
    expect(biometricNoHardware(avail("unavailable"))).toBe(false);
  });
});
