/**
 * shell.svelte.test.ts — Svelte top-level Shell decision tree (Phase-3 ③).
 *
 * Drives shellState and asserts Shell renders the matching Svelte surface:
 * lock→LockScreen, edit→EditHome, app→app surface (back→home), home→HomeDock;
 * overlays (Spotlight / Notification Center) open from shellState; Esc closes them.
 * HomeDock/EditHome are fed their controlled channels by Shell from shellState.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Shell from "../src/svelte/Shell.svelte";
import { resetPropsChannels, propsChannel } from "../src/svelte/propsBus";
import {
  applyLayout,
  enterEdit,
  lock,
  open,
  resetShellState,
  setNc,
  setRecents,
  setSpot,
  layout,
  pulseId,
  unlock,
} from "../src/svelte/shellState.svelte";
import { moveBefore, readStoreValue, writeStoreValue, RECENTS_KEY } from "../src/lib/amosStore";
import { CONTACTS_KEY } from "../src/lib/contacts";
import { NOTIF_KEY } from "../src/lib/settings";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});
afterEach(() => {
  resetPropsChannels();
  resetShellState();
});

describe("Shell.svelte (surface decision tree)", () => {
  test("locked surface renders LockScreen", async () => {
    lock();
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    unlock();
  });

  test("home surface renders the Svelte HomeDock", async () => {
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });

  test("unmount disposes the channels the shell owns (no stale snapshot on remount)", async () => {
    const { unmount } = render(Shell);
    await tick();
    // Shell fed the controlled "home" channel from shellState during mount.
    const home = propsChannel<Record<string, unknown>>("home");
    expect(home.get()).toBeTruthy();

    unmount();

    // The host disposed its channels on teardown, so a fresh get starts clean
    // instead of inheriting the previous mount's props.
    expect(propsChannel<Record<string, unknown>>("home").get()).toBeUndefined();
  });

  test("edit surface renders EditHome (Done action present)", async () => {
    enterEdit();
    const { container } = render(Shell);
    await tick();
    const done = [...container.querySelectorAll("button")].find((b) =>
      (b.className ?? "").includes("bg-accent"),
    );
    expect(done).toBeTruthy();
  });

  test("app surface shows chrome + Back returns home", async () => {
    open("phone");
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
    const back = container.querySelector('button[aria-label="back"]') as HTMLButtonElement | null;
    expect(back).toBeTruthy();
    await fireEvent.click(back!);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });

  test("an id with no screen shows an honest message, never a blank frame", async () => {
    // An unknown id can still reach `open()` (a link, a persisted layout, a
    // manifest). The surface must say so rather than render nothing.
    open("nope-not-an-app");
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
    const box = container.querySelector('[data-testid="app-unavailable"]');
    expect(box).toBeTruthy();
    expect(box?.textContent ?? "").toContain("未知应用");
    expect(box?.textContent ?? "").toContain("nope-not-an-app");
  });

  test("app surface hosts a scrollable region so tall content-flow apps can be paged", async () => {
    open("settings");
    const { container } = render(Shell);
    await tick();
    const surface = container.querySelector('[data-testid="app-surface"]');
    expect(surface).toBeTruthy();
    // the app host is the ScrollView → an overflow-y-auto region exists under the
    // surface chrome (this is what lets a Settings/Phone list scroll on device)
    const host = surface?.querySelector(".overflow-y-auto");
    expect(host).toBeTruthy();
    // and it is bounded (min-h-0 flex-1) so it fills the space under the header
    expect(host?.className ?? "").toContain("min-h-0");
  });

  test("first launch seeds the address book once (so Contacts/Phone are not empty)", async () => {
    // Fresh install: the key is absent.
    expect(readStoreValue<unknown>(CONTACTS_KEY, undefined)).toBeUndefined();
    render(Shell);
    await tick();
    const seeded = readStoreValue<unknown>(CONTACTS_KEY, undefined);
    expect(Array.isArray(seeded)).toBe(true);
    expect((seeded as unknown[]).length).toBeGreaterThan(0);
  });

  test("an intentionally emptied address book is never resurrected", async () => {
    writeStoreValue(CONTACTS_KEY, []); // the user deleted everyone
    render(Shell);
    await tick();
    // Still empty: seeding keys off an ABSENT store, not an empty list.
    expect(readStoreValue<unknown>(CONTACTS_KEY, undefined)).toEqual([]);
  });

  test("Spotlight overlay opens from shellState and closes on setSpot(false)", async () => {
    setSpot(true);
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeTruthy();
    setSpot(false);
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeNull();
  });

  test("Notification Center overlay shows quick tiles when opened", async () => {
    setNc(true);
    const { container } = render(Shell);
    await tick();
    expect(container.querySelectorAll('button[aria-pressed]').length).toBeGreaterThanOrEqual(6);
  });

  test("Escape closes an open overlay", async () => {
    setSpot(true);
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeNull();
  });

  test("app surface Home indicator returns to the home surface", async () => {
    open("phone");
    const { container } = render(Shell);
    await tick();
    const home = container.querySelector('button[data-testid="home-indicator"]') as HTMLButtonElement | null;
    expect(home).toBeTruthy();
    await fireEvent.click(home!);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });


  test("tapping a HomeDock dock icon opens the app surface via Shell", async () => {
    applyLayout({ page: [], dock: ["phone"], hidden: [] });
    const { container } = render(Shell);
    await tick();
    const phone = container.querySelector(
      `button[aria-label="${zh["app.phone"]}"]`,
    ) as HTMLButtonElement | null;
    expect(phone).toBeTruthy();
    await fireEvent.click(phone!);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
  });

  test("tapping the monitor dock tile opens the System Monitor app surface", async () => {
    applyLayout({ page: [], dock: ["monitor"], hidden: [] });
    const { container } = render(Shell);
    await tick();
    const tile = container.querySelector(
      `button[aria-label="${zh["app.monitor"]}"]`,
    ) as HTMLButtonElement | null;
    expect(tile).toBeTruthy();
    await fireEvent.click(tile!);
    await tick();
    const surf = container.querySelector('[data-testid="app-surface"]');
    expect(surf).toBeTruthy();
    // The app chrome shows the localized title (registry resolved `monitor`).
    expect(surf!.textContent ?? "").toContain(zh["app.monitor"]);
  });

  test("opening the calendar app really mounts its month grid through the registry", async () => {
    open("calendar");
    const { container } = render(Shell);
    await tick();
    const surf = container.querySelector('[data-testid="app-surface"]');
    expect(surf).toBeTruthy();
    expect(surf!.textContent ?? "").toContain(zh["app.calendar"]);
    // The registry's dynamic import resolves and the app screen renders for real
    // (not just the chrome) — the month grid is the calendar's own DOM.
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="cal-grid"]')).toBeTruthy();
    });
    expect(container.querySelectorAll("[data-day]").length).toBe(42);
  });

  test("unlocking from the LockScreen returns Shell to the home surface", async () => {
    lock();
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    const unlockBtn = [...container.querySelectorAll("button")].find(
      (b) => !b.getAttribute("aria-label"),
    );
    expect(unlockBtn).toBeTruthy();
    await fireEvent.click(unlockBtn as HTMLButtonElement);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });


  test("NC 'edit home' action routes Shell into the edit surface", async () => {
    setNc(true);
    const { container } = render(Shell);
    await tick();
    const editBtn = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "edit home",
    );
    expect(editBtn).toBeTruthy();
    await fireEvent.click(editBtn as HTMLButtonElement);
    await tick();
    // Edit surface shows its Done button (bg-accent).
    const done = [...container.querySelectorAll("button")].find((b) =>
      (b.className ?? "").includes("bg-accent"),
    );
    expect(done).toBeTruthy();
  });

  test("choosing a Recents row opens that app via Shell", async () => {
    writeStoreValue(RECENTS_KEY, ["clock"]);
    setRecents(true);
    const { container } = render(Shell);
    await tick();
    const row = container.querySelector(
      `button[aria-label="${zh["app.clock"]}"]`,
    ) as HTMLButtonElement | null;
    expect(row).toBeTruthy();
    await fireEvent.click(row!);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
  });


  test("NC 'search' opens the Spotlight overlay via Shell", async () => {
    setNc(true);
    const { container } = render(Shell);
    await tick();
    // Both the home pill and the NC action carry aria-label="search"; either
    // routes to Spotlight through Shell.
    const search = container.querySelector('button[aria-label="search"]') as HTMLButtonElement | null;
    expect(search).toBeTruthy();
    await fireEvent.click(search!);
    await tick();
    expect(container.querySelector("input[placeholder]")).toBeTruthy();
  });

  test("NC 'lock' routes Shell into the locked surface", async () => {
    setNc(true);
    const { container } = render(Shell);
    await tick();
    const lockBtn = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "lock",
    );
    expect(lockBtn).toBeTruthy();
    await fireEvent.click(lockBtn as HTMLButtonElement);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy(); // LockScreen
  });

  test("choosing a Spotlight result soft-launches (stays home + pulses)", async () => {
    setSpot(true);
    const { container } = render(Shell);
    await tick();
    // The home now ships a real default layout (seeded dock + page), so a "时钟"
    // tile also lives on the home page. The Spotlight overlay is rendered AFTER
    // the home content in the DOM, so pick the LAST "时钟" button = the Spotlight
    // result, not the home tile (which would open the app).
    const clocks = [
      ...container.querySelectorAll(`button[aria-label="${zh["app.clock"]}"]`),
    ];
    const spotlightResult = clocks[clocks.length - 1];
    expect(spotlightResult).toBeTruthy();
    await fireEvent.click(spotlightResult!);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeNull(); // stays home
    expect(pulseId()).toBe("clock"); // soft-launch pulse set
  });

  test("App Library entry routes Shell into the library surface and back home", async () => {
    const { container } = render(Shell);
    await tick();
    const entry = container.querySelector(
      'button[data-testid="app-library-entry"]',
    ) as HTMLButtonElement | null;
    expect(entry).toBeTruthy();
    await fireEvent.click(entry!);
    await tick();
    // The library surface (category folders) replaces the home grid.
    expect(container.querySelector('[data-testid="home-grid"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-library"]')).toBeTruthy();
    // Its home indicator returns to the dock home.
    const home = container.querySelector(
      'button[data-testid="library-home-indicator"]',
    ) as HTMLButtonElement | null;
    expect(home).toBeTruthy();
    await fireEvent.click(home!);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });


});

  test("HomeDock dock reorder via Shell persists to shellState layout", async () => {
    applyLayout({ page: [], dock: ["phone", "messages"], hidden: [] });
    const { container } = render(Shell);
    await tick();

    const phone = container.querySelector(
      `button[aria-label="${zh["app.phone"]}"]`,
    ) as HTMLButtonElement | null;
    const messages = container.querySelector(
      `button[aria-label="${zh["app.messages"]}"]`,
    ) as HTMLButtonElement | null;
    expect(phone).toBeTruthy();
    expect(messages).toBeTruthy();

    await fireEvent.dragStart(phone!);
    await fireEvent.drop(messages!);
    await tick();

    const expected = moveBefore({ page: [], dock: ["phone", "messages"], hidden: [] }, "phone", "messages");
    expect(layout()).toEqual(expected);
  });

describe("Shell.svelte (edge gestures)", () => {
  const rootOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;
  /** Simulate an edge drag: down at `fromY`, move to `toY`, release. */
  const swipe = (el: HTMLElement, fromY: number, toY: number) => {
    el.dispatchEvent(new MouseEvent("pointerdown", { clientY: fromY, bubbles: true }));
    el.dispatchEvent(new MouseEvent("pointermove", { clientY: toY, bubbles: true }));
    el.dispatchEvent(new MouseEvent("pointerup", { clientY: toY, bubbles: true }));
  };

  test("a pull DOWN from the top edge opens the Notification Center", async () => {
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector(`[aria-label="${zh["nc.title"]}"]`)).toBeNull();
    swipe(rootOf(container), 10, 10 + 60);
    await tick();
    expect(container.querySelector(`[aria-label="${zh["nc.title"]}"]`)).toBeTruthy();
  });

  test("a pull UP from the bottom edge opens Recents", async () => {
    const { container } = render(Shell);
    await tick();
    const h = window.innerHeight;
    expect(container.textContent ?? "").not.toContain(zh["shell.recents"]);
    swipe(rootOf(container), h - 20, h - 20 - 60);
    await tick();
    expect(container.textContent ?? "").toContain(zh["shell.recents"]);
  });

  test("a body drag (not started at an edge) opens nothing", async () => {
    const { container } = render(Shell);
    await tick();
    swipe(rootOf(container), 400, 470);
    await tick();
    expect(container.querySelector(`[aria-label="${zh["nc.title"]}"]`)).toBeNull();
    expect(container.textContent ?? "").not.toContain(zh["shell.recents"]);
  });

  test("a too-short edge drag does not fire (below threshold)", async () => {
    const { container } = render(Shell);
    await tick();
    swipe(rootOf(container), 10, 10 + 10);
    await tick();
    expect(container.querySelector(`[aria-label="${zh["nc.title"]}"]`)).toBeNull();
  });

  test("no edge gesture on the lock screen", async () => {
    lock();
    const { container } = render(Shell);
    await tick();
    swipe(rootOf(container), 10, 10 + 60);
    await tick();
    expect(container.querySelector(`[aria-label="${zh["nc.title"]}"]`)).toBeNull();
  });
});

describe("Shell.svelte (screen-state reporting)", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  /** Install a fake bridge recording every `invoke(command, args)`. */
  function bridge(spy: Array<{ cmd: string; args?: Record<string, unknown> }>) {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        spy.push({ cmd, args });
        // A previous run left the display `off` on disk (the case the boot
        // re-assert exists to clear).
        if (cmd === "screen_state_get") return { on: false };
        if (cmd === "screen_state_set") return { on: Boolean(args?.on) };
        return null;
      },
      listen: async () => () => {},
    };
  }

  const lastSet = (spy: Array<{ cmd: string; args?: Record<string, unknown> }>) =>
    [...spy].reverse().find((c) => c.cmd === "screen_state_set");

  test("boot while unlocked re-asserts screen on (clears a stale off)", async () => {
    const spy: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    bridge(spy);
    render(Shell);
    await tick();
    for (let i = 0; i < 100 && !spy.some((c) => c.cmd === "screen_state_set"); i++) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(spy.some((c) => c.cmd === "screen_state_get")).toBe(true);
    expect(lastSet(spy)?.args).toEqual({ on: true });
  });

  test("locking reports screen off; unlocking reports screen on", async () => {
    const spy: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    bridge(spy);
    render(Shell);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 10));
    spy.length = 0;

    lock();
    await tick();
    expect(lastSet(spy)?.args).toEqual({ on: false });

    spy.length = 0;
    unlock();
    await tick();
    expect(lastSet(spy)?.args).toEqual({ on: true });
  });
});

describe("Shell.svelte (store tiles)", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  /** Bridge that reports one installed store app. */
  function bridgeWithInstalled() {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "appstore_installed") {
          return [
            {
              manifest: {
                id: "org.amos.demo",
                name: "Demo",
                summary: "",
                author: "",
                version: { major: 1, minor: 0, patch: 0 },
                category: "utility",
                package: { url: "", sha256: "" },
              },
              installed_at: 1,
            },
          ];
        }
        return null;
      },
      listen: async () => () => {},
    };
  }

  test("an installed store app appears on the home screen", async () => {
    bridgeWithInstalled();
    // Put the store tile on the home page (as the App Library's "add to dock"
    // would). The tile cache is only populated by loadStoreTiles() — which nothing
    // called before the shell wired it, so an installed app was invisible.
    applyLayout({ page: ["clock", "store:org.amos.demo"], dock: [], hidden: [] });
    const host = render(Shell);
    await vi.waitFor(() => {
      expect(host.container.textContent ?? "").toContain("Demo");
    });
  });

  test("opening a store tile explains the missing runtime host (never blank)", async () => {
    bridgeWithInstalled();
    const host = render(Shell);
    await tick();
    open("store:org.amos.demo");
    await tick();
    expect(host.container.querySelector('[data-testid="ext-app-pending"]')).toBeTruthy();
    // The manifest id is named and the honest reason is shown.
    const text = host.container.textContent ?? "";
    expect(text).toContain("org.amos.demo");
    expect(text).toContain("web-bundle");
  });
});

describe("Shell.svelte (clipboard announce mount)", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("a clipboard-changed notice surfaces the announce toast", async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async () => null,
      listen: async (ch: string, h: (e: { payload: unknown }) => void) => {
        handlers[ch] = h;
        return () => {};
      },
    };
    const { container } = render(Shell);
    await tick();
    for (let i = 0; i < 100 && typeof handlers["clipboard-changed"] !== "function"; i++) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(typeof handlers["clipboard-changed"]).toBe("function");
    handlers["clipboard-changed"]({ payload: { seq: 1, timestamp_ms: 1, source: "container" } });
    await tick();
    expect(container.querySelector('[data-testid="clipboard-announce"]')).toBeTruthy();
  });
});

describe("Shell.svelte (telemetry-spy watch)", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  const highHit = (severity = "high") => ({
    payload: {
      ts_ms: 1,
      iface: "wlan0",
      src_ip: "10.0.0.2",
      src_port: 40000,
      dst_ip: "203.0.113.9",
      dst_port: 80,
      protocol: "tcp",
      hits: [{ kind: "serial", occurrences: 1, confidence: "low" }],
      payload_bytes: 128,
      severity,
      confidence: "high",
    },
  });

  async function renderAndCapture(
    handlers: Record<string, (e: { payload: unknown }) => void>,
  ) {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async () => null,
      listen: async (ch: string, h: (e: { payload: unknown }) => void) => {
        handlers[ch] = h;
        return () => {};
      },
    };
    render(Shell);
    await tick();
    for (let i = 0; i < 100 && typeof handlers["telemetry-spy-hit"] !== "function"; i++) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(typeof handlers["telemetry-spy-hit"]).toBe("function");
  }

  test("a high telemetry-spy-hit becomes a durable notification", async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    await renderAndCapture(handlers);
    handlers["telemetry-spy-hit"](highHit());
    await tick();
    const stored = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as {
      title: string;
    }[];
    const prefix = zh["spy.notif.title"].split("{")[0].trim();
    expect(stored.some((n) => n.title.startsWith(prefix))).toBe(true);
  });

  test("a non-high hit is ignored (no notification)", async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    await renderAndCapture(handlers);
    handlers["telemetry-spy-hit"](highHit("low"));
    await tick();
    // The shell seeds demo notifications on first mount, so assert on spy hits
    // specifically (none should be added for a non-high severity).
    const stored = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as {
      title: string;
    }[];
    const prefix = zh["spy.notif.title"].split("{")[0].trim();
    expect(stored.some((n) => n.title.startsWith(prefix))).toBe(false);
  });
});


