import { describe, expect, test } from "bun:test";
import {
  PUSH_NOTIF_ICON,
  dropPushNotifs,
  mergePushHistory,
  pushRecordToNotif,
} from "../pushNotifBridge";
import type { PushPayload, RustNotificationRecord } from "../pushNotifications";
import { NOTIF_CAP, type Notif } from "../settings";

const NOW = 1_700_000_000_000;

/** Build a Rust record the way `push_get_history` really returns one. */
function record(
  over: { payload: Record<string, unknown> } & Partial<Omit<RustNotificationRecord, "payload">>,
): RustNotificationRecord {
  const { payload, ...rest } = over;
  return {
    id: "notif_1",
    received_at: "2026-09-17T10:00:00+00:00",
    read: false,
    ...rest,
    payload: { aps: {}, ...payload } as unknown as PushPayload,
  };
}

describe("pushNotifBridge.pushRecordToNotif", () => {
  test("projects a visible delivery into the shell's Notif shape", () => {
    const n = pushRecordToNotif(
      record({ id: "notif_a", payload: { aps: { alert: "build finished", badge: 3 } } }),
      NOW,
    );
    expect(n).not.toBeNull();
    expect(n?.id).toBe("notif_a");
    expect(n?.source).toBe("push");
    expect(n?.read).toBe(false);
    expect(n?.body).toBe("build finished");
    expect(n?.icon).toBe(PUSH_NOTIF_ICON);
    expect(n?.badge).toBe(3);
    // `received_at` is an ISO string — the millisecond time must come from parsing it.
    expect(n?.time).toBe(Date.parse("2026-09-17T10:00:00+00:00"));
  });

  test("keeps a structured alert's title, subtitle and body", () => {
    const n = pushRecordToNotif(
      record({
        payload: { aps: { alert: { title: "Deploy", subtitle: "prod", body: "done" } } },
      }),
      NOW,
    );
    expect(n?.title).toBe("Deploy prod");
    expect(n?.body).toBe("done");
  });

  test("a silent push produces no visible notification", () => {
    expect(
      pushRecordToNotif(record({ payload: { aps: { "content-available": 1 } } }), NOW),
    ).toBeNull();
  });

  test("a badge-only push produces no visible notification", () => {
    expect(pushRecordToNotif(record({ payload: { aps: { badge: 7 } } }), NOW)).toBeNull();
  });

  test("an unparseable received_at falls back to the moment we first saw it", () => {
    const n = pushRecordToNotif(
      record({ received_at: "not-a-date", payload: { aps: { alert: "hi" } } }),
      NOW,
    );
    expect(n?.time).toBe(NOW);
  });

  test("copies the device's own read flag and the payload's app label", () => {
    const n = pushRecordToNotif(
      record({
        read: true,
        payload: { aps: { alert: "hi" }, app: "  Mail  " },
      }),
      NOW,
    );
    expect(n?.read).toBe(true);
    expect(n?.app).toBe("Mail");
  });

  test("a blank app label is not invented", () => {
    const n = pushRecordToNotif(
      record({ payload: { aps: { alert: "hi" }, app: "   " } }),
      NOW,
    );
    expect(n?.app).toBeUndefined();
  });
});

describe("pushNotifBridge.mergePushHistory", () => {
  const held: Notif[] = [
    { id: "notif_old", time: NOW - 1000, title: "already here", source: "push", read: true },
    { id: "system_1", time: NOW - 2000, title: "shell made" },
  ];

  test("adds only the deliveries it does not already hold", () => {
    const out = mergePushHistory(
      held,
      [
        record({ id: "notif_old", payload: { aps: { alert: "already here" } } }),
        record({ id: "notif_new", payload: { aps: { alert: "fresh" } } }),
      ],
      NOW,
      NOTIF_CAP,
    );
    expect(out.map((n) => n.id)).toEqual(["notif_new", "notif_old", "system_1"]);
  });

  test("never resurrects the local read flag of a delivery it already holds", () => {
    const out = mergePushHistory(
      held,
      [record({ id: "notif_old", read: false, payload: { aps: { alert: "already here" } } })],
      NOW,
      NOTIF_CAP,
    );
    expect(out.find((n) => n.id === "notif_old")?.read).toBe(true);
  });

  test("newest delivery lands first, and the list stays bounded", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      record({
        id: `n${i}`,
        received_at: new Date(NOW - i * 60_000).toISOString(),
        payload: { aps: { alert: `m${i}` } },
      }),
    );
    const out = mergePushHistory([], many, NOW, 3);
    expect(out).toHaveLength(3);
    expect(out.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);
  });

  test("a delivery with nothing to show is not added", () => {
    const out = mergePushHistory(held, [record({ payload: { aps: { badge: 1 } } })], NOW, NOTIF_CAP);
    expect(out).toEqual(held);
  });

  test("a failed fetch removes nothing", () => {
    const out = mergePushHistory(held, [], NOW, NOTIF_CAP);
    expect(out).toEqual(held);
  });

  test("the input list is never mutated", () => {
    const before = JSON.stringify(held);
    mergePushHistory(held, [record({ id: "notif_x", payload: { aps: { alert: "x" } } })], NOW, NOTIF_CAP);
    expect(JSON.stringify(held)).toBe(before);
  });
});

describe("pushNotifBridge.dropPushNotifs", () => {
  test("drops push deliveries and keeps the shell's own notifications", () => {
    const out = dropPushNotifs([
      { id: "p1", time: 1, source: "push" },
      { id: "s1", time: 2 },
      { id: "s2", time: 3, source: "system" },
    ]);
    expect(out.map((n) => n.id)).toEqual(["s1", "s2"]);
  });
});
