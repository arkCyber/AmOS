/**
 * calculator-app.svelte.test.ts — the calculator screen's disclosure control (REQ-A968).
 *
 * The reduction logic is unit-tested once against the pure reducer
 * (`svelte-tests/calculator.test.ts` / `lib/calculator.ts`); this file pins the one
 * thing the screen owns and the pure tests cannot see: the 历史 button's state.
 *
 * That button's accessible name is the visible text 「历史 (N)」, which is byte-identical
 * whether the panel is open or closed — the only other signal was the background class
 * (`bg-[#ff9f0a]` vs `bg-white/10`), which no assistive technology can read. So a
 * screen-reader user could not tell the panel's state, and a press meant to *open* it
 * would close it. `aria-expanded` is the repo idiom for a disclosure
 * (`Dock.svelte:777 aria-expanded={overflowMenu !== null}`).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import CalculatorApp from "../src/svelte/CalculatorApp.svelte";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);

const historyBtn = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(zh["calc.history"]),
  ) as HTMLButtonElement | undefined;

describe("CalculatorApp.svelte", () => {
  test("history disclosure announces its expanded state", async () => {
    const host = render(CalculatorApp);
    expect(historyBtn(host)).toBeTruthy();
    expect(historyBtn(host)!.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(historyBtn(host)!);
    expect(historyBtn(host)!.getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(historyBtn(host)!);
    expect(historyBtn(host)!.getAttribute("aria-expanded")).toBe("false");
  });
});
