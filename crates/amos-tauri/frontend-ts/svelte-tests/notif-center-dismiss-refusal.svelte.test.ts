/**
 * notif-center-dismiss-refusal.svelte.test.ts — 逐条「忽略」也必须先问设备（REQ-A1303）。
 *
 * 上一轮（REQ-A1251／F-SH-528）修的是这两块面板的**整份清空**：先清本地、再丢掉设备的判决，
 * 于是被拒时屏幕先清空、轮询又把设备仍持有的行写回来。同一段代码里的**逐条忽略**是同一个
 * 形状，只是规模从「一份历史」缩到「一行」：
 *
 * ```ts
 * if (notifs.find((n) => n.id === id)?.source === "push") void deleteNotification(id);
 * persist(removeNotif(notifs, id));
 * ```
 *
 * 推送行是设备历史的**投影**（`osPushWatcher` 每几秒重问一次 `push_get_history`，把存储里
 * 已经没有的记录写回），所以只在本地面删掉的一行会在下一次轮询之后**回来** —— 而用户看到
 * 的是它消失了又出现，中间没有任何一句解释。
 *
 * `delete_notification` 答的是「设备手里有没有这条」：`true` = 删掉了，一个格式良好的
 * `false` = 设备本来就没持有它 —— **两者都是答复**，两种情况下这一行都真的不在设备上了，
 * 本地删掉是对的。拿布尔值当"成功 ∕ 失败"会把一次**成功**（设备答 `false`）报成失败 —— 镜像
 * 缺陷，`installHost(false)` 那条就是钉它的。
 *
 * 三值而不是两值：`true` ∕ `false` 是**设备的答复**，`null` 是**根本没问到**（REQ-A1352）。
 * 这一层判决曾经从**每命令共用**的 `bridgeDiag("push_delete_notification")` 槽里捞回来 ——
 * 而那个槽是"最后一次"的：两次忽略同时在飞时，谁的结果最后落地就是谁说了算，一次被拒绝
 * 的删除会被另一行的成功盖住，于是行删了、设备还留着（下面的 interleave 用例）。
 * `deleteNotification` 现在把 `null` 直接答出来，返回值就是判决，账本降级为解释。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import DesktopNotificationCenter from "../src/svelte/DesktopNotificationCenter.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, type Notif } from "../src/lib/settings";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const REFUSED = zh["pushSettings.deleteFailed"];

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 一条外壳自己的通知 + 一条推送投递。被忽略的是**推送**那条。 */
const RECORDS: Notif[] = [
  { id: "n1", app: "时钟", title: "计时结束", body: "5 分钟已到", icon: "⏱️", time: 1_700_000_000_000 },
  {
    id: "n2",
    app: "邮件",
    title: "新邮件",
    body: "来自 Amos",
    icon: "✉️",
    time: 1_700_000_600_000,
    source: "push",
    read: false,
  },
];

/**
 * Install a host whose `push_delete_notification` behaves as `answer` describes:
 *   • `"refuse"` — the call does not reach the device (Tauri 2 `Err` ⇒ the promise rejects ⇒
 *     `invoke` records `command-failed` and answers `null`);
 *   • `false` — the device **answered** that it does not hold the id (a well-formed reply).
 */
function installHost(answer: "refuse" | boolean): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "push_delete_notification") {
        if (answer === "refuse") throw new Error("device store is locked");
        return answer;
      }
      return null;
    },
    listen: async () => () => {},
  };
}

const held = (): Notif[] => JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as Notif[];
/** 忽略**推送那一行**（n2）：`querySelector` 会拿到第一行，而第一行是外壳自己的通知。 */
const dismiss = (c: HTMLElement): HTMLButtonElement =>
  c.querySelector(
    `[data-testid="nc-notif-n2"] button[aria-label="${zh["a11y.dismiss"]}"]`,
  ) as HTMLButtonElement;

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  setLocale("zh");
  writeStoreValue(NOTIF_KEY, RECORDS);
});
afterEach(() => {
  cleanup();
  resetPropsChannels();
  setLocale("zh");
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("NotificationCenter —— 忽略一条推送、而设备没删掉它（REQ-A1303）", () => {
  test("本地那一行也要留住，并且要说出来", async () => {
    installHost("refuse");
    propsChannel<{ open: boolean }>("nc").set({ open: true });
    const { container } = render(NotificationCenter);
    await settle();

    await fireEvent.click(dismiss(container));
    await settle();

    // 下一轮轮询写回时，屏幕才不会先消失又出现。
    expect(held()).toHaveLength(2);
    expect(container.textContent ?? "").toContain(REFUSED);
  });
});

describe("DesktopNotificationCenter —— 忽略一条推送、而设备没删掉它（REQ-A1303）", () => {
  test("本地那一行也要留住，并且要说出来", async () => {
    installHost("refuse");
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await settle();

    await fireEvent.click(dismiss(container));
    await settle();

    expect(held()).toHaveLength(2);
    expect(container.textContent ?? "").toContain(REFUSED);
  });
});

// 设备**答了** `false`（它手里本来就没有这条）—— 一次成功。本地删掉是对的，且一句失败都
// 不该说：把布尔值当判决的写法会把这一次报成「设备没删掉」。
describe("设备回答「它没有这条」（REQ-A1303）", () => {
  test("本地照常删掉，且不报失败", async () => {
    installHost(false);
    propsChannel<{ open: boolean }>("nc").set({ open: true });
    const { container } = render(NotificationCenter);
    await settle();

    await fireEvent.click(dismiss(container));
    await settle();

    expect(held().map((n) => n.id)).toEqual(["n1"]);
    expect(container.textContent ?? "").not.toContain(REFUSED);
  });
});

// 没有宿主桥（手机 ∕ 平板的正常路径）：轮询第一步就 `if (!bridged()) return 0`，没有谁会写回，
// 忽略本来就是纯本地动作 —— 门不该宽过它的理由。
describe("没有宿主桥时（REQ-A1303）", () => {
  test("忽略照常生效，且不报一句问不到的失败", async () => {
    propsChannel<{ open: boolean }>("nc").set({ open: true });
    const { container } = render(NotificationCenter);
    await settle();

    await fireEvent.click(dismiss(container));
    await settle();

    expect(held().map((n) => n.id)).toEqual(["n1"]);
    expect(container.textContent ?? "").not.toContain(REFUSED);
  });
});

/**
 * 两次忽略同时在飞（REQ-A1352 / F-SH-616）。
 *
 * 判决曾经从 **`push_delete_notification` 这一个命令名共用**的 `bridgeDiag` 槽里读 ——
 * 而那个槽只装"最后一次"。两次忽略几乎同时发出时，被拒绝的那一次会在自己**已经**写进账本、
 * 却还没读到账本的那一瞬，被另一次成功的写覆盖：于是它读到 `{ ok: true }`，把设备仍然持有的
 * 那一行从本地删掉，而 `osPushWatcher` 下一次轮询会把它原样写回来。
 *
 * 构造：**同一轮同步**点两次（中间不 await），被拒绝的那次（n2）与成功的那次（n3）都在同一
 * 批微任务里结算。结算顺序是：n2 写账本 → n3 写账本（覆盖）→ n2 读账本。旧实现因此把 n2 也
 * 删了；新实现读的是各自的返回值，n2 拿到 `null`，行留住。
 */
describe("两次忽略同时在飞（REQ-A1352）", () => {
  const ROWS: Notif[] = [
    { id: "n1", app: "时钟", title: "计时结束", icon: "⏱️", time: 1_700_000_000_000 },
    { id: "n2", app: "邮件", title: "新邮件", icon: "✉️", time: 1_700_000_600_000, source: "push", read: false },
    { id: "n3", app: "日历", title: "日程提醒", icon: "📅", time: 1_700_001_200_000, source: "push", read: false },
  ];

  test("被拒绝的那一行不能被另一行的成功盖过去", async () => {
    writeStoreValue(NOTIF_KEY, ROWS);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "push_delete_notification") {
          if (args?.id === "n2") throw new Error("device store is locked"); // 设备没删掉
          return true; // 设备删掉了
        }
        return null;
      },
      listen: async () => () => {},
    };

    propsChannel<{ open: boolean }>("nc").set({ open: true });
    const { container } = render(NotificationCenter);
    await settle();

    const rowBtn = (id: string) =>
      container.querySelector(
        `[data-testid="nc-notif-${id}"] button[aria-label="${zh["a11y.dismiss"]}"]`,
      ) as HTMLButtonElement;

    // 同步点两次，中间不 await —— 两次调用必须在同一批微任务里结算。
    rowBtn("n2").click();
    rowBtn("n3").click();
    await settle();

    // 设备没删掉 n2 ⇒ 本地也必须留住它（否则下一次轮询会把它写回来）。
    // n3 设备删掉了 ⇒ 本地照常删掉。
    expect(held().map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(container.textContent ?? "").toContain(REFUSED);
  });
});

// 桌面右半边那块面板是**另一份实现**（同一个 `deleteNotification`，同一套规则），
// 所以同一个交错也必须在那里成立 —— 只在一处修好的规则会在另一处原样复发。
describe("DesktopNotificationCenter —— 两次忽略同时在飞（REQ-A1352）", () => {
  const ROWS: Notif[] = [
    { id: "n1", app: "时钟", title: "计时结束", icon: "⏱️", time: 1_700_000_000_000 },
    { id: "n2", app: "邮件", title: "新邮件", icon: "✉️", time: 1_700_000_600_000, source: "push", read: false },
    { id: "n3", app: "日历", title: "日程提醒", icon: "📅", time: 1_700_001_200_000, source: "push", read: false },
  ];

  test("被拒绝的那一行不能被另一行的成功盖过去", async () => {
    writeStoreValue(NOTIF_KEY, ROWS);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "push_delete_notification") {
          if (args?.id === "n2") throw new Error("device store is locked");
          return true;
        }
        return null;
      },
      listen: async () => () => {},
    };

    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await settle();

    const rowBtn = (id: string) =>
      container.querySelector(
        `[data-testid="nc-notif-${id}"] button[aria-label="${zh["a11y.dismiss"]}"]`,
      ) as HTMLButtonElement;

    rowBtn("n2").click();
    rowBtn("n3").click();
    await settle();

    expect(held().map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(container.textContent ?? "").toContain(REFUSED);
  });
});
