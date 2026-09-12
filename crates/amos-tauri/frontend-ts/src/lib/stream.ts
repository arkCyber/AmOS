/**
 * Pure parsers for backend event streams (`ai-token-received` / `ai-card-received`
 * / `ai-session-complete` / `interpret-output`), so each live surface's event
 * handling can be unit-tested with "fake events" (no DOM / no bridge).
 *
 * The *accumulation* lives with its consumer: `AiApp` keeps its own message model
 * (text + cards + busy state) and the interpreter transcript is the persisted
 * segment store in `lib/interp`. The older `ChatLog` / `InterpOutput` reducer
 * models that used to live here had no production consumer left, so they were
 * removed rather than kept as a second, parallel transcript model.
 */
export function tokenOf(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "token" in payload) return String((payload as { token: string }).token);
  return "";
}

/** A semantic UiCard delivered via the `ai-card-received` event. */
export interface AiCard {
  kind: string;
  title: string;
  subtitle: string;
  fields: { key: string; value: string }[];
  actions: string[];
}

/**
 * Parse an `ai-card-received` payload into an [`AiCard`] (null when it is not a
 * recognised card object — e.g. an empty `kind`, or a non-card event).
 */
export function cardOf(payload: unknown): AiCard | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  // Aerospace-grade: the daemon must send a plain-string `kind`; anything else
  // (array/object/number) is treated as "not a card" rather than coerced.
  if (typeof p.kind !== "string" || !p.kind) return null;
  const kind = p.kind;
  const fields = Array.isArray(p.fields)
    ? p.fields.map((f) => {
        const o =
          f && typeof f === "object" ? (f as Record<string, unknown>) : {};
        return { key: String(o.key ?? ""), value: String(o.value ?? "") };
      })
    : [];
  const actions = Array.isArray(p.actions) ? p.actions.map((a) => String(a)) : [];
  return {
    kind,
    title: String(p.title ?? ""),
    subtitle: String(p.subtitle ?? ""),
    fields,
    actions,
  };
}

/**
 * Parse an `ai-session-complete` payload — serialized as a `[sessionId, fullText]`
 * pair — into a plain object (null otherwise).
 */
export function sessionMetaOf(payload: unknown): { sid: string; full: string } | null {
  if (!Array.isArray(payload) || payload.length < 1) return null;
  const sid = String(payload[0] ?? "");
  if (!sid) return null;
  const full = payload.length >= 2 ? String(payload[1] ?? "") : "";
  return { sid, full };
}

/**
 * Extract the speakable final translation from an `interpret-output` payload, or
 * null when it is not a `segment_final` (partials/state change are never spoken,
 * matching sokuji's final-segment readout for low-latency clean audio).
 */
export function finalSegmentOf(payload: unknown): { text: string; lang: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== "segment_final") return null;
  const text = String(p.target_text ?? "");
  const lang = String(p.target_lang ?? "") || "zh";
  return text ? { text, lang } : null;
}
