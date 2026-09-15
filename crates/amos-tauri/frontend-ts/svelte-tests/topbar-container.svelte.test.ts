/**
 * DOM tests for the top bar **as a container** (REQ-A261).
 *
 * The bar no longer knows its widgets: it renders whatever the registry says, in
 * the registry's order. So these tests check the two halves of that contract —
 * that the slot is filled from the table (and only from the table), and that the
 * widgets' intents still reach the shell as the same events `DesktopShell` has
 * always bound (`on:launchpad` / `on:spotlight`).
 *
 * Deliberately *not* re-testing each widget's internals: those live next to the
 * widget (`chrome-widgets.svelte.test.ts`), which is the point of the split — a
 * widget's own rendering must not need the whole bar mounted.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import TopBar from "../src/svelte/TopBar.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { modulesFor } from "../src/lib/shellModule";
import { SHELL_MODULES } from "../src/svelte/shellModules";

afterEach(cleanup);
afterEach(() => setLocale("zh"));

/** Mount the bar; the shell hands it the two intents it cares about. */
function mount(handlers: { onlaunchpad?: () => void; onspotlight?: () => void } = {}) {
  return render(TopBar, { props: handlers });
}

describe("TopBar as a chrome container", () => {
  test("renders one node per registered module, in registry order", async () => {
    const host = mount();
    await tick();

    const slot = host.container.querySelector('[data-testid="topbar-right-slot"]');
    expect(slot, "the right-hand slot must exist").toBeTruthy();
    const ids = [...slot!.children].map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(modulesFor("topbar-right", SHELL_MODULES).map((m) => m.testId));
  });

  test("the container's own markup carries no widget glyphs — the widgets do", async () => {
    const host = mount();
    await tick();
    const bar = host.container.querySelector('[aria-label="顶部菜单栏"]')!;
    // The bar's *own* children: the left group (Apple menu, app name, main menu).
    // Its right-hand sibling is the slot, whose contents come from the registry —
    // checking the bar's whole `innerHTML` would include them and prove nothing.
    const left = bar.firstElementChild as HTMLElement;
    expect(left.textContent).toContain("Amos");
    for (const glyph of ["🚀", "🔍", "⚙️"]) {
      expect(left.innerHTML, `the container itself must not carry ${glyph}`).not.toContain(glyph);
    }
    // …and the slot *does* carry them, because the widgets do.
    const slot = bar.lastElementChild as HTMLElement;
    expect(slot.innerHTML).toContain("🚀");
  });

  test("the launchpad widget asks the shell through the chrome handle", async () => {
    const onlaunchpad = vi.fn();
    const host = mount({ onlaunchpad });
    await tick();

    await fireEvent.click(host.container.querySelector('[data-testid="chrome-launchpad"]')!);
    expect(onlaunchpad).toHaveBeenCalledTimes(1);
  });

  test("the spotlight widget asks the shell through the chrome handle", async () => {
    const onspotlight = vi.fn();
    const host = mount({ onspotlight });
    await tick();

    await fireEvent.click(host.container.querySelector('[data-testid="chrome-spotlight"]')!);
    expect(onspotlight).toHaveBeenCalledTimes(1);
  });

  test("the control-centre widget is honestly disabled, not an inert button", async () => {
    const host = mount();
    await tick();
    const button = host.container.querySelector<HTMLButtonElement>(
      '[data-testid="chrome-control-center"]',
    )!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // …and it still has a name that says so (never a nameless disabled control).
    expect(button.getAttribute("aria-label")).toContain("控制中心");
  });

  test("the clock and the battery are rendered by their own widgets", async () => {
    const host = mount();
    await tick();
    expect(host.container.querySelector('[data-testid="chrome-clock"]')?.textContent).toMatch(
      /\d/,
    );
    expect(host.container.querySelector('[data-testid="chrome-battery"]')?.textContent).toContain(
      "—",
    );
  });
});
