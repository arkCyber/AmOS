import { describe, it, expect, beforeEach } from "bun:test";
import { debounce } from "../utils/debounce";

describe("debounce", () => {
  beforeEach(() => {
    // Clean up any pending timers
  });

  it("should call function after delay", async () => {
    let callCount = 0;
    const fn = debounce(() => {
      callCount++;
    }, 100);

    fn();
    expect(callCount).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(1);
  });

  it("should debounce multiple rapid calls", async () => {
    let callCount = 0;
    const fn = debounce(() => {
      callCount++;
    }, 100);

    // Rapid fire 5 calls
    fn();
    fn();
    fn();
    fn();
    fn();

    expect(callCount).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(1); // Only called once
  });

  it("should use the latest arguments", async () => {
    let lastValue = "";
    const fn = debounce((value: string) => {
      lastValue = value;
    }, 100);

    fn("first");
    fn("second");
    fn("third");

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lastValue).toBe("third");
  });

  it("should cancel pending call", async () => {
    let callCount = 0;
    const fn = debounce(() => {
      callCount++;
    }, 100);

    fn();
    fn.cancel();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(0);
  });

  it("should handle multiple debounce sequences", async () => {
    let callCount = 0;
    const fn = debounce(() => {
      callCount++;
    }, 50);

    // First sequence
    fn();
    fn();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(callCount).toBe(1);

    // Second sequence
    fn();
    fn();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(callCount).toBe(2);
  });

  it("should preserve context", async () => {
    const obj = {
      value: 42,
      getValue: debounce(function (this: { value: number }) {
        return this.value;
      }, 50),
    };

    const promise = new Promise<number>((resolve) => {
      const original = obj.getValue;
      obj.getValue = debounce(function (this: { value: number }) {
        resolve(this.value);
        return this.value;
      }, 50);
    });

    obj.getValue();
    const result = await promise;
    expect(result).toBe(42);
  });

  it("should work with zero delay", async () => {
    let callCount = 0;
    const fn = debounce(() => {
      callCount++;
    }, 0);

    fn();
    fn();
    fn();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(1);
  });
});
