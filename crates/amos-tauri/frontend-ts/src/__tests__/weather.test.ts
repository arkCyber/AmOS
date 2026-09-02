import { describe, expect, test } from "bun:test";
import { forecast, dayLabel, intlTag } from "../lib/weather";

describe("weather", () => {
  test("provides a deterministic 5-day forecast starting today", () => {
    const days = forecast();
    expect(days.length).toBe(5);
    expect(days[0].daysFromNow).toBe(0);
    days.forEach((d, i) => expect(d.daysFromNow).toBe(i));
  });

  test("intlTag maps locales and dayLabel yields a weekday string", () => {
    expect(intlTag("zh")).toBe("zh-CN");
    expect(intlTag("en")).toBe("en-US");
    const base = new Date(2024, 0, 1); // a Monday
    expect(dayLabel("en", base, 0).length).toBeGreaterThan(0);
    expect(dayLabel("zh", base, 1).length).toBeGreaterThan(0);
  });
});
