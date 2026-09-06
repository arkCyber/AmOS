/**
 * DOM tests for the Svelte 5 clock screen (ClockApp.svelte).
 *
 * The pure stopwatch/timer/alarm reduction is unit-tested against lib/time.ts
 * (shared by the React + Svelte UIs). Here we verify the Svelte UI wiring:
 * default world-clock cities, tab switching, initial countdown/stopwatch, and
 * adding an alarm through the form. We do NOT assert on running timers (timing
 * is covered by the pure reducer tests); the 1 Hz interval is torn down on
 * unmount via $effect cleanup.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ClockApp from "../src/svelte/ClockApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(() => {
  cleanup();
  setLocale("zh");
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const tab = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll('button[role="tab"]')].find((b) =>
    (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;
const inputByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === aria) as
    HTMLInputElement | undefined;

describe("ClockApp.svelte", () => {
  test("world tab shows default cities incl. 北京", () => {
    const host = render(ClockApp);
    expect(txt(host)).toContain("北京");
    expect(txt(host)).toContain("伦敦");
  });

  test("stopwatch tab shows initial 00:00.00", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "秒表") as HTMLButtonElement);
    expect(txt(host)).toContain("00:00.00");
  });

  test("timer tab shows initial 00:00", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
    expect(txt(host)).toContain("00:00");
  });

  test("alarm tab starts empty and can add an alarm", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);
    expect(txt(host)).toContain("还没有闹钟");

    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "7" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "30" } });
    await fireEvent.input(inputByAria(host, "标签（可选）")!, { target: { value: "起床" } });
    const add = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "添加",
    );
    expect(add).toBeTruthy();
    await fireEvent.click(add as HTMLButtonElement);
    expect(txt(host)).toContain("07:30");
    expect(txt(host)).toContain("起床");
  });
});
