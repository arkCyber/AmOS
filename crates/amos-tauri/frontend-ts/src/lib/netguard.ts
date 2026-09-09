/**
 * Typed client for the daemon's egress "network guard" (`NetGuardService`, wire
 * contract `proto/netguard.proto`, Rust bridge `crates/amos-tauri/src/
 * netguard.rs`). The Settings "Network Guard" page calls `netguardArm` /
 * `netguardStatus` here to arm/disarm the guard and show an honest status.
 *
 * Offline contract (mirrors `lib/backend.ts`): outside Tauri — or when the
 * daemon command fails — every call returns `null`, so the UI can show a
 * localized "daemon not connected" state rather than pretending to arm or crash.
 *
 * Honest semantics: `enforced` is true ONLY when a real backend (rootless
 * `VpnService`, or nftables on AOSP/root) is actually enforcing on-device. The
 * default host build backs the guard with an in-process mock, so `enforced` is
 * false and arming is *intent* — the UI reflects that and never claims a
 * firewall is blocking traffic it cannot block.
 */
import { bridged, invoke } from "./backend";

/** Serializable mirror of the daemon `ToggleReply` (matches the Rust serde keys). */
export interface NetGuardToggle {
  enabled: boolean;
  message: string;
}

/** One top egress domain (by bytes) from the daemon's rolling counter. */
export interface NetGuardEgressSample {
  domain: string;
  bytes: number;
}

/** Serializable mirror of the daemon `StatusReply`. */
export interface NetGuardStatus {
  enabled: boolean;
  /** `"mock"` (default host) | `"vpn"` | `"nftables"`. */
  backend: string;
  /** True ONLY when a real backend is actually enforcing on this device. */
  enforced: boolean;
  policy_rules: number;
  top_egress: NetGuardEgressSample[];
}

/** Arm (`on = true`) or disarm (`on = false`) the daemon's egress guard. Null offline. */
export async function netguardArm(on: boolean): Promise<NetGuardToggle | null> {
  if (!bridged()) return null;
  return invoke<NetGuardToggle>("netguard_toggle", { enabled: on });
}

/** Read armed state + backend + small audit summary. Null offline. */
export async function netguardStatus(): Promise<NetGuardStatus | null> {
  if (!bridged()) return null;
  return invoke<NetGuardStatus>("netguard_status");
}

/** A truthful, display-ready classification of the guard's armed state. */
export type GuardLevel =
  | "armed-enforced" // a real backend is actually blocking traffic
  | "armed-intent" // user intent recorded, but no real backend enforcing
  | "disarmed"
  | "offline"; // daemon not reachable / no status yet

/** Classify a status (or its absence) into a display level (pure, unit-tested). */
export function guardLevel(s: NetGuardStatus | null): GuardLevel {
  if (!s) return "offline";
  if (!s.enabled) return "disarmed";
  return s.enforced ? "armed-enforced" : "armed-intent";
}

/** True only when a real enforcement backend reports it is enforcing. */
export function isEnforcing(s: NetGuardStatus | null): boolean {
  return guardLevel(s) === "armed-enforced";
}
