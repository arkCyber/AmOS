import { describe, expect, test } from "bun:test";
import {
  counterSummary,
  formatUptime,
  healthKey,
  linkLevel,
  peerSummary,
  robotLevel,
  robotLevelKey,
  robotSummary,
  type LinkActuation,
  type LinkStatus,
} from "../lib/link";

/** A realistic degraded status: the daemon works, but the clock is uncalibrated. */
const DEGRADED: LinkStatus = {
  peer: "amos-daemon",
  kind: "brain",
  version: "0.1.0",
  uptime_ms: 4200,
  clock_synced: false,
  health: "degraded",
  health_reasons: ["no_peers", "clock_unsynced"],
  metrics: {
    published: 12,
    delivered: 12,
    dropped: 0,
    blocked: 0,
    decode_errors: 0,
    encode_errors: 0,
  },
  peers: [],
};

describe("robot-link client (pure helpers)", () => {
  test("no answer from the daemon is offline", () => {
    expect(linkLevel(null)).toBe("offline");
  });

  test("the daemon's own verdict is passed through, not re-judged", () => {
    expect(linkLevel({ ...DEGRADED, health: "healthy" })).toBe("healthy");
    expect(linkLevel(DEGRADED)).toBe("degraded");
  });

  test("unknown (no evidence yet) is NOT healthy", () => {
    // The whole point of the page: a quiet link must not render as a green all-clear.
    expect(linkLevel({ ...DEGRADED, health: "unknown" })).toBe("unknown");
    expect(healthKey("unknown")).toBe("link.valUnknown");
    expect(healthKey("healthy")).not.toBe(healthKey("unknown"));
  });

  test("a verdict this build does not recognize stays un-asserted", () => {
    // A newer daemon's enum must not be folded into a verdict we do know.
    expect(linkLevel({ ...DEGRADED, health: "unrecognized" })).toBe("unknown");
    expect(linkLevel({ ...DEGRADED, health: "" })).toBe("unknown");
  });

  test("each level maps to its own copy key", () => {
    expect(healthKey("healthy")).toBe("link.valHealthy");
    expect(healthKey("degraded")).toBe("link.valDegraded");
    expect(healthKey("offline")).toBe("link.valOffline");
    expect(healthKey("unknown")).toBe("link.valUnknown");
  });

  test("uptime is rendered at a useful scale, zero included", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(-5)).toBe("0s");
    expect(formatUptime(Number.NaN)).toBe("0s");
    expect(formatUptime(45_000)).toBe("45s");
    expect(formatUptime(125_000)).toBe("2m 05s");
    expect(formatUptime(3 * 3_600_000 + 4 * 60_000)).toBe("3h 04m");
    expect(formatUptime(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 03h");
  });

  test("the peer summary names ids and kinds, in the daemon's order", () => {
    expect(peerSummary([])).toBe("");
    expect(
      peerSummary([
        { id: "dog1", kind: "robot", endpoint: null, last_seen_ms: 10, beacons: 2 },
        { id: "mini-brain", kind: "brain", endpoint: "tcp/1.2.3.4:7447", last_seen_ms: 5, beacons: 0 },
      ]),
    ).toBe("dog1 (robot), mini-brain (brain)");
  });

  test("the counter readout prints every counter with its wire name", () => {
    const line = counterSummary(DEGRADED.metrics);
    for (const token of [
      "published=12",
      "delivered=12",
      "dropped=0",
      "blocked=0",
      "decode_errors=0",
      "encode_errors=0",
    ]) {
      expect(line).toContain(token);
    }
  });
});

describe("robot rows (the control loop's return path)", () => {
  const robot = (over: Partial<LinkActuation> = {}): LinkActuation => ({
    robot: "dog1",
    seq: 12,
    gait: "trot",
    frames: 13,
    armed: true,
    estopped: false,
    estop_reason: null,
    watchdog_ms: null,
    last_refusal: null,
    stamp_ms: 1,
    ...over,
  });

  test("a latched e-stop wins over a stale `armed`", () => {
    // Torque cut is the fact a user must see first; the panel must never show "armed"
    // just because the flag was still true when the robot reported.
    expect(robotLevel(robot({ estopped: true, estop_reason: "watchdog" }))).toBe("estopped");
  });

  test("armed and never-armed are told apart", () => {
    expect(robotLevel(robot())).toBe("armed");
    expect(robotLevel(robot({ armed: false, gait: null, seq: null }))).toBe("idle");
  });

  test("each level has its own copy key", () => {
    expect(robotLevelKey("estopped")).toBe("link.robotEstopped");
    expect(robotLevelKey("armed")).toBe("link.robotArmed");
    expect(robotLevelKey("idle")).toBe("link.robotIdle");
  });

  test("the row names the robot, its gait and the action it reflects", () => {
    expect(robotSummary(robot())).toBe("dog1 · trot · #12");
    // `null` is "the robot did not report it", never a made-up zero.
    expect(robotSummary(robot({ gait: null, seq: null }))).toBe("dog1 · - · #-");
  });
});
