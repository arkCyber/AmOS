/**
 * bundleHost.ts — client for the **web-bundle runtime host**.
 *
 * An installed third-party app is a `tar.gz` of static files unpacked under
 * `<install root>/<id>/` (`amos_appstore::WebInstaller`). It runs at its **own
 * origin** on the `amos-app://` custom protocol, which the Rust gateway already
 * serves (`amos-appstore::host::serve_bundle`, `docs/pwa-index.md` §1): the
 * bundle's own `index.html`, `/app.js`, `/style.css` are same-origin with each
 * other, so a real multi-page / ESM bundle works, and fetching its own assets
 * needs no CORS header.
 *
 * Two things this module refuses to guess:
 *
 * 1. **The URL comes from Rust** (`appstore_bundle_entry`). On Windows/Android a
 *    custom scheme has no native support and wry rewrites `{scheme}://{host}` to
 *    `http://{scheme}.{host}`; a literal here would be dead there. Rust also
 *    checks that the app is *actually installed* and that its declared entry
 *    really is a servable file inside the bundle, so a "runnable" URL is never
 *    handed out for something that cannot be served.
 * 2. **The sandbox flags are a decision, not a default** — see
 *    [`BUNDLE_FRAME_SANDBOX`].
 */
import { bridgeDiag, invoke, type BridgeDiag } from "./backend";
import { amosWarn } from "./debugLog";

/** What a bundle's entry looks like to the host. Mirrors `appstore::BundleEntry`. */
export interface BundleEntry {
  /** Platform-correct absolute URL of the entry document. */
  url: string;
  /** The entry file inside the bundle (`amos-app.json`'s `start`). */
  start: string;
}

/** Why a bundle could not be hosted. Each is a different thing to tell the user. */
export type BundleHostFailure =
  /** No Tauri bridge: not running inside AmOS. */
  | "offline"
  /** The host has no web-install directory, or the app is not installed / has no bundle. */
  | "unavailable"
  /** The host answered with something we refuse to put in an iframe `src`. */
  | "blocked";

/** The outcome of resolving a bundle entry. */
export type BundleEntryResult =
  | { kind: "ok"; entry: BundleEntry }
  | { kind: "failed"; reason: BundleHostFailure; detail: string };

/**
 * The iframe `sandbox` a hosted bundle gets.
 *
 * * `allow-scripts` — a web app without JS is not a web app.
 * * `allow-same-origin` — keeps the frame's **real** origin (`amos-app://<id>`),
 *   which is what makes the bundle same-origin with its own assets and lets it
 *   use its own storage. This is the combination MDN warns about *only when the
 *   frame is same-origin with its parent* (then it could reach up and remove its
 *   own sandbox). A bundle is never same-origin with the shell: the shell is
 *   `tauri://localhost` / `http://tauri.localhost`, the bundle is
 *   `amos-app://<id>` / `http://amos-app.<id>` — different scheme *and* host. So
 *   the warning does not apply, and without this flag a bundle could not even
 *   `fetch` its own files.
 * * `allow-forms` — a form that silently does nothing is worse than a form.
 *
 * **Deliberately NOT granted:** `allow-top-navigation` (a bundle can never
 * navigate the shell away from AmOS), `allow-popups` (a sandboxed frame cannot
 * open a window we have no manager for), `allow-modals` (no `alert`/`confirm`
 * hijacking the shell), `allow-pointer-lock`, `allow-presentation`.
 */
export const BUNDLE_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";

/**
 * Only a URL on our own custom protocol may be framed.
 *
 * The URL is host-supplied, so this is a cheap backstop with a loud failure
 * rather than a silent `src` that could be `javascript:`/`data:` if the host ever
 * regressed. Both real forms are accepted: `amos-app://<id>/…` (macOS/iOS/Linux)
 * and `http://amos-app.<id>/…` (Windows/Android).
 */
export function isFrameableBundleUrl(url: string): boolean {
  if (typeof url !== "string" || url === "" || /\s/.test(url)) return false;
  return /^amos-app:\/\/[a-z0-9._-]+\//.test(url) || /^https?:\/\/amos-app\.[a-z0-9._-]+\//.test(url);
}

/** Normalise the host's reply; `null` when we would not frame it. */
export function normalizeBundleEntry(raw: unknown): BundleEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.url !== "string" || typeof o.start !== "string") return null;
  if (!isFrameableBundleUrl(o.url)) return null;
  return { url: o.url, start: o.start };
}

/** Reject anything that is not a plain non-empty string (ids come from the shell). */
function cleanId(mid: string): string | null {
  const trimmed = mid.trim();
  return trimmed === "" ? null : trimmed;
}

function formatDetail(d: unknown): string {
  if (typeof d === "string") return d.trim() === "" ? "command failed" : d;
  if (d instanceof Error) return d.message;
  return d === undefined || d === null ? "command failed" : String(d);
}

/**
 * Turn a `null` reply into an honest reason, using the bridge's own diagnostic.
 *
 * Necessary because the shared bridge collapses **both** "not running inside
 * AmOS" and "the host rejected the call" into `null` — and here those are
 * different things to say (and the host's rejection text, e.g. `no web install
 * dir (set AMOS_APPSTORE_INSTALL_DIR)`, is exactly what the user needs). Pure, so
 * every branch is testable without a bridge.
 *
 * Note: `bridgeDiag()` is the bridge's *last* outcome, so a concurrent command
 * could overwrite it between our call and this read. That only affects the
 * wording of an already-failed load, never a success.
 */
export function bundleFailureFromDiag(diag: BridgeDiag): {
  reason: BundleHostFailure;
  detail: string;
} {
  if (!diag.ok) {
    return diag.kind === "not-bridged"
      ? { reason: "offline", detail: "no Tauri bridge" }
      : { reason: "unavailable", detail: formatDetail(diag.detail) };
  }
  // The bridge reported success and yet produced nothing: we will not frame
  // "nothing".
  return { reason: "blocked", detail: "host returned no entry" };
}

/**
 * Resolve the entry URL for a store manifest id. Never throws: a failure carries
 * *which* failure so the host screen can say it instead of showing a blank frame.
 */
export async function fetchBundleEntry(mid: string): Promise<BundleEntryResult> {
  const id = cleanId(mid);
  if (id === null) {
    return { kind: "failed", reason: "blocked", detail: "empty app id" };
  }
  const raw = await invoke<unknown>("appstore_bundle_entry", { id });
  if (raw === null) {
    return { kind: "failed", ...bundleFailureFromDiag(bridgeDiag()) };
  }
  const entry = normalizeBundleEntry(raw);
  if (entry === null) {
    amosWarn("bundle", "host returned an un-frameable bundle entry", { id, raw });
    return { kind: "failed", reason: "blocked", detail: "refused to frame the host's URL" };
  }
  return { kind: "ok", entry };
}
