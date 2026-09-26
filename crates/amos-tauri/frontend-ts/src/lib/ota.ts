/**
 * Typed client for the host's system-update (OTA) bridge
 * (`crates/amos-tauri/src/ota.rs`, which in turn drives the `amos-ota` decision
 * core). The Settings「关于本机」page calls {@link otaStatus} for identity and
 * {@link otaCheck} for a decision, then renders it via {@link otaOutcome}.
 *
 * Offline contract (mirrors `lib/backend.ts` / `lib/netguard.ts`): outside Tauri
 * — or when the host command fails — every call returns `null`, so the page
 * shows a localized "not connected" state rather than pretending.
 *
 * Honest boundary: the host **checks and stages, but does not flash**. An
 * `eligible` answer reports the offered version/URI; {@link otaInstall} drives
 * the download-and-verify pipeline to the point where a reboot *would* apply the
 * image — which is the runtime's job, not this bridge's. So the success sentence
 * is "downloaded and verified", never "installed". A missing source is
 * `unconfigured` and an unreadable one is `unreachable` — never a fabricated
 * "up to date".
 */
import { readStoreValue } from "./amosStore";
import { bridged, invoke } from "./backend";
import { normalizeQuick, SETTINGS_KEY } from "./settings";
import { systemStatusWithHostBattery } from "./system";
import { normalizeWifi, wifiInit, wifiLink, WIFI_KEY } from "./wifi";

/** Mirror of the host `OtaStatus` (serde keys). */
export interface OtaStatus {
  current_version: string;
  /** `"stable"` | `"beta"`. */
  channel: string;
  /** True only when an update source is configured on the host. */
  configured: boolean;
  /** The configured source path (empty when unconfigured). */
  source: string;
  /**
   * Set when `AMOS_OTA_CHANNEL` is not a channel. The host then answers every
   * check with `misconfigured` rather than checking the `stable` fallback lane
   * the operator did not select, so this is the only place the typo is visible.
   */
  channel_error?: string | null;
}

/**
 * The device facts the host needs to decide. Both battery fields are
 * three-valued: `null` means the fact could not be read, and the host then
 * **defers** rather than guess. `in_window` is a maintenance-window fact the
 * caller generally cannot observe; the default host policy has no window gate,
 * so it is inert today (pass `true`).
 */
export interface OtaFacts {
  battery_percent: number | null;
  /** `null` when the charger was not read — distinct from `false` (read, on battery). */
  charging: boolean | null;
  on_wifi: boolean;
  in_window: boolean;
}

/** Mirror of the host `OtaCheckResult` (serde keys). */
export interface OtaCheckResult {
  /**
   * `up_to_date` | `eligible` | `deferred` | `refused` | `unreachable` |
   * `unconfigured` | `misconfigured`.
   */
  kind: string;
  current_version: string;
  channel: string;
  version: string | null;
  package_uri: string | null;
  package_bytes: number | null;
  /** Stable machine code for a deferral/refusal (`needs_wifi`, `unsigned`, …). */
  reason_code: string | null;
  detail: string | null;
}

/** Identity + whether an update source is configured. Null offline. */
export async function otaStatus(): Promise<OtaStatus | null> {
  if (!bridged()) return null;
  return invoke<OtaStatus>("ota_status");
}

/** Ask the host for an update decision. Null offline. */
export async function otaCheck(facts: OtaFacts): Promise<OtaCheckResult | null> {
  if (!bridged()) return null;
  return invoke<OtaCheckResult>("ota_check", {
    batteryPercent: facts.battery_percent,
    charging: facts.charging,
    onWifi: facts.on_wifi,
    inWindow: facts.in_window,
  });
}

/**
 * Mirror of the host `OtaInstallResult` (serde keys).
 *
 * `state` is the `amos-ota` machine's terminal key. **`"staged"` is the best
 * outcome there is** — the bytes matched the published digest and a reboot would
 * apply them. It does **not** mean the image is running; flashing is the
 * runtime's job, and this client must never word a `staged` result as
 * "installed".
 */
export interface OtaInstallResult {
  state: string;
  version: string | null;
  /** Set when the machine settled in `failed` — the honest cause. */
  fail_reason: string | null;
  /** Set when the install never began (not eligible, or the provider refused). */
  detail: string | null;
  /**
   * The signature verdict when verification ran — absent when it did not.
   *
   * `staged` is gated on the **integrity** verdict alone, so a package whose signer
   * is not trusted still stages. The verdict rides along so the screen can qualify
   * its 「校验完成」 sentence: the bytes matching the published digest is a real
   * check; the signer is a separate fact, and nothing here established it.
   */
  signature?: OtaSignatureReport | null;
}

/** Mirror of the host `OtaSignatureReport`. `verdict` is `trusted | untrusted | missing`. */
export interface OtaSignatureReport {
  verdict: string;
  /** The signing key id, when the package carried a signature. */
  key_id: string | null;
  /**
   * How the verdict was reached: `"ed25519"` when the signature was checked
   * against a registered public key, `"policy"` when only the key *id* was
   * matched and no cryptography ran.
   *
   * **A `trusted` verdict is worth exactly as much as this field.** Under
   * `"policy"` a forged signature claiming a trusted key id reads `trusted` too,
   * so a screen that renders the two alike is asserting an authenticity nobody
   * checked. Treat any value other than `"ed25519"` as the weak mode.
   */
  verified_by?: string | null;
}

/**
 * Download and verify the offered update from the host's configured image.
 *
 * Null offline. A non-null result with `state: "failed"` carries the cause in
 * `fail_reason`; `state: "idle"` means nothing ran and `detail` says why.
 */
export async function otaInstall(facts: OtaFacts): Promise<OtaInstallResult | null> {
  if (!bridged()) return null;
  return invoke<OtaInstallResult>("ota_install", {
    batteryPercent: facts.battery_percent,
    charging: facts.charging,
    onWifi: facts.on_wifi,
    inWindow: facts.in_window,
  });
}

/**
 * Gather the device facts the host's check/install decisions depend on.
 *
 * These are the facts **only this UI can observe**, and the Wi-Fi one is subtle:
 * the question is about the *bearer* (is this transfer metered?), so the answer
 * is the link rule — `wifiLink`, "the radio is on **and** an AP is joined" — the
 * same rule the Settings index already shares (REQ-A1123). Two wrong answers this
 * replaced are recorded on `AboutPage` (REQ-A1120 / REQ-A1173).
 *
 * Both battery facts come from the live daemon readout and stay `null` when they
 * cannot be read — the host then **defers** rather than guess, on the fact that
 * was actually missing (`unknown_battery` vs `unknown_charging`). `in_window` is
 * a maintenance-window fact this client cannot observe and the host's default
 * policy does not gate on, so it is inert (`true`).
 */
export async function readOtaFacts(): Promise<OtaFacts> {
  const sys = await systemStatusWithHostBattery();
  const wifi = normalizeWifi(readStoreValue(WIFI_KEY, wifiInit()));
  const quick = normalizeQuick(readStoreValue(SETTINGS_KEY, {}));
  return {
    battery_percent: sys?.battery_level_pct == null ? null : Math.round(sys.battery_level_pct),
    charging: otaChargingFact(sys?.battery_charging),
    on_wifi: wifiLink(!!quick.wifi, wifi.current).kind === "joined",
    in_window: true,
  };
}

/**
 * Map the wire's three-valued charging bit onto the fact the host takes.
 *
 * The wire (and the battery authority this reads) distinguishes **unread** from
 * **off the charger**: `null` means nobody observed the charger, `false` means
 * somebody looked at the charger and the device was not on it. Folding the
 * unread case into `false` hands the host a measured "on battery" it never
 * measured — so it applies the battery floor to a device that may be plugged in,
 * and (when the level is also unread) reports a *battery* problem while the
 * decisive unknown was the charger. `undefined` (no sample at all) is the same
 * unknown.
 */
export function otaChargingFact(wire: boolean | null | undefined): boolean | null {
  return typeof wire === "boolean" ? wire : null;
}

/** A display-ready classification of a check result (or its absence). */
export type OtaOutcome =
  | "up-to-date"
  | "update-available"
  | "deferred"
  | "refused"
  | "unreachable"
  | "unconfigured"
  | "misconfigured"
  | "offline";

/**
 * Classify a check result (or `null`) into a display outcome (pure, unit-tested).
 *
 * `null` means the host never answered (not bridged, or the command threw) and is
 * its own `offline` case — distinct from the host answering `unreachable`, which
 * means the host *did* run the check and its configured source could not be read.
 * `misconfigured` is likewise the host *having answered*: `AMOS_OTA_CHANNEL` is
 * not a channel, so the check refused to answer for the fallback lane — an
 * operator error to surface, not a silent "up to date".
 * An unrecognized `kind` is treated as `offline`: better to say "no answer" than
 * to render a sentence for a state this client does not understand.
 */
export function otaOutcome(r: OtaCheckResult | null): OtaOutcome {
  return otaOutcomeFromKind(r?.kind);
}

/** The same classification from the bare `kind` (a stored record has no result). */
export function otaOutcomeFromKind(kind: string | undefined): OtaOutcome {
  switch (kind) {
    case "up_to_date":
      return "up-to-date";
    case "eligible":
      return "update-available";
    case "deferred":
      return "deferred";
    case "refused":
      return "refused";
    case "unreachable":
      return "unreachable";
    case "unconfigured":
      return "unconfigured";
    case "misconfigured":
      return "misconfigured";
    default:
      return "offline";
  }
}

const OUTCOME_KEYS: Record<OtaOutcome, string> = {
  "up-to-date": "settings.updateOutcome_uptodate",
  "update-available": "settings.updateOutcome_available",
  deferred: "settings.updateOutcome_deferred",
  refused: "settings.updateOutcome_refused",
  unreachable: "settings.updateOutcome_unreachable",
  unconfigured: "settings.updateOutcome_unconfigured",
  misconfigured: "settings.updateOutcome_misconfigured",
  offline: "settings.updateOutcome_offline",
};

/** The i18n key for an outcome's headline sentence. */
export function otaOutcomeKey(outcome: OtaOutcome): string {
  return OUTCOME_KEYS[outcome];
}

/**
 * The i18n key for a deferral/refusal reason code. Unknown codes fall back to a
 * generic "held back" line rather than echoing an untranslated machine code.
 */
export function otaReasonKey(code: string | null): string {
  const known = new Set([
    "reflash_required",
    "prerelease_not_allowed",
    "unsigned",
    "not_in_cohort",
    "outside_window",
    "needs_wifi",
    "unknown_battery",
    "unknown_charging",
    "low_battery",
  ]);
  return code !== null && known.has(code)
    ? `settings.updateReason.${code}`
    : "settings.updateReason.other";
}

/**
 * A display-ready classification of an install result (or its absence).
 *
 * `unknown` exists so an unrecognized `state` renders "no answer" rather than a
 * sentence for a state this client does not understand — and, critically, is
 * **not** folded into `staged`.
 */
export type OtaInstallOutcome = "staged" | "failed" | "not-run" | "offline" | "unknown";

/** Classify an install result (or `null`) into a display outcome (pure). */
export function otaInstallOutcome(r: OtaInstallResult | null): OtaInstallOutcome {
  if (r === null) return "offline";
  switch (r.state) {
    case "staged":
      return "staged";
    case "failed":
      return "failed";
    case "idle":
      return "not-run";
    default:
      return "unknown";
  }
}

const INSTALL_OUTCOME_KEYS: Record<OtaInstallOutcome, string> = {
  // The success line is deliberately "downloaded and verified (applies after a
  // reboot)" — the host does not flash, so it must never read as "installed".
  staged: "settings.updateInstall_staged",
  failed: "settings.updateInstall_failed",
  "not-run": "settings.updateInstall_notRun",
  offline: "settings.updateInstall_offline",
  unknown: "settings.updateInstall_unknown",
};

/** The i18n key for an install outcome's headline sentence. */
export function otaInstallOutcomeKey(outcome: OtaInstallOutcome): string {
  return INSTALL_OUTCOME_KEYS[outcome];
}

/**
 * Where the shell's background watcher records its most recent check.
 *
 * A `derived` key, not user content: it is a *reading* of the host's answer at a
 * moment, so there is nothing to back up, and restoring it on another device
 * would put this device's verdict on screen. It is never the source of a
 * decision — the Settings page still asks the host live — only of the "last
 * checked" line.
 */
export const OTA_CHECK_KEY = "amos.ota";

/** One background check's answer. `at` is the local time it was taken. */
export interface OtaCheckRecord {
  at: number;
  outcome: OtaOutcome;
  /** The host's raw `kind`, kept for the reason-code lookup. */
  kind: string;
  version: string | null;
  reason_code: string | null;
}

/** Narrow a stored record. Anything unusable is `null` — never a guessed record. */
export function normalizeOtaCheckRecord(raw: unknown): OtaCheckRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Partial<OtaCheckRecord>;
  if (typeof o.at !== "number" || !Number.isFinite(o.at) || o.at <= 0) return null;
  if (typeof o.kind !== "string" || o.kind === "") return null;
  const outcome = otaOutcomeFromKind(o.kind);
  return {
    at: o.at,
    outcome,
    kind: o.kind,
    version: typeof o.version === "string" ? o.version : null,
    reason_code: typeof o.reason_code === "string" ? o.reason_code : null,
  };
}
