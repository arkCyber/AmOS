/**
 * dockBadge.test.ts — the Dock badge: the pure math, and the one bridge call.
 *
 * Two defect classes are pinned here:
 *
 *  1. **A count that paints the wrong thing.** `badgeText` must answer `null` (not `""`)
 *     for "no badge" — an empty string would paint an empty red circle, the exact
 *     regression `dock_badge.rs::sanitize_label` guards on the host side.
 *  2. **Success read as failure.** `dock_badge_set` answers `()`, which the bridge delivers
 *     as `null` *and* uses to express a failure, so `result !== null` is false even on
 *     success (the REQ-A513 shape). `setDockBadge` must derive the answer from the
 *     diagnostics ledger instead — both directions are asserted below.
 */

import { describe, test as it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  badgeText,
  appUnread,
  dockBadgeTotal,
  setDockBadge,
  requestAttention,
  shellIsBackground,
  shouldRequestAttention,
  DOCK_BADGE_MAX,
} from "../dockBadge";
import type { Notif } from "../settings";

const notif = (app: string, id = app + "-1"): Notif => ({ id, app, time: 1 });

type Internals = { invoke: (cmd: string, args?: unknown) => Promise<unknown>; listen: () => Promise<() => void> };

function installHost(onInvoke: Internals["invoke"]): void {
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: { invoke: onInvoke, listen: async () => () => {} },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("badgeText", () => {
  it("paints nothing at zero, negative or non-finite counts", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-3)).toBeNull();
    expect(badgeText(Number.NaN)).toBeNull();
    expect(badgeText(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("paints the count up to the cap, then the cap plus an ellipsis", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(DOCK_BADGE_MAX)).toBe(String(DOCK_BADGE_MAX));
    expect(badgeText(DOCK_BADGE_MAX + 1)).toBe(`${DOCK_BADGE_MAX}+`);
    expect(badgeText(1234)).toBe(`${DOCK_BADGE_MAX}+`);
  });

  it("truncates a fractional count rather than painting a decimal", () => {
    expect(badgeText(3.7)).toBe("3");
    expect(badgeText(0.9)).toBeNull();
  });
});

/** The dictionaries `appIdForDisplayName` reverse-resolves against (all locales, REQ-A1134). */
const DICTS = [{ "app.messages": "信息", "app.mail": "邮件" }];

describe("appUnread", () => {
  const list = [notif("信息", "a"), notif("信息", "b"), notif("邮件", "c")];

  it("counts only the rows that belong to the app", () => {
    expect(appUnread(list, "messages", DICTS, false)).toBe(2);
    expect(appUnread(list, "mail", DICTS, false)).toBe(1);
    expect(appUnread(list, "weather", DICTS, false)).toBe(0);
    expect(appUnread([], "messages", DICTS, false)).toBe(0);
  });

  it("is 0 under Do-Not-Disturb without changing the count itself", () => {
    expect(appUnread(list, "messages", DICTS, true)).toBe(0);
    // …and the same list still counts when DND is off (the gate is the only difference).
    expect(appUnread(list, "messages", DICTS, false)).toBe(2);
  });

  it("does not count a push row the user has already read (REQ-A1135)", () => {
    // A read push row is *not* removed (`markNotifRead` keeps it, dimmed), so counting rows
    // here would leave the tile badged forever after the user opened the notification.
    const rows: Notif[] = [
      notif("信息", "a"),
      { ...notif("信息", "b"), source: "push", read: false },
      { ...notif("信息", "c"), source: "push", read: true },
    ];
    expect(appUnread(rows, "messages", DICTS, false)).toBe(2);
  });

  it("still counts a flagless shell row, which is unread until it is *removed*", () => {
    // "No flag" is unread, not read: shell-made rows are deleted when opened, so a listed one
    // is genuinely pending. `read === false` would wrongly drop it.
    expect(appUnread([notif("信息", "a")], "messages", DICTS, false)).toBe(1);
    expect(appUnread([{ ...notif("信息", "a"), read: false }], "messages", DICTS, false)).toBe(1);
  });
});

describe("dockBadgeTotal", () => {
  it("is the number of rows the notification centre is holding", () => {
    expect(dockBadgeTotal([notif("信息"), notif("邮件", "m")], false)).toBe(2);
    expect(dockBadgeTotal([], false)).toBe(0);
  });

  it("collapses to 0 under Do-Not-Disturb", () => {
    expect(dockBadgeTotal([notif("信息")], true)).toBe(0);
  });

  it("drops the rows already read, so the OS icon's number can go down (REQ-A1135)", () => {
    const rows: Notif[] = [
      notif("信息", "a"),
      { ...notif("信息", "b"), source: "push", read: true },
    ];
    expect(dockBadgeTotal(rows, false)).toBe(1);
  });
});

describe("setDockBadge", () => {
  it("reports success from the diagnostics ledger even though the reply is null", async () => {
    installHost(async () => null);
    // The host answers `()` → `null`, the same value the bridge uses for a failure. Reading
    // the value would say `false` here; the ledger is what distinguishes them.
    expect(await setDockBadge("3")).toBe(true);
  });

  it("reports failure when the host refuses (the bridge throws)", async () => {
    installHost(async () => {
      throw new Error("no main window");
    });
    expect(await setDockBadge("3")).toBe(false);
  });

  it("reports failure when there is no bridge at all", async () => {
    delete (globalThis as { window?: unknown }).window;
    expect(await setDockBadge("3")).toBe(false);
  });

  it("passes the label through, and `null` means clear", async () => {
    const seen: Array<unknown> = [];
    installHost(async (_cmd, args) => {
      seen.push(args);
      return null;
    });
    await setDockBadge("99+");
    await setDockBadge(null);
    expect(seen).toEqual([{ label: "99+" }, { label: null }]);
  });
});

/**
 * The **attention** half (REQ-A589): `dock_request_attention` had no caller at all until a push
 * delivery that lands while the shell is in the background became one.
 */
describe("Dock attention (the half that had no caller)", () => {
  it("only asks for attention when something arrived **and** the user is not looking", () => {
    expect(shouldRequestAttention(1, true)).toBe(true);
    expect(shouldRequestAttention(3, true)).toBe(true);
    // A delivery while the window is on screen needs no bounce — the banner is already there.
    expect(shouldRequestAttention(1, false)).toBe(false);
    // Nothing new (a silent/badge-only push projects to nothing) is never a reason to bounce.
    expect(shouldRequestAttention(0, true)).toBe(false);
    expect(shouldRequestAttention(0, false)).toBe(false);
  });

  it("reads the background state from `document.visibilityState`, and never claims it without a document", () => {
    const g = globalThis as unknown as { document?: unknown };
    const original = Object.getOwnPropertyDescriptor(g, "document");
    const withVisibility = (value: string) =>
      Object.defineProperty(g, "document", { value: { visibilityState: value }, configurable: true });
    try {
      // No `document` at all ⇒ never claim the user is away. (`undefined`, not a deleted
      // property: another suite in the same process may have registered a DOM, and this test
      // must leave the global exactly as it found it.)
      Object.defineProperty(g, "document", { value: undefined, configurable: true });
      expect(shellIsBackground()).toBe(false);
      withVisibility("visible");
      expect(shellIsBackground()).toBe(false);
      withVisibility("hidden");
      expect(shellIsBackground()).toBe(true);
    } finally {
      if (original) Object.defineProperty(g, "document", original);
      else delete g.document;
    }
  });

  it("sends `level: \"info\"` (one bounce) and reports the host's answer from the ledger", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    installHost(async (cmd, args) => {
      calls.push({ cmd, args });
      return null; // `Result<(), String>` answers `()` ⇒ null on the wire, even on success
    });
    expect(await requestAttention()).toBe(true);
    expect(calls).toEqual([{ cmd: "dock_request_attention", args: { level: "info" } }]);
  });

  it("can ask for the critical level, and the wire value is lowercase", async () => {
    const seen: Array<unknown> = [];
    installHost(async (_cmd, args) => {
      seen.push(args);
      return null;
    });
    expect(await requestAttention("critical")).toBe(true);
    expect(seen).toEqual([{ level: "critical" }]);
  });

  it("reports failure when the host refuses (no Dock surface) or there is no bridge", async () => {
    installHost(async () => {
      throw new Error("unsupported platform");
    });
    expect(await requestAttention()).toBe(false);
    delete (globalThis as { window?: unknown }).window;
    expect(await requestAttention()).toBe(false);
  });
});

// ─── REQ-A670: the host *parses* the label this module paints ───────────────────────────────
//
// `badgeText`'s doc states a contract with the other side: "*`dock_badge.rs::count_from_label`
// reduces whatever this returns to its **leading integer** (`"99+"` → 99). Changing the suffix
// convention here means the host rule has to change with it — otherwise the OS icon goes blank
// at the cap while the tile still paints*". Each half pins its own literal (this file pins
// `"99+"`, `dock_badge.rs`'s own test pins `count_from_label(Some("99+")) == Some(99)`) and
// **nothing** ties the two: a producer that paints the digits anywhere but the front (e.g.
// `"+99"`) or a host rule that becomes a whole-string parse — the exact pre-REQ-A412 bug — is a
// *silent* divergence on the Windows/Linux taskbar, which is what the two halves exist to
// prevent. These tests read the Rust rule and run this module's output through it.

describe("badgeText's label == what dock_badge.rs::count_from_label reads", () => {
  /** The host's rule (its three steps) plus the label bound that runs before it. */
  function hostRule(): { body: string; maxChars: number } {
    const src = readFileSync(new URL("../../../../src/dock_badge.rs", import.meta.url), "utf8");
    const at = src.indexOf("pub fn count_from_label(label: Option<&str>) -> Option<i64> {");
    expect(at, "count_from_label not found in amos-tauri/src/dock_badge.rs").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}", at));
    const m = /pub const MAX_BADGE_CHARS: usize = (\d+);/.exec(src);
    expect(m, "MAX_BADGE_CHARS not found in dock_badge.rs").not.toBeNull();
    return { body, maxChars: Number(m?.[1]) };
  }

  it("the rule is still 'the leading integer', and the painted label reads back as the count", () => {
    const { body, maxChars } = hostRule();
    // The rule's three steps, asserted as **source anchors**: this is what catches a host-side
    // rewrite (the anchors are the only thing a *rule* change can fail — the mirrored function
    // below would happily keep reading the old way).
    expect(body).toContain("trim_start()");
    expect(body).toContain("take_while(|c| c.is_ascii_digit())");
    expect(body).toContain("parse::<i64>()");
    // Truncation (which runs before the rule, in `apply`) must not be able to reach the digits:
    // 12 chars is the host's bound and 3 is what the cap paints.
    expect(maxChars).toBeGreaterThan(0);

    // The mirrored rule, pinned above: trim, then the leading ASCII digits.
    const hostCount = (label: string | null): number | null => {
      const digits = (label ?? "").trimStart().match(/^\d*/)?.[0] ?? "";
      return digits === "" ? null : Number(digits);
    };
    for (const n of [1, DOCK_BADGE_MAX - 1, DOCK_BADGE_MAX, DOCK_BADGE_MAX + 1, 1234, 999_999]) {
      const painted = badgeText(n);
      expect(painted, `badgeText(${n})`).not.toBeNull();
      // `null` here is the failure the doc names: the host would *clear* the taskbar badge while
      // the tile keeps painting — exactly when the unread count is highest.
      expect([n, hostCount(painted)]).toEqual([n, Math.min(n, DOCK_BADGE_MAX)]);
      expect(painted!.length, `badgeText(${n}) = ${painted}`).toBeLessThanOrEqual(maxChars);
    }
  });
});
