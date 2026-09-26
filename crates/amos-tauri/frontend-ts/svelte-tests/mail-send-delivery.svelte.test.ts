/**
 * mail-send-delivery.svelte.test.ts — REQ-A1622 / F-SH-824 —
 * 「邮件生产环境是离线 mock，界面却把一份只存进本地「已发送」的回执印成『已发送』」。
 *
 * `SendReceipt` 过去只有 `{id, date}`：一个 id 既代表「SMTP 中继收下了」，也代表「mock 把它
 * 抄进了 Sent」，屏幕无法分辨，于是把后者也说成投递成功。真实的两态是 **delivered ∕ stored
 * only**：只有真有一条线（SMTP 中继回了 Ok）才算投递；离线 mock 只入档。本文件盯住屏幕上的
 * 两半 —— 默认的 mock 必须在**写信之前**就把「演示模式、不会投递」说出来，并且发送后的回执
 * 用**它自己的句子**（「未投递」），而不是 green 的「已发送，编号 …」；正控是一个真投递的后端，
 * 它必须照说「已发送」。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MailApp from "../src/svelte/MailApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import type { MailSummary } from "../src/lib/backend";

/** A backend bridge with one knob: what `mail_status` / `mail_send` answer. */
function installHost(status: { provider: string; delivers: boolean }, sendDelivered: boolean) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "mail_status") return status;
      if (cmd === "mail_mailboxes") return ["INBOX", "Sent"];
      if (cmd === "mail_list") return [] as MailSummary[];
      if (cmd === "mail_send")
        return { id: "s1", date: 1_700_020_000, delivered: sendDelivered };
      return null;
    },
    listen: async () => () => {},
  };
}

const settle = async () => {
  await new Promise<void>((r) => setTimeout(r, 20));
  await tick();
  await new Promise<void>((r) => setTimeout(r, 20));
  await tick();
};
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const byTestId = (h: { container: HTMLElement }, id: string) =>
  h.container.querySelector(`[data-testid="${id}"]`);
const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    | HTMLButtonElement
    | undefined;
const inputByPlaceholder = (h: { container: HTMLElement }, ph: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === ph) as
    | HTMLInputElement
    | undefined;

/** Render, open the composer, fill a recipient and send. */
async function composeAndSend(
  status: { provider: string; delivers: boolean },
  sendDelivered: boolean,
) {
  installHost(status, sendDelivered);
  const host = render(MailApp);
  await settle();
  await fireEvent.click(buttonContaining(host, "写邮件")!);
  await settle();
  const to = inputByPlaceholder(host, "收件人（用逗号分隔）")!;
  await fireEvent.input(to, { target: { value: "them@x.io" } });
  await fireEvent.click(buttonContaining(host, "发送")!);
  await settle();
  return host;
}

beforeEach(() => setLocale("zh"));
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterEach(() => setLocale("zh"));

describe("MailApp — 一份只入档的回执不是「已发送」", () => {
  test("离线 mock：写信时就把「演示模式、不会投递」说出来（发送之前）", async () => {
    installHost({ provider: "mock", delivers: false }, false);
    const host = render(MailApp);
    await settle();
    await fireEvent.click(buttonContaining(host, "写邮件")!);
    await settle();
    const banner = byTestId(host, "mail-demo-mode");
    expect(banner).not.toBeNull();
    expect(banner?.textContent ?? "").toContain("演示模式");
    expect(banner?.textContent ?? "").toContain("不会真正投递");
  });

  test("离线 mock：回执说「未投递」，绝不说「已发送，编号 …」", async () => {
    const host = await composeAndSend({ provider: "mock", delivers: false }, false);
    const note = byTestId(host, "mail-sent-note");
    expect(note).not.toBeNull();
    expect(note?.textContent ?? "").toContain("未投递");
    // `mail.sentOk` 的措辞是「已发送，编号 {id}」—— 「已发送」单独出现是允许的
    // （模板里「演示模式…存入『已发送』」那句也有），但**这一句**不能出现。
    expect(txt(host)).not.toContain("已发送，编号");
  });

  test("真投递的后端：没有演示横幅，回执照说「已发送，编号 …」", async () => {
    installHost({ provider: "imap+smtp", delivers: true }, true);
    const host = render(MailApp);
    await settle();
    await fireEvent.click(buttonContaining(host, "写邮件")!);
    await settle();
    // 横幅只在「没有线」时出现 —— 否则「一律说演示模式」也能让上面两条通过。
    expect(byTestId(host, "mail-demo-mode")).toBeNull();

    const to = inputByPlaceholder(host, "收件人（用逗号分隔）")!;
    await fireEvent.input(to, { target: { value: "them@x.io" } });
    await fireEvent.click(buttonContaining(host, "发送")!);
    await settle();
    const note = byTestId(host, "mail-sent-note");
    expect(note?.textContent ?? "").toContain("已发送，编号 s1");
    expect(note?.textContent ?? "").not.toContain("未投递");
  });
});
