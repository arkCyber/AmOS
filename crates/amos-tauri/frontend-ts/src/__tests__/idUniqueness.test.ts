/**
 * idUniqueness.test.ts — 生产 id 生成器的族级唯一性契约（REQ-A401）
 *
 * 背景：REQ-A400 之后，"时间 + 一把随机数字"的 id 写法仍在多处，而它们各自声称
 * "唯一"。这里把它变成可复现的测量，而不是断言式的相信：**冻结时钟**（同一毫秒）
 * + **固定种子的 PRNG**（`Math.random` 被替换成 mulberry32(0x9e3779b9)），然后每个
 * 生成器紧循环 20,000 次。冻结时钟拿掉了时间戳这个区分器，种子让数字可被别人复算 ——
 * 这正是修前测得的结果：
 *
 *   cameraCapture.newCaptureId      3 次碰撞（5 位 base36 ≈ 26 bit）
 *   PhoneApp/ContactsApp 通知 id     3 次碰撞（同上）
 *   AiApp 消息 id                    3 次碰撞（同上）
 *   contacts / measure / webman / pushNotifications / shortcuts / conversationId
 *                                  0 次（6-9 位随机尾巴，≈31-53 bit）——"这一次没撞"，
 *                                   不是"不会撞"；它们同样改走 `localId`
 *
 * 修后每个生成器都由 **进程内单调计数器** 兜底（`lib/localId.ts`），所以在同样条件下
 * 每一位都唯一、且**与运气无关**。文件里那条 `retiredNotificationId` 就是负控：
 * 它保留着已退役的旧公式，并断言它在同样的测量下**必须撞**——否则这个测量本身没有
 * 分辨力（写测试时最容易犯的错是"测试恒过"）。idgen-scan.mjs 之所以排除测试语料，
 * 正是因为这里需要出现那条被禁的写法。
 *
 * 不导入 happy-dom 之外的东西：cameraCapture / shortcuts / customGroups / backend 的
 * 生成器会碰 `localStorage`，所以按本仓既有做法注册 happy-dom（与
 * `src/__tests__/cameraCapture.test.ts` 相同）；`localId` 自己的契约另有
 * `lib/__tests__/localId.test.ts` 钉住。
 */
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import { makeContactId } from "../lib/contacts";
import { createMeasurement } from "../lib/measure";
import { newCaptureId } from "../lib/cameraCapture";
import { generateId as webmanId } from "../lib/webman";
import { generateNotificationId } from "../lib/pushNotifications";
import { addCustomGroup } from "../lib/customGroups";
import { createShortcut, saveShortcuts } from "../lib/shortcuts";
import { conversationId, newConversation } from "../lib/backend";
import { newNotifId } from "../lib/settings";
import { makeId as filesId } from "../lib/files";
import { localId } from "../lib/localId";
import { makeNote } from "../lib/notes";
import { makeId as reminderId } from "../lib/reminders";
import { makeId as eventId } from "../lib/calendar";
import { makeVoiceId } from "../lib/voiceMemos";
import { newPhoto } from "../lib/photos";
import { alarmsReducer } from "../lib/time";
import { addConversation } from "../lib/messages";

/** The measurement's conditions: one millisecond, and a PRNG anyone can reproduce. */
const FROZEN_MS = 1_700_000_000_000;
const SEED = 0x9e3779b9;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `fn` with the clock frozen and `Math.random` replaced by the seeded PRNG. */
function frozen<T>(fn: () => T): T {
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => FROZEN_MS;
  Math.random = mulberry32(SEED);
  try {
    return fn();
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
}

/** How many of `n` ids minted by `make` are distinct. */
function distinct(make: () => string, n: number): number {
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) seen.add(make());
  return seen.size;
}

const N = 20_000;

describe("production id generators — uniqueness under a frozen clock (REQ-A401)", () => {
  test("negative control: the retired formula really does collide (the measurement has power)", () => {
    // The pre-REQ-A401 notification id, kept verbatim so the assertion below cannot be
    // vacuous: if this ever stops colliding, the burst no longer measures anything.
    const retiredNotificationId = () =>
      `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    expect(frozen(() => distinct(retiredNotificationId, N))).toBeLessThan(N);
  });

  test("contacts.makeContactId: 20,000 ids, no collision", () => {
    expect(frozen(() => distinct(() => makeContactId(), N))).toBe(N);
  });

  test("measure.createMeasurement: 20,000 ids, no collision", () => {
    const pt = { x: 0.1, y: 0.2 };
    expect(frozen(() => distinct(() => createMeasurement(pt, pt, 1000, 800, 500).id, N))).toBe(N);
  });

  test("cameraCapture.newCaptureId: 20,000 ids, no collision (the id is the media key)", () => {
    expect(frozen(() => distinct(() => newCaptureId(), N))).toBe(N);
  });

  test("webman.generateId: 20,000 ids, no collision", () => {
    expect(frozen(() => distinct(() => webmanId(), N))).toBe(N);
  });

  test("pushNotifications.generateNotificationId: 20,000 ids, no collision", () => {
    expect(frozen(() => distinct(() => generateNotificationId(), N))).toBe(N);
  });

  test("settings.newNotifId: 20,000 ids, no collision (a repeat is dropped on reload)", () => {
    expect(frozen(() => distinct(() => newNotifId(), N))).toBe(N);
  });

  test("files.makeId: 20,000 ids, no collision (REQ-A400's site)", () => {
    expect(frozen(() => distinct(() => filesId(), N))).toBe(N);
  });

  test("localId: 20,000 ids, no collision", () => {
    expect(frozen(() => distinct(() => localId("x"), N))).toBe(N);
  });

  // The two generators that write the store on every call stay at a small N (each id costs
  // a read+write round trip, and `createShortcut` logs per call). Their regression guard is
  // the static gate (`idgen-scan` R2), not the birthday bound — said here rather than
  // pretending 200 ids prove a 26-bit tail.
  test("customGroups.addCustomGroup: 1,000 group ids, no collision", () => {
    expect(frozen(() => distinct(() => addCustomGroup([], "g").created.id, 1_000))).toBe(1_000);
  });

  test("shortcuts.createShortcut: 200 shortcut ids, no collision", () => {
    expect(
      frozen(() =>
        distinct(() => {
          saveShortcuts([]);
          return createShortcut("x")!.id;
        }, 200),
      ),
    ).toBe(200);
  });

  test("backend.conversationId: 200 persisted conversation ids, no collision", () => {
    expect(
      frozen(() =>
        distinct(() => {
          const id = conversationId();
          newConversation();
          return id;
        }, 200),
      ),
    ).toBe(200);
  });
});

/**
 * REQ-A402: the family that relied on the clock + a **per-process** counter.
 *
 * `${now.toString(36)}-${seq}` has no entropy at all, so two contexts that agree on a
 * millisecond mint the SAME string. Measured with two real processes and a frozen clock —
 * one throwaway script that freezes `Date.now()` and prints one id per generator, run twice
 * (the exact outputs are in the CHANGELOG entry for REQ-A402):
 *
 *   note       loyw3v28-1        ← identical across the two processes
 *   reminder   loyw3v28-1
 *   event      loyw3v28-1
 *   voicememo  loyw3v28-1
 *   localId    note-loyw3v28-1-0gur3ba / …-1rzd4yu   ← differs (the crypto tail)
 *
 * and the consequences are silent: `normalizeVoiceMemos` **drops** a repeated id (2 rows
 * in → 1 row out, bytes orphaned), `normalizeConversations` **kept** both (two threads, one
 * identity — `removeConversation` deleted both), `normalizeNotes`/`normalizeEvents`
 * **rename** the row (every stored reference to it breaks).
 *
 * A two-process reproduction cannot be a unit test, so the guard here is the **shape
 * contract** instead: every identity must come out of `localId` (`<prefix>-<time36>-<seq36>-
 * <7 base36>`). A regression to `${now36}-${seq}` fails these assertions immediately — one
 * dash, no 7-char tail — which is exactly the property that makes the counter safe (the
 * counter alone is *not*: only the tail separates two contexts).
 */
const LOCAL_ID_SHAPE = (prefix: string) => new RegExp(`^${prefix}-[0-9a-z]+-[0-9a-z]+-[0-9a-z]{7}$`);

describe("identities that used to rest on the clock + a per-process counter (REQ-A402)", () => {
  test("the shape test has teeth: a retired `${now36}-${seq}` id does NOT match", () => {
    const fromLocalId = localId("note");
    expect(fromLocalId).toMatch(LOCAL_ID_SHAPE("note"));
    expect("loyw3v28-1").not.toMatch(LOCAL_ID_SHAPE("note")); // the pre-REQ-A402 form
  });

  test("notes.makeNote", () => {
    expect(makeNote("x", FROZEN_MS).id).toMatch(LOCAL_ID_SHAPE("note"));
  });

  test("reminders.makeId", () => {
    expect(reminderId()).toMatch(LOCAL_ID_SHAPE("rem"));
  });

  test("calendar.makeId", () => {
    expect(eventId()).toMatch(LOCAL_ID_SHAPE("ev"));
  });

  test("voiceMemos.makeVoiceId", () => {
    expect(makeVoiceId()).toMatch(LOCAL_ID_SHAPE("vm"));
  });

  test("photos.newPhoto (the factory now owns the id it used to be handed)", () => {
    // REQ-A402, second pass: `svelte/PhotosApp.svelte` used to pass `p${Date.now()}` — the
    // clock with no counter — into `newPhoto(id, now)`, whose result feeds a **keyed**
    // `{#each … (p.id)}` (a repeated key is a render-time error). The factory now mints it.
    expect(newPhoto(FROZEN_MS).id).toMatch(LOCAL_ID_SHAPE("p"));
    expect(frozen(() => distinct(() => newPhoto(FROZEN_MS).id, 3_000))).toBe(3_000);
  });

  test("time: a new alarm", () => {
    const st = alarmsReducer({ list: [], lastKey: "" }, { type: "add", hour: 1, min: 2, label: "" });
    expect(st.list[0]!.id).toMatch(LOCAL_ID_SHAPE("alarm"));
  });

  test("messages.addConversation", () => {
    const convs = addConversation([], "李四");
    expect(convs[0]!.id).toMatch(LOCAL_ID_SHAPE("chat"));
  });

  test("3,000 ids from each, clock frozen: all distinct", () => {
    const burst = (make: () => string) => frozen(() => distinct(make, 3_000));
    expect(burst(() => makeNote("x", FROZEN_MS).id)).toBe(3_000);
    expect(burst(() => reminderId())).toBe(3_000);
    expect(burst(() => eventId())).toBe(3_000);
    expect(burst(() => makeVoiceId())).toBe(3_000);
    expect(burst(() => addConversation([], "n")[0]!.id)).toBe(3_000);
    expect(
      burst(() => {
        const st = alarmsReducer({ list: [], lastKey: "" }, { type: "add", hour: 1, min: 2, label: "" });
        return st.list[0]!.id;
      }),
    ).toBe(3_000);
  });
});
