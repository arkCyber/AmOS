import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import {
  capForWire,
  daemonAuthorize,
  daemonGrant,
  daemonGrantsAll,
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

/** Bridge that **refuses** the given commands, i.e. a daemon that rejects the RPC. */
function installRefusingBridge(cmds: string[]): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      if (cmds.includes(cmd)) throw new Error(`${cmd} refused`);
      return null;
    },
    listen: async () => async () => {},
  };
}

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

  test("a refused perm_grant/perm_revoke reads false — the write's own verdict", async () => {
    // `perm_grant`/`perm_revoke` are Rust `Result<(), String>`: the success reply and a
    // refusal both arrive as JSON `null`, so the *reply* cannot carry the verdict — but
    // `invoke` records the outcome of that command (`bridgeDiag`), which is how the repo
    // already reads every other unit-returning mutation. Before this case the answer was
    // the constant `true`, so a daemon that refused the write (unknown privacy id, no
    // socket, RPC error) was reported to the caller as an authoritative grant.
    installRefusingBridge(["perm_grant", "perm_revoke"]);
    expect(await daemonGrant("com.x", "storage")).toBe(false);
    expect(await daemonRevoke("com.x", "storage")).toBe(false);

    // The other direction: a call the daemon accepted still reads true.
    installBridge({ perm_grant: null as unknown, perm_revoke: null as unknown });
    expect(await daemonGrant("com.x", "storage")).toBe(true);
    expect(await daemonRevoke("com.x", "storage")).toBe(true);

    // And offline / local-only stay `null` — "the daemon never answered", not a refusal.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
    expect(await daemonGrant("com.x", "storage")).toBeNull();
  });

  test("capForWire is the inverse of daemonResource; an unknown key is null", () => {
    // Round-trip: every wire key daemonResource produces maps back to its capability.
    for (const cap of ALL) {
      const wire = daemonResource(cap);
      if (wire) expect(capForWire(wire)).toBe(cap);
    }
    // notifications is local-only, so it has no wire key at all.
    expect(capForWire("notifications")).toBeNull();
    // A resource the UI does not know yet must never be labelled as a capability.
    expect(capForWire("nfc")).toBeNull();
    expect(capForWire("")).toBeNull();
  });

  test("daemonGrantsAll is null offline and reads the authority online", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
    expect(await daemonGrantsAll()).toBeNull();

    // `GrantRow` serializes with its snake_case field name `app_id`.
    const rows = [{ app_id: "com.other", resources: ["camera", "storage"] }];
    installBridge({ perm_grants_all: rows });
    expect(await daemonGrantsAll()).toEqual(rows);
    expect(calls).toContainEqual({ cmd: "perm_grants_all", args: {} });
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

/**
 * The daemon's `Resource` vocabulary has **three** frontend re-spellings, and this file
 * owns the third: `WireResource` / `daemonResource` / `capForWire`. Its doc claims the five
 * keys "map 1:1 to the daemon's stable wire keys", but every assertion above compares them
 * only against a **local** literal list — the same self-proving blind spot
 * `sandbox-bridge.test.ts` already closed for the sibling consumer (`SANDBOX_RESOURCES`);
 * `permissions.test.ts` closed it for `CAPABILITIES`. So a rename in `privacy.rs::Resource::key()`
 * left *this* gate silently one step behind — and this is the gate that actually dispatches
 * `perm_authorize`/`perm_grant`, so a drifted key either targets a resource the daemon does
 * not know (deny) or, via `capForWire`, drops a real grant out of the review UI. These cases
 * read the Rust authority instead of a copy (REQ-A777).
 *
 * The second mirror here is the reply shape: `DaemonGrantRow` and `DaemonAuditRecord` claim
 * to be `privacy_client.rs`'s `GrantRow` / `PermissionAudit`. Nothing read those either, so a
 * renamed field would make the review list show blank apps / lost rows with no test red.
 */
function readSrc(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** The daemon's `Resource::key()` wire strings, read from the Rust authority. */
function daemonResourceKeys(): string[] {
  const src = readSrc("../../../../amos-ai/src/privacy.rs");
  const keyIdx = src.indexOf("const fn key(self)");
  expect(keyIdx).toBeGreaterThan(0);
  // Slice to the `key()` body: a bare scan would also catch `AccessDecision`'s
  // `Display` arms ("granted"/"denied").
  const body = src.slice(keyIdx, keyIdx + 400);
  return [...new Set([...body.matchAll(/Self::\w+ => "([a-z_]+)"/g)].map((m) => m[1] ?? ""))].sort();
}

/** `pub` field names of a Rust struct, in declaration order. */
function rustFields(src: string, struct: string): string[] {
  const at = src.indexOf(`pub struct ${struct} {`);
  expect(at, `pub struct ${struct} not found`).toBeGreaterThan(0);
  const body = src.slice(at, src.indexOf("\n}", at));
  return [...body.matchAll(/^\s{4}pub (\w+):/gm)].map((m) => m[1] ?? "").sort();
}

/** Field names of a TS interface, in declaration order. */
function tsFields(src: string, iface: string): string[] {
  const at = src.indexOf(`interface ${iface} {`);
  expect(at, `interface ${iface} not found`).toBeGreaterThan(0);
  const body = src.slice(at, src.indexOf("\n}", at));
  return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1] ?? "").sort();
}

describe("privacyBackend's wire vocabulary == amos-ai `Resource::key()`", () => {
  test("the five wire keys are exactly the daemon's, both directions", () => {
    const rust = daemonResourceKeys();
    // Guard: the scan found the real table (five arms), not an empty window.
    expect(rust).toHaveLength(5);

    // Every capability's wire key is a real daemon resource — and every daemon
    // resource is reachable from some capability (no resource silently unreviewable).
    const mine = (ALL.map(daemonResource).filter((r) => r !== null) as string[]).sort();
    expect(mine).toEqual(rust);

    // The declared union is the same set (a name the union omits would be a type error,
    // but the union could still list a key the daemon never sends).
    const lib = readSrc("../lib/privacyBackend.ts");
    const at = lib.indexOf("export type WireResource =");
    expect(at).toBeGreaterThan(0);
    const union = [...lib.slice(at, lib.indexOf(";", at)).matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
    expect(union.sort()).toEqual(rust);

    // …and `capForWire` inverts it: a real daemon key round-trips, an unknown one is null.
    for (const key of rust) expect(capForWire(key) as string, key).toBe(key);
    expect(capForWire("nfc")).toBeNull();
  });
});

describe("privacyBackend's reply shapes == amos-tauri `privacy_client.rs`", () => {
  const client = readSrc("../../../../amos-tauri/src/privacy_client.rs");
  const lib = readSrc("../lib/privacyBackend.ts");

  test("`DaemonGrantRow` is exactly `GrantRow`'s serialized fields", () => {
    const rust = rustFields(client, "GrantRow");
    expect(rust).toEqual(["app_id", "resources"]); // guard against an empty scan
    expect(tsFields(lib, "DaemonGrantRow")).toEqual(rust);
  });

  test("`DaemonAuditRecord` is exactly `PermissionAudit`'s serialized fields", () => {
    const rust = rustFields(client, "PermissionAudit");
    expect(rust).toEqual(["details", "op", "outcome", "principal", "resource", "ts"]);
    expect(tsFields(lib, "DaemonAuditRecord")).toEqual(rust);
  });
});
