/**
 * On-screen input method (IME) client — the System UI's pinyin keyboard.
 *
 * Split in two on purpose:
 *
 *  • **Bridge wrappers** (`imeStatus`/`imeKey`/…): one thin `invoke` per `ime_*`
 *    command the Rust bridge registers. The engine, the candidate ranking and the
 *    per-user learner all live in Rust (`amos-ime`); the WebView never ranks
 *    anything itself, so the UI cannot drift from the engine's dictionary.
 *    The session is **per window** (REQ-A258): the host files each buffer under the
 *    calling `WebviewWindow`'s label, and injects that window itself — so these
 *    wrappers deliberately take no window argument (the `clipboard.ts` precedent).
 *    The dictionary + learner are process-wide: a word learned in one window ranks
 *    first in the other.
 *  • **Pure helpers** (`isTextEntry`, `insertTextAtCursor`, the key layouts, the
 *    candidate pager): everything about *where* text goes and *what keys exist*,
 *    headless-testable without a backend.
 *
 * Honest boundaries (see `docs/input-method.md`): the keyboard emits letters,
 * digits/punctuation and space — it is not a full symbol/emoji keyboard, and
 * `contenteditable` hosts (like the note preview) are not targeted yet. In Chinese
 * mode a punctuation key is the **Chinese** glyph (`，。？！`); the half-width forms
 * live on the English page, and digits stay half-width in both modes.
 */
import { bridgeDiag, invoke } from "./backend";
import { readStoreValue, writeStoreValueChecked } from "./amosStore";

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

/** Digits + ASCII punctuation page (the `?123` key in **English** mode). */
export const IME_SYMBOL_ROWS: readonly string[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'],
  [".", ",", "?", "!", "'", "*", "#", "%", "+", "="],
];

/**
 * Digits + **Chinese** punctuation page — what the `?123` key shows in Chinese
 * mode. Half-width ASCII punctuation belongs to the English page; in Chinese mode
 * a punctuation key must read as Chinese (`，。？！`), the way every pinyin IME
 * behaves. Digits stay half-width on purpose: `１２３` is never what a phone-number
 * field wants.
 *
 * REQ-A759 (F-SH-216): the Chinese punctuation layer.
 */
export const IME_ZH_SYMBOL_ROWS: readonly string[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["，", "。", "？", "！", "、", "：", "；", "“", "”", "…"],
  ["（", "）", "《", "》", "【", "】", "「", "」", "‘", "’"],
];

/**
 * The ASCII→Chinese (full-width) punctuation a **physical** keyboard key becomes
 * in Chinese mode. Only punctuation with an unambiguous Chinese form is mapped
 * (a comma is always `，`); a straight quote has no single Chinese form — a
 * Chinese quotation is a *pair* (`“…”` / `‘…’`) and both glyphs are keys on the
 * Chinese symbol page — so `"`/`'` map to the **opening** glyph rather than
 * guessing an open/close alternation from invisible state.
 *
 * Everything else (letters, digits, and ASCII symbols with no Chinese twin, like
 * `@` or `#`) passes through unchanged — that is what keeps an email address or a
 * phone number typed in Chinese mode readable.
 */
const ZH_PUNCTUATION: Readonly<Record<string, string>> = {
  ",": "，",
  ".": "。",
  "?": "？",
  "!": "！",
  ":": "：",
  ";": "；",
  "(": "（",
  ")": "）",
  "<": "《",
  ">": "》",
  "[": "【",
  "]": "】",
  "{": "「",
  "}": "」",
  "\\": "、",
  "'": "‘",
  '"': "“",
};

/** The Chinese form of an ASCII punctuation key, or the key itself when it has none. */
export function toChinesePunctuation(ch: string): string {
  return ZH_PUNCTUATION[ch] ?? ch;
}

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

/* ---- The Android **system** IME's entry point (REQ-A1904) -------------------- */

/**
 * What the **platform** says about AmOS's own keyboard, as
 * `ime_system_status` answers it (mirror of `SystemImeStatus`).
 *
 * `enabled` / `selected` / `current_id` are `null` when the platform was never asked,
 * and that is **not** the same as `false` / `""`: `false` is the platform's own
 * sentence ("this keyboard is not enabled"), and folding "we could not ask" into it
 * would print the platform's word for a question nobody answered (REQ-A775 /
 * F-AND-007, the family `nfc_status` paid for).
 */
export interface SystemImeStatus {
  available: boolean;
  /** Why not, in the host's own words; `""` when `available`. */
  reason: string;
  enabled: boolean | null;
  selected: boolean | null;
  /** The platform's current keyboard id; `""` is the platform reporting *none*. */
  current_id: string | null;
}

/**
 * Which of the four things the user needs to be told, from the platform's answer
 * alone. Pure, so the branch a device would take is pinned headlessly.
 *
 * The order matters and is the point of the function: `unavailable` is asked
 * **before** any of the flags, because a status whose reads failed has no flags to
 * read — a classifier that tested `enabled` first would answer `"disabled"` (a
 * platform statement) for a device that never spoke.
 */
export type SystemImeState =
  /** This build cannot ask the platform (a desktop/host build, or no bound Context). */
  | "unavailable"
  /** In force: AmOS's keyboard is the one the platform is using. */
  | "current"
  /** Enabled but another keyboard is in force — the ordinary Gboard case. */
  | "enabled"
  /** The platform says AmOS's keyboard is not in its enabled list. */
  | "disabled"
  /** The platform answered, but not in a shape this build recognises. */
  | "unknown";

export function imeSystemState(status: SystemImeStatus): SystemImeState {
  if (!status.available) return "unavailable";
  if (status.enabled === null) return "unknown";
  if (!status.enabled) return "disabled";
  if (status.selected === null) return "unknown";
  return status.selected ? "current" : "enabled";
}

/** The platform's answer about AmOS's keyboard (never throws — see `SystemImeStatus`). */
export async function imeSystemStatus(): Promise<SystemImeStatus | null> {
  return invoke<SystemImeStatus>("ime_system_status");
}

/**
 * Show the platform's keyboard switcher (lists **enabled** keyboards only).
 *
 * `true` when the platform took the request. The command returns `()`, which the wire
 * carries as `null` — and the bridge *also* answers `null` for a refusal — so
 * `result !== null` would be false even on success (REQ-A513). The one place the two
 * are distinguishable is the diagnostic ledger, read back by command name, exactly as
 * `spaces.ts::unitMutationOk` does it.
 */
export async function imeSystemOpenPicker(): Promise<boolean> {
  await invoke<null>("ime_system_open_picker");
  return bridgeDiag("ime_system_open_picker").ok;
}

/**
 * Open the platform's input-method settings — the screen where AmOS 拼音 is
 * **enabled**. This is the door a user who has never enabled it cannot reach from the
 * picker, which lists enabled keyboards only.
 *
 * `true` when the platform took the request (see [`imeSystemOpenPicker`] for why the
 * ledger, not the reply, is what says so).
 */
export async function imeSystemOpenSettings(): Promise<boolean> {
  await invoke<null>("ime_system_open_settings");
  return bridgeDiag("ime_system_open_settings").ok;
}

/** The two commands [`imeSystemFailureKey`] can be asked about. */
export type ImeSystemOpenCommand = "ime_system_open_picker" | "ime_system_open_settings";

/**
 * Which sentence a refused `ime_system_open_*` earns — the one rule, so a refusal can never be
 * rendered as "nothing happened" (`spacesFailure`, F-SH-577).
 *
 * The specific case is the picker's **platform precondition**, and it is the reason this rule
 * exists: `showInputMethodPicker()` draws the switcher from the serving IME's window, so with
 * nothing accepting text the platform returns having shown nothing (measured on the S5
 * 2026-09-26: `mServedInputConnection=null` ⇒ no window, `mCurrentFocus` still AmOS's own
 * activity; with a served connection the 「选择输入法」 dialog appeared). The glue now answers
 * `no_editor` for that, which the host carries as `amos.ime.system_no_text_editor` — a retry
 * word ("could not open the system screen. Please try again.") would be a lie about what the
 * user must do, which is put the caret in a text field or use the settings door.
 *
 * `bridgeDiag` keeps one reading **per command name**, so the caller must pass the command its
 * own `open()` just ran (with concurrent calls it reads the most recently completed one — this
 * repo's established reading for an unseparable return value).
 */
export function imeSystemFailureKey(command: ImeSystemOpenCommand): string {
  const diag = bridgeDiag(command);
  if (diag.ok) return "ime.systemOpenFailed";
  const detail =
    diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
      ? (diag.detail as { code?: string })
      : null;
  return detail?.code === "amos.ime.system_no_text_editor"
    ? "ime.systemNoTextEditor"
    : "ime.systemOpenFailed";
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

/**
 * Persist the on/off preference (configuration — device-local by design).
 *
 * Returns the **store's** verdict (REQ-A1432), because this preference *is* the on-screen
 * claim: the Settings switch and the keyboard's own ⌨ button each draw the value they just
 * wrote, and it is the very key the *other* surface reads back. A refused `setItem`
 * therefore cannot be reported as a saved preference — the switch would light (or the dock
 * would rise) while `amos-ui.ime` still held the old value, and the listener each surface
 * installs to stop the two from drifting (`STORE_CHANGED_EVENT`, dispatched only **after** a
 * write lands) would never fire to correct it. `writeJson` refuses **per `setItem`**, so even
 * a one-bit key is refused once the quota is gone.
 */
export function writeImeEnabled(on: boolean): boolean {
  return writeStoreValueChecked(IME_ENABLED_KEY, on);
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
 * The index a Backspace should delete back to: `index - 1`, or `index - 2` when
 * the preceding code unit is the **low half of a surrogate pair**. Deleting one
 * UTF-16 code unit there would cut a single character in half and leave a lone
 * high surrogate in the field — a broken string the host then stores (JSON
 * round-trips a lone surrogate). One Backspace removes one *character*.
 *
 * The mirror of the guard `insertTextAtCursor` applies at its truncation boundary
 * (REQ-A1931 ∕ F-SH-931). `charCodeAt` of an out-of-range index is `NaN`, so both
 * comparisons are false at the start of the value and this answers `index - 1`.
 */
function codeUnitStartBefore(value: string, index: number): number {
  const lo = value.charCodeAt(index - 1);
  const hi = value.charCodeAt(index - 2);
  const isLowHalf = lo >= 0xdc00 && lo <= 0xdfff;
  const isHighHalf = hi >= 0xd800 && hi <= 0xdbff;
  return isLowHalf && isHighHalf ? index - 2 : index - 1;
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
 *
 * "One character" is one **code point**, not one code unit: a non-BMP glyph (an
 * emoji) is two code units, and deleting only the low half leaves a lone surrogate
 * behind — the same hazard `insertTextAtCursor` refuses at the truncation boundary
 * (REQ-A1931 ∕ F-SH-931).
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
    from = Math.max(0, codeUnitStartBefore(value, to));
  } else if (start !== end) {
    from = start;
    to = end; // a selection is what Backspace deletes
  } else {
    from = Math.max(0, codeUnitStartBefore(value, start));
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

