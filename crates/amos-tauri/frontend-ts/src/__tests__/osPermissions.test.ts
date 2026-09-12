import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { capSet, loadLedger } from "../lib/permissions";
import { daemonVerdict, grantCapability, revokeCapability } from "../svelte/osPermissions";

/** Record which commands/args the fake bridge received. */
let calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

function installBridge(returns: Record<string, unknown> = {}): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      return cmd in returns ? returns[cmd] : null;
    },
    listen: async () => async () => {},
  };
}
function goOffline(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
}
/** Let the fire-and-forget daemon mirror settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("osPermissions (capability ledger seam)", () => {
  beforeEach(() => {
    try {
      GlobalRegistrator.register();
    } catch {
      /* already registered */
    }
    calls = [];
    window.localStorage.clear();
  });
  afterEach(() => {
    goOffline();
    window.localStorage.clear();
  });

  test("grantCapability persists locally AND mirrors to the daemon", async () => {
    installBridge();
    const next = grantCapability("maps", "location");
    // Local ledger is updated synchronously (the UI gate stays immediate)...
    expect(capSet(loadLedger(), "maps", "location")).toBe(true);
    expect(next).toEqual(loadLedger());
    // ...the shared store gets the new ledger (durable copy + cross-window bus)...
    // (REQ-A101: this mirror used to go to a `window.Amos.storeWrite` shim that
    // nothing injected, so it silently never happened.)
    // ...and the daemon (authoritative, audited) is told too.
    await settle();
    expect(calls).toEqual([
      {
        cmd: "store_set",
        args: { key: "amos.permissions", value: JSON.stringify(loadLedger()) },
      },
      { cmd: "perm_grant", args: { appId: "maps", resource: "location" } },
    ]);
  });

  test("revokeCapability mirrors a revoke", async () => {
    installBridge();
    grantCapability("camera", "camera");
    await settle();
    calls = [];
    revokeCapability("camera", "camera");
    expect(capSet(loadLedger(), "camera", "camera")).toBe(false);
    await settle();
    expect(calls.filter((c) => c.cmd.startsWith("perm_"))).toEqual([
      { cmd: "perm_revoke", args: { appId: "camera", resource: "camera" } },
    ]);
  });

  test("a local-only capability (notifications) never reaches the daemon", async () => {
    installBridge();
    grantCapability("messages", "notifications");
    expect(capSet(loadLedger(), "messages", "notifications")).toBe(true);
    await settle();
    // No daemon *resource* → no permission RPC. (The ledger write itself still
    // mirrors to the shared store, which is not a capability decision.)
    expect(calls.filter((c) => c.cmd.startsWith("perm_"))).toEqual([]);
  });

  test("offline: local-only, no daemon calls, never throws", async () => {
    goOffline();
    grantCapability("maps", "location");
    expect(capSet(loadLedger(), "maps", "location")).toBe(true);
    await settle();
    expect(calls).toEqual([]);
  });

  test("daemonVerdict answers from the daemon; null offline and for local-only caps", async () => {
    installBridge({ perm_authorize: false });
    expect(await daemonVerdict("maps", "location")).toBe(false);
    installBridge({ perm_authorize: true });
    expect(await daemonVerdict("maps", "location")).toBe(true);
    installBridge();
    expect(await daemonVerdict("messages", "notifications")).toBeNull(); // no resource
    goOffline();
    expect(await daemonVerdict("maps", "location")).toBeNull(); // offline → no claim
  });
});
