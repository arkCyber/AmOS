/**
 * Emergency-call affordances shared across the System UI (lock-screen quick dial).
 *
 * The *authoritative* emergency classification lives in the Rust domain
 * (`crates/amos-telephony/src/number.rs`, `EmergencyMap`) and is enforced
 * server-side when a `Dial` RPC is dispatched (the daemon re-classifies the
 * number and routes a recognized 110/112/911… to the privileged emergency
 * provider even when the caller did not set the `emergency` flag). What is kept
 * here is only the single *presentation* constant a lock-screen one-tap entry
 * dials and labels itself with, so the displayed number and the dialed number
 * can never drift apart across UI/i18n.
 *
 * See `docs/telephony.md` for the legal framing: this module never *claims* to
 * build a kernel-protected path — routing guarantees live in the platform
 * telecom/RIL layer. `EMERGENCY_QUICK_NUMBER` is the product default; on-device
 * builds may drive it from the assembled region set.
 */

/** Primary one-tap emergency number on the lock screen (CN police by default). */
export const EMERGENCY_QUICK_NUMBER = "110";

/**
 * The recognized emergency codes surfaced in the dialer's Emergency page. CN-market
 * primary set + the universal 112 (which routes on any GSM/UMTS/LTE network even
 * with no SIM / roaming). Mirrors the Rust `EmergencyMap` family (see number.rs);
 * the daemon re-classifies any of these to the privileged provider regardless.
 */
export const EMERGENCY_NUMBERS = ["110", "119", "120", "122", "112"] as const;

/** Region-selected quick-dial mirrors `EmergencyMap::quick_dial` (see number.rs). */
export function quickEmergencyNumber(region: string): string {
  const r = region.trim().toUpperCase();
  if (["CN", "CN-HK", "CN-MO", "JP", "KR"].includes(r)) return "110";
  if (["US", "CA", "MX", "AU", "NZ"].includes(r)) return "911";
  return "112";
}
