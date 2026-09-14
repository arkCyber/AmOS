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
 * The decision is pure and strict:
 *   * no fragment → `null` (an ordinary launcher window);
 *   * a label that names a built-in app (`APP_META`) or a store-installed tile
 *     (`store:<manifest.id>`) → that id;
 *   * **anything else → `null`** — never a guessed app id, the same
 *     "unknown → None, never a wrong guess" rule `FormFactor::parse` follows.
 *
 * The launcher's own label needs no special case: a launcher window carries no
 * fragment, and even if one did, its label is not an app id — so hard-coding the
 * Rust `LAUNCHER_LABEL` here would add a second copy of a constant that could
 * drift, for no behaviour.
 */
import { isKnownApp } from "./appMeta";
import { isExtId } from "./storeApps";

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
    return isKnownApp(label) || isExtId(label) ? label : null;
  } catch {
    return null; // a malformed fragment is not an app id
  }
}
