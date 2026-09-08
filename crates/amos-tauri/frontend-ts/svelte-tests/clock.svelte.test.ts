/**
 * DOM tests for the Svelte 5 clock screen (ClockApp.svelte).
 *
 * The pure stopwatch/timer/alarm reduction is unit-tested against lib/time.ts
 * (shared by the React + Svelte UIs). Here we verify the Svelte UI wiring:
 * default world-clock cities, tab switching, initial countdown/stopwatch, and
 * adding an alarm through the form. We do NOT assert on running timers (timing
 * is covered by the pure reducer tests); the 1 Hz interval is torn down on
 * unmount via $effect cleanup.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ClockApp from "../src/svelte/ClockApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(() => {
  cleanup();
  setLocale("zh");
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const tab = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll('button[role="tab"]')].find((b) =>
    (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;
const inputByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === aria) as
    HTMLInputElement | undefined;

describe("ClockApp.svelte", () => {
  test("world-clock rows carry an iOS-style offset / day subtitle", async () => {
    const host = render(ClockApp);
    const rows = host.container.querySelectorAll('[data-city]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of Array.from(rows)) {
      const sub = row.querySelector("[data-zone-sub]") as HTMLElement | null;
      expect(sub).toBeTruthy(); // every row renders a relative line
      const text = (sub?.textContent ?? "").trim();
      // zh locale: each city is either 同时 (same as local) or 快/慢 N 小时,
      // optionally prefixed by 明天/昨天 when its calendar day differs.
      expect(text).toMatch(/同时|快|慢|明天|昨天/);
    }
  });

  test("world-clock search narrows the catalog and adds the match", async () => {
    const host = render(ClockApp);
    const sel = host.container.querySelector('select[aria-label="城市"]') as HTMLSelectElement;
    const opts = () => [...sel.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value);
    expect(opts()).toContain("Australia/Sydney");
    expect(opts()).toContain("Europe/Rome");

    // Type the (zh) name of Rome → only the match stays.
    await fireEvent.input(inputByAria(host, "搜索城市")!, { target: { value: "罗马" } });
    expect(opts()).toEqual(["Europe/Rome"]);

    // Adding picks the matched city.
    const add = host.container.querySelector('button[data-role="add-city"]') as HTMLButtonElement;
    expect((add as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(add);
    expect(host.container.querySelector('[data-city="Europe/Rome"]')).toBeTruthy();
  });

  test("adds a larger-catalog city (Hong Kong) with its bilingual name", async () => {
    const host = render(ClockApp);
    await fireEvent.input(inputByAria(host, "搜索城市")!, { target: { value: "香港" } });
    const add = host.container.querySelector('button[data-role="add-city"]') as HTMLButtonElement;
    await fireEvent.click(add);
    await tick();
    // Shown as a world row with its zh name…
    expect(host.container.querySelector('[data-city="Asia/Hong_Kong"]')).toBeTruthy();
    // …and persisted with a bilingual name (survives normalize on reload).
    const stored = JSON.parse(window.localStorage.getItem("amos.worldclock") ?? "[]") as {
      zone: string; labelKey?: string; name?: { zh: string; en: string };
    }[];
    const hk = stored.find((c) => c.zone === "Asia/Hong_Kong");
    expect(hk?.name).toEqual({ zh: "香港", en: "Hong Kong" });
  });

  test("world tab shows default cities incl. 北京", () => {
    const host = render(ClockApp);
    expect(txt(host)).toContain("北京");
    expect(txt(host)).toContain("伦敦");
  });

  test("world-clock picker adds the chosen city (not just the next preset)", async () => {
    const host = render(ClockApp);
    expect(host.container.querySelector('[data-city="Europe/Paris"]')).toBeFalsy();
    const sel = host.container.querySelector('select[aria-label="城市"]') as HTMLSelectElement;
    expect(sel).toBeTruthy();
    // Paris is offered but not yet on the list; choose it from the catalog.
    expect([...sel.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value)).toContain(
      "Europe/Paris",
    );
    await fireEvent.change(sel, { target: { value: "Europe/Paris" } });
    const addBtn = host.container.querySelector('button[data-role="add-city"]') as HTMLButtonElement;
    expect(addBtn).toBeTruthy();
    await fireEvent.click(addBtn);
    // The picked city is now a list row …
    expect(host.container.querySelector('[data-city="Europe/Paris"]')).toBeTruthy();
    // … and is no longer offered (dedupe).
    const opts = [...sel.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value);
    expect(opts).not.toContain("Europe/Paris");
  });

  test("stopwatch tab shows initial 00:00.00", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "秒表") as HTMLButtonElement);
    expect(txt(host)).toContain("00:00.00");
  });

  test("timer tab shows initial 00:00", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
    expect(txt(host)).toContain("00:00");
  });

  test("alarm tab starts empty and can add an alarm", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);
    expect(txt(host)).toContain("还没有闹钟");

    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "7" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "30" } });
    await fireEvent.input(inputByAria(host, "标签（可选）")!, { target: { value: "起床" } });
    const add = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "添加",
    );
    expect(add).toBeTruthy();
    await fireEvent.click(add as HTMLButtonElement);
    expect(txt(host)).toContain("07:30");
    expect(txt(host)).toContain("起床");
  });

  test("tapping an alarm opens the editor; saving rewrites it in place", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);

    // Add one alarm to edit.
    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "7" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "30" } });
    await fireEvent.input(inputByAria(host, "标签（可选）")!, { target: { value: "起床" } });
    const add = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "添加",
    ) as HTMLButtonElement;
    await fireEvent.click(add);

    // The row itself is the edit affordance (iOS parity). Clicking it loads 07:30.
    const row = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("07:30"),
    ) as HTMLButtonElement;
    expect(row).toBeTruthy();
    await fireEvent.click(row);

    // Editor banner + form prefilled with the alarm's current values.
    expect(txt(host)).toContain("正在编辑闹钟");
    expect(inputByAria(host, "时")!.value).toBe("07");
    expect(inputByAria(host, "分")!.value).toBe("30");

    // Change time + label, then save → count stays 1, old label gone.
    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "8" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "15" } });
    await fireEvent.input(inputByAria(host, "标签（可选）")!, { target: { value: "晨跑" } });
    const save = host.container.querySelector('button[data-role="save-edit"]') as HTMLButtonElement;
    expect(save).toBeTruthy();
    await fireEvent.click(save);

    expect(txt(host)).toContain("共 1 个");
    expect(txt(host)).toContain("08:15");
    expect(txt(host)).toContain("晨跑");
    expect(txt(host)).not.toContain("起床");
    // Editing finished → back to the add form.
    expect(txt(host)).not.toContain("正在编辑闹钟");
    expect([...host.container.querySelectorAll("button")].some((b) =>
      (b.textContent ?? "").trim() === "添加",
    )).toBe(true);
  });

  test("cancel leaves the alarm untouched", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);
    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "6" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "0" } });
    const add = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "添加",
    ) as HTMLButtonElement;
    await fireEvent.click(add);
    expect(txt(host)).toContain("06:00");

    const row = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("06:00"),
    ) as HTMLButtonElement;
    await fireEvent.click(row);
    // Change the hour, then cancel (the cancel in the edit banner).
    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "9" } });
    const cancel = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "取消",
    ) as HTMLButtonElement;
    expect(cancel).toBeTruthy();
    await fireEvent.click(cancel);
    expect(txt(host)).toContain("06:00");
    expect(txt(host)).not.toContain("09:00");
  });

  test("world-clock edit mode can reorder cities and persists the new order", async () => {
    const host = render(ClockApp);
    const order = () =>
      [...host.container.querySelectorAll("[data-city]")].map((el) => el.getAttribute("data-city"));

    // Default four in preset order.
    expect(order()).toEqual(["Asia/Shanghai", "Asia/Tokyo", "Europe/London", "America/New_York"]);

    // Enter edit mode.
    const edit = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "编辑",
    ) as HTMLButtonElement;
    await fireEvent.click(edit);

    // Move the first city (北京/Shanghai) down one slot.
    const first = host.container.querySelector('[data-city="Asia/Shanghai"]') as HTMLElement;
    const down = first.querySelector('button[data-role="move-down"]') as HTMLButtonElement;
    expect(down).toBeTruthy();
    await fireEvent.click(down);
    await tick();
    expect(order()).toEqual(["Asia/Tokyo", "Asia/Shanghai", "Europe/London", "America/New_York"]);

    // The persisted store reflects the new order.
    const stored = JSON.parse(window.localStorage.getItem("amos.worldclock") ?? "[]") as {
      zone: string;
    }[];
    expect(stored.map((c) => c.zone)).toEqual([
      "Asia/Tokyo", "Asia/Shanghai", "Europe/London", "America/New_York",
    ]);

    // The now-first city's move-up is disabled at the top edge.
    const top = host.container.querySelector('[data-city="Asia/Tokyo"]') as HTMLElement;
    expect((top.querySelector('button[data-role="move-up"]') as HTMLButtonElement).disabled).toBe(true);
  });

  test("ringtone picker selects a tone; saving persists it", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);

    // The editor exposes a 试听 preview control and per-tone chips.
    expect([...host.container.querySelectorAll("button")].some((b) =>
      (b.textContent ?? "").trim() === "试听",
    )).toBe(true);
    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-label") === "选择铃声 ⏰",
    ) as HTMLButtonElement;
    expect(chip).toBeTruthy();

    // Choose the ⏰ ringtone, set a time, save.
    await fireEvent.click(chip);
    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "6" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "30" } });
    const add = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "添加",
    ) as HTMLButtonElement;
    await fireEvent.click(add);

    // The persisted alarm carries the chosen ringtone token.
    const stored = JSON.parse(window.localStorage.getItem("amos.alarms") ?? "[]") as {
      tone?: string;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tone).toBe("⏰");
  });

  test("alarm list renders earliest-first regardless of add order", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);

    // Add 08:00 first…
    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "8" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "0" } });
    const add1 = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "添加",
    ) as HTMLButtonElement;
    await fireEvent.click(add1);

    // …then 06:00. The list must still show 06:00 above 08:00.
    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "6" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "0" } });
    const add2 = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "添加",
    ) as HTMLButtonElement;
    await fireEvent.click(add2);

    const text = txt(host);
    expect(text.indexOf("06:00")).toBeGreaterThan(-1);
    expect(text.indexOf("08:00")).toBeGreaterThan(-1);
    expect(text.indexOf("06:00")).toBeLessThan(text.indexOf("08:00")); // earliest first
    expect(text).toContain("共 2 个");
  });

  test("alarm time steppers step and wrap within valid ranges", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);
    const val = (aria: string) => inputByAria(host, aria)!.value;
    const step = (role: string) =>
      host.container.querySelector(`button[data-step="${role}"]`) as HTMLButtonElement;

    // Default 8:00 → minute up = 8:01; hour up thrice = 11:01.
    expect(val("分")).toBe("0");
    await fireEvent.click(step("min-up"));
    expect(val("分")).toBe("01");
    await fireEvent.click(step("hour-up"));
    await fireEvent.click(step("hour-up"));
    await fireEvent.click(step("hour-up"));
    expect(val("时")).toBe("11");

    // Wrap hour: 23:59 +1 → 00:59 (minute unchanged).
    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "23" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "59" } });
    await fireEvent.click(step("hour-up"));
    expect(val("时")).toBe("00");
    expect(val("分")).toBe("59");
    // Wrap minute: 00:00 −1 → 00:59.
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "0" } });
    await fireEvent.click(step("min-down"));
    expect(val("分")).toBe("59");
  });

  test("repeat quick preset sets weekdays and persists", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);

    const weekdayBtn = host.container.querySelector('button[data-role="repeat-weekdays"]') as HTMLButtonElement;
    expect(weekdayBtn).toBeTruthy();
    await fireEvent.click(weekdayBtn);

    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "7" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "30" } });
    const add = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "添加",
    ) as HTMLButtonElement;
    await fireEvent.click(add);

    const stored = JSON.parse(window.localStorage.getItem("amos.alarms") ?? "[]") as {
      repeat?: number[];
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.repeat).toEqual([1, 2, 3, 4, 5]); // Mon..Fri
  });

  test("a persisted ringing alarm shows the animated ring and can be dismissed", async () => {
    window.localStorage.setItem(
      "amos.alarms",
      JSON.stringify([
        { id: "r1", hour: 8, min: 0, label: "晨起", enabled: true, ringing: true, tone: "🔔" },
      ]),
    );
    const host = render(ClockApp);

    // The ringing state survives seeding → the animated ring surface is visible.
    const ring = host.container.querySelector('[data-testid="alarm-ring"]') as HTMLElement;
    expect(ring).toBeTruthy();
    expect(txt(host)).toContain("08:00");
    expect(txt(host)).toContain("晨起");
    expect(txt(host)).toContain("再响");

    // Dismissing clears it (and the store no longer marks it ringing).
    const dismiss = [...ring.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "关闭",
    ) as HTMLButtonElement;
    expect(dismiss).toBeTruthy();
    await fireEvent.click(dismiss);
    await tick();
    expect(host.container.querySelector('[data-testid="alarm-ring"]')).toBeFalsy();
    const stored = JSON.parse(window.localStorage.getItem("amos.alarms") ?? "[]") as {
      ringing?: boolean;
    }[];
    expect(stored[0]!.ringing).toBe(false);
  });

  test("choosing a snooze length persists it on the alarm", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);
    const chip = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "9",
    ) as HTMLButtonElement;
    expect(chip).toBeTruthy();
    await fireEvent.click(chip);

    await fireEvent.input(inputByAria(host, "时")!, { target: { value: "7" } });
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "0" } });
    const add = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "添加",
    ) as HTMLButtonElement;
    await fireEvent.click(add);
    await tick();

    const stored = JSON.parse(window.localStorage.getItem("amos.alarms") ?? "[]") as {
      snoozeMin?: number;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.snoozeMin).toBe(9);
  });

  test("timer arms persist to the OS timer store", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "2" } });
    await tick();
    const read = () => JSON.parse(window.localStorage.getItem("amos.timer") ?? "{}") as {
      running?: boolean; totalMs?: number; endAtMs?: number;
    };
    // Armed (not started): persisted idle with the total set.
    expect(read().totalMs).toBeGreaterThanOrEqual(120_000);
    expect(read().running).toBe(false);
  });

  test("starting the timer persists a running wall-clock deadline", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "1" } });
    const play = [...host.container.querySelectorAll("button")].find((b) =>
      b.getAttribute("data-icon") === "play",
    ) as HTMLButtonElement;
    await fireEvent.click(play);
    await tick();
    const t = JSON.parse(window.localStorage.getItem("amos.timer") ?? "{}") as {
      running?: boolean; endAtMs?: number;
    };
    expect(t.running).toBe(true);
    expect(typeof t.endAtMs).toBe("number");
    expect(t.endAtMs!).toBeGreaterThan(Date.now());
  });

  test("an armed (not-started) timer is restored across restart", async () => {
    window.localStorage.setItem(
      "amos.timer",
      JSON.stringify({ running: false, totalMs: 300_000, remainingMs: 300_000, endAtMs: 0, fired: false }),
    );
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
    expect(txt(host)).toContain("05:00");
    // Still idle (can be started) — not marked "time's up".
    expect(txt(host)).not.toContain("时间到");
  });

  test("timer accepts a custom mm:ss and quick presets", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
    expect(txt(host)).toContain("00:00");

    // Custom: 2 min 30 s → display arms to 02:30.
    await fireEvent.input(inputByAria(host, "分")!, { target: { value: "2" } });
    await fireEvent.input(inputByAria(host, "秒")!, { target: { value: "30" } });
    expect(txt(host)).toContain("02:30");

    // Quick preset "1 分" → resets the arming to 01:00.
    const preset = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "1 分",
    ) as HTMLButtonElement;
    expect(preset).toBeTruthy();
    await fireEvent.click(preset);
    expect(txt(host)).toContain("01:00");

    // The play button becomes enabled once a duration is armed.
    const play = [...host.container.querySelectorAll("button")].find((b) =>
      b.getAttribute("data-icon") === "play",
    ) as HTMLButtonElement;
    expect(play).toBeTruthy();
    expect((play as HTMLButtonElement).disabled).toBe(false);
  });
});
