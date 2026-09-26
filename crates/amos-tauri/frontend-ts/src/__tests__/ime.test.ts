import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  IME_CANDIDATE_PAGE_SIZE,
  IME_ENABLED_KEY,
  IME_FUZZY_PAIRS,
  IME_LETTER_ROWS,
  IME_SYMBOL_ROWS,
  IME_ZH_SYMBOL_ROWS,
  candidatePageCount,
  deleteBeforeCaret,
  imeBackspace,
  imeClear,
  imeCommit,
  imeDefaultOn,
  imeForgetLast,
  imeFuzzyPreset,
  imeFuzzyToggle,
  imeKey,
  imeLearningClear,
  imeStatus,
  insertTextAtCursor,
  isTextEntry,
  pageCandidates,
  readImeEnabled,
  toChinesePunctuation,
  writeImeEnabled,
} from "../lib/ime";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

/** Install a fake `__TAURI_INTERNALS__.invoke` and return the recorded calls. */
function fakeBridge(reply: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return Promise.resolve(reply(command, args));
    },
  };
  return calls;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  window.localStorage.removeItem(IME_ENABLED_KEY);
});

describe("lib/ime — bridge wrappers", () => {
  test("every command is sent by name with lowerCamelCase arguments", async () => {
    const calls = fakeBridge((command) =>
      command === "ime_commit"
        ? { committed: "中国", state: { input: "", candidates: [] } }
        : { input: "zhong", candidates: [] },
    );
    const state = await imeStatus();
    expect(state?.input).toBe("zhong");
    await imeKey("z");
    await imeBackspace();
    await imeClear();
    const out = await imeCommit(2);
    await imeFuzzyToggle("z_zh");
    await imeFuzzyPreset("strict");
    await imeLearningClear();
    await imeForgetLast();

    expect(calls.map((c) => c.command)).toEqual([
      "ime_status",
      "ime_key",
      "ime_backspace",
      "ime_clear",
      "ime_commit",
      "ime_fuzzy_toggle",
      "ime_fuzzy_preset",
      "ime_learning_clear",
      "ime_forget_last",
    ]);
    expect(calls[1]?.args).toEqual({ ch: "z" });
    expect(calls[4]?.args).toEqual({ index: 2 });
    expect(calls[5]?.args).toEqual({ pair: "z_zh" });
    expect(calls[6]?.args).toEqual({ preset: "strict" });
    expect(out?.committed).toBe("中国");
  });

  test("outside the Tauri shell every wrapper degrades to null", async () => {
    expect(await imeStatus()).toBeNull();
    expect(await imeKey("z")).toBeNull();
    expect(await imeCommit(0)).toBeNull();
    expect(await imeForgetLast()).toBeNull();
  });
});

describe("lib/ime — 被拒的写入不是「已保存的偏好」（REQ-A1432）", () => {
  /** Replace `window.localStorage` with one whose `setItem` throws **only** for `key`. */
  function installRefusingStorage(key: string): () => void {
    const real = window.localStorage;
    const fake = {
      getItem: (k: string) => real.getItem(k),
      removeItem: (k: string) => real.removeItem(k),
      clear: () => real.clear(),
      key: (i: number) => real.key(i),
      get length() {
        return real.length;
      },
      setItem: (k: string, v: string) => {
        if (k === key) throw new DOMException("quota", "QuotaExceededError");
        real.setItem(k, v);
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: fake,
      configurable: true,
      writable: true,
    });
    return () => {
      Object.defineProperty(window, "localStorage", {
        value: real,
        configurable: true,
        writable: true,
      });
    };
  }

  test("writeImeEnabled 把存储的判决交回调用方（拒写 ⇒ false，且盘上还是旧值）", () => {
    window.localStorage.setItem(IME_ENABLED_KEY, "false");
    const restore = installRefusingStorage(IME_ENABLED_KEY);
    try {
      expect(writeImeEnabled(true)).toBe(false);
      // 这就是「偏好」这个断言所依赖的事实：屏幕上的开关若跟着动，盘上并没有动。
      expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("false");
      expect(readImeEnabled()).toBe(false);
    } finally {
      restore();
    }
    // 存储回来可写 ⇒ 判决翻成 true，且这次真的落盘了。
    expect(writeImeEnabled(true)).toBe(true);
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("true");
  });
});

describe("lib/ime — text-entry helpers", () => {
  test("isTextEntry accepts real text fields and rejects the rest", () => {
    const input = document.createElement("input");
    const search = document.createElement("input");
    search.type = "search";
    const area = document.createElement("textarea");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    const readOnly = document.createElement("input");
    readOnly.readOnly = true;
    const disabled = document.createElement("input");
    disabled.disabled = true;
    const div = document.createElement("div");

    expect(isTextEntry(input)).toBe(true);
    expect(isTextEntry(search)).toBe(true);
    expect(isTextEntry(area)).toBe(true);
    expect(isTextEntry(checkbox)).toBe(false);
    expect(isTextEntry(hidden)).toBe(false);
    expect(isTextEntry(readOnly)).toBe(false);
    expect(isTextEntry(disabled)).toBe(false);
    expect(isTextEntry(div)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(undefined)).toBe(false);
  });

  test("insertTextAtCursor inserts at the caret and announces an input event", () => {
    const field = document.createElement("textarea");
    field.value = "nihao";
    field.setSelectionRange(5, 5);
    let events = 0;
    field.addEventListener("input", () => (events += 1));

    expect(insertTextAtCursor(field, "!")).toBe(true);
    expect(field.value).toBe("nihao!");
    expect(field.selectionStart).toBe(6);
    expect(events).toBe(1);

    // A selection is replaced, not appended.
    field.setSelectionRange(0, 5);
    expect(insertTextAtCursor(field, "世界")).toBe(true);
    expect(field.value).toBe("世界!");
  });

  test("insertTextAtCursor never claims an empty insertion", () => {
    const field = document.createElement("input");
    field.value = "x";
    expect(insertTextAtCursor(field, "")).toBe(false);
    expect(field.value).toBe("x");
  });

  test("an insertion never writes past the host's declared maxlength", () => {
    const field = document.createElement("input");
    field.maxLength = 5;
    field.value = "abc";
    field.setSelectionRange(3, 3);

    // Room for exactly two characters: they land, the caret follows them.
    expect(insertTextAtCursor(field, "中国")).toBe(true);
    expect(field.value).toBe("abc中国");
    expect(field.selectionStart).toBe(5);

    // The field is full now: the third character cannot land, so it is refused
    // rather than written past the limit (a real keystroke could not do it either).
    expect(insertTextAtCursor(field, "中")).toBe(false);
    expect(field.value).toBe("abc中国");
  });

  test("a field at its limit is not claimed as an insertion (and fires nothing)", () => {
    const field = document.createElement("input");
    field.maxLength = 2;
    field.value = "ab";
    field.setSelectionRange(2, 2);
    let events = 0;
    field.addEventListener("input", () => (events += 1));

    expect(insertTextAtCursor(field, "好")).toBe(false);
    expect(field.value).toBe("ab");
    expect(events).toBe(0); // no phantom `input` either
  });

  test("the clamp never writes half of a surrogate pair", () => {
    const field = document.createElement("input");
    field.maxLength = 1; // room for one code unit, and 😀 needs two
    field.value = "";
    field.setSelectionRange(0, 0);

    // Refused (nothing fits) — and above all the field does not end up holding a
    // lone surrogate, which is not a character.
    expect(insertTextAtCursor(field, "😀")).toBe(false);
    expect(field.value).toBe("");

    // With room for the pair in a longer field it lands whole.
    field.maxLength = 4;
    field.value = "ab";
    field.setSelectionRange(2, 2);
    expect(insertTextAtCursor(field, "😀")).toBe(true);
    expect(field.value).toBe("ab😀");
    expect(field.selectionStart).toBe(4);
  });

  test("deleteBeforeCaret removes one character, or the selection", () => {
    const field = document.createElement("input");
    field.value = "zhong";
    field.setSelectionRange(5, 5);
    expect(deleteBeforeCaret(field)).toBe(true);
    expect(field.value).toBe("zhon");

    field.setSelectionRange(0, 4);
    expect(deleteBeforeCaret(field)).toBe(true);
    expect(field.value).toBe("");

    // Nothing left to delete.
    field.setSelectionRange(0, 0);
    expect(deleteBeforeCaret(field)).toBe(false);
  });

  test("a field with no caret deletes its last character instead of claiming nothing", () => {
    const field = document.createElement("input");
    field.value = "abc";
    // `email`/`number` inputs report no caret at all (`null` for both ends).
    Object.defineProperty(field, "selectionStart", { configurable: true, get: () => null });
    Object.defineProperty(field, "selectionEnd", { configurable: true, get: () => null });

    expect(deleteBeforeCaret(field)).toBe(true);
    expect(field.value).toBe("ab");
    expect(deleteBeforeCaret(field)).toBe(true);
    expect(field.value).toBe("a");
  });

  test("a deletion that would not change the value is never claimed", () => {
    const field = document.createElement("input");
    field.value = "abc";
    field.setSelectionRange(0, 0); // caret at the very start: nothing before it
    expect(deleteBeforeCaret(field)).toBe(false);
    expect(field.value).toBe("abc");

    const empty = document.createElement("textarea");
    empty.value = "";
    expect(deleteBeforeCaret(empty)).toBe(false);
  });
});

describe("lib/ime — layout, preference and paging", () => {
  test("the letter page is QWERTY and every key is a single character", () => {
    const flat = IME_LETTER_ROWS.flat();
    expect(flat.slice(0, 10)).toEqual(["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"]);
    expect(flat).toContain("m");
    for (const row of IME_SYMBOL_ROWS) expect(row.length).toBeGreaterThan(0);
    for (const k of flat) expect(k.length).toBe(1);
  });

  test("the Chinese symbol page carries Chinese punctuation and half-width digits", () => {
    const zh = IME_ZH_SYMBOL_ROWS.flat();
    // The punctuation a Chinese IME must produce is actually on the page…
    for (const g of ["，", "。", "？", "！", "、", "：", "；", "「", "」"]) {
      expect(zh).toContain(g);
    }
    // …the half-width twins are not (English mode owns them)…
    expect(zh).not.toContain(".");
    expect(zh).not.toContain(",");
    // …and digits stay half-width (a phone number, not １２３).
    expect(IME_ZH_SYMBOL_ROWS[0]).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  });

  test("toChinesePunctuation maps the ASCII punctuation a Chinese IME converts", () => {
    expect(toChinesePunctuation(",")).toBe("，");
    expect(toChinesePunctuation(".")).toBe("。");
    expect(toChinesePunctuation("?")).toBe("？");
    expect(toChinesePunctuation("!")).toBe("！");
    expect(toChinesePunctuation(":")).toBe("：");
    expect(toChinesePunctuation(";")).toBe("；");
    expect(toChinesePunctuation("(")).toBe("（");
    expect(toChinesePunctuation(")")).toBe("）");
    expect(toChinesePunctuation("<")).toBe("《");
    expect(toChinesePunctuation("\\")).toBe("、");
  });

  test("toChinesePunctuation is a pass-through for letters, digits and twinless symbols", () => {
    // Anything without an unambiguous Chinese form must survive untouched, or an
    // email address / phone number typed in Chinese mode would be mangled.
    for (const ch of ["a", "Z", "7", "@", "#", "$", "%", "&", "*", "+", "=", "-", "/", " "]) {
      expect(toChinesePunctuation(ch)).toBe(ch);
    }
    // Already-Chinese glyphs are idempotent (the symbol page emits these directly).
    expect(toChinesePunctuation("，")).toBe("，");
  });

  test("the fuzzy-pair list is the nine engine pairs, read from `amos_ime`", () => {
    // REQ-A644: the fuzzy list is a declared cross-language mirror (`amos_ime`),
    // not a locally-owned constant.
    // `ime.ts` says the list "must match `amos_ime::FUZZY_PAIRS`", but this test
    // used to assert a locally re-typed copy of the same nine strings — a value
    // equal to itself. It never touched `amos_ime`. Read the Rust `key()` map and
    // require both directions, so a rename on either side is a red here.
    const src = readFileSync(
      new URL("../../../../amos-ime/src/fuzzy.rs", import.meta.url),
      "utf8",
    );
    const keyIdx = src.indexOf("pub const fn key(self)");
    expect(keyIdx).toBeGreaterThan(0);
    const body = src.slice(keyIdx, keyIdx + 500);
    const rust = [...body.matchAll(/=>\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
    expect(rust).toHaveLength(9);
    expect(rust).toEqual([...IME_FUZZY_PAIRS]);
  });

  test("the enabled preference round-trips and defaults by pointer type", () => {
    expect(imeDefaultOn(true)).toBe(true);
    expect(imeDefaultOn(false)).toBe(false);
    // happy-dom reports a fine pointer, so the default here is off.
    expect(readImeEnabled()).toBe(false);
    writeImeEnabled(true);
    expect(readImeEnabled()).toBe(true);
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("true");
  });

  test("candidates are paged and out-of-range pages are clamped", () => {
    const items = Array.from({ length: IME_CANDIDATE_PAGE_SIZE * 2 + 3 }, (_, i) => `c${i}`);
    expect(candidatePageCount(0)).toBe(1);
    expect(candidatePageCount(1)).toBe(1);
    expect(candidatePageCount(IME_CANDIDATE_PAGE_SIZE * 3)).toBe(3);
    expect(pageCandidates(items, 0).length).toBe(IME_CANDIDATE_PAGE_SIZE);
    expect(pageCandidates(items, 2).length).toBe(3);
    // Beyond the last page clamps to the last page, never an empty slice.
    expect(pageCandidates(items, 99)).toEqual(items.slice(IME_CANDIDATE_PAGE_SIZE * 2));
    expect(pageCandidates(items, -5)).toEqual(items.slice(0, IME_CANDIDATE_PAGE_SIZE));
    expect(pageCandidates([], 3)).toEqual([]);
  });
});
