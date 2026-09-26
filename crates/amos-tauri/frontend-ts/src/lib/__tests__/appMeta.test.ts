/**
 * appMeta.test.ts — `appIdForDisplayName`: the reverse of `appMetaById`.
 *
 * A stored notification names its **sender** as a display string, never as an app id
 * (every `addNotif` call site writes `zh["app.mail"]` / `bgT("app.clock")` / a push
 * payload's free text). So "which app is this row from?" is a *reverse* lookup, and both
 * the notification centre's tap-to-open and the Dock's unread badge need it.
 *
 * The three cases that matter, each because a wrong answer has a different consequence:
 *
 *   1. the **Chinese** name resolves (the four apps that write `zh[...]` literally, and the
 *      badge path that has always assumed Chinese);
 *   2. the **English** name resolves *to the same id* (the timer / reminder / calendar
 *      producers write the name in the locale in effect at push time via `bgText.ts`, so an
 *      English-UI user's rows say "Clock", not "时钟");
 *   3. a name that matches **nothing** is `null` — a push payload's free-text `app`, the
 *      telemetry spy's own label. The caller must render no affordance rather than invent a
 *      destination (the F-SH-433 shape, one surface over).
 */
import { describe, expect, test } from "bun:test";
import { appIdForDisplayName } from "../appMeta";
import { zh } from "../../i18n/locales/zh";
import { en } from "../../i18n/locales/en";

const DICTS = [zh, en] as readonly Record<string, string>[];

describe("appIdForDisplayName — reverse lookup of an app's display name", () => {
  test("a Chinese name resolves to its app id (what the zh-literal producers write)", () => {
    expect(appIdForDisplayName(zh["app.mail"], DICTS)).toBe("mail");
    expect(appIdForDisplayName(zh["app.messages"], DICTS)).toBe("messages");
    expect(appIdForDisplayName(zh["app.phone"], DICTS)).toBe("phone");
    expect(appIdForDisplayName(zh["app.clock"], DICTS)).toBe("clock");
    expect(appIdForDisplayName(zh["app.calendar"], DICTS)).toBe("calendar");
    expect(appIdForDisplayName(zh["app.reminders"], DICTS)).toBe("reminders");
  });

  test("the English name resolves to the SAME id (what bgT writes under an English UI)", () => {
    // The row is stored as a string resolved at push time, so a locale switch must not
    // change which app it points at — nor stop it resolving at all.
    expect(appIdForDisplayName(en["app.mail"], DICTS)).toBe("mail");
    expect(appIdForDisplayName(en["app.clock"], DICTS)).toBe("clock");
    expect(appIdForDisplayName(en["app.calendar"], DICTS)).toBe("calendar");
  });

  test("a name that matches no built-in app is null — never a guessed id", () => {
    // A push payload's `app` is free text (the device-side test even feeds "  Mail  "), and
    // the telemetry spy labels its own rows 「外发泄漏审计」. Neither is an app.
    expect(appIdForDisplayName("MyApp", DICTS)).toBeNull();
    expect(appIdForDisplayName(zh["spy.app"], DICTS)).toBeNull();
    expect(appIdForDisplayName("Mail", [zh])).toBeNull(); // no English dict ⇒ no match, not a guess
  });

  test("an absent / blank name is null (a row without a sender names no app)", () => {
    expect(appIdForDisplayName(undefined, DICTS)).toBeNull();
    expect(appIdForDisplayName("", DICTS)).toBeNull();
    expect(appIdForDisplayName("   ", DICTS)).toBeNull();
  });

  test("a padded name still resolves (a push payload is external input)", () => {
    expect(appIdForDisplayName(`  ${zh["app.mail"]}  `, DICTS)).toBe("mail");
  });
});
