/**
 * REQ-A1949 / F-SH-945 — 一个 App 重发的整批通知必须落在**头部**（newest-first），
 * 不能追加在尾部。
 *
 * `amos.notifications` 的约定是 newest-first：`addNotif` 前插、`mergePushHistory` 把新行按
 * `time` 排好后前插、timer ∕ reminder ∕ calendar 生产者都写头部。而通知中心**按数组顺序渲染**
 * （`NotificationCenter.svelte` / `DesktopNotificationCenter.svelte` 都 `{#each notifs}`，渲染
 * 时不再排序）⇒ 位置**就是**显示顺序。
 *
 * 两个「每次变更都把本 App 的整批行重新推导一遍」的生产者 —— `MailApp`（邮件）与
 * `MessagesApp`（信息）—— 自己拼 `[...others, ...fresh]`，于是把本 App 的行放在**所有其它
 * App 之后**，不管时间谁新。这条轴由 REQ-A1940 的边界逐字点名（「那两个写入者『把最新行追加
 * 在尾部』……本轮**未**按其约定改为前置」）。而 REQ-A1940 之后，超上限的裁剪改由 `time` 判定，
 * 于是一个被裁剪过的 store 里，**可见顺序**已无法从位置还原。
 *
 * 本文件先把共享规则钉成纯函数 `replaceAppNotifs`，再断言它的**头部语义**。
 *
 * 如实边界：本文件只钉**纯规则**；两个调用点的接线由
 * `svelte-tests/messages-notif-order.svelte.test.ts` 单独钉（可把调用点改回追加让它转红）。
 */
import { describe, expect, test } from "vitest";
import { replaceAppNotifs } from "../lib/notifApp";
import type { Notif } from "../lib/settings";
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";

const DICTS = [zh, en] as const;

const row = (id: string, app: string, time: number): Notif => ({ id, app, time });

describe("replaceAppNotifs — 本 App 的整批行落在头部", () => {
  test("新行必须排在其它 App 的行之前，且批内按 time 新→旧（红先）", () => {
    const clock = row("clock:1", zh["app.clock"], 5_000);
    const existing = [clock, row("mail:old", zh["app.mail"], 100)];
    const fresh = [row("mail:a", zh["app.mail"], 1_000), row("mail:b", zh["app.mail"], 3_000)];

    const out = replaceAppNotifs(existing, "mail", fresh, DICTS);

    // 本 App 的旧行被替换掉，其它 App 的行原样保留。
    expect(out.map((n) => n.id).sort()).toEqual(["clock:1", "mail:a", "mail:b"]);
    // 头部是刚发布的这批，且批内 newest-first；其它 App 的行跟在后面。
    expect(out.map((n) => n.id)).toEqual(["mail:b", "mail:a", "clock:1"]);
  });

  test("本 App 的旧行被整批替换（不残留）", () => {
    const existing = [
      row("mail:stale-1", zh["app.mail"], 900),
      row("clock:1", zh["app.clock"], 5_000),
      row("mail:stale-2", zh["app.mail"], 800),
    ];
    const out = replaceAppNotifs(existing, "mail", [row("mail:new", zh["app.mail"], 7_000)], DICTS);

    expect(out.map((n) => n.id)).toEqual(["mail:new", "clock:1"]);
  });

  test("空批 = 撤回本 App 的全部行，其它 App 的行保持原顺序（对照）", () => {
    const existing = [
      row("clock:1", zh["app.clock"], 5_000),
      row("mail:x", zh["app.mail"], 100),
      row("clock:2", zh["app.clock"], 4_000),
    ];
    const out = replaceAppNotifs(existing, "mail", [], DICTS);

    expect(out.map((n) => n.id)).toEqual(["clock:1", "clock:2"]);
  });

  test("英文界面下写出的行同样按 app 认领（locale-independent，对照）", () => {
    const existing = [row("msg:old", en["app.messages"], 100)];
    const fresh = [row("msg:new", en["app.messages"], 2_000)];
    const out = replaceAppNotifs(existing, "messages", fresh, DICTS);

    expect(out.map((n) => n.id)).toEqual(["msg:new"]);
  });
});
