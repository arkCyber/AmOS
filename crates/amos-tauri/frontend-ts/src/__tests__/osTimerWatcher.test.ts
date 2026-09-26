import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { NOTIF_KEY } from "../lib/settings";
import { TIMER_KEY, writeTimer } from "../lib/timerStore";
import { LOCALE_KEY } from "../svelte/i18n";
import { startTimerWatcher, timerWatcherTick } from "../svelte/osTimerWatcher";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const NOW = 1_000_000;

afterEach(() => {
  window.localStorage.removeItem(TIMER_KEY);
  window.localStorage.removeItem(NOTIF_KEY);
  window.localStorage.removeItem(LOCALE_KEY);
});

describe("osTimerWatcher — pure-Svelte host timer notifier", () => {
  test("fires + notifies once when a running timer's deadline is reached", () => {
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });
    expect(timerWatcherTick(null, NOW)).toBe(true);
    const notifs = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as { id: string }[];
    expect(notifs.filter((x) => x.id === "timer:done")).toHaveLength(1);
    // Fires exactly once.
    expect(timerWatcherTick(null, NOW)).toBe(false);
  });

  test("suppressed while the Clock app is the focused surface", () => {
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });
    expect(timerWatcherTick("clock", NOW)).toBe(false);
    // Timer still running in store (the Clock app's in-app timer owns it).
    const t = JSON.parse(window.localStorage.getItem(TIMER_KEY) ?? "{}") as { running?: boolean };
    expect(t.running).toBe(true);
  });

  test("not due yet → no fire", () => {
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW + 10_000, fired: false });
    expect(timerWatcherTick(null, NOW)).toBe(false);
  });

  test("the OS notification text follows the UI locale (English UI → English notification)", () => {
    // A notification is a **stored display string**: it is resolved once, here, in a
    // `setInterval` callback — not during a render. The producer used to read the `zh`
    // dictionary directly, so an English-UI user got 「时钟 / 时间到」 in this banner.
    window.localStorage.setItem(LOCALE_KEY, "en");
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });
    expect(timerWatcherTick(null, NOW)).toBe(true);
    const notifs = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as {
      id: string;
      app?: string;
      title?: string;
    }[];
    const n = notifs.find((x) => x.id === "timer:done")!;
    expect(n.app).toBe("Clock");
    expect(n.title).toBe("Time's up");
  });
});

/**
 * REQ-A1394 ∕ FMEA F-SH-653 — the alert must land **before** the one-shot is consumed.
 *
 * `pollTimer` writes `{running:false, fired:true}`; that write is the only thing stopping
 * later ticks, so consuming it before the notification existed dropped the alert forever
 * whenever the notification's own write was refused. The refusal this pins is the one
 * quota pressure actually produces: `writeJson` refuses **per `setItem`**, and the
 * notifications array (up to `NOTIF_CAP` rows) is far larger than the timer's tiny record —
 * so `amos.timer` lands while `amos.notifications` is refused.
 */
describe("osTimerWatcher — a refused notification must not consume the timer (REQ-A1394)", () => {
  let refuseNotifWrites = false;
  let restore: (() => void) | null = null;

  const installRefusingStorage = (): void => {
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
        if (refuseNotifWrites && k === NOTIF_KEY) throw new Error("QuotaExceededError");
        real.setItem(k, v);
      },
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
    restore = () => {
      Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
    };
  };

  const timerState = (): { running?: boolean; fired?: boolean } =>
    JSON.parse(window.localStorage.getItem(TIMER_KEY) ?? "{}") as { running?: boolean; fired?: boolean };
  const doneRows = (): { id: string }[] =>
    (JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as { id: string }[]).filter(
      (x) => x.id === "timer:done",
    );

  const withStorage = (body: () => void): void => {
    installRefusingStorage();
    try {
      body();
    } finally {
      // 逐例复位：一次失败的断言不许把「存储拒写」的开关漏给下一例。
      refuseNotifWrites = false;
      restore?.();
      restore = null;
    }
  };

  test("拒写 ⇒ 不消费这一次到点（timer 仍 running、fired 仍 false），下一次 tick 重试并成功", () => {
    withStorage(() => {
      refuseNotifWrites = true;
      writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });

      expect(timerWatcherTick(null, NOW), "提醒没落脚 ⇒ 不许报「已提醒」").toBe(false);
      expect(timerState().running, "这一次到点**没有被消费**").toBe(true);
      expect(timerState().fired).toBe(false);
      expect(doneRows()).toHaveLength(0);

      // 存储恢复 ⇒ 下一次 tick 把那一句提醒补上（用户等的那一声只是晚了一拍，不是没有）。
      refuseNotifWrites = false;
      expect(timerWatcherTick(null, NOW + 1_000)).toBe(true);
      expect(doneRows()).toHaveLength(1);
      expect(timerState().running).toBe(false);
      // 仍然只响一次。
      expect(timerWatcherTick(null, NOW + 2_000)).toBe(false);
    });
  });

  test("对照：存储收下 ⇒ 一次 tick 就响，且第二次不再响", () => {
    withStorage(() => {
      writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });
      expect(timerWatcherTick(null, NOW)).toBe(true);
      expect(doneRows()).toHaveLength(1);
      expect(timerWatcherTick(null, NOW + 1_000)).toBe(false);
      expect(doneRows(), "重试路径不许把同一枚 id 叠成两行").toHaveLength(1);
    });
  });

  test("重试仍**幂等**：盘上已有一行 timer:done 时再响一次，仍只有一行", () => {
    withStorage(() => {
      window.localStorage.setItem(
        NOTIF_KEY,
        JSON.stringify([{ id: "timer:done", app: "Clock", icon: "⏱️", title: "x", time: NOW - 5_000 }]),
      );
      writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });
      expect(timerWatcherTick(null, NOW)).toBe(true);
      expect(doneRows()).toHaveLength(1);
    });
  });
});

/**
 * REQ-A1404 ∕ FMEA F-SH-663 — a non-array `amos.notifications` must not wedge the timer alert.
 *
 * `readJson` (lib/amosStore) quarantines only **unparseable** bytes: a stored `null`, `{}` or
 * `5` is valid JSON, so it comes back as-is and the `null` fallback never fires (that fires only
 * when the string is *absent*). `removeNotif(list, id)` is `list.filter(...)`, so the raw read
 * threw *before* the alert was written — and `timerWatcherTick` throws before `pollTimer`, so
 * the one-shot was never consumed either. Both of this watcher's call sites wrap the tick in a
 * bare `catch {}`, so this was swallowed on every 1 s tick, forever: the countdown reached zero
 * and nothing ever said so.
 *
 * The three sibling producers of the same key — `alarmCore`, `calendarCore`, `reminderCore` —
 * all pass this read through `normalizeNotifs`, and two of them carry the rule verbatim
 * ("a corrupt value must not wedge the alert pipeline … on every tick, forever"). This producer
 * was missed by that sweep (REQ-A1400 fixed the `alarmCore` half).
 */
describe("osTimerWatcher — a corrupt notifications store must not wedge the alert (REQ-A1404)", () => {
  const setCorrupt = (raw: string): void => window.localStorage.setItem(NOTIF_KEY, raw);
  const doneRows = (): { id: string }[] =>
    (JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as { id: string }[]).filter(
      (x) => x.id === "timer:done",
    );
  const timerState = (): { running?: boolean; fired?: boolean } =>
    JSON.parse(window.localStorage.getItem(TIMER_KEY) ?? "{}") as {
      running?: boolean;
      fired?: boolean;
    };

  test("一个非数组对象（合法 JSON）⇒ 提醒照常落地一次，且存储被修好成数组", () => {
    setCorrupt(JSON.stringify({ nope: true }));
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });

    expect(timerWatcherTick(null, NOW), "提醒没落脚 ⇒ 不许报「已提醒」").toBe(true);
    expect(doneRows(), "那一句「时间到」仍然只有一行").toHaveLength(1);
    expect(timerState().running, "这一次到点被消费了").toBe(false);
    expect(Array.isArray(JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "null"))).toBe(true);
    // 仍然只响一次（幂等路径没有被这次修复破坏）。
    expect(timerWatcherTick(null, NOW + 1_000)).toBe(false);
  });

  test("字面量 null（镜像 ∕ 水合路径的形状）⇒ 同样照常落地", () => {
    setCorrupt("null");
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });

    expect(timerWatcherTick(null, NOW)).toBe(true);
    expect(doneRows()).toHaveLength(1);
    expect(timerState().running).toBe(false);
  });

  test("对照：数组内的坏条目被丢弃，好条目留下（走的是 normalizeNotifs，不只是「是个数组就行」）", () => {
    setCorrupt(JSON.stringify([{ nope: 1 }, { id: "keep", time: NOW - 1_000, app: "X" }]));
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });

    expect(timerWatcherTick(null, NOW)).toBe(true);
    const rows = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as { id?: string }[];
    // 长度也要断（`toEqual` 对数组里的 `undefined` 是宽容的：只比 id 列表看不见被留下的
    // 坏条目 —— 这条叶子的第一版就是这么错的，负控 NC-B 把它抓了出来）。
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => typeof r.id === "string")).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual(["keep", "timer:done"]);
  });

  test("没有到点的计时器时不读也不改通知存储（修复不引入一次急切的改写）", () => {
    setCorrupt(JSON.stringify({ nope: true }));
    // 空闲计时器（`running: false`）⇒ `timerDue` 在读到通知存储之前就返回了。
    expect(timerWatcherTick(null, NOW)).toBe(false);
    expect(window.localStorage.getItem(NOTIF_KEY)).toBe(JSON.stringify({ nope: true }));
  });

  test("生产路径：`startTimerWatcher` 的裸 catch 不再把这一次到点吞掉", async () => {
    setCorrupt(JSON.stringify({ nope: true }));
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: Date.now() - 100, fired: false });
    const stop = startTimerWatcher(() => null);
    try {
      // 这个 watcher 的 tick 周期是 1 s；给它两个周期（真实的 setInterval 回调，
      // 即那条把异常吞掉的路径本身）。
      await new Promise((r) => setTimeout(r, 2_200));
    } finally {
      stop();
    }
    expect(timerState().running, "到点被消费了（不是被 catch 吞掉）").toBe(false);
    expect(doneRows()).toHaveLength(1);
  });
});

/**
 * REQ-A1431 ∕ FMEA F-SH-689 — the mirror image of F-SH-653: the **timer** write is the
 * refused one.
 *
 * F-SH-653's doc reasoned that quota pressure refuses the (large) notifications array while
 * the (tiny) `amos.timer` record lands — so the fix put the alert first. It does not follow
 * that `amos.timer` always lands: `writeJson` refuses **per `setItem`** (quota is
 * size-dependent, and availability can change between two writes a millisecond apart), and
 * `pollTimer`'s consume is itself a write. With its verdict dropped, `timerWatcherTick`
 * answered `true` — "the deadline was consumed" — off the attempt, not off the store: the
 * timer stayed `running` and due, so the very next tick announced the same deadline again,
 * and "Fires exactly once" read as satisfied while it was not.
 */
describe("osTimerWatcher — a refused timer write is not a consumed one-shot (REQ-A1431)", () => {
  let refuseTimerWrites = false;
  let restore: (() => void) | null = null;

  const installRefusingStorage = (): void => {
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
        if (refuseTimerWrites && k === TIMER_KEY) throw new Error("QuotaExceededError");
        real.setItem(k, v);
      },
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
    restore = () => {
      Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
    };
  };

  const timerState = (): { running?: boolean; fired?: boolean } =>
    JSON.parse(window.localStorage.getItem(TIMER_KEY) ?? "{}") as { running?: boolean; fired?: boolean };
  const doneRows = (): { id: string }[] =>
    (JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as { id: string }[]).filter(
      (x) => x.id === "timer:done",
    );

  test("消费被拒 ⇒ 这一拍不许报「已消费」；存储恢复后重试才落定（且始终只有一行）", () => {
    // 先在真存储上种一个「已到点、未消费」的计时器，再换上会拒写 `amos.timer` 的存储。
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });
    installRefusingStorage();
    try {
      refuseTimerWrites = true;
      // 提醒**落**了（`amos.notifications` 不在拒写名单里），但那一枚一次性位没有消费掉。
      expect(timerWatcherTick(null, NOW), "消费没落盘 ⇒ 不许报「已消费」").toBe(false);
      expect(doneRows(), "提醒本身是落地的（正是这一点让返回值有信息量）").toHaveLength(1);
      expect(timerState().running, "这一次到点**没有被消费**").toBe(true);
      expect(timerState().fired).toBe(false);

      // 存储恢复 ⇒ 下一拍把那一枚位消费掉，从此不再响（幂等：同一枚 id 仍只有一行）。
      refuseTimerWrites = false;
      expect(timerWatcherTick(null, NOW + 1_000)).toBe(true);
      expect(doneRows()).toHaveLength(1);
      expect(timerState().running).toBe(false);
      expect(timerWatcherTick(null, NOW + 2_000)).toBe(false);
    } finally {
      refuseTimerWrites = false;
      restore?.();
      restore = null;
    }
  });

  test("对照：存储收下消费 ⇒ 第一拍就报 true，第二拍 false", () => {
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });
    installRefusingStorage();
    try {
      expect(timerWatcherTick(null, NOW)).toBe(true);
      expect(timerState().running).toBe(false);
      expect(timerWatcherTick(null, NOW + 1_000)).toBe(false);
      expect(doneRows()).toHaveLength(1);
    } finally {
      restore?.();
      restore = null;
    }
  });
});
