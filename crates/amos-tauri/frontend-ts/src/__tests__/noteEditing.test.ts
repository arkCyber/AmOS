import { describe, expect, test } from "bun:test";
import {
  enterContinuesTask,
  noteLineRange,
  prefixTaskAtLine,
  shiftLineIndent,
  toggleTaskLineAt,
} from "../lib/noteEditing";

describe("noteLineRange", () => {
  test("bounds each line excluding its newline", () => {
    const text = "aa\nbbbb\nc";
    expect(noteLineRange(text, 0)).toEqual({ lineStart: 0, lineEnd: 2 }); // "aa"
    expect(noteLineRange(text, 4)).toEqual({ lineStart: 3, lineEnd: 7 }); // "bbbb"
    expect(noteLineRange(text, 8)).toEqual({ lineStart: 8, lineEnd: 9 }); // "c"
    expect(noteLineRange(text, 99)).toEqual({ lineStart: 8, lineEnd: 9 }); // clamp past end
  });
});

describe("toggleTaskLineAt", () => {
  test("open → done on the caret's line", () => {
    const r = toggleTaskLineAt("- [ ] buy milk\n- [ ] eggs", 2)!;
    expect(r.text).toBe("- [x] buy milk\n- [ ] eggs");
    expect(r.cursor).toBe(2);
    expect(r.changed).toBe(true);
  });
  test("done → open", () => {
    expect(toggleTaskLineAt("- [x] done", 0)!.text).toBe("- [ ] done");
  });
  test("non-task line returns null", () => {
    expect(toggleTaskLineAt("just a paragraph", 3)).toBeNull();
  });
});

describe("enterContinuesTask", () => {
  test("pressing Enter at end of a task continues with a new empty task", () => {
    const text = "- [ ] buy milk\n- [ ] eggs";
    const r = enterContinuesTask(text, 14)!;
    expect(r.text).toBe("- [ ] buy milk\n- [ ] \n- [ ] eggs");
    // caret sits just after the new "- [ ] " marker
    expect(r.text[r.cursor]).toBe("\n");
    expect(r.changed).toBe(true);
  });
  test("text after the caret carries onto the new task line", () => {
    const r = enterContinuesTask("- [ ] abcdef", 9)!; // caret after "abc"
    expect(r.text).toBe("- [ ] abc\n- [ ] def");
  });
  test("non-task line returns null (default newline allowed)", () => {
    expect(enterContinuesTask("hello world", 3)).toBeNull();
  });
});

describe("shiftLineIndent", () => {
  test("Tab indents the caret's line by two spaces", () => {
    const r = shiftLineIndent("line", 0, 2, false);
    expect(r.text).toBe("  line");
    expect(r.cursor).toBe(2);
  });
  test("Shift+Tab outdents up to two leading spaces", () => {
    const r = shiftLineIndent("  - [ ] a", 9, 2, true);
    expect(r.text).toBe("- [ ] a");
    expect(r.cursor).toBe(7);
  });
  test("outdent with nothing to remove is a no-op", () => {
    const r = shiftLineIndent("- [ ] a", 0, 2, true);
    expect(r.changed).toBe(false);
    expect(r.text).toBe("- [ ] a");
  });
});

describe("prefixTaskAtLine", () => {
  test("turns a plain line into a checklist item", () => {
    const r = prefixTaskAtLine("write docs", 5)!;
    expect(r.text).toBe("- [ ] write docs");
    expect(r.cursor).toBe(11);
  });
  test("leaves existing tasks / list items and empty lines alone", () => {
    expect(prefixTaskAtLine("- [ ] a", 0)).toBeNull();
    expect(prefixTaskAtLine("- buy", 0)).toBeNull();
    expect(prefixTaskAtLine("   ", 0)).toBeNull();
  });
});
