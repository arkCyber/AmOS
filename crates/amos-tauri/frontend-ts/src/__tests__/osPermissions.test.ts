import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { capSet, loadLedger } from "../lib/permissions";
import {
  daemonVerdict,
  grantCapability,
  mirrorRefused,
  onMirrorVerdict,
  revokeCapability,
} from "../svelte/osPermissions";

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
/** Bridge whose permission RPCs **refuse**: a daemon that is up but rejects the call. */
function refuseMirrors(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push({ cmd, args: {} });
      if (cmd.startsWith("perm_")) throw new Error(`${cmd} refused`);
      return null;
    },
    listen: async () => async () => {},
  };
}
/** Let the fire-and-forget daemon mirror settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** Puts the real `window` back after a refusing-store test (null when none is installed). */
let restoreWindow: (() => void) | null = null;

/**
 * A `window` whose localStorage **refuses writes to `failKey`** (a full/unavailable store).
 *
 * A minimal stub rather than a spy on the happy-dom instance: `writeJson` reads
 * `window.localStorage` at call time, so the whole object is what has to answer. The
 * **daemon** half is untouched — a refusing `setItem` is a local fact, and the mirror's own
 * verdict has its tests below.
 */
function installRefusingStore(failKey: string) {
  const store = new Map<string, string>();
  const attempted: string[] = [];
  const real = (globalThis as unknown as { window: unknown }).window;
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        attempted.push(k);
        if (k === failKey) throw new Error("QuotaExceededError");
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
    dispatchEvent: () => true,
  };
  restoreWindow = () => {
    (globalThis as unknown as { window: unknown }).window = real;
  };
  return {
    /** Seed the store as if an earlier (successful) write had landed. */
    put: (k: string, v: unknown) => store.set(k, JSON.stringify(v)),
    /** The keys a write was *attempted* for — a count of writes, landed or not. */
    attempted,
  };
}

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
    mock.restore();
    restoreWindow?.();
    restoreWindow = null;
    window.localStorage.clear();
  });

  test("grantCapability persists locally AND mirrors to the daemon", async () => {
    installBridge();
    const res = grantCapability("maps", "location");
    // Local ledger is updated synchronously (the UI gate stays immediate)...
    expect(capSet(loadLedger(), "maps", "location")).toBe(true);
    expect(res.landed).toBe(true);
    expect(res.ledger).toEqual(loadLedger());
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

  // The local ledger is written first (the UI gate must stay immediate) and the mirror is
  // best-effort. A refusal used to be indistinguishable from success: the mirror's return
  // was a constant and the caller discarded it, so "the authority refused this write"
  // never left this module. Four cases, one assertion per failure mode, so each direction
  // has a control of its own and none is masked by an earlier abort.
  test("a refused mirror is recorded, and the local ledger still shows the grant", async () => {
    const seen: Array<[string, string, boolean]> = [];
    const stop = onMirrorVerdict((a, c, ok) => seen.push([a, c, ok]));
    refuseMirrors();
    grantCapability("maps", "location");
    await settle();
    expect(mirrorRefused("maps", "location")).toBe(true);
    expect(seen).toEqual([["maps", "location", false]]);
    // The display cache is deliberately optimistic (works offline, gates immediately) —
    // which is exactly why the refusal has to be readable somewhere else.
    expect(capSet(loadLedger(), "maps", "location")).toBe(true);
    stop();
  });

  test("an accepted mirror is not recorded as a refusal", async () => {
    const seen: Array<[string, string, boolean]> = [];
    const stop = onMirrorVerdict((a, c, ok) => seen.push([a, c, ok]));
    installBridge();
    grantCapability("camera", "camera");
    await settle();
    expect(mirrorRefused("camera", "camera")).toBe(false);
    // The verdict is still reported (a view may need to retract a mark); it just is not a
    // refusal.
    expect(seen).toEqual([["camera", "camera", true]]);
    stop();
  });

  test("a daemon that never answered is not a refusal", async () => {
    goOffline();
    grantCapability("weather", "location");
    await settle();
    // Offline is the documented "no claim" case: marking it would accuse the daemon of
    // refusing something it was never asked (daemonVerdict answers null here too).
    expect(mirrorRefused("weather", "location")).toBe(false);
  });

  test("a later accepted write for the same pair clears the mark", async () => {
    refuseMirrors();
    grantCapability("maps", "location");
    await settle();
    expect(mirrorRefused("maps", "location")).toBe(true);
    // The mark is a statement about the *last* write, not a sticky session scar: once the
    // authority takes a write for this pair the two stores agree again (here: both say
    // "not granted", after the revoke lands).
    installBridge();
    revokeCapability("maps", "location");
    await settle();
    expect(mirrorRefused("maps", "location")).toBe(false);
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

  // ---- the LOCAL write's verdict (REQ-A1402 / F-SH-660) ----------------------
  // The mirror tests above cover the daemon half. This is the other half: `amos.permissions`
  // is what every gate in the OS reads back (`loadLedger`), so a *local* refusal means the
  // change the user just made is not the change the next boot enforces — a revoke that did
  // not land leaves the capability granted. `saveLedger` used to answer `void`, so the
  // surfaces adopted the attempted ledger and drew a revoke that never took effect.
  test("a refused local revoke is not reported as landed, and the persisted grant stands", async () => {
    // The store holds the grant from an earlier, landed write — then starts refusing.
    const st = installRefusingStore("amos.permissions");
    st.put("amos.permissions", { camera: ["camera"] });
    expect(capSet(loadLedger(), "camera", "camera")).toBe(true);

    const res = revokeCapability("camera", "camera");
    expect(res.landed).toBe(false);
    // The ledger a surface may show is the **persisted** one — still granted — because that
    // is what `loadLedger` answers to every gate in the OS.
    expect(capSet(res.ledger, "camera", "camera")).toBe(true);
    expect(capSet(loadLedger(), "camera", "camera")).toBe(true);
  });

  test("a refused local grant is not reported as landed either", async () => {
    installRefusingStore("amos.permissions");
    const res = grantCapability("maps", "location");
    expect(res.landed).toBe(false);
    expect(capSet(res.ledger, "maps", "location")).toBe(false);
    expect(capSet(loadLedger(), "maps", "location")).toBe(false);
  });

  test("a landed write reports the new ledger and clears the way for a later revoke", async () => {
    goOffline();
    const granted = grantCapability("maps", "location");
    expect(granted.landed).toBe(true);
    expect(capSet(granted.ledger, "maps", "location")).toBe(true);
    const revoked = revokeCapability("maps", "location");
    expect(revoked.landed).toBe(true);
    expect(capSet(revoked.ledger, "maps", "location")).toBe(false);
    expect(capSet(loadLedger(), "maps", "location")).toBe(false);
  });

  test("an idempotent re-grant writes nothing and is still honest about the store", () => {
    const st = installRefusingStore("<no key refuses>");
    st.put("amos.permissions", { maps: ["location"] });
    // The call is a no-op (`grantCap` returns the same reference) — the daemon mirror is
    // skipped on purpose, so the audit log stays honest about which boot wrote what. The store
    // already holds the grant, so the write is *satisfied*: `landed` is true, with no write.
    const again = grantCapability("maps", "location");
    expect(st.attempted).toEqual([]);
    expect(again.landed).toBe(true);
    expect(capSet(again.ledger, "maps", "location")).toBe(true);
  });
});
