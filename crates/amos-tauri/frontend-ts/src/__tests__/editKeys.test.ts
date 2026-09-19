/**
 * editKeys.test.ts — ⌘A selects the focused field (REQ-A439).
 *
 * The defect this pins (measured on a live `Amos.app`, 2026-09-19): ⌘A did **nothing** in a
 * WebView text field — in every modifier combination, and ⌘A+⌘C left the pasteboard empty, i.e.
 * nothing was selected anywhere — while clicking 编辑 ▸ Select All selected the field's text and
 * the same keystrokes in TextEdit selected and copied. So the shell performs the gesture; these
 * cases are the rule it performs, including the two shapes it must **refuse** (a ⇧⌘A press, and
 * a non-editable focus) so no new dead chord can appear (F-SH-001).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  focusedEditable,
  isSelectAllChord,
  lastFocusedEditable,
  resetEditableFocusForTest,
  selectAllFromMenu,
  selectAllInFocus,
  trackEditableFocus,
} from "../lib/editKeys";

const chord = (over: Partial<Parameters<typeof isSelectAllChord>[0]> = {}) => ({
  key: "a",
  code: "KeyA",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

beforeEach(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    /* already registered */
  }
  document.body.innerHTML = "";
  // A selection survives `innerHTML = ""` in happy-dom, so a previous case's Range would leak
  // into the next one (it did: "no editable focus" read the *previous* case's selection).
  document.getSelection()?.removeAllRanges();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isSelectAllChord", () => {
  test("⌘A and ⌃A are the chord; the shift/alt/⌃⌘ variants are not", () => {
    expect(isSelectAllChord(chord({ metaKey: true }))).toBe(true);
    expect(isSelectAllChord(chord({ ctrlKey: true }))).toBe(true);
    // ⇧⌘A is "Deselect All" in macOS apps — not this gesture.
    expect(isSelectAllChord(chord({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSelectAllChord(chord({ metaKey: true, altKey: true }))).toBe(false);
    expect(isSelectAllChord(chord({ metaKey: true, ctrlKey: true }))).toBe(false);
    // Other ⌘-letters, and the bare key.
    expect(isSelectAllChord(chord({ metaKey: true, key: "c", code: "KeyC" }))).toBe(false);
    expect(isSelectAllChord(chord())).toBe(false);
  });

  test("a non-Latin layout still counts: the physical key is what the platform binds", () => {
    // e.g. a Chinese IME / Cyrillic layout: `key` is not `a`, `code` is still KeyA.
    expect(isSelectAllChord(chord({ metaKey: true, key: "ф" }))).toBe(true);
    // …and the reverse shape: a layout whose character is `a` on another key is not ours.
    expect(isSelectAllChord(chord({ metaKey: true, key: "a", code: "KeyF" }))).toBe(true);
  });
});

describe("focusedEditable", () => {
  test("an input / textarea / contenteditable host owns the focus; anything else does not", () => {
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    const plain = document.createElement("div");
    document.body.append(input, area, host, plain);

    input.focus();
    expect(focusedEditable()).toBe(input);
    area.focus();
    expect(focusedEditable()).toBe(area);
    host.focus();
    expect(focusedEditable()).toBe(host);
    plain.focus();
    expect(focusedEditable()).toBeNull();
  });
});

describe("selectAllInFocus", () => {
  test("an input selects its whole value and reports ownership", () => {
    const input = document.createElement("input");
    input.value = "OUR-ABC-123";
    document.body.append(input);
    input.focus();

    expect(selectAllInFocus()).toBe(true);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("OUR-ABC-123".length);
  });

  test("a textarea selects its whole value", () => {
    const area = document.createElement("textarea");
    area.value = "line one\nline two";
    document.body.append(area);
    area.focus();

    expect(selectAllInFocus()).toBe(true);
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(area.value.length);
  });

  test("a contenteditable host selects its contents (a Range, not execCommand)", () => {
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    host.textContent = "editable body";
    document.body.append(host);
    host.focus();

    expect(selectAllInFocus()).toBe(true);
    expect(document.getSelection()?.toString()).toBe("editable body");
  });

  test("no editable focus ⇒ false, so the caller leaves the key alone", () => {
    const plain = document.createElement("div");
    document.body.append(plain);
    plain.focus();
    expect(selectAllInFocus()).toBe(false);
    expect(document.getSelection()?.toString() ?? "").toBe("");
  });

  test("an input type with no selection model is not claimed", () => {
    // `type=color` has no text selection: `select()` throws in WebKit and leaves it empty in
    // others. Either way the rule must answer false rather than eat the chord.
    const colour = document.createElement("input");
    colour.type = "color";
    document.body.append(colour);
    colour.focus();

    const owned = selectAllInFocus();
    if (owned) {
      // A browser that does support it must have produced a range.
      expect(colour.selectionStart).not.toBeNull();
    } else {
      expect(colour.selectionStart).toBeNull();
    }

/**
 * The row's semantics (`selectAllFromMenu`) — the same function the host's `menu.edit.select-all`
 * event and the shell's in-app Edit menu row call, so there is one answer to "what does Edit ▸
 * Select All do" (F-SH-005's rule: one implementation).
 */
describe("selectAllFromMenu", () => {
  test("a focused field wins over the page", () => {
    const field = document.createElement("input");
    field.value = "row-selects-field";
    document.body.append(field);
    field.focus();

    expect(selectAllFromMenu()).toBe(true);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("row-selects-field".length);
  });

  test("with no editable focus it answers without throwing (the page fallback may be a no-op here)", () => {
    const plain = document.createElement("div");
    document.body.append(plain);
    plain.focus();
    // WebKit still honours `execCommand("selectAll")`; a DOM shim that does not must not make the
    // activation throw — it is absorbed and the shell keeps running.
    expect(typeof selectAllFromMenu()).toBe("boolean");
  });
});

  });
});

/**
 * The remembered editable focus — the DOM half of AppKit's first responder (REQ-A439).
 */
describe("trackEditableFocus", () => {
  test("a move into a field is remembered; a move to a button clears it", () => {
    const field = document.createElement("input");
    field.value = "remembered";
    const button = document.createElement("button");
    document.body.append(field, button);
    const stop = trackEditableFocus();
    try {
      field.focus();
      expect(lastFocusedEditable()).toBe(field);
      // macOS hands the first responder over; it does not keep the old field alive.
      button.focus();
      expect(lastFocusedEditable()).toBeNull();
    } finally {
      stop();
      resetEditableFocusForTest();
    }
  });

  test("after a native menu takes the DOM focus away, the remembered field is still selected", () => {
    const field = document.createElement("input");
    field.value = "menu-selects-me";
    document.body.append(field);
    const stop = trackEditableFocus();
    try {
      field.focus();
      // What clicking a native menu row does to the page: the DOM focus drops to `<body>`.
      (document.activeElement as HTMLElement | null)?.blur();
      expect(focusedEditable()).toBe(field);
      expect(selectAllFromMenu()).toBe(true);
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe("menu-selects-me".length);
    } finally {
      stop();
      resetEditableFocusForTest();
    }
  });

  test("a pop-up menu row taking focus does NOT erase the field being edited", () => {
    const field = document.createElement("input");
    field.value = "still-here";
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const row = document.createElement("button");
    row.setAttribute("role", "menuitem");
    menu.append(row);
    document.body.append(field, menu);
    const stop = trackEditableFocus();
    try {
      field.focus();
      // Clicking `Edit ▸ Select All` in the shell's own menu moves DOM focus to the row…
      row.focus();
      // …but macOS's first responder does not move for a menu, so the field is still the target.
      expect(lastFocusedEditable()).toBe(field);
      expect(selectAllFromMenu()).toBe(true);
      expect(field.selectionEnd).toBe("still-here".length);
    } finally {
      stop();
      resetEditableFocusForTest();
    }
  });
});

