/**
 * Boot-time **default-on capabilities** for built-in apps (REQ-A380).
 *
 * The OS ships with a deny-by-default capability ledger, so a first run of
 * `CameraApp` or `VoiceMemosApp` had to ask the user before it could call
 * `getUserMedia` — even though the camera and microphone are the headline
 * features of those screens and the user just opened them on purpose.
 *
 * This module is the **single seam** that:
 *   1. Marks a built-in app's *expected default* capabilities (the same set
 *      `PermissionsApp` renders in the "已默认启用" group). Today the only
 *      defaults are:
 *        • `camera`     → app `camera` (the Camera screen itself).
 *        • `microphone` → apps `vmemos`, `ai` (the resident voice mic),
 *                         `interpreter` (the Interp screen).
 *      (Magnifier and others still do an in-app allow — they pre-date the
 *      default-on rule and are outside the headline camera/voice path.)
 *   2. Seeds them in the local ledger **once** (`amos.permissions` is only
 *      touched when a key is missing — never on re-boot), then mirrors to the
 *      daemon via the `osPermissions` seam (so the audit trail is honest too).
 *
 * Why the ledger mirror is best-effort, not awaited: the rule "default-on so the
 * screen opens" must not depend on the daemon being online. UI gates read the
 * ledger; the daemon is for audit (`PermissionsApp`'s recent-access section).
 *
 * Why a separate module from `osPermissions.ts`:
 *   • `osPermissions` is *user-initiated* grant/revoke (privacy dashboard).
 *   • `osCapabilities` is *system-default* — a different lifecycle, different
 *     tests, no UI can revoke from here. The two never call each other.
 */
import {
  CAPABILITIES,
  loadLedger,
  type Capability,
  type PermissionLedger,
} from "../lib/permissions";
import { amosWarn } from "../lib/debugLog";
import { grantCapability } from "./osPermissions";

/**
 * The default-on matrix: app id → the capabilities granted to it on first
 * boot. Order matters only for tests; the seed is idempotent.
 *
 * * `camera`     → only the Camera screen itself (Magnifier opts in explicitly
 *                  because it shares the viewfinder with photo capture and is
 *                  rarely the first place a user touches the camera).
 * * `microphone` → vmemos (Voice Memos recorder), ai (resident voice mic),
 *                  interpreter (the Interp screen).
 */
export const DEFAULT_CAPABILITIES: Readonly<Record<string, ReadonlyArray<Capability>>> = Object.freeze(
  {
    camera: ["camera"],
    vmemos: ["microphone"],
    ai: ["microphone"],
    interpreter: ["microphone"],
  },
);

/**
 * The set of capabilities for which we keep an explicit *default-on* matrix.
 * Mirrors `DEFAULT_CAPABILITIES`; uses the same vocabulary as the dashboard.
 */
export const DEFAULT_ON_CAPABILITIES: ReadonlyArray<Capability> = Object.freeze([
  "camera",
  "microphone",
]);

/**
 * An app id holding one of `DEFAULT_ON_CAPABILITIES` via this seam is rendered
 * as a *default-on* row in `PermissionsApp` ("已默认启用" / "Default-on"),
 * instead of "用户授权". Used by the dashboard to render the badge.
 */
export function isDefaultOnGrant(
  appId: string,
  cap: Capability,
): boolean {
  const caps = DEFAULT_CAPABILITIES[appId] ?? [];
  return caps.includes(cap);
}

/**
 * Apply the default-on matrix on every boot. Mirrors `seedContactsOnce` /
 * `seedVoiceMemos`: defaults are **system policy**, not user-asserted grants —
 * the user explicitly walks to the Privacy dashboard to revoke them, and that
 * path (`revokeCapability`) keeps the entry off for the rest of the session.
 * A re-boot re-asserts the matrix so a user who flips "off then on then off"
 * in Privacy doesn't end up with a dead Camera screen the next launch.
 *
 * Each entry goes through `grantCapability` so the daemon audit mirror fires
 * exactly once for the entry — both the local ledger write and the daemon RPC.
 *
 * Returns the resulting ledger so the shell/tests can compare.
 */
export function seedDefaultCapabilities(): PermissionLedger {
  let ledger = loadLedger();
  for (const [appId, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
    for (const cap of caps) {
      ledger = grantCapability(appId, cap);
    }
  }
  return ledger;
}

/**
 * Companion of {@link isDefaultOnGrant} for the candidate list. Returns the
 * built-in apps that should appear in a `cap`'s permission dashboard group,
 * preserving the order they were declared in `DEFAULT_CAPABILITIES` (the row
 * the user is editing). Empty for caps the OS does not default-on.
 *
 * The dashboard unions this into its row (`PermissionsApp.candidatesFor`), which is
 * what keeps a default-on grant **reversible in the same session**: without it the
 * row would not offer the app, and revoking it (the holder chip is always there)
 * would leave no way back on until the next boot re-seeds the matrix.
 */
export function defaultAppsFor(cap: Capability): string[] {
  if (!DEFAULT_ON_CAPABILITIES.includes(cap)) return [];
  const out: string[] = [];
  for (const [appId, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
    if (caps.includes(cap)) out.push(appId);
  }
  return out;
}

/**
 * Ensure `seedDefaultCapabilities` runs at most once per process. Called from
 * the shell's `onMount` and from any test that needs the seeded state.
 */
let seeded = false;
export function ensureDefaultCapabilitiesSeeded(): void {
  if (seeded) return;
  seeded = true;
  // Checked **here**, at the one moment the matrix becomes policy: if the matrix names a
  // capability the OS does not declare as default-on, then `defaultAppsFor` hides that
  // app from the capability's row while `isDefaultOnGrant` still stars it in the holder
  // list — a grant the dashboard can revoke but never re-offer. A warning at boot is what
  // makes the invariant observable instead of a rule only the tests knew (REQ-A425).
  if (!defaultCapabilitiesInvariant()) {
    amosWarn(
      "permissions",
      "the default-on capability matrix names a capability the OS does not default-on; that row will hide the app",
      { defaults: DEFAULT_ON_CAPABILITIES },
    );
  }
  seedDefaultCapabilities();
}

/** Reset the seeded-once latch (tests only — the convention every reset fn here follows). */
export function resetDefaultCapabilitiesSeedForTest(): void {
  seeded = false;
}

/**
 * Sanity guard: there is no default-on entry for capabilities the OS does not
 * default-on. This is the invariant the dashboard's badge relies on — it renders the ★
 * from `isDefaultOnGrant` and the per-capability row from `defaultAppsFor`, and those
 * two must agree or a grant could be revoked with no way back on. Called once at boot
 * from {@link ensureDefaultCapabilitiesSeeded}.
 */
export function defaultCapabilitiesInvariant(): boolean {
  for (const cap of CAPABILITIES) {
    if (!DEFAULT_ON_CAPABILITIES.includes(cap)) {
      for (const [, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
        if (caps.includes(cap)) return false;
      }
    }
  }
  return true;
}
