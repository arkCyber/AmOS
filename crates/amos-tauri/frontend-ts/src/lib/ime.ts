/**
 * On-screen input method (IME) client — the System UI's pinyin keyboard.
 *
 * Split in two on purpose:
 *
 *  • **Bridge wrappers** (`imeStatus`/`imeKey`/…): one thin `invoke` per `ime_*`
 *    command the Rust bridge registers. The engine, the candidate ranking and the
 *    per-user learner all live in Rust (`amos-ime`); the WebView never ranks
 *    anything itself, so the UI cannot drift from the engine's dictionary.
 *  • **Pure helpers** (`isTextEntry`, `insertTextAtCursor`, the key layouts, the
 *    candidate pager): everything about *where* text goes and *what keys exist*,
 *    headless-testable without a backend.
 *
 * Honest boundaries (see `docs/input-method.md`): the keyboard emits letters,
 * digits/punctuation and space — it is not a full symbol/emoji keyboard, and
 * `contenteditable` hosts (like the note preview) are not targeted yet.
 */
import { invoke } from "./backend";
import { readStoreValue, writeStoreValue } from "./amosStore";

/** The nine fuzzy pairs, in display order (must match `amos_ime::FUZZY_PAIRS`). */
export const IME_FUZZY_PAIRS = [
  "z_zh",
  "c_ch",
  "s_sh",
  "n_l",
  "f_h",
  "r_l",
  "in_ing",
  "en_eng",
  "an_ang",
] as const;

/** QWERTY letter page. */
export const IME_LETTER_ROWS: readonly string[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

/** Digits + common punctuation page (toggled by the `?123` key). */
export const IME_SYMBOL_ROWS: readonly string[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'],
  [".", ",", "?", "!", "'", "*", "#", "%", "+", "="],
];

/** Candidates shown per page before the pager kicks in. */
export const IME_CANDIDATE_PAGE_SIZE = 8;

/** Store key for the keyboard on/off preference (configuration, device-local). */
export const IME_ENABLED_KEY = "amos-ui.ime";

/** Fuzzy-pair preferences (mirror of `amos_ime::FuzzyPrefs`). */
export interface ImeFuzzy {
  z_zh: boolean;
  c_ch: boolean;
  s_sh: boolean;
  n_l: boolean;
  f_h: boolean;
  r_l: boolean;
  in_ing: boolean;
  en_eng: boolean;
  an_ang: boolean;
}

/** One candidate (mirror of `amos_tauri::ime::ImeCandidateOut`). */
export interface ImeCandidate {
  text: string;
  /** `"dict"` (an exact dictionary word) or `"sentence"` (a composed guess). */
  kind: string;
}

/** The session state every `ime_*` command answers (mirror of `ImeStateOut`). */
export interface ImeState {
  input: string;
  candidates: ImeCandidate[];
  composing: boolean;
  strict: boolean;
  fuzzy: ImeFuzzy;
  dict_entries: number;
  learned_pins: number;
  learned_pending: number;
  last_committed: string | null;
  /** Code of the last **dictionary** commit, while undoing it is possible. */
  last_pick_code: string | null;
}

/** Reply of `ime_commit` (mirror of `amos_tauri::ime::ImeCommitOut`). */
export interface ImeCommit {
  committed: string | null;
  state: ImeState;
}

/** Current session state; `null` outside the Tauri shell. */
export async function imeStatus(): Promise<ImeState | null> {
  return invoke<ImeState>("ime_status");
}

/** Feed taps (ASCII letters compose; everything else is ignored by the engine). */
export async function imeKey(ch: string): Promise<ImeState | null> {
  return invoke<ImeState>("ime_key", { ch });
}

/** Delete the last buffered pinyin letter. */
export async function imeBackspace(): Promise<ImeState | null> {
  return invoke<ImeState>("ime_backspace");
}

/** Abandon the in-flight composition. */
export async function imeClear(): Promise<ImeState | null> {
  return invoke<ImeState>("ime_clear");
}

/** Commit candidate `index`; resolves the inserted text + new state. */
export async function imeCommit(index: number): Promise<ImeCommit | null> {
  return invoke<ImeCommit>("ime_commit", { index });
}

/** Toggle one fuzzy pair by its stable key. */
export async function imeFuzzyToggle(pair: string): Promise<ImeState | null> {
  return invoke<ImeState>("ime_fuzzy_toggle", { pair });
}

/** Apply a fuzzy preset (`"strict"` / `"permissive"`). */
export async function imeFuzzyPreset(preset: string): Promise<ImeState | null> {
  return invoke<ImeState>("ime_fuzzy_preset", { preset });
}

/** Forget everything the learner has learned. */
export async function imeLearningClear(): Promise<ImeState | null> {
  return invoke<ImeState>("ime_learning_clear");
}

/** Undo the just-committed dictionary word (drop its learned pin). */
export async function imeForgetLast(): Promise<ImeState | null> {
  return invoke<ImeState>("ime_forget_last");
}

/**
 * `true` when `el` is a field the keyboard may type into: a real, enabled text
 * `<input>` (text-like types only — a checkbox or a range is not a text field) or
 * a `<textarea>`. `null` / anything else is not.
 */
export function isTextEntry(el: Element | null | undefined): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly) return false;
    // `type` is normalized by the parser; the empty string is the default "text".
    return ["", "text", "search", "email", "url", "tel", "password"].includes(
      el.type.toLowerCase(),
    );
  }
  return false;
}

/**
 * Insert `text` at the field's caret (replacing a selection) and notify the host
 * component the way a real keystroke would: set the value, move the caret past the
 * inserted text, dispatch a bubbling `input` event (Svelte's `bind:value` reads the
 * element on that event). Returns `false` when the field refused the write
 * (read-only / a value setter that throws) **or when the host's declared
 * `maxlength` leaves nothing to insert**, so callers never claim an insertion that
 * did not happen.
 *
 * `maxlength` is deliberately honoured here: it constrains *user* input, but a
 * programmatic `.value` write sails straight past it — without the clamp the
 * keyboard would type beyond a limit the host declared (and that the same field's
 * real keystrokes could not). `-1` means "no limit".
 */
export function insertTextAtCursor(
  field: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): boolean {
  if (!text) return false;
  const value = field.value;
  const start = field.selectionStart ?? value.length;
  const end = field.selectionEnd ?? start;
  let next = value.slice(0, start) + text + value.slice(end);
  if (field.maxLength >= 0 && next.length > field.maxLength) {
    next = next.slice(0, field.maxLength);
    // `maxlength` counts UTF-16 code units, but a code unit is not a character:
    // cutting between the halves of a surrogate pair would write a lone surrogate
    // into the host's field. Drop the half rather than store a broken one.
    const last = next.charCodeAt(next.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) next = next.slice(0, -1);
  }
  // The limit can reduce the insertion to nothing (a field already at its limit):
  // writing the same value back and reporting success would be a phantom insert.
  if (next === value) return false;
  try {
    field.value = next;
  } catch {
    return false;
  }
  const caret = Math.min(start + text.length, next.length);
  try {
    field.setSelectionRange(caret, caret);
  } catch {
    // Some input types (email/tel) refuse selection APIs — the value is what matters.
  }
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/**
 * Whether the keyboard should default to **on**: touch-first devices get it, a
 * desktop does not (where a physical keyboard already works and an overlay would
 * be in the way). Pure so the decision is testable; the caller supplies the
 * `(pointer: coarse)` bit from `matchMedia`.
 */
export function imeDefaultOn(coarsePointer: boolean): boolean {
  return coarsePointer;
}

/** Read the persisted on/off preference, falling back to the device default. */
export function readImeEnabled(): boolean {
  const coarse =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  return readStoreValue<boolean>(IME_ENABLED_KEY, imeDefaultOn(coarse));
}

/** Persist the on/off preference (configuration — device-local by design). */
export function writeImeEnabled(on: boolean): void {
  writeStoreValue(IME_ENABLED_KEY, on);
}

/** Number of candidate pages for `total` candidates (always at least 1). */
export function candidatePageCount(total: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / IME_CANDIDATE_PAGE_SIZE));
}

/** The slice of candidates on `page` (0-based), clamped to the available data. */
export function pageCandidates<T>(items: readonly T[], page: number): T[] {
  const pages = candidatePageCount(items.length);
  const clamped = Math.min(Math.max(0, Math.trunc(page)), pages - 1);
  const start = clamped * IME_CANDIDATE_PAGE_SIZE;
  return items.slice(start, start + IME_CANDIDATE_PAGE_SIZE);
}

/**
 * Delete the character before the caret (or the current selection) and notify the
 * host the way a real Backspace would. Returns `false` when there was nothing to
 * delete — an empty field is not a failure the caller should report, but it must
 * not claim a deletion that did not happen either.
 *
 * A field type with no caret at all (`email`/`number`/… report `null` for
 * `selectionStart`) has exactly one honest position — the end — so Backspace
 * deletes the last character there instead of silently doing nothing.
 */
export function deleteBeforeCaret(
  field: HTMLInputElement | HTMLTextAreaElement,
): boolean {
  const value = field.value;
  const start = field.selectionStart;
  const end = field.selectionEnd;
  let from: number;
  let to: number;
  if (start === null || end === null) {
    to = value.length;
    from = Math.max(0, to - 1);
  } else if (start !== end) {
    from = start;
    to = end; // a selection is what Backspace deletes
  } else {
    from = Math.max(0, start - 1);
    to = start;
  }
  const next = value.slice(0, from) + value.slice(to);
  if (next === value) return false; // nothing changed ⇒ nothing to claim
  try {
    field.value = next;
  } catch {
    return false;
  }
  try {
    field.setSelectionRange(from, from);
  } catch {
    // Same as above — the value is what matters.
  }
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

