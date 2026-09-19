/**
 * editKeys.ts — the one editing chord the platform does not deliver to us: **⌘A** (REQ-A439).
 *
 * Measured on this machine (2026-09-19, four AX probes on a live `Amos.app`, Files window's
 * search field focused by a real tab/click, with TextEdit as the control):
 *
 * | gesture | AmOS | TextEdit (control) |
 * |---|---|---|
 * | ⌘C / ⌘X / ⌘V / ⌘Z | act (and ⌘Z undoes what was typed) | act |
 * | clicking 编辑 ▸ Cut/Copy/Paste/Undo/Select All | act | — |
 * | **⌘A / ⇧⌘A / ⌥⇧⌘A** | **nothing** (⌘A+⌘C leaves the pasteboard empty ⇒ no selection anywhere) | selects + copies |
 *
 * So the native menu's `selectAll:` never runs from the keyboard in this app (the row works on
 * click), and the OS does not hand the chord to the WebView either — a text field that cannot be
 * selected with ⌘A is the same F-SH-001 family as a menu row that looks actionable and is not.
 * The shell therefore performs the gesture itself, with the rule macOS uses:
 *
 *   • an `<input>` / `<textarea>` selects **its own value** (`select()`),
 *   • a `contenteditable` host selects **its contents** (a `Range` — no deprecated `execCommand`),
 *   • **anything else keeps the key**: a desktop UI has no "select the whole page" meaning, so
 *     claiming the chord there would only invent another dead key (and would shadow the
 *     desktop's own ⌘A-free list navigation, e.g. `lib/filesA11y.ts`).
 *
 * One implementation, used by both windows that own chords (`DesktopShell` for the launcher,
 * `DesktopWindowKeys` for an app window) and by the in-app menu row — three copies of "what does
 * ⌘A select" is exactly how the two drift apart (F-SH-005).
 */

/** The parts of a key event the rule reads (a `KeyboardEvent` satisfies this). */
export interface EditChordEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Is this the "select all" chord — ⌘A on macOS, ⌃A elsewhere?
 *
 * `code` is checked first: with a non-Latin layout (a Chinese IME, a Cyrillic keyboard) `key`
 * is not `a` while the physical key still is, and the platform's own Edit ▸ Select All row is
 * bound to the key equivalent, not to the layout's character. `⇧⌘A` is deliberately **not**
 * ours (macOS apps use it for "Deselect All"), and neither is `⌃⌘A`.
 */
export function isSelectAllChord(e: EditChordEvent): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (e.metaKey === e.ctrlKey) return false; // need exactly one of ⌘ / ⌃
  return e.code === "KeyA" || e.key === "a" || e.key === "A";
}

/**
 * The editable element the user last put the caret in — the DOM's equivalent of AppKit's **first
 * responder**, which is what the platform's own `selectAll:` acted on.
 *
 * Why it is needed (measured 2026-09-19, REQ-A439): clicking a **native menu row** makes the
 * WebView drop the DOM focus to `<body>`, so a rule that only reads `document.activeElement`
 * finds nothing to select — the platform's predefined row worked because AppKit's first responder
 * survives the menu being open. Remembering the last editable focus reproduces that, for the
 * keyboard path and the menu path alike.
 */
let lastEditable: HTMLElement | null = null;

/** Remember every focus change. Returns an uninstaller. */
export function trackEditableFocus(doc: Document = document): () => void {
  const onFocusIn = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // A pop-up menu row is not a focus destination in macOS terms: opening a menu does not move
    // the first responder, so a row that happens to take DOM focus must not erase the field the
    // user was editing (`Edit ▸ Select All` is exactly that case).
    if (target.closest('[role="menu"], [role="menuitem"], [role="menuitemradio"]')) return;
    // Anywhere else, the first responder really was handed over — macOS does not keep the old
    // field alive when you click a button.
    lastEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
        ? target
        : null;
  };
  doc.addEventListener("focusin", onFocusIn, true);
  return () => doc.removeEventListener("focusin", onFocusIn, true);
}

/** The remembered editable element, if it is still in the document. */
export function lastFocusedEditable(): HTMLElement | null {
  if (lastEditable && !lastEditable.isConnected) lastEditable = null;
  return lastEditable;
}

/** Forget the remembered element (tests only — the convention every reset fn here follows). */
export function resetEditableFocusForTest(): void {
  lastEditable = null;
}

/** The editable element that owns the focus, or `null`. */
export function focusedEditable(doc: Document = document): HTMLElement | null {
  const el = doc.activeElement as HTMLElement | null;
  if (el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
    if (el.isContentEditable) return el;
  }
  // Nothing editable holds the DOM focus (e.g. the shell just came back from a native menu):
  // fall back to the element the user was editing, like AppKit's first responder would.
  return lastFocusedEditable();
}

/**
 * Select the focused field's contents.
 *
 * `true` when this module did it — the caller then owns the chord (`preventDefault`).
 * `false` when nothing editable has the focus, or when the element has no selection model
 * (`<input type="number">` ignores `select()`); the caller must then **not** consume the key.
 */
export function selectAllInFocus(doc: Document = document): boolean {
  const el = focusedEditable(doc);
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Some input types (number/color/date) have no text selection: `select()` either throws or
    // leaves the selection range empty, and claiming the chord there would be a dead key.
    try {
      el.select();
    } catch {
      return false;
    }
    return el.selectionStart !== null && el.selectionEnd !== null;
  }
  const selection = doc.getSelection();
  if (!selection) return false;
  const range = doc.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * What the **Edit ▸ Select All row** does, wherever it is activated from (the native menu's
 * `menu.edit.select-all` event, or the shell's own in-app menu row):
 *
 *   • a focused field selects its contents (macOS's own meaning for a text field), else
 *   • the page's text is selected — which is what the platform's `selectAll:` did for a
 *     non-editable focus, so the row never becomes a row that does nothing (F-SH-001).
 *
 * `execCommand` is deprecated, and it is the only remaining way to reproduce the platform's
 * page-level selection from script (WebKit still honours `selectAll`); the field case, which is
 * the one a user actually needs, does **not** depend on it.
 */
export function selectAllFromMenu(doc: Document = document): boolean {
  if (selectAllInFocus(doc)) return true;
  try {
    return doc.execCommand("selectAll");
  } catch {
    return false;
  }
}
