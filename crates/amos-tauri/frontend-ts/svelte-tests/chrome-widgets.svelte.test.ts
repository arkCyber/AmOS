/**
 * DOM tests for the chrome **widgets** — the other half of the container split.
 *
 * Each widget is mounted on its own (no bar, no shell): that is the property the
 * modularisation buys, so these tests are also the proof of it. They pin the parts
 * of the *look* that are a contract rather than taste:
 *
 *  • every interactive widget has an accessible name AND a tooltip, and carries the
 *    shared hit target + focus ring (`lib/shellChrome.ts`) — three widgets that each
 *    roll their own button is exactly what this round removed;
 *  • the control centre says it is not wired yet instead of being an inert button;
 *  • the radios/battery render what the pure libs decided (dim glyph when off, `—`
 *    when no sample exists) and never invent a value.
 *
 * REQ-A262 added the widgets that were still inline in `TopBar`/`DesktopStage` — the
 * Apple menu (a real dropdown now), the app name, the five app-menu titles (greyed with
 * a reason: FMEA F-SH-001) and the stage clock — so their contracts are asserted here
 * too. A widget mounted alone has **no chrome handle** (the shell provides it), which is
 * also why nothing here asserts an intent; those paths belong to `desktop-shell…`.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import BatteryWidget from "../src/svelte/modules/BatteryWidget.svelte";
import ClockWidget from "../src/svelte/modules/ClockWidget.svelte";
import ControlCenterButton from "../src/svelte/modules/ControlCenterButton.svelte";
import LaunchpadTrigger from "../src/svelte/modules/LaunchpadTrigger.svelte";
import RadiosWidget from "../src/svelte/modules/RadiosWidget.svelte";
import SpotlightTrigger from "../src/svelte/modules/SpotlightTrigger.svelte";
import StageClock from "../src/svelte/modules/StageClock.svelte";
import TopbarAppleMenu from "../src/svelte/modules/TopbarAppleMenu.svelte";
import TopbarAppName from "../src/svelte/modules/TopbarAppName.svelte";
import TopbarMainMenu from "../src/svelte/modules/TopbarMainMenu.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { CHROME_ICON_BUTTON } from "../src/lib/shellChrome";
import { SETTINGS_KEY } from "../src/lib/settings";
import { WIFI_KEY } from "../src/lib/wifi";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);
afterEach(() => setLocale("zh"));
// The radios widget reads persisted stores now (REQ-A1123), so a seeded key must not
// leak into the next case — the "dimmed when off" case depends on an empty store.
afterEach(() => window.localStorage.clear());
// A bridged test must not leak its bridge into the next test (the "—" case relies on
// being unbridged), so the fake is torn down after every case.
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

/** Install a Tauri bridge whose `system_health` returns the given payload.
 *  `extra` answers further commands by name — unlisted commands answer `null`, which is
 *  what a host that does not have the command does. */
function installBridge(systemHealth: unknown, extra: Record<string, unknown> = {}) {
  const invoke = async (cmd: string) => {
    if (cmd === "system_health") return systemHealth;
    if (cmd in extra) return extra[cmd];
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

/** Let the async battery poll settle. */
const settle = () => new Promise((r) => setTimeout(r, 40));

/** The classes the shared chrome button must carry (hit target + focus ring). */
const REQUIRED_CLASSES = [
  "h-6",
  "min-w-6",
  "hover:bg-white/10",
  "focus-visible:ring-2",
  "rounded-md",
];

describe("chrome widgets (mounted alone)", () => {
  test("the shared chrome button is the one implementation the widgets use", () => {
    for (const cls of REQUIRED_CLASSES) {
      expect(CHROME_ICON_BUTTON, `the token must carry ${cls}`).toContain(cls);
    }
  });

  test("the launchpad trigger has a name, a tooltip and the shared look", async () => {
    const { container } = render(LaunchpadTrigger);
    await tick();
    const b = container.querySelector<HTMLButtonElement>('[data-testid="chrome-launchpad"]')!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.getAttribute("aria-label")).toBe("启动台");
    expect(b.getAttribute("title")).toBe("启动台");
    expect(b.textContent).toContain("🚀");
    for (const cls of REQUIRED_CLASSES) expect(b.className).toContain(cls);
    // The bar's text shadow is part of the look (white glyph over glass).
    expect(b.getAttribute("style")).toContain("text-shadow");
  });

  test("the spotlight trigger is the same shape as the launchpad one", async () => {
    const { container } = render(SpotlightTrigger);
    await tick();
    const b = container.querySelector<HTMLButtonElement>('[data-testid="chrome-spotlight"]')!;
    expect(b.getAttribute("aria-label")).toBe("Spotlight 搜索");
    expect(b.className).toBe(container.querySelector("button")!.className);
    for (const cls of REQUIRED_CLASSES) expect(b.className).toContain(cls);
  });

  test("the control centre item is a real disclosure control now (no inert button)", async () => {
    const { container } = render(ControlCenterButton);
    await tick();
    const b = container.querySelector<HTMLButtonElement>('[data-testid="chrome-control-center"]')!;
    // REQ-A262 shipped this as a *disabled* control whose name said the panel did not exist.
    // REQ-A263 landed the panel, so the same widget is a live toggle again — and the whole
    // change is this file plus its registry row, which is what the module boundary promised.
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-disabled")).toBeNull();
    expect(b.getAttribute("aria-label")).toBe("控制中心");
    expect(b.getAttribute("title")).toBe("控制中心");
    // Mounted outside a shell there is no handle: the state it reports is "closed", not a
    // guess, and clicking does nothing rather than throwing.
    expect(b.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("false");
  });

  test("the clock renders a formatted time and reserves its width", async () => {
    const { container } = render(ClockWidget);
    await tick();
    const span = container.querySelector<HTMLElement>('[data-testid="chrome-clock"]')!;
    expect(span.textContent).toMatch(/^\d{1,2}:\d{2}/);
    expect(span.className).toContain("tabular-nums");
    expect(span.getAttribute("style")).toContain("min-width");
  });

  test("the radios render the glyphs the pure lib decided, dimmed when off", async () => {
    const { container } = render(RadiosWidget);
    await tick();
    const root = container.querySelector<HTMLElement>('[data-testid="chrome-radios"]')!;
    // No quick settings ⇒ every radio is off ⇒ dimmed, never lit.
    const glyphs = [...root.querySelectorAll("span")];
    expect(glyphs.length).toBeGreaterThan(0);
    for (const g of glyphs) expect(g.className).toContain("text-white/30");
  });

  test("the Wi-Fi glyph names the joined network — it reads amos.wifi, not the quick bit (REQ-A1123)", async () => {
    // The SSID lives in `amos.wifi` (`WifiCfg.current`), and `normalizeQuick` keeps only
    // booleans — so the old `typeof quick.wifi === "string" ? quick.wifi : null` was
    // always null and this bar could never name the network the phone's bar names.
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ wifi: true, airplane: false }));
    window.localStorage.setItem(
      WIFI_KEY,
      JSON.stringify({ current: "Cafe_Free", saved: ["Cafe_Free"], passwords: {} }),
    );
    const { container } = render(RadiosWidget);
    await tick();
    const root = container.querySelector<HTMLElement>('[data-testid="chrome-radios"]')!;
    const want = zh["a11y.wifiWithSsid"].replace("{ssid}", "Cafe_Free");
    expect([...root.querySelectorAll("span")].some((s) => s.getAttribute("title") === want)).toBe(true);
  });

  test("the battery shows — while no sample exists (never an invented level)", async () => {
    const { container } = render(BatteryWidget);
    await tick();
    const root = container.querySelector<HTMLElement>('[data-testid="chrome-battery"]')!;
    expect(root.textContent).toContain("—");
    expect(root.getAttribute("aria-label")).toBe("电量");
    // No tooltip with a percentage: there is no reading to report.
    expect(root.getAttribute("title")).toBeNull();
  });

  test("the battery shows the REAL daemon level when one is bridged", async () => {
    // REQ-A517: the desktop top bar used to hardcode an unknown sample and show "—"
    // forever. It now resolves the reading through the same live subscription as the
    // phone StatusBar — so with `system_health` reporting a level it must show it.
    installBridge({ battery_level_pct: 80, battery_charging: false });
    const { container } = render(BatteryWidget);
    await settle();
    const root = container.querySelector<HTMLElement>('[data-testid="chrome-battery"]')!;
    expect(root.textContent).toContain("80%");
    expect(root.getAttribute("title")).toBe(zh["a11y.battery"].replace("{pct}", "80%"));
    // The reading is the NAME too: `aria-label` overrides the content *and* the
    // `title`, so the old constant label left the level unreadable to AT (REQ-A1016).
    expect(root.getAttribute("aria-label")).toBe(zh["a11y.battery"].replace("{pct}", "80%"));
  });

  test("the Apple menu opens a real menu, and every row in it is live", async () => {
    const { container } = render(TopbarAppleMenu);
    await tick();
    // Closed by default: a menu panel that is always mounted is how a bar grows a
    // permanent overlay.
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="apple-menu-trigger"]')!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(trigger);
    await tick();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const rows = [...container.querySelectorAll('[data-testid="apple-menu-panel"] [role="menuitem"]')];
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "apple-menu-about",
      "apple-menu-settings",
      "apple-menu-lock",
      "apple-menu-restart",
      "apple-menu-shutdown",
      "apple-menu-sleep",
    ]);
    // Every row is live as of REQ-A796: the three power rows run a host command
    // (REQ-A515), 关于本机 asks the host for the platform About panel, and the other two
    // are shell-local. No row is greyed here — which is the point, because a greyed row
    // must name a reason and the one it named ("尚未接入独立面板") was false.
    const live = rows.filter((r) => !(r as HTMLButtonElement).disabled).map((r) => r.getAttribute("data-testid"));
    expect(live).toEqual([
      "apple-menu-about",
      "apple-menu-settings",
      "apple-menu-lock",
      "apple-menu-restart",
      "apple-menu-shutdown",
      "apple-menu-sleep",
    ]);
    for (const r of rows) {
      expect((r as HTMLButtonElement).disabled, `${r.getAttribute("data-testid")} must be live`).toBe(false);
      // A live row carries no `aria-disabled` at all — the attribute is only for the
      // greyed-and-named shape, which this menu no longer has.
      expect(r.getAttribute("aria-disabled")).toBeNull();
      expect(r.getAttribute("aria-label")).toBeTruthy();
    }

    // Escape dismisses it (macOS), and so does a click outside the widget.
    await fireEvent.keyDown(window, { key: "Escape" });
    await tick();
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();
  });

  /**
   * REQ-A796 — 关于本机 asks the host, and **reports** what came back.
   *
   * The row was greyed before this round with the reason "no standalone panel". That reason
   * was false: the host already opens the standard panel for the native `menu.about` item, so
   * what was missing was only a command. Three outcomes are pinned here — the panel came up,
   * the host has no panel, the host was not reachable — because the defect being guarded
   * against is a row that *looks* like it worked. Asserting only "a command was invoked" would
   * pass a version that called the host and then said nothing whatever the answer.
   */
  test("关于本机 asks the host for the platform About panel", async () => {
    installBridge(undefined, { shell_about_panel: "shown" });
    const { container } = render(TopbarAppleMenu);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-trigger"]')!);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-about"]')!);
    await tick();
    await settle();
    // The panel came up, so the menu is dismissed — the row did what it says.
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="apple-about-notice"]')).toBeNull();
  });

  test("a host with no About panel SAYS so, in the menu, instead of looking like it worked", async () => {
    // The negative control for the test above: same click, same command, a host that answers
    // `unsupported_host`. The row must not close quietly — that is exactly the F-SH-001 shape.
    installBridge(undefined, { shell_about_panel: "unsupported_host" });
    const { container } = render(TopbarAppleMenu);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-trigger"]')!);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-about"]')!);
    await tick();
    await settle();
    const notice = container.querySelector('[data-testid="apple-about-notice"]')!;
    expect(notice, "a refusal must be reported, not swallowed").toBeTruthy();
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(zh["desktop.apple.aboutUnsupported"]);
    // The menu stays open, so the row is still there to retry and the user can read the reason
    // next to the row that produced it.
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).not.toBeNull();
    // …and dismissing the menu clears the notice, so it cannot be waiting behind the next open.
    await fireEvent.keyDown(window, { key: "Escape" });
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-trigger"]')!);
    await tick();
    expect(container.querySelector('[data-testid="apple-about-notice"]')).toBeNull();
  });

  test("an unreachable host is reported as unreachable, not as a missing panel", async () => {
    // Mounted with no bridge at all. `invoke` answers `null`, and `null` is not a spelling the
    // host can send — collapsing it into "unsupported_host" would blame the platform for the
    // shell's own missing bridge (the F-SH-236 confusion this signal's enum exists to avoid).
    const { container } = render(TopbarAppleMenu);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-trigger"]')!);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-about"]')!);
    await tick();
    await settle();
    const notice = container.querySelector('[data-testid="apple-about-notice"]')!;
    expect(notice.textContent).toContain(zh["desktop.apple.aboutUnreachable"]);
  });

  /**
   * REQ-A515: selecting a power row must **not** act.
   *
   * Restart / shut down / sleep are irreversible and throw away unsaved work, so the row
   * opens an inline `alertdialog` and only 「继续」 reaches the host. Mounted alone there is
   * no bridge at all, so a leaked call would also show up as a `null`... which is why the
   * assertion is on the confirmation's presence, not on a command list: this test pins
   * "the row asks", and `desktop-shell…` pins "the confirmed call arrives".
   */
  test("a power row asks before it acts, and 取消 leaves without acting", async () => {
    const { container } = render(TopbarAppleMenu);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-trigger"]')!);
    await tick();
    expect(container.querySelector('[data-testid="apple-power-confirm"]')).toBeNull();

    for (const id of ["apple-menu-restart", "apple-menu-shutdown", "apple-menu-sleep"]) {
      await fireEvent.click(container.querySelector(`[data-testid="${id}"]`)!);
      await tick();
      const dialog = container.querySelector('[data-testid="apple-power-confirm"]')!;
      expect(dialog, `${id} must ask first`).toBeTruthy();
      expect(dialog.getAttribute("role")).toBe("alertdialog");
      // The dialog names the action the user picked, in the row's own words.
      const rowLabel = container
        .querySelector(`[data-testid="${id}"]`)!
        .getAttribute("aria-label")!;
      expect(dialog.textContent).toContain(rowLabel);
      // The menu stays open behind it.
      expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeTruthy();
      await fireEvent.click(container.querySelector('[data-testid="apple-power-cancel"]')!);
      await tick();
      expect(container.querySelector('[data-testid="apple-power-confirm"]')).toBeNull();
    }
  });

  test("dismissing the menu drops a pending confirmation (no half-armed power action)", async () => {
    const { container } = render(TopbarAppleMenu);
    await tick();
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="apple-menu-trigger"]')!;
    await fireEvent.click(trigger);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-shutdown"]')!);
    await tick();
    expect(container.querySelector('[data-testid="apple-power-confirm"]')).toBeTruthy();

    await fireEvent.keyDown(window, { key: "Escape" });
    await tick();
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();

    await fireEvent.click(trigger);
    await tick();
    expect(container.querySelector('[data-testid="apple-power-confirm"]')).toBeNull();
  });

  test("the app name is the product name until the host names a focused app", async () => {
    const { container } = render(TopbarAppName);
    await tick();
    const name = container.querySelector<HTMLElement>('[data-testid="menu-app-name"]')!;
    expect(name.textContent?.trim()).toBeTruthy();
  });

  test("the bar has 5 enabled menu triggers (REQ-A275)", async () => {
    const { container } = render(TopbarMainMenu);
    await tick();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.length).toBe(5);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
      expect(b.getAttribute("aria-haspopup")).toBe("menu");
    }
  });

  test("Help menu rows act (REQ-A482): every row is enabled and named", async () => {
    // Was the F-SH-001 "every row disabled" case — honest while Help had no implementation.
    // REQ-A482 gave both rows real work (Search → Spotlight, Amos Help → Settings), so the
    // honest state is now the opposite one: an **enabled** row that is named. A future edit
    // that greys one again (or leaves it unnamed) is what fails here.
    const { container } = render(TopbarMainMenu);
    await tick();
    const help = container.querySelector<HTMLElement>('[data-testid="menu-help-trigger"]')!;
    await fireEvent.click(help);
    await tick();
    const panel = container.querySelector('[data-testid="menu-help-panel"]');
    expect(panel).toBeTruthy();
    const rows = [...panel!.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.disabled).toBe(false);
      expect((r.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  test("the stage clock renders a formatted time over a formatted date", async () => {
    const { container } = render(StageClock);
    await tick();
    const root = container.querySelector<HTMLElement>('[data-testid="stage-clock"]')!;
    expect(root.textContent).toMatch(/\d{2}:\d{2}/);
    expect(root.textContent?.trim().length).toBeGreaterThan(5); // the date line is there too
  });
});
