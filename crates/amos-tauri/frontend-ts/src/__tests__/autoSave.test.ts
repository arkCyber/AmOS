import { describe, expect, test } from "bun:test";
import {
  clockLabel,
  createDebouncer,
  initialSaveState,
  saveStateReducer,
  type TimerApi,
} from "../lib/autoSave";

/** A manual clock the debouncer tests can drive deterministically. */
class FakeTimers implements TimerApi {
  time = 0;
  private next = 0;
  private map = new Map<number, { at: number; cb: () => void }>();

  set(cb: () => void, ms: number): unknown {
    const id = ++this.next;
    this.map.set(id, { at: this.time + ms, cb });
    return id;
  }
  clear(id: unknown): void {
    this.map.delete(id as number);
  }
  /** Advance the clock; fire due callbacks in order (re-armed ones may fire later). */
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = [...this.map.entries()]
        .filter(([, e]) => e.at <= this.time)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) return;
      for (const [id, e] of due) {
        this.map.delete(id);
        e.cb();
      }
    }
  }
}

function make() {
  const t = new FakeTimers();
  let calls = 0;
  const fn = () => {
    calls += 1;
  };
  const debouncer = createDebouncer(fn, 10, t);
  return { t, calls: () => calls, debouncer };
}

describe("createDebouncer", () => {
  test("fires once on the trailing edge after the idle window", () => {
    const { t, calls, debouncer } = make();
    debouncer.schedule();
    t.advance(9);
    expect(calls()).toBe(0); // not yet
    t.advance(1);
    expect(calls()).toBe(1); // fired exactly once
  });

  test("coalesces rapid schedules into one call", () => {
    const { t, calls, debouncer } = make();
    debouncer.schedule();
    t.advance(5);
    debouncer.schedule(); // resets the idle timer
    t.advance(9);
    expect(calls()).toBe(0);
    t.advance(1);
    expect(calls()).toBe(1); // only one fire
  });

  test("cancel drops a pending call", () => {
    const { t, calls, debouncer } = make();
    debouncer.schedule();
    debouncer.cancel();
    t.advance(100);
    expect(calls()).toBe(0);
  });

  test("flush runs a pending call now and disarms it", () => {
    const { t, calls, debouncer } = make();
    debouncer.schedule();
    debouncer.flush();
    expect(calls()).toBe(1);
    t.advance(100);
    expect(calls()).toBe(1); // nothing left to fire
  });

  test("flush with nothing pending is a no-op", () => {
    const { calls, debouncer } = make();
    debouncer.flush();
    expect(calls()).toBe(0);
  });
});

describe("saveStateReducer", () => {
  test("edit → dirty saving, saved → clean saved", () => {
    let s = initialSaveState;
    s = saveStateReducer(s, { type: "edit" });
    expect(s).toEqual({ dirty: true, status: "saving" });
    s = saveStateReducer(s, { type: "saved" });
    expect(s).toEqual({ dirty: false, status: "saved" });
  });
  test("save_failed keeps the draft dirty and reports error", () => {
    const s = saveStateReducer(saveStateReducer(initialSaveState, { type: "edit" }), {
      type: "save_failed",
    });
    expect(s).toEqual({ dirty: true, status: "error" });
  });
  test("flush_started marks saving without losing dirty", () => {
    const s = saveStateReducer({ dirty: true, status: "saved" }, { type: "flush_started" });
    expect(s).toEqual({ dirty: true, status: "saving" });
  });
});

describe("clockLabel", () => {
  test("zero-pads h:m:s", () => {
    expect(clockLabel(new Date(2026, 0, 1, 9, 5, 7))).toBe("09:05:07");
  });
});
