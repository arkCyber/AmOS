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
  closeSysInk,
  enterEdit,
  enterSplit,
  exitSplit,
  hideSlideOver,
  openSlideOver,
  slideOver,
  goHome,
  lock,
  ncOpen,
  open,
  openSysInk,
  recentsOpen,
  resetShellState,
  setNc,
  setRecents,
  setSpot,
  spotOpen,
  layout,
  pulseId,
  surface,
  unlock,
} from "../src/svelte/shellState.svelte";
import { moveBefore, readStoreValue, writeStoreValue, RECENTS_KEY, LAYOUT_KEY } from "../src/lib/amosStore";
import { CONTACTS_KEY } from "../src/lib/contacts";
import { NOTIF_KEY } from "../src/lib/settings";
import { LAYOUT_CHANGED_EVENT, type LayoutSnapshot } from "../src/lib/wm";
import { SPLIT_KEY } from "../src/lib/splitPersist";
import { SLIDE_PERCENT_DEFAULT } from "../src/lib/slideOver";
import { AUTOOFF_STORE_KEY, WAKE_HOME_MIN_MS } from "../src/lib/display";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { BRIGHTNESS_KEY } from "../src/lib/brightness";
import { setStoreTiles } from "../src/lib/storeApps";
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

/** Install a fake host so the shell's own class-dependent chrome can be driven.
 * `extra` answers boot commands beyond the snapshot (e.g. `appstore_installed`). */
function installHost(answer: () => unknown, extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Listener>();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      bridgeCalls.push({ cmd, args });
      if (cmd === "wm_layout_snapshot") return answer();
      if (cmd === "wm_set_shell_title") return (args?.title as string | null) ?? "Amos";
      if (cmd in extra) return extra[cmd];
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

  // REQ-A1401: the idle watcher is started once (in `onMount`) and the sleep it
  // triggers is a surface change inside this same component — so the *wiring* has to
  // hand it the lock state it produced, or 「自动息屏」 fires once per app launch and
  // the display then stays lit forever after the first unlock.
  test("idle auto-off fires again after a wake, not only once per launch (REQ-A1401)", async () => {
    vi.useFakeTimers();
    try {
      writeStoreValue(AUTOOFF_STORE_KEY, 15);
      render(Shell);
      await tick();

      await vi.advanceTimersByTimeAsync(16_000);
      await tick();
      expect(surface().kind).toBe("lock");

      // The user unlocks; the next idle period must sleep the display again.
      unlock();
      await tick();
      expect(surface().kind).toBe("home");

      await vi.advanceTimersByTimeAsync(16_000);
      await tick();
      expect(surface().kind).toBe("lock");
    } finally {
      vi.useRealTimers();
    }
  });

  test("home surface renders the Svelte HomeDock", async () => {
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
  });

  test("a refused home-layout write keeps the grid and says so on screen (REQ-A1378)", async () => {
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();
    const before = layout();

    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      applyLayout({ page: ["clock"], dock: [], hidden: ["notes"] });
      await tick();
    } finally {
      spy.mockRestore();
    }

    // The icon the user dragged is still where it was — the screen backs up the store.
    expect(layout()).toEqual(before);
    expect(container.querySelector('[data-testid="store-write-error"]')?.textContent).toContain(
      zh["common.storeWriteFailed"],
    );

    // And a later accepted write clears the line.
    applyLayout({ page: ["notes"], dock: ["phone"], hidden: [] });
    await tick();
    expect(container.querySelector('[data-testid="store-write-error"]')).toBeNull();
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

  test("the home screen's long-press 'edit' action reaches the Edit surface", async () => {
    // HomeDock emits `edit` over the "home" channel when an icon is held; the shell
    // must translate it into the surface change (it handled open/move/search/library
    // only, so the action was a no-op end-to-end).
    const { container } = render(Shell);
    await tick();
    expect(container.querySelector('[data-testid="home-grid"]')).toBeTruthy();

    propsChannel<Record<string, unknown>>("home").emit("edit");
    await tick();
    expect(surface()).toEqual({ kind: "edit" });
    expect(container.querySelector('[data-testid="home-grid"]')).toBeNull();
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

  test("a store app installed at boot reaches the desktop Dock (REQ-A1179 wiring)", async () => {
    // The push chain — `Shell` (the only component that loads the tiles) → `DesktopShell` →
    // `SHELL_CHROME_API.storeTiles` — is the half no other test can see: the
    // `desktop-shell.svelte.test.ts` cases render `DesktopShell` directly and pass `ext` as a
    // prop, so they stay green even if `Shell` stops forwarding it. Here the *real* host
    // answers `appstore_installed`, the shell's own loader fills `ext`, and the assertion is
    // on the Dock's rendered label — i.e. on the whole chain, not on a prop.
    installHost(() => snap({ form: "desktop" }), {
      appstore_installed: [{ manifest: { id: "org.amos.demo", name: "Demo" } }],
    });
    writeStoreValue(LAYOUT_KEY, {
      page: [],
      dock: ["clock", "store:org.amos.demo"],
      hidden: [],
    });
    const { container } = render(Shell);
    await tick();
    await new Promise((r) => setTimeout(r, 80));

    const labels = [...container.querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toContain("Demo");
    expect(labels).not.toContain("store:org.amos.demo");
    // The built-in beside it is untouched — the filter widened, it did not replace.
    expect(labels).toContain(zh["app.clock"]);
  });

  test("a desktop APP window renders the app it addresses, not a second desktop (REQ-A416)", async () => {    // `wm_open(label)` builds a real `WebviewWindow` at `index.html#window=<label>`
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
    // The bound is explicit because the verdict this waits on is a **lazy dynamic
    // import** (`svelteAppLoader`), not a tick: `vi.waitFor`'s 1 s default is measured
    // against a cold vite transform of `SettingsApp.svelte`, which the file has grown
    // past (24.8 KB at HEAD → 34.9 KB) — measured 2026-09-22: this case reddened in
    // ~2 of 3 full-file runs, at ~2.3 s, green alone. Waiting on the app's own words
    // is right; the default ceiling was just below the work it was waiting for.
    await vi.waitFor(
      () => {
        expect(container.textContent ?? "").toContain(zh["settings.dock.title"]);
      },
      { timeout: 5000 },
    );
  });

  test("a desktop window of an INSTALLED app is named by the store registry (REQ-A1185 wiring)", async () => {
    // The `ext` half of the same chain the REQ-A1179 wiring test above covers: `Shell` loads
    // the tiles and hands them to `DesktopAppWindow` — which, unlike `DesktopShell`'s
    // surfaces, is *not* inside the `SHELL_CHROME_API` context (REQ-A416 routes app windows
    // around the shell), so the list can only reach it as a prop. The dedicated
    // `store-app-window-name.svelte.test.ts` passes `ext` directly and therefore stays green
    // even if `Shell` stops forwarding it; this case renders the whole chain instead.
    installHost(() => snap({ form: "desktop" }), {
      appstore_installed: [{ manifest: { id: "org.amos.demo", name: "Demo" } }],
    });
    await open("store:org.amos.demo");
    const { container } = render(Shell);
    await tick();
    await new Promise((r) => setTimeout(r, 80));

    const title = container.querySelector('[data-testid="app-window-title"]');
    expect(title, "the store app's window must mount").toBeTruthy();
    expect(title?.textContent?.trim()).toBe("Demo");
    expect(container.textContent).not.toContain("store:org.amos.demo");
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

  test("the desktop form renders the system ink layer when it is raised (REQ-A1590)", async () => {
    // The desktop Control Center (`control-center-panel` → `ControlCenter.svelte`) carries the
    // 系统级手写 button, whose `onclick` is `openSysInk()`. That button lives on the *desktop*
    // branch and `SystemInkLayer` used to be mounted only on the touch branch — so on a PC the
    // button set `_sysInkOpen` and nothing drew. This case mounts the real launcher window and
    // drives the same `openSysInk()` the button calls: the layer must exist in this window.
    installHost(() => snap({ form: "desktop" }));
    const { container } = render(Shell);
    await tick();
    await new Promise((r) => setTimeout(r, 80));

    // The desktop window is up (Control Center reaches this window) ...
    expect(container.querySelector('[aria-label="底部 Dock"], [aria-label="Dock"]')).toBeTruthy();
    // ... and nothing has raised the layer yet (the negative control: the mount is not
    // unconditional — a closed layer renders nothing).
    expect(container.querySelector('[data-testid="system-ink-layer"]')).toBeNull();

    openSysInk();
    await tick();
    expect(container.querySelector('[data-testid="system-ink-layer"]')).toBeTruthy();
    closeSysInk();
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

  test("the brightness dim layer rides the touch shell, not the desktop one (G-β-1)", async () => {
    // The desktop form draws this layer inside DesktopShell (see its own test); the
    // phone/tablet branch must draw its own, or the slider just added to the phone
    // Control Center would move a number nothing on screen honours.
    installHost(() => snap({ form: "phone", screen_w: 480, screen_h: 820 }));
    const { container } = render(Shell);
    await tick();
    // pct=100 (the default) = no dimming = no layer at all.
    expect(container.querySelector('[data-testid="brightness-overlay"]')).toBeNull();

    writeStoreValue(BRIGHTNESS_KEY, { pct: 30 });
    await tick();
    const overlay = container.querySelector('[data-testid="brightness-overlay"]');
    expect(overlay).toBeTruthy();
    expect(overlay?.getAttribute("data-brightness-pct")).toBe("30");
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
    // The sentence above can only be rendered by the app surface's terminal branch
    // (`{:else if noScreen}` — the loader answered "none" and no component was mounted) —
    // so it *is* the negative control for "PhoneApp never started" (a `[data-testid]` on
    // PhoneApp would be a weaker, copy-pasted assertion). The `{:else}` below it is the
    // loading state and deliberately never reaches this sentence.
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

  test("a hidden app picked from Spotlight opens instead of pulsing nowhere (REQ-A1362)", async () => {
    // Spotlight offers every built-in, including one the user hid from EditHome — home
    // draws only `layout.page` + `layout.dock`, so a "pulse the icon" launch had no
    // icon: the sheet closed, the shell stayed home and the screen did not change, i.e.
    // the pick looked like it had failed. With nowhere to pulse, it opens the app.
    applyLayout({ page: ["notes", "photos"], dock: ["phone", "ai", "interpreter"], hidden: ["clock"] });
    setSpot(true);
    const { container } = render(Shell);
    await tick();
    await fireEvent.input(container.querySelector("input") as HTMLInputElement, {
      target: { value: "clock" },
    });
    await tick();
    const result = container.querySelector<HTMLButtonElement>('[data-testid="spot-app-clock"]');
    expect(result, "Spotlight must still offer an installed app").toBeTruthy();
    await fireEvent.click(result!);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).not.toBeNull();
    expect(pulseId()).toBeNull(); // nothing was pulsed that nobody can see
  });

  test("a soft launch of an app on a later home page turns the grid to it (REQ-A1361)", async () => {
    setSpot(true);
    const { container } = render(Shell);
    await tick();
    // The seeded layout puts all 33 non-dock built-ins on the page and home opens on
    // page 1, so an app from further down the registry has no tile on screen at all.
    // Pre-fix the pulse was set on a tile nobody could see: the sheet closed, the shell
    // stayed home, and the screen did not change — the pick looked like it failed.
    const tile = () =>
      container.querySelector<HTMLElement>(
        `[data-testid="home-grid"] button[aria-label="${zh["app.webman"]}"]`,
      );
    expect(tile()).toBeNull();
    await fireEvent.input(container.querySelector("input") as HTMLInputElement, {
      target: { value: "webman" },
    });
    await tick();
    const result = container.querySelector<HTMLButtonElement>('[data-testid="spot-app-webman"]');
    expect(result, "Spotlight must offer the app it is being asked to launch").toBeTruthy();
    await fireEvent.click(result!);
    await tick();
    expect(container.querySelector('[data-testid="app-surface"]')).toBeNull();
    expect(pulseId()).toBe("webman");
    // …and the grid is now showing the page that holds it.
    expect(tile()?.innerHTML).toContain("animate-pulse");
  });

  test("picking the SAME Spotlight result again still turns the grid to it (REQ-A1361)", async () => {
    // The second pick re-states an id the shell already holds. Svelte compares runes by
    // value, so nothing in the pushed payload changes — the soft launch is an event, and
    // only the launch counter makes the shell re-push for it. Without that, a user who
    // swiped away from the revealed tile and searched the same app again saw nothing at
    // all: the same silent no-op, one pick later.
    setSpot(true);
    const { container } = render(Shell);
    await tick();
    const tile = () =>
      container.querySelector<HTMLElement>(
        `[data-testid="home-grid"] button[aria-label="${zh["app.webman"]}"]`,
      );
    const openSpotlight = async () => {
      setSpot(true);
      await tick();
      await fireEvent.input(container.querySelector("input") as HTMLInputElement, {
        target: { value: "webman" },
      });
      await tick();
      const row = container.querySelector<HTMLButtonElement>('[data-testid="spot-app-webman"]');
      expect(row).toBeTruthy();
      await fireEvent.click(row!);
      await tick();
    };

    await openSpotlight();
    expect(tile()).toBeTruthy();

    // The user pages home back themselves (page dots), the way a swipe does.
    const dots = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="home-dot"]')];
    expect(dots.length).toBeGreaterThan(1);
    await fireEvent.click(dots[0]);
    expect(tile()).toBeNull();

    await openSpotlight();
    expect(pulseId()).toBe("webman"); // the same id, re-stated
    expect(tile()?.innerHTML).toContain("animate-pulse");
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
import { setFormFactor as setFormFactorLib } from "../src/lib/formAuthority.svelte";

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
    setStoreTiles([]); // the tile cache is module-global — don't leak it to the next test
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

  test("a store app placed on the dock survives the next launch", async () => {
    bridgeWithInstalled();
    // A real boot reaches the tile cache *cold*: `loadStoreTiles` is async and only
    // `Shell` starts it, so the layout repair at init cannot yet see the installed app.
    setStoreTiles([]);
    // Last session's App Library "add to dock" wrote this.
    window.localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ page: ["clock"], dock: ["phone", "store:org.amos.demo"], hidden: [] }),
    );
    resetShellState(); // the boot seed, with the cache still cold
    const host = render(Shell);
    // The shell re-derives the layout once the tiles arrive, so the placement the user
    // already made is restored rather than filtered out as a ghost.
    await vi.waitFor(() => {
      expect(layout().dock).toContain("store:org.amos.demo");
    });
    // …and the dock actually draws it (a dock tile carries its name as the accessible
    // name — the bar itself is icon-only).
    expect(host.container.querySelector('[aria-label="Demo"]')).toBeTruthy();
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


describe("Shell.svelte — the tablet split entry (REQ-A512)", () => {
  // The control for the whole feature: a phone offers **no** split control at all (its
  // measured `columns` is 1 — a control that could never work is worse than none), and a
  // tablet's entry leads to a real split surface through `enterSplit`, whose gate is the
  // same `columns >= 2` that decided the button was drawn.
  const settle = () => new Promise((r) => setTimeout(r, 80));

  test("a tablet app surface offers the split entry; a phone's does not", async () => {
    installHost(() => snap({ form: "tablet", columns: 2, multi_window: false, free_resize: false }));
    await open("settings");
    const tablet = render(Shell);
    await tick();
    await settle();
    expect(tablet.container.querySelector('[data-testid="split-enter"]')).toBeTruthy();
    tablet.unmount();

    installHost(() =>
      snap({ form: "phone", columns: 1, screen_w: 420, screen_h: 820, multi_window: false, free_resize: false }),
    );
    await open("settings");
    const phone = render(Shell);
    await tick();
    await settle();
    expect(phone.container.querySelector('[data-testid="split-enter"]')).toBeNull();
  });

  test("picking a second app from the entry's sheet enters the split surface", async () => {
    installHost(() => snap({ form: "tablet", columns: 2, multi_window: false, free_resize: false }));
    await open("phone"); // a recent, so the picker has a candidate
    await open("settings"); // the primary pane
    const { container } = render(Shell);
    await tick();
    await settle();

    const entry = container.querySelector<HTMLButtonElement>('[data-testid="split-enter"]');
    expect(entry).toBeTruthy();
    await fireEvent.click(entry!);
    await tick();

    // The sheet says what it is for, and the primary app is not offered against itself.
    expect(container.textContent ?? "").toContain(zh["split.pickSecond"]);
    const candidate = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === zh["app.phone"],
    );
    expect(candidate, "the picker must offer the other recent app").toBeTruthy();
    await fireEvent.click(candidate!);
    await tick();

    const state = surface();
    expect(state.kind).toBe("split");
    if (state.kind === "split") {
      expect(state.primary).toBe("settings");
      expect(state.secondary).toBe("phone");
    }
    // The single-app surface is gone; the split surface (with its own status bar) is up.
    // No pane is painted here because this host answers no geometry — that is the
    // honest-failure rule, covered in `split-surface.svelte.test.ts`.
    expect(container.querySelector('[data-testid="app-surface"]')).toBeNull();
  });

  test("a split closed on an installed store app comes back on the next launch", async () => {
    // The tablet's real boot race: the layout snapshot (`restoreSplit`'s caller) and the
    // async store-tile load are two independent host round-trips. Here the tile load is
    // deliberately slower, so the restore genuinely runs with a **cold** cache — the case
    // where a store pane read as a ghost and the whole split was dropped.
    installHost(() => snap({ form: "tablet", columns: 2, multi_window: false, free_resize: false }));
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const plain = internals.invoke.bind(internals);
    internals.invoke = async (cmd, args) => {
      if (cmd === "appstore_installed") {
        await new Promise((r) => setTimeout(r, 40)); // resolve *after* the snapshot
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
      // Two panes for a 1024×720 tablet split, so the surface actually paints them.
      if (cmd === "wm_pane_rects")
        return [
          { label: "primary", x: 0, y: 0, width: 508, height: 720 },
          { label: "secondary", x: 516, y: 0, width: 508, height: 720 },
        ];
      return plain(cmd, args);
    };

    setStoreTiles([]); // cold: only loadStoreTiles() populates the cache
    resetShellState(); // the boot surface, before the host has answered anything
    // Last session's split, closed with an installed store app in the second pane.
    // Written *after* the reset: `resetShellState` drops the intent on purpose (a reset
    // must not leave a stored split a later boot would restore into a disowned state).
    writeStoreValue(SPLIT_KEY, {
      primary: "notes",
      secondary: "store:org.amos.demo",
      axis: "vertical",
      percent: 50,
    });

    // happy-dom reports every element as 0×0: give the pane host a real size and make the
    // observer fire once on observe, exactly as a real one does on first measurement.
    // Each override is *restored*, never deleted: happy-dom defines all three on the
    // shared prototypes, so removing them would strip the capability from every later
    // test in this file (measured: the following case died with `ResizeObserver is not
    // defined` once this test's `finally` had run).
    const saved = {
      w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
      h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
      ro: (globalThis as unknown as Record<string, unknown>).ResizeObserver,
    };
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1024 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 720 });
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      constructor(private cb: () => void) {}
      observe(): void {
        this.cb();
      }
      disconnect(): void {}
      unobserve(): void {}
    };
    try {
      const host = render(Shell);
      await vi.waitFor(() => {
        expect(surface().kind).toBe("split");
      });
      // …and the store app really is painted in the second pane — its own accessible
      // name, through the same `AppPane` → `ExtAppHost` route any app uses.
      await vi.waitFor(() => {
        expect(host.container.querySelector('[data-pane-app="store:org.amos.demo"]')).toBeTruthy();
      });
      expect(host.container.textContent ?? "").toContain("Demo");
    } finally {
      if (saved.w) Object.defineProperty(HTMLElement.prototype, "clientWidth", saved.w);
      if (saved.h) Object.defineProperty(HTMLElement.prototype, "clientHeight", saved.h);
      (globalThis as unknown as Record<string, unknown>).ResizeObserver = saved.ro;
      setStoreTiles([]);
    }
  });

  test("an installed store app can be picked as the second pane (and as a Slide Over panel) (REQ-A1137)", async () => {
    // The picker drew its candidates from `amos.recents`, which `open()` fills for
    // built-ins only — so an installed store app was never *offered*, even though the
    // door behind the picker (`enterSplit` / `openSlideOver`), the persisted-split
    // validation and `AppPane`'s ext host all accept a `store:` pane. The chooser must
    // therefore offer the shell's installed-tile list as well.
    installHost(() => snap({ form: "tablet", columns: 2, multi_window: false, free_resize: false }));
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const plain = internals.invoke.bind(internals);
    internals.invoke = async (cmd, args) => {
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
      return plain(cmd, args);
    };
    setStoreTiles([]); // cold: only the shell's own load populates the list
    await open("settings"); // the primary pane (a built-in, so the picker excludes it)

    try {
      const { container } = render(Shell);
      await tick();
      const entry = await vi.waitFor(() => {
        const e = container.querySelector<HTMLButtonElement>('[data-testid="split-enter"]');
        expect(e).toBeTruthy();
        return e!;
      });
      await fireEvent.click(entry);
      await tick();

      // The sheet offers the installed store app beside the recents, under its own
      // manifest name — proof the shell pushed the tile list, not just recents.
      const demo = await vi.waitFor(() => {
        const b = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (x) => x.getAttribute("aria-label") === "Demo",
        );
        expect(b, "the picker must offer the installed store app").toBeTruthy();
        return b!;
      });
      await fireEvent.click(demo);
      await tick();

      const state = surface();
      expect(state.kind).toBe("split");
      if (state.kind === "split") {
        expect(state.primary).toBe("settings");
        expect(state.secondary).toBe("store:org.amos.demo");
      }
      // …and the same pick is accepted as the floating Slide Over panel.
      exitSplit();
      await open("settings");
      await tick();
      expect(openSlideOver("store:org.amos.demo")).toBe(true);
      expect(slideOver()).toEqual({ id: "store:org.amos.demo", axis: "auto", percent: SLIDE_PERCENT_DEFAULT, hidden: false });
    } finally {
      setStoreTiles([]);
      hideSlideOver();
    }
  });

  test("back leaves a split one level at a time: split → primary app → home", async () => {
    installHost(() => snap({ form: "tablet", columns: 2, multi_window: false, free_resize: false }));
    await open("settings");
    render(Shell);
    await tick();
    await settle();
    enterSplit("settings", "phone", "auto");
    await tick();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    // The pure decision (`backNav`) maps the split surface to `exit-split`, i.e. collapse
    // to the primary app — not straight home (that would lose the app the user was in).
    expect(surface()).toEqual({ kind: "app", id: "settings" });
  });
});
