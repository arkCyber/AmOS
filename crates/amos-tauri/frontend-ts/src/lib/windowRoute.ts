/**
 * windowRoute.ts — which app a **window** was created for.
 *
 * The Rust host builds every app window as `index.html#window=<label>`
 * (`crates/amos-tauri/src/wm.rs`, `WmEvent::Created` → `WebviewWindowBuilder`)
 * with the comment "so the boot script auto-navigates to that app's screen".
 * Nothing read that fragment until this module existed, so an app window — and
 * therefore **each pane of a split**, which is a tablet's whole point
 * (`LayoutPolicy::of(Tablet).multi_window`) — opened onto the launcher instead of
 * its app: two panes side by side showing two copies of the home screen.
 *
 * ## Labels carry an *instance* (REQ-A473)
 *
 * Since the identity model landed, a window is not the same thing as an app: one app may
 * own several windows, and the host labels them `files`, `files_2`, `files_3`
 * (`crates/amos-wm/src/identity.rs` owns that scheme — `INSTANCE_SEPARATOR` there is the
 * one真源, mirrored here as [`WINDOW_INSTANCE_SEPARATOR`]). The fragment therefore carries
 * a **window label**, and this module resolves it to the app.
 *
 * The decision is pure and strict:
 *   * no fragment → `null` (an ordinary launcher window);
 *   * the **whole** label names a built-in app (`APP_META`) or a store tile
 *     (`store:<manifest.id>`) → that app, instance 1;
 *   * a trailing **numeric** `_<n>` with `2 ≤ n ≤ MAX_WINDOWS_PER_APP` whose base names such
 *     an app → that app, instance `n`;
 *   * **anything else → `null`** — never a guessed app id, the same
 *     "unknown → None, never a wrong guess" rule `FormFactor::parse` follows.
 *
 * The suffix is checked **first**, which is the host's own rule rather than a preference:
 * `identity.rs` forbids the separator inside an app id, so a label ending in a numeric
 * suffix was *created* as an instance by the host, and resolving it as a whole would ask
 * the loader for an app that was never registered. The numeric requirement is what keeps
 * real ids like `store:org.amos.some_app` safe — `app` is not a number, so nothing is
 * stripped and the whole label is looked up (see [`splitWindowLabel`]).
 *
 * The launcher's own label needs no special case: a launcher window carries no
 * fragment, and even if one did, its label is not an app id — so hard-coding the
 * Rust `LAUNCHER_LABEL` here would add a second copy of a constant that could
 * drift, for no behaviour.
 */
import { isKnownApp } from "./appMeta";
import { isExtId } from "./storeApps";

/**
 * The character that separates an app id from its window-instance number.
 *
 * Mirrors `amos_wm::identity::INSTANCE_SEPARATOR` (Rust). It is `_` because Tauri rejects
 * `#` in window labels outright — `Window labels must only include alphanumeric
 * characters, -, /, : and _` (measured 2026-09-19; see that module's docs for why the
 * other two candidates were rejected).
 */
export const WINDOW_INSTANCE_SEPARATOR = "_";

/**
 * The largest window-instance ordinal the host will accept for one app.
 *
 * Mirrors `amos_wm::identity::MAX_WINDOWS_PER_APP` (Rust). The host's `identity_of_label`
 * refuses a suffixed label whose ordinal falls outside `2..=MAX_WINDOWS_PER_APP` with
 * `IdentityRefusal::OrdinalOutOfRange`, so the shell must apply the same ceiling: a label
 * above it was never created by the host, and resolving one here would route the window to
 * an identity the host rejects — a failed window rather than the `null` (home) fallback the
 * strict rule promises. Like the separator, this value is bound to the Rust source by a test
 * (`windowRoute.test.ts`), never trusted as a second hand-typed copy.
 */
export const MAX_WINDOWS_PER_APP = 16;

/** A resolved window label: which app, and which instance of it. */
export interface WindowLabelParts {
  /** The app id the shell's registry can open. */
  app: string;
  /** 1 for the app's first window, `2..` for the ones after it. */
  instance: number;
}

/**
 * Resolve a window label to `{ app, instance }`, or `null` when it names no known app.
 *
 * Pure, and deliberately total: every string either resolves or gets `null`.
 *
 * **Order: a valid instance suffix is stripped first.** That is the host's own rule
 * (`identity.rs`: an app id may not contain the separator), so a label with a numeric
 * `_n` (n ≥ 2) suffix *is* an instance of its prefix — the host created it that way, and
 * resolving it as a whole would make the shell ask for an app the host never registered.
 * The suffix has to be all digits and ≥ 2, which is what keeps a real id such as
 * `store:org.amos.some_app` (or `…demo_v2`) resolving as **itself**: neither `app` nor
 * `v2` is a number, so there is no suffix to strip.
 */
export function splitWindowLabel(label: string | null | undefined): WindowLabelParts | null {
  const raw = (label ?? "").trim();
  if (!raw) return null;
  // 1) A trailing instance suffix, if there is one (see the ordering note above).
  const cut = raw.lastIndexOf(WINDOW_INSTANCE_SEPARATOR);
  if (cut > 0 && cut < raw.length - 1) {
    const suffix = raw.slice(cut + 1);
    if (/^[0-9]+$/.test(suffix)) {
      const instance = Number(suffix);
      const app = raw.slice(0, cut);
      // Instance 1 is spelled bare (the Rust rule): `files_1` is not a second spelling of
      // `files`, so a `_1` label resolves to nothing rather than to a duplicate identity.
      // The ceiling is the host's `MAX_WINDOWS_PER_APP`: above it the ordinal is one the
      // host refuses with `OrdinalOutOfRange`, so it must fall through to `null` here too
      // (see the constant's docs) rather than resolve to a window that cannot exist.
      if (
        Number.isSafeInteger(instance) &&
        instance >= 2 &&
        instance <= MAX_WINDOWS_PER_APP &&
        (isKnownApp(app) || isExtId(app))
      ) {
        return { app, instance };
      }
      // A numeric suffix whose base is not an app is **not** stripped into a guess: fall
      // through, so the whole string gets one more chance as an app id (and then `null`).
    }
  }
  // 2) The whole label as an app id.
  if (isKnownApp(raw) || isExtId(raw)) return { app: raw, instance: 1 };
  return null;
}

/**
 * The app a window label belongs to, or `null` when it names no known app.
 *
 * This is the one function every frontend caller should use for "which app is this
 * window?" — including the boot route below, so the surface a window renders and the app
 * its title shows can never disagree.
 */
export function appOfWindowLabel(label: string | null | undefined): string | null {
  return splitWindowLabel(label)?.app ?? null;
}

/**
 * The app id addressed by a location hash, or `null` when the hash names no app.
 * Accepts the hash with or without its leading `#` (and an empty/absent string).
 */
export function appIdFromHash(hash: string | null | undefined): string | null {
  const raw = (hash ?? "").replace(/^#/, "");
  if (!raw) return null;
  try {
    const label = new URLSearchParams(raw).get("window");
    if (!label) return null;
    return appOfWindowLabel(label);
  } catch {
    return null; // a malformed fragment is not an app id
  }
}

/**
 * The **window label** a location hash addresses, or `null` when it names no known app's
 * window (REQ-A478).
 *
 * `appIdFromHash` deliberately answers with the *app* (that is what the shell's surface
 * state wants), which loses the instance: two windows of one app have the same app id and
 * different labels. A caller that has to name **this window** — the OS window title, so it
 * agrees with the titlebar the window draws itself — needs the label, and this is the one
 * place that hands it over (validated the same way, so an unknown label is still `null`
 * rather than a fabricated identity).
 */
export function windowLabelFromHash(hash: string | null | undefined): string | null {
  const raw = (hash ?? "").replace(/^#/, "");
  if (!raw) return null;
  try {
    const label = new URLSearchParams(raw).get("window");
    if (!label) return null;
    return appOfWindowLabel(label) === null ? null : label;
  } catch {
    return null;
  }
}

