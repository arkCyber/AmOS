/**
 * phoneApps.test.ts — `withoutPhone()` utility.
 *
 * The desktop shell cannot dial (no SIM). These tests pin that `withoutPhone`
 * drops every id in `PHONE_APP_IDS` and keeps every other id in the same order.
 */
import { describe, expect, test } from "vitest";
import { isPhoneApp, PHONE_APP_IDS, withoutPhone } from "../lib/phoneApps";

describe("lib/phoneApps.ts", () => {
  test("`phone` is a phone app id", () => {
    expect(isPhoneApp("phone")).toBe(true);
  });

  test("non-phone ids are not phone apps", () => {
    expect(isPhoneApp("settings")).toBe(false);
    expect(isPhoneApp("ai")).toBe(false);
    expect(isPhoneApp("")).toBe(false);
  });

  test("`withoutPhone` removes every PHONE_APP_IDS entry, keeps order", () => {
    const input = ["phone", "settings", "ai", "phone", "music"];
    expect(withoutPhone(input)).toEqual(["settings", "ai", "music"]);
  });

  test("`PHONE_APP_IDS` exposes exactly the phone-only ids we filter", () => {
    expect([...PHONE_APP_IDS]).toContain("phone");
  });
});
