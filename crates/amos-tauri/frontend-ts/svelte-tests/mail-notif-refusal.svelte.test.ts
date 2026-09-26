/**
 * mail-notif-refusal.svelte.test.ts — 邮件镜像进通知 store 的那次写被拒时必须说出口，
 * 不能静默吞掉（REQ-A1954 / FMEA F-SH-947）。
 *
 * `MailApp.svelte` 的发布 `$effect` 把未读 INBOX 镜像成 App 通知，写 `NOTIF_KEY`
 * （`amos.notifications`）供 Dock ∕ 启动器徽标使用。它以前逐字
 * `writeStoreValue(NOTIF_KEY, replaceAppNotifs(...))` —— `writeStoreValue` 是 `void`，
 * 判决被**扔掉**。存储满 ∕ 不可用（`setItem` 抛 `QuotaExceededError`）时，徽标停留在
 * 旧的未读计数上，页面上却什么也不说。
 *
 * 本文件是**同一个产物里缺席的那一条**：同一个文件对 `mail_set_seen` 等写都走判定读回
 * （`listNote`），其它通知生产者（`osPushWatcher.ts` ∕ `osTimerWatcher.ts` ∕
 * `reminderCore.ts` ∕ `calendarCore.ts` ∕ `shortcuts.ts` ∕ `PhoneApp` ∕ `ContactsApp`）
 * 也全都消费判决；只有这两个 App 的镜像写是 `void`。姊妹用例
 * `phone-dial-notif-refusal.svelte.test.ts`（REQ-A1948）逐字点名过它们。
 *
 * 判据：拒写后页面上要出现 `t("common.storeWriteFailed")`（本机存储写入失败），且通知
 * 确实没落地。第二条用例是**反向守卫** —— 存储正常时必须照旧落地，修法不许把正常路径判红。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import MailApp from "../src/svelte/MailApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import type { MailSummary } from "../src/lib/backend";
import { zh } from "../src/i18n/locales/zh";

const settle = () => new Promise((r) => setTimeout(r, 40));
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const notifs = () => readStoreValue<{ app?: string }[]>("amos.notifications", []);

type MailboxMap = Map<string, MailSummary[]>;
/** INBOX with two unread messages — the shape the mirror publishes. */
function seedStore(): MailboxMap {
  const s: MailboxMap = new Map();
  s.set("INBOX", [
    {
      id: "m1",
      mailbox: "INBOX",
      from: { name: "Ada", email: "ada@x.io" },
      to: [],
      subject: "Design review",
      date: 1_700_000_000,
      flags: { seen: false, flagged: false, answered: false },
      attachment_count: 0,
    },
    {
      id: "m2",
      mailbox: "INBOX",
      from: { name: "Grace", email: "grace@x.io" },
      to: [],
      subject: "Build report",
      date: 1_700_010_000,
      flags: { seen: false, flagged: false, answered: false },
      attachment_count: 1,
    },
  ]);
  s.set("Sent", []);
  return s;
}

/** The same fake bridge as `mail.svelte.test.ts` (only the read paths the mirror needs). */
function installBridge(store: MailboxMap): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "mail_mailboxes") return ["INBOX", "Sent"];
      if (cmd === "mail_list") return [...(store.get("INBOX") ?? [])];
      if (cmd === "mail_status") return { provider: "mock", delivers: false };
      return null;
    },
    listen: async () => () => {},
  };
}

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return a
 * restore function. Same helper as the PhoneApp ∕ ContactsApp refusal tests.
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

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.removeItem("amos.notifications");
  vi.restoreAllMocks();
});

describe("REQ-A1954 — 邮件镜像通知被拒写要被报出来", () => {
  test("通知写被拒：徽标没更新，页面说出口", async () => {
    const restore = failWritesFor("amos.notifications");
    try {
      installBridge(seedStore());
      const host = render(MailApp);
      await settle();
      await settle();

      // The mailbox itself was read fine — the listing is on screen.
      expect(txt(host)).toContain("Design review");
      // …but the mirror never landed, and the page must say so rather than staying silent.
      await vi.waitFor(() => expect(txt(host)).toContain(zh["common.storeWriteFailed"]));
      expect(notifs(), "通知被拒写了，就不该有通知落地").toEqual([]);
    } finally {
      restore();
    }
  });

  test("存储正常时照旧落地 —— 修法不许把正常路径判红", async () => {
    installBridge(seedStore());
    const host = render(MailApp);
    await settle();
    await settle();

    expect(notifs().some((n) => n.app === zh["app.mail"]), "未读 INBOX 必须镜像成通知").toBe(true);
    expect(txt(host), "存储正常就不该报写入失败").not.toContain(zh["common.storeWriteFailed"]);
  });
});
