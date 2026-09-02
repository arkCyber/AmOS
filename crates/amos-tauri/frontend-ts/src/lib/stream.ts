/**
 * Pure reducers for backend event streams (ai-token-received / interpret-output),
 * so streaming behaviour can be unit-tested with "fake events" (no DOM/bridge).
 */
export interface ChatLog {
  text: string;
  busy: boolean;
  complete: boolean;
}
export function chatLogInit(): ChatLog {
  return { text: "", busy: false, complete: false };
}
/** Extract a token string from an ai-token-received payload. */
export function tokenOf(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "token" in payload) return String((payload as { token: string }).token);
  return "";
}
export function onAiToken(log: ChatLog, payload: unknown): ChatLog {
  const token = tokenOf(payload);
  return token ? { ...log, text: log.text + token, busy: true, complete: false } : log;
}
export function onAiComplete(log: ChatLog): ChatLog {
  return { ...log, busy: false, complete: true };
}
export function chatLogReset(): ChatLog {
  return chatLogInit();
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
  const kind = String(p.kind ?? "");
  if (!kind) return null;
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

export interface InterpLine {
  src: string;
  target: string;
}
export interface InterpOutput {
  lines: InterpLine[];
}
export function interpInit(): InterpOutput {
  return { lines: [] };
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
/** Feed an `interpret-output` event (segment_final) into the transcript. */
export function onInterpOutput(state: InterpOutput, payload: unknown): InterpOutput {
  if (!payload || typeof payload !== "object") return state;
  const p = payload as Record<string, unknown>;
  if (p.kind === "segment_final") {
    const line: InterpLine = {
      src: String(p.source_text ?? ""),
      target: String(p.target_text ?? ""),
    };
    if (line.src || line.target) return { lines: [...state.lines, line] };
  }
  return state;
}
export function interpClear(): InterpOutput {
  return interpInit();
}
