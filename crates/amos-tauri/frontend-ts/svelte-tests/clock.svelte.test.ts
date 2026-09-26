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
import { reconcileNativeAlarms, resetArmedNativeAlarmsForTest } from "../src/svelte/osAlarmArm";
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

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

describe("ClockApp.svelte", () => {
  test("a rejected alarm write is reported (the alarms are the user's content)", async () => {
    const restore = failWritesFor("amos.alarms");
    try {
      const host = render(ClockApp);
      await tick();
      // The alarms tab state is on screen; the store rejected it, so say so rather than
      // letting the user believe the alarms survive a reload.
      expect(txt(host)).toContain("本机存储写入失败");
    } finally {
      restore();
    }
  });

  // The world-clock list is the user's content in exactly the way the alarm list is: they add,
  // remove and reorder cities by hand, and the rows redraw the moment they do. The write's own
  // verdict must be read, or a refused store loses the change silently — the screen shows the
  // new city and a reload shows it never happened. (The alarm writer a few lines below has said
  // so since it was written; the city writer was left `void`.)
  test("a rejected world-clock write is reported (the cities are the user's content too)", async () => {
    const restore = failWritesFor("amos.worldclock");
    try {
      const host = render(ClockApp);
      await tick();
      // The rows still draw (the reducer state did move) — so the only thing that can tell the
      // user the change will not survive a reload is the sentence.
      expect(host.container.querySelectorAll("[data-city]").length).toBeGreaterThan(0);
      expect(txt(host)).toContain("本机存储写入失败");
      // …and the disk really holds nothing: that is what the next launch reads.
      expect(window.localStorage.getItem("amos.worldclock")).toBeNull();
    } finally {
      restore();
    }
  });

  test("adding a city on a refused store shows it and says it did not land", async () => {
    const restore = failWritesFor("amos.worldclock");
    try {
      const host = render(ClockApp);
      await fireEvent.input(inputByAria(host, "搜索城市")!, { target: { value: "罗马" } });
      const add = host.container.querySelector('button[data-role="add-city"]') as HTMLButtonElement;
      await fireEvent.click(add);
      await tick();
      expect(host.container.querySelector('[data-city="Europe/Rome"]')).toBeTruthy();
      expect(txt(host)).toContain("本机存储写入失败");
      expect(window.localStorage.getItem("amos.worldclock")).toBeNull();
    } finally {
      restore();
    }
  });

  test("a landed world-clock write says nothing (control)", async () => {
    const host = render(ClockApp);
    await fireEvent.input(inputByAria(host, "搜索城市")!, { target: { value: "罗马" } });
    const add = host.container.querySelector('button[data-role="add-city"]') as HTMLButtonElement;
    await fireEvent.click(add);
    await tick();
    expect(host.container.querySelector('[data-city="Europe/Rome"]')).toBeTruthy();
    expect(txt(host)).not.toContain("本机存储写入失败");
    expect(window.localStorage.getItem("amos.worldclock")).not.toBeNull();
  });

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

  test("a query matching no city offers nothing and disables + (domain search)", async () => {
    const host = render(ClockApp);
    await fireEvent.input(inputByAria(host, "搜索城市")!, {
      target: { value: "zzzz-not-a-city" },
    });
    const sel = host.container.querySelector('select[aria-label="城市"]') as HTMLSelectElement;
    expect([...sel.querySelectorAll("option")]).toHaveLength(0);
    const add = host.container.querySelector('button[data-role="add-city"]') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
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

  // iOS parity: 计次 is available while the stopwatch is **paused**, not only while running
  // (the lap snapshots the frozen elapsed). The idle stopwatch has nothing to lap.
  test("计次 stays available while the stopwatch is paused", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "秒表") as HTMLButtonElement);
    const byAria = (label: string) =>
      [...host.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === label,
      ) as HTMLButtonElement;
    const lap = () => byAria("计次");
    const runToggle = () => byAria("秒表");

    // idle: nothing to lap
    expect(lap().disabled).toBe(true);

    // start → let elapsed advance → lap while running
    await fireEvent.click(runToggle());
    await new Promise<void>((r) => setTimeout(r, 80));
    await fireEvent.click(lap());
    await tick();
    expect(txt(host)).toContain("计次 1");

    // pause → the lap button must STAY enabled (the fix; it used to be disabled)
    await fireEvent.click(runToggle());
    expect(lap().disabled).toBe(false);
    await fireEvent.click(lap());
    await tick();
    expect(txt(host)).toContain("计次 2");

    // reset → idle again, nothing to lap
    await fireEvent.click(byAria("重置"));
    expect(lap().disabled).toBe(true);
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

  test("a ring with no audio at all says so instead of implying a sound", async () => {
    // No Audio / AudioContext in this environment → the ringtone layer cannot
    // start anything, `activeRingtone()` is null, and the banner must not imply a
    // sound that isn't playing.
    const w = window as unknown as Record<string, unknown>;
    const saved = {
      Audio: w.Audio,
      AudioContext: w.AudioContext,
      webkitAudioContext: w.webkitAudioContext,
    };
    delete w.Audio;
    delete w.AudioContext;
    delete w.webkitAudioContext;
    try {
      window.localStorage.setItem(
        "amos.alarms",
        JSON.stringify([
          { id: "r2", hour: 8, min: 0, enabled: true, ringing: true, tone: "🔔" },
        ]),
      );
      const host = render(ClockApp);
      await tick();
      expect(host.container.querySelector('[data-testid="alarm-ring"]')).toBeTruthy();
      const silent = host.container.querySelector('[data-testid="alarm-ring-silent"]');
      expect(silent).toBeTruthy();
      expect(silent?.textContent ?? "").toContain("无法播放声音");
    } finally {
      w.Audio = saved.Audio;
      w.AudioContext = saved.AudioContext;
      w.webkitAudioContext = saved.webkitAudioContext;
    }
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

  // REQ-A962: the running state was painted only as a glyph + colour, and the static
  // `aria-label` shadows the glyph — so the toggle also carries `aria-pressed`, and it must
  // track exactly what the glyph shows. (Seeded explicitly: an earlier case in this file
  // leaves a *running* timer in the shared store.)
  test("the timer's play/pause says whether it is running (REQ-A962)", async () => {
    window.localStorage.setItem(
      "amos.timer",
      JSON.stringify({ running: false, totalMs: 60_000, remainingMs: 60_000, endAtMs: 0, fired: false }),
    );
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
    const toggle = () =>
      [...host.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === "计时器",
      ) as HTMLButtonElement;
    expect(toggle().getAttribute("data-icon")).toBe("play");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(toggle());
    await tick();
    expect(toggle().getAttribute("data-icon")).toBe("pause"); // the glyph really moved
    expect(toggle().getAttribute("aria-pressed")).toBe("true"); // and so did the state

    await fireEvent.click(toggle()); // pause again — leave no running timer behind
    await tick();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  // The stopwatch's toggle is the sibling of the timer's — same fix, pinned separately so
  // one of them cannot regress behind the other's test (REQ-A962).
  test("the stopwatch's play/pause says whether it is running (REQ-A962)", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "秒表") as HTMLButtonElement);
    const toggle = () =>
      [...host.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === "秒表",
      ) as HTMLButtonElement;
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(toggle());
    await tick();
    expect(toggle().getAttribute("data-icon")).toBe("pause");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(toggle()); // stop it — the 1 Hz interval is torn down on unmount,
    await tick(); // but leave the tab idle rather than running.
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
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

  test("says when the OS will not wake a sleeping phone for an alarm (REQ-A369)", async () => {
    // What the host now answers: the in-process ledger holds the alarm, but the *device*
    // half did not happen (exact alarms refused). Before this, the page looked fine and a
    // dozing phone was never woken (F-TAU-007, measured on a real device).
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) =>
        cmd === "scheduler_alarm_register"
          ? { id: args.id, atMs: args.atMs, device: { state: "disallowed" } }
          : null,
      listen: async () => async () => {},
    };
    resetArmedNativeAlarmsForTest();
    window.localStorage.setItem(
      "amos.alarms",
      JSON.stringify([{ id: "a1", hour: 7, min: 30, label: "", enabled: true, ringing: false, tone: "🔔" }]),
    );
    // The watcher does this when the list changes (started from Shell in the real app).
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());

    const host = render(ClockApp);
    await tick();
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);

    const banner = host.container.querySelector('[data-testid="alarm-native-wake"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-native-wake")).toBe("disallowed");
    expect(banner!.textContent).toContain("不会响");
    cleanup();
    resetArmedNativeAlarmsForTest();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
  });

  test("offers the way out when the OS refused exact alarms (REQ-A373)", async () => {
    const calls: string[] = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push(cmd);
        if (cmd === "scheduler_alarm_register") {
          return { id: args.id, atMs: args.atMs, device: { state: "disallowed" } };
        }
        if (cmd === "scheduler_alarm_open_settings") return false; // the glue could not post it
        return null;
      },
      listen: async () => async () => {},
    };
    resetArmedNativeAlarmsForTest();
    window.localStorage.setItem(
      "amos.alarms",
      JSON.stringify([{ id: "a1", hour: 7, min: 30, label: "", enabled: true, ringing: false, tone: "🔔" }]),
    );
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());

    const host = render(ClockApp);
    await tick();
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);
    const grant = host.container.querySelector('[data-testid="alarm-native-wake-grant"]') as HTMLButtonElement;
    expect(grant).not.toBeNull();

    await fireEvent.click(grant);
    await tick();
    expect(calls).toContain("scheduler_alarm_open_settings");
    // The command resolved `false` (no screen was started) → say *that*, never "已打开".
    const msg = host.container.querySelector('[data-testid="alarm-native-wake-msg"]');
    expect(msg?.textContent ?? "").toContain("没能打开");
    cleanup();
    resetArmedNativeAlarmsForTest();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
  });

  test("a non-refusal state must not claim the OS refused, and offers no button (REQ-A373)", async () => {
    // `unattached` = boot ordering (the glue is not bound yet): nothing was refused, so the copy
    // must not say it was, and there is nothing for the user to grant.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) =>
        cmd === "scheduler_alarm_register"
          ? { id: args.id, atMs: args.atMs, device: { state: "unattached" } }
          : null,
      listen: async () => async () => {},
    };
    resetArmedNativeAlarmsForTest();
    window.localStorage.setItem(
      "amos.alarms",
      JSON.stringify([{ id: "a1", hour: 7, min: 30, label: "", enabled: true, ringing: false, tone: "🔔" }]),
    );
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());

    const host = render(ClockApp);
    await tick();
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);
    const banner = host.container.querySelector('[data-testid="alarm-native-wake"]');
    expect(banner?.getAttribute("data-native-wake")).toBe("unattached");
    const text = banner?.textContent ?? "";
    expect(text).toContain("本机未能安排"); // the neutral sentence
    expect(text).not.toContain("系统未允许"); // never a cause we did not observe
    expect(host.container.querySelector('[data-testid="alarm-native-wake-grant"]')).toBeNull();
    cleanup();
    resetArmedNativeAlarmsForTest();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
  });

  // REQ-A875 / F-ALM-004. `nativeAlarmDeviceState().cancel` had no reader at all, so a
  // cancellation the device did not carry out was invisible: the module forgot the id and
  // the user was never told the OS might still ring. The pair below is two-sided — the line
  // is drawn for the refusal and *not* drawn for the release — because an assertion that only
  // ever sees the refusal cannot tell "the notice is right" from "the notice is always there".
  const ALARM_ON = [{ id: "a1", hour: 7, min: 30, label: "", enabled: true, ringing: false, tone: "🔔" }];
  const ALARM_OFF = [{ id: "a1", hour: 7, min: 30, label: "", enabled: false, ringing: false, tone: "🔔" }];

  async function renderClockAfterDisable(cancelState: string) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) =>
        cmd === "scheduler_alarm_cancel"
          ? { id: args.id, wasRegistered: true, device: { state: cancelState } }
          : null,
      listen: async () => async () => {},
    };
    resetArmedNativeAlarmsForTest();
    window.localStorage.setItem("amos.alarms", JSON.stringify(ALARM_ON));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());
    // The user turns the alarm off → the host is asked to cancel it.
    window.localStorage.setItem("amos.alarms", JSON.stringify(ALARM_OFF));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 5).getTime());

    const host = render(ClockApp);
    await tick();
    await fireEvent.click(tab(host, "闹钟") as HTMLButtonElement);
    return host;
  }

  test("says when a turned-off alarm may still ring from the OS (REQ-A875)", async () => {
    const host = await renderClockAfterDisable("unavailable");
    const pending = host.container.querySelector('[data-testid="alarm-native-cancel-pending"]');
    expect(pending).not.toBeNull();
    expect(pending!.getAttribute("data-pending")).toBe("1");
    expect(pending!.textContent).toContain("可能仍会响");
    cleanup();
    resetArmedNativeAlarmsForTest();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
  });

  test("a cancellation the OS confirmed is not announced as pending", async () => {
    const host = await renderClockAfterDisable("cancelled");
    expect(host.container.querySelector('[data-testid="alarm-native-cancel-pending"]')).toBeNull();
    cleanup();
    resetArmedNativeAlarmsForTest();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
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

  // ---- the three live readouts are queryable, like the four clock faces (REQ-A1115) ----
  //
  // `role="timer"` names a value that changes on its own so screen readers can ask for it
  // on demand, without `aria-live` (which would shout every second — REQ-A284 refused it).
  // StatusBar / LockScreen / ClockWidget / StageClock and the in-call duration all carry
  // `role="timer"` + a stable label; the Clock app's own three readouts did not.
  const readout = (host: { container: HTMLElement }) =>
    host.container.querySelector<HTMLElement>('[role="timer"]');

  test("the world clock's time is a labelled timer, not an anonymous div (REQ-A1115)", () => {
    const host = render(ClockApp);
    const el = readout(host);
    expect(el, "the current time must be queryable by assistive tech").not.toBeNull();
    expect(el!.getAttribute("aria-label")).toBe("当前时间");
    expect(el!.textContent?.trim()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("the countdown is a labelled timer (REQ-A1115)", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
    const el = readout(host);
    expect(el, "the countdown must be queryable by assistive tech").not.toBeNull();
    expect(el!.getAttribute("aria-label")).toBe("计时器");
    expect(el!.textContent?.trim()).toMatch(/^\d{2}:\d{2}$/);
  });

  test("the stopwatch is a labelled timer (REQ-A1115)", async () => {
    const host = render(ClockApp);
    await fireEvent.click(tab(host, "秒表") as HTMLButtonElement);
    const el = readout(host);
    expect(el, "the elapsed stopwatch must be queryable by assistive tech").not.toBeNull();
    expect(el!.getAttribute("aria-label")).toBe("秒表");
    expect(el!.textContent?.trim()).toMatch(/^\d{2}:\d{2}\.\d{2}$/);
  });
});

/**
 * REQ-A1431 ∕ FMEA F-SH-689 — the countdown's write verdict.
 *
 * `amos.timer` is the **third** independent writer on this screen (the alarm list and the
 * city list are the other two, and both already speak). It is the one whose refusal costs
 * the most: the record exists *only* so an OS notifier can finish the countdown after this
 * screen closes (`lib/timerStore.ts`'s doc), so a refused write leaves the countdown the
 * user set living on this screen alone — it rings nowhere, and nothing on screen said so.
 */
describe("ClockApp.svelte — a refused countdown write is reported (REQ-A1431)", () => {
  const armFive = (h: { container: HTMLElement }) =>
    [...h.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "5 分",
    ) as HTMLButtonElement | undefined;

  test("拒绝写入时说出拒写，且盘上没有这一枚计时器", async () => {
    window.localStorage.removeItem("amos.timer");
    const restore = failWritesFor("amos.timer");
    try {
      const host = render(ClockApp);
      await tick();
      // The mount flush is a **no-op** write (nothing has changed yet), so it must NOT
      // print 「本次改动未保存」 on a screen where the user has done nothing.
      expect(txt(host)).not.toContain("本机存储写入失败");

      await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
      await fireEvent.click(armFive(host)!);
      await tick();

      // The countdown is armed on screen; the store refused it, so the sentence is the only
      // thing that can tell the user it will not be there when the screen closes.
      expect(host.container.querySelector('[data-testid="timer-readout"]')?.textContent ?? txt(host)).toContain("05:00");
      expect(txt(host)).toContain("本机存储写入失败");
      expect(window.localStorage.getItem("amos.timer")).toBeNull();
    } finally {
      restore();
      window.localStorage.removeItem("amos.timer");
    }
  });

  test("对照：写入被收下时什么都不说，且盘上有这一枚计时器", async () => {
    window.localStorage.removeItem("amos.timer");
    const host = render(ClockApp);
    await tick();
    await fireEvent.click(tab(host, "计时器") as HTMLButtonElement);
    await fireEvent.click(armFive(host)!);
    await tick();
    expect(txt(host)).not.toContain("本机存储写入失败");
    expect(window.localStorage.getItem("amos.timer")).not.toBeNull();
    const stored = JSON.parse(window.localStorage.getItem("amos.timer")!) as { totalMs?: number };
    expect(stored.totalMs).toBe(300_000);
    window.localStorage.removeItem("amos.timer");
  });
});
