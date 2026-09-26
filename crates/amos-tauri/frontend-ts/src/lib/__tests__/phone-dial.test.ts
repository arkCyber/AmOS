/**
 * phone-dial.test.ts — the outbound-call transport decision (`placeOutgoingCall`).
 *
 * The point of these tests is the **order**: the real platform path (`ACTION_CALL`)
 * is tried first, for a regular number and an emergency one alike; a daemon backed by
 * a genuinely real stack is next; and a *simulated* call is only ever reached on a host
 * with no telephony stack at all. The regression they pin is the shipped defect — with
 * the daemon tried first, its `MockTelephonyProvider` answered every dial, so
 * `ACTION_CALL` was unreachable and a real phone never placed a real call (emergency
 * numbers included, while that path is exactly where the platform's emergency
 * guarantee lives: `docs/telephony.md` §5).
 *
 * Transports are injected, so the whole decision is pinned offline (no Tauri, no
 * Android).
 */
import { describe, expect, test, vi } from "vitest";
import { placeOutgoingCall, type DialTransports } from "../phone";

type Host = { on_device: boolean; available: boolean; reason: string };
/** An on-device build with the dial context bound: `real_dial` can fire. */
const DEVICE_READY: Host = { on_device: true, available: true, reason: "" };
/** An on-device build whose context is not bound — the phone *cannot* place a call. */
const DEVICE_UNBOUND: Host = {
  on_device: true,
  available: false,
  reason: "real dial context not bound — grant CALL_PHONE and re-open the app",
};
/**
 * An on-device build whose context IS bound but the user denied `CALL_PHONE`. `bind` is
 * unconditional at boot, so this is what a phone with a refused permission reports; the
 * reason must name the grant (REQ-A1626).
 */
const DEVICE_DENIED: Host = {
  on_device: true,
  available: false,
  reason: "CALL_PHONE not granted — allow the phone permission to place real calls",
};
/** A desktop host: no telephony stack at all. */
const DESKTOP: Host = {
  on_device: false,
  available: false,
  reason: "real dial is only available in the on-device (Android) System UI build",
};

/**
 * Four transports whose calls are recorded, so "the daemon was never consulted" is
 * provable rather than assumed. Defaults describe a desktop host whose daemon is the
 * mock and does not answer.
 */
function harness(over: Partial<DialTransports> = {}) {
  const system = vi.fn(over.system ?? (async () => false));
  const daemonReal = vi.fn(over.daemonReal ?? (async () => false));
  const hostStatus = vi.fn(over.hostStatus ?? (async () => DESKTOP));
  const daemon = vi.fn(over.daemon ?? (async () => null));
  return { system, daemonReal, hostStatus, daemon };
}

describe("placeOutgoingCall", () => {
  test("the real system path wins, and the daemon is never consulted", async () => {
    // The negative control for the defect: a daemon that would answer `out-1` must not
    // get the chance, or a device never fires ACTION_CALL.
    const t = harness({
      system: async () => true,
      daemonReal: async () => true,
      hostStatus: async () => DEVICE_READY,
      daemon: async () => ({ id: "out-1" }),
    });
    await expect(placeOutgoingCall("13800000000", false, t)).resolves.toEqual({
      kind: "handed-off",
    });
    expect(t.system).toHaveBeenCalledWith("13800000000");
    expect(t.daemon).not.toHaveBeenCalled();
    expect(t.daemonReal).not.toHaveBeenCalled();
  });

  test("an emergency number takes the real system path too", async () => {
    // The change, pinned: `ACTION_CALL` is where `docs/telephony.md` §5 puts the
    // emergency guarantee, so an emergency number must reach it — the previous routing
    // diverted emergency calls to the daemon's simulation.
    // `daemonReal` answers `true` so this pins the **order** and not just the outcome:
    // an emergency dial must reach `ACTION_CALL` *before* a real daemon is even asked.
    const t = harness({
      system: async () => true,
      daemonReal: async () => true,
      daemon: async () => ({ id: "out-1" }),
    });
    await expect(placeOutgoingCall("110", true, t)).resolves.toEqual({ kind: "handed-off" });
    expect(t.system).toHaveBeenCalledWith("110");
    expect(t.daemonReal).not.toHaveBeenCalled();
    expect(t.daemon).not.toHaveBeenCalled();
  });

  test("a daemon backed by a real stack is the next real path", async () => {
    // `system` could not reach the platform, but the daemon's provider *is* the real
    // telephony stack (backend kind `android`) — that call is real and binds our UI.
    const t = harness({
      system: async () => false,
      daemonReal: async () => true,
      daemon: async () => ({ id: "out-2" }),
    });
    await expect(placeOutgoingCall("13800000000", false, t)).resolves.toEqual({
      kind: "managed",
      id: "out-2",
      simulated: false,
    });
    expect(t.daemon).toHaveBeenCalledWith("13800000000", false);
  });

  test("a device with no real path fails with the host's reason — never a simulation", async () => {
    // The load-bearing honesty rule. The daemon here is the mock (real=false) on an
    // on-device build, so the call must be reported failed, *not* drawn as a managed
    // call that nothing placed. `daemon` not being called is the whole assertion.
    const t = harness({
      system: async () => false,
      daemonReal: async () => false,
      hostStatus: async () => DEVICE_UNBOUND,
      daemon: async () => ({ id: "mock-1" }),
    });
    await expect(placeOutgoingCall("110", true, t)).resolves.toEqual({
      kind: "failed",
      reason: DEVICE_UNBOUND.reason,
    });
    expect(t.daemon).not.toHaveBeenCalled();
  });

  test("a denied CALL_PHONE surfaces the grant reason, not a generic failure", async () => {
    // REQ-A1626. A bound context with the permission refused is the case the host used
    // to report as `available: true` with an empty reason — the dialer then showed a
    // bare "failed" (or routed into a rejected ACTION_CALL) with nothing actionable.
    // The reason must reach the caller intact.
    const t = harness({
      system: async () => false,
      daemonReal: async () => false,
      hostStatus: async () => DEVICE_DENIED,
      daemon: async () => ({ id: "mock-1" }),
    });
    const outcome = await placeOutgoingCall("13800000000", false, t);
    expect(outcome).toEqual({ kind: "failed", reason: DEVICE_DENIED.reason });
    expect((outcome as { reason: string }).reason).toContain("CALL_PHONE");
    expect(t.daemon).not.toHaveBeenCalled();
  });

  test("an unanswered host status reads as on-device, not as desktop", async () => {
    // `null` is "the host never answered" — the safe direction is to refuse, because
    // the other reading lets a real phone have its call simulated.
    const t = harness({
      hostStatus: async () => null,
      daemon: async () => ({ id: "mock-1" }),
    });
    await expect(placeOutgoingCall("13800000000", false, t)).resolves.toEqual({
      kind: "failed",
      reason: "",
    });
    expect(t.daemon).not.toHaveBeenCalled();
  });

  test("a desktop host gets the daemon's call, reported as simulated", async () => {
    const t = harness({
      hostStatus: async () => DESKTOP,
      daemon: async () => ({ id: "demo-1" }),
    });
    await expect(placeOutgoingCall("13800000000", false, t)).resolves.toEqual({
      kind: "managed",
      id: "demo-1",
      simulated: true,
    });
  });

  test("a desktop whose daemon does not answer fails, with no reason to quote", async () => {
    const t = harness({ hostStatus: async () => DESKTOP, daemon: async () => null });
    await expect(placeOutgoingCall("13800000000", false, t)).resolves.toEqual({
      kind: "failed",
      reason: "",
    });
  });

  test("a real daemon that refuses the call fails rather than being downgraded", async () => {
    const t = harness({
      daemonReal: async () => true,
      hostStatus: async () => DESKTOP,
      daemon: async () => null,
    });
    await expect(placeOutgoingCall("13800000000", false, t)).resolves.toEqual({
      kind: "failed",
      reason: "",
    });
    // A real stack was asked and declined: the desktop fallback must not run after it.
    expect(t.hostStatus).not.toHaveBeenCalled();
  });

  test("the number is trimmed, and a blank one touches no transport", async () => {
    const t = harness({
      system: async () => true,
      daemonReal: async () => true,
      hostStatus: async () => DEVICE_READY,
      daemon: async () => ({ id: "out-3" }),
    });
    await expect(placeOutgoingCall("  13800000000 ", false, t)).resolves.toEqual({
      kind: "handed-off",
    });
    expect(t.system).toHaveBeenCalledWith("13800000000");

    const blank = harness({ system: async () => true, daemon: async () => ({ id: "x" }) });
    await expect(placeOutgoingCall("   ", false, blank)).resolves.toEqual({
      kind: "failed",
      reason: "",
    });
    expect(blank.system).not.toHaveBeenCalled();
    expect(blank.daemonReal).not.toHaveBeenCalled();
    expect(blank.hostStatus).not.toHaveBeenCalled();
    expect(blank.daemon).not.toHaveBeenCalled();
  });
});
