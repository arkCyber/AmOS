/**
 * Pure helpers + persistence for the 同传 (simultaneous-interpretation) app.
 *
 * Kept free of React/DOM so they unit-test headlessly: language catalog,
 * remembered prefs (language pair + auto-speak), and a transcript that survives
 * reopening the app (mirroring the legacy vanilla interpreter app's `amos.interp`
 * / `amos.interp.log` keys so both UIs interoperate in the shared store).
 */
import { readStoreValue, writeStoreValue } from "./amosStore";

export const INTERP_PREFS_KEY = "amos.interp";
export const INTERP_LOG_KEY = "amos.interp.log";

export interface InterpPrefs {
  source: string;
  target: string;
  autospeak: boolean;
}

/** A finalized transcript segment, with optional detected/requested languages. */
export interface InterpSeg {
  src: string;
  target: string;
  srcLang?: string;
  targetLang?: string;
}

export interface LangOption {
  code: string;
  /** Native-language display name (empty for the special "auto" choice). */
  native: string;
}

/** Language options offered for interpretation (auto = detect source only). */
export const LANGS: LangOption[] = [
  { code: "auto", native: "" },
  { code: "zh", native: "中文" },
  { code: "en", native: "English" },
  { code: "ja", native: "日本語" },
  { code: "ko", native: "한국어" },
  { code: "fr", native: "Français" },
  { code: "es", native: "Español" },
];

export const DEFAULT_PREFS: InterpPrefs = {
  source: "auto",
  target: "zh",
  autospeak: false,
};

/** The native label for a language code (falls back to the code itself). */
export function langNative(code: string): string {
  return LANGS.find((l) => l.code === code)?.native ?? code;
}

/**
 * Join a finalized transcript into one copyable block. Returns the target lines
 * (skipping empty ones). When `includeSource` is set, each line becomes
 * `source → target` so a bilingual copy can be made.
 */
export function transcriptText(segs: readonly InterpSeg[], includeSource = false): string {
  const lines: string[] = [];
  for (const s of segs) {
    const target = s.target.trim();
    if (!target) continue;
    lines.push(includeSource && s.src.trim() ? `${s.src.trim()} → ${target}` : target);
  }
  return lines.join("\n");
}

/** Load remembered prefs (language pair + auto-speak) with safe defaults. */
export function readPrefs(): InterpPrefs {
  const p = readStoreValue<Partial<InterpPrefs> | null>(INTERP_PREFS_KEY, null);
  return {
    source: p?.source || DEFAULT_PREFS.source,
    target: p?.target || DEFAULT_PREFS.target,
    autospeak: p?.autospeak ?? DEFAULT_PREFS.autospeak,
  };
}

export function writePrefs(p: InterpPrefs): void {
  writeStoreValue(INTERP_PREFS_KEY, p);
}

/** Load the persisted interpretation transcript (empty array by default). */
export function loadSegs(): InterpSeg[] {
  return readStoreValue<InterpSeg[]>(INTERP_LOG_KEY, []);
}

export function saveSegs(segs: InterpSeg[]): void {
  writeStoreValue(INTERP_LOG_KEY, segs);
}

export function clearSegs(): void {
  saveSegs([]);
}

/** Build a persisted transcript record from a `segment_final` payload (or null). */
export function segOf(payload: unknown): InterpSeg | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== "segment_final") return null;
  const src = String(p.source_text ?? "");
  const target = String(p.target_text ?? "");
  if (!src && !target) return null;
  const opt = (v: unknown): string | undefined => {
    const s = String(v ?? "").trim();
    return s ? s : undefined;
  };
  return { src, target, srcLang: opt(p.source_lang), targetLang: opt(p.target_lang) };
}

/** Extract the live (transient) source text from a `partial` payload, or "". */
export function partialTextOf(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  return p.kind === "partial" ? String(p.text ?? "") : "";
}

/** True when the payload announces the session ended. */
export function sessionEndedOf(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as { kind?: string }).kind === "session_ended"
  );
}

/** Extract an error message from an `error` payload ("" otherwise). */
export function errorOf(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  return p.kind === "error" ? String(p.message ?? "") : "";
}
