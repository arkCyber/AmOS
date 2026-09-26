/**
 * DOM tests for the Svelte 5 mail screen (MailApp.svelte).
 *
 * The mail domain is a pure bridge to the amos-mail daemon (lib/backend.ts,
 * shared with the React UI). Here we exercise the Svelte wiring on top of that
 * bridge: the offline (no-bridge) path, loading an INBOX through a fake bridge,
 * opening a message in the reader, and compose requiring a recipient.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MailApp from "../src/svelte/MailApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import type { MailMessage, MailSummary } from "../src/lib/backend";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => setLocale("zh"));

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

/**
 * Install a fake `__TAURI_INTERNALS__` bridge backed by `store` (mirrors the React test).
 *
 * `fail` names commands the *daemon* refuses: they **throw**, which is what a real
 * Tauri command does on `Err` — and `backend.ts::invoke` then swallows it into the
 * per-command diagnosis and answers `null`, exactly as on a device (REQ-A830).
 */
function installBridge(store: MailboxMap, fail: string[] = []) {
  const find = (mb: string, id: string) => store.get(mb)?.find((m) => m.id === id);
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    const mb = String(args?.mailbox ?? "INBOX");
    const id = String(args?.id ?? "");
    if (fail.includes(cmd)) throw new Error(`${cmd}: the mail store refused`);
    if (cmd === "mail_mailboxes") {
      return ["INBOX", "Sent", "Archive", "Trash"].filter((n) => store.has(n));
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
    if (cmd === "mail_status") return { provider: "mock", delivers: false };
    // The default host is the offline mock, so its receipt says `delivered: false`
    // — the same shape `crates/amos-mail` produces (F-SH-824).
    if (cmd === "mail_send") return { id: "s1", date: 1_700_020_000, delivered: false };
    if (cmd === "mail_set_flagged") {
      const row = find(mb, id);
      if (row) row.flags.flagged = Boolean(args?.flagged);
      return null;
    }
    if (cmd === "mail_set_answered") {
      const row = find(mb, id);
      if (row) row.flags.answered = Boolean(args?.answered);
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
        // The daemon re-homes the summary, not just the array slot: a later
        // `mail_read` is addressed by the row's own `mailbox` field.
        moved.mailbox = target;
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

  test("the notification a bridged INBOX writes follows the live locale (REQ-A1134)", async () => {
    // A notification's `app` is the display name **at push time** (`bgText.ts::bgT`), so an
    // English UI must write "Mail", not the Chinese dictionary's name. The old producer read
    // `zh["app.mail"]` directly, so every mail notification an English user received was
    // signed in Chinese — a surface that follows neither the reactive `t()` nor any scan
    // (`zh[...]` is a dictionary lookup, invisible to the hardcoded-copy scan).
    window.localStorage.clear();
    setLocale("en");
    installBridge(seedStore());
    render(MailApp);
    await settle();
    await settle();

    const notifs = JSON.parse(window.localStorage.getItem("amos.notifications") ?? "[]") as {
      app?: string;
    }[];
    expect(notifs.some((n) => n.app === en["app.mail"])).toBe(true);
    expect(notifs.some((n) => n.app === zh["app.mail"])).toBe(false);
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

  // `t()` is documented as the REACTIVE locale read (`locale.svelte.ts`: "re-renders
  // them the instant setLocale() is called — no remount, no state loss"), and the
  // shell switches locale on a live window. The mailbox chips are drawn through
  // `labelOf()`, which reads a `const labels = {…t(…)}` snapshot taken once when the
  // component's script body ran — so they keep the mount-time language while the
  // rest of the screen re-keys. That is the D-1 family (a value read outside a
  // reactive context never re-derives).
  test("a live locale switch re-keys the mailbox chips too", async () => {
    installBridge(seedStore());
    const host = render(MailApp);
    await settle();
    await settle();
    expect(txt(host)).toContain("收件箱");

    setLocale("en");
    await tick();

    expect(txt(host)).toContain("Inbox");
    expect(txt(host)).not.toContain("收件箱");
    // The rest of the screen was already reactive — so this is a real divergence,
    // not "the whole app ignored the switch".
    expect(txt(host)).toContain("Compose");
  });
});

/**
 * **A flag the store never accepted** (REQ-A830 / F-SH-263).
 *
 * `mail_set_flagged` / `_answered` / `_seen` are `void` commands: `null` on success,
 * and `invoke` answers `null` for a call that *failed* too — it never rejects, it
 * records the reason in the per-command diagnosis. The three reader buttons used to
 * write `opened` from the intent alone, so the star / tick / read state the store
 * never got was drawn as fact while the reader stayed open (and for `markUnread` it
 * also removed the retry button). These tests pin the rule: **the reader may only
 * show a flag the mail service confirmed** — otherwise it shows the store's actual
 * state and says the write did not land.
 */
describe("MailApp.svelte — a flag the store never accepted", () => {
  const openFirst = async (host: { container: HTMLElement }) => {
    const row = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Design review"),
    );
    expect(row).toBeTruthy();
    await fireEvent.click(row as HTMLButtonElement);
    await vi.waitFor(() => expect(txt(host)).toContain("Please review the mock engine."));
  };
  const flagged = (store: MailboxMap, id: string) =>
    store.get("INBOX")!.find((m) => m.id === id)!.flags;
  /**
   * The star button is located by its **glyph**, not by its label: `标星` is not a
   * substring of `取消星标` (the characters are reversed), so a label search finds
   * the button before it is starred and loses it after.
   */
  const starButton = (host: { container: HTMLElement }) =>
    [...host.container.querySelectorAll("button")].find((b) =>
      /^[★☆]/.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
  /** Likewise `已回复` sits *inside* the un-pressed label `标为已回复`. */
  const answeredButton = (host: { container: HTMLElement }) =>
    [...host.container.querySelectorAll("button")].find((b) =>
      /^[↩↪]/.test(b.textContent ?? ""),
    ) as HTMLButtonElement;

  test("a star the store never accepted is not drawn as starred", async () => {
    const store = seedStore();
    installBridge(store, ["mail_set_flagged"]);
    const host = render(MailApp);
    await settle();
    await settle();
    await openFirst(host);

    await fireEvent.click(starButton(host));

    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.flagUnconfirmed"]));
    // The button still reads "☆ Star" — not the "★ Unstar" we merely intended, and
    // which the store never got.
    expect(starButton(host).textContent).toBe(`☆ ${zh["mail.star"]}`);
    expect(flagged(store, "m1").flagged).toBe(false);
  });

  test("a star the store accepts is drawn as starred", async () => {
    const store = seedStore();
    installBridge(store);
    const host = render(MailApp);
    await settle();
    await settle();
    await openFirst(host);

    await fireEvent.click(starButton(host));

    await vi.waitFor(() => expect(starButton(host).textContent).toBe(`★ ${zh["mail.unstar"]}`));
    expect(flagged(store, "m1").flagged).toBe(true);
    // A confirmed write is not an apology.
    expect(txt(host)).not.toContain(zh["mail.flagUnconfirmed"]);
  });

  // The dangerous direction: marking unread is how a message is put back on the
  // user's list. Folding a refused write into "unread" would drop it *and* hide the
  // retry — the `{#if …flags.seen}` button is the only way to notice and fix it.
  test("a mark-unread the store never accepted keeps the read state and the retry", async () => {
    const store = seedStore();
    installBridge(store, ["mail_set_seen"]);
    const host = render(MailApp);
    await settle();
    await settle();
    await openFirst(host); // opening marks it seen in the store

    const unread = buttonContaining(host, zh["mail.markUnread"]);
    expect(unread).toBeTruthy();
    await fireEvent.click(unread!);

    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.flagUnconfirmed"]));
    expect(flagged(store, "m1").seen).toBe(true);
    // The retry is still offered — the button did not disappear on a write that
    // never happened.
    expect(buttonContaining(host, zh["mail.markUnread"])).toBeTruthy();
  });

  test("an answered tick the store never accepted is not drawn as answered", async () => {
    const store = seedStore();
    installBridge(store, ["mail_set_answered"]);
    const host = render(MailApp);
    await settle();
    await settle();
    await openFirst(host);

    await fireEvent.click(answeredButton(host));

    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.flagUnconfirmed"]));
    // Still the un-pressed glyph: `已回复` alone would also match `标为已回复`.
    expect(answeredButton(host).textContent).toBe(`↪ ${zh["mail.markAnswered"]}`);
    expect(flagged(store, "m1").answered).toBe(false);
  });

  // The verdict must come from the *diagnosis*, not from "the command was called":
  // a store that fails on the flag write but answers the verification listing is the
  // exact case the old code could not see.
  test("a refused write is verified against the store, not assumed", async () => {
    const store = seedStore();
    installBridge(store, ["mail_set_flagged"]);
    const host = render(MailApp);
    await settle();
    await settle();
    await openFirst(host);

    await fireEvent.click(starButton(host));
    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.flagUnconfirmed"]));

    // Retrying against a store that now works must land and clear the note.
    installBridge(store);
    await fireEvent.click(starButton(host));
    await vi.waitFor(() => expect(starButton(host).textContent).toBe(`★ ${zh["mail.unstar"]}`));
    expect(txt(host)).not.toContain(zh["mail.flagUnconfirmed"]);
    expect(flagged(store, "m1").flagged).toBe(true);
  });
});

/**
 * **An action that closes the reader** (REQ-A835 / F-SH-265). `mail_move` and
 * `mail_delete` are `void` commands too, and closing the reader is a claim that the
 * message left this mailbox. The old code set `opened = null` unconditionally, so a
 * refused archive dismissed the reader and then `refresh()` put the message straight
 * back in the list the user had just watched it leave — with no explanation.
 */
describe("MailApp.svelte — an action the mail service never confirmed", () => {
  const openFirst = async (host: { container: HTMLElement }) => {
    const row = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Design review"),
    );
    expect(row).toBeTruthy();
    await fireEvent.click(row as HTMLButtonElement);
    await vi.waitFor(() => expect(txt(host)).toContain("Please review the mock engine."));
  };
  const inInbox = (store: MailboxMap) => store.get("INBOX")!.some((m) => m.id === "m1");
  const seen = (store: MailboxMap) =>
    store.get("INBOX")!.filter((m) => m.flags.seen).length;
  /**
   * `deletePermanent` only exists for a message **already in the Trash** (`{#if
   * opened.summary.mailbox === "Trash"}`), because for anything else the destructive
   * action is the move to Trash. So the delete tests start from a seeded Trash.
   */
  const toTrash = (store: MailboxMap) => {
    const [m] = store.get("INBOX")!.splice(0, 1);
    // The row's own `mailbox` field must move too: `openMessage` opens by
    // `m.mailbox`/`m.id`, so a fixture that only re-homes the array makes the reader
    // read from the mailbox the message has left — and the daemon answers `null`.
    m.mailbox = "Trash";
    store.set("Trash", [m]);
    return store;
  };
  const openTrashed = async (host: { container: HTMLElement }) => {
    await fireEvent.click(buttonContaining(host, zh["mail.trash"])!);
    await settle();
    await openFirst(host);
  };
  const deleteButton = (host: { container: HTMLElement }) =>
    [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === zh["mail.delete"],
    ) as HTMLButtonElement;

  test("an archive the mail service never accepted does not close the reader", async () => {
    const store = seedStore();
    installBridge(store, ["mail_move"]);
    const host = render(MailApp);
    await settle();
    await settle();
    await openFirst(host);

    await fireEvent.click(buttonContaining(host, zh["mail.archive"])!);

    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.actionUnconfirmed"]));
    // The reader is still open and the message never left — we did not claim it did.
    expect(txt(host)).toContain("Please review the mock engine.");
    expect(inInbox(store)).toBe(true);
  });

  test("an archive the mail service accepts closes the reader", async () => {
    const store = seedStore();
    installBridge(store);
    const host = render(MailApp);
    await settle();
    await settle();
    await openFirst(host);

    await fireEvent.click(buttonContaining(host, zh["mail.archive"])!);

    await vi.waitFor(() => expect(txt(host)).not.toContain("Please review the mock engine."));
    expect(txt(host)).not.toContain(zh["mail.actionUnconfirmed"]);
    expect(inInbox(store)).toBe(false);
  });

  // Deleting is the destructive half: the reader closing is the only signal the user
  // gets that the message is gone, so claiming it on an unconfirmed write is the worst
  // version of this bug — the message is still there and the screen said otherwise.
  test("a delete the mail service never accepted does not close the reader", async () => {
    const store = toTrash(seedStore());
    installBridge(store, ["mail_delete"]);
    const host = render(MailApp);
    await settle();
    await settle();
    await openTrashed(host);

    await fireEvent.click(deleteButton(host));

    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.actionUnconfirmed"]));
    expect(txt(host)).toContain("Please review the mock engine.");
    expect(store.get("Trash")!.some((m) => m.id === "m1")).toBe(true);
  });

  test("a delete the mail service accepts closes the reader and drops the row", async () => {
    const store = toTrash(seedStore());
    installBridge(store);
    const host = render(MailApp);
    await settle();
    await settle();
    await openTrashed(host);

    await fireEvent.click(deleteButton(host));

    await vi.waitFor(() => expect(txt(host)).not.toContain("Please review the mock engine."));
    expect(txt(host)).not.toContain(zh["mail.actionUnconfirmed"]);
    expect(store.get("Trash")!.some((m) => m.id === "m1")).toBe(false);
  });

  // `markAllRead` is the batch case, and it is why the verdict is read back from the
  // **store** rather than from `bridgeDiag("mail_set_seen")`: that slot holds only the
  // last call's result, so a batch with a partial failure would report one write as if
  // it spoke for all of them.
  test("a mark-all-read the mail service never accepted says so and leaves the rows unread", async () => {
    const store = seedStore();
    installBridge(store, ["mail_set_seen"]);
    const host = render(MailApp);
    await settle();
    await settle();

    await fireEvent.click(buttonContaining(host, zh["mail.markAllRead"])!);

    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.actionUnconfirmed"]));
    // The rows are still unread — the note cannot disagree with what is drawn under it.
    expect(seen(store)).toBe(0);
    expect(txt(host)).toContain(zh["mail.markAllRead"]);
  });

  test("a mark-all-read the mail service accepts reports nothing", async () => {
    const store = seedStore();
    installBridge(store);
    const host = render(MailApp);
    await settle();
    await settle();

    await fireEvent.click(buttonContaining(host, zh["mail.markAllRead"])!);

    // The unread affordance disappears — the batch landed.
    await vi.waitFor(() => expect(buttonContaining(host, zh["mail.markAllRead"])).toBeUndefined());
    expect(txt(host)).not.toContain(zh["mail.actionUnconfirmed"]);
    expect(seen(store)).toBe(2);
  });

  /**
   * **A search the engine never ran** (REQ-A836 / F-SH-266). `mailSearch` answers `null`
   * for "found nothing" and for "the command was refused", and the search path coerced
   * both with the same `?? []` — so a refused search was drawn as 《没有匹配的邮件》. The
   * `refresh` path next door never folds (`rows === null` sets the honest error), which
   * is what makes this a defect rather than a convention.
   */
  test("a refused search is not drawn as no matches", async () => {
    const store = seedStore();
    installBridge(store, ["mail_search"]);
    const host = render(MailApp);
    await settle();
    await settle();

    const search = inputByPlaceholder(host, zh["mail.search"])!;
    await fireEvent.input(search, { target: { value: "Design" } });

    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.searchUnconfirmed"]));
    // The message the term *does* match is still in the list we hold, so "no matching
    // messages" would have contradicted data the screen already had.
    expect(txt(host)).not.toContain(zh["mail.noMatch"]);
    expect(store.get("INBOX")!.some((m) => m.subject === "Design review")).toBe(true);
  });

  test("a search the engine confirms as empty says no matches", async () => {
    const store = seedStore();
    installBridge(store);
    const host = render(MailApp);
    await settle();
    await settle();

    const search = inputByPlaceholder(host, zh["mail.search"])!;
    await fireEvent.input(search, { target: { value: "zzz-nothing" } });

    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.noMatch"]));
    expect(txt(host)).not.toContain(zh["mail.searchUnconfirmed"]);
  });
});

/**
 * **A composer's refusal is not a statement about the mailbox** (REQ-A1078 / F-SH-393).
 *
 * One `$state` named `error` was written by two different events: the list *read* failing
 * (`refresh`, when `mail_list` answers `null`) and the composer's *send* refusing (no
 * recipient — validation — or a `mail_send` the daemon turned down). The list region is
 * keyed on it (`{:else if error}`), and `refresh` only re-runs when `mailbox` changes, so
 * 发送 with an empty recipient followed by 取消 left the sentence 「请填写至少一个收件人」
 * standing where the inbox listing goes. Nothing was wrong with the listing — the read had
 * succeeded a moment earlier, and `refresh` is what would have cleared the slot, not the
 * cancel.
 *
 * Splitting `listError` (set only by the read) from `sendError` (set only by the composer)
 * makes the conflation structurally impossible: a composer refusal has no render point in
 * the list region. The same rule `FilesApp`'s `hostListFailed` keeps (REQ-A1030 / F-SH-347).
 */
describe("MailApp.svelte — a refused send does not speak for the listing", () => {
  test("cancelling a composer whose send was refused leaves the inbox listing on screen", async () => {
    const store = seedStore();
    installBridge(store); // the mailbox read succeeds; only the *send* is refused
    const host = render(MailApp);
    await settle();
    await settle();
    expect(txt(host)).toContain("Design review");

    await fireEvent.click(buttonContaining(host, zh["mail.compose"])!);
    await fireEvent.click(buttonContaining(host, zh["mail.send"])!);
    // The refusal is shown inside the composer, where the button that caused it lives.
    await vi.waitFor(() => expect(txt(host)).toContain(zh["mail.needTo"]));

    await fireEvent.click(buttonContaining(host, zh["mail.cancel"])!);

    // The refusal left with the composer, and the listing it never spoke about is still
    // drawn — not replaced by the validation sentence.
    await vi.waitFor(() => expect(txt(host)).toContain("Design review"));
    expect(txt(host)).toContain("Build report");
    expect(txt(host)).not.toContain(zh["mail.needTo"]);
  });
});
