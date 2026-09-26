/**
 * print.test.ts — the shell's print front door (`src/lib/print.ts`, REQ-A869).
 *
 * These cases pin the frontend half of the contract, not the printing itself — no test can
 * observe a print dialog (the host's own suite records that `tauri::test::mock_runtime`'s
 * `print()` is a no-op and that the real one returns `Ok(())` whether or not a page printed):
 *
 *   • the wrapper invokes the **literal** zero-argument command name (`tauri-command-scan.mjs`
 *     resolves consumers by static string, and the host exposes `print_document` with no
 *     arguments precisely so the WebView has nothing to name — D2);
 *   • `invoke` returning `null` is **failure** (not-bridged / command-failed), and a non-null
 *     reply is "the platform was asked" — never "a page printed", which is why the reply is
 *     read as a request rather than a result;
 *   • `printRefusalMessage` names each of the three `amos.print.*` codes **apart** — one
 *     sentence for all refusals would make "this platform has no dialog" and "the platform
 *     call failed" read the same in the diagnostic log.
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import { printDocumentWithDiag, printRefusalMessage, type PrintRefusal } from "../print";

type Recorded = { command: string; args: Record<string, unknown> | undefined };

let calls: Recorded[];
let respond: (command: string) => unknown;

/** Install a Tauri bridge whose `invoke` records every command and answers `respond`. */
function installBridge(): void {
  calls = [];
  respond = () => ({ window: "files", platform: "macOs" });
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

const invoked = () => calls.map((c) => c.command);

describe("print.ts — the host asked the platform", () => {
  it("invokes its literal command, once, with no arguments", async () => {
    const out = await printDocumentWithDiag();
    expect(out).toEqual({ ok: true, window: "files" });
    // A zero-argument command: the shell cannot name a window the host might not agree is
    // focused, and `print_document` resolves the target itself (D2, F-SH-008).
    expect(invoked()).toEqual(["print_document"]);
    expect(calls[0]?.args).toBeUndefined();
  });

  it("reports the window the host named, and a null reply is not mistaken for one", async () => {
    // The reply is a *request* record: the host says which window it asked about. The real
    // `print()` answers `Ok(())` on every platform whether or not anything printed, so
    // `window` being present is the only fact this wire carries — and it must survive.
    respond = () => ({ window: "notes.2", platform: "windows" });
    expect(await printDocumentWithDiag()).toEqual({ ok: true, window: "notes.2" });

    // `null` is the failure value (`invoke` resolves it for a refused command *and* for an
    // absent bridge), so it must not be read as a request.
    respond = () => null;
    const out = await printDocumentWithDiag();
    expect(out.ok).toBe(false);
  });
});

describe("print.ts — the host refused or is absent", () => {
  it("an unbridged host is a failure carrying a not-bridged diagnostic", async () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    const out = await printDocumentWithDiag();
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.diag).toEqual({ ok: false, kind: "not-bridged", command: "print_document" });
  });

  it("a command that throws is a failure carrying a command-failed diagnostic", async () => {
    respond = () => {
      throw { code: "amos.print.no_window", message: "no app window is focused" };
    };
    const out = await printDocumentWithDiag();
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.diag).toMatchObject({
      ok: false,
      kind: "command-failed",
      command: "print_document",
    });
  });
});

/** A `command-failed` diagnostic carrying `code`, built the way `invoke` builds it. */
function failedWith(code: unknown): PrintRefusal {
  return {
    ok: false,
    kind: "command-failed",
    command: "print_document",
    detail: code === undefined ? undefined : { code },
  };
}

describe("printRefusalMessage — one sentence per reason", () => {
  it("the three host codes read as three different facts", () => {
    const unsupported = printRefusalMessage(failedWith("amos.print.unsupported_platform"));
    const noWindow = printRefusalMessage(failedWith("amos.print.no_window"));
    const dialogFailed = printRefusalMessage(failedWith("amos.print.dialog_failed"));

    // Pairwise distinct: if two of these collapsed into one sentence, the log would report a
    // platform with no print dialog and a broken platform call as the same event.
    expect(new Set([unsupported, noWindow, dialogFailed]).size).toBe(3);
    // …and each names its own cause, not just "print failed".
    expect(unsupported).toContain("no print dialog");
    expect(noWindow).toContain("no app window is focused");
    expect(dialogFailed).toContain("print dialog");
    expect(dialogFailed).toContain("failed");
  });

  it("an absent bridge and an unrecognised code are each reported as themselves", () => {
    const unbridged = printRefusalMessage({
      ok: false,
      kind: "not-bridged",
      command: "print_document",
    });
    expect(unbridged).toContain("no bridge");

    // A renamed host code must be *visible*, not folded into one of the three known reasons —
    // no gate mirrors these spellings across the two languages (see `print.ts`).
    const unknown = printRefusalMessage(failedWith("amos.print.some_new_reason"));
    expect(unknown).toContain("amos.print.some_new_reason");
    expect(unknown).not.toBe(printRefusalMessage(failedWith("amos.print.no_window")));

    // A detail that carries no code at all (or one that is not a string) is still reported.
    expect(printRefusalMessage(failedWith(undefined))).toContain("unrecognised reason");
    expect(printRefusalMessage(failedWith(404))).toContain("unrecognised reason");
  });
});
