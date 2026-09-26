/**
 * notifApp.test.ts — the one rule for "which app is this stored notification from?" (REQ-A1134).
 *
 * A stored row names its sender as a **display string** in the locale active at push time, so
 * the only language-independent answer is the reverse lookup over **every** locale's
 * dictionary. These tests pin the two halves the shells depend on:
 *
 *   * a row written under **either** locale resolves to the same app id (the defect: the old
 *     forward lookup — id → one locale's name — silently read zero for the other locale);
 *   * free text and a foreign id resolve to `null` (no built-in app names itself that way),
 *     which is what keeps a push row from badging a tile it did not come from.
 */
import { describe, expect, test as it } from "bun:test";
import { notifAppId, countNotifsOfApp, hasNotifsOfApp, withoutAppNotifs } from "../notifApp";
import type { Notif } from "../settings";

const DICTS = [
  {
    "app.messages": "信息",
    "app.mail": "邮件",
    "app.phone": "电话",
    "app.clock": "时钟",
  },
  {
    "app.messages": "Messages",
    "app.mail": "Mail",
    "app.phone": "Phone",
    "app.clock": "Clock",
  },
];

const notif = (app: string, id = `${app}-1`): Notif => ({ id, app, time: 1 });

describe("notifAppId — reverse lookup of the sender, over every locale", () => {
  it("resolves a row written under either locale to the same app id", () => {
    expect(notifAppId(notif("信息"), DICTS)).toBe("messages");
    expect(notifAppId(notif("Messages"), DICTS)).toBe("messages");
    expect(notifAppId(notif("Clock"), DICTS)).toBe("clock");
  });

  it("answers null for a push payload's free text or a foreign id", () => {
    expect(notifAppId(notif("我的应用"), DICTS)).toBeNull();
    expect(notifAppId(notif("com.example.thing"), DICTS)).toBeNull();
    expect(notifAppId(notif(""), DICTS)).toBeNull();
  });
});

describe("countNotifsOfApp / hasNotifsOfApp / withoutAppNotifs", () => {
  // Two rows written in Chinese, one in English, one foreign — all the same app's tile.
  const list: Notif[] = [
    notif("信息", "a"),
    notif("信息", "b"),
    notif("Messages", "c"),
    notif("com.example.thing", "d"),
  ];

  it("counts rows from the app across every locale, and drops the foreign row", () => {
    expect(countNotifsOfApp(list, "messages", DICTS)).toBe(3);
    expect(countNotifsOfApp(list, "mail", DICTS)).toBe(0);
  });

  it("answers membership without materialising a count", () => {
    expect(hasNotifsOfApp(list, "messages", DICTS)).toBe(true);
    expect(hasNotifsOfApp(list, "mail", DICTS)).toBe(false);
  });

  it("removes every locale's rows for the app while keeping the rest", () => {
    const left = withoutAppNotifs(list, "messages", DICTS);
    expect(left.map((n) => n.id)).toEqual(["d"]);
  });

  it("does not touch the input list", () => {
    const before = list.length;
    withoutAppNotifs(list, "messages", DICTS);
    expect(list.length).toBe(before);
  });
});
