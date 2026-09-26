/**
 * osOtaWatcher.ts — shell-level periodic system-update **check**.
 *
 * The Settings「关于本机」page can take a check on demand, but a user who never
 * opens that page never learns an update exists. This is the other half: the
 * shell asks the host on a slow interval and records the answer, so the About
 * page can show "last checked …" the moment it opens, and a background check is
 * not a button nobody presses.
 *
 * It writes **only when the host actually answered**, for two reasons:
 *   * `invoke` answers `null` when the host never answered (unbridged, or the
 *     command threw). No answer is not a check result — recording it would
 *     overwrite a real verdict with a state we never observed;
 *   * "landed" is the **write's** verdict. A store that refused the write
 *     recorded nothing, so the tick reports no check rather than a fresh record.
 *
 * Honest boundaries:
 *   * This checks; it never installs. Staging/flashing stays behind the explicit
 *     user action on the About page (`otaInstall`), because a background
 *     download-and-reboot is not something a user asked for.
 *   * The interval is slow by design (`OTA_CHECK_MS`): a check is a manifest
 *     read, but the *answer* changes on the order of days, so a tight poll would
 *     only spend power and wake the device for a verdict that cannot have moved.
 */
import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
import { bridged } from "../lib/backend";
import {
  normalizeOtaCheckRecord,
  OTA_CHECK_KEY,
  otaCheck,
  otaOutcome,
  readOtaFacts,
  type OtaCheckRecord,
  type OtaCheckResult,
} from "../lib/ota";

/** How often the shell asks the host whether an update exists. */
export const OTA_CHECK_MS = 6 * 60 * 60 * 1000;

/** The record one check answer produces (pure — the caller owns *when* it is stored). */
export function toOtaCheckRecord(result: OtaCheckResult, nowMs: number): OtaCheckRecord {
  return {
    at: nowMs,
    outcome: otaOutcome(result),
    kind: result.kind,
    version: result.version,
    reason_code: result.reason_code,
  };
}

/**
 * Record a check answer as the 「上次检查」 record, and hand the record back so a live
 * surface can render it without re-reading storage.
 *
 * `OTA_CHECK_KEY` has **two** producers of a check now — this module's poller and the
 * About page's 「检查更新」 button — and they must agree byte for byte on what a record is,
 * which is why the shape lives here rather than being rebuilt at each call site. A check
 * the user takes on that page is a check: leaving it unrecorded made the row answer "when
 * did we last check?" with an older (or no) answer while the verdict an inch below it
 * described the one just taken (REQ-A1530 ∕ F-SH-773).
 *
 * A refused write is not reported as a failure to the caller: the record is still what
 * this session observed, and the write's verdict only decides whether it outlives the
 * session. Use {@link otaWatcherTick} where the write's verdict *is* the return value.
 */
export function recordOtaCheck(result: OtaCheckResult, nowMs = Date.now()): OtaCheckRecord {
  const record = toOtaCheckRecord(result, nowMs);
  writeStoreValueChecked(OTA_CHECK_KEY, record);
  return record;
}

/**
 * One check: gather the facts, ask the host, and record the answer.
 *
 * @returns whether a record was written (false when unbridged, the host did not
 *   answer, or the store refused the write).
 */
export async function otaWatcherTick(nowMs = Date.now()): Promise<boolean> {
  if (!bridged()) return false;
  const result = await otaCheck(await readOtaFacts());
  // `null` = the host never answered (not bridged, or the command threw). That is
  // *no news*, so the previous record and its timestamp stand.
  if (result === null) return false;
  return writeStoreValueChecked(OTA_CHECK_KEY, toOtaCheckRecord(result, nowMs));
}

/**
 * The recorded check, or `null` when none has landed yet (or the stored value is
 * unusable). A `null` here means "we have never recorded a check", which the
 * About page renders as such — never as "up to date".
 */
export function readOtaCheckRecord(): OtaCheckRecord | null {
  return normalizeOtaCheckRecord(readStoreValue<unknown>(OTA_CHECK_KEY, null));
}

/**
 * Start the poller. Runs one check immediately, then on `OTA_CHECK_MS`.
 * Returns a stop function (call on unmount).
 */
export function startOtaWatcher(): () => void {
  const tick = () => {
    void otaWatcherTick().catch(() => {
      /* storage unavailable / backend threw — best effort; `invoke` logs the why */
    });
  };
  tick();
  const interval = window.setInterval(tick, OTA_CHECK_MS);
  return () => window.clearInterval(interval);
}
