/**
 * desktop-notification-banner.svelte.test.ts — G-γ: macOS 桌面右上角通知 banner.
 *
 * 复用 `NotificationBanner.svelte`（phone 形态）的同源纯函数：
 *   * `newestAddedNotif` (lib/settings.ts) — 检测新到的那一条
 *   * `removeAppNotifs` (lib/settings.ts) — 单击 ack 清该 app 所有通知
 *   * `dndActive / normalizeQuick` (lib/settings.ts) — DND 门
 *   * `shouldRingOnArrival / effectiveAlert` (lib/sound.ts) — 提示音策略
 *   * `playNotifyTone` (lib/notifyTone.ts) — 提示音合成
 *
 * 不复制：每条负控钉一个"如果回到内联实现 ⇒ 该测试失败"。
 *
 * REQs: docs/DESKTOP_NOTIFICATION_BANNER_G_GAMMA.md §4.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import * as fs from "node:fs";
import * as path from "node:path";
import DesktopNotificationBanner from "../src/svelte/DesktopNotificationBanner.svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import {
  NOTIF_KEY,
  SETTINGS_KEY,
  addNotif,
} from "../src/lib/settings";
import { SOUND_KEY } from "../src/lib/sound";
import {
  TOPBAR_HEIGHT,
  NOTIF_BANNER_TOP_OFFSET,
  NOTIF_BANNER_RIGHT_OFFSET,
  NOTIF_BANNER_MAX_WIDTH,
  NOTIF_BANNER_SHOW_MS,
} from "../src/lib/desktopLayout";

// The chime is asserted, not heard: swap the real (asset-free) Web Audio synth
// for a spy so the arrival *policy* is what's under test (mirrors the phone
// banner's mock — same file, different mount).
const tone = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock("../src/lib/notifyTone", () => ({ playNotifyTone: tone.play }));

const bannerEl = (c: HTMLElement) =>
  c.querySelector('[data-testid="desktop-notif-banner"]') as HTMLElement | null;

beforeEach(() => {
  window.localStorage.clear();
  tone.play.mockClear();
});
afterEach(() => {
  window.localStorage.clear();
  tone.play.mockClear();
});

// ─── §4.1 几何（5 条） ───────────────────────────────────────────────────────

describe("G-γ — 几何常量（lib/desktopLayout.ts 唯一真源）", () => {
  test("NOTIF_BANNER_SHOW_MS = 4200（与 phone 形态 NotificationBanner 同源）", () => {
    expect(NOTIF_BANNER_SHOW_MS).toBe(4200);
  });

  test("TOPBAR_HEIGHT = 24（仓内唯一顶栏高度真源）", () => {
    expect(TOPBAR_HEIGHT).toBe(24);
  });

  test("NOTIF_BANNER_RIGHT_OFFSET = 8（macOS 实测）", () => {
    expect(NOTIF_BANNER_RIGHT_OFFSET).toBe(8);
  });

  test("NOTIF_BANNER_TOP_OFFSET = 6（macOS 实测）", () => {
    expect(NOTIF_BANNER_TOP_OFFSET).toBe(6);
  });

  test("NOTIF_BANNER_MAX_WIDTH = 360（与 DesktopNotificationCenter 同宽）", () => {
    expect(NOTIF_BANNER_MAX_WIDTH).toBe(360);
  });

  // **负控 #1**：若有人把 SHOW_MS 在桌面组件里写回 `const SHOW_MS = 4200` 内联，
  // grep 应能查出至少两处。把 `NotificationBanner.svelte` 与 `desktopLayout.ts`
  // 之外的文件**没有**任何"裸 4200"作为本地常量定义为断言：仓内仅一处真源。
  test("SHOW_MS 字面值在仓内仅出现于 desktopLayout.ts / NotificationBanner.svelte（无重复常量定义）", () => {
    const root = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.(ts|svelte)$/.test(f)) {
          const body = fs.readFileSync(full, "utf8");
          // 匹配 "const SHOW_MS = 4200" / "const FOO_BAR = 4200" 这种「本地常量定义」。
          // 注释里的 4200 / i18n 里的 4200 不计。
          if (/const\s+[A-Z_][A-Z0-9_]*\s*=\s*4200\b/.test(body)) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    // 只允许 desktopLayout.ts 定义（暴露为 NOTIF_BANNER_SHOW_MS）—— NotificationBanner
    // 改用 import，不再写 const。这条测试是 *钉住* desktopLayout.ts 唯一真源。
    expect(offenders).toEqual(["lib/desktopLayout.ts"]);
  });

  // **负控 #2**：钉住 `TOPBAR_HEIGHT` 这个名字在仓内只 export 一次。
  // 用 grep 在 .ts/.svelte 上找 `export const TOPBAR_HEIGHT` —— 若有人在别的文件
  // 也 `export const TOPBAR_HEIGHT = 24`，就是「两份真源」。同样的，
  // 我们不主动去找"裸 24"，因为仓内别处有 `VMEMO_CAP = 24` 这类与顶栏无关的 24，
  // 那是**别的**纪律，不归这条负管控。
  test("TOPBAR_HEIGHT 这个名字在仓内仅在 lib/desktopLayout.ts 导出", () => {
    const root = path.resolve(__dirname, "..", "src");
    const exporters: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.(ts|svelte)$/.test(f)) {
          const body = fs.readFileSync(full, "utf8");
          if (/export\s+const\s+TOPBAR_HEIGHT\b/.test(body)) {
            exporters.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(exporters).toEqual(["lib/desktopLayout.ts"]);
  });
});

// ─── §4.2 行为（5 条） ───────────────────────────────────────────────────────

describe("G-γ — 通知到达 / 消失 / 位置 / 新到一条 / ack", () => {
  test("topBanner_appears_when_a_new_notification_arrives", async () => {
    const { container } = render(DesktopNotificationBanner);
    await tick();
    expect(bannerEl(container)).toBeFalsy();

    writeStoreValue(NOTIF_KEY, [
      { id: "n1", app: "信息", icon: "💬", title: "小安", body: "hi", time: Date.now() },
    ]);
    await tick();
    expect(bannerEl(container)).toBeTruthy();
    expect(container.textContent ?? "").toContain("信息");
  });

  test("topBanner_dismisses_after_NOTIF_BANNER_SHOW_MS", async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(DesktopNotificationBanner);
      await tick();
      writeStoreValue(NOTIF_KEY, [
        { id: "n1", app: "信息", title: "hi", time: Date.now() },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(bannerEl(container)).toBeTruthy();

      // 距离超时还有 1 ms — 还应可见
      await vi.advanceTimersByTimeAsync(NOTIF_BANNER_SHOW_MS - 1);
      expect(bannerEl(container)).toBeTruthy();

      // 跨过超时 — 消失
      await vi.advanceTimersByTimeAsync(1);
      expect(bannerEl(container)).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  test("topBanner_is_positioned_top_right_corner（top/right 由真源常量驱动）", async () => {
    const { container } = render(DesktopNotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [
      { id: "n1", app: "信息", title: "hi", time: Date.now() },
    ]);
    await tick();
    const el = bannerEl(container);
    expect(el).toBeTruthy();
    // 期望：top = TOPBAR_HEIGHT + NOTIF_BANNER_TOP_OFFSET
    //       right = NOTIF_BANNER_RIGHT_OFFSET
    //       max-width = NOTIF_BANNER_MAX_WIDTH
    const styleAttr = el!.getAttribute("style") ?? "";
    const dataTop = el!.getAttribute("data-banner-top");
    const dataRight = el!.getAttribute("data-banner-right");
    const dataMaxW = el!.getAttribute("data-banner-max-width");
    expect(dataTop).toBe(String(TOPBAR_HEIGHT + NOTIF_BANNER_TOP_OFFSET));
    expect(dataRight).toBe(String(NOTIF_BANNER_RIGHT_OFFSET));
    expect(dataMaxW).toBe(String(NOTIF_BANNER_MAX_WIDTH));
    // 同时确认样式里以 px 写出（不是裸数字），便于 CSS 解析。
    expect(styleAttr).toContain(`top: ${TOPBAR_HEIGHT + NOTIF_BANNER_TOP_OFFSET}px`);
    expect(styleAttr).toContain(`right: ${NOTIF_BANNER_RIGHT_OFFSET}px`);
    expect(styleAttr).toContain(`max-width: ${NOTIF_BANNER_MAX_WIDTH}px`);
  });

  test("topBanner_only_shows_the_just_arrived_notification（newestAddedNotif 真源）", async () => {
    const { container } = render(DesktopNotificationBanner);
    await tick();
    // 一次性 push 三条，banner 只显示**最新那条**（time 最大者）
    const now = Date.now();
    writeStoreValue(NOTIF_KEY, [
      { id: "n3", app: "天气", title: "第三条", time: now + 30 },
      { id: "n2", app: "日历", title: "第二条", time: now + 20 },
      { id: "n1", app: "信息", title: "第一条", time: now + 10 },
    ]);
    await tick();
    expect(container.textContent ?? "").toContain("天气");
    expect(container.textContent ?? "").not.toContain("日历");
    expect(container.textContent ?? "").not.toContain("信息");
    // store 仍在（三条都没被 ack）
    const remaining = JSON.parse(localStorage.getItem(NOTIF_KEY) ?? "[]") as unknown[];
    expect(remaining.length).toBe(3);
  });

  // 单击 ack = 该 app 所有通知清空（removeAppNotifs 真源，不是 removeNotif 单条）。
  // **负控 #3**：把 removeAppNotifs 改成 removeNotif ⇒ store 还会剩 2 条，测试失败。
  test("clicking_topBanner_marks_all_notifications_of_that_app_read", async () => {
    const { container } = render(DesktopNotificationBanner);
    await tick();
    const now = Date.now();
    // 同 app "信息" 3 条 + 别的 app "天气" 1 条 ⇒ ack 后信息 3 条应全没了，天气还在
    const list = addNotif(
      [{ id: "wx1", app: "天气", title: "今天 26°", time: now - 100 }],
      { id: "msg1", app: "信息", title: "A", time: now - 50 },
    );
    writeStoreValue(NOTIF_KEY, [
      ...list,
      { id: "msg2", app: "信息", title: "B", time: now - 40 },
      { id: "msg3", app: "信息", title: "C", time: now - 30 },
    ]);
    await tick();
    const b = bannerEl(container)?.querySelector("button") as HTMLButtonElement | null;
    expect(b).toBeTruthy();
    await fireEvent.click(b!);
    await tick();
    // banner 消失
    expect(bannerEl(container)).toBeFalsy();
    // "信息" 的 3 条都没了；"天气" 还在
    const remaining = JSON.parse(localStorage.getItem(NOTIF_KEY) ?? "[]") as Array<{
      app?: string;
    }>;
    expect(remaining.map((n) => n.app)).toEqual(["天气"]);
  });
});

// ─── §4.3 负面控制 / 契约不退化（3 条） ───────────────────────────────────

describe("G-γ — DND / 静音 / 不抢焦点", () => {
  test("topBanner_does_not_appear_when_DND_is_active（DND 真源 dndActive）", async () => {
    writeStoreValue(SETTINGS_KEY, { dnd: true });
    const { container } = render(DesktopNotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [
      { id: "n1", app: "信息", title: "hi", time: Date.now() },
    ]);
    await tick();
    expect(bannerEl(container)).toBeFalsy();
    // 也不应该响
    expect(tone.play).not.toHaveBeenCalled();
  });

  // **负控 #4**：若把 shouldRingOnArrival 短路成 true，desktop banner 会在用户静音时
  // 仍响 —— 这条测试钉这条路径必读 sound.ts 的真源。
  test("topBanner_does_not_ring_when_shouldRingOnArrival_returns_false", async () => {
    writeStoreValue(SOUND_KEY, { ring: false, vibrate: true });
    const { container } = render(DesktopNotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [
      { id: "n1", app: "信息", title: "hi", time: Date.now() },
    ]);
    await tick();
    // banner 仍出现（不是 DND）
    expect(bannerEl(container)).toBeTruthy();
    // 但不响（shouldRingOnArrival = false）
    expect(tone.play).not.toHaveBeenCalled();
  });

  // **负控 #5**：banner 出现时**不**把键盘焦点抓到自身 —— macOS 上通知 banner
  // 不抢焦点，否则用户正在打字会被打断。
  test("topBanner_does_not_steal_focus_from_active_window", async () => {
    const { container } = render(DesktopNotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [
      { id: "n1", app: "信息", title: "hi", time: Date.now() },
    ]);
    await tick();
    const el = bannerEl(container);
    expect(el).toBeTruthy();
    expect(el!.getAttribute("tabindex")).toBe("-1");
  });
});

// ─── §4.4 i18n / 仓内纪律（2 条） ─────────────────────────────────────────

describe("G-γ — 挂载 / 与 NotificationCenter 同源", () => {
  test("desktopShell_mounts_DesktopNotificationBanner_exactly_once", () => {
    const shellPath = path.resolve(
      __dirname,
      "..",
      "src",
      "svelte",
      "DesktopShell.svelte",
    );
    const body = fs.readFileSync(shellPath, "utf8");
    // 仅 1 行 mount —— 多挂一次会触发重复渲染与重复出现 banner
    const mounts = body.match(/<DesktopNotificationBanner\b[^/]*\/?>/g) ?? [];
    expect(mounts.length).toBe(1);
  });

  test("topBanner_uses_the_same_store_as_DesktopNotificationCenter", async () => {
    // 与 phone banner 的同源测试同形态：先 render 让订阅挂上，再写 store → banner
    // 出现。若先写 store 再 render，组件第一次订阅时 `seeded=true` 把它当作「已存在」
    // 不会触发到达 diff —— 这是订阅模型的语义，不是 bug。
    const { container } = render(DesktopNotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [
      { id: "shared-1", app: "信息", icon: "💬", title: "小安", body: "在么", time: Date.now() },
    ]);
    await tick();
    expect(bannerEl(container)).toBeTruthy();
    const persisted = JSON.parse(localStorage.getItem(NOTIF_KEY) ?? "[]") as Array<{
      id: string;
    }>;
    expect(persisted.map((n) => n.id)).toContain("shared-1");
    // banner 文案读到同一份
    expect(container.textContent ?? "").toContain("信息");
  });
});
