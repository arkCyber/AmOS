/**
 * notifApp.ts — "which app is this stored notification from?" (REQ-A1134)
 *
 * A notification's `app` field is a **display string**, never an app id: every producer
 * writes the app's localized name *at push time* — `MailApp` / `MessagesApp` / `PhoneApp` /
 * `ContactsApp` write their own name, the timer / reminder / calendar producers write
 * `bgText.ts::bgT(...)`, and a push payload carries free text. So a row's sender can only be
 * named **backwards**, and — because a name is resolved once, when the alert is pushed — a
 * row written while the UI was Chinese keeps a Chinese name after a switch to English.
 *
 * The two shell Dock badges used to answer this question by resolving an app **id** to a
 * single-locale name (`zh[...]`) and then comparing strings. That lookup runs the wrong way:
 * a row written under another locale no longer matches, so the badge silently reads zero —
 * and the timer / reminder / calendar producers already wrote via `bgT`, so the undercount
 * was live, not theoretical. The correct rule is the **reverse** lookup, and the
 * notification centre already had it (`lib/appMeta.ts::appIdForDisplayName`, which tries
 * **every** locale).
 *
 * This module is that one rule, shared: `notifAppId` answers "which built-in app (if any)
 * does this row name?", and the count / drop helpers filter by app **id**. `null` from
 * `notifAppId` is honest — a push payload's free text and a third-party id name no built-in
 * app, so they belong to no tile and the caller must not invent a match.
 *
 * `dicts` is a parameter (rather than an import of the active locale) for the same reason
 * `appIdForDisplayName` takes one: the rule must see **every** locale, and a pure test can
 * drive it without a reactive module.
 */
import { appIdForDisplayName } from "./appMeta";
import type { Notif } from "./settings";

/** Which built-in app this row came from, or `null` for free text / a foreign id. */
export function notifAppId(n: Notif, dicts: readonly Record<string, string>[]): string | null {
  return appIdForDisplayName(n.app, dicts);
}

/** How many stored rows belong to `appId` — locale-independent. */
export function countNotifsOfApp(
  list: readonly Notif[],
  appId: string,
  dicts: readonly Record<string, string>[],
): number {
  let n = 0;
  for (const row of list) if (notifAppId(row, dicts) === appId) n++;
  return n;
}

/** Does the store hold any row from `appId`? */
export function hasNotifsOfApp(
  list: readonly Notif[],
  appId: string,
  dicts: readonly Record<string, string>[],
): boolean {
  return list.some((row) => notifAppId(row, dicts) === appId);
}

/** Drop every row belonging to `appId` (open = read), locale-independent. */
export function withoutAppNotifs(
  list: Notif[],
  appId: string,
  dicts: readonly Record<string, string>[],
): Notif[] {
  return list.filter((row) => notifAppId(row, dicts) !== appId);
}
