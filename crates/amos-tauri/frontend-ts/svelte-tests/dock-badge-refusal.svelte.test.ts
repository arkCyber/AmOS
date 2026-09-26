/**
 * dock-badge-refusal.svelte.test.ts — 宿主拒了一次角标写入时，Dock 不能把它记成「已经画上」（REQ-A1246）。
 *
 * `Dock.svelte` 的角标 effect 用一个 `lastBadge` 记忆挡住重复写入，理由是 store 每次
 * `store-updated` 都会抖动，反复写只会换来一串无意义的宿主日志：
 *
 * ```ts
 * if (label === lastBadge) return;
 * lastBadge = label;            // ← 在读到判决**之前**就记下
 * void setDockBadge(label);     // ← 判决被丢弃
 * ```
 *
 * `setDockBadge` 返回 `Promise<boolean>`，**`false` 就是宿主拒绝**（`dock_badge_set` 在
 * `set_badge_label` ∕ `set_badge_count` 失败、或 `no main window` 时返回 `Err`；`invoke`
 * 把 `Err` 折成 `null`，故真值只能从 `bridgeDiag` 读）。于是两层缺陷叠在一起：
 *
 *   1. 判决被 `void` 丢弃 —— 拒绝没有任何人知道。
 *   2. `lastBadge` 在判决之前落定 —— 一次**被拒**的写入被记成「宿主已经在显示它」。此后
 *      同一个值再也不会重试（`label === lastBadge` 直接 return），真实的 macOS 图标就此
 *      与瓦片上画着的数字永久不一致 —— 而屏幕上没有任何东西说得出这件事。
 *
 * 本文件的第一例正是钉住第 2 点：**被拒之后，下一次 store 抖动必须重试**。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Dock from "../src/svelte/Dock.svelte";
import { LAYOUT_KEY, writeStoreValue, type HomeLayout } from "../src/lib/amosStore";
import { NOTIF_KEY, type Notif } from "../src/lib/settings";
import { zh } from "../src/i18n/locales/zh";

const SEEDED: HomeLayout = { page: [], dock: ["messages", "mail", "files"], hidden: [] };
const settle = () => new Promise((r) => setTimeout(r, 20));
const MESSAGES = zh["app.messages"]; // "信息"

const notif = (id: string, app: string): Notif => ({ id, app, time: 1 });

let badgeCalls: Array<{ label: string | null }> = [];

/** Install a host whose `dock_badge_set` **rejects** — the Rust `Err` path through Tauri 2. */
function installRefusingHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (cmd === "dock_badge_set") {
        badgeCalls.push(args as { label: string | null });
        throw { code: "badge-failed", message: "no main window" };
      }
      return null;
    },
    listen: async () => () => {},
  };
}

const setNotifications = (list: Notif[]) => writeStoreValue(NOTIF_KEY, list);

beforeEach(() => {
  window.localStorage.clear();
  badgeCalls = [];
  writeStoreValue(LAYOUT_KEY, SEEDED);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("Dock 角标 —— 宿主拒绝时不得把「已画上」记成事实（REQ-A1246）", () => {
  test("被拒的写入不得被记住：下一次 store 抖动必须重试", async () => {
    installRefusingHost();
    setNotifications([notif("a", MESSAGES)]);
    render(Dock);
    await tick();
    await settle();

    const after = badgeCalls.length;
    expect(after).toBeGreaterThan(0);
    // The store re-broadcasts; the value is unchanged. A *successful* write must not be
    // re-sent (that is the guard's whole point) — but a **refused** one never took effect,
    // so the badge write must be attempted again.
    setNotifications([notif("a", MESSAGES)]);
    await tick();
    await settle();

    expect(badgeCalls.length).toBeGreaterThan(after);
  });

  test("被拒的写入要说出来（同文件的 wm_windows 面包屑就是这个形状）", async () => {
    installRefusingHost();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setNotifications([notif("a", MESSAGES)]);
    render(Dock);
    await tick();
    await settle();

    expect(badgeCalls.length).toBeGreaterThan(0);
    const said = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    // Assert the **surface** breadcrumb, not just the command name: `backend.invoke`'s own
    // `amosWarn("backend", "dock_badge_set failed", …)` already carries the command, so a
    // command-only assertion is unfailable — it passes on the broken code too.
    expect(said).toContain("[Dock]");
    expect(said).toContain("dock_badge_set");
  });

  test("没有桥（手机 ∕ 平板的正常路径）保持安静 —— 不是失败就没有面包屑", async () => {
    // No `__TAURI_INTERNALS__` at all ⇒ `invoke` records `not-bridged` and answers null.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setNotifications([notif("a", MESSAGES)]);
    render(Dock);
    await tick();
    await settle();

    const said = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(said).not.toContain("dock_badge_set refused");
  });
});
