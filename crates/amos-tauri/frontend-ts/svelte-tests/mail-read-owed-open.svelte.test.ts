/**
 * mail-read-owed-open.svelte.test.ts — REQ-A1512 ∕ F-SH-757 —
 * 「被前景规则拒绝的那句话**许了一个愿**，而第二次调用它的地方把愿吞了」。
 *
 * `refusalOf` 返回的是一对 `{ text, owed }`，`owed` 就是那个许诺：`mail.readRefused`
 * =「未读取：这个窗口不是用户正在看的那个 —— **回到这个窗口时会补上这次读取**」。
 * `refresh`（`mail_list`）把 `owed` 记进 `readOwed`，聚焦时补上；后来加进来的第二个调用点
 * `openMessage`（`mail_read`）只取了 `.text`，把 `owed` 丢掉 —— 于是那句话照样画出来，
 * 而**没有任何东西会补上这次读**：用户切走再切回来，他点的那封信仍然打不开，屏幕上却
 * 站着「回来时会补上」。许诺的兑现者只在两个调用点中的一个。
 *
 * 这一轮把 `owed` 在 `openMessage` 也消费掉：回到前台时**重开这封信**（`openMessage`
 * 带着刚才那一行再跑一次），兑现那句话说的正是「这次读取」。宿主**按错误的码**分开处理：
 * 只有 `amos.mail.foreground_required` 才是欠读，引擎拒绝不是（对照组）。
 *
 * 从组件之外派发 `window` 的 focus（真实用户切回窗口时浏览器做的事），并数宿主被问了
 * 几次 —— 既有套件看不到这个缺陷，因为那里的 `mail_read` 从不失败。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import MailApp from "../src/svelte/MailApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import type { MailMessage, MailSummary } from "../src/lib/backend";
import { zh } from "../src/i18n/locales/zh";

const FOREGROUND_CODE = "amos.mail.foreground_required";
const BODY = "Please review the mock engine.";

const row: MailSummary = {
  id: "m1",
  mailbox: "INBOX",
  from: { name: "Ada", email: "ada@x.io" },
  to: [],
  subject: "Design review",
  date: 1_700_000_000,
  flags: { seen: false, flagged: false, answered: false },
  attachment_count: 0,
};

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const focus = () => window.dispatchEvent(new Event("focus"));
const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    | HTMLButtonElement
    | undefined;

/**
 * A bridge whose `mail_list` always lands and whose `mail_read` fails until `allowReads()`.
 * It fails the way the host fails: the command **rejects**, `invoke` folds that into `null`
 * and keeps the payload in `bridgeDiag("mail_read").detail`, which is where the caller reads
 * *which* refusal it was. `refusal` is what the host sends.
 */
function installHost(refusal: { code?: string; message?: string }) {
  const calls: string[] = [];
  let allow = false;
  const invoke = async (cmd: string) => {
    calls.push(cmd);
    if (cmd === "mail_mailboxes") return ["INBOX"];
    if (cmd === "mail_list") return [row];
    if (cmd === "mail_read") {
      if (!allow) throw refusal;
      const full: MailMessage = {
        summary: { ...row, flags: { ...row.flags, seen: true } },
        body_plain: BODY,
        body_html: null,
        attachments: [],
      };
      return full;
    }
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
  return {
    reads: () => calls.filter((c) => c === "mail_read").length,
    allowReads: () => {
      allow = true;
    },
  };
}

beforeEach(() => setLocale("zh"));
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("MailApp — 被拒的那句话许了愿，就得有人兑现", () => {
  test("前景拒绝：回来时重开这封信，兑现「会补上这次读取」", async () => {
    const host = installHost({
      code: FOREGROUND_CODE,
      message: "[amos.mail.foreground_required] mail read refused: 'mail' is not the foreground window",
    });
    const view = render(MailApp);
    await vi.waitFor(() => expect(txt(view)).toContain("Design review"));

    fireEvent.click(buttonContaining(view, "Design review") as HTMLButtonElement);
    await vi.waitFor(() => expect(txt(view)).toContain(zh["mail.readRefused"]));

    // The reader is exactly the region that never opened — the sentence stands in the list.
    expect(txt(view)).not.toContain(BODY);
    expect(host.reads()).toBe(1);

    // Coming back is the moment the owed *message* read is paid.
    host.allowReads();
    focus();
    await vi.waitFor(() => expect(txt(view)).toContain(BODY));
    expect(host.reads()).toBeGreaterThan(1);
    expect(txt(view)).not.toContain(zh["mail.readRefused"]);
  });

  test("对照组 — 引擎拒绝：不欠这一次读，聚焦不会重开", async () => {
    const host = installHost({ message: "mail engine: mailbox unavailable" });
    const view = render(MailApp);
    await vi.waitFor(() => expect(txt(view)).toContain("Design review"));

    fireEvent.click(buttonContaining(view, "Design review") as HTMLButtonElement);
    await vi.waitFor(() => expect(txt(view)).toContain(zh["mail.readFailed"]));
    expect(host.reads()).toBe(1);

    // `owed` is false for an engine refusal: there is nothing to make up, so the window
    // regaining focus must not re-issue the read (and the message must not appear).
    focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(host.reads()).toBe(1);
    expect(txt(view)).not.toContain(BODY);
  });
});
