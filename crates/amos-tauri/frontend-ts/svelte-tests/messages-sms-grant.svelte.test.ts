/**
 * messages-sms-grant.svelte.test.ts — REQ-A1577 / F-TEL-037 —
 * 「短信权限从来没有人问过：普通安装下收件箱永远报权限错误，用户在 AmOS 里没有任何补救入口」。
 *
 * 宿主侧的 `SmsGlue` 一直**检查** READ_SMS ∕ SEND_SMS ∕ RECEIVE_SMS，缺一个就回
 * `{"error_kind":"permission"}`；但仓库里没有任何地方**申请**过它们 —— `adb install -g`
 * 会预授予，普通安装不会。于是收件箱永远显示权限错误，而屏幕上那句「请在系统设置中…」
 * 是唯一的说法，哪怕用户根本没有可以点的东西。
 *
 * 本轮补上 JS 可等待的申请缝：这一屏在读取被拒时给出「授予短信权限」按钮，按下后
 * 走 `sms_permission_request`（Kotlin 弹系统对话框 → `onSmsResult` 回填）。
 * **只有** granted 才清错误并重读；timed-out ∕ unreadable ∕ host 各自说各自的话，
 * 绝不折成「用户拒绝了」（那是另一个按钮会误导人的地方）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MessagesApp from "../src/svelte/MessagesApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { CONV_KEY, seedConversations } from "../src/lib/messages";
import { DRAFT_KEY } from "../src/lib/smsDrafts";
import { resetPropsChannels } from "../src/svelte/propsBus";

interface Thread {
  id: string;
  address: string;
  display_name: string;
  last_text: string;
  last_ts_ms: number;
  unread: number;
}

function thread(id: string, name: string, text: string, ts: number): Thread {
  return {
    id,
    address: `1380013800${id}`,
    display_name: name,
    last_text: text,
    last_ts_ms: ts,
    unread: 0,
  };
}

const seeded = thread("1", "小安", "在吗", 1_700_000_000_000);

const DENIED = { native: true, granted: false, state: "denied" as const };
const GRANTED = { native: true, granted: true, state: "granted" as const };
const TIMED_OUT = { native: true, granted: false, state: "timed-out" as const };

/**
 * Install a device bridge whose inbox read is refused for want of the grant. The refusal
 * is thrown in the shape the host **actually** sends — the `AmosError` envelope
 * `{ code, message, cause }`, whose `cause[0]` is the `SmsError` words
 * (`error.rs`'s `SmsProviderRejected` doc; `sms.rs` pins `cause[0] == "permission denied"`).
 * A plain `new Error("… permission denied")` is string-friendly and let REQ-A1756 hide:
 * `String(envelope)` is `"[object Object]"`, so a fixture that throws an `Error` proved a
 * fold no real device performs.
 * `setReadable` flips it to a working inbox, which is what a real grant produces.
 */
function installHost(permissionAnswer: unknown) {
  const calls: string[] = [];
  let readable = false;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "sms_status") return { provider: "android-sms", device: true };
      if (cmd === "sms_snapshot") {
        if (!readable) {
          throw {
            code: "amos.sms.provider_rejected",
            message: "amos.sms.provider_rejected",
            cause: ["SMS permission denied: READ_SMS not granted"],
          };
        }
        return [seeded];
      }
      if (cmd === "sms_messages") return [];
      if (cmd === "sms_counts") return { inbox: readable ? 1 : 0, sent: 0, draft: 0 };
      if (cmd === "sms_permission_request") return permissionAnswer;
      return null;
    },
    listen: async () => () => {},
  };
  return {
    calls,
    requested: () => calls.filter((c) => c === "sms_permission_request").length,
    setReadable: () => {
      readable = true;
    },
  };
}

const settle = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btn = (h: { container: HTMLElement }, id: string) =>
  h.container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
/** How many times `needle` appears in the rendered text (as a *text node* count, not a
 *  substring-of-a-word count — the sentences under test are whole sentences). */
const times = (h: { container: HTMLElement }, needle: string) =>
  txt(h).split(needle).length - 1;

/** The two sentences the *refused read* path prints: the denial, then where to fix it. */
const DENIAL = "短信权限被拒绝";
const SETTINGS_HINT = "请在系统设置中为 AmOS 授予短信权限后重试。";

beforeEach(() => {
  writeStoreValue(CONV_KEY, seedConversations(Date.now()));
  writeStoreValue(DRAFT_KEY, []);
  resetPropsChannels();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  resetPropsChannels();
});

describe("MessagesApp — 短信权限的申请入口", () => {
  test("读取被拒时，屏幕上出现可以按的「授予短信权限」，而不是只有一句叫用户自己去设置", async () => {
    installHost(DENIED);
    const view = render(MessagesApp);
    await settle();

    // The error is stated…
    expect(txt(view)).toContain("短信权限被拒绝");
    // …and there is a thing to press that can fix it from inside AmOS.
    expect(btn(view, "sms-grant")).not.toBeNull();
  });

  test("授予后：按钮消失、发一次申请、收件箱重读并画出会话", async () => {
    const host = installHost(GRANTED);
    const view = render(MessagesApp);
    await settle();
    expect(btn(view, "sms-grant")).not.toBeNull();

    // The OS returns granted → the button does its one job: re-read, and the
    // permission error must not linger over a working inbox.
    host.setReadable();
    await fireEvent.click(btn(view, "sms-grant")!);
    await settle();

    expect(host.requested()).toBe(1);
    expect(btn(view, "sms-grant")).toBeNull();
    expect(txt(view)).toContain("小安");
    expect(txt(view)).not.toContain("短信权限被拒绝");
  });

  test("超时不是「用户拒绝」：说超时那句话，不摆出「请在系统设置中…」的姿态", async () => {
    installHost(TIMED_OUT);
    const view = render(MessagesApp);
    await settle();
    await fireEvent.click(btn(view, "sms-grant")!);
    await settle();

    expect(txt(view)).toContain("尚未收到系统的授权结果");
    // The settings hint is the denial's sentence, and a timeout is not a denial.
    expect(txt(view)).not.toContain("请在系统设置中");
    // No denial ⇒ no grant button: it would re-post the same dialog pointlessly.
    expect(btn(view, "sms-grant")).toBeNull();
  });

  /**
   * REQ-A1752 / F-TEL-043 — the OS's own "no" must land on the *same two sentences* a
   * refused read prints, not print the settings pointer twice.
   *
   * The read path (`refreshReal`'s failure branch) states the denial and *then* adds the
   * hint: `短信权限被拒绝` over `请在系统设置中…`. The grant path handed
   * `smsGrantRefusalKey("denied")` the settings-pointer key, which the component then
   * rendered **again** in its `{#if smsDenied}` hint — so the identical sentence appeared
   * twice, once as the red alert and once as the grey line directly beneath it. Two faces
   * of one event, one answerer disagreeing with the other.
   */
  test("拒绝之后：两句话各说一遍 —— 与「读取被拒」是同样的两句，不是同一句印两次", async () => {
    installHost(DENIED);
    const view = render(MessagesApp);
    await settle();

    // Positive control: the refused *read* already prints the pair exactly once each.
    expect(times(view, DENIAL)).toBe(1);
    expect(times(view, SETTINGS_HINT)).toBe(1);

    await fireEvent.click(btn(view, "sms-grant")!);
    await settle();

    // The read is still refused and the OS answered "denied": unchanged pair, not a
    // second copy of the pointer and a missing denial.
    expect(times(view, DENIAL)).toBe(1);
    expect(times(view, SETTINGS_HINT)).toBe(1);
    // The remedy is still offered (this is a denial — the settings can fix it).
    expect(btn(view, "sms-grant")).not.toBeNull();
  });
});
