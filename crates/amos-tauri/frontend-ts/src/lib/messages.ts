export interface Msg {
  from: "me" | "them";
  text: string;
  ts: number;
  /** Optional: incoming messages you haven't read yet (outgoing never tracked). */
  read?: boolean;
  /** Optional: text this message is replying to (quote-reply). */
  quote?: string;
}

export const MSG_KEY = "amos.messages";

/** Upper bound on stored messages (keeps the conversation from growing unbounded). */
export const MESSAGE_CAP = 200;

export function seedMessages(now: number): Msg[] {
  return [
    { from: "them", text: "你好！Amos 系统感觉怎么样？", ts: now - 3000, read: true },
    { from: "me", text: "很棒，像 iOS 一样顺滑。", ts: now - 2000 },
    { from: "them", text: "要不要试试 AI 应用？", ts: now - 1000, read: false }, // newest incoming unread
  ];
}

/** Append an outgoing message (iMessage-style, chronological). Blank text is
 * trimmed and refused (returns the list unchanged). */
export function appendMessage(list: Msg[], text: string, now: number): Msg[] {
  const clean = text.trim();
  if (!clean) return list;
  return [...list, { from: "me", text: clean, ts: now }];
}

/** Corruption / back-compat guard for a stored conversation. Drops entries with a
 * bad sender or non-text body, coerces `ts`, and keeps valid `read`/`quote`. */
export function normalizeMessages(list: unknown): Msg[] {
  if (!Array.isArray(list)) return [];
  const out: Msg[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const from = o.from === "me" ? "me" : o.from === "them" ? "them" : undefined;
    if (!from) continue;
    if (typeof o.text !== "string" || o.text.trim() === "") continue;
    const m: Msg = {
      from,
      text: o.text,
      ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0,
    };
    if (from === "them" && typeof o.read === "boolean") m.read = o.read;
    if (typeof o.quote === "string" && o.quote !== "") m.quote = o.quote;
    out.push(m);
  }
  // Bound the history so a long-running conversation can't grow unbounded.
  return out.length > MESSAGE_CAP ? out.slice(out.length - MESSAGE_CAP) : out;
}

/** Append an outgoing message that quote-replies to `quote` (trims both; blank
 * text is refused, whitespace-only quote degrades to a plain message). */
export function appendQuote(list: Msg[], text: string, quote: string, now: number): Msg[] {
  const clean = text.trim();
  if (!clean) return list;
  const q = quote.trim();
  if (!q) return appendMessage(list, clean, now);
  return [...list, { from: "me", text: clean, ts: now, quote: q }];
}

/** Start a brand-new, empty conversation. */
export function clearMessages(): Msg[] {
  return [];
}

/** Delete exactly the message at `index` (true no-op — returns the same array —
 * when the index is out of range). */
export function removeMessageAt(list: Msg[], index: number): Msg[] {
  if (index < 0 || index >= list.length) return list;
  return list.filter((_, i) => i !== index);
}

/** Local wall-clock "HH:MM" for a message timestamp. */
export function fmtBubbleTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Local calendar-day stamp (YYYY-MM-DD) — for grouping consecutive messages. */
export function dayStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A separator label for a message day: "today" / "yesterday" markers, else the
 * plain calendar date (deterministic, locale-neutral for testability). */
export function messageDayLabel(ts: number, now: number): string {
  const t = dayStamp(ts);
  if (t === dayStamp(now)) return "today";
  if (t === dayStamp(now - 86400000)) return "yesterday";
  return t;
}

/** Whether two timestamps belong to different calendar days (insert a header). */
export function isNewDay(prevTs: number, ts: number): boolean {
  return dayStamp(prevTs) !== dayStamp(ts);
}

/** Number of unread *incoming* messages (from "them"). Outgoing never count. */
export function unreadCount(list: Msg[]): number {
  return list.filter((m) => m.from === "them" && !m.read).length;
}

/** Mark exactly one message as read (no-op if id/index unknown). */
export function markRead(list: Msg[], index: number): Msg[] {
  if (index < 0 || index >= list.length) return list;
  return list.map((m, i) => (i === index && m.from === "them" ? { ...m, read: true } : m));
}

/** Mark every incoming message as read (used when the user opens the chat). */
export function markAllRead(list: Msg[]): Msg[] {
  if (!unreadCount(list)) return list;
  return list.map((m) => (m.from === "them" ? { ...m, read: true } : m));
}
