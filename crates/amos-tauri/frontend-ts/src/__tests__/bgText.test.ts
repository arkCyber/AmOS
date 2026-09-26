import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { bgT } from "../svelte/bgText";
import { LOCALE_KEY } from "../svelte/i18n";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

afterEach(() => {
  window.localStorage.removeItem(LOCALE_KEY);
});

describe("bgT — non-reactive text follows the locale in effect", () => {
  test("with no locale set it resolves the default (zh) — the behaviour before this seam", () => {
    expect(bgT("app.clock")).toBe("时钟");
    expect(bgT("clock.timerDone")).toBe("时间到");
    expect(bgT("app.reminders")).toBe("提醒事项");
    expect(bgT("app.calendar")).toBe("日历");
  });

  test("an English locale resolves the English dictionary", () => {
    window.localStorage.setItem(LOCALE_KEY, "en");
    expect(bgT("app.clock")).toBe("Clock");
    expect(bgT("clock.timerDone")).toBe("Time's up");
    expect(bgT("app.reminders")).toBe("Reminders");
    expect(bgT("app.calendar")).toBe("Calendar");
  });

  test("the locale is read per call, so a live switch is honoured (never frozen at init)", () => {
    expect(bgT("app.clock")).toBe("时钟");
    window.localStorage.setItem(LOCALE_KEY, "en");
    expect(bgT("app.clock")).toBe("Clock");
    window.localStorage.removeItem(LOCALE_KEY);
    expect(bgT("app.clock")).toBe("时钟");
  });

  test("a junk locale value falls back to zh rather than throwing or leaking a key", () => {
    window.localStorage.setItem(LOCALE_KEY, "klingon");
    expect(bgT("app.clock")).toBe("时钟");
  });
});
