/**
 * mail-foreground-read.svelte.test.ts — REQ-A1396 / F-SH-655 —
 * 「读信箱是前景窗口才有的权利，而这一屏从前把**被拒**画成**离线**」。
 *
 * 宿主侧的四条读取（`mail_list` ∕ `mail_search` ∕ `mail_read` ∕ `mail_inbox`）现在都走
 * `require_mail_foreground`（与 `clipboard_read`、短信读取、录音开关同一条规则）；
 * 而 `refresh` 从前把 `mail_list` 的 `null` 一律画成 `mail.offline` —— 那是对**邮箱**的
 * 一条断言，而被拒根本不是邮箱的事：这一屏自己的读都在自己窗口里发生，只有「发出之后、
 * 宿主执行之前换走了焦点」才会落地为拒（`invoke` 是异步的）。所以这一轮把三种 `null`
 * 分开：没有桥 → 离线；宿主答 `amos.mail.foreground_required` → 「未读取，回来时补上」
 * 并记一笔欠读；引擎拒绝 → 「服务拒绝了这次读取」，不重试。
 *
 * 从**组件之外**派发 `window` 的 focus（真实用户在窗口之间切回来时浏览器做的事），
 * 然后数宿主被问了几次 —— 既有套件看不到这个缺陷，因为那些用例都跑在「窗口一直有焦点」
 * 的世界里，那里的 `null` 只可能来自没有桥。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import MailApp from "../src/svelte/MailApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import type { MailSummary } from "../src/lib/backend";
import { zh } from "../src/i18n/locales/zh";

const FOREGROUND_CODE = "amos.mail.foreground_required";

const inbox: MailSummary[] = [
  {
    id: "m1",
    mailbox: "INBOX",
    from: { name: "Ada", email: "ada@x.io" },
    to: [],
    subject: "Design review",
    date: 1_700_000_000,
    flags: { seen: true, flagged: false, answered: false },
    attachment_count: 0,
  },
  {
    id: "m2",
    mailbox: "INBOX",
    from: { name: "Grace", email: "grace@x.io" },
    to: [],
    subject: "Build report",
    date: 1_700_010_000,
    flags: { seen: true, flagged: false, answered: false },
    attachment_count: 0,
  },
];

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const focus = () => window.dispatchEvent(new Event("focus"));

/**
 * A device bridge whose `mail_list` fails until `allowReads()` — and it fails the way the host
 * fails: the command **rejects**, `invoke` folds that into `null` and keeps the payload in
 * `bridgeDiag("mail_list").detail`, which is where the caller reads *which* refusal it was.
 * `refusal` is what the host sends: the typed mail envelope, or a plain engine error.
 */
function installHost(refusal: { code?: string; message?: string }) {
  const calls: string[] = [];
  let allow = false;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "mail_list") {
        if (!allow) throw refusal;
        return inbox;
      }
      if (cmd === "mail_mailboxes") return ["INBOX", "Sent"];
      return null;
    },
    listen: async () => () => {},
  };
  return {
    reads: () => calls.filter((c) => c === "mail_list").length,
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

describe("MailApp — 读信箱要用户正在看着这个窗口", () => {
  test("被前景规则拒绝：不画成离线，回到这个窗口时补上这次读", async () => {
    const host = installHost({
      code: FOREGROUND_CODE,
      message: "[amos.mail.foreground_required] mail read refused: 'mail' is not the foreground window",
    });
    const view = render(MailApp);
    await vi.waitFor(() => expect(txt(view)).toContain(zh["mail.readRefused"]));

    // Not a claim about the account: "offline" would be a fact about the mail service, and the
    // service answered — it refused *this window*.
    expect(txt(view)).not.toContain(zh["mail.offline"]);
    expect(txt(view)).not.toContain("Design review");

    // Coming back is the moment the owed read is paid.
    const before = host.reads();
    host.allowReads();
    focus();
    await vi.waitFor(() => expect(txt(view)).toContain("Design review"));
    expect(host.reads()).toBeGreaterThan(before);
    expect(txt(view)).not.toContain(zh["mail.readRefused"]);
  });

  test("引擎拒绝：说服务拒绝了这次读，且不去重试（那不是欠读）", async () => {
    const host = installHost({ message: "mail engine: mailbox unavailable" });
    const view = render(MailApp);
    await vi.waitFor(() => expect(txt(view)).toContain(zh["mail.readFailed"]));

    const before = host.reads();
    focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(host.reads()).toBe(before);
    expect(txt(view)).toContain(zh["mail.readFailed"]);
  });

  test("没有桥：照旧是离线那一句，聚焦不会把它变成一次读", async () => {
    const view = render(MailApp);
    await vi.waitFor(() => expect(txt(view)).toContain(zh["mail.offline"]));
    expect(txt(view)).not.toContain(zh["mail.readRefused"]);

    // No bridge at all: there is nothing to re-read, and nothing was owed.
    focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(txt(view)).toContain(zh["mail.offline"]);
  });
});
