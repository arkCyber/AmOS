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
  goHome,
  lock,
  ncOpen,
  open,
  recentsOpen,
  resetShellState,
  setNc,
  setRecents,
  setSpot,
  spotOpen,
  layout,
  pulseId,
  unlock,
} from "../src/svelte/shellState.svelte";
import { moveBefore, readStoreValue, writeStoreValue, RECENTS_KEY, LAYOUT_KEY } from "../src/lib/amosStore";
import { CONTACTS_KEY } from "../src/lib/contacts";
import { NOTIF_KEY } from "../src/lib/settings";
import { LAYOUT_CHANGED_EVENT, type LayoutSnapshot } from "../src/lib/wm";
import { WAKE_HOME_MIN_MS } from "../src/lib/display";
import { setFormFactor } from "../src/lib/desktopApps";
import { zh } from "../src/i18n/locales/zh";

/** A host snapshot of the class under test (the shape `wm_layout_snapshot` returns). */
const snap = (over: Partial<LayoutSnapshot> = {}): LayoutSnapshot => ({
  screen_w: 1496,
  screen_h: 881,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
  ...over,
});

type Listener = (e: { payload: unknown }) => void;

/** Every bridge call the shell made, in order (command + args) — so a test can assert
 * *what* the shell asked for, not merely that it asked. */
let bridgeCalls: Array<{ cmd: string; args?: Record<string, unknown> }>;

/** Install a fake host so the shell's own class-dependent chrome can be driven. */
function installHost(answer: () => unknown) {
  const listeners = new Map<string, Listener>();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      bridgeCalls.push({ cmd, args });
      if (cmd === "wm_layout_snapshot") return answer();
      if (cmd === "wm_set_shell_title") return (args?.title as string | null) ?? "Amos";
      return null;
    },
    listen: async (channel: string, handler: Listener) => {
      listeners.set(channel, handler);
      return () => listeners.delete(channel);
    },
  };
  return {
    push: (s: LayoutSnapshot) => listeners.get(LAYOUT_CHANGED_EVENT)?.({ payload: s }),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
  setFormFactor(null);
  bridgeCalls = [];
});
afterEach(() => {
  resetPropsChannels();
  resetShellState();
  setFormFactor(null);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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
    await open("phone");
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
    const back = container.querySelector(`button[aria-label="${zh["a11y.back"]}"]`) as HTMLButtonElement | null;
    expect(back).toBeTruthy();
    await fireEvent.click(back!);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });

  test("an id with no screen shows an honest message, never a blank frame", async () => {
    // An unknown id can still reach `open()` (a link, a persisted layout, a
    // manifest). The surface must say so rather than render nothing.
    await open("nope-not-an-app");
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
    const box = container.querySelector('[data-testid="app-unavailable"]');
    expect(box).toBeTruthy();
    expect(box?.textContent ?? "").toContain("未知应用");
    expect(box?.textContent ?? "").toContain("nope-not-an-app");
  });

  test("app surface hosts a scrollable region so tall content-flow apps can be paged", async () => {
    await open("settings");
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
    await open("phone");
    const { container } = render(Shell);
    await tick();
    const home = container.querySelector('button[data-testid="home-indicator"]') as HTMLButtonElement | null;
    expect(home).toBeTruthy();
    await fireEvent.click(home!);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });

  test("the launcher window renders DesktopShell (TopBar + Dock + Stage), never an app surface", async () => {
    // The PC desktop form factor (Phase 3 alignment) renders its own chrome for the
    // **launcher** window — the one shell-entry.ts leaves at surface `home` (a launcher
    // window carries no `#window=` fragment). REQ-A416 narrowed this rule: an app window
    // renders its own app (see the test below), so this case pins the launcher's half.
    // The host is the only authority on the form factor; the shell never guesses from
    // the viewport.
    installHost(() => snap({ form: "desktop" }));
    const { container } = render(Shell);
    await tick();
    // Wait for `wm_layout_snapshot()` round-trip + onLayoutChanged push to settle.
    // DesktopShell needs the snapshot before it can route, and the Shell needs the
    // 40 ms tick to give the promises time.
    await new Promise((r) => setTimeout(r, 80));

    // Desktop shell renders its own chrome — TopBar / Dock / 启动台入口 / spotlight.
    expect(container.querySelector('[data-testid="app-surface"]')).toBeNull();
    expect(container.querySelector('button[data-testid="home-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="dynamic-island"]')).toBeNull();
    // macOS shell: TopBar (aria-label uses i18n key) and Dock (role=toolbar) are
    // present; together they're the unambiguous DesktopShell signature.
    const topbar = container.querySelector(
      '[aria-label="顶部菜单栏"], [aria-label="Top Menu Bar"]',
    );
    expect(topbar).toBeTruthy();
    const dock = container.querySelector('[aria-label="底部 Dock"], [aria-label="Dock"]');
    expect(dock).toBeTruthy();
  });

  test("a desktop APP window renders the app it addresses, not a second desktop (REQ-A416)", async () => {
    // `wm_open(label)` builds a real `WebviewWindow` at `index.html#window=<label>`
    // (crates/amos-tauri/src/wm.rs) and `shell-entry.ts` turns that fragment into
    // `open(label)`. Before this round the desktop branch rendered `DesktopShell` for
    // **every** window, so on a PC every "app window" was another copy of the desktop
    // and no window ever drew an app — while `docs/PC_DESKTOP_ARCHITECTURE.md` §2.2
    // documented `app — 聚焦 app 窗口`.
    installHost(() => snap({ form: "desktop" }));
    await open("settings");
    const { container } = render(Shell);
    await tick();
    await new Promise((r) => setTimeout(r, 80));

    const surface = container.querySelector('[data-testid="app-surface"]');
    expect(surface, "an app window must show its app").toBeTruthy();
    expect(surface?.getAttribute("data-window-app")).toBe("settings");
    // The desktop chrome belongs to the launcher window: an app window has none.
    expect(container.querySelector('[aria-label="底部 Dock"], [aria-label="Dock"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="顶部菜单栏"], [aria-label="Top Menu Bar"]'),
    ).toBeNull();
    // The app itself really mounted (Settings has a screen in this build), so this is
    // not merely "a wrapper div appeared".
    await vi.waitFor(() => {
      expect(container.textContent ?? "").toContain(zh["settings.dock.title"]);
    });
  });

  test("a desktop APP window does not navigate itself home on a wake (REQ-A429)", async () => {
    // Measured on this machine (2026-09-18): with the Settings window open, a plain
    // **focus change** (⌘M hid a sibling window) made that app window call `goHome()` —
    // it re-rendered the desktop shell *inside* an app window (the REQ-A416 defect, this
    // time reached through a watcher) and its title bar flipped back to the label-derived
    // English name. `Shell.svelte` mounts the shell-level navigation watchers in *every*
    // window, but on a desktop a window that **is** one app (REQ-A416) must not navigate
    // itself: wake-home / auto-off lock / hardware nav belong to the window that is the
    // shell. (On a phone there is one window and surfaces are its modes — see the control
    // test below, which stays green.)
    installHost(() => snap({ form: "desktop" }));
    await open("settings");
    const { container } = render(Shell);
    await tick();
    await new Promise((r) => setTimeout(r, 80));
    expect(container.querySelector('[data-window-app="settings"]')).toBeTruthy();

    // A real wake: away for longer than the gate's minimum, then back.
    fireEvent(window, new Event("blur"));
    await new Promise((r) => setTimeout(r, WAKE_HOME_MIN_MS + 150));
    fireEvent(window, new Event("focus"));
    await tick();
    await new Promise((r) => setTimeout(r, 60));

    // Still that app — not the desktop, not the home screen.
    expect(
      container.querySelector('[data-window-app="settings"]'),
      "an app window must not turn itself into the desktop on a wake",
    ).toBeTruthy();
    expect(container.querySelector('[aria-label="底部 Dock"], [aria-label="Dock"]')).toBeNull();
  });

  test("a touch class STILL returns home on a wake (the guard is not global) (REQ-A429)", async () => {
    // The control: on a phone the shell has one window and surfaces are its modes, so a
    // real wake must keep returning to the dock exactly as before.
    installHost(() => snap({ form: "phone", screen_w: 480, screen_h: 820 }));
    await open("settings");
    const { container } = render(Shell);
    await tick();
    await new Promise((r) => setTimeout(r, 60));
    expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();

    fireEvent(window, new Event("blur"));
    await new Promise((r) => setTimeout(r, WAKE_HOME_MIN_MS + 150));
    fireEvent(window, new Event("focus"));
    await tick();
    await new Promise((r) => setTimeout(r, 60));

    expect(
      container.querySelector('[data-testid="app-surface"]'),
      "a phone surface must still be sent home by a wake",
    ).toBeNull();
  });

  test("a touch class keeps both, and a layout push flips them live (REQ-A249)", async () => {
    // The same shell, told it is a phone: today's chrome is unchanged. Then the host
    // re-classes it as a desktop on `layout-changed` — the chrome must follow that
    // push, not the value read at startup.
    const host = installHost(() => snap({ form: "phone", screen_w: 480, screen_h: 820 }));
    await open("phone");
    const { container } = render(Shell);
    await tick();
    await new Promise((r) => setTimeout(r, 40));
    expect(container.querySelector('button[data-testid="home-indicator"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="dynamic-island"]')).toBeTruthy();

    host.push(snap({ form: "desktop" }));
    await tick();
    expect(container.querySelector('button[data-testid="home-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="dynamic-island"]')).toBeNull();
  });
  test("the window's name follows what is on screen (REQ-A250)", async () => {
    // The defect this pins: the shell window carried the configured title for every
    // surface, so a Mac's title bar (and the window menu, and the Dock's window list)
    // said "Amos · AI System UI" while the window showed Settings.
    installHost(() => snap({ form: "desktop" }));
    await open("phone");
    render(Shell);
    await tick();
    // Wait longer for wm_open to complete and title to be set
    await new Promise((r) => setTimeout(r, 100));

    const asked = () =>
      bridgeCalls.filter((c) => c.cmd === "wm_set_shell_title").map((c) => c.args?.title);

    // The app on screen, by its localized name — the same string the in-window chrome
    // shows, so the title bar and the window cannot disagree.
    expect(asked()).toContain(zh["app.phone"]);

    // Back to the launcher — whichever surface the desktop class renders (this test is
    // about the *title*, not about which component owns the desktop): the shell asks for
    // `null`, i.e. "restore the title the host was configured with". The product name is
    // not duplicated in the UI (REQ-A234's rule).
    bridgeCalls = [];
    goHome();
    await tick();
    await new Promise((r) => setTimeout(r, 40));
    expect(asked().length).toBeGreaterThan(0);
    expect(asked().every((t) => t === null)).toBe(true);
  });

  test("no title is sent where there is no title bar (REQ-A250)", async () => {
    // A phone/tablet app is fullscreen, and renaming an Android activity's label would
    // rename the app in the task switcher — so the shell asks for nothing there.
    installHost(() => snap({ form: "phone", screen_w: 480, screen_h: 820 }));
    await open("phone");
    render(Shell);
    await tick();
    await new Promise((r) => setTimeout(r, 40));
    expect(bridgeCalls.filter((c) => c.cmd === "wm_set_shell_title")).toEqual([]);
  });

  test("a desktop app window for a phone-only app says so instead of drawing a dialer (REQ-A251 + REQ-A416)", async () => {
    // Desktop form factor + a window addressing the phone app (it is not in the dock on
    // desktop, but a stray link or an old window could still address it).
    // REQ-A416: the window now shows its own app surface — and because `phone` has no
    // SIM on desktop, `svelteAppLoader` returns undefined, so the surface states that
    // instead of mounting `PhoneApp` (and instead of drawing a second desktop, which is
    // what every desktop window did before this round).
    installHost(() => snap({ form: "desktop" }));
    await open("phone");
    const { container } = render(Shell);
    await tick();
    await new Promise((r) => setTimeout(r, 80));
    const surface = container.querySelector('[data-testid="app-surface"]');
    expect(surface?.getAttribute("data-window-app")).toBe("phone");
    expect(
      container.textContent ?? "",
      "the window must explain why there is no dialer",
    ).toContain(zh["app.screenMissing"].replace("{id}", "phone"));
    // The sentence above can only be rendered by the `{:else}` branch of the app
    // surface, i.e. when no app component was mounted — so it *is* the negative control
    // for "PhoneApp never started" (a `[data-testid]` on PhoneApp would be a weaker,
    // copy-pasted assertion).
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
    // Wait for async open() to complete
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
    });
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
    // Wait for async open() to complete
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
    });
    const surf = container.querySelector('[data-testid="app-surface"]');
    // The app chrome shows the localized title (registry resolved `monitor`).
    expect(surf!.textContent ?? "").toContain(zh["app.monitor"]);
  });

  test("opening the calendar app really mounts its month grid through the registry", async () => {
    await open("calendar");
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
      (b) => b.getAttribute("aria-label") === zh["a11y.editHome"],
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
    // Wait for async open() to complete
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
    });
  });


  test("NC 'search' opens the Spotlight overlay via Shell", async () => {
    setNc(true);
    const { container } = render(Shell);
    await tick();
    // Both the home pill and the NC action carry aria-label="search"; either
    // routes to Spotlight through Shell.
    const search = container.querySelector(`button[aria-label="${zh["shell.search"]}"]`) as HTMLButtonElement | null;
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
      (b) => b.getAttribute("aria-label") === zh["a11y.lock"],
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

/**
 * Launcher → desktop wiring (REQ-A417 follow-up). Before this round the home /
 * App-Library "open" handlers always reached `open(id)`, a **touch**-shell surface
 * switch that `Shell.svelte` never translates on the desktop form. The Mac launcher
 * therefore sat at `surface=home` no matter what the user tapped, and every doc/
 * audit claimed "the home launcher can open apps on the desktop" while the
 * implementation said otherwise.
 *
 * The fix: a `launchApp(id)` helper that picks `wm_open` on the desktop and the
 * legacy surface switch everywhere else. The cases below pin both halves — the
 * decision (which command reaches the host) and the visible outcome (what
 * `surface` ends up being).
 *
 * Why the desktop cases render `DesktopShell` and the phone case renders `Shell`:
 * REQ-A416 split the desktop form into two windows — the **launcher** carries
 * `DesktopShell` (top bar, dock, stage, overlays); an app window carries
 * `DesktopAppWindow`. The launcher is what users tap on, so "tapping a desktop
 * tile reaches `wm_open`" is an assertion about the launcher window's own chrome.
 * The phone form keeps using `Shell` + `HomeDock`, so its control lives there.
 */
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import { resetDesktopFeaturesForTest } from "../src/lib/desktopFeatures";
import { setFormFactor as setFormFactorLib } from "../src/lib/desktopApps";

const DESKTOP_SNAPSHOT = {
  screen_w: 1496,
  screen_h: 882,
  split: null,
  candidates: [],
  form: "desktop" as const,
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

/** Recorder host for DesktopShell: returns the desktop snapshot and records every
 * `wm_open(label)` call. Boot reads (`wm_windows`, `wm_layout_snapshot`,
 * `desktop_features_disabled`) are not user gestures and are filtered out. */
function installRecorderHost() {
  const opens: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      if (cmd === "desktop_features_disabled") return [];
      if (cmd === "wm_open") {
        const label = (args as { label?: string } | undefined)?.label;
        if (typeof label === "string") opens.push(label);
        return { windows: [] };
      }
      return null;
    },
    listen: async () => () => {},
  };
  return opens;
}

const press = (key: string, mods: Record<string, boolean> = {}): KeyboardEvent => {
  const ev = new KeyboardEvent("keydown", { key, cancelable: true, ...mods });
  window.dispatchEvent(ev);
  return ev;
};

describe("DesktopShell — launcher routes to wm_open on the desktop form", () => {
  beforeEach(() => {
    resetDesktopFeaturesForTest();
    setFormFactorLib("desktop");
  });
  const settle = () => new Promise((r) => setTimeout(r, 40));

  test("desktop form: tapping a Dock app tile reaches the host as wm_open(id)", async () => {
    const opens = installRecorderHost();
    // `notes` is not a phone app, so the Dock renders it on the desktop form factor
    // (`Dock.svelte` runs every user dock id through `withoutPhone`; phone apps
    // are mobile-only and do not appear on a desktop Dock).
    writeStoreValue(LAYOUT_KEY, { page: [], dock: ["notes"], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    // The Dock uses `<DockAppItem>` (`data-testid="dock-app-{id}"`). The touch shell's
    // HomeDock selector (`button[aria-label="${zh["app.phone"]}"]`) would never
    // resolve here: a desktop shell does not mount HomeDock.
    const tile = container.querySelector<HTMLButtonElement>(
      '[data-testid="dock-app-notes"]',
    );
    expect(tile, "the Dock has rendered the user-pinned notes tile").toBeTruthy();
    await fireEvent.click(tile!);
    await tick();
    await settle();
    expect(opens).toEqual(["notes"]);
  });

  test("desktop form: a Launchpad tile tap also reaches wm_open (not open)", async () => {
    // The Launchpad is the desktop shell's second entry point (F4 / 🚀 in the bar /
    // 🚀 in the dock). Whatever widget owns the click, `launchApp` must route to the
    // host — not fall back to the touch shell's surface switch.
    const opens = installRecorderHost();
    writeStoreValue(LAYOUT_KEY, { page: [], dock: [], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    press("F4"); // open Launchpad
    await tick();
    await settle();
    const overlay = container.querySelector<HTMLElement>(
      '[data-testid="launchpad-overlay"]',
    );
    expect(overlay, "F4 summoned the Launchpad overlay").toBeTruthy();
    // The same `app.notes` aria-label may also live in the Stage icon grid; pick
    // the one inside the overlay container.
    const tile = overlay!.querySelector<HTMLButtonElement>(
      `button[aria-label="${zh["app.notes"]}"]`,
    );
    expect(tile, "the Launchpad overlay shows a Notes tile").toBeTruthy();
    await fireEvent.click(tile!);
    await tick();
    await settle();
    expect(opens).toEqual(["notes"]);
  });

  test("desktop form: a refused wm_open leaves the launcher at home (no surface flip, no fake app)", async () => {
    // REQ-A297 phase-2 §4: a `wm_open` that returns `null` is the "host refused"
    // signal. The launcher must NOT compensate by flipping its own surface to
    // `app(id)` — that would render an app it never opened. The case asserts the
    // visible half: a refused Dock click does not put the launcher window into an
    // app surface (which is what `DesktopAppWindow` would mount in an *app* window).
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
        if (cmd === "wm_windows") return { windows: [] };
        if (cmd === "desktop_features_disabled") return [];
        // wm_open returns null ⇒ refused.
        return null;
      },
      listen: async () => () => {},
    };
    writeStoreValue(LAYOUT_KEY, { page: [], dock: ["notes"], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const tile = container.querySelector<HTMLButtonElement>(
      '[data-testid="dock-app-notes"]',
    );
    expect(tile).toBeTruthy();
    await fireEvent.click(tile!);
    await tick();
    await settle();
    // DesktopShell never renders `[data-testid="app-surface"]` — that belongs to
    // DesktopAppWindow, which is what Shell mounts in an *app* window. The launcher
    // window, on a refused click, stays a launcher.
    expect(container.querySelector('[data-testid="app-surface"]')).toBeNull();
    // The dock, the top bar and the stage are still there (the launcher's chrome).
    expect(container.querySelector('[data-testid="dock-panel"]')).toBeTruthy();
    expect(container.querySelector(`[aria-label="${zh["desktop.dock"]}"]`)).toBeTruthy();
  });
});

describe("Shell.svelte — phone form keeps the touch surface switch", () => {
  // The control: on the touch form the launcher is `HomeDock`, the tap calls
  // `open()`, and the shell surface flips to `app(id)`. No `wm_open` reaches the
  // bridge — the host has no real windows to open on a phone.
  beforeEach(() => setFormFactorLib("phone"));
  const settle = () => new Promise((r) => setTimeout(r, 40));

  test("phone form: the same tap goes through open() and reaches the app surface (no wm_open)", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "wm_set_shell_title") return (args?.title as string | null) ?? "Amos";
        return null;
      },
      listen: async () => () => {},
    };
    applyLayout({ page: [], dock: ["phone"], hidden: [] });
    const { container } = render(Shell);
    await tick();
    await settle();
    const tile = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${zh["app.phone"]}"]`,
    );
    expect(tile).toBeTruthy();
    const callsBefore = calls.length;
    await fireEvent.click(tile!);
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="app-surface"]')).toBeTruthy();
    });
    // No `wm_open` was sent. We slice from `callsBefore` so the only entries are
    // user-driven calls; mount-time reads were excluded by the pre-click guard.
    expect(calls.slice(callsBefore).filter((c) => c.cmd === "wm_open")).toEqual([]);
  });
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

  /** Bridge that reports one installed store app, with a runnable web bundle. */
  function bridgeWithInstalled(entry?: { url: string; start: string } | "reject") {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        bridgeCalls.push({ cmd, args });
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
        if (cmd === "appstore_bundle_entry") {
          if (entry === "reject") throw new Error("no web install dir (set AMOS_APPSTORE_INSTALL_DIR)");
          return entry ?? { url: "amos-app://org.amos.demo/index.html", start: "index.html" };
        }
        // wm_* commands should not be called in phone mode, but return safely if they are
        if (cmd.startsWith("wm_")) return null;
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

  test("opening a store tile runs its bundle at the app's own origin", async () => {
    bridgeWithInstalled();
    const host = render(Shell);
    await tick();
    await open("store:org.amos.demo");
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="ext-app-frame"]')).toBeTruthy();
    });
    const frame = host.container.querySelector('[data-testid="ext-app-frame"]') as HTMLIFrameElement;
    // The app's OWN origin — not the index's, not the shell's — is what makes the
    // bundle same-origin with its own assets and cross-origin to AmOS.
    expect(frame.getAttribute("src")).toBe("amos-app://org.amos.demo/index.html");
    // Sandboxed, and without the flags that would let it escape (no top-navigation,
    // no popups, no modals). `allow-same-origin` is safe only because the frame is
    // cross-origin to the shell.
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-popups");
  });

  test("a bundle the host cannot serve explains why (never blank)", async () => {
    bridgeWithInstalled("reject");
    const host = render(Shell);
    await tick();
    await open("store:org.amos.demo");
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="ext-app-failed"]')).toBeTruthy();
    });
    const text = host.container.textContent ?? "";
    // The host's own words, not a generic shrug.
    expect(text).toContain("AMOS_APPSTORE_INSTALL_DIR");
    expect(text).toContain("无法运行");
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



/**
 * The touch shell's **keyboard admission**, re-wired after the rollback that lost REQ-A335/A336/A338
 * (REQ-A346). The pure decisions live in `lib/systemKeys.ts` and have their own unit tests; these
 * cases pin the wiring to the real component, because that is what was missing: the engine could
 * decide, and nothing asked it.
 */
describe("Shell.svelte — keyboard admission (REQ-A346)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 40));
  const press = (key: string, init: KeyboardEventInit = {}) =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  const spot = (c: HTMLElement) => c.querySelector("input[placeholder]");
  const sheet = (c: HTMLElement) => c.querySelector('[role="dialog"]');

  test("⌘Space opens Spotlight, and the same key closes it", async () => {
    installHost(() => snap({ form: "phone", columns: 1, multi_window: false }));
    const { container } = render(Shell);
    await tick();
    await settle();
    expect(spot(container)).toBeNull();
    press(" ", { metaKey: true });
    await tick();
    expect(spot(container), "Spotlight opened by key").toBeTruthy();
    press(" ", { metaKey: true });
    await tick();
    expect(spot(container), "…and the same key closed it").toBeNull();
  });

  test("F4 reaches the App Library, and F4 again comes home", async () => {
    installHost(() => snap({ form: "phone", columns: 1, multi_window: false }));
    const { container } = render(Shell);
    await tick();
    await settle();
    press("F4");
    await tick();
    expect(container.querySelector('[data-testid="app-library"]')).toBeTruthy();
    press("F4");
    await tick();
    expect(container.querySelector('[data-testid="app-library"]')).toBeNull();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });

  test("Escape undoes exactly one level: the sheet first, the surface after", async () => {
    installHost(() => snap({ form: "phone", columns: 1, multi_window: false }));
    const { container } = render(Shell);
    await tick();
    await settle();
    press(" ", { metaKey: true }); // Spotlight over home
    await tick();
    expect(spot(container)).toBeTruthy();
    press("Escape");
    await tick();
    expect(spot(container), "Escape closed the sheet").toBeNull();
    expect(sheet(container), "…and nothing else was undone").toBeNull();
    expect(container.querySelector('[data-testid="home-grid"]'), "still home").toBeTruthy();
  });

  test("no key opens a surface on the lock screen (a keyboard is not a way around the lock)", async () => {
    installHost(() => snap({ form: "phone", columns: 1, multi_window: false }));
    lock();
    const { container } = render(Shell);
    await tick();
    await settle();
    press(" ", { metaKey: true });
    await tick();
    expect(spotOpen(), "⌘Space on the lock screen opens nothing").toBe(false);
    expect(ncOpen()).toBe(false);
    expect(recentsOpen()).toBe(false);
    expect(container.querySelector('[role="dialog"]'), "still locked").toBeTruthy();
  });
});


/**
 * The **history half** of system back (REQ-A347, re-wired): the host asks
 * `webView.canGoBack()` and the answer is only true if the shell pushed an entry **per level**.
 * Without it a back press inside an app leaves AmOS entirely — a device behaviour nobody can see in
 * a unit test of the decision tree, which is why these cases assert the *entries*, not the intent.
 */
describe("Shell.svelte — system back pushes one history entry per level (REQ-A347)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 40));
  const phone = () => installHost(() => snap({ form: "phone", columns: 1, multi_window: false }));

  test("an app is one entry, a sheet over it is a second — never one per transition", async () => {
    const pushes: unknown[] = [];
    vi.spyOn(window.history, "pushState").mockImplementation((s: unknown) => {
      pushes.push(s);
    });
    phone();
    await open("notes");
    const { container } = render(Shell);
    await tick();
    await settle();
    expect(pushes, "opening an app pushed exactly one entry").toHaveLength(1);
    expect(pushes[0]).toEqual({ amosDepth: 1 });

    setNc(true);
    await tick();
    await settle();
    expect(pushes, "the sheet over it is a second entry (one back press = one level)").toHaveLength(2);
    expect(pushes[1]).toEqual({ amosDepth: 2 });
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    vi.restoreAllMocks();
  });

  test("stepping back inside the shell pops the entry it no longer needs", async () => {
    const goes: number[] = [];
    vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    vi.spyOn(window.history, "go").mockImplementation((n?: number) => {
      goes.push(n ?? 0);
    });
    phone();
    await open("notes");
    const { container } = render(Shell);
    await tick();
    await settle();
    await fireEvent.click(container.querySelector<HTMLElement>('[aria-label]')!);
    goHome();
    await tick();
    await settle();
    expect(goes, "the shell rewinds the entry it no longer needs").toContain(-1);
    vi.restoreAllMocks();
  });

  test("the desktop form pushes nothing (real windows have their own close semantics)", async () => {
    const pushes: unknown[] = [];
    vi.spyOn(window.history, "pushState").mockImplementation((s: unknown) => {
      pushes.push(s);
    });
    installHost(() => snap({ form: "desktop", multi_window: true }));
    const { container } = render(Shell);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="home-grid"]') ?? container.firstElementChild).toBeTruthy();
    expect(pushes, "no history entries on the desktop form").toHaveLength(0);
    vi.restoreAllMocks();
  });
});

