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
  /**
   * Which way the call went. Optional for **back-compat**: records written before
   * directions existed have none, and the UI shows a neutral row for those rather
   * than pretending they were outgoing.
   */
  direction?: CallDirection;
}

/** Call direction as shown in the call-history page. */
export type CallDirection = "incoming" | "outgoing" | "missed";

/** Whitelist a stored direction (anything else → undefined, never guessed). */
export function normalizeDirection(raw: unknown): CallDirection | undefined {
  return raw === "incoming" || raw === "outgoing" || raw === "missed" ? raw : undefined;
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
    const rec: CallRecord = {
      number,
      name: typeof o.name === "string" && o.name.trim() !== "" ? o.name.trim() : undefined,
      ts,
    };
    const direction = normalizeDirection(o.direction);
    if (direction) rec.direction = direction;
    out.push(rec);
  }
  return [...out].sort((a, b) => b.ts - a.ts).slice(0, CALLLOG_CAP);
}

/** Record a call (keep history for frequency stats), newest-first, capped. */
export function recordCall(
  list: CallRecord[],
  number: string,
  name?: string,
  now: number = Date.now(),
  direction?: CallDirection,
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
  const dir = normalizeDirection(direction);
  if (dir) entry.direction = dir;
  return [entry, ...list].slice(0, CALLLOG_CAP);
}

/**
 * Calls that could not be **persisted yet** (REQ-A150).
 *
 * Why this exists: the incoming-call overlay appends its row at the moment the call ends,
 * which is exactly when no screen is up to report a failure — so a rejected write used to
 * cost that history row **silently**. A row that did not land is now kept here and
 * retried by the next screen that can both write and speak (the Phone screen's history),
 * and while it is still pending that screen says so.
 *
 * Honest boundary: this survives a *transient* failure (storage full then freed, store
 * temporarily unavailable), **not** a reload — persisting the pending marker would need
 * the very storage that just failed. A queued call is therefore also capped like the log.
 */
let pendingCalls: CallRecord[] = [];

/** Queue a record whose write was rejected (bounded; invalid records are ignored). */
export function queuePendingCall(rec: CallRecord | undefined): void {
  if (!rec) return;
  const clean = normalizeCallLog([rec]);
  const first = clean[0];
  if (!first) return; // no usable number ⇒ nothing to recover
  // A repeated Ended event for the same call must not queue the row twice.
  if (pendingCalls.some((p) => p.number === first.number && p.ts === first.ts)) return;
  pendingCalls = [first, ...pendingCalls].slice(0, CALLLOG_CAP);
}

/** How many calls are still waiting to be written. */
export function pendingCallCount(): number {
  return pendingCalls.length;
}

/** Drop every pending call — test-only reset (production clears it through a flush). */
export function resetPendingCallsForTest(): void {
  pendingCalls = [];
}

/**
 * Merge the pending calls into `list` and try to persist the result through `save`
 * (the caller's checked write). Returns how many records **landed**: on success the queue
 * is emptied, on failure it is left exactly as it was (nothing is dropped, nothing is
 * claimed).
 */
export function flushPendingCalls(
  list: CallRecord[],
  save: (next: CallRecord[]) => boolean,
): number {
  if (pendingCalls.length === 0) return 0;
  const queue = pendingCalls;
  const next = normalizeCallLog([...queue, ...list]);
  if (!save(next)) return 0;
  // Only remove what we actually wrote (a concurrent queue() during the write stays).
  pendingCalls = pendingCalls.filter((p) => !queue.includes(p));
  return queue.length;
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

/** Name hint for a number from the log (best known), if any. Uses the SAME
 * `sameCallNumber` equality as `recentNumbers`/`frequentNumbers`, so `+CC…` and a
 * bare local form of the same number resolve to one name. */
export function logNameFor(list: CallRecord[], number: string): string | undefined {
  const d = callDigits(number);
  if (d === "") return undefined;
  const rec = normalizeCallLog(list).find((r) => sameCallNumber(r.number, number));
  return rec?.name;
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

// ---- Call-history page helpers (pure; formatting is locale-neutral) -------------

/** The full call history, newest first and capped (the history page's source). */
export function callHistory(list: unknown): CallRecord[] {
  return normalizeCallLog(list);
}

/** How many history rows are missed calls (for the page's summary line). */
export function missedCalls(list: CallRecord[]): number {
  return list.filter((r) => r.direction === "missed").length;
}

/** Which subset of the history a filter shows. */
export type CallFilter = "all" | "incoming" | "outgoing" | "missed";

/** The history rows a filter selects (`all` = every row), newest-first + capped
 * through the SAME normalization as `callHistory`. The input is `unknown` (store
 * data), so junk degrades to the empty log rather than throwing. */
export function filterHistory(list: unknown, filter: CallFilter): CallRecord[] {
  const rows = callHistory(list);
  return filter === "all" ? rows : rows.filter((r) => r.direction === filter);
}

/** A cleared call log — a named seam so callers never have to spell the empty
 * literal and tests can assert the intent. */
export function clearCallHistory(): CallRecord[] {
  return [];
}

/** Local calendar-day stamp (YYYY-MM-DD); empty for a non-positive timestamp. */
export function callDateStamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Which day bucket a timestamp falls in, so the UI can localize it:
 * `"today"` / `"yesterday"` / `"date"` (render `callDateStamp`) / `"unknown"`.
 */
export function callWhenLabel(
  ts: number,
  now: number = Date.now(),
): "today" | "yesterday" | "date" | "unknown" {
  const stamp = callDateStamp(ts);
  if (stamp === "") return "unknown";
  if (stamp === callDateStamp(now)) return "today";
  if (stamp === callDateStamp(now - 86400000)) return "yesterday";
  return "date";
}

/** Local wall-clock `HH:MM` for a call timestamp (`""` for an unknown time). */
export function fmtCallClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
