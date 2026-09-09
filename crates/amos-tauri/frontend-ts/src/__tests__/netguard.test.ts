import { describe, expect, test } from "bun:test";
import {
  guardLevel,
  isEnforcing,
  type NetGuardStatus,
} from "../lib/netguard";

/** A realistic disarmed/mock host-build status: never `enforced` on the mock. */
const MOCK_OFF: NetGuardStatus = {
  enabled: false,
  backend: "mock",
  enforced: false,
  policy_rules: 0,
  top_egress: [],
};

describe("network-guard client (pure helpers)", () => {
  test("disarmed mock status is not enforcing", () => {
    expect(guardLevel(MOCK_OFF)).toBe("disarmed");
    expect(isEnforcing(MOCK_OFF)).toBe(false);
  });

  test("null status is offline", () => {
    expect(guardLevel(null)).toBe("offline");
    expect(isEnforcing(null)).toBe(false);
  });

  test("armed intent (mock backend) is honest: not enforced", () => {
    const armedIntent: NetGuardStatus = { ...MOCK_OFF, enabled: true };
    expect(guardLevel(armedIntent)).toBe("armed-intent");
    expect(isEnforcing(armedIntent)).toBe(false);
  });

  test("only a real enforcing backend reports armed-enforced", () => {
    const enforcing: NetGuardStatus = {
      enabled: true,
      backend: "nftables",
      enforced: true,
      policy_rules: 2,
      top_egress: [{ domain: "tracker.example", bytes: 900 }],
    };
    expect(guardLevel(enforcing)).toBe("armed-enforced");
    expect(isEnforcing(enforcing)).toBe(true);
    // status mirror keeps the audit sample intact
    expect(enforcing.top_egress[0]!.bytes).toBe(900);
  });
});
