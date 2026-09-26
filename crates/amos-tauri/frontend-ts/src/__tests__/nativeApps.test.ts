import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  lastFailureReason,
  launchCommand,
  nativeApps,
  nativeAvailability,
  nativeLaunch,
  normalizeLinuxApps,
  normalizeWineApps,
} from "../lib/nativeApps";

// Bring up a real DOM for this file (globals are per-process in bun) — the bridge
// is read off `window.__TAURI_INTERNALS__`, so there is nothing to test without one.
if (!globalThis.document) GlobalRegistrator.register();

/**
 * Tests for the desktop native-application bridge (`lib/nativeApps.ts`).
 *
 * Two halves: the **pure normalizers** (malformed payloads must degrade, never
 * throw, never invent a row) and the **wire contract** — the command names and the
 * camelCase argument keys the Rust commands actually declare (`{ id }` for
 * `wine_launch`/`linux_launch`, whose parameter is `id`).
 */

type Call = { command: string; args?: Record<string, unknown> };
let calls: Call[] = [];

function installBridge(reply: (command: string) => unknown) {
  calls = [];
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      const value = reply(command);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  calls = [];
});

describe("nativeApps normalizers", () => {
  test("wine rows map to the display shape and keep ids verbatim", () => {
    const rows = normalizeWineApps([
      {
        id: "Notepad",
        name: "Notepad",
        exePath: "C:\\Program Files\\Notepad\\np.exe",
        desktopPath: "/w/.wine/…/Notepad.desktop",
        prefix: "/w/.wine",
      },
    ]);
    expect(rows).toEqual([
      {
        kind: "wine",
        id: "Notepad",
        name: "Notepad",
        program: "C:\\Program Files\\Notepad\\np.exe",
        entryPath: "/w/.wine/…/Notepad.desktop",
      },
    ]);
  });

  test("a row without an id or name is dropped, not rendered as a blank app", () => {
    expect(normalizeWineApps([{ id: "", name: "x" }, { id: "y" }, "junk", null])).toEqual([]);
    expect(normalizeLinuxApps([{ id: "ok", name: "" }])).toEqual([]);
  });

  test("non-arrays are not a listing", () => {
    expect(normalizeWineApps(null)).toEqual([]);
    expect(normalizeWineApps({ apps: [] })).toEqual([]);
    expect(normalizeLinuxApps("nope")).toEqual([]);
  });

  test("linux rows show program + arguments and ignore non-string args", () => {
    const rows = normalizeLinuxApps([
      { id: "firefox", name: "Firefox", exec: "firefox", args: ["--new-window", 7, null] },
      { id: "bare", name: "Bare", exec: "/usr/bin/bare", args: [] },
    ]);
    expect(rows[0]).toMatchObject({ kind: "linux", program: "firefox --new-window" });
    expect(rows[1]).toMatchObject({ kind: "linux", program: "/usr/bin/bare" });
  });
});

describe("nativeApps bridge", () => {
  test("no bridge at all is null (not \"this machine has no apps\")", async () => {
    expect(await nativeAvailability()).toBeNull();
    expect(await nativeApps()).toBeNull();
  });

  test("availability mirrors the host booleans and never trusts junk", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return true;
      if (cmd === "linux_is_available") return "yes"; // malformed: not a boolean
      return null;
    });
    expect(await nativeAvailability()).toEqual({ wine: true, linux: false });
  });

  /**
   * REQ-A1363 / F-SH-627. The sibling fold F-SH-266 removed from the **listing**
   * (`nativeApps`) was left in the **availability** read, where `wine === true` turned a
   * refused probe into `false` — and the screen reads `false` as 「本机没有安装 Wine」, a
   * claim about this machine's PATH. Only `null` (the host did not answer) stays `null`;
   * a malformed non-boolean answer is still `false` (the test above), because junk *is*
   * an answer and "no answer" is not.
   */
  test("a refused probe stays null per kind — it does not become a false claim", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return new Error("the probe could not read PATH");
      if (cmd === "linux_is_available") return true;
      return null;
    });
    expect(await nativeAvailability()).toEqual({ wine: null, linux: true });
  });

  test("listings are per kind, and [] only for the kind the host answered", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_apps") return [{ id: "w1", name: "Wine App", exePath: "a.exe" }];
      if (cmd === "linux_apps") return [];
      return null;
    });
    const read = await nativeApps();
    expect(read?.wine?.map((a) => a.id)).toEqual(["w1"]);
    // The host answered for Linux and found nothing: `[]`, **not** `null`.
    expect(read?.linux).toEqual([]);
    expect(calls.map((c) => c.command)).toEqual(["wine_apps", "linux_apps"]);
  });

  // The fold this pins: a rejected `invoke` answers `null`, and a merged array could not
  // carry the difference between "refused" and "empty" for one half (REQ-A836 / F-SH-266).
  test("a half the host refused stays null instead of becoming an empty list", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_apps") return new Error("the enumerator could not read the prefixes");
      if (cmd === "linux_apps") return [{ id: "l1", name: "Linux App", exec: "l" }];
      return null;
    });
    const read = await nativeApps();
    expect(read?.wine).toBeNull();
    expect(read?.linux?.map((a) => a.id)).toEqual(["l1"]);
  });

  test("launch names the command per surface and passes the id key Rust declares", async () => {
    installBridge(() => "Notepad");
    expect(await nativeLaunch("wine", "Notepad")).toBe("Notepad");
    expect(calls[0]).toEqual({ command: "wine_launch", args: { id: "Notepad" } });

    installBridge(() => "Firefox");
    expect(await nativeLaunch("linux", "firefox")).toBe("Firefox");
    expect(calls[0]).toEqual({ command: "linux_launch", args: { id: "firefox" } });
  });

  test("an empty id never reaches the host", async () => {
    installBridge(() => "x");
    expect(await nativeLaunch("wine", "")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a refused launch keeps the host's own sentence", async () => {
    installBridge(() => new Error("no Linux app with id 'ghost' is installed"));
    expect(await nativeLaunch("linux", "ghost")).toBeNull();
    expect(lastFailureReason(launchCommand("linux"))).toBe(
      "no Linux app with id 'ghost' is installed",
    );
  });

  test("a successful call clears the failure reason", async () => {
    installBridge(() => new Error("boom"));
    await nativeLaunch("wine", "x");
    expect(lastFailureReason(launchCommand("wine"))).toBe("boom");
    installBridge(() => "ok");
    await nativeLaunch("wine", "x");
    expect(lastFailureReason(launchCommand("wine"))).toBe("");
  });

  test("a failure reason belongs to its own command, not to whoever finished last (REQ-A296)", async () => {
    // The bridge keeps one slot per command: a *different* command failing after our
    // launch must not become this launch's reason (the old global slot did exactly that).
    installBridge(() => new Error("boom"));
    await nativeLaunch("wine", "x");
    installBridge(() => new Error("unrelated command failed"));
    await nativeApps(); // fails on wine_apps / linux_apps
    expect(lastFailureReason(launchCommand("wine"))).toBe("boom");
    expect(lastFailureReason("wine_apps")).toBe("unrelated command failed");
    // A command that was never called has no recorded failure.
    expect(lastFailureReason("never_called")).toBe("");
  });
});
