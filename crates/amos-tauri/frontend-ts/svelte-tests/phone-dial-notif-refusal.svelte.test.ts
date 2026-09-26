/**
 * phone-dial-notif-refusal.svelte.test.ts — 拨号时被拒的通知写入必须说出口，不能静默吞掉
 * （REQ-A1948 / FMEA F-SH-944）。
 *
 * `PhoneApp.svelte::recordOutgoing` 在同一条拨号路径上做**两次**写：
 *   ① `storeErr = callLogStore.save(next) ? "" : t("common.storeWriteFailed");`
 *      —— 检查了判决（`lib/calllog` 的 `save` 是 checked 写）；
 *   ② `writeStoreValue(NOTIF_KEY, addNotif(normalizeNotifs(readStoreValue(NOTIF_KEY, [])), entry));`
 *      —— `writeStoreValue` 是 `void`，判决被**扔掉**。
 *
 * 两次写指向**不同的键**（`amos.calllog` 与 `amos.notifications`），所以第二次可以单独失败：
 * 存储满 ∕ 不可用时，调用记录那一趟可能刚好装得下、而更大的通知列表装不下 —— 于是通知从
 * 通知中心**静默消失**，页面上却什么也不说（`storeErr` 还是空串）。
 *
 * 姊妹面**已经修过**：`ContactsApp.svelte` 的同一次拨号用 `writeStoreValueChecked` 并把失败
 * 折进 `storeErr`（其逐字注释：「The sibling above checked; this one used the unchecked
 * `writeStoreValue`, so a full/unavailable store silently ate the notification while the page
 * still reported the dial.」），且有回归用例 `contacts.svelte.test.ts` 的
 * 「a rejected notification write is reported, not swallowed」。同一个手势在**电话** App 里
 * 是同一个缺陷、同一个产物 —— 本文件是它缺席的那一条。
 *
 * 判据：拒写后页面上要出现 `t("common.storeWriteFailed")`（本机存储写入失败），且通知确实没落地。
 * 第二条用例是**反向守卫** —— 存储正常时必须照旧落地，修法不许把正常路径判红。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PhoneApp from "../src/svelte/PhoneApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { CALLLOG_KEY } from "../src/lib/calllog";
import { zh } from "../src/i18n/locales/zh";

type AnyWin = Record<string, unknown>;

/**
 * A **desktop demo host**: `telephony_dial` succeeds with a fixed id (so the dial path
 * runs through `recordOutgoing`), while the real platform path reports it is unavailable.
 * Identical in spirit to `phone-outgoing.svelte.test.ts`'s `installBridge`.
 */
function installBridge(): void {
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "telephony_dial") return { id: "out-1", state: "Dialing" };
      if (cmd === "telephony_backend_kind") return { kind: "mock", detail: "", real: false };
      if (cmd === "telephony_real_dial_status") {
        return { on_device: false, available: false, reason: "desktop" };
      }
      return null;
    },
    listen: async () => () => {},
  };
}

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return a
 * restore function. (`window.localStorage` is a per-access proxy, so the prototype cannot
 * be patched — the window property itself is replaced.) Same helper as the ContactsApp
 * refusal test.
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

const settle = () => new Promise((r) => setTimeout(r, 20));
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const key = (h: { container: HTMLElement }, aria: string) =>
  h.container.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;
const notifs = () => readStoreValue<unknown[]>("amos.notifications", []);
const callLog = () => readStoreValue<unknown[]>(CALLLOG_KEY, []);

/** Key in a number and press call (the dialer's own gesture). */
async function dial(h: { container: HTMLElement }, number: string): Promise<void> {
  for (const d of number) await fireEvent.click(key(h, d)!);
  await fireEvent.click(key(h, zh["phone.call"]) as HTMLButtonElement);
  await tick();
  await settle();
}

afterEach(() => {
  delete (window as AnyWin).__TAURI_INTERNALS__;
  window.localStorage.removeItem("amos.notifications");
  window.localStorage.removeItem(CALLLOG_KEY);
  vi.restoreAllMocks();
});

describe("REQ-A1948 — 拨号时被拒的通知写入要被报出来", () => {
  test("通知写被拒：调用记录落地了，但通知没落下，且页面说出口", async () => {
    installBridge();
    const restore = failWritesFor("amos.notifications");
    try {
      const host = render(PhoneApp);
      await settle();
      await dial(host, "13800000000");

      // The call itself was recorded — its own (checked) write landed.
      expect(callLog().length, "调用记录那一趟应当落地").toBeGreaterThan(0);
      // …but the notification did not, and the page must say so rather than staying silent.
      await vi.waitFor(() => expect(txt(host)).toContain(zh["common.storeWriteFailed"]));
      expect(notifs(), "通知被拒写了，就不该有通知落地").toEqual([]);
    } finally {
      restore();
    }
  });

  test("存储正常时照旧落地 —— 修法不许把正常路径判红", async () => {
    installBridge();
    const host = render(PhoneApp);
    await settle();
    await dial(host, "13800000000");

    expect(callLog().length).toBeGreaterThan(0);
    expect(notifs().length, "一次成功的拨号必须真的留下一行通知").toBe(1);
    expect(txt(host), "存储正常就不该报写入失败").not.toContain(zh["common.storeWriteFailed"]);
  });
});
