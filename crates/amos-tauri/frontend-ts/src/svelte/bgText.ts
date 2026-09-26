/**
 * Background (non-reactive) localized text, for the OS surfaces produced **outside**
 * the Svelte render tree.
 *
 * `t()` from `./locale.svelte` is the shell's only `t`, and it is reactive on purpose:
 * that is how a live locale switch reaches the screen. But the timer / reminder /
 * calendar watchers run on a `setInterval` (and on store-change events), never during a
 * render — there is no reactive reader to call `t()` from. And an OS notification is a
 * **stored display string**, not a key: its text is resolved once, when the alert is
 * pushed.
 *
 * Those producers used to reach straight into the Chinese dictionary
 * (`zh["app.clock"]`), so a user running the English UI got a Chinese app name and
 * title in every OS notification — a surface that follows neither the reactive `t()`
 * nor any scan (`zh[...]` is a dictionary lookup, so a hardcoded-copy scan cannot see
 * it). `currentLocale()` is the framework-free reader this exists for: it reads the
 * same shared key the shell writes (`amos-ui.locale`), so the text follows the locale
 * in effect at push time.
 *
 * With no locale set the result is `"zh"` — the same default `currentLocale()` has, so
 * anything that never sets a locale keeps the behaviour it had.
 */
import type { MessageKey } from "../i18n/locales/zh";
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";
import { currentLocale, translate } from "./i18n";

/** Translate `key` in the locale in effect **right now** (no reactivity). */
export function bgT(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(currentLocale() === "en" ? en : zh, key, params);
}
