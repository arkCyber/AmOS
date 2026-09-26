/**
 * session.test.ts — the host power/session wrappers (`src/lib/session.ts`, REQ-A515).
 *
 * The Rust side (`crates/amos-tauri/src/session.rs`) replies with a **`SessionPlan` object**
 * on success and hands the action to a detached `sh` only after the reply is written — a
 * restart must not power the machine off before the WebView can read the answer. These cases
 * pin the frontend half of that contract:
 *
 *   • each wrapper invokes its own **literal** command name (the command scan resolves
 *     consumers by static string — a table keyed by a variable would read as "nobody asks");
 *   • `invoke` returning `null` is **failure** (not-bridged / command-failed), and any
 *     non-null reply — including an empty object — is "the host scheduled it";
 *   • `sessionActionRunner` maps a row to one of those literal-`invoke` wrappers.
 *
 * No test here can restart anything: the delay and the spawn are the host's side.
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import {
  sessionRestartWithDiag,
  sessionShutdownWithDiag,
  sessionSleepWithDiag,
  sessionActionRunner,
  type SessionOutcome,
} from "../session";

type Recorded = { command: string; args: Record<string, unknown> | undefined };

let calls: Recorded[];
let respond: (command: string) => unknown;

/** Install a Tauri bridge whose `invoke` records every command and answers `respond`. */
function installBridge(): void {
  calls = [];
  respond = () => ({ unsupported_host: false, argv: ["sh", "-c", "sleep 2; reboot"], delay_secs: 2 });
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return respond(command);
      },
      listen: async () => () => {},
    },
  };
}

beforeEach(installBridge);
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** The commands a call actually reached, in order. */
const invoked = () => calls.map((c) => c.command);

describe("session.ts — the host scheduled the action", () => {
  it("each wrapper invokes its own literal command, once, with no arguments", async () => {
    expect(await sessionRestartWithDiag()).toEqual({ ok: true });
    expect(await sessionShutdownWithDiag()).toEqual({ ok: true });
    expect(await sessionSleepWithDiag()).toEqual({ ok: true });
    // Three zero-argument commands — nothing to name, nothing to validate (D2).
    expect(invoked()).toEqual(["session_restart", "session_shutdown", "session_sleep"]);
    for (const c of calls) expect(c.args).toBeUndefined();
  });

  it("a non-null reply is success — an empty object is not mistaken for failure", async () => {
    // Tauri serialises a Rust `()`
    // to `null`, so the wrapper keys on null-vs-object. Were it to inspect the object's
    // contents (e.g. `Object.keys(...).length`), a plan with no fields would read as a
    // failure and report a restart that *did* happen as one that did not (REQ-A513).
    respond = () => ({});
    expect(await sessionRestartWithDiag()).toEqual({ ok: true });
  });
});

describe("session.ts — the host refused or is absent", () => {
  it("an unbridged host is a failure carrying a not-bridged diagnostic", async () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    const out = await sessionSleepWithDiag();
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.diag).toEqual({ ok: false, kind: "not-bridged", command: "session_sleep" });
  });

  it("a command that throws is a failure carrying a command-failed diagnostic", async () => {
    respond = () => {
      throw new Error("host refused: unsupported_host");
    };
    const out = await sessionShutdownWithDiag();
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.diag).toMatchObject({ ok: false, kind: "command-failed", command: "session_shutdown" });
  });
});

describe("sessionActionRunner", () => {
  it("maps every action to the wrapper for that command (no computed invoke name)", async () => {
    const expected: Array<[Parameters<typeof sessionActionRunner>[0], string]> = [
      ["restart", "session_restart"],
      ["shutdown", "session_shutdown"],
      ["sleep", "session_sleep"],
    ];
    for (const [action, command] of expected) {
      calls = [];
      const out: SessionOutcome = await sessionActionRunner(action)();
      expect(out).toEqual({ ok: true });
      expect(invoked()).toEqual([command]);
    }
  });
});
