import { describe, expect, test } from "bun:test";
import { makeLock, sanitizePin, validPin, PIN_MIN, PIN_MAX } from "../lib/lock";

describe("lock passcode", () => {
  test("sanitizePin keeps only digits and caps at 6", () => {
    expect(sanitizePin("12a34")).toBe("1234");
    expect(sanitizePin("1234567")).toBe("123456");
  });

  test("policy: 4-6 digit passcode", () => {
    expect(PIN_MIN).toBe(4);
    expect(PIN_MAX).toBe(6);
    expect(validPin("1234")).toBe(true);
    expect(validPin("123456")).toBe(true);
    expect(validPin("123")).toBe(false); // too short
    expect(validPin("12a34")).toBe(true); // non-digits stripped -> 1234
    expect(validPin("1234567")).toBe(true); // sanitize caps to 6 -> valid (UI also caps input)
  });

  test("makeLock disables and keeps a previous valid pin on empty input", () => {
    expect(makeLock(false, "1234", { enabled: true, pin: "0000" })).toEqual({ enabled: false });
    expect(makeLock(true, "", { enabled: true, pin: "0000" })).toEqual({ enabled: true, pin: "0000" });
  });

  test("makeLock enables only with a valid 4-6 digit pin", () => {
    expect(makeLock(true, "1234", { enabled: false })).toEqual({ enabled: true, pin: "1234" });
    expect(makeLock(true, "123456", { enabled: false })).toEqual({ enabled: true, pin: "123456" });
    // Changing an existing pin is validated too.
    expect(makeLock(true, "9999", { enabled: true, pin: "0000" })).toEqual({ enabled: true, pin: "9999" });
  });

  test("边界（REQ-A1131）：本机存的**就是密码本身**，不是摘要 —— 页面把这一点说给用户", () => {
    // 这条断言是**边界钉**，不是行为测试：它把「锁是界面门禁、不是保密边界」写成一个会红的
    // 事实。存的就是明文口令，配置里没有第三个字段（没有摘要、没有盐）。
    // 拒绝的两个"加固"方向与理由写在 `lib/lock.ts` 头部；任何要走那两条路的改动，都必须先改
    // `lock.passcodeHint` 的说法与这条断言，而不是悄悄上线。
    const cfg = makeLock(true, "1234", { enabled: false });
    expect(Object.keys(cfg).sort()).toEqual(["enabled", "pin"]);
    expect(cfg.pin).toBe("1234");
  });

  test("makeLock refuses to enable without a usable pin", () => {
    // Too-short new pin, no previous: refused (never an unlockable-less lock).
    expect(makeLock(true, "123", { enabled: false })).toEqual({ enabled: false });
    // Enabling with empty input and no previous pin: refused.
    expect(makeLock(true, "", { enabled: false })).toEqual({ enabled: false });
    // Invalid change keeps the previous valid pin.
    expect(makeLock(true, "12", { enabled: true, pin: "0000" })).toEqual({ enabled: true, pin: "0000" });
  });
});
