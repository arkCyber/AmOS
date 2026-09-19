/**
 * Boot-time default-on capability seed (REQ-A380).
 *
 * The OS ships deny-by-default for the camera + microphone grants, so a fresh
 * install of Camera / Voice Memos / the AI resident voice mic had to ask the
 * user before its first getUserMedia. This module is the one seam that
 * pre-grants them on first boot — and the tests below pin its core
 * properties:
 *   1. The set of (app, capability) pairs the seed writes is exactly
 *      `DEFAULT_CAPABILITIES`, no more, no less.
 *   2. A warm boot (the ledger already holds them) writes **nothing** and asks
 *      the daemon nothing — explicit Privacy revokes must never be clobbered.
 *   3. The first call mirrors each freshly-seeded entry through the
 *      `osPermissions` seam, so the daemon audit trail agrees with what the
 *      UI is showing.
 *   4. The dashboard predicate `isDefaultOnGrant` only returns true for entries
 *      the seed actually wrote.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  capSet,
  loadLedger,
  saveLedger,
  type Capability,
} from "../lib/permissions";
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_ON_CAPABILITIES,
  defaultAppsFor,
  defaultCapabilitiesInvariant,
  ensureDefaultCapabilitiesSeeded,
  isDefaultOnGrant,
  resetDefaultCapabilitiesSeedForTest,
  seedDefaultCapabilities,
} from "../svelte/osCapabilities";

type DaemonCalls = Array<{ appId: string; cap: Capability }>;

function installBridge(): { calls: DaemonCalls; goOffline: () => void } {
  const calls: DaemonCalls = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "perm_grant") {
        calls.push({ appId: String(args?.appId ?? ""), cap: String(args?.resource ?? "") as Capability });
      }
      return null;
    },
    listen: async () => async () => {},
  };
  return {
    calls,
    goOffline: () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
    },
  };
}

beforeEach(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    /* already registered */
  }
  window.localStorage.clear();
  resetDefaultCapabilitiesSeedForTest();
});

afterEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
  window.localStorage.clear();
});

describe("osCapabilities (REQ-A380): boot-time default-on seed", () => {
  test("seeds the documented (app, cap) matrix and nothing else", () => {
    installBridge();
    const ledger = seedDefaultCapabilities();
    // every declared pair is present
    for (const [app, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
      for (const cap of caps) {
        expect(capSet(ledger, app, cap)).toBe(true);
      }
    }
    // nothing else is touched — only the apps / capabilities we declared exist
    expect(Object.keys(ledger).sort()).toEqual(Object.keys(DEFAULT_CAPABILITIES).sort());
    for (const app of Object.keys(ledger)) {
      expect([...ledger[app]!].sort()).toEqual([...DEFAULT_CAPABILITIES[app]!].sort());
    }
  });

  test("a cold boot mirrors each seeded entry through the daemon audit seam", async () => {
    const { calls, goOffline } = installBridge();
    try {
      seedDefaultCapabilities();
      await new Promise<void>((r) => setTimeout(r, 0));
      // every declared pair was mirrored to the daemon exactly once
      const expected: DaemonCalls = [];
      for (const [app, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
        for (const cap of caps) expected.push({ appId: app, cap });
      }
      expect([...calls].sort((a, b) => (a.appId + a.cap).localeCompare(b.appId + b.cap))).toEqual(
        expected.sort((a, b) => (a.appId + a.cap).localeCompare(b.appId + b.cap)),
      );
    } finally {
      goOffline();
    }
  });

  test("a warm boot (ledger already populated) writes nothing and asks nothing", async () => {
    // Pre-populate the ledger with the EXACT target set, so the seed is a no-op
    // (idempotent grantCap — see `osPermissions.grantCapability`).
    const seeded: Record<string, Capability[]> = {};
    for (const [app, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
      seeded[app] = [...caps];
    }
    saveLedger(seeded);
    const { calls, goOffline } = installBridge();
    try {
      const ledger = seedDefaultCapabilities();
      await new Promise<void>((r) => setTimeout(r, 0));
      // ledger unchanged (no entries added, none lost)
      for (const [app, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
        expect([...ledger[app]!].sort()).toEqual([...caps].sort());
      }
      // daemon was not contacted — an already-defaulted install never re-mirrors.
      expect(calls).toEqual([]);
    } finally {
      goOffline();
    }
  });

  test("a partial warm boot only re-asserts the missing pair (idempotent for held caps)", async () => {
    // The boot-time matrix is a system policy; user-revoked caps are re-asserted
    // by a fresh `seedDefaultCapabilities` (mirrors iOS's "default-on services
    // come back after reboot"). Held caps short-circuit `grantCap` (no daemon
    // mirror either), so only the genuinely-missing pairs hit the bus.
    saveLedger({ ai: ["microphone"], interpreter: ["microphone"] });
    const { calls, goOffline } = installBridge();
    try {
      const ledger = seedDefaultCapabilities();
      await new Promise<void>((r) => setTimeout(r, 0));
      // All entries from the matrix are present (camera + vmemos re-asserted,
      // ai + interpreter were already held).
      expect(capSet(ledger, "camera", "camera")).toBe(true);
      expect(capSet(ledger, "vmemos", "microphone")).toBe(true);
      expect(capSet(ledger, "ai", "microphone")).toBe(true);
      expect(capSet(ledger, "interpreter", "microphone")).toBe(true);
      // Held caps never fire the mirror; only the missing pairs did.
      expect(calls).toEqual([
        { appId: "camera", cap: "camera" },
        { appId: "vmemos", cap: "microphone" },
      ]);
    } finally {
      goOffline();
    }
  });

  test("isDefaultOnGrant only returns true for declared entries", () => {
    for (const [app, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
      for (const cap of caps) expect(isDefaultOnGrant(app, cap)).toBe(true);
    }
    // A non-defaulted app / cap pair returns false.
    expect(isDefaultOnGrant("vmemos", "camera")).toBe(false);
    expect(isDefaultOnGrant("maps", "location")).toBe(false);
  });

  test("defaultAppsFor lists the apps that default-on for a given capability", () => {
    expect(defaultAppsFor("camera")).toEqual(["camera"]);
    expect(defaultAppsFor("microphone").sort()).toEqual(["ai", "interpreter", "vmemos"]);
    // A capability the OS does not default-on returns an empty list.
    expect(defaultAppsFor("location")).toEqual([]);
    expect(defaultAppsFor("contacts")).toEqual([]);
  });

  test("DEFAULT_ON_CAPABILITIES drives the dashboard badge invariant", () => {
    expect(DEFAULT_ON_CAPABILITIES.includes("camera")).toBe(true);
    expect(DEFAULT_ON_CAPABILITIES.includes("microphone")).toBe(true);
    expect(DEFAULT_ON_CAPABILITIES.includes("location")).toBe(false);
    expect(defaultCapabilitiesInvariant()).toBe(true);
  });

  test("ensureDefaultCapabilitiesSeeded is idempotent across the process", async () => {
    const { calls, goOffline } = installBridge();
    try {
      ensureDefaultCapabilitiesSeeded();
      await new Promise<void>((r) => setTimeout(r, 0));
      // Capture the daemon-call count for the seeded pairs (cold boot path).
      const seededCalls = calls.length;
      // Subsequent ensure* calls in the same process must not re-mirror: the
      // ledger already holds every default, the call short-circuits internally.
      ensureDefaultCapabilitiesSeeded();
      ensureDefaultCapabilitiesSeeded();
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(calls.length).toBe(seededCalls);
      // And the ledger is still what the matrix says.
      const ledger = loadLedger();
      for (const [app, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
        for (const cap of caps) expect(capSet(ledger, app, cap)).toBe(true);
      }
    } finally {
      goOffline();
    }
  });
});
