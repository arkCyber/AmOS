/**
 * buildIdentity.ts — build + subject identity stamped onto every enterprise audit record
 * (REQ-A695 / F-SH-155).
 *
 * The audit trail is a compliance artifact: each entry records **which build** produced it and
 * **who** it is attributed to. Both had a defect before this module existed:
 *
 *  - **Version.** `audit.ts` carried its *own* literal copy of the build version (`"0.1.0"`) as the
 *    fallback for the `amos.app.version` store key. Nothing ever wrote that key, so the fallback was
 *    what shipped — a second, unguarded copy of a value that already has a single source
 *    (`AMOS_UI_VERSION`, itself pinned to `package.json` by `version.test.ts`). The first time
 *    someone bumps the version, every audit record silently lies about which build produced it.
 *    The fix is one source: the audit trail reads `AMOS_UI_VERSION` via [`currentAppVersion`]. The
 *    key stays a **host-override seam** (a host may write the device's true build version); the shell
 *    deliberately does **not** write it, so it can never clobber a value the host provided.
 *
 *  - **Subject.** The shell has no login and nothing writes `amos.user.*`. The old fallbacks dressed
 *    that absence up as a real subject (`"user-default"` / `"Default User"`), which a compliance
 *    reader would take for an account named "Default User". We do not invent a person: an absent
 *    identity is stamped as an explicit, self-describing **unattributed** marker, so the record says
 *    "no subject recorded" rather than naming one that does not exist.
 */
import { readStoreValue } from "./amosStore";
import { AMOS_UI_VERSION } from "./version";

/** The host-provided build version (a host may write it; this build reads it, never writes it). */
export const APP_VERSION_KEY = "amos.app.version";
/** Subject fields. Read by the audit trail; written by no component in this build. */
export const USER_ID_KEY = "amos.user.id";
export const USER_NAME_KEY = "amos.user.name";
export const USER_EMAIL_KEY = "amos.user.email";

/** Explicit marker for a record with no attributable subject (this build has no login). */
export const UNATTRIBUTED_USER_ID = "unattributed";
export const UNATTRIBUTED_USER_NAME = "Unattributed";

/**
 * The build version to stamp: the host's override if it wrote one, else the real build constant —
 * **never** a second literal that can drift from `AMOS_UI_VERSION`.
 */
export function currentAppVersion(): string {
  const stored = readStoreValue(APP_VERSION_KEY, "");
  return typeof stored === "string" && stored.trim() !== "" ? stored : AMOS_UI_VERSION;
}

/** The subject fields an audit record carries, with an absent identity marked honestly. */
export interface AuditIdentity {
  userId: string;
  userName: string;
  userEmail?: string;
}

/**
 * Resolve the subject fields. An empty/absent value becomes the unattributed marker — never a
 * fabricated person; an absent email stays `undefined` (the field is optional).
 */
export function resolveAuditIdentity(): AuditIdentity {
  const userId = readStoreValue(USER_ID_KEY, "");
  const userName = readStoreValue(USER_NAME_KEY, "");
  const userEmail = readStoreValue(USER_EMAIL_KEY, "");
  return {
    userId: typeof userId === "string" && userId.trim() !== "" ? userId : UNATTRIBUTED_USER_ID,
    userName: typeof userName === "string" && userName.trim() !== "" ? userName : UNATTRIBUTED_USER_NAME,
    userEmail: typeof userEmail === "string" && userEmail.trim() !== "" ? userEmail : undefined,
  };
}
