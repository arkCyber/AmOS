/**
 * Emergency-call affordances shared across the System UI (lock-screen quick dial).
 *
 * The *authoritative* emergency classification lives in the Rust domain
 * (`crates/amos-telephony/src/number.rs`, `EmergencyMap`) and is enforced
 * server-side when a `Dial` RPC is dispatched (the daemon re-classifies the
 * number and routes a recognized 110/112/911… to the privileged emergency
 * provider even when the caller did not set the `emergency` flag). What is kept
 * here is the *presentation* choice of which number a one-tap entry dials and
 * labels itself with, so the displayed number and the dialed number can never
 * drift apart across UI/i18n.
 *
 * That choice is **region-dependent**: a one-tap number the jurisdiction does
 * not recognize reaches nobody (`EmergencyMap::quick_dial`'s own words — KR's
 * 110 is not an emergency number, AU/NZ's 911 does not connect). So the lock
 * screen derives its number from the **device's own locale** through
 * {@link deviceQuickEmergencyNumber}; the region table mirrors
 * `EmergencyMap::quick_dial`, and a locale that names no region falls back to
 * the universal **112** (routed by every GSM/UMTS/LTE network) — never to a
 * single country's code.
 *
 * See `docs/telephony.md` for the legal framing: this module never *claims* to
 * build a kernel-protected path — routing guarantees live in the platform
 * telecom/RIL layer.
 */

/**
 * The dialer's CN-market **primary** code — the highlighted row on the dialer's
 * emergency page ({@link EMERGENCY_NUMBERS}). It is **not** the lock-screen
 * number: that one is region-derived ({@link deviceQuickEmergencyNumber}), because
 * a locked user reaches it in one tap without choosing.
 */
export const EMERGENCY_QUICK_NUMBER = "110";

/**
 * The recognized emergency codes surfaced in the dialer's Emergency page. CN-market
 * primary set + the universal 112 (which routes on any GSM/UMTS/LTE network even
 * with no SIM / roaming). Mirrors the Rust `EmergencyMap` family (see number.rs);
 * the daemon re-classifies any of these to the privileged provider regardless.
 *
 * This is a **presentation** list — which buttons the page draws. It is not the set the
 * dial surfaces classify a call with; that is {@link EMERGENCY_CODES}, the daemon's
 * broader classification table.
 */
export const EMERGENCY_NUMBERS = ["110", "119", "120", "122", "112"] as const;

/**
 * The i18n key for each number on the dialer page's emergency buttons — the labels
 * that belong to {@link EMERGENCY_NUMBERS}.
 *
 * It lives here, beside the list it labels, so the two cannot drift apart unnoticed:
 * a code added to the list but not to this table would draw a button with no name.
 * `emergency.test.ts` binds them (every listed code has a key, and every key
 * resolves in both dictionaries).
 */
export const EMERGENCY_LABEL_KEYS: Record<string, string> = {
  "110": "phone.emergency.police",
  "119": "phone.emergency.fire",
  "120": "phone.emergency.ambulance",
  "122": "phone.emergency.traffic",
  "112": "phone.emergency.international",
};

/**
 * The message key to render for `code`: its own label, or the generic
 * "emergency number {num}" for one the table does not name.
 *
 * It returns a **key**, not a pre-translated string. That is deliberate: a lookup
 * that answered `""` for an unknown code (as the phone screen's old inline table
 * did) made its caller's `"…" ?? generic` unreachable — `""` is not nullish — so a
 * code the table did not name would have drawn an empty label on the emergency
 * page. Handing back the key keeps that fallback live.
 */
export function emergencyLabelKey(code: string): string {
  return EMERGENCY_LABEL_KEYS[code] ?? "phone.emergencyGeneric";
}

/**
 * The **classification** set: every code the daemon treats as an emergency, mirroring
 * `EmergencyMap::common_global()` (`crates/amos-telephony/src/number.rs`).
 *
 * Deliberately separate from the dialer page's **presentation** list
 * ({@link EMERGENCY_NUMBERS}, the CN-market buttons). `common_global()`'s own doc calls
 * itself "deliberately broad" and states the requirement it exists to satisfy: it "must
 * be a **superset of every code the device recognizes**", because "the cost of
 * over-classifying is a regular number forced onto the emergency path, while the cost of
 * under-classifying is a **recorded emergency**". Every per-region table is a subset of
 * it — `911` (US/CA/MX), `999` (GB/IE), `000` (AU/NZ), `118` (JP), `108` (IN) included.
 *
 * It is a mirror (bound to the Rust source by `declaredMirrors.test.ts`, both
 * directions) rather than something re-derived from a region the WebView cannot
 * authoritatively know: the question it answers is a safety question, and the answer
 * must be **≥** the daemon's own table.
 */
export const EMERGENCY_CODES = [
  "110", "112", "119", "120", "122", "911", "999", "000", "118", "108",
] as const;

/**
 * Is this number one the platform would route on the **emergency** path?
 *
 * The daemon is the *authoritative* classifier (see this file's header), so this is
 * **not** a claim that the call is an emergency — it is the narrower question the dial
 * surfaces ask so the daemon can be told which path to take: the `emergency` argument of
 * `telephony_dial` / `TelephonyService::dial`, which selects the privileged,
 * rate-limit-exempt, differently-audited (`operation="emergency_dial"`) emergency route
 * over the ordinary dial. Answering it too narrowly is what makes a saved `110` take the
 * ordinary route — where `MockTelephonyProvider::guard_regular` refuses it outright — so
 * the answer must be at least as broad as the daemon's own table.
 *
 * The routing order this file's doc header used to describe ("emergency numbers are
 * excluded from the fallback") no longer holds: `placeOutgoingCall` now tries the real
 * platform path (`ACTION_CALL`) **first, for every number** — which is where
 * `docs/telephony.md` §5 puts the emergency guarantee in the first place — so the flag
 * does not gate a fallback any more, it classifies the call for the daemon.
 *
 * It answers against {@link EMERGENCY_CODES} — the daemon's **classification** table —
 * and not the dialer page's presentation list: a US/AU/GB device's own `911`/`000`/`999`
 * is exactly the number whose misclassification this guard exists to prevent (`112`
 * appears in both lists, which is what hid the gap: the page's list covers 5 of the 10
 * codes).
 *
 * The question is asked about the **number**, so it must be normalised the way the daemon
 * normalises it: `Number::new` (`crates/amos-telephony/src/number.rs`) strips spaces,
 * hyphens and parentheses before `digits()` feeds `EmergencyMap::is_emergency`, and
 * `docs/telephony.md` §5 guarantee #5 states the consequence as a requirement — a code
 * with those separators must still hit the map and take the emergency path, never the
 * ordinary dial. A number a phone field can hold verbatim (`"1 1 0"`) is therefore 110 to
 * the daemon; a guard that only trimmed would call it regular and hand the daemon an
 * ordinary dial that refuses it as an emergency number — the exact silent downgrade this
 * exists to refuse. So it strips the daemon's separator set (and the optional leading `+`
 * its `digits()` drops) before comparing.
 */
export function isEmergencyNumber(number: string): boolean {
  const canonical = number
    .trim()
    .replace(/[-() ]/g, "")
    .replace(/^\+/, "");
  return (EMERGENCY_CODES as readonly string[]).includes(canonical);
}

/**
 * Region-selected quick-dial mirrors `EmergencyMap::quick_dial` (see number.rs).
 * Each answer is the region's *own* emergency number: KR dials 112 (110 is not
 * an emergency number in Korea), AU/NZ dial 000 (911 does not connect there).
 */
export function quickEmergencyNumber(region: string): string {
  const r = region.trim().toUpperCase();
  if (["CN", "CN-HK", "CN-MO", "JP"].includes(r)) return "110";
  if (r === "KR") return "112";
  if (["US", "CA", "MX"].includes(r)) return "911";
  if (["AU", "NZ"].includes(r)) return "000";
  return "112";
}

/**
 * The region subtag of a BCP-47 locale tag: `"zh-CN"` → `"CN"`, `"ko-KR"` → `"KR"`,
 * `"sr-Latn-RS"` → `"RS"`, `"en"` → `""` (no region named). Subtags are split on
 * `-` **or** `_` (some platform APIs use the latter). The first 2-letter subtag is
 * the region — scripts are 4 letters, so `"zh-Hans"` names no region; a 3-digit
 * subtag is a UN M.49 region and is returned as-is.
 */
export function regionFromLocale(locale: string): string {
  for (const sub of locale.trim().split(/[-_]/).slice(1)) {
    if (/^[A-Za-z]{2}$/.test(sub)) return sub.toUpperCase();
    if (/^[0-9]{3}$/.test(sub)) return sub;
  }
  return "";
}

/** {@link quickEmergencyNumber} for a BCP-47 **locale** rather than a bare region. */
export function quickEmergencyNumberForLocale(locale: string): string {
  return quickEmergencyNumber(regionFromLocale(locale));
}

/**
 * The one-tap emergency number for the **device's own** locale region.
 *
 * `navigator.language` is the only device-region signal a WebView has (the host
 * registers no locale command), and it is the OS locale rather than the UI
 * language: a phone set to `ko-KR` dials **112** whether the System UI is in
 * Chinese or English. With no `navigator` (tests, SSR) or a locale that names no
 * region, the answer is the universal **112** — never a single country's code.
 */
export function deviceQuickEmergencyNumber(): string {
  const tag =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language
      : "";
  return quickEmergencyNumberForLocale(tag);
}
