import { describe, expect, test } from "bun:test";
import {
  otaChargingFact,
  otaOutcome,
  otaOutcomeKey,
  otaReasonKey,
  type OtaCheckResult,
} from "../lib/ota";

/** A minimal result of a given `kind` (the other fields are irrelevant here). */
function result(kind: string, reason: string | null = null): OtaCheckResult {
  return {
    kind,
    current_version: "1.0.0",
    channel: "stable",
    version: null,
    package_uri: null,
    package_bytes: null,
    reason_code: reason,
    detail: null,
  };
}

describe("ota client (pure helpers)", () => {
  test("each host kind maps to its display outcome", () => {
    expect(otaOutcome(result("up_to_date"))).toBe("up-to-date");
    expect(otaOutcome(result("eligible"))).toBe("update-available");
    expect(otaOutcome(result("deferred", "needs_wifi"))).toBe("deferred");
    expect(otaOutcome(result("refused", "unsigned"))).toBe("refused");
    expect(otaOutcome(result("unreachable"))).toBe("unreachable");
    expect(otaOutcome(result("unconfigured"))).toBe("unconfigured");
    expect(otaOutcome(result("misconfigured"))).toBe("misconfigured");
  });

  test("no answer (null) is offline, distinct from the host's own 'unreachable'", () => {
    // `null` means the command never ran/returned (not bridged, or it threw);
    // `unreachable` means the host DID run the check and could not read its source.
    // Collapsing the two would tell a user their update server is down when in fact
    // the daemon was never reached.
    expect(otaOutcome(null)).toBe("offline");
    expect(otaOutcome(result("unreachable"))).toBe("unreachable");
  });

  test("an unrecognized kind is 'offline', never a fabricated verdict", () => {
    // A kind this build does not understand must not be rendered as "up to date":
    // the honest reading of an unknown state is "no answer".
    expect(otaOutcome(result("something_new"))).toBe("offline");
  });

  test("misconfigured is the host having answered, not folded into 'offline'", () => {
    // The host *did* run the decision and refused to answer for the fallback lane
    // (`AMOS_OTA_CHANNEL` is not a channel). Folding it into `offline` would read
    // as "not connected" and hide the operator error; folding it into `up-to-date`
    // would be an outright lie.
    expect(otaOutcome(result("misconfigured"))).toBe("misconfigured");
  });

  test("every outcome has a headline i18n key", () => {
    for (const k of ["up_to_date", "eligible", "deferred", "refused", "unreachable", "unconfigured", "misconfigured"]) {
      expect(otaOutcomeKey(otaOutcome(result(k)))).toMatch(/^settings\.updateOutcome_/);
    }
    expect(otaOutcomeKey("offline")).toMatch(/^settings\.updateOutcome_/);
  });

  test("known reason codes key into the dictionary; unknown ones degrade", () => {
    const known = [
      "reflash_required",
      "prerelease_not_allowed",
      "unsigned",
      "not_in_cohort",
      "outside_window",
      "needs_wifi",
      "unknown_battery",
      "unknown_charging",
      "low_battery",
    ];
    for (const code of known) {
      expect(otaReasonKey(code)).toBe(`settings.updateReason.${code}`);
    }
    // An unknown code (or none) must not leak a raw machine token into the UI.
    expect(otaReasonKey("brand_new_reason")).toBe("settings.updateReason.other");
    expect(otaReasonKey(null)).toBe("settings.updateReason.other");
  });

  test("an unread charger stays unknown, never folded into 'on battery'", () => {
    // The wire is three-valued: `null` (nobody read the charger) and `undefined`
    // (no sample at all) are both "unknown", distinct from a read-and-false
    // "on battery". Folding either into `false` would hand the host a measured
    // fact it never measured.
    expect(otaChargingFact(null)).toBeNull();
    expect(otaChargingFact(undefined)).toBeNull();
    // Positive controls: real readings survive both ways.
    expect(otaChargingFact(true)).toBe(true);
    expect(otaChargingFact(false)).toBe(false);
  });
});
