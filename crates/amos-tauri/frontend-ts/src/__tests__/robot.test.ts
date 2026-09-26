import { afterEach, describe, expect, test } from "bun:test";
import {
  QUADRUPED_ACTIONS,
  actionJson,
  beatAgeKey,
  beatAgeMs,
  beatOrigin,
  fleetSummary,
  receiptKey,
  receiptLevel,
  receiptSummary,
  robotCommand,
  robotCommandMany,
  fleetTargets,
  robotTargets,
  listenHeartbeats,
  startHeartbeats,
  type LinkPublishOut,
} from "../lib/robot";
import type { LinkStatus } from "../lib/link";

/** A status where two robots are known: one by its report, one only as a beacon peer. */
const STATUS: LinkStatus = {
  peer: "amos-daemon",
  kind: "brain",
  version: "0.1.0",
  uptime_ms: 4200,
  clock_synced: false,
  health: "degraded",
  health_reasons: ["no_peers"],
  metrics: {
    published: 3,
    delivered: 3,
    dropped: 0,
    blocked: 0,
    decode_errors: 0,
    encode_errors: 0,
  },
  peers: [
    { id: "patrol-01", kind: "robot", endpoint: null, last_seen_ms: 20, beacons: 4 },
    { id: "patrol-02", kind: "robot", endpoint: null, last_seen_ms: 30, beacons: 2 },
    // A non-robot peer must never be offered as a command target.
    { id: "mini-brain", kind: "brain", endpoint: null, last_seen_ms: 10, beacons: 1 },
  ],
  actuations: [
    {
      robot: "patrol-03",
      seq: 2,
      gait: "trot",
      frames: 13,
      armed: true,
      estopped: false,
      estop_reason: null,
      watchdog_ms: 300,
      last_refusal: null,
      stamp_ms: 1_700_000_000_000,
    },
  ],
};

describe("robot console client (pure helpers)", () => {
  test("the command palette leads with the safety pair, gaits last", () => {
    expect(QUADRUPED_ACTIONS.map((a) => a.key)).toEqual([
      "estop",
      "arm",
      "stand",
      "trot",
      "walk",
      "sit",
    ]);
    expect(QUADRUPED_ACTIONS.filter((a) => a.safety).map((a) => a.key)).toEqual(["estop", "arm"]);
    // Only motion gaits take a speed; the safety pair ignores it by design.
    expect(QUADRUPED_ACTIONS.filter((a) => a.motion).map((a) => a.key)).toEqual([
      "stand",
      "trot",
      "walk",
      "sit",
    ]);
  });

  test("a motion gait carries speed; the safety pair is sent bare", () => {
    expect(actionJson("trot", 0.6)).toBe('{"action":"trot","speed":0.6}');
    // Speed is rounded so a slider cannot emit binary-float noise.
    expect(actionJson("walk", 0.1 + 0.2)).toBe('{"action":"walk","speed":0.3}');
    // estop / arm ignore speed, so it is not sent (sending it would imply it matters).
    expect(actionJson("estop", 0.9)).toBe('{"action":"estop"}');
    expect(actionJson("arm", 0.9)).toBe('{"action":"arm"}');
  });

  test("robot targets merge the peer table and the return path, sorted and deduped", () => {
    // patrol-03 is known only by its report; patrol-01/02 only as peers.
    expect(robotTargets(STATUS)).toEqual(["patrol-01", "patrol-02", "patrol-03"]);
  });

  test("fleet targets are the registry plus a robot aimed at by hand", () => {
    // The aimed robot the registry has never heard of is included — the whole point of the union.
    expect(fleetTargets(["patrol-01", "patrol-02"], "rig-hand")).toEqual([
      "patrol-01",
      "patrol-02",
      "rig-hand",
    ]);
    // An aimed robot already in the registry is not duplicated.
    expect(fleetTargets(["patrol-01", "patrol-02"], "patrol-02")).toEqual([
      "patrol-01",
      "patrol-02",
    ]);
    // A blank target box is 「nothing selected」, not a robot named "".
    expect(fleetTargets(["patrol-01"], "")).toEqual(["patrol-01"]);
    expect(fleetTargets(["patrol-01"], "   ")).toEqual(["patrol-01"]);
    // Only a hand-aimed robot: the fleet is exactly it (the single e-stop is pressable here too).
    expect(fleetTargets([], "rig-hand")).toEqual(["rig-hand"]);
    // Nothing at all: the fleet is empty, which is what disables the button.
    expect(fleetTargets([], "")).toEqual([]);
    // The caller's array is not mutated.
    const known = ["patrol-01"];
    fleetTargets(known, "rig-hand");
    expect(known).toEqual(["patrol-01"]);
  });

  test("a receipt only asserts delivery when the transport could count it", () => {
    const reaches: LinkPublishOut = { seq: 7, matched: 1, delivered: 1, dropped: 0 };
    expect(receiptLevel(reaches)).toBe("reached");
    expect(receiptKey(receiptLevel(reaches))).toBe("robot.receiptReached");
    // delivered=0 is 「could not count」 (a network transport always answers 0) — never
    // rendered as 「failed」.
    const zero: LinkPublishOut = { seq: 7, matched: 0, delivered: 0, dropped: 0 };
    expect(receiptLevel(zero)).toBe("unknown");
    expect(receiptKey(receiptLevel(zero))).toBe("robot.receiptUnknown");
    expect(receiptSummary(reaches)).toBe("seq=7 matched=1 delivered=1 dropped=0");
  });

  test("a beat row can name what its peer is, and never invents a role", () => {
    // The daemon's OWN beat: `with_heartbeat` starts the node's own heartbeat and
    // `heartbeat_pattern()` (`amos/*/telemetry/beat`) delivers it back into the very stream this
    // console reads — while `LinkNode::observe` refuses a node as its own peer, so it is in
    // `status.peers` never. `status.peer` is the only thing that identifies it.
    expect(beatOrigin("amos-daemon", STATUS)).toEqual({ role: "self" });
    // A robot's beat, and a non-robot peer's beat: same panel, and the kind is the one thing that
    // separates them (`robotTargets` filters on it; a liveness row that does not is the odd one out).
    expect(beatOrigin("patrol-01", STATUS)).toEqual({ role: "peer", token: "robot" });
    expect(beatOrigin("mini-brain", STATUS)).toEqual({ role: "peer", token: "brain" });
    // A beat from a peer the table cannot resolve: a role must NOT be guessed for it — a robot
    // whose beacon aged out of the registry while its beats kept flowing is indistinguishable
    // here from a stranger, so the row says it could not be placed rather than picking a kind.
    expect(beatOrigin("ghost-9", STATUS)).toEqual({ role: "unknown" });
    // No status at all (the panel this row lives in is not even rendered): still no invented role.
    expect(beatOrigin("patrol-01", null)).toEqual({ role: "unknown" });
    // A peer the daemon itself could not classify stays a *resolved* peer with an unhelpful token:
    // "we found it, its role is one this build does not know" is not "we could not find it".
    const newer: LinkStatus = {
      ...STATUS,
      peers: [{ id: "future-01", kind: "quantum", endpoint: null, last_seen_ms: 1, beacons: 1 }],
    };
    expect(beatOrigin("future-01", newer)).toEqual({ role: "peer", token: "quantum" });
  });

  test("a beat is dated by when we heard it — the age a liveness row is made of", () => {
    const heard = { seq: 4, at: 10_000 };
    expect(beatAgeMs(heard, 10_000)).toBe(0);
    expect(beatAgeKey(beatAgeMs(heard, 10_000))).toBe("robot.beatNow");
    // 3 s later the same beat is 3 s old: the row can tell a beating peer from a silent one.
    expect(beatAgeMs(heard, 13_000)).toBe(3_000);
    expect(beatAgeKey(beatAgeMs(heard, 13_000))).toBe("robot.beatAgo");
    // …and one we never heard from has no age at all (never a fabricated 0).
    expect(beatAgeMs(undefined, 13_000)).toBeNull();
    expect(beatAgeKey(beatAgeMs(undefined, 13_000))).toBe("robot.beatUnknown");
    // A moment this console never observed cannot date anything (a clock set backwards).
    expect(beatAgeMs(heard, 9_000)).toBeNull();
  });

  test("offline: no bridge ⇒ the command is not sent (null), never a fake receipt", async () => {
    expect(await robotCommand("patrol-01", '{"action":"estop"}')).toBeNull();
  });
});

describe("robotCommandMany: the fleet stop reports per robot and abandons nobody", () => {
  const setWin = (v: unknown) => {
    (globalThis as { window?: unknown }).window = v;
  };
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("a mid-fleet refusal is a datum, not the end of the loop", async () => {
    // The shape this pins: a fleet stop that `return`s (or throws) at the first robot it cannot
    // reach leaves the robots *behind* that one un-stopped — a stop that stops part of the fleet
    // is worse than one that reports it did. Every robot must be attempted, and the two lists
    // must name which is which.
    const seen: string[] = [];
    setWin({
      __TAURI_INTERNALS__: {
        invoke: async (_cmd: string, args: { robot: string }) => {
          seen.push(args.robot);
          // patrol-02 is unreachable — the bridge answers `Err`, which `invoke` folds to `null`.
          return args.robot === "patrol-02"
            ? null
            : { seq: 1, matched: 0, delivered: 0, dropped: 0 };
        },
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    });

    const r = await robotCommandMany(
      ["patrol-01", "patrol-02", "patrol-03"],
      '{"action":"estop"}',
    );
    // patrol-03 was attempted *after* the refusal.
    expect(seen).toEqual(["patrol-01", "patrol-02", "patrol-03"]);
    expect(r.sent).toEqual(["patrol-01", "patrol-03"]);
    expect(r.failed).toEqual(["patrol-02"]);
    expect(fleetSummary(r)).toBe("sent=2 not-sent=1");
  });

  test("offline: every robot is reported as not sent, and the two zeros stay apart", async () => {
    // No bridge: the whole fleet is un-sent. This is the direction that matters for honesty — a
    // receipt that only listed successes would show an empty panel, which reads as 「no fleet」
    // rather than 「the stop reached nobody」.
    const r = await robotCommandMany(["patrol-01", "patrol-02"], '{"action":"estop"}');
    expect(r.sent).toEqual([]);
    expect(r.failed).toEqual(["patrol-01", "patrol-02"]);
    expect(fleetSummary(r)).toBe("sent=0 not-sent=2");
    // A third thing again: a fleet with no robots in it is neither of the above, and a summary
    // that printed only one half would render it identically to a total failure.
    expect(fleetSummary({ sent: [], failed: [] })).toBe("sent=0 not-sent=0");
  });
});

describe("heartbeats: the listener once per window, the stream on every ask", () => {
  const setWin = (v: unknown) => {
    (globalThis as { window?: unknown }).window = v;
  };
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("no bridge ⇒ no listener and no stream, and no command is issued", async () => {
    // REQ-A838 / F-SH-267: the Rust side spawns a never-ending `StreamHeartbeats` task. The
    // existing cleanup stops it; the same invariant binds the other way — it must not be
    // *started* unless the listener is up, or the stream emits into a window with no reader
    // and the panel shows a dead link as a quiet one. Off-bridge there is no listener at all.
    expect(await listenHeartbeats(() => {})).toBeNull();
    expect(await startHeartbeats()).toBe(false);
  });

  test("refused listen ⇒ null (the caller then has no reason to ask for a stream)", async () => {
    const invoked: string[] = [];
    setWin({
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          invoked.push(cmd);
          return null;
        },
        listen: async () => {
          throw new Error("event plugin refused the registration");
        },
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    });

    expect(await listenHeartbeats(() => {})).toBeNull();
    expect(invoked).not.toContain("link_watch_heartbeats");
  });

  test("established listen ⇒ a cleanup that drops the listener and releases this window's claim", async () => {
    const invoked: string[] = [];
    let unlistened = 0;
    setWin({
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          invoked.push(cmd);
          return null;
        },
        listen: async () => () => {
          unlistened += 1;
        },
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    });

    const stop = await listenHeartbeats((b) => void b);
    expect(stop).not.toBeNull();
    stop!();
    expect(unlistened).toBe(1);
    // Dropping only the listener would leave the host emitting into a closed window. The stop is
    // safe to send unconditionally now that the host keys claims by window: a console that holds
    // no claim cannot release another one's.
    expect(invoked).toContain("link_stop_heartbeats");
  });

  test("the stream half reads the host's verdict, and a refused start is `false` (REQ-A844)", async () => {
    // REQ-A844 / F-LK-027: `link_watch_heartbeats` has to reach the daemon and open the stream, and
    // `link.rs` answers `Err` (giving this window's claim back) when it cannot. `invoke` turns that
    // `Err` into a `null` reply — the same value a `void` command answers on success — so the
    // verdict has to come from the per-command diagnosis. A `true` here would be a live-looking
    // channel running nothing, which is the state the caller's three-state panel exists to refuse.
    setWin({
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          if (cmd === "link_watch_heartbeats") throw new Error("daemon unreachable");
          return null;
        },
        listen: async () => () => {},
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    });

    expect(await startHeartbeats()).toBe(false);

    let ok = 0;
    setWin({
      __TAURI_INTERNALS__: {
        invoke: async () => {
          ok += 1;
          return null;
        },
        listen: async () => () => {},
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    });
    expect(await startHeartbeats()).toBe(true);
    expect(ok).toBe(1);
  });

  test("the stream half does not memoise: every ask reaches the host", async () => {
    // The console asks again on every poll, because a stream that ended under a still-open window
    // (the daemon restarted) is restarted by the *next ask* — nothing else can tell this window
    // that its stream died. So "already started" must not become a local flag: the host is the one
    // that knows, and it answers an ask against a live stream by sharing it (no second stream, no
    // daemon round trip). A cached `started` here would silently restore the freeze.
    let asked = 0;
    setWin({
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          if (cmd === "link_watch_heartbeats") asked += 1;
          return null;
        },
        listen: async () => () => {},
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    });

    expect(await startHeartbeats()).toBe(true);
    expect(await startHeartbeats()).toBe(true);
    expect(await startHeartbeats()).toBe(true);
    expect(asked).toBe(3);
  });
});
