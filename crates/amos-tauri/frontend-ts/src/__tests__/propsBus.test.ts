import { afterEach, describe, expect, test } from "bun:test";
import {
  disposePropsChannel,
  propsChannel,
  resetPropsChannels,
  type PropsChannel,
} from "../svelte/propsBus";

/**
 * Contract tests for the general React ⇄ Svelte external-props channel
 * (src/svelte/propsBus.ts). Locks both directions:
 *   • DOWN: host pushes updated props; subscribers see the new value (in-place).
 *   • UP: component emits actions; host listener receives (event, detail).
 */

interface HomeProps {
  layout: { page: string[]; dock: string[]; hidden: string[] };
  pulseId: string | null;
}

afterEach(() => resetPropsChannels());

describe("propsChannel — DOWN direction (React → Svelte external props)", () => {
  test("set() stores a snapshot readable via get() and pushes to subscribers", () => {
    const c: PropsChannel<HomeProps> = propsChannel<HomeProps>("home");
    const seen: (HomeProps | undefined)[] = [];
    const unsub = c.subscribe((v) => seen.push(v));

    const p1: HomeProps = { layout: { page: ["a"], dock: ["b"], hidden: [] }, pulseId: null };
    c.set(p1);
    expect(c.get()).toEqual(p1);
    expect(seen[seen.length - 1]).toEqual(p1);

    // In-place update (no remount semantics): a later set() reaches the
    // subscriber with the new value — this is what preserves internal state.
    const p2: HomeProps = {
      layout: { page: ["a", "c"], dock: ["b"], hidden: [] },
      pulseId: "a",
    };
    c.set(p2);
    expect(c.get()).toEqual(p2);
    expect(seen[seen.length - 1]).toEqual(p2);

    unsub();
  });

  test("a named channel is shared: two subscribers on the same name both update", () => {
    const a = propsChannel<HomeProps>("home");
    const b = propsChannel<HomeProps>("home");
    const aSeen: number[] = [];
    const bSeen: number[] = [];
    a.subscribe(() => aSeen.push(1));
    b.subscribe(() => bSeen.push(1));
    const p: HomeProps = { layout: { page: [], dock: [], hidden: [] }, pulseId: null };
    a.set(p);
    expect(aSeen.length).toBeGreaterThan(0);
    expect(bSeen.length).toBeGreaterThan(0);
  });

  test("distinct names are isolated", () => {
    const home = propsChannel<HomeProps>("home");
    const other = propsChannel<{ x: number }>("other");
    const otherSeen: ({ x: number } | undefined)[] = [];
    other.subscribe((v) => otherSeen.push(v));
    home.set({ layout: { page: [], dock: [], hidden: [] }, pulseId: null });
    expect(other.get()).toBeUndefined();
    expect(otherSeen).toEqual([undefined]);
  });
});

describe("propsChannel — UP direction (Svelte → React actions)", () => {
  test("emit() delivers (event, detail) to registered listeners", () => {
    const c = propsChannel<HomeProps>("home");
    const received: [string, unknown][] = [];
    c.on((event, detail) => received.push([event, detail]));

    c.emit("open", "phone");
    c.emit("move", { drag: "phone", over: "mail" });
    c.emit("search");

    expect(received).toEqual([
      ["open", "phone"],
      ["move", { drag: "phone", over: "mail" }],
      ["search", undefined],
    ]);
  });

  test("on() returns an unsubscribe that stops delivery", () => {
    const c = propsChannel<HomeProps>("home");
    let count = 0;
    const off = c.on(() => count++);
    c.emit("open", "x");
    expect(count).toBe(1);
    off();
    c.emit("open", "x");
    expect(count).toBe(1);
  });
});

describe("propsChannel — dispose (clean teardown for a leaving screen)", () => {
  test("disposePropsChannel drops DOWN state and UP listeners; re-get starts clean", () => {
    const c = propsChannel<HomeProps>("home");
    const p: HomeProps = { layout: { page: ["a"], dock: [], hidden: [] }, pulseId: null };
    c.set(p);
    let pings = 0;
    c.on(() => pings++);
    expect(c.get()).toEqual(p);
    c.emit("open", "x");
    expect(pings).toBe(1);

    // After dispose, the old channel is gone.
    disposePropsChannel("home");

    // Re-getting the same name creates a FRESH channel: no stale snapshot, and
    // the previous listener no longer fires.
    const again = propsChannel<HomeProps>("home");
    expect(again.get()).toBeUndefined();
    again.emit("open", "y");
    expect(pings).toBe(1); // unchanged — old listener was dropped
  });
});

