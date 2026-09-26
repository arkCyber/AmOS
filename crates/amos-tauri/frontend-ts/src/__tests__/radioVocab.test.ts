import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { radioRefusalView } from "../lib/radioControl";
import { RADIO_KEYS, tapRadio, type RadioCommands } from "../lib/quickRadio";
import { flipRadio } from "../lib/settings";

/**
 * The quick-settings radio vocabulary the frontend re-spells, vs the Rust authority that
 * defines it (`crates/amos-radio`).
 *
 * `lib/radioControl.ts` turns the machine tokens a `radio_set` refusal carries into the
 * sentence a screen shows; `lib/quickRadio.ts` fixes the order the tiles render in. Both
 * are mirrors of vocabularies `crates/amos-radio` owns and the bridge passes through
 * verbatim (`crates/amos-tauri/src/radio.rs`):
 *
 *   * `RadioError::kind()` — the refusal tokens (`airplane_active`, `provider_refused`,
 *     `unsupported`, `platform_managed`). The Rust side pins its own tokens
 *     (`error.rs::every_failure_kind_has_one_stable_token`); the screen side did not. A
 *     rename or a new variant on the Rust side leaves `radioRefusalView` returning `""`
 *     and every frontend test green — the tile tap reports `applied: false` and *nothing
 *     else*, i.e. the exact "the interface says nothing" defect this repo gates against.
 *   * `RadioMode::ALL` / `RadioMode::key()` — the four radios, in order. `quickRadio.ts`'s
 *     `RADIO_KEYS` re-lists them as a literal.
 *
 * These read the **source** (the declarations), not a runtime — a drift in the Rust
 * *implementation* is out of scope; what is in scope is that the two vocabularies are the
 * same set of strings at build time instead of discovered on a device.
 *
 * (REQ-A770 / F-SH-226; same family as the rotation mirror REQ-A765 and the e-stop-reason
 * mirror REQ-A767 — a declared cross-language mirror that only the frontend's own local
 * literals were pinning.)
 */

const RUST_ROOT = "../../../../";

function readRust(rel: string): string {
  return readFileSync(new URL(RUST_ROOT + rel, import.meta.url), "utf8");
}

function readLib(rel: string): string {
  return readFileSync(new URL("../lib/" + rel, import.meta.url), "utf8");
}

const ERROR_RS = readRust("amos-radio/src/error.rs");
const STATE_RS = readRust("amos-radio/src/state.rs");
const CONTROL_TS = readLib("radioControl.ts");

/** Every machine token `RadioError::kind()` can return, scanned from its match body. */
function radioKindTokens(src: string): string[] {
  const i = src.indexOf("pub fn kind");
  expect(i).toBeGreaterThan(0);
  const end = src.indexOf("\n    }", i);
  expect(end).toBeGreaterThan(i);
  return [...src.slice(i, end).matchAll(/=>\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
}

/** The `RadioMode::Variant => "wire key"` arms of `RadioMode::key()`: variant → key. */
function radioKeyArms(src: string): Map<string, string> {
  return new Map(
    [...src.matchAll(/RadioMode::(\w+)\s*=>\s*"([a-z_]+)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

/** The ordered wire keys of `RadioMode::ALL`, resolved through the `key()` arms. */
function radioAllOrder(src: string, keys: Map<string, string>): string[] {
  const i = src.indexOf("const ALL");
  expect(i).toBeGreaterThan(0);
  const end = src.indexOf("];", i);
  expect(end).toBeGreaterThan(i);
  return [...src.slice(i, end).matchAll(/RadioMode::(\w+)/g)].map((m) => {
    const key = keys.get(m[1] ?? "");
    // A variant in `ALL` with no `key()` arm means the scan window missed the table — fail
    // loudly rather than compare against a hole.
    expect(key).toBeDefined();
    return key ?? "";
  });
}

/**
 * The refusal tokens `radioControl.ts` handles: the `REFUSAL_KEYS` map keys, plus the one
 * token it special-cases as a literal branch (`refusal.kind === "platform_managed"`, whose
 * sentence depends on the refused radio, so it cannot live in the flat map).
 */
function frontendRefusalTokens(src: string): string[] {
  const i = src.indexOf("const REFUSAL_KEYS");
  expect(i).toBeGreaterThan(0);
  const end = src.indexOf("};", i);
  expect(end).toBeGreaterThan(i);
  const mapKeys = [...src.slice(i, end).matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1] ?? "");
  const branch = /refusal\.kind === "([a-z_]+)"/.exec(src);
  expect(branch).not.toBeNull();
  return [...mapKeys, branch?.[1] ?? ""];
}

const sort = (xs: readonly string[]) => [...xs].sort();

const kindTokens = radioKindTokens(ERROR_RS);
const keyArms = radioKeyArms(STATE_RS);
const allOrder = radioAllOrder(STATE_RS, keyArms);
const feTokens = frontendRefusalTokens(CONTROL_TS);

describe("the quick-settings refusal vocabulary == `RadioError::kind()`", () => {
  test("every kind the Rust core can answer is one the screen can explain", () => {
    // Guard: a rewrite that moved the match arms out of the scanned window must not turn
    // this into a vacuous pass — `kind()` has exactly four variants.
    expect(kindTokens).toHaveLength(4);
    // An empty `noteKey` here is the defect: the refusal reached the screen and the screen
    // had nothing to say (it may report `applied: false`, but not *why*). Naming the tokens
    // in the failure keeps a rename from being a mystery.
    const unexplained = kindTokens.filter(
      (token) => radioRefusalView({ kind: token, radio: "wifi" }, "wifi").noteKey === "",
    );
    expect(unexplained).toEqual([]);
  });

  test("the screen handles exactly the kinds the core can answer — no more, no less", () => {
    // The reverse direction: a token the screen still handles after Rust stopped emitting it
    // is dead copy that can never render, and it hides the fact that a *new* core token has
    // no sentence. The two sets must be the same set, not merely overlap.
    expect(feTokens.length).toBeGreaterThan(0);
    expect(sort(kindTokens)).toEqual(sort(feTokens));
  });
});

describe("the quick-settings radio order == `RadioMode::ALL`", () => {
  test("`RADIO_KEYS` is the four radios `RadioMode::ALL` names, in the same order", () => {
    // Guard: the scans found the real tables, not empty windows (`key()` has four arms).
    expect(keyArms.size).toBe(4);
    expect(allOrder).toHaveLength(4);
    expect([...RADIO_KEYS] as string[]).toEqual(allOrder);
  });
});

// REQ-A1012：把「谁的开关归 Airplane 管」这条**策略**也绑到权威上。上面两组绑的是**词汇**
// （拒绝 token、四台无线电的顺序）；这条策略是 `settings.ts::flipRadio` 的文档注释亲口声明的
// ——「mirroring the Rust `RadioManager` policy used when the Tauri backend is available (so an
// unbridged UI behaves identically)」—— 而 `quickRadio.ts` 的 gated 分支同样自称如此。
// 两份声明都没有读者：`RadioManager` 的**级联集合**与**门禁集合**（`refuse_enabling_under_airplane`
// 的调用点）没有任何测试读过。Rust 若把 Hotspot 加进级联（或从门禁里拿走），离线 UI 仍按旧策略
// 走，于是**同一次点击在有无守护进程时行为不同** —— 而各处兜底（持久化的开关位、tile 上不动的
// 状态）会让这次漂移看起来像一次「设备没反应」，而不是一次版本错位。
describe("the Airplane-mode policy == `RadioManager::set` (REQ-A1012)", () => {
  const MANAGER_RS = readRust("amos-radio/src/manager.rs");

  /** The radios Airplane switches **off** when it goes on: the array `set()` iterates. */
  function rustCascade(src: string): string[] {
    const i = src.indexOf("for member in [");
    expect(i).toBeGreaterThan(0);
    const end = src.indexOf("]", i);
    expect(end).toBeGreaterThan(i);
    return [...src.slice(i, end).matchAll(/RadioMode::(\w+)/g)].map((m) => {
      const key = keyArms.get(m[1] ?? "");
      expect(key, `no key() arm for ${m[1]}`).toBeDefined();
      return key ?? "";
    });
  }

  /**
   * The radios the policy **refuses** while Airplane is on: every match arm routed through
   * `refuse_enabling_under_airplane`. The `Airplane` arm deliberately is not one (it owns the
   * bit). The guard gates **enabling** only (REQ-A1773), and this scan reads the arm's own call
   * site — which is the `if on` branch the caller already sits in.
   */
  function rustGate(src: string): string[] {
    return [...src.matchAll(/self\.refuse_enabling_under_airplane\(RadioMode::(\w+)\)/g)].map((m) => {
      const key = keyArms.get(m[1] ?? "");
      expect(key, `no key() arm for ${m[1]}`).toBeDefined();
      return key ?? "";
    });
  }

  const rustCascadeKeys = rustCascade(MANAGER_RS);
  const rustGateKeys = rustGate(MANAGER_RS);

  // The frontend side is derived from what `flipRadio` **does**, not from its source text:
  // that is the binding the doc comment claims, and it survives a rewrite of the function.
  const allRadiosOn = { wifi: true, bluetooth: true, hotspot: true } as const;
  const afterAirplaneOn = flipRadio(allRadiosOn, "airplane");
  const tsCascadeKeys = RADIO_KEYS.filter(
    (k) => k !== "airplane" && afterAirplaneOn[k] === false,
  );

  test("the radios Airplane turns off == the Rust cascade array", () => {
    // Guard: both scans found a real window rather than an empty one.
    expect(rustCascadeKeys).toHaveLength(3);
    expect(tsCascadeKeys.length).toBeGreaterThan(0);
    expect([...tsCascadeKeys].sort() as string[]).toEqual([...rustCascadeKeys].sort());
  });

  test("the radios refused while Airplane is on == the Rust `refuse_enabling_under_airplane` arms", () => {
    // Guard: the gate is a *strict, non-empty subset* of the radios — if it silently became
    // empty (a rewrite moving the calls out of the scanned window) both sides must still agree
    // *and* the window guard must notice. `set()` gates exactly the non-Airplane radios.
    expect(rustGateKeys).toHaveLength(3);
    const airplaneOn = { airplane: true } as const;
    const tsGateKeys = RADIO_KEYS.filter(
      (k) => k !== "airplane" && flipRadio(airplaneOn, k) === airplaneOn,
    );
    expect(tsGateKeys).toHaveLength(3);
    expect([...tsGateKeys].sort() as string[]).toEqual([...rustGateKeys].sort());
  });

  test("`tapRadio` refuses every gated radio **without asking the host**", async () => {
    // The second consumer of the same policy: the orchestrator must answer `gated` (nothing
    // changed, nothing persisted) and must not attempt a write it knows the device would
    // refuse. A throwing port proves the branch returned before any command.
    const exploding: RadioCommands = {
      set: () => {
        throw new Error("radio_set must not be attempted while Airplane is on");
      },
      status: () => {
        throw new Error("radio_status must not be needed for a gated tap");
      },
      control: () => {
        throw new Error("radio_control must not be attempted for a gated tap");
      },
      openSettings: () => {
        throw new Error("radio_open_settings must not be attempted for a gated tap");
      },
    };
    for (const k of RADIO_KEYS) {
      if (k === "airplane") continue;
      const out = await tapRadio({ key: k, settings: { airplane: true }, host: true, cmds: exploding });
      expect(out, `${k} while Airplane is on`).toMatchObject({ kind: "gated", persist: false });
    }
    // Control: with Airplane off the same port IS reached — so the assertion above is not
    // passing merely because `tapRadio` ignores its `cmds`.
    await expect(
      tapRadio({ key: "wifi", settings: { airplane: false }, host: true, cmds: exploding }),
    ).rejects.toThrow(/radio_set must not be attempted/);
  });
});
