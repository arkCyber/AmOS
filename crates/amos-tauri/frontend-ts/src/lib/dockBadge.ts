/**
 * dockBadge.ts — the Dock's unread badge: the pure math + the one bridge call that
 * paints the **real** macOS Dock icon. (REQ-A549)
 *
 * ## The defect this closes
 *
 * The touch home screen has painted an unread count on its dock icons since the
 * notification store existed (now through [`appUnread`], shared with the desktop Dock).
 * The **desktop** Dock
 * (`Dock.svelte`) never did: on the desktop form, unread 信息 / 邮件 were invisible on the
 * Dock even when the notification centre listed them — the same notification rendered a
 * badge in one shell and nothing in the other.
 *
 * And the OS's own Dock icon (one app: AmOS) never carried the aggregate either, even
 * though the host has had `dock_badge_set` ready since REQ-A389
 * (`crates/amos-tauri/src/dock_badge.rs`) and `tauri-command-allowlist.json` recorded the
 * gap verbatim: *"Nothing calls them: the Dock tile in this shell does not paint a badge"*.
 *
 * ## One source for the numbers
 *
 * Both surfaces read the **same** functions here, so the count on a tile and the count on
 * the OS Dock icon cannot disagree:
 *   * [`appUnread`] — one app's tile count (0 under Do-Not-Disturb, mirroring the shell);
 *   * [`badgeText`] — what a tile paints (`null` at 0, `99+` past the cap — macOS's own
 *     ellipsis, and the same bound the touch dock uses);
 *   * [`dockBadgeTotal`] — the aggregate the OS Dock icon shows.
 *
 * ## The bridge call is the one writer
 *
 * macOS's Dock tile is a per-app singleton; `dock_badge.rs` is explicit that hosting the
 * write in Rust gives "exactly one writer". The frontend must therefore call it from
 * exactly one place: the desktop Dock, which only the `main` window mounts. App windows
 * (each its own WebView) never call it — they read the same shared store for their own
 * tiles instead.
 */

import { invoke, bridgeDiag } from "./backend";
import type { Notif } from "./settings";
import { countNotifsOfApp } from "./notifApp";

/**
 * The count past which a tile paints `99+` instead of the number.
 *
 * macOS/iOS use the same ellipsis; the touch dock already caps here, and two shells
 * showing different text for the same count would be a needless divergence.
 */
export const DOCK_BADGE_MAX = 99;

/**
 * A row the user has not yet dealt with — the only kind a badge counts.
 *
 * **"Stored" is not "unread."** A **push** row carries the device's own read flag and
 * survives being read: `settings.ts::markNotifRead` sets `read: true` and the row stays
 * listed (dimmed) until dismissed, so counting *rows* leaves a badge that never goes down —
 * the exact failure `settings.ts::unreadCount` exists to avoid. The reverse does not hold
 * either: a shell-made row has no flag at all, and "no flag" means unread, not read (those
 * rows are *removed* when opened — `removeAppNotifs`), so the test is `read !== true`, not
 * `read === false`.
 */
function stillUnread(n: Notif): boolean {
  return n.read !== true;
}

/**
 * One app's unread count, or 0 while Do-Not-Disturb is on.
 *
 * `appId` is the app's **id**, not a name: a stored row's `app` is a display string in the
 * locale that was active when it was pushed, so the two shells must ask "did this row come
 * from this app?" backwards (`lib/notifApp.ts`) rather than resolve the id forward to one
 * locale's name — the forward form silently reads zero for every row written under another
 * locale. Both shells pass every locale's dictionary, exactly as the notification centre
 * does.
 */
export function appUnread(
  list: readonly Notif[],
  appId: string,
  dicts: readonly Record<string, string>[],
  quiet: boolean,
): number {
  if (quiet) return 0;
  return countNotifsOfApp(list.filter(stillUnread), appId, dicts);
}

/**
 * Tile text for a count, or `null` when there is nothing to paint.
 *
 * `null` (not `""`) is the honest answer for "no badge": an empty string would paint an
 * empty red circle — the visible regression `dock_badge.rs::sanitize_label` guards against
 * on the host side for the very same reason.
 *
 * The `"99+"` form is also read by the host: non-macOS badge surfaces take a *count*, so
 * `dock_badge.rs::count_from_label` reduces whatever this returns to its **leading
 * integer** (`"99+"` → 99). Changing the suffix convention here means the host rule has to
 * change with it — otherwise the OS icon goes blank at the cap while the tile still paints
 * (the divergence the two halves used to have).
 */
export function badgeText(count: number): string | null {
  if (!Number.isFinite(count)) return null;
  const n = Math.trunc(count);
  if (n <= 0) return null;
  return n > DOCK_BADGE_MAX ? `${DOCK_BADGE_MAX}+` : String(n);
}

/**
 * The aggregate the **OS Dock icon** shows: how many items still need the user's attention,
 * or 0 under Do-Not-Disturb.
 *
 * **"Listed" is not "unread"** (see [`stillUnread`]): a push row the user has already read
 * stays in the notification centre *and* carries `read: true`, so counting rows would leave
 * the OS icon showing a number that never goes down. Shell-made rows are counted (they are
 * *removed* when opened, so a listed one is genuinely pending). Summing per-app tile counts
 * instead would silently drop the notifications of apps that are not on the Dock at all.
 */
export function dockBadgeTotal(notifs: readonly Notif[], quiet: boolean): number {
  if (quiet) return 0;
  return notifs.filter(stillUnread).length;
}

/**
 * Paint (or clear) the real Dock icon's badge. `false` = no bridge, or the host refused.
 *
 * The command answers with `()` — which is `null` on the wire — and the bridge expresses
 * a *failure* as `null` too, so `result !== null` would be **false even on success**. The
 * only place the two are distinguishable is the diagnostics ledger, which `invoke` writes
 * on every call (`bridgeDiag`). This is the same rule `lib/spaces.ts` uses for its
 * unit-reply mutations (REQ-A513); it is stated here rather than shared, because the two
 * modules take different arguments and a shared helper would have to be generic over a
 * command name to stay honest.
 *
 * The host sanitizes (truncates, collapses whitespace to a clear), so callers pass the raw
 * text — `null` only for "clear", never `""` (see `badgeText`).
 */
export async function setDockBadge(label: string | null): Promise<boolean> {
  await invoke("dock_badge_set", { label });
  return bridgeDiag("dock_badge_set").ok;
}

/**
 * Whether this shell window is in the **background** — i.e. the user is not looking at it.
 *
 * `document.visibilityState` is the signal: it is standard, needs no host command, and goes
 * `"hidden"` exactly when the window is minimized / not being presented. That is the state in
 * which a delivery can be *missed*.
 *
 * `document.hasFocus()` is deliberately **not** used (REQ-A589): on the desktop an AmOS *app
 * window* is its own WebView, so the launcher window's `hasFocus()` is `false` while the user is
 * actively working inside AmOS — bouncing the Dock then would be a false alarm, and a false
 * bounce is user-visible noise. The host cannot help either: it exposes no "is the application
 * frontmost" query, and inventing one from `window` focus would answer a different question.
 *
 * No DOM at all (a test, a worker) ⇒ `false`: never claim the user is away.
 */
export function shellIsBackground(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState !== "visible";
}

/**
 * Should a delivery that just landed bounce the Dock? (pure)
 *
 * Two conditions, both necessary: something the user can actually open arrived (`added > 0` — a
 * silent/badge-only push projects to nothing and must not bounce), and this window is in the
 * background. Kept pure so both branches are testable without a document.
 */
export function shouldRequestAttention(added: number, background: boolean): boolean {
  return added > 0 && background;
}

/**
 * Bounce the Dock icon (`dock_request_attention`). `false` = no bridge, no Dock on this platform,
 * or the host refused.
 *
 * `level: "info"` bounces **once** and stops; `"critical"` keeps bouncing until the user clicks
 * the icon. Only `"info"` is ever used from a push delivery here: the payload carries no
 * interruption level, so claiming "critical" would invent urgency the sender never expressed
 * (`AttentionLevel` is `#[serde(rename_all = "lowercase")]` — the wire values are `"info"` /
 * `"critical"`).
 *
 * Same success/failure shape as [`setDockBadge`]: the command answers `()`, which reaches the
 * bridge as `null` — the very value a failure produces — so the answer comes from the
 * diagnostics ledger. The reply is declared as `null` (the unit wire value) rather than left
 * untyped, so `scripts/tauri-reply-scan.mjs` can compare it with `Result<(), String>`.
 */
export async function requestAttention(level: "info" | "critical" = "info"): Promise<boolean> {
  await invoke<null>("dock_request_attention", { level });
  return bridgeDiag("dock_request_attention").ok;
}
