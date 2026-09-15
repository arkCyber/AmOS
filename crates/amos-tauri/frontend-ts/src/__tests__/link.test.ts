import { describe, expect, test } from "bun:test";
import {
  actuationAgeMs,
  counterSummary,
  formatUptime,
  healthKey,
  linkLevel,
  peerSummary,
  reportAgeKey,
  reportAgeText,
  returnPathKey,
  returnPathLevel,
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
  actuations: [],
};

describe("robot-link client (pure helpers)", () => {
  test("no answer from the daemon is offline", () => {
    expect(linkLevel(null)).toBe("offline");
  });

  test("the return path has three states, and 'not answered' is not 'nobody reported'", () => {
    // `null` = the daemon did not answer `ListActuations` (an older build) — the panel knows
    // nothing about the fleet, so it must not say 「nobody reported」. This is the shape the
    // bridge produces for a daemon without the RPC (`docs/amos-link.md` §6.5).
    expect(returnPathLevel({ ...DEGRADED, actuations: null })).toBe("unavailable");
    expect(returnPathKey("unavailable")).toBe("link.returnPathUnavailable");
    // `[]` = it answered and nobody has reported yet.
    expect(returnPathLevel(DEGRADED)).toBe("none");
    expect(returnPathKey("none")).toBe("link.noReports");
    // A report makes it `reported`, and the copy is a different sentence again. (Built inline:
    // the `robot(...)` fixture of the second suite is scoped to that suite.)
    const reported: LinkActuation = {
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
    };
    expect(returnPathLevel({ ...DEGRADED, actuations: [reported] })).toBe("reported");
    expect(returnPathKey("reported")).not.toBe(returnPathKey("none"));
    // An **older bridge** omits the field entirely; that is the same version skew in the other
    // direction, so it reads as 「not answered」 too (never as an empty fleet).
    const skew: Partial<LinkStatus> = { ...DEGRADED };
    delete skew.actuations;
    expect(returnPathLevel(skew as LinkStatus)).toBe("unavailable");
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

  test("a report's age is computed from the reader's clock, or refused", () => {
    // What the row needs to answer "is this *still* true?": `armed` from two hours ago is not
    // "armed now". The age is `now - stamp_ms`, and the two cases that must not produce a number
    // are named instead of being folded into `0` (which would read as brand new).
    const now = 1_700_000_000_000;
    expect(actuationAgeMs(robot({ stamp_ms: now - 2_500 }), now)).toBe(2_500);
    expect(actuationAgeMs(robot({ stamp_ms: now - 3 * 3_600_000 }), now)).toBe(3 * 3_600_000);
    // A stamp of 0 is the proto's "absent", not 1970 (which would read as 56 years old).
    expect(actuationAgeMs(robot({ stamp_ms: 0 }), now)).toBeNull();
    // A stamp in the future means two unsynchronised clocks — an age would be a guess.
    expect(actuationAgeMs(robot({ stamp_ms: now + 5_000 }), now)).toBeNull();
    // A just-now report is `0`, which is a *real* age (unlike the two above).
    expect(actuationAgeMs(robot({ stamp_ms: now }), now)).toBe(0);
  });

  test("the age is rendered in the same shapes the CLI uses", () => {
    expect(reportAgeKey(250)).toBe("link.reportedNow");
    expect(reportAgeKey(2_000)).toBe("link.reportedAgo");
    expect(reportAgeKey(3 * 3_600_000)).toBe("link.reportedAgo");
    // …and an age that cannot be stated gets its own sentence, never a number.
    expect(reportAgeKey(null)).toBe("link.reportedUnknown");
    expect(reportAgeText(250)).toBe("250ms");
    expect(reportAgeText(2_500)).toBe("2s");
    expect(reportAgeText(125_000)).toBe("2m 05s");
    expect(reportAgeText(3 * 3_600_000)).toBe("3h 00m");
  });
});
