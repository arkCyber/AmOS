/**
 * HealthApp.svelte — a day the history never sampled is not a day of "0 steps".
 *
 * `recentDays` returns a fixed seven rows (the `{#each}` is keyed by `day`, so a variable
 * row count would break the strip), and for a day with no row it filled `steps` with a
 * structural `0`. The screen then drew a bar at that height and, worse, a tooltip reading
 * `"2026-09-18: 0"` — and the header summed all seven into 「共 0 步」. Both assert a
 * measurement nobody took: the app was not watching, so it has no reading, which is the
 * `null`-vs-`0` rule every other reading in this app follows (REQ-A1454).
 *
 * `RecentDay.recorded` now carries that difference — and it is a *measured* step that records a
 * day, not the mere existence of a row: a row minted by a heart-rate sample carries the seed
 * `steps: 0` that no one observed, so it reads like a day never seen (REQ-A1838 ∕ F-SH-909).
 *
 * The same rule applied one degree milder (REQ-A1635 / FMEA F-SH-830): the header summed all
 * seven rows and called the result the week's total, so a week of which only three days were
 * sampled read 「共 600 步」 — a figure of the *sampled* days presented as the *week's*. The
 * leaves' `weekSummary` helper reads that one cell, and the positive control (a fully-recorded
 * week) still gets the plain 「共 700 步」.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import HealthApp from "../src/svelte/HealthApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { dayKey, HEALTH_HISTORY_KEY, type HealthState } from "../src/lib/health";
import { addLocalDays } from "../src/lib/time";
import { zh } from "../src/i18n/locales/zh";

const NO_READING = zh["health.noReading"];
/** The weekly total as an empty history would have rendered it — a week of "0 steps". */
const ZERO_TOTAL = zh["health.weekTotal"].replace("{n}", "0");

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = () => new Promise((r) => setTimeout(r, 30));

/** The tooltips the bars carry — where a fabricated `0` used to be printed. */
const barTitles = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>("[title]")].map((el) => el.title);

/**
 * The week header's summary cell.
 *
 * The whole container's `textContent` is every panel on the screen, so a substring check on it
 * cannot tell "the header called 600 the week's total" from "the header named 600 as a partial
 * figure" — 「共 600 步」 is a substring of a partial sentence that contains the same phrase. The
 * question is what *that one cell* says, so read that one cell.
 */
const weekSummary = (container: HTMLElement): string => {
  const label = [...container.querySelectorAll("div")].find(
    (d) => d.textContent?.trim() === zh["health.week"],
  );
  return label?.parentElement?.lastElementChild?.textContent?.trim() ?? "";
};

describe("HealthApp.svelte — unobserved days claim no step count (REQ-A1454)", () => {
  test("an empty history says there is no reading, and prints no per-day 0", async () => {
    const h = render(HealthApp);
    await settle();

    expect(h.container.textContent).toContain(NO_READING);
    expect(h.container.textContent).not.toContain(ZERO_TOTAL);
    // No bar may claim a step count for a day that was never sampled.
    expect(barTitles(h.container).filter((tt) => /:\s*0$/.test(tt))).toEqual([]);
  });

  test("a row minted only by a heart rate claims no step count (REQ-A1838 ∕ F-SH-909)", async () => {
    const today = dayKey(Date.now());
    // The row exists — a heart-rate sample created it for the bpm pair — but no step was ever
    // observed, so its `steps` is the seed `0`, not a measurement.
    const state: HealthState = {
      days: [{ day: today, steps: 0, steps_recorded: false, hr_min: 70, hr_max: 90 }],
      workouts: [],
    };
    writeStoreValue(HEALTH_HISTORY_KEY, state);
    const h = render(HealthApp);
    await settle();

    // The strip must treat it like a day it never saw: a baseline mark, never a `today: 0`
    // bar/title asserting a count nobody took. (A zero *measurement* cannot arise here — the
    // reducer mints a row only for a positive delta — so a zero-steps row is always this case.)
    expect(barTitles(h.container)).not.toContain(`${today}: 0`);
    expect(barTitles(h.container)).toContain(`${today} · ${NO_READING}`);
  });

  test("a partly-recorded week is not passed off as the week's total", async () => {
    // Three of the last seven days were sampled (100 + 200 + 300 = 600); four never were.
    const now = Date.now();
    const days = [0, 1, 2].map((i) => ({
      day: dayKey(addLocalDays(now, -i)),
      steps: (i + 1) * 100,
      steps_recorded: true,
      hr_min: null,
      hr_max: null,
    }));
    writeStoreValue(HEALTH_HISTORY_KEY, { days, workouts: [] } satisfies HealthState);
    const h = render(HealthApp);
    await settle();

    // Summing the four structural zeros into 「共 600 步」 is the same category error the
    // empty week is guarded against, one degree milder: 600 is the total of the sampled
    // days, not of the week. The cell reports the figure *and* what it covers.
    expect(weekSummary(h.container)).toBe(
      zh["health.weekPartial"].replace("{n}", "600").replace("{d}", "3"),
    );
    expect(weekSummary(h.container)).not.toBe(zh["health.weekTotal"].replace("{n}", "600"));
  });

  test("a fully-recorded week is still reported as the week's total (control)", async () => {
    const now = Date.now();
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      day: dayKey(addLocalDays(now, -i)),
      steps: 100,
      steps_recorded: true,
      hr_min: null,
      hr_max: null,
    }));
    writeStoreValue(HEALTH_HISTORY_KEY, { days, workouts: [] } satisfies HealthState);
    const h = render(HealthApp);
    await settle();

    // All seven days have a row, so the cell is the week's total — not the partial sentence.
    expect(weekSummary(h.container)).toBe(zh["health.weekTotal"].replace("{n}", "700"));
  });
});
