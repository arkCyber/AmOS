import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { DEVICE_HOLDS, osHoldsAlarm } from "../lib/shortcutSchedule";
import { startShortcutTriggers } from "../svelte/osShortcutTriggers";
import { clearDiag, recentDiag } from "../lib/debugLog";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

/**
 * The shell's shortcut-trigger runtime vs the per-trigger **OS** outcome the Rust host
 * answers with (`amos-tauri/src/shortcut_triggers.rs` → `alarm_sched::DeviceOutcome`).
 *
 * `syncTimeTriggers` returns what the ledger armed *and* what the OS did with each one.
 * `lib/shortcutSchedule.ts` declared the outcome ("the phone will not wake") but the shell's
 * only consumer — `svelte/osShortcutTriggers.ts::syncPlan` — read just `reply.rejected` (a
 * *parse* refusal) and dropped `reply.armed[].device`, so a device that refuses exact alarms
 * (`disallowed`) left every time-trigger silently believed armed: the automation does not
 * fire while the phone dozes, and nothing said why. These cases pin the wiring and the
 * vocabulary against the Rust authority (REQ-A773).
 */

const RUST_ROOT = "../../../../";
const readRust = (rel: string): string =>
  readFileSync(new URL(RUST_ROOT + rel, import.meta.url), "utf8");
const readLib = (rel: string): string =>
  readFileSync(new URL("../lib/" + rel, import.meta.url), "utf8");

/** Install a Tauri bridge answering `shortcuts_trigger_sync` with `reply`. */
function installBridge(reply: unknown): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) =>
      cmd === "shortcuts_trigger_sync" ? reply : cmd === "shortcuts_trigger_poll" ? { due: [] } : null,
    listen: async () => async () => {},
  };
}
function goOffline(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
}

/** Let the `syncPlan` promise chain (invoke → .then) settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** The `shortcuts`-area warnings recorded so far. */
const shortcutWarns = () =>
  recentDiag().filter((e) => e.level === "warn" && e.area === "shortcuts");

let stop: (() => void) | null = null;

beforeEach(() => {
  clearDiag();
  window.localStorage.clear();
});
afterEach(() => {
  stop?.();
  stop = null;
  goOffline();
  window.localStorage.clear();
});

describe("the shell surfaces a trigger the OS refused (REQ-A773)", () => {
  test("`disallowed` is reported by name, not rounded up to armed", async () => {
    installBridge({
      armed: [{ key: "a:t1", atMs: 1, device: { state: "disallowed" } }],
      rejected: [],
      canceled: [],
    });
    stop = startShortcutTriggers();
    await flush();

    const line = shortcutWarns().find((e) => e.msg.includes("a:t1"));
    expect(line, "the refused trigger must be surfaced").toBeDefined();
    expect(line?.msg).toContain("disallowed");
  });

  test("`host_only` (the honest desktop answer) is not a refusal and is not warned about", async () => {
    // The ledger + the WebView heartbeat *are* the mechanism on a host with no
    // `AlarmManager`; warning here would be a false alarm, not honesty.
    installBridge({
      armed: [
        { key: "a:t1", atMs: 1, device: { state: "scheduled" } },
        { key: "a:t2", atMs: 2, device: { state: "host_only" } },
      ],
      rejected: [],
      canceled: [],
    });
    stop = startShortcutTriggers();
    await flush();

    expect(shortcutWarns().filter((e) => /a:t[12]/.test(e.msg))).toEqual([]);
  });
});

/**
 * The OS-outcome vocabulary `lib/shortcutSchedule.ts` and `lib/backend.ts` re-spell, bound
 * to its Rust authority. `alarm_sched.rs` already pins its own words (Kotlin glue ↔ Rust);
 * this pins the frontend to the same enum so a rename cannot silently strand a state the UI
 * branches on (`osHoldsAlarm`, ClockApp's `disallowed` banner).
 */
describe("the OS-outcome vocabulary == amos-tauri `alarm_sched::DeviceOutcome`", () => {
  const SRC = readRust("amos-tauri/src/alarm_sched.rs");
  const BACKEND = readLib("backend.ts");

  const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const sort = (xs: readonly string[]) => [...xs].sort();

  /** The enum's variant names, from `pub enum DeviceOutcome {` to its closing brace. */
  function variants(src: string): string[] {
    const i = src.indexOf("pub enum DeviceOutcome {");
    expect(i).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("\n}", i));
    return [...body.matchAll(/^\s{4}(\w+)(?:\(|,)/gm)].map((m) => m[1] ?? "");
  }

  /** The variants `keeps_ledger` names inside `matches!(self, …)`. */
  function keepsLedger(src: string): string[] {
    const i = src.indexOf("fn keeps_ledger");
    expect(i).toBeGreaterThan(0);
    const m = /matches!\(self,\s*([\s\S]*?)\)/.exec(src.slice(i, i + 400));
    expect(m).not.toBeNull();
    return [...(m?.[1] ?? "").matchAll(/DeviceOutcome::(\w+)/g)].map((x) => snake(x[1] ?? ""));
  }

  const words = variants(SRC).map(snake);

  test("`osHoldsAlarm` is exactly Rust's `keeps_ledger` set, and rejects every other state", () => {
    // Guard: the scan found the real table (eight variants), not an empty window.
    expect(words).toHaveLength(8);
    const kept = keepsLedger(SRC);
    expect(sort(kept)).toEqual(sort([...DEVICE_HOLDS]));

    // Every enum word is classified the way Rust classifies it — a rename on either side
    // that changed the answer here would fail, not silently accept a working alarm.
    for (const w of words) {
      expect(osHoldsAlarm(w), `osHoldsAlarm(${w})`).toBe(kept.includes(w));
    }
    // …and an unrecognised token fails safe (not armed), never benign.
    expect(osHoldsAlarm("something_new")).toBe(false);
  });

  test("the `NativeAlarmDeviceState` union lists exactly the enum's serde words", () => {
    // The second re-spelling (the native-alarm bridge): a rename that misses it would make
    // `state` a free string and strand ClockApp's `disallowed` banner.
    const at = BACKEND.indexOf('state: "host_only"');
    expect(at, "the alarm-state union not found in backend.ts").toBeGreaterThan(0);
    const line = BACKEND.slice(at, BACKEND.indexOf(";", at));
    const union = [...line.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
    expect(sort(union)).toEqual(sort(words));
  });
});
