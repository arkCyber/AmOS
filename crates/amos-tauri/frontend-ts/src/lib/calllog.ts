/**
 * Call log ("最近通话") domain — records of outgoing calls, durable under
 * `amos.calllog`.
 *
 * Pure + immutable: every op returns a new array. Records are kept newest-first
 * and bounded; corrupt store data is normalized away. `frequentNumbers` derives
 * the "常用联系人" ranking (by recency-weighted frequency) for quick dialing.
 */

/** One call-log record (outgoing today; extend `direction` later). */
export interface CallRecord {
  /** Phone number (as dialed / displayed). */
  number: string;
  /** Contact name known at dial time (optional, display hint). */
  name?: string;
  /** Wall-clock ms when the call was placed. */
  ts: number;
}

/** Shared-store key under which the call log is persisted. */
export const CALLLOG_KEY = "amos.calllog";

/** Upper bound on how many records we keep. */
export const CALLLOG_CAP = 60;

/** Digits-only view of a number (ignores separators / leading `+`), for matching. */
export function callDigits(raw: string): string {
  const t = raw.trim();
  return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, "");
}

/** Whether two dialed strings refer to the same number (ignores country-code
 * `+CC` prefix when the bare local form is a ≥7-digit suffix). */
export function sameCallNumber(a: string, b: string): boolean {
  const da = callDigits(a).replace(/^\+/, "");
  const db = callDigits(b).replace(/^\+/, "");
  if (!da || !db) return false;
  if (da === db) return true;
  const short = da.length <= db.length ? da : db;
  const long = da.length <= db.length ? db : da;
  return short.length >= 7 && long.endsWith(short);
}

/** Keep only well-formed records (non-blank number, finite ts), newest-first, capped.
 * History (repeats of a number) is preserved so `frequentNumbers` can count. */
export function normalizeCallLog(raw: unknown): CallRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: CallRecord[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const number = typeof o.number === "string" ? o.number.trim() : "";
    if (number === "" || callDigits(number) === "") continue;
    const ts = typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0;
    out.push({
      number,
      name: typeof o.name === "string" && o.name.trim() !== "" ? o.name.trim() : undefined,
      ts,
    });
  }
  return [...out].sort((a, b) => b.ts - a.ts).slice(0, CALLLOG_CAP);
}

/** Record a call (keep history for frequency stats), newest-first, capped. */
export function recordCall(
  list: CallRecord[],
  number: string,
  name?: string,
  now: number = Date.now(),
): CallRecord[] {
  const n = number.trim();
  if (n === "" || callDigits(n) === "") return list;
  // Don't store a "name" that is actually just the number itself.
  const hint = name && name.trim() !== "" && name.trim() !== n ? name.trim() : undefined;
  const entry: CallRecord = {
    number: n,
    name: hint,
    ts: now,
  };
  return [entry, ...list].slice(0, CALLLOG_CAP);
}

/** The most recent `n` *distinct* numbers (newest first), for a quick-dial strip.
 * `+CC` and bare forms of the same number count as one. */
export function recentNumbers(list: CallRecord[], n: number): string[] {
  const out: string[] = [];
  for (const rec of normalizeCallLog(list)) {
    if (out.some((existing) => sameCallNumber(existing, rec.number))) continue;
    out.push(rec.number);
    if (out.length >= n) break;
  }
  return out;
}

/** Name hint for a number from the log (best known), if any. */
export function logNameFor(list: CallRecord[], number: string): string | undefined {
  const d = callDigits(number);
  if (d === "") return undefined;
  return normalizeCallLog(list).find((r) => callDigits(r.number) === d)?.name;
}

/** Top `n` most frequently-dialed numbers ("常用联系人"), newest-first on ties,
 * returned in their *display* form (the most recent formatting seen). A number
 * dialed as both `+CC…` and bare `…` counts as one. */
export function frequentNumbers(list: CallRecord[], n: number): string[] {
  const groups: { rep: string; display: string; count: number; last: number }[] = [];
  for (const rec of normalizeCallLog(list)) {
    const g = groups.find((grp) => sameCallNumber(grp.rep, rec.number));
    if (g) {
      g.count += 1;
      g.last = Math.max(g.last, rec.ts);
    } else {
      groups.push({ rep: rec.number, display: rec.number, count: 1, last: rec.ts });
    }
  }
  return [...groups]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, n)
    .map((g) => g.display);
}
