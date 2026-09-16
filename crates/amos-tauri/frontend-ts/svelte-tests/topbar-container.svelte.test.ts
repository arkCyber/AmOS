/**
 * DOM tests for the top bar **as a container** (REQ-A261, extended by REQ-A262).
 *
 * The bar no longer knows its widgets: **both** slots render whatever the registry says,
 * in the registry's order — including the left group, which round 1 left inlined in the
 * template (Apple menu, app name, the five menu titles, and the store subscription
 * behind the app name).
 *
 * Deliberately *not* re-tested here:
 *   • each widget's own rendering — that lives next to the widget
 *     (`chrome-widgets.svelte.test.ts`), which is the point of the split;
 *   • the intent path (click a trigger → chrome handle → shell). The handle belongs to
 *     the **shell** now (`DesktopShell` provides it once for every slot), so a bar
 *     mounted on its own has none and its widgets deliberately do nothing rather than
 *     throw. That path is asserted end-to-end in `desktop-shell.svelte.test.ts`, where a
 *     real shell is present — including the cross-check that the same registry row both
 *     labels a trigger's tooltip and binds the key.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import TopBar from "../src/svelte/TopBar.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { modulesFor } from "../src/lib/shellModule";
import { SHELL_MODULES } from "../src/svelte/shellModules";
import { APP_FOCUSED_KEY } from "../src/lib/wm";
import { writeStoreValue } from "../src/lib/amosStore";
import { AMOS_OS_NAME } from "../src/lib/version";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);
afterEach(() => setLocale("zh"));
beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

const testIds = (slot: "topbar-left" | "topbar-right") =>
  modulesFor(slot, SHELL_MODULES).map((m) => m.testId);

describe("TopBar as a chrome container", () => {
  test("renders one node per registered module, in registry order, in each slot", async () => {
    const host = render(TopBar);
    await tick();

    for (const slot of ["topbar-left", "topbar-right"] as const) {
      const el = host.container.querySelector(`[data-testid="${slot}-slot"]`);
      expect(el, `the ${slot} slot must exist`).toBeTruthy();
      const ids = [...el!.children].map((c) => c.getAttribute("data-testid"));
      expect(ids).toEqual(testIds(slot));
    }
  });

  test("the container's own markup is only the two slots (no glyphs, no labels)", async () => {
    const host = render(TopBar);
    await tick();
    const bar = host.container.querySelector(`[aria-label="${zh["desktop.topbar"]}"]`)!;
    // The container's own children are the two slot divs and nothing else: a bar that
    // renders a widget itself is the defect this split removed.
    expect(bar.children.length).toBe(2);
    expect([...bar.children].map((c) => c.getAttribute("data-testid"))).toEqual([
      "topbar-left-slot",
      "topbar-right-slot",
    ]);
    // …and none of the bar's *own* markup is a control or a glyph: everything visible in
    // the bar arrives from inside a slot (the widgets the registry names).
    expect(bar.querySelectorAll(":scope > button, :scope > span, :scope > nav, :scope > a").length).toBe(0);
  });

  test("the left group is three widgets in the order macOS shows them", async () => {
    const host = render(TopBar);
    await tick();
    const left = host.container.querySelector('[data-testid="topbar-left-slot"]')!;
    expect([...left.children].map((c) => c.getAttribute("data-testid"))).toEqual([
      "menu-apple",
      "menu-app-name",
      "menu-main",
    ]);
  });

  test("the app name is the product name until the host reports a focused app", async () => {
    const host = render(TopBar);
    await tick();
    const name = () => host.container.querySelector('[data-testid="menu-app-name"]')!.textContent;
    expect(name()).toBe(AMOS_OS_NAME);

    writeStoreValue(APP_FOCUSED_KEY, "files");
    await tick();
    expect(name()).toBe("Files");
  });

  test("the five app menus are enabled triggers that open a real dropdown (REQ-A275)", async () => {
    // REQ-A275 turned the bar from "5 inert buttons" into "5 enabled triggers that
    // open dropdowns". Each dropdown contains a mix of live rows (wired to the host)
    // and F-SH-001 honest rows (visible, disabled, named with the reason). The
    // invariant we pin here: **all 5 triggers open a panel** and **at least one row
    // per panel is disabled + named** (so the F-SH-001 discipline is still in force).
    const host = render(TopBar);
    await tick();
    const nav = host.container.querySelector('[data-testid="menu-main"]')!;
    const triggers = [...nav.querySelectorAll("button")];
    expect(triggers.map((b) => b.textContent?.trim())).toEqual([
      zh["desktop.menu.file"],
      zh["desktop.menu.edit"],
      zh["desktop.menu.view"],
      zh["desktop.menu.window"],
      zh["desktop.menu.help"],
    ]);
    for (const t of triggers) {
      expect((t as HTMLButtonElement).disabled).toBe(false);
      expect(t.getAttribute("aria-haspopup")).toBe("menu");
    }
    const groups = ["file", "edit", "view", "window", "help"] as const;
    for (const id of groups) {
      const trigger = host.container.querySelector<HTMLElement>(
        `[data-testid="menu-${id}-trigger"]`,
      )!;
      await fireEvent.click(trigger);
      await tick();
      const panel = host.container.querySelector(`[data-testid="menu-${id}-panel"]`);
      expect(panel, `the ${id} menu must open`).toBeTruthy();
      const rows = [...panel!.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
      expect(rows.length).toBeGreaterThan(0);
      const disabledRows = rows.filter((r) => r.disabled);
      expect(disabledRows.length, `${id} must have at least one F-SH-001 honest row`)
        .toBeGreaterThan(0);
      const first = disabledRows[0]!;
      expect(first.getAttribute("aria-disabled")).toBe("true");
      expect(first.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      await fireEvent.click(trigger);
      await tick();
    }
  });
});
