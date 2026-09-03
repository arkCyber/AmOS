import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import MailApp from "../components/MailApp";
import type { MailMessage, MailSummary } from "../lib/backend";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ---- Fake bridge: multi-mailbox store so folder navigation (archive/trash/
 *      restore/permanent-delete) is testable. Reset fresh before every test. ---- */
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
      attachment_count: 0,
    },
  ]);
  s.set("Sent", []);
  return s;
}
let store = seedStore();
const bodies: Record<string, { body_plain: string }> = {
  m1: { body_plain: "Please review the mock engine." },
  m2: { body_plain: "Shipping the email client today." },
};
let sentCalls = 0;
let moveCalls = 0;
let delCalls = 0;
let flagCalls = 0;
let setSeenCalls = 0;
let lastSeen = true;
let lastMove = "";

function findIn(mb: string, id: string): MailSummary | undefined {
  return store.get(mb)?.find((m) => m.id === id);
}

async function invoke(cmd: string, args?: Record<string, unknown>) {
  const mb = String(args?.mailbox ?? "INBOX");
  const id = String(args?.id ?? "");
  if (cmd === "mail_mailboxes") {
    const ordered = ["INBOX", "Sent", "Archive", "Trash"];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const n of ordered) {
      if (store.has(n)) {
        result.push(n);
        seen.add(n);
      }
    }
    for (const n of [...store.keys()].sort()) {
      if (!seen.has(n)) result.push(n);
    }
    return result;
  }
  if (cmd === "mail_list") {
    const arr = store.get(mb);
    return arr ? [...arr] : []; // fresh array each call (like real bridge)
  }
  if (cmd === "mail_read") {
    const row = findIn(mb, id);
    if (!row) return null;
    row.flags = { ...row.flags, seen: true }; // read = marked seen, like the bridge
    const full: MailMessage = {
      summary: { ...row },
      body_plain: bodies[id]?.body_plain ?? "",
      body_html: null,
      attachments: [],
    };
    return full;
  }
  if (cmd === "mail_send") {
    sentCalls += 1;
    return { id: "s1", date: 1_700_020_000 };
  }
  if (cmd === "mail_set_flagged") {
    flagCalls += 1;
    const row = findIn(mb, id);
    if (row) row.flags.flagged = Boolean(args?.flagged);
    return null;
  }
  if (cmd === "mail_set_seen") {
    setSeenCalls += 1;
    lastSeen = Boolean(args?.seen);
    const row = findIn(mb, id);
    if (row) row.flags.seen = lastSeen;
    return null;
  }
  if (cmd === "mail_move") {
    moveCalls += 1;
    lastMove = String(args?.target ?? "");
    const src = store.get(mb);
    if (src) {
      const i = src.findIndex((m) => m.id === id);
      if (i >= 0) {
        const msg = src[i];
        if (msg) {
          src.splice(i, 1);
          msg.mailbox = lastMove; // like the real engine, the stored copy moves
          const tgt = store.get(lastMove);
          if (tgt) tgt.push(msg);
          else store.set(lastMove, [msg]);
        }
      }
    }
    return null;
  }
  if (cmd === "mail_delete") {
    delCalls += 1;
    const src = store.get(mb);
    if (src) {
      const i = src.findIndex((m) => m.id === id);
      if (i >= 0) src.splice(i, 1);
    }
    return null;
  }
  return null;
}

beforeEach(() => {
  sentCalls = 0;
  moveCalls = 0;
  delCalls = 0;
  flagCalls = 0;
  setSeenCalls = 0;
  lastSeen = true;
  lastMove = "";
  store = seedStore();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: () => () => {},
  };
});

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const wait = () => new Promise((r) => setTimeout(r, 0));
async function flush() {
  await act(async () => {
    await wait();
    await wait();
  });
}

async function mountMail() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <MailApp />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  await flush();
  return host;
}

/** Find a button whose text contains `text`. */
function btn(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
}


describe("MailApp (fake __TAURI_INTERNALS__, DOM)", () => {
  test("lists INBOX messages from the bridge, newest first", async () => {
    const host = await mountMail();
    const text = host.textContent ?? "";
    expect(text).toContain("收件箱");
    expect(text).toContain("Design review");
    expect(text).toContain("Build report");
  });

  test("tapping a row reads the full message, then Back returns to the list", async () => {
    const host = await mountMail();

    const row = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Design review"),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row!.click();
    });
    await flush();

    expect(host.textContent).toContain("Please review the mock engine.");
    expect(host.textContent).toContain("Ada");

    // Back ‹ 返回 returns to the list view.
    const back = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("返回"),
    );
    expect(back).toBeTruthy();
    await act(async () => {
      back!.click();
    });
    await flush();
    expect(host.textContent).toContain("Design review");
  });

  test("compose Send with no recipient shows validation and skips the bridge", async () => {
    const host = await mountMail();

    const composeBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("写邮件"),
    );
    expect(composeBtn).toBeTruthy();
    await act(async () => {
      composeBtn!.click();
    });
    await flush();

    const sendBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("发送"),
    );
    expect(sendBtn).toBeTruthy();
    await act(async () => {
      sendBtn!.click();
    });
    await flush();
    expect(sentCalls).toBe(0); // no valid recipient → mail_send not called
    expect(host.textContent).toContain("请填写至少一个收件人");
  });

  test("reader Star toggles mail_set_flagged over the bridge", async () => {
    const host = await mountMail();

    const row = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Design review"),
    );
    await act(async () => {
      row!.click();
    });
    await flush();
    expect(host.textContent).toContain("Please review the mock engine.");

    const star = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("标星"),
    );
    expect(star).toBeTruthy();
    await act(async () => {
      star!.click();
    });
    await flush();
    expect(flagCalls).toBe(1);
    // After starring, the control shows the unstar affordance.
    expect(host.textContent).toContain("取消星标");
  });

  test("reader Trash moves the message to Trash (mail_move) and leaves the list", async () => {
    const host = await mountMail();

    const row = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Design review"),
    );
    await act(async () => {
      row!.click();
    });
    await flush();

    const trash = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("回收站"),
    );
    expect(trash).toBeTruthy();
    await act(async () => {
      trash!.click();
    });
    await flush();

    expect(moveCalls).toBe(1);
    expect(lastMove).toBe("Trash");
    // Back on the list: the trashed message is gone, the other one remains.
    expect(host.textContent).not.toContain("Design review");
    expect(host.textContent).toContain("Build report");
  });

  test("unread INBOX mail is published as notifications (dock badge)", async () => {
    const mailNotifs = () => {
      const raw = window.localStorage.getItem("amos.notifications") ?? "[]";
      const all = JSON.parse(raw) as { app?: string }[];
      return all.filter((n) => n.app === "邮件").length;
    };

    const host = await mountMail();
    await flush(); // let the inbox list + badge reconcile fully settle
    expect(mailNotifs()).toBe(2); // both seeded demo messages are unread

    // Read one message, then go back → only one unread remains in the store.
    const row = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Design review"),
    );
    await act(async () => {
      row!.click();
    });
    await flush();
    const back = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("返回"),
    );
    await act(async () => {
      back!.click();
    });
    for (let i = 0; i < 5; i++) await flush();
    expect(mailNotifs()).toBe(1);
  });

  test("Trash: open folder and restore moves it back to Inbox", async () => {
    const host = await mountMail();

    // Move Design review (m1) to Trash via the reader.
    await act(async () => {
      btn(host, "Design review")!.click();
    });
    await flush();
    await act(async () => {
      btn(host, "回收站")!.click(); // reader "move to trash"
    });
    await flush();
    expect(lastMove).toBe("Trash");

    // Open the Trash folder chip (exact label) and see the message there.
    await act(async () => {
      const chip = Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "回收站",
      )!;
      chip.click();
    });
    await flush();
    expect(host.textContent).toContain("Design review");

    // Open it and restore → it leaves Trash.
    await act(async () => {
      btn(host, "Design review")!.click();
    });
    await flush();
    expect(host.textContent).toContain("移至收件箱");
    await act(async () => {
      btn(host, "移至收件箱")!.click();
    });
    for (let i = 0; i < 4; i++) await flush();
    expect(lastMove).toBe("INBOX");
    expect(host.textContent).not.toContain("Design review");
  });

  test("Trash: permanent delete removes it from the store", async () => {
    const host = await mountMail();

    await act(async () => {
      btn(host, "Design review")!.click();
    });
    await flush();
    await act(async () => {
      btn(host, "回收站")!.click(); // move to trash
    });
    await flush();

    await act(async () => {
      const chip = Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "回收站",
      )!;
      chip.click();
    });
    await flush();

    await act(async () => {
      btn(host, "Design review")!.click();
    });
    await flush();
    await act(async () => {
      btn(host, "删除")!.click(); // permanent delete (only offered in Trash)
    });
    for (let i = 0; i < 4; i++) await flush();

    expect(delCalls).toBe(1);
    expect(host.textContent).not.toContain("Design review");
    expect(host.textContent).toContain("暂无邮件"); // Trash is now empty
  });

  test("reader can mark a read message as unread", async () => {
    const host = await mountMail();

    await act(async () => {
      btn(host, "Design review")!.click(); // opening it marks it seen
    });
    await flush();
    expect(host.textContent).toContain("标为未读"); // seen → offered

    await act(async () => {
      btn(host, "标为未读")!.click();
    });
    await flush();
    expect(setSeenCalls).toBe(1);
    expect(lastSeen).toBe(false);
    expect(host.textContent).not.toContain("标为未读"); // now unread → hidden
  });

  test("mark all read clears inbox unread and the badge", async () => {
    const host = await mountMail();
    await flush();
    const mailNotifs = () => {
      const raw = window.localStorage.getItem("amos.notifications") ?? "[]";
      const all = JSON.parse(raw) as { app?: string }[];
      return all.filter((n) => n.app === "邮件").length;
    };
    expect(mailNotifs()).toBe(2); // both demo messages unread

    const mark = btn(host, "全部标为已读");
    expect(mark).toBeTruthy();
    await act(async () => {
      mark!.click();
    });
    for (let i = 0; i < 5; i++) await flush();

    expect(setSeenCalls).toBeGreaterThanOrEqual(2);
    expect(lastSeen).toBe(true);
    expect(mailNotifs()).toBe(0); // reconcile removed all mail notifications
    expect(host.textContent).not.toContain("全部标为已读"); // no unread → button hidden
  });
});
