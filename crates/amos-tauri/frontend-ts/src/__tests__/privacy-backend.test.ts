import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  daemonAuthorize,
  daemonGrant,
  daemonRecentAudit,
  daemonResource,
  daemonRevoke,
  toAuditViews,
} from "../lib/privacyBackend";
import type { Capability } from "../lib/permissions";

/** Record which commands/args the fake bridge received. */
let calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

function installBridge(returns: Record<string, unknown>): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      return cmd in returns ? returns[cmd] : null;
    },
    listen: async () => async () => {},
  };
}

const ALL: Capability[] = ["camera", "microphone", "location", "contacts", "storage", "notifications"];

describe("privacyBackend (daemon OS-permission bridge)", () => {
  beforeEach(() => {
    calls = [];
    try {
      GlobalRegistrator.register();
    } catch {
      /* already registered */
    }
  });
  afterEach(() => {
    // Clear any installed fake bridge so later tests start offline.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
  });

  test("daemonResource maps OS capabilities to wire keys; notifications is local-only", () => {
    expect(daemonResource("camera")).toBe("camera");
    expect(daemonResource("microphone")).toBe("microphone");
    expect(daemonResource("location")).toBe("location");
    expect(daemonResource("contacts")).toBe("contacts");
    expect(daemonResource("storage")).toBe("storage");
    expect(daemonResource("notifications")).toBeNull();
    // Every capability is covered (no missing case).
    expect(ALL.map(daemonResource).filter((r) => r !== null)).toHaveLength(5);
  });

  test("offline (no bridge) degrades to null, never a fabricated grant", async () => {
    // Ensure no bridge is present.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
    expect(await daemonAuthorize("maps", "location")).toBeNull();
    expect(await daemonGrant("maps", "location")).toBeNull();
    expect(await daemonRevoke("maps", "location")).toBeNull();
    // Local-only capability never reaches the daemon even when bridged.
    installBridge({ perm_authorize: true });
    expect(await daemonAuthorize("messages", "notifications")).toBeNull();
  });

  test("online calls the perm_* command with the aligned resource key", async () => {
    installBridge({ perm_authorize: true, perm_grant: null as unknown, perm_revoke: null as unknown });

    expect(await daemonAuthorize("com.x", "contacts")).toBe(true);
    expect(calls).toContainEqual({ cmd: "perm_authorize", args: { appId: "com.x", resource: "contacts" } });

    // A successful (non-null) grant/revoke resolves to true.
    calls.length = 0;
    installBridge({ perm_grant: {}, perm_revoke: {} });
    expect(await daemonGrant("com.x", "storage")).toBe(true);
    expect(await daemonRevoke("com.x", "storage")).toBe(true);
    expect(calls).toEqual([
      { cmd: "perm_grant", args: { appId: "com.x", resource: "storage" } },
      { cmd: "perm_revoke", args: { appId: "com.x", resource: "storage" } },
    ]);
  });

  test("toAuditViews maps raw daemon records to display views (order preserved)", () => {
    const views = toAuditViews([
      {
        ts: 2,
        principal: "com.b",
        op: "perm.authorize",
        resource: "camera",
        outcome: "denied",
        details: "",
      },
      {
        ts: 1,
        principal: "com.a",
        op: "perm.authorize",
        resource: "microphone",
        outcome: "granted",
        details: "",
      },
    ]);
    expect(views).toEqual([
      { appId: "com.b", resource: "camera", granted: false, outcome: "denied", ts: 2 },
      { appId: "com.a", resource: "microphone", granted: true, outcome: "granted", ts: 1 },
    ]);
  });

  test("daemonRecentAudit is null offline and returns records online", async () => {
    // Offline (no bridge) → null.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
    expect(await daemonRecentAudit(20)).toBeNull();

    // Online → the perm_recent_audit records come back verbatim.
    const records = [
      { ts: 1, principal: "com.a", op: "perm.authorize", resource: "mic", outcome: "granted", details: "" },
    ];
    installBridge({ perm_recent_audit: records });
    const got = await daemonRecentAudit(20, { resource: "camera" });
    expect(got).toEqual(records);
    expect(calls).toContainEqual({
      cmd: "perm_recent_audit",
      args: { appId: "", resource: "camera", limit: 20 },
    });
  });
});
