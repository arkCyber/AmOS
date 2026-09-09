/**
 * lib/noteEditing.ts — cursor-aware editing transforms for the Notes editor.
 *
 * All functions are **pure**: they take a note's whole text (the editor edits the
 * full body, exactly what `NotesApp` binds to `editVal`) plus a character offset
 * (the caret), and return the new text + new caret offset. They never touch the
 * DOM, so they are exhaustively unit-tested headless; the Svelte editor wires
 * them to keydown / buttons and restores the caret from the returned offset.
 *
 * Behaviour implemented:
 *   * toggle the task checkbox on the caret's line (open ⇄ done);
 *   * Enter inside a checklist line continues with a new `- [ ] ` line (the text
 *     after the caret, if any, carries onto the new task line);
 *   * Tab / Shift+Tab indent / outdent the caret's line by two spaces;
 *   * turn the caret's line into a checklist item when it isn't one already.
 */

/** The text + caret offset a transform produces. */
export interface EditResult {
  text: string;
  /** Where the caret should land after the edit (offset into `text`). */
  cursor: number;
  /** True when the transform actually changed something. */
  changed: boolean;
}

/** Start/end (exclusive of a trailing newline) of the line containing `offset`. */
export function noteLineRange(
  text: string,
  offset: number,
): { lineStart: number; lineEnd: number } {
  const o = Math.min(Math.max(0, offset), text.length);
  const lineStart = text.lastIndexOf("\n", o === text.length ? o - 1 : o) + 1;
  const nl = text.indexOf("\n", lineStart);
  const lineEnd = nl === -1 ? text.length : nl;
  return { lineStart, lineEnd };
}

/** A checklist line: indent, the `[x]/[ ]` mark, and everything after the bracket. */
const TASK_LINE = /^(\s*)[-*]\s+\[([ xX])\](.*)$/;

/** If the caret's line is a checklist item, toggle its box and return the edit;
 *  otherwise `null` (caller decides whether to let the default happen). */
export function toggleTaskLineAt(text: string, offset: number): EditResult | null {
  const { lineStart, lineEnd } = noteLineRange(text, offset);
  const line = text.slice(lineStart, lineEnd);
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  const indent = m[1] ?? "";
  const mark = m[2] ?? " ";
  const rest = m[3] ?? "";
  const next = mark === " " ? "x" : " ";
  const newLine = `${indent}- [${next}]${rest}`;
  return {
    text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
    cursor: offset,
    changed: true,
  };
}

/** Pressing Enter on a checklist line continues it with a new `- [ ] ` task line.
 *  The text after the caret (if any) becomes the new task's content. Returns the
 *  edit, or `null` when the caret's line is not a checklist item. */
export function enterContinuesTask(text: string, offset: number): EditResult | null {
  const { lineStart, lineEnd } = noteLineRange(text, offset);
  const line = text.slice(lineStart, lineEnd);
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  const indent = m[1] ?? "";
  const caret = Math.min(Math.max(0, offset), text.length);
  // Whatever remains on this line after the caret moves onto the new task line.
  const remainder = text.slice(caret, lineEnd).replace(/^[ \t]+/, "");
  const newTask = `${indent}- [ ] `;
  const before = text.slice(0, caret);
  const after = text.slice(lineEnd);
  const inserted = `\n${newTask}${remainder}`;
  return {
    text: before + inserted + after,
    cursor: before.length + inserted.length - remainder.length,
    changed: true,
  };
}

/** Indent (`outdent=false`) or outdent the caret's line by `n` spaces.
 *  Outdent removes up to `n` leading spaces (or one tab). Returns the edit. */
export function shiftLineIndent(
  text: string,
  offset: number,
  n: number,
  outdent: boolean,
): EditResult {
  const { lineStart, lineEnd } = noteLineRange(text, offset);
  const spaces = Math.max(1, Math.floor(n));
  let newText = text;
  let cursor = offset;
  if (!outdent) {
    newText = text.slice(0, lineStart) + " ".repeat(spaces) + text.slice(lineStart);
    cursor = offset + spaces;
  } else {
    // Count removable leading spaces (or a single tab).
    let removed = 0;
    let i = lineStart;
    while (removed < spaces && i < lineEnd && text[i] === " ") {
      removed += 1;
      i += 1;
    }
    if (removed === 0 && i < lineEnd && text[i] === "\t") {
      removed = 1;
      i += 1;
    }
    if (removed === 0) return { text, cursor: offset, changed: false };
    newText = text.slice(0, lineStart) + text.slice(lineStart + removed);
    // Keep the caret in a sensible place after removing leading spaces before it.
    const onLineCol = offset - lineStart;
    cursor = offset - (offset >= lineStart + removed ? removed : Math.min(removed, onLineCol));
    if (cursor < lineStart) cursor = lineStart;
  }
  return { text: newText, cursor, changed: newText !== text };
}

/** Make the caret's line a checklist item (`- [ ] …`) when it isn't already a
 *  task or a `- `/`* ` list line. Returns `null` if already a list/task line. */
export function prefixTaskAtLine(text: string, offset: number): EditResult | null {
  const { lineStart, lineEnd } = noteLineRange(text, offset);
  const line = text.slice(lineStart, lineEnd);
  if (!line.trim()) return null; // empty line → leave to the caller / default
  if (TASK_LINE.test(line)) return null; // already a checklist item
  if (/^\s*[-*]\s+/.test(line)) return null; // a plain list item already
  const prefix = "- [ ] ";
  return {
    text: text.slice(0, lineStart) + prefix + text.slice(lineStart),
    cursor: offset + prefix.length,
    changed: true,
  };
}
