import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QUADRUPED_ACTIONS, ROBOT_PEER_KIND } from "../lib/robot";
import { estopReasonKey } from "../lib/link";

/**
 * The robot console's action palette vs the Rust authority that accepts it.
 *
 * `lib/robot.ts` declares `QUADRUPED_ACTIONS` as "the `action` keys `Platform::quadruped()`
 * accepts", and derives two more claims per entry — `motion` (a speed slider applies) and
 * `safety` (the arm/estop pair, its own group). `robot.test.ts` pinned all three against a
 * **literal list in the test**, i.e. the frontend against itself: rename a gait on the Rust side
 * and the console offers a dead button (or a gait the machine never had) with every test green.
 *
 * Two Rust authorities define the vocabulary, and the console must agree with **both**:
 *
 *   * `robot_hal::Gait` — the vocabulary the **shipping** bridge holds (`Vocabulary::Reference`,
 *     `RobotBridge::new`). `Gait::key()` is the wire string `parse_command` accepts, and
 *     `is_motion()` / `is_arm()` / `is_emergency()` are the classification the console's two
 *     flags mirror (`motion` ⇔ `is_motion`, `safety` ⇔ `is_arm() || is_emergency()`).
 *   * `platform::QUADRUPED_ACTIONS` — `Platform::quadruped()`'s table, which the module comment
 *     names; `parse_intent` accepts exactly these keys, and its per-entry `speed_scaled` is what
 *     decides whether a `speed` field is honoured or refused.
 *
 * These read the **source** (the declarations), not a runtime — a drift in either side's
 * *implementation* is out of scope here; what is in scope is that the two vocabularies are the
 * same set of strings at build time instead of discovered on a robot.
 */

const RUST_ROOT = "../../../../";

function readRust(rel: string): string {
  return readFileSync(new URL(RUST_ROOT + rel, import.meta.url), "utf8");
}

const HAL = readRust("amos-link/src/robot_hal.rs");
const PLATFORM = readRust("amos-link/src/platform.rs");
const DISCOVERY = readRust("amos-link/src/discovery.rs");

/** The `Gait::Variant => "wire key"` arms of `Gait::key()`: the variant → wire string map. */
function gaitKeyArms(src: string): Map<string, string> {
  return new Map(
    [...src.matchAll(/Gait::(\w+)\s*=>\s*"([a-z][a-z-]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

/** The wire keys of the `Gait::Variant` set a `matches!(self, …)` predicate names. */
function predicate(src: string, decl: string, keys: Map<string, string>): string[] {
  const i = src.indexOf(decl);
  expect(i).toBeGreaterThan(0);
  const m = /matches!\(self,\s*([\s\S]*?)\)/.exec(src.slice(i, i + 400));
  expect(m).not.toBeNull();
  return [...(m?.[1] ?? "").matchAll(/Gait::(\w+)/g)].map((x) => {
    const wire = keys.get(x[1] ?? "");
    // A variant with no `key()` arm means the scan window missed the table — fail loudly
    // rather than compare against a hole.
    expect(wire).toBeDefined();
    return wire ?? "";
  });
}

/** A `const NAME: … = &[ … ];` block, from its name to the closing `];`. */
function constBlock(src: string, decl: string): string {
  const i = src.indexOf(decl);
  expect(i).toBeGreaterThan(0);
  const end = src.indexOf("\n];", i);
  expect(end).toBeGreaterThan(i);
  return src.slice(i, end);
}

/** The `key: "…"` strings of an `ActionSpec` table. */
function actionKeys(block: string): string[] {
  return [...block.matchAll(/key:\s*"([a-z][a-z-]*)"/g)].map((m) => m[1] ?? "");
}

/**
 * The `key: "…"` → `speed_scaled: bool` pairs of an `ActionSpec` table.
 *
 * `speed_scaled` is the property `Platform::parse_intent` actually reads when it refuses a
 * `speed` field (`platform.rs`: "action `{}` … has a fixed pose, so `speed` {} cannot be
 * honoured"); the non-greedy window pairs each key with the `speed_scaled` that follows it.
 */
function actionSpeedScaled(block: string): Map<string, boolean> {
  return new Map(
    [...block.matchAll(/key:\s*"([a-z][a-z-]*)"[\s\S]*?speed_scaled:\s*(true|false)/g)].map((m) => [
      m[1] ?? "",
      m[2] === "true",
    ]),
  );
}

/** The `NodeKind::Variant => "wire key"` arms of `NodeKind::key()`: the variant → wire string map. */
function nodeKindArms(src: string): Map<string, string> {
  return new Map(
    [...src.matchAll(/NodeKind::(\w+)\s*=>\s*"([a-z][a-z-]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

/**
 * The `EstopReason::Variant => "wire key"` arms of `EstopReason::key()`.
 *
 * Scanned from the `impl EstopReason` block only, so the mirrored arms of `from_key`
 * (`"commanded" => Some(…)`, variant on the *right*) cannot be mistaken for the authority.
 */
function estopReasonArms(src: string): Map<string, string> {
  const i = src.indexOf("impl EstopReason");
  expect(i).toBeGreaterThan(0);
  const end = src.indexOf("\n}", i);
  expect(end).toBeGreaterThan(i);
  return new Map(
    [...src.slice(i, end).matchAll(/EstopReason::(\w+)\s*=>\s*"([a-z][a-z-]*)"/g)].map((m) => [
      m[1] ?? "",
      m[2] ?? "",
    ]),
  );
}

const sort = (xs: readonly string[]) => [...xs].sort();

const tsKeys = QUADRUPED_ACTIONS.map((a) => a.key);
const tsMotion = QUADRUPED_ACTIONS.filter((a) => a.motion).map((a) => a.key);
const tsSafety = QUADRUPED_ACTIONS.filter((a) => a.safety).map((a) => a.key);

const gaitKeys = gaitKeyArms(HAL);
const halKeys = [...gaitKeys.values()];
const quadrupedKeys = actionKeys(constBlock(PLATFORM, "const QUADRUPED_ACTIONS"));

describe("the robot console's palette == the Rust vocabulary that accepts it", () => {
  test("the console's keys are exactly the reference gait vocabulary, and the quadruped table's", () => {
    // Guards: a rewrite that moved the match bodies out of the scanned window must not
    // turn these into a vacuous pass.
    expect(halKeys).toHaveLength(6);
    expect(quadrupedKeys).toHaveLength(6);
    expect(tsKeys).toHaveLength(6);

    expect(sort(tsKeys)).toEqual(sort(halKeys));
    expect(sort(tsKeys)).toEqual(sort(quadrupedKeys));
  });

  test("`motion` (a speed slider applies) is exactly the gaits that move", () => {
    const moving = predicate(HAL, "pub fn is_motion", gaitKeys);
    expect(moving).toHaveLength(4);
    expect(sort(tsMotion)).toEqual(sort(moving));
  });

  test("`motion` is exactly the actions the robot will accept a `speed` on", () => {
    // `actionJson` emits a `speed` field **iff** the entry is `motion`. The robot refuses a
    // speed on any action whose `speed_scaled` is false, so a `motion: true` entry the platform
    // does not speed-scale means every press of that button is refused — silently, on a host
    // with no robot on the wire.
    const scaled = actionSpeedScaled(constBlock(PLATFORM, "const QUADRUPED_ACTIONS"));
    expect(scaled.size).toBe(6);
    const acceptsSpeed = [...scaled].filter(([, s]) => s).map(([k]) => k);
    expect(acceptsSpeed).toHaveLength(4);
    expect(sort(tsMotion)).toEqual(sort(acceptsSpeed));
  });

  test("`safety` (the segregated pair) is exactly arm + estop", () => {
    const arm = predicate(HAL, "pub fn is_arm", gaitKeys);
    const emergency = predicate(HAL, "pub fn is_emergency", gaitKeys);
    expect(arm).toEqual(["arm"]);
    expect(emergency).toEqual(["estop"]);
    expect(sort(tsSafety)).toEqual(sort([...arm, ...emergency]));

    // motion and safety partition the palette: no key is both, and none is neither.
    expect(sort([...tsMotion, ...tsSafety])).toEqual(sort(tsKeys));
    expect(tsMotion.filter((k) => tsSafety.includes(k))).toEqual([]);
  });
});

/**
 * The console picks its target robots out of `link_status.peers` by comparing each peer's `kind`
 * against a literal. That literal is a second, cross-language mirror of a Rust authority —
 * `NodeKind::Robot.key()` (`crates/amos-link/src/discovery.rs`), which the daemon writes onto the
 * wire (`service.rs`) and the bridge folds through `NodeKind::wire_token` (`link.rs::peer_out`). A
 * re-spelling on either side drops the peer from the console's target list **silently** — a robot
 * that has only beaconed (never reported) simply is not there, and no suite notices.
 */
describe("the robot console's peer-kind filter == the Rust node-kind vocabulary", () => {
  test("`ROBOT_PEER_KIND` is exactly the key `NodeKind::Robot` writes", () => {
    const kinds = nodeKindArms(DISCOVERY);
    // Guard: a rewrite that moved the match bodies out of the scanned window must not make
    // this a vacuous pass (`NodeKind::ALL` has five variants).
    expect(kinds.size).toBe(5);
    expect(kinds.get("Robot")).toBe(ROBOT_PEER_KIND);
    // The constant is a key of the vocabulary, not a string that merely resembles one.
    expect([...kinds.values()]).toContain(ROBOT_PEER_KIND);
  });

  /**
   * `LinkPeer.kind` is documented as a **closed** set — the five roles the daemon writes, plus
   * `unknown`. That set is a declared mirror of `NodeKind` (`discovery.rs`): the five keys, and
   * the one token an unfamiliar role folds to (`UNKNOWN_KIND`, what the bridge now writes for a
   * newer daemon's role). A role added on the Rust side, or a re-spelt sentinel, would leave the
   * panel's documented vocabulary silently wrong — and the panel renders `kind` verbatim, so a
   * reader would see a word this UI has no vocabulary for.
   */
  test("the panel's `LinkPeer.kind` vocabulary == `NodeKind`'s keys plus the fold sentinel", () => {
    const kinds = [...nodeKindArms(DISCOVERY).values()];
    expect(kinds).toHaveLength(5);
    const unknown = /pub const UNKNOWN_KIND: &str = "([a-z-]+)"/.exec(DISCOVERY)?.[1];
    expect(unknown, "`UNKNOWN_KIND` is declared in discovery.rs").toBe("unknown");

    const lib = readFileSync(
      new URL(RUST_ROOT + "amos-tauri/frontend-ts/src/lib/link.ts", import.meta.url),
      "utf8",
    );
    const doc =
      /interface LinkPeer \{[\s\S]*?\/\*\*([\s\S]*?)\*\/\s*\n\s*kind: string;/.exec(lib)?.[1] ?? "";
    const documented = [...doc.matchAll(/`([a-z-]+)`/g)].map((m) => m[1] ?? "");
    expect(sort(documented)).toEqual(sort([...kinds, unknown ?? ""]));

    // The bridge really applies that fold (a `peer.kind.clone()` passthrough would make the
    // documented `unknown` token unreachable).
    expect(readRust("amos-tauri/src/link.rs")).toContain("NodeKind::wire_token(&peer.kind)");
  });
});

/**
 * The return-path row labels an e-stop with *why* torque was cut, keyed off the robot's own
 * `EstopReason::key()` token (`crates/amos-link/src/robot_hal.rs`) — the same token the CLI
 * prints as `estopped=true(watchdog)`. The panel's `estopReasonKey` re-spells those tokens in
 * TypeScript; if the robot renames one, the panel silently stops labelling it and the row is back
 * to a bare 「torque cut」 with no reason — the exact fact the return path exists to carry.
 */
describe("the panel's e-stop-reason labels == the robot's e-stop-reason vocabulary", () => {
  test("every reason `EstopReason::key()` writes is one the panel can label", () => {
    const reasons = estopReasonArms(HAL);
    // Guard: the scan found the real table (three variants), not an empty window — and the
    // count is pinned so a fourth variant forces this panel to be given a label deliberately,
    // rather than falling into `estopReasonKey`'s `default: null` (a bare 「torque cut」).
    expect(reasons.size).toBe(3);
    for (const token of reasons.values()) {
      expect(estopReasonKey(token)).not.toBeNull();
    }
    // The variants are told apart — all would pass the loop above even if they collapsed.
    expect(new Set([...reasons.values()].map((t) => estopReasonKey(t))).size).toBe(reasons.size);
  });
});
