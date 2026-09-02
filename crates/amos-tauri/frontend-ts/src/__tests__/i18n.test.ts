import { describe, expect, test } from "bun:test";
import { translate } from "../i18n";
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";
import { isLocale } from "../i18n/types";

describe("i18n", () => {
  test("translates known keys per locale", () => {
    expect(translate(zh, "app.phone")).toBe("电话");
    expect(translate(en, "app.phone")).toBe("Phone");
    expect(translate(zh, "home.greeting")).toBe("你好，Amos");
    expect(translate(en, "home.greeting")).toBe("Hello, Amos");
  });

  test("falls back to the key when a dictionary entry is missing", () => {
    expect(translate(zh, "missing.key")).toBe("missing.key");
  });

  test("interpolates {params}", () => {
    expect(translate(zh, "count.notifications", { n: 3 })).toBe("3 条通知");
    expect(translate(en, "count.notifications", { n: 7 })).toBe("7 notifications");
  });

  test("zh and en dictionaries expose the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  test("isLocale accepts only supported locales", () => {
    expect(isLocale("zh")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });
});
