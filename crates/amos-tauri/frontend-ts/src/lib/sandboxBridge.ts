/**
 * Web-bundle sandbox capability bridge — **pure decision seam** (Phase 3).
 *
 * A store-installed web-bundle runs in a `srcdoc iframe sandbox="allow-scripts"`
 * (no same-origin), so by default it cannot reach the OS shell or any sensitive
 * resource. When a *real* origin host (future `amos-app://` custom-protocol
 * host, `amos_appstore::serve`) lets a bundle request a sensitive capability,
 * it should send a restricted message of the shape this module validates and
 * decides — and the host must **only** grant when the daemon's `perm_authorize`
 * (the single audited chokepoint) says so.
 *
 * This module is intentionally pure (no DOM / no bridge / no daemon) so the
 * request validation + deny-by-default reply logic is unit-testable, matching
 * `lib/bundle.ts`. Wiring it into an actual `postMessage` listener / real origin
 * host is device/ecosystem work (see `docs/permissions-sandbox-audit-plan.md`
 * Phase 3) and is **not** faked here.
 *
 * Invariant: an unknown resource, a malformed frame, or an *unknown* daemon
 * outcome is always treated as **denied** — a sandboxed third party is never
 * granted on ambiguity.
 */

/** The daemon `Resource` wire keys a web-bundle may request (see privacy.proto). */
export const SANDBOX_RESOURCES = [
  "camera",
  "microphone",
  "contacts",
  "location",
  "storage",
] as const;

export type SandboxResource = (typeof SANDBOX_RESOURCES)[number];

/** Restricted inbound message a web-bundle sends to request a capability. */
export interface SandboxCapabilityRequest {
  type: "capability.request";
  /** One of [`SANDBOX_RESOURCES`]. */
  resource: string;
  /** Caller-chosen token echoed back so the bundle can correlate the reply. */
  requestId: string;
}

/**
 * Outbound reply the host sends back into the sandboxed iframe. `granted` is
 * only ever `true` when the daemon authoritatively granted it.
 */
export interface SandboxCapabilityReply {
  type: "capability.reply";
  requestId: string;
  resource: string;
  granted: boolean;
}

/** Outcome of structurally validating a possibly-hostile inbound frame. */
export type RequestValidation =
  | { kind: "valid"; request: SandboxCapabilityRequest; resource: SandboxResource }
  | { kind: "invalid"; reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** A known daemon wire key, or null for anything else. */
export function parseSandboxResource(s: unknown): SandboxResource | null {
  return typeof s === "string" && (SANDBOX_RESOURCES as readonly string[]).includes(s)
    ? (s as SandboxResource)
    : null;
}

/**
 * Validate an inbound `capability.request`. Structural rules: must be an object,
 * `type === "capability.request"`, `resource` a known wire key, `requestId` a
 * non-empty string. Anything else is rejected (never silently granted).
 */
export function validateCapabilityRequest(raw: unknown): RequestValidation {
  if (!isObject(raw)) return { kind: "invalid", reason: "not-an-object" };
  if (raw.type !== "capability.request") return { kind: "invalid", reason: "bad-type" };
  const requestId = raw.requestId;
  if (typeof requestId !== "string" || requestId.trim() === "") {
    return { kind: "invalid", reason: "bad-request-id" };
  }
  const resource = parseSandboxResource(raw.resource);
  if (resource === null) return { kind: "invalid", reason: "unknown-resource" };
  const request: SandboxCapabilityRequest = {
    type: "capability.request",
    resource,
    requestId,
  };
  return { kind: "valid", request, resource };
}

/**
 * Decide one capability request given the daemon's authoritative outcome.
 *
 * * `granted === true` → reply `granted: true` (the daemon audited this).
 * * `granted !== true` (including `null` = offline/unknown) → reply denied.
 * * Invalid frames → `null` (host should log an audit-denied, never reply/grant).
 */
export function decideCapabilityRequest(
  raw: unknown,
  daemonGranted: boolean | null,
): SandboxCapabilityReply | null {
  const v = validateCapabilityRequest(raw);
  if (v.kind !== "valid") return null;
  return {
    type: "capability.reply",
    requestId: v.request.requestId,
    resource: v.request.resource,
    granted: daemonGranted === true,
  };
}
