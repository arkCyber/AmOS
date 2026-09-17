import { describe, expect, it } from "bun:test";
import { calculateVirtualRange } from "../virtualScroll";

describe("calculateVirtualRange", () => {
  it("returns empty range when itemCount is 0", () => {
    const r = calculateVirtualRange(0, 500, 0, 50);
    expect(r.items).toHaveLength(0);
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(-1);
  });

  it("returns empty range when itemHeight is non-positive", () => {
    const r = calculateVirtualRange(0, 500, 100, 0);
    expect(r.items).toHaveLength(0);
  });

  it("returns empty range for non-finite inputs", () => {
    expect(calculateVirtualRange(NaN, 500, 100, 50).items).toHaveLength(0);
    expect(calculateVirtualRange(0, Infinity, 100, 50).items).toHaveLength(0);
    expect(calculateVirtualRange(0, 500, Infinity, 50).items).toHaveLength(0);
    expect(calculateVirtualRange(0, 500, 100, NaN).items).toHaveLength(0);
  });

  it("clamps scrollTop to 0", () => {
    const r = calculateVirtualRange(-100, 500, 100, 50);
    expect(r.startIndex).toBe(0);
  });

  it("renders first visible window with overscan", () => {
    // 10 items of 50px each. scrollTop=0, container=200px => visible 0..3 (indices 0-3)
    // overscan=2 => startIndex=max(0, 0-2)=0, endIndex=min(9, ceil(200/50)+2)=4+2=6
    const r = calculateVirtualRange(0, 200, 10, 50, 2);
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(6);
    expect(r.items).toHaveLength(7);
  });

  it("respects overscan when scrolled into the middle", () => {
    // scrollTop=500 => first visible index = 500/50 = 10
    // container=200 => ceil((500+200)/50) = 14 (inclusive of index 13)
    // overscan=3 => start=max(0, 10-3)=7, end=min(19, 14+3)=17
    const r = calculateVirtualRange(500, 200, 20, 50, 3);
    expect(r.startIndex).toBe(7);
    expect(r.endIndex).toBe(17);
    expect(r.items).toHaveLength(11);
  });

  it("caps endIndex at itemCount - 1", () => {
    // 10 items. Scroll to bottom with large overscan.
    // scrollTop=450 (last item), container=100, itemHeight=50 => visible 9..9
    // overscan=20 => endIndex=min(9, ceil(550/50)+20)=min(9,11+20)=9
    const r = calculateVirtualRange(450, 100, 10, 50, 20);
    expect(r.endIndex).toBe(9);
  });

  it("computes correct pixel offsets for each item", () => {
    const r = calculateVirtualRange(0, 100, 5, 50, 0);
    // first visible = 0, last visible = ceil(100/50) - 1 = 1
    expect(r.items[0]).toEqual({ index: 0, start: 0, size: 50, end: 50 });
    expect(r.items[1]).toEqual({ index: 1, start: 50, size: 50, end: 100 });
  });

  it("treats overscan=0 as no extra items", () => {
    // scrollTop=0, container=200, 10 items of 50, overscan=0
    // visible range: start=0, end=ceil(200/50)+0 = 4 (indices 0..4)
    const r = calculateVirtualRange(0, 200, 10, 50, 0);
    expect(r.items).toHaveLength(5);
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(4);
  });

  it("treats overscan=0 with scrollTop>0 correctly", () => {
    // scrollTop=250, container=200, 10 items of 50
    // first visible = 250/50 = 5; last visible = ceil((250+200)/50)-1 = 9
    const r = calculateVirtualRange(250, 200, 10, 50, 0);
    expect(r.startIndex).toBe(5);
    expect(r.endIndex).toBe(9);
    expect(r.items).toHaveLength(5);
  });

  it("handles single item list", () => {
    const r = calculateVirtualRange(0, 100, 1, 50, 0);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.index).toBe(0);
  });

  it("handles container taller than content", () => {
    // 3 items, container tall enough to show all
    const r = calculateVirtualRange(0, 1000, 3, 50, 0);
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(2);
    expect(r.items).toHaveLength(3);
  });
});
