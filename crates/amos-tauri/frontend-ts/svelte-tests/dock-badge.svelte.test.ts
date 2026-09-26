/**
 * dock-badge.svelte.test.ts — the desktop Dock lights an unread badge, and the one
 * process-wide writer tells the host.
 *
 * Two halves of the same completion are pinned here:
 *
 *  1. **The pixels.** The desktop `Dock.svelte` used to paint *no* unread badge at all —
 *     the same notification showed a count on the touch home screen's dock and then, in
 *     desktop form, nothing. The tile must now render the per-app number, and turn it off
 *     under Do-Not-Disturb exactly like the touch shell (`HomeDock.svelte` does it through
 *     the same `lib/dockBadge.ts` functions).
 *  2. **The host call.** `dock_badge_set` had no caller since REQ-A389. Only the `main`
 *     window mounts this Dock, so that effect is the sole writer; it must send the
 *     **aggregate** count, and `null` (clear) when there is nothing left to show.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Dock from "../src/svelte/Dock.svelte";
import { LAYOUT_KEY, writeStoreValue, type HomeLayout } from "../src/lib/amosStore";
import { NOTIF_KEY, SETTINGS_KEY, type Notif } from "../src/lib/settings";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

const SEEDED: HomeLayout = { page: [], dock: ["messages", "mail", "files"], hidden: [] };
const settle = () => new Promise((r) => setTimeout(r, 20));

const MESSAGES = zh["app.messages"]; // "信息"
const MAIL = zh["app.mail"]; // "邮件"

const notif = (id: string, app: string): Notif => ({ id, app, time: 1 });

/** Every `dock_badge_set` payload the shell sent, in order. */
let badgeCalls: Array<{ label: string | null }> = [];

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (cmd === "dock_badge_set") badgeCalls.push(args as { label: string | null });
      return null;
    },
    listen: async () => () => {},
  };
}

const setNotifications = (list: Notif[]) => writeStoreValue(NOTIF_KEY, list);
const setQuiet = (dnd: boolean) => writeStoreValue(SETTINGS_KEY, { dnd });

const badge = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`[data-testid="dock-app-${id}-badge"]`);

beforeEach(() => {
  window.localStorage.clear();
  badgeCalls = [];
  installHost();
  writeStoreValue(LAYOUT_KEY, SEEDED);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("Dock.svelte — unread badges", () => {
  test("paints the per-app count on the tile that owns the rows", async () => {
    setNotifications([
      notif("a", MESSAGES),
      notif("b", MESSAGES),
      notif("c", MAIL),
    ]);
    const { container } = render(Dock);
    await tick();
    await settle();

    expect(badge(container, "messages")?.textContent).toBe("2");
    expect(badge(container, "mail")?.textContent).toBe("1");
    // The app with no rows paints no badge at all — not an empty pill.
    expect(badge(container, "files")).toBeNull();
  });

  test("names the real count for assistive tech, not the capped text", async () => {
    // 100 rows — the store's own ceiling (`NOTIF_CAP`): every reader normalises, so a
    // longer list can't exist. The tile shows "99+", but the label still says 100.
    setNotifications(Array.from({ length: 100 }, (_, i) => notif(`m${i}`, MESSAGES)));
    const { container } = render(Dock);
    await tick();
    await settle();

    const tile = container.querySelector<HTMLElement>('[data-testid="dock-app-messages"]');
    expect(badge(container, "messages")?.textContent).toBe("99+");
    expect(tile?.getAttribute("aria-label")).toContain("100");
  });

  test("Do-Not-Disturb hides every badge", async () => {
    setNotifications([notif("a", MESSAGES), notif("c", MAIL)]);
    setQuiet(true);
    const { container } = render(Dock);
    await tick();
    await settle();

    expect(badge(container, "messages")).toBeNull();
    expect(badge(container, "mail")).toBeNull();
  });

  test("a row written while the UI was English still badges its app（REQ-A1134）", async () => {
    // 每条通知的 `app` 是**推送当刻**的显示名（`bgText.ts::bgT`），不是 app id。所以
    // 中文界面写下的行是「信息」，英文界面写下的是 "Messages"，而两者都是 `messages`
    // 这一个 app。把 id 解析成**单一**语言的名字再按字符串相等去数（旧法）在这两种情况里
    // 必有一半数不到 —— 见 `lib/notifApp.ts`。反向解析（显示名 → id）才是唯一与语言无关
    // 的规则，也正是桌面通知中心 `appIdForDisplayName` 已经在用的那条。
    setNotifications([notif("a", en["app.messages"] as string)]);
    const { container } = render(Dock);
    await tick();
    await settle();

    expect(badge(container, "messages")?.textContent).toBe("1");
  });

  test("a push row the user already read paints no badge（REQ-A1135）", async () => {
    // `markNotifRead` keeps the row (dimmed) — it is *not* removed — so a badge counted from
    // rows alone stays lit for a notification the user has already opened.
    setNotifications([
      notif("a", MESSAGES),
      { ...notif("b", MESSAGES), source: "push", read: true },
    ]);
    const { container } = render(Dock);
    await tick();
    await settle();

    expect(badge(container, "messages")?.textContent).toBe("1");
    // …and the OS Dock icon's aggregate drops it too — otherwise the real icon keeps a
    // number the tile has already stopped painting.
    expect(badgeCalls.at(-1)).toEqual({ label: "1" });
  });
});

describe("Dock.svelte — the macOS Dock icon badge (the one writer)", () => {
  test("sends the aggregate unread count to the host", async () => {
    setNotifications([
      notif("a", MESSAGES),
      notif("b", MESSAGES),
      notif("c", MAIL),
    ]);
    render(Dock);
    await tick();
    await settle();

    expect(badgeCalls.at(-1)).toEqual({ label: "3" });
  });

  test("clears the host badge when Do-Not-Disturb turns on", async () => {
    setNotifications([notif("a", MESSAGES)]);
    render(Dock);
    await tick();
    await settle();
    expect(badgeCalls.at(-1)).toEqual({ label: "1" });

    // Flipping DND on must wipe the icon's badge, not leave the stale "1".
    setQuiet(true);
    await tick();
    await settle();

    expect(badgeCalls.at(-1)).toEqual({ label: null });
  });

  test("does not re-send the same label as the store jitters", async () => {
    setNotifications([notif("a", MESSAGES)]);
    render(Dock);
    await tick();
    await settle();
    const after = badgeCalls.length;
    // The store re-broadcasts on every `store-updated`; an unchanged value must not
    // produce another host write.
    setNotifications([notif("a", MESSAGES)]);
    await tick();
    await settle();

    expect(badgeCalls.length).toBe(after);
  });
});
