import { describe, expect, test } from "bun:test";
import { guardLevel, type NetGuardStatus } from "../lib/netguard";

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
  });

  test("null status is offline", () => {
    expect(guardLevel(null)).toBe("offline");
  });

  test("armed intent (mock backend) is honest: not enforced", () => {
    const armedIntent: NetGuardStatus = { ...MOCK_OFF, enabled: true };
    expect(guardLevel(armedIntent)).toBe("armed-intent");
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
    // status mirror keeps the audit sample intact
    expect(enforcing.top_egress[0]!.bytes).toBe(900);
  });

  test("a self-contradictory reply cannot make the UI claim a firewall (REQ-A295)", () => {
    // `enforced: true` is the daemon's claim; the UI's "armed-enforced" sentence asserts
    // traffic is really being blocked, so the claim must come from a backend that can do
    // it. The shipped mock says `enforced: false` itself (Rust test pins that), so this
    // shape is a *contradiction* — and the honest reading of a contradiction is intent,
    // never a firewall that the named backend cannot provide.
    for (const backend of ["mock", "mock+breaker", "  MOCK +breaker ", ""]) {
      const contradictory: NetGuardStatus = {
        enabled: true,
        backend,
        enforced: true,
        policy_rules: 0,
        top_egress: [],
      };
      expect(guardLevel(contradictory), `backend=${JSON.stringify(backend)}`).toBe(
        "armed-intent",
      );
    }
  });

  test("a named real backend is believed — including one this build has never seen", () => {
    // The daemon is the authority on enforcement; under-claiming a future backend (ebpf,
    // a vendor VPN) would be its own kind of dishonesty.
    for (const backend of ["vpn", "nftables", "ebpf", "Vpn"]) {
      const enforcing: NetGuardStatus = {
        enabled: true,
        backend,
        enforced: true,
        policy_rules: 1,
        top_egress: [],
      };
      expect(guardLevel(enforcing), `backend=${backend}`).toBe("armed-enforced");
    }
    // …but a *mock* decorated by a real-sounding suffix is still a mock.
    expect(
      guardLevel({
        enabled: true,
        backend: "mock+vpn",
        enforced: true,
        policy_rules: 0,
        top_egress: [],
      }),
    ).toBe("armed-intent");
  });
});
