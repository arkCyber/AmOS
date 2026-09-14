/**
 * DOM tests for ImeOverlay.svelte — the input method's behavior.
 *
 * These cases pin the contract that makes the keyboard an *input method* rather
 * than a decoration: the dock appears for the focused text field, taps are routed
 * to the `ime_*` commands, committed text is written into that field at its caret,
 * and an in-flight pinyin code is abandoned when the field goes away (so a
 * half-typed code can never land in the next field).
 *
 * The Rust engine is replaced by a tiny in-test fake that keeps an input buffer
 * and answers the same wire shapes — the real ranking is covered by `amos-ime`'s
 * own Rust tests, which is where it belongs.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ImeOverlay from "../src/svelte/ImeOverlay.svelte";
import { IME_ENABLED_KEY, writeImeEnabled } from "../src/lib/ime";
import { STORE_CHANGED_EVENT } from "../src/lib/amosStore";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(cleanup);
afterEach(() => setLocale("zh"));
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const PAIRS = ["z_zh", "c_ch", "s_sh", "n_l", "f_h", "r_l", "in_ing", "en_eng", "an_ang"];

interface FakeIme {
  /** Every command the overlay sent, in order. */
  calls: string[];
  /** Every character fed to `ime_key`. */
  keys: string[];
  /** The fake engine's current buffer. */
  buffer: () => string;
  /** How many candidates the fake offers for a non-empty buffer (0 = none at all). */
  setCandidateCount: (n: number) => void;
  /** The index of the last `ime_commit` (to prove the keyboard's index math). */
  commitIndex: () => number | null;
  /** Make every command fail, the way an unreachable bridge would. */
  setFailing: (on: boolean) => void;
}

/** Install a minimal `ime_*` backend over `__TAURI_INTERNALS__.invoke`. */
function installFakeIme(): FakeIme {
  const calls: string[] = [];
  const keys: string[] = [];
  let input = "";
  let candidateCount = 1;
  let learnedPins = 0;
  let lastCommitted: string | null = null;
  let lastPickCode: string | null = null;
  let lastCommitIndex: number | null = null;
  let failing = false;
  let fuzzy: Record<string, boolean> = Object.fromEntries(PAIRS.map((p) => [p, false]));

  const state = () => ({
    input,
    candidates: input
      ? Array.from({ length: candidateCount }, (_, i) => ({
          text: i === 0 ? "中国" : `候选${i}`,
          kind: "dict",
        }))
      : [],
    composing: input.length > 0,
    strict: PAIRS.every((p) => !fuzzy[p]),
    fuzzy,
    dict_entries: 165_361,
    learned_pins: learnedPins,
    learned_pending: 0,
    last_committed: lastCommitted,
    last_pick_code: lastPickCode,
  });

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      if (failing) return Promise.resolve(null);
      switch (command) {
        case "ime_status":
          return Promise.resolve(state());
        case "ime_key": {
          const ch = String(args?.ch ?? "");
          if (/^[a-zA-Z]$/.test(ch)) {
            keys.push(ch);
            input += ch.toLowerCase();
          }
          return Promise.resolve(state());
        }
        case "ime_backspace":
          input = input.slice(0, -1);
          return Promise.resolve(state());
        case "ime_clear":
          input = "";
          return Promise.resolve(state());
        case "ime_commit": {
          const committed = input ? "中国" : null;
          lastCommitIndex = Number(args?.index ?? -1);
          // Only a dictionary pick is learnable — the fake mirrors the engine.
          lastPickCode = committed ? input : null;
          if (committed) {
            learnedPins += 1;
            lastCommitted = committed;
          }
          input = "";
          return Promise.resolve({ committed, state: state() });
        }
        case "ime_forget_last":
          lastPickCode = null;
          lastCommitted = null;
          learnedPins = 0;
          return Promise.resolve(state());
        case "ime_fuzzy_toggle": {
          const pair = String(args?.pair ?? "");
          fuzzy = { ...fuzzy, [pair]: !fuzzy[pair] };
          return Promise.resolve(state());
        }
        case "ime_fuzzy_preset": {
          const on = args?.preset === "permissive";
          fuzzy = Object.fromEntries(PAIRS.map((p) => [p, on]));
          return Promise.resolve(state());
        }
        case "ime_learning_clear":
          learnedPins = 0;
          return Promise.resolve(state());
        default:
          return Promise.resolve(null);
      }
    },
  };
  return {
    calls,
    keys,
    buffer: () => input,
    setCandidateCount: (n) => {
      candidateCount = Math.max(0, n);
    },
    commitIndex: () => lastCommitIndex,
    setFailing: (on) => {
      failing = on;
    },
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** Render the overlay plus a real text field, optionally with the IME already on. */
async function harness(on: boolean) {
  if (on) window.localStorage.setItem(IME_ENABLED_KEY, "true");
  const fake = installFakeIme();
  const host = render(ImeOverlay);
  const field = document.createElement("input");
  field.value = "";
  document.body.appendChild(field);
  await tick();
  await settle();
  return { ...fake, host, field };
}

/** Focus the field the way a tap would (happy-dom may not emit focusin itself). */
async function focusField(field: HTMLInputElement | HTMLTextAreaElement) {
  field.focus();
  field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  field.dispatchEvent(new Event("focusin", { bubbles: true }));
  await tick();
}

const sel = (host: { container: HTMLElement }, testid: string) =>
  host.container.querySelector(`[data-testid="${testid}"]`);

describe("ImeOverlay.svelte — visibility", () => {
  test("a focused field on a fresh install offers the keyboard, it does not force it", async () => {
    const { host, field } = await harness(false);
    await focusField(field);

    expect(sel(host, "ime-keyboard")).toBeNull();
    expect(sel(host, "ime-show")).toBeTruthy();
    // The default is off on a fine-pointer device, and nothing claimed otherwise.
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBeNull();
  });

  test("tapping ⌨ enables the input method and remembers it", async () => {
    const { host, field } = await harness(false);
    await focusField(field);
    await fireEvent.click(sel(host, "ime-show")!);
    await tick();

    expect(sel(host, "ime-keyboard")).toBeTruthy();
    expect(sel(host, "ime-show")).toBeNull();
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("true");
  });

  test("with the IME on, focusing a field raises the dock", async () => {
    const { host, field } = await harness(true);
    expect(sel(host, "ime-keyboard")).toBeNull(); // nothing focused yet
    await focusField(field);
    expect(sel(host, "ime-keyboard")).toBeTruthy();
  });

  test("hiding collapses the dock and ⌨ brings it back", async () => {
    const { host, field } = await harness(true);
    await focusField(field);
    await fireEvent.click(sel(host, "ime-hide")!);
    await tick();

    expect(sel(host, "ime-keyboard")).toBeNull();
    const show = sel(host, "ime-show");
    expect(show).toBeTruthy();

    await fireEvent.click(show!);
    await tick();
    expect(sel(host, "ime-keyboard")).toBeTruthy();
  });

  test("losing the field abandons the in-flight code and closes the dock", async () => {
    const { host, field, calls, buffer } = await harness(true);
    await focusField(field);
    await fireEvent.click(sel(host, "ime-key-z")!);
    await tick();
    expect(buffer()).toBe("z");

    field.blur();
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();
    await tick();
    await settle();

    expect(calls).toContain("ime_clear");
    expect(buffer()).toBe("");
    expect(sel(host, "ime-keyboard")).toBeNull();
    // Nothing was inserted into the field by merely losing focus.
    expect(field.value).toBe("");
  });
});

describe("ImeOverlay.svelte — typing", () => {
  test("letters compose in the engine and a candidate commits at the caret", async () => {
    const { host, field, keys } = await harness(true);
    await focusField(field);
    field.value = "ab";
    field.setSelectionRange(1, 1);

    await fireEvent.click(sel(host, "ime-key-z")!);
    await fireEvent.click(sel(host, "ime-key-h")!);
    await tick();

    // Every letter went to the engine, and the composition bar shows the buffer.
    expect(keys).toEqual(["z", "h"]);
    expect(sel(host, "ime-input")?.textContent).toBe("zh");
    expect(field.value).toBe("ab"); // nothing inserted yet — still composing

    await fireEvent.click(sel(host, "ime-candidate")!);
    await tick();
    expect(field.value).toBe("a中国b"); // committed at the caret, not appended
    expect(sel(host, "ime-input")).toBeNull(); // composition finished
  });

  test("space commits the first candidate while composing, and types a space otherwise", async () => {
    const { host, field } = await harness(true);
    await focusField(field);

    await fireEvent.click(sel(host, "ime-space")!);
    expect(field.value).toBe(" "); // not composing → a real space

    await fireEvent.click(sel(host, "ime-key-w")!);
    await fireEvent.click(sel(host, "ime-space")!);
    await tick();
    expect(field.value).toBe(" 中国"); // composing → the first candidate
  });

  test("backspace edits the pinyin first, then the field", async () => {
    const { host, field, buffer } = await harness(true);
    await focusField(field);
    field.value = "xy";
    field.setSelectionRange(2, 2);

    await fireEvent.click(sel(host, "ime-key-z")!);
    await fireEvent.click(sel(host, "ime-backspace")!);
    await tick();
    expect(buffer()).toBe(""); // the pinyin buffer absorbed it
    expect(field.value).toBe("xy");

    await fireEvent.click(sel(host, "ime-backspace")!);
    await tick();
    expect(field.value).toBe("x"); // now it edits the field itself
  });

  test("English mode types straight into the field and never calls the engine", async () => {
    const { host, field, keys } = await harness(true);
    await focusField(field);

    await fireEvent.click(sel(host, "ime-mode")!);
    await fireEvent.click(sel(host, "ime-key-a")!);
    await fireEvent.click(sel(host, "ime-space")!);
    await tick();

    expect(field.value).toBe("a ");
    expect(keys).toEqual([]); // no composition in English mode
  });
});

describe("ImeOverlay.svelte — settings panel", () => {
  test("the settings panel drives fuzzy pairs, presets, the learner and the off switch", async () => {
    const { host, field, calls } = await harness(true);
    await focusField(field);

    await fireEvent.click(sel(host, "ime-settings")!);
    await tick();
    expect(sel(host, "ime-settings-panel")).toBeTruthy();

    await fireEvent.click(sel(host, "ime-fuzzy-n_l")!);
    await fireEvent.click(sel(host, "ime-preset-permissive")!);
    // Destructive: the first tap only asks for confirmation.
    await fireEvent.click(sel(host, "ime-learn-clear")!);
    await fireEvent.click(sel(host, "ime-learn-clear")!);
    await tick();
    expect(calls).toContain("ime_fuzzy_toggle");
    expect(calls).toContain("ime_fuzzy_preset");
    expect(calls).toContain("ime_learning_clear");

    await fireEvent.click(sel(host, "ime-disable")!);
    await tick();
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("false");
    expect(sel(host, "ime-keyboard")).toBeNull();
    expect(sel(host, "ime-settings-panel")).toBeNull();
  });

  test("the clear button on the composition bar drops the pinyin buffer", async () => {
    const { host, field, buffer, calls } = await harness(true);
    await focusField(field);
    await fireEvent.click(sel(host, "ime-key-z")!);
    await tick();
    expect(buffer()).toBe("z");

    await fireEvent.click(sel(host, "ime-composition-clear")!);
    await tick();
    expect(calls).toContain("ime_clear");
    expect(buffer()).toBe("");
    expect(sel(host, "ime-composition")).toBeNull();
  });
});

describe("ImeOverlay.svelte — symbols, paging, refusals and the commit hint", () => {
  test("the symbol page really types digits and punctuation in Chinese mode", async () => {
    const { host, field, keys } = await harness(true);
    await focusField(field);

    await fireEvent.click(sel(host, "ime-symbols")!);
    await fireEvent.click(sel(host, "ime-key-1")!);
    await fireEvent.click(sel(host, "ime-key-.")!);
    await tick();

    expect(field.value).toBe("1.");
    expect(keys).toEqual([]); // the engine only ever sees letters
  });

  test("a symbol while composing commits the candidate first, then types the symbol", async () => {
    const { host, field } = await harness(true);
    await focusField(field);

    await fireEvent.click(sel(host, "ime-key-w")!);
    await fireEvent.click(sel(host, "ime-symbols")!);
    await fireEvent.click(sel(host, "ime-key-.")!);
    await tick();

    expect(field.value).toBe("中国.");
    expect(sel(host, "ime-composition")).toBeNull(); // the code was consumed, not dropped
  });

  test("space with a code that has no candidate is a space, not a swallowed key", async () => {
    const f = await harness(true);
    f.setCandidateCount(0); // composing, but the dictionary offers nothing
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-z")!);
    await tick();
    expect(sel(f.host, "ime-no-candidates")).toBeTruthy();

    await fireEvent.click(sel(f.host, "ime-space")!);
    await tick();
    // The reference rule the physical keyboard now follows too: with nothing to
    // commit, the key still means a space instead of doing nothing at all.
    expect(f.field.value).toBe(" ");
  });

  test("a new letter starts the candidate list over at page one", async () => {
    const f = await harness(true);
    f.setCandidateCount(20); // 20 candidates → 3 pages
    await focusField(f.field);

    await fireEvent.click(sel(f.host, "ime-key-s")!);
    await tick();
    await fireEvent.click(sel(f.host, "ime-page-next")!);
    await fireEvent.click(sel(f.host, "ime-page-next")!);
    await tick();
    expect(sel(f.host, "ime-page")?.textContent).toContain("3 / 3");

    await fireEvent.click(sel(f.host, "ime-key-h")!);
    await tick();
    expect(sel(f.host, "ime-page")?.textContent).toContain("1 / 3");
  });

  test("a field that becomes read-only while focused is not written to", async () => {
    const { host, field } = await harness(true);
    await focusField(field);
    field.readOnly = true; // the app may lock the field while the keyboard is open

    await fireEvent.click(sel(host, "ime-key-w")!);
    await fireEvent.click(sel(host, "ime-candidate")!);
    await tick();

    // The insertion is refused (and reported through the diagnostics ledger)
    // rather than written past `readOnly`.
    expect(field.value).toBe("");
  });

  test("Enter inserts a newline only where one can exist", async () => {
    const { host, field } = await harness(true);
    await focusField(field);
    await fireEvent.click(sel(host, "ime-mode")!); // English mode

    await fireEvent.click(sel(host, "ime-enter")!);
    await tick();
    expect(field.value).toBe(""); // an <input> has no newline to give

    const area = document.createElement("textarea");
    document.body.appendChild(area);
    await focusField(area);
    await fireEvent.click(sel(host, "ime-enter")!);
    await tick();
    expect(area.value).toBe("\n"); // …a textarea does
  });

  test("the commit hint offers an undo that really forgets", async () => {
    const { host, field, calls } = await harness(true);
    await focusField(field);
    await fireEvent.click(sel(host, "ime-key-w")!);
    await fireEvent.click(sel(host, "ime-candidate")!);
    await tick();

    expect(field.value).toBe("中国");
    expect(sel(host, "ime-last-committed")).toBeTruthy();
    expect(sel(host, "ime-forget")).toBeTruthy();

    await fireEvent.click(sel(host, "ime-forget")!);
    await tick();
    expect(calls).toContain("ime_forget_last");
    // The engine cleared the hint, so the keyboard stops offering the action.
    expect(sel(host, "ime-last-committed")).toBeNull();
  });

  test("opening the dock scrolls the focused field back into view", async () => {
    const { host, field } = await harness(true);
    const scroll = vi.fn();
    field.scrollIntoView = scroll;

    await focusField(field);
    await settle();
    await tick();

    expect(sel(host, "ime-keyboard")).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
  });
});

describe("ImeOverlay.svelte — paging and Escape", () => {
  test("paging to the end cannot report an index that commits nothing", async () => {
    const f = await harness(true);
    f.setCandidateCount(20); // 3 pages of 8
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-s")!);
    await tick();

    await fireEvent.click(sel(f.host, "ime-page-next")!);
    await fireEvent.click(sel(f.host, "ime-page-next")!);
    await tick();
    expect(sel(f.host, "ime-page")?.textContent).toContain("3 / 3");
    expect(sel(f.host, "ime-page-next")?.hasAttribute("disabled")).toBe(true);

    await fireEvent.click(sel(f.host, "ime-candidate")!);
    await tick();
    // The last page starts at 16: the visible candidate must report exactly that
    // (an over-range page used to report 24, which commits nothing).
    expect(f.commitIndex()).toBe(16);
  });

  test("Escape cancels the composition and does not leak to the shell", async () => {
    const f = await harness(true);
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-w")!);
    await tick();
    expect(f.buffer()).toBe("w");

    const leaked: string[] = [];
    const onWindowKey = (e: Event) => leaked.push((e as KeyboardEvent).key);
    window.addEventListener("keydown", onWindowKey);
    try {
      f.field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await tick();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }

    expect(f.buffer()).toBe("");
    expect(f.calls).toContain("ime_clear");
    expect(leaked).toEqual([]); // the shell's global Escape never saw it
  });

  test("Escape is not swallowed when there is nothing to cancel", async () => {
    const f = await harness(true);
    await focusField(f.field);

    const leaked: string[] = [];
    const onWindowKey = (e: Event) => leaked.push((e as KeyboardEvent).key);
    window.addEventListener("keydown", onWindowKey);
    try {
      f.field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await tick();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
    expect(leaked).toEqual(["Escape"]); // the shell still gets to close overlays
  });
});

describe("ImeOverlay.svelte — no engine", () => {
  test("an unavailable engine degrades to literal typing and says so", async () => {
    // No fake bridge at all: every invoke returns null, exactly as in a browser
    // preview or a build without the daemon.
    window.localStorage.setItem(IME_ENABLED_KEY, "true");
    const host = render(ImeOverlay);
    const field = document.createElement("input");
    document.body.appendChild(field);
    await tick();
    await settle();
    await focusField(field);

    // The keyboard is there and explains itself…
    expect(sel(host, "ime-keyboard")).toBeTruthy();
    expect(sel(host, "ime-offline")).toBeTruthy();
    // …and only offers what can actually work: the two engine-dependent controls
    // are visibly disabled rather than silently doing nothing.
    expect(sel(host, "ime-mode")?.hasAttribute("disabled")).toBe(true);
    expect(sel(host, "ime-settings")?.hasAttribute("disabled")).toBe(true);

    // Letters still type — in English, which is the honest degraded mode (a Chinese
    // keyboard with no engine would swallow every letter).
    await fireEvent.click(sel(host, "ime-key-a")!);
    await fireEvent.click(sel(host, "ime-space")!);
    await tick();
    expect(field.value).toBe("a ");
  });
});

describe("ImeOverlay.svelte — physical keys", () => {
  /** Record window-level keydowns exactly the way the shell's shortcut bridge does. */
  function windowKeys(): { keys: string[]; stop: () => void } {
    const keys: string[] = [];
    const onKey = (e: Event) => keys.push((e as KeyboardEvent).key);
    window.addEventListener("keydown", onKey);
    return { keys, stop: () => window.removeEventListener("keydown", onKey) };
  }

  function pressKey(el: Element, k: string, init: KeyboardEventInit = {}): void {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  }

  test("a pinyin letter composes — it neither types nor navigates", async () => {
    const f = await harness(true);
    await focusField(f.field);
    const seen = windowKeys();
    try {
      pressKey(f.field, "h"); // also the shell's Home shortcut
      await tick();
    } finally {
      seen.stop();
    }
    expect(f.keys).toEqual(["h"]); // the engine got it…
    expect(f.field.value).toBe(""); // …nothing leaked into the field…
    expect(seen.keys).toEqual([]); // …and the shell never saw it (no Home jump)
  });

  test("a physical digit picks the candidate on the page that is showing", async () => {
    const f = await harness(true);
    f.setCandidateCount(20); // 3 pages
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-s")!);
    await tick();
    await fireEvent.click(sel(f.host, "ime-page-next")!); // page 2 of 3
    await tick();

    pressKey(f.field, "3");
    await tick();
    expect(f.commitIndex()).toBe(10); // page 1 * 8 + (3 - 1), not 2
  });

  test("a digit this page has no candidate for commits first, like a symbol", async () => {
    const f = await harness(true); // one candidate only, so 7 is out of range
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-w")!);
    await tick();

    pressKey(f.field, "7");
    await tick();
    // The digit is still typed literally rather than swallowed — but only *after*
    // the code the user typed before it, so the field reads 中国7 and not 7中国.
    expect(f.field.value).toBe("中国7");
    expect(f.buffer()).toBe("");
    expect(f.commitIndex()).toBe(0);
  });

  test("a physical punctuation key commits the code the user typed before it", async () => {
    const f = await harness(true);
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-w")!);
    await tick();

    pressKey(f.field, ",");
    await tick();
    // A physical comma used to skip the engine entirely: it reached the field on
    // its own, in front of the Chinese, while the pinyin code kept composing.
    expect(f.field.value).toBe("中国,");
    expect(f.buffer()).toBe("");
    expect(f.commitIndex()).toBe(0);
  });

  test("a physical space is not swallowed when the code has no candidate", async () => {
    const f = await harness(true);
    f.setCandidateCount(0); // a code the dictionary offers nothing for
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-z")!);
    await tick();
    expect(sel(f.host, "ime-no-candidates")).toBeTruthy();

    pressKey(f.field, " ");
    await tick();
    // The key means what the on-screen space key means (a space) instead of
    // vanishing because there was nothing to commit.
    expect(f.field.value).toBe(" ");
  });

  test("a physical key the keyboard does not act on is left to the field", async () => {
    const f = await harness(true);
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-w")!);
    await tick();
    expect(f.buffer()).toBe("w");

    const seen = windowKeys();
    try {
      pressKey(f.field, "Tab"); // not printable: never consumed, even while composing
      pressKey(f.field, "ArrowLeft");
      await tick();
    } finally {
      seen.stop();
    }
    expect(f.keys).toEqual(["w"]);
    expect(seen.keys).toEqual(["Tab", "ArrowLeft"]);
    expect(f.field.value).toBe(""); // and nothing was inserted behind the code
  });

  test("physical space commits the highlighted candidate", async () => {
    const f = await harness(true);
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-w")!);
    await tick();

    pressKey(f.field, " ");
    await tick();
    expect(f.field.value).toBe("中国");
    expect(f.commitIndex()).toBe(0);
  });

  test("physical Backspace edits the pinyin before the field", async () => {
    const f = await harness(true);
    await focusField(f.field);
    f.field.value = "xy";
    f.field.setSelectionRange(2, 2);
    await fireEvent.click(sel(f.host, "ime-key-w")!);
    await tick();

    pressKey(f.field, "Backspace");
    await tick();
    expect(f.buffer()).toBe("");
    expect(f.field.value).toBe("xy");
  });

  test("modifier combinations pass straight through", async () => {
    const f = await harness(true);
    await focusField(f.field);
    const seen = windowKeys();
    try {
      pressKey(f.field, "c", { ctrlKey: true });
      await tick();
    } finally {
      seen.stop();
    }
    expect(seen.keys).toEqual(["c"]);
    expect(f.keys).toEqual([]);
  });

  test("a hidden keyboard hands the keys back to the field", async () => {
    const f = await harness(true);
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-hide")!);
    await tick();

    const seen = windowKeys();
    try {
      pressKey(f.field, "h");
      await tick();
    } finally {
      seen.stop();
    }
    expect(f.keys).toEqual([]);
    expect(seen.keys).toEqual(["h"]);
  });

  test("English mode hands the keys back to the field", async () => {
    const f = await harness(true);
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-mode")!); // → EN
    await tick();

    const seen = windowKeys();
    try {
      pressKey(f.field, "h");
      await tick();
    } finally {
      seen.stop();
    }
    expect(f.keys).toEqual([]);
    expect(seen.keys).toEqual(["h"]);
  });

  test("a tap the engine never saw is shown instead of doing nothing", async () => {
    const f = await harness(true);
    await focusField(f.field);
    f.setFailing(true);

    await fireEvent.click(sel(f.host, "ime-key-w")!);
    await tick();
    expect(sel(f.host, "ime-bridge-error")).toBeTruthy();

    // …and the notice clears as soon as the engine answers again.
    f.setFailing(false);
    await fireEvent.click(sel(f.host, "ime-key-o")!);
    await tick();
    expect(sel(f.host, "ime-bridge-error")).toBeNull();
  });
});

describe("ImeOverlay.svelte — a field that leaves the document", () => {
  test("an orphaned field is not written to, and the keyboard does not stay up", async () => {
    const f = await harness(true);
    await focusField(f.field);
    await fireEvent.click(sel(f.host, "ime-key-w")!);
    await tick();

    // A panel closing, a screen switching: focus moves to <body> **without** any
    // `focusout`, so the overlay still holds the removed node.
    f.field.remove();
    await tick();
    expect(f.field.isConnected).toBe(false);

    await fireEvent.click(sel(f.host, "ime-candidate")!);
    await settle();
    await tick();

    // A write into a node the user cannot see is not an insertion.
    expect(f.field.value).toBe("");
    expect(sel(f.host, "ime-keyboard")).toBeNull(); // and the keyboard does not stay up typing nowhere
  });

  test("Backspace does not claim a deletion on an orphaned field", async () => {
    const f = await harness(true);
    await focusField(f.field);
    f.field.value = "xy";
    f.field.setSelectionRange(2, 2);

    f.field.remove();
    await tick();

    await fireEvent.click(sel(f.host, "ime-backspace")!);
    await settle();
    await tick();

    expect(f.field.value).toBe("xy");
    expect(sel(f.host, "ime-keyboard")).toBeNull();
  });
});

describe("ImeOverlay.svelte — Settings owns the same switch", () => {
  test("a preference change from another screen takes effect immediately", async () => {
    const f = await harness(false); // the input method starts off
    await focusField(f.field);
    expect(sel(f.host, "ime-keyboard")).toBeNull();
    expect(sel(f.host, "ime-show")).toBeTruthy();

    // Settings → Input Method flips it. `writeImeEnabled` is the same seam the
    // keyboard preference lives in, and writing it is what notifies this window —
    // so no test-only plumbing is needed to prove the two surfaces are wired.
    writeImeEnabled(true);
    await tick();
    expect(sel(f.host, "ime-keyboard")).toBeTruthy();

    // …and turning it back off closes the keyboard again.
    writeImeEnabled(false);
    await tick();
    expect(sel(f.host, "ime-keyboard")).toBeNull();
  });

  test("an unrelated store change leaves the keyboard alone", async () => {
    const f = await harness(true);
    await focusField(f.field);
    expect(sel(f.host, "ime-keyboard")).toBeTruthy();

    window.dispatchEvent(
      new CustomEvent(STORE_CHANGED_EVENT, { detail: { key: "amos.notes" } }),
    );
    await tick();
    expect(sel(f.host, "ime-keyboard")).toBeTruthy(); // the filter held
  });
});
