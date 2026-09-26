/**
 * HealthApp.svelte — a workout that is **still running** must not be given a duration.
 *
 * `Workout.endedAt === 0` is the running marker (`lib/health.ts` spells it out). The log list
 * renders every row as `formatDuration(w.endedAt - w.startedAt)`, so a running one computes
 * `0 - startedAt` — a large **negative** millisecond count that `formatDuration` turns into a
 * nonsense string (`-14:-40`), drawn beside the same workout the card above already shows as
 * 「进行中」. The sibling summary line on the same screen guards the identical subtraction
 * (`workoutTotals` does `ms += Math.max(0, w.endedAt - w.startedAt)`), which is the tell: the
 * guard exists one row away and was not applied here.
 *
 * The pair below is discriminating: while running the row carries the running marker, and after
 * stopping it carries a real elapsed time — so a fix that simply hard-codes 「进行中」 for every
 * row fails the second case.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import HealthApp from "../src/svelte/HealthApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  setLocale("zh");
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/** One macrotask: `readHealthVitals()` is awaited inside the mount effect. */
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A host whose sensor snapshot carries a real steps reading. */
function installBridge() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) =>
      cmd === "sensor_host_snapshot"
        ? { vitals: { timestamp_ms: Date.now(), steps_total: 100, heart_rate_bpm: null } }
        : null,
    listen: async () => () => {},
  };
}

function startWalk(h: { container: HTMLElement }): HTMLButtonElement {
  const btn = [...h.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === zh["health.kind.walk"],
  );
  if (!btn) throw new Error("walk start button not found");
  return btn as HTMLButtonElement;
}

describe("HealthApp.svelte — a running workout is never given a duration (REQ-A1490)", () => {
  test("the log row for a still-running workout says 进行中, never a negative time", async () => {
    installBridge();
    const h = render(HealthApp);
    await settle();

    await fireEvent.click(startWalk(h));
    await settle();

    const ul = h.container.querySelector("ul");
    expect(ul, "the workout log must render").not.toBeNull();
    expect(ul!.textContent ?? "").toContain(zh["health.running"]);
    // The defect's signature: a negative duration drawn anywhere in the screen.
    expect(txt(h)).not.toMatch(/-\d+:-?\d+/);
  });

  test("once stopped, the same row carries a real elapsed time (not the running marker)", async () => {
    installBridge();
    const h = render(HealthApp);
    await settle();

    await fireEvent.click(startWalk(h));
    await settle();

    const stop = [...h.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === zh["health.stop"],
    );
    expect(stop, "the running card offers a stop button").toBeTruthy();
    await fireEvent.click(stop as HTMLButtonElement);
    await settle();

    const ul = h.container.querySelector("ul");
    expect(ul!.textContent ?? "").not.toContain(zh["health.running"]);
    expect(txt(h)).not.toMatch(/-\d+:-?\d+/);
  });
});
