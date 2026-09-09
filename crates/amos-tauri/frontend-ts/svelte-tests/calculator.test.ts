/**
 * DOM tests for the Svelte 5 calculator (CalculatorApp.svelte).
 *
 * These mirror the coverage that calculator-dom.test.tsx gives the React
 * calculator, but exercised against the real Svelte component under vitest
 * (see vitest.config.ts). Pure reduction behaviour is already unit-tested once
 * in src/__tests__/calculator.test.ts against lib/calculator.ts — the single
 * reducer shared by BOTH the React and the Svelte UIs.
 */
import { afterEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import CalculatorApp from "../src/svelte/CalculatorApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { readStoreValue } from "../src/lib/amosStore";

afterEach(() => {
  setLocale("zh");
});

function renderCalc() {
  return render(CalculatorApp);
}
const status = (host: ReturnType<typeof renderCalc>) =>
  host.container.querySelector('[role="status"]')?.textContent ?? "";

async function tap(host: ReturnType<typeof renderCalc>, aria: string) {
  const btn = host.container.querySelector(
    `button[aria-label="${aria}"]`,
  ) as HTMLButtonElement | null;
  expect(btn, `missing key "${aria}"`).toBeTruthy();
  await fireEvent.click(btn!);
}

describe("CalculatorApp.svelte — keypad (DOM)", () => {
  test("starts at 0", async () => {
    const host = renderCalc();
    expect(status(host)).toBe("0");
  });

  test("9 + 3 = shows 12", async () => {
    const host = renderCalc();
    await tap(host, "9");
    await tap(host, "+");
    await tap(host, "3");
    await tap(host, "=");
    expect(status(host)).toBe("12");
  });

  test("pressing an operator shows it (not 0); typing the operand then = gives the result", async () => {
    const host = renderCalc();
    await tap(host, "2");
    await tap(host, "+");
    expect(status(host)).toBe("+"); // operator, not a staged "0"
    await tap(host, "3");
    expect(status(host)).toBe("3");
    await tap(host, "=");
    expect(status(host)).toBe("5");
  });

  test("% inside a pending + is a percentage of the left operand (50 + 10 % = 55)", async () => {
    const host = renderCalc();
    await tap(host, "5");
    await tap(host, "0");
    await tap(host, "+");
    await tap(host, "1");
    await tap(host, "0");
    await tap(host, "%");
    await tap(host, "=");
    expect(status(host)).toBe("55");
  });

  test("AC clears an entry back to 0", async () => {
    const host = renderCalc();
    await tap(host, "9");
    expect(status(host)).toBe("9");
    const clear = host.container.querySelector(
      'button[aria-label="AC"], button[aria-label="C"]',
    );
    expect(clear).toBeTruthy();
    await fireEvent.click(clear as HTMLButtonElement);
    expect(status(host)).toBe("0");
  });
});

describe("CalculatorApp.svelte — physical keyboard", () => {
  test("typing 9 + 3 Enter shows 12 via the window listener", async () => {
    const host = renderCalc();
    for (const key of ["9", "+", "3", "Enter"]) {
      await fireEvent.keyDown(window, { key });
    }
    expect(status(host)).toBe("12");
  });

  test("an empty Enter is swallowed (no spurious second operation)", async () => {
    const host = renderCalc();
    await fireEvent.keyDown(window, { key: "5" });
    await fireEvent.keyDown(window, { key: "Enter" });
    expect(status(host)).toBe("5");
  });
});

describe("CalculatorApp.svelte — persisted history via createStoreValue", () => {
  test("a completed '=' is persisted to the shared store and shown in the panel", async () => {
    const host = renderCalc();
    await tap(host, "9");
    await tap(host, "+");
    await tap(host, "3");
    await tap(host, "=");
    expect(status(host)).toBe("12");

    // Real consumer check: history was written through the shared amos.* store.
    const stored = readStoreValue<unknown>("amos.calculator.history", []);
    expect(Array.isArray(stored)).toBe(true);
    expect((stored as unknown[]).length).toBe(1);
    expect((stored as { expr: string; result: string }[])[0]!.expr).toBe("9 + 3");
    expect((stored as { expr: string; result: string }[])[0]!.result).toBe("12");

    // And it appears in the history panel.
    const histBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("历史"),
    );
    expect(histBtn).toBeTruthy();
    await fireEvent.click(histBtn as HTMLButtonElement);
    expect(host.container.textContent ?? "").toContain("9 + 3");
  });
});

describe("CalculatorApp.svelte — reactive i18n (in place, no remount)", () => {
  test("history button relabels when the shell locale changes", async () => {
    const host = renderCalc();
    expect(host.container.textContent ?? "").toContain("历史");
    setLocale("en");
    await tick();
    expect(host.container.textContent ?? "").toContain("History");
  });
});

describe("CalculatorApp.svelte — sign toggle + clear-key label (folded from the retired React dom tests)", () => {
  const statusText = (host: ReturnType<typeof renderCalc>) =>
    host.container.querySelector('[role="status"]')?.textContent ?? "";
  const clearBtn = (host: ReturnType<typeof renderCalc>) =>
    host.container.querySelector(
      'button[aria-label="AC"], button[aria-label="C"]',
    ) as HTMLButtonElement | null;

  test("± toggles the sign of the shown entry and 0 is a no-op", async () => {
    const host = renderCalc();
    await tap(host, "5");
    expect(statusText(host)).toBe("5");
    await tap(host, "±");
    expect(statusText(host)).toBe("-5");
    await tap(host, "±");
    expect(statusText(host)).toBe("5");
    // a fresh 0 followed by ± must not produce "-0"
    await tap(host, "C");
    expect(statusText(host)).toBe("0");
    await tap(host, "±");
    expect(statusText(host)).toBe("0");
  });

  test("clear key reads AC fresh, flips to C while typing, and resets", async () => {
    const host = renderCalc();
    expect(clearBtn(host)?.getAttribute("aria-label")).toBe("AC");
    await tap(host, "7");
    expect(clearBtn(host)?.getAttribute("aria-label")).toBe("C");
    await fireEvent.click(clearBtn(host) as HTMLButtonElement);
    expect(statusText(host)).toBe("0");
    expect(clearBtn(host)?.getAttribute("aria-label")).toBe("AC");
  });
});

