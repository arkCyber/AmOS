/**
 * DOM tests for the Svelte 5 mail screen (MailApp.svelte).
 *
 * The mail domain is a pure bridge to the amos-mail daemon (lib/backend.ts,
 * shared with the React UI). Here we exercise the Svelte wiring on top of that
 * bridge: the offline (no-bridge) path, loading an INBOX through a fake bridge,
 * opening a message in the reader, and compose requiring a recipient.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import MailApp from "../src/svelte/MailApp.svelte";
import type { MailMessage, MailSummary } from "../src/lib/backend";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByPlaceholder = (h: { container: HTMLElement }, ph: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === ph) as
    HTMLInputElement | undefined;
const settle = () => new Promise((r) => setTimeout(r, 40));

type MailboxMap = Map<string, MailSummary[]>;
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
const bodies: Record<string, { body_plain: string }> = {
  m1: { body_plain: "Please review the mock engine." },
  m2: { body_plain: "Shipping the email client today." },
};

/** Install a fake __TAURI_INTERNALS__ bridge backed by `store` (mirrors the React test). */
function installBridge(store: MailboxMap) {
  const find = (mb: string, id: string) => store.get(mb)?.find((m) => m.id === id);
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    const mb = String(args?.mailbox ?? "INBOX");
    const id = String(args?.id ?? "");
    if (cmd === "mail_mailboxes") {
      return ["INBOX", "Sent"].filter((n) => store.has(n));
    }
    if (cmd === "mail_list") {
      return store.get(mb) ? [...(store.get(mb) as MailSummary[])] : [];
    }
    if (cmd === "mail_read") {
      const row = find(mb, id);
      if (!row) return null;
      row.flags = { ...row.flags, seen: true };
      const full: MailMessage = {
        summary: { ...row },
        body_plain: bodies[id]?.body_plain ?? "",
        body_html: null,
        attachments: [],
      };
      return full;
    }
    if (cmd === "mail_send") return { id: "s1", date: 1_700_020_000 };
    if (cmd === "mail_set_flagged") {
      const row = find(mb, id);
      if (row) row.flags.flagged = Boolean(args?.flagged);
      return null;
    }
    if (cmd === "mail_set_seen") {
      const row = find(mb, id);
      if (row) row.flags.seen = Boolean(args?.seen);
      return null;
    }
    if (cmd === "mail_move") {
      const target = String(args?.target ?? "");
      const src = store.get(mb);
      const i = src ? src.findIndex((m) => m.id === id) : -1;
      if (src && i >= 0) {
        const [moved] = src.splice(i, 1);
        if (!store.has(target)) store.set(target, []);
        (store.get(target) as MailSummary[]).unshift(moved);
      }
      return null;
    }
    if (cmd === "mail_delete") {
      const src = store.get(mb);
      if (src) {
        const i = src.findIndex((m) => m.id === id);
        if (i >= 0) src.splice(i, 1);
      }
      return null;
    }
    if (cmd === "mail_search") {
      const term = String(args?.query ?? "").toLowerCase();
      return (store.get(mb) ?? []).filter(
        (m) =>
          m.subject.toLowerCase().includes(term) ||
          (m.from ? `${m.from.name} ${m.from.email}`.toLowerCase().includes(term) : false),
      );
    }
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

describe("MailApp.svelte", () => {
  test("offline (no bridge) shows the banner and compose validates a recipient", async () => {
    const host = render(MailApp);
    await settle();
    expect(txt(host)).toContain("未连接邮件服务");
    // Compose with no recipient surfaces the validation error (no bridge send).
    await fireEvent.click(buttonContaining(host, "写邮件") as HTMLButtonElement);
    await fireEvent.click(buttonContaining(host, "发送") as HTMLButtonElement);
    expect(txt(host)).toContain("请填写至少一个收件人");
  });

  test("bridged INBOX lists messages and mirrors unread as dock notifications", async () => {
    installBridge(seedStore());
    const host = render(MailApp);
    await settle();
    await settle();
    expect(txt(host)).toContain("Design review");
    expect(txt(host)).toContain("Build report");
    // Unread INBOX mail became app notifications for the dock badge.
    const notifs = JSON.parse(window.localStorage.getItem("amos.notifications") ?? "[]") as {
      app?: string;
    }[];
    expect(notifs.some((n) => n.app === "邮件")).toBe(true);
  });

  test("opening a message shows its body in the reader", async () => {
    installBridge(seedStore());
    const host = render(MailApp);
    await settle();
    await settle();
    const row = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Design review"),
    );
    expect(row).toBeTruthy();
    await fireEvent.click(row as HTMLButtonElement);
    await settle();
    expect(txt(host)).toContain("Please review the mock engine.");
    expect(txt(host)).toContain("发件人: Ada");
  });
});
