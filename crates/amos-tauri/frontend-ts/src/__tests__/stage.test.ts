/**
 * Stage Manager 桥接层（`lib/stage.ts`）—— 命令接线、回包收窄、拒绝措辞。
 *
 * 纯逻辑 + 一个假宿主，不渲染组件（组件那半在 `svelte-tests/stage-rail.svelte.test.ts`）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  normalizeStageSnapshot,
  stageArrange,
  stageBring,
  stageFailure,
  stagePark,
  stageSetEnabled,
  stageSnapshot,
  type StageSnapshot,
} from "../lib/stage";
import { bridgeDiag } from "../lib/backend";
import { clearDiag } from "../lib/debugLog";

/**
 * The host's own `amos.stage.*` wire codes, read from the Rust that emits them
 * (`crates/amos-tauri/src/error.rs`, `ErrorCode::as_str`).
 *
 * Read, not hand-listed. The literal array below is a *sample* — it pins the sentences —
 * but a hand-copied family list cannot make the completeness claim its own title makes,
 * and the family's last code (`amos.stage.persist_failed`) is the proof: it arrived in
 * `lib/stage.ts` and in the array below, and was left out of `store-allowlist.json`, so
 * `scripts/store-scan.mjs` was red while every test stayed green (REQ-A1700 ∕ F-DEV-145).
 */
const ERROR_RS = readFileSync(new URL("../../../src/error.rs", import.meta.url), "utf8");
const STORE_ALLOWLIST = JSON.parse(
  readFileSync(new URL("../../scripts/store-allowlist.json", import.meta.url), "utf8"),
) as { keys: Array<{ key: string; kind: string }> };

/** Every distinct `amos.stage.*` code `error.rs` can put on the wire, sorted. */
function hostStageCodes(): string[] {
  const found = [...ERROR_RS.matchAll(/"(amos\.stage\.[a-z0-9_]+)"/g)].map((m) => m[1]!);
  return [...new Set(found)].sort();
}

type Call = { command: string; args?: Record<string, unknown> };
let realWindow: unknown;
let calls: Call[] = [];
/** What the fake host answers with — a function so a case can make it throw. */
let respond: () => unknown;

const SNAP: StageSnapshot = {
  enabled: true,
  on_stage: [{ label: "files_2", app: "files", instance: 2 }],
  parked: [{ label: "notes", app: "notes", instance: 1 }],
};

function setWindow(obj: unknown) {
  (globalThis as { window?: unknown }).window = obj;
}

beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
  calls = [];
  respond = () => SNAP;
  clearDiag();
  setWindow({
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return respond();
      },
    },
  });
});

afterEach(() => {
  setWindow(realWindow);
});

/** Make the fake host refuse the next call the way a Rust `Err` arrives at `invoke`. */
function refuse(code: string, message = "refused") {
  respond = () => {
    throw { code, message };
  };
}

describe("stage command wrappers", () => {
  test("each command reaches its own name with its own args", async () => {
    await stageSnapshot();
    expect(calls[0]).toEqual({ command: "stage_snapshot", args: undefined });

    await stageSetEnabled(true);
    expect(calls[1]).toEqual({ command: "stage_set_enabled", args: { enabled: true } });

    await stagePark("notes");
    expect(calls[2]).toEqual({ command: "stage_park", args: { label: "notes" } });

    await stageBring("notes");
    expect(calls[3]).toEqual({ command: "stage_bring", args: { label: "notes" } });

    await stageArrange();
    expect(calls[4]).toEqual({ command: "stage_arrange", args: undefined });
  });

  /**
   * 成功是**对象**、拒绝是 `null` —— 五个命令都返回 `Result<StageSnapshot, _>`，所以这里
   * 不会踩到 `spaces.ts` 记录的"单位返回的命令判据恒假"那个陷阱。
   */
  test("a reply the host refused reads as null, and a reply it gave reads as the snapshot", async () => {
    expect(await stageSnapshot()).toEqual(SNAP);
    refuse("amos.stage.disabled");
    expect(await stagePark("notes")).toBeNull();
    // 原因仍在台账里（按命令名保留最近一次读数）—— 界面读句子走 `stageFailure`。
    expect(bridgeDiag("stage_park").ok).toBe(false);
  });

  test("every reply is narrowed, never trusted", async () => {
    respond = () => ({
      enabled: "yes",
      // Not a field of `StageSnapshot` any more (REQ-A1563): the rail's width is a layout
      // fact, so a payload that still carried one must not resurrect it as a second reading.
      rail_width: 180,
      on_stage: ["not-a-record", { label: "files", app: "files", instance: 1 }],
      parked: [{ app: "notes" }, null, { label: "notes", app: "notes", instance: 1 }],
    });
    const s = await stageSnapshot();
    expect(s).toEqual({
      // `"yes"` is not `true`: a malformed payload must not turn the rail on.
      enabled: false,
      // The string entry is dropped, the record kept.
      on_stage: [{ label: "files", app: "files", instance: 1 }],
      // A record with no label cannot be addressed by any command, so it is dropped —
      // an unnamed tile would be a dead button.
      parked: [{ label: "notes", app: "notes", instance: 1 }],
    });
    expect(Object.keys(s ?? {}).sort()).toEqual(["enabled", "on_stage", "parked"]);
  });

  test("a payload that is not even an object degrades to an empty, off stage", () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      const s = normalizeStageSnapshot(bad);
      expect(s.enabled).toBe(false);
      expect(s.on_stage).toEqual([]);
      expect(s.parked).toEqual([]);
    }
  });
});

describe("stageFailure — the one rule that turns a typed code into a sentence", () => {
  test("every amos.stage.* code has its own key", async () => {
    const cases: Array<[string, string]> = [
      ["amos.stage.disabled", "stage.errorDisabled"],
      ["amos.stage.unsupported", "stage.errorUnsupported"],
      ["amos.stage.window_unknown", "stage.errorWindowUnknown"],
      ["amos.stage.window_is_screen", "stage.errorWindowIsScreen"],
      ["amos.stage.window_in_split", "stage.errorWindowInSplit"],
      ["amos.stage.arrange_impossible", "stage.errorArrangeImpossible"],
      ["amos.stage.lock_failed", "stage.errorLockFailed"],
      // The family's last wire code. It was absent from both this list and `stageFailure`,
      // so the title's "every amos.stage.* code" was true of the data and false of the
      // implementation — the fix is the arm, and this row is what keeps the title honest
      // (REQ-A1683).
      ["amos.stage.persist_failed", "stage.errorPersistFailed"],
    ];
    for (const [code, key] of cases) {
      refuse(code);
      expect(await stagePark("notes")).toBeNull();
      expect(stageFailure("stage_park")).toEqual({ key });
    }
  });

  /**
   * The completeness half of the claim above, derived from the host rather than listed.
   *
   * Two obligations for every code the host can actually send, both of which the last
   * arrival met for only one of its two homes: it is mapped here (the family's one rule
   * says it turns *every* `amos.stage.*` code into a sentence), and it is classified in
   * `scripts/store-allowlist.json` (a `case "amos.stage.…"` literal looks like a store
   * key to `store-scan` — REQ-A1396's rule). A code that gains a switch arm but not an
   * allow-list entry reds the gate; before this test only the gate said so, and only if
   * it was run.
   */
  test("every amos.stage.* code the host can send is both mapped and classified", async () => {
    const codes = hostStageCodes();
    // Positive control: the Rust read really found the family — an empty list (a moved
    // file, a changed spelling) must not pass the loop vacuously.
    expect(codes.length).toBeGreaterThan(0);
    const classified = new Map(STORE_ALLOWLIST.keys.map((k) => [k.key, k.kind]));
    for (const code of codes) {
      refuse(code);
      expect(await stagePark("notes")).toBeNull();
      expect(stageFailure("stage_park").key).not.toBe("stage.errorUnknown");
      expect(classified.get(code)).toBe("host-error-code");
    }
  });

  test("an unrecognised code keeps the host's own sentence instead of inventing a cause", async () => {
    refuse("amos.stage.something_new", "the host's own words");
    expect(await stageArrange()).toBeNull();
    expect(stageFailure("stage_arrange")).toEqual({
      key: "stage.errorUnknown",
      hostMessage: "the host's own words",
    });
  });

  test("a command whose last word in the ledger is 'fine' has nothing to map", () => {
    // `stage_bring` was called successfully above and never refused, so the ledger's last
    // word on it is `{ ok: true }` — the caller's own `null` check is the authority here,
    // and this reports the neutral sentence rather than a cause nobody observed.
    expect(bridgeDiag("stage_bring")).toEqual({ ok: true });
    expect(stageFailure("stage_bring")).toEqual({ key: "stage.errorUnknown" });
  });
});
