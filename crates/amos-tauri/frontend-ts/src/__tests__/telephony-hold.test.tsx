import { describe, expect, test } from "bun:test";
import { holdSet, isHoldState } from "../lib/useTelephonyHold";

const call = (id: string, state: string, direction = "Incoming") => ({
  id,
  peer: "1",
  state,
  direction,
  emergency: false,
  recording: "Off",
});

describe("holdSet pure reducer (call-id aware)", () => {
  test("adds holding states and removes only the ended call id", () => {
    const empty = new Set<string>();
    const afterA = holdSet(empty, call("A", "Active"));
    expect([...afterA]).toEqual(["A"]);
    const afterB = holdSet(afterA, call("B", "Ringing"));
    expect([...afterB].sort()).toEqual(["A", "B"]);
    // Ended for A removes only A; B keeps the hold.
    const onlyB = holdSet(afterB, call("A", "Ended"));
    expect([...onlyB]).toEqual(["B"]);
    // Ended for a call that isn't tracked is a no-op (same reference).
    const unchanged = holdSet(onlyB, call("ghost", "Ended", "Outgoing"));
    expect(unchanged).toBe(onlyB);
    // Ended for the last call empties the set → no hold.
    expect(holdSet(onlyB, call("B", "Ended")).size).toBe(0);
  });

  test("no-op and duplicate events keep the same reference", () => {
    const empty = new Set<string>();
    // Unknown/idle state leaves the set untouched.
    expect(holdSet(empty, call("A", "Held"))).toBe(empty);
    // Re-asserting the same call's Active is a no-op.
    const once = holdSet(empty, call("A", "Active"));
    expect(holdSet(once, call("A", "Active"))).toBe(once);
  });

  test("isHoldState covers Ring/Active/Dialing only", () => {
    expect(isHoldState("Ringing")).toBe(true);
    expect(isHoldState("Active")).toBe(true);
    expect(isHoldState("Dialing")).toBe(true);
    expect(isHoldState("Ended")).toBe(false);
    expect(isHoldState("Held")).toBe(false);
  });
});
