/**
 * The Wi-Fi automation trigger's **signal source** (REQ-A1165 / F-SH-463).
 *
 * `startShortcutTriggers` fed `{ type: "wifi" }` from `navigator.onLine` — internet
 * reachability — and stamped the event with `amos.wifi.current`. Reachability is a
 * different fact from "which network we are on", so the app's own join fired nothing
 * (「连上 X 时…」 never ran), a Wi-Fi drop to cellular stayed silent (no `offline`), and a
 * plain internet loss fired 「断开时」 naming whatever SSID the store happened to remember.
 * The source is now a change to the Wi-Fi store itself (`STORE_CHANGED_EVENT` on `WIFI_KEY`),
 * read as a **transition**.
 *
 * A transition has two halves, and the first cut of the fix read only one: a *direct switch*
 * (`Home → Cafe`) reported the join and dropped the disconnect, so a 「断开 Home 时」 rule
 * missed every switch. Both halves are now forwarded, each named for its own network
 * (REQ-A1167 / F-SH-464).
 *
 * These cases drive the runtime end-to-end — store write → event → `fire` → the shortcut
 * actually executes — rather than feeding `triggerMatches` a hand-made event (which is what
 * `shortcutTriggerCatalog.test.ts` does, and why the wrong source stayed green there).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Shortcut, Trigger } from "../lib/shortcuts";
import { loadShortcuts, saveShortcuts } from "../lib/shortcuts";
import { WIFI_KEY } from "../lib/wifi";
import { writeStoreValue } from "../lib/amosStore";
import { startShortcutTriggers } from "../svelte/osShortcutTriggers";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

/** A shortcut whose only trigger is a Wi-Fi rule; no actions, so running it is inert. */
function wifiShortcut(id: string, config: Record<string, unknown>): Shortcut {
  const trigger: Trigger = { id: `${id}-t`, type: "wifi", enabled: true, config };
  return {
    id,
    name: id,
    icon: "📶",
    color: "#000000",
    description: "",
    actions: [],
    quickActions: [],
    triggers: [trigger],
    createdAt: 1,
    updatedAt: 1,
    runCount: 0,
    runOnLockScreen: false,
    requiresConfirmation: false,
    tags: [],
  };
}

/** Seed the Wi-Fi store without going through a trigger-relevant transition. */
function seedWifi(current: string | null): void {
  window.localStorage.setItem(
    WIFI_KEY,
    JSON.stringify({ current, saved: current ? [current] : [], passwords: {} }),
  );
}

const runCount = (id: string): number => loadShortcuts().find((s) => s.id === id)?.runCount ?? 0;

/** Let the `fire` → `executeShortcut` promise chain settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

let stop: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(WIFI_KEY, JSON.stringify({ current: null, saved: [], passwords: {} }));
});

afterEach(() => {
  stop?.();
  stop = null;
  window.localStorage.clear();
});

describe("the Wi-Fi trigger fires on the Wi-Fi state, not on internet reachability", () => {
  test("joining a network in the app runs an SSID-scoped 「连接时」 shortcut", async () => {
    const sc = wifiShortcut("join-cafe", { ssid: "Cafe_Free", event: "connect" });
    saveShortcuts([sc]);
    stop = startShortcutTriggers();
    await flush();

    // The Wi-Fi page's join writes exactly this shape into `amos.wifi`.
    writeStoreValue(WIFI_KEY, { current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} });
    await flush();

    expect(runCount(sc.id)).toBe(1);
  });

  test("forgetting the joined network runs the 「断开时」 rule for the network we left", async () => {
    seedWifi("Home-2.4G");
    const sc = wifiShortcut("drop-home", { ssid: "Home-2.4G", event: "disconnect" });
    saveShortcuts([sc]);
    stop = startShortcutTriggers();
    await flush();

    writeStoreValue(WIFI_KEY, { current: null, saved: ["Home-2.4G"], passwords: {} });
    await flush();

    expect(runCount(sc.id)).toBe(1);
  });

  test("switching networks runs the 「断开时」 rule for the network we left", async () => {
    // A direct switch (`Home → Cafe`, what `lib/wifi.ts::join` writes when you tap a second
    // network) is *two* facts. The old transition read it as one — the join — so only the
    // disconnect half was lost, and a 「断开 Home 时」 rule never ran on a switch.
    seedWifi("Home-2.4G");
    const left = wifiShortcut("switch-off", { ssid: "Home-2.4G", event: "disconnect" });
    const joined2 = wifiShortcut("switch-on", { ssid: "Cafe_Free", event: "connect" });
    saveShortcuts([left, joined2]);
    stop = startShortcutTriggers();
    await flush();

    writeStoreValue(WIFI_KEY, { current: "Cafe_Free", saved: ["Home-2.4G", "Cafe_Free"], passwords: {} });
    await flush();

    expect(runCount(left.id)).toBe(1);
    expect(runCount(joined2.id)).toBe(1);
  });

  test("an unscoped 「任意」 rule sees both halves of a switch (two real facts)", async () => {
    seedWifi("Home-2.4G");
    saveShortcuts([wifiShortcut("switch-any", { ssid: "", event: "any" })]);
    stop = startShortcutTriggers();
    await flush();

    writeStoreValue(WIFI_KEY, { current: "Cafe_Free", saved: ["Home-2.4G", "Cafe_Free"], passwords: {} });
    await flush();

    // `fire` deliberately does not dedupe non-time events: leaving Home and joining Cafe are
    // two things that happened.
    expect(runCount("switch-any")).toBe(2);
  });

  test("a rule scoped to another SSID does not run for this join", async () => {
    // The old source stamped the *remembered* SSID onto a reachability event, so an
    // SSID-scoped rule could fire for a network that was never involved.
    const other = wifiShortcut("join-library", { ssid: "Library_Guest", event: "connect" });
    saveShortcuts([other]);
    stop = startShortcutTriggers();
    await flush();

    writeStoreValue(WIFI_KEY, { current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} });
    await flush();

    expect(runCount(other.id)).toBe(0);
  });

  test("a write that does not change the joined network is not a transition", async () => {
    saveShortcuts([wifiShortcut("idle", { ssid: "Cafe_Free", event: "any" })]);
    stop = startShortcutTriggers();
    await flush();

    writeStoreValue(WIFI_KEY, { current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} });
    await flush();
    // A second write with the same `current` (e.g. the same network re-saved) is not a join.
    writeStoreValue(WIFI_KEY, { current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} });
    await flush();

    expect(runCount("idle")).toBe(1);
  });

  test("an unrelated store write does not run a Wi-Fi rule", async () => {
    const sc = wifiShortcut("noise", { ssid: "", event: "any" });
    saveShortcuts([sc]);
    stop = startShortcutTriggers();
    await flush();

    writeStoreValue("amos.unrelated", { anything: true });
    await flush();

    expect(runCount(sc.id)).toBe(0);
  });
});
