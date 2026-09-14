/**
 * DOM tests for ImeKeyboard.svelte — the on-screen pinyin keyboard's presentation.
 *
 * The point of these cases is the *contract* the overlay relies on: a letter tap
 * reports its glyph, a candidate tap reports its ABSOLUTE index (page offset
 * included, because the Rust engine commits by index into the whole list), the
 * pager is only offered when there is more than one page, and the fuzzy settings
 * panel reflects + reports the nine pairs. No backend is involved.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ImeKeyboard from "../src/svelte/ImeKeyboard.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import type { ImeState } from "../src/lib/ime";

afterEach(cleanup);
// Other suites assert zh wording; never let a locale leak into the next case.
afterEach(() => setLocale("zh"));

function state(over: Partial<ImeState> = {}): ImeState {
  return {
    input: "",
    candidates: [],
    composing: false,
    strict: true,
    fuzzy: {
      z_zh: false,
      c_ch: false,
      s_sh: false,
      n_l: false,
      f_h: false,
      r_l: false,
      in_ing: false,
      en_eng: false,
      an_ang: false,
    },
    dict_entries: 165_361,
    learned_pins: 0,
    learned_pending: 0,
    last_committed: null,
    last_pick_code: null,
    ...over,
  };
}

const noop = () => {};

function mount(props: Record<string, unknown> = {}) {
  return render(ImeKeyboard, {
    props: {
      session: state(),
      online: true,
      error: false,
      mode: "zh",
      page: 0,
      settingsOpen: false,
      onkey: noop,
      onbackspace: noop,
      onclear: noop,
      oncommit: noop,
      onpage: noop,
      onmode: noop,
      onhide: noop,
      onsettings: noop,
      onpreset: noop,
      onfuzztoggle: noop,
      onlearnclear: noop,
      ondisable: noop,
      onforget: noop,
      ...props,
    },
  });
}

describe("ImeKeyboard.svelte — keys", () => {
  test("renders the key grid and reports each tapped letter", async () => {
    const onkey = vi.fn();
    const host = mount({ onkey });
    expect(host.container.querySelector('[data-testid="ime-keyboard"]')).toBeTruthy();

    await fireEvent.click(host.container.querySelector('[data-testid="ime-key-z"]')!);
    await fireEvent.click(host.container.querySelector('[data-testid="ime-key-h"]')!);
    expect(onkey.mock.calls.map((c) => c[0])).toEqual(["z", "h"]);
  });

  test("the ?123 page swaps to digits and back to letters", async () => {
    const onkey = vi.fn();
    const host = mount({ onkey });
    expect(host.container.querySelector('[data-testid="ime-key-q"]')).toBeTruthy();

    await fireEvent.click(host.container.querySelector('[data-testid="ime-symbols"]')!);
    expect(host.container.querySelector('[data-testid="ime-key-q"]')).toBeNull();
    await fireEvent.click(host.container.querySelector('[data-testid="ime-key-1"]')!);
    expect(onkey.mock.calls.map((c) => c[0])).toEqual(["1"]);

    await fireEvent.click(host.container.querySelector('[data-testid="ime-symbols"]')!);
    expect(host.container.querySelector('[data-testid="ime-key-q"]')).toBeTruthy();
  });

  test("space, backspace and enter report their intent", async () => {
    const onkey = vi.fn();
    const onbackspace = vi.fn();
    const onmode = vi.fn();
    const host = mount({ onkey, onbackspace, onmode });

    await fireEvent.click(host.container.querySelector('[data-testid="ime-space"]')!);
    await fireEvent.click(host.container.querySelector('[data-testid="ime-backspace"]')!);
    await fireEvent.click(host.container.querySelector('[data-testid="ime-enter"]')!);
    expect(onkey.mock.calls.map((c) => c[0])).toEqual([" ", "\n"]);
    expect(onbackspace).toHaveBeenCalledTimes(1);

    await fireEvent.click(host.container.querySelector('[data-testid="ime-mode"]')!);
    expect(onmode).toHaveBeenCalledWith("en");
  });

  test("shift is one-shot and uppercases only in English mode", async () => {
    const onkey = vi.fn();
    const host = mount({ onkey, mode: "en" });
    const shift = () => host.container.querySelector('[data-testid="ime-shift"]');

    await fireEvent.click(shift()!);
    expect(shift()?.getAttribute("aria-pressed")).toBe("true");
    expect(
      host.container.querySelector('[data-testid="ime-key-a"]')?.textContent?.trim(),
    ).toBe("A");

    await fireEvent.click(host.container.querySelector('[data-testid="ime-key-a"]')!);
    await fireEvent.click(host.container.querySelector('[data-testid="ime-key-a"]')!);
    expect(onkey.mock.calls.map((c) => c[0])).toEqual(["A", "a"]);
    expect(shift()?.getAttribute("aria-pressed")).toBe("false"); // one-shot
  });

  test("shift is not offered in Chinese mode (pinyin is case-insensitive)", async () => {
    const onkey = vi.fn();
    const host = mount({ onkey, mode: "zh" });
    const shift = () =>
      host.container.querySelector('[data-testid="ime-shift"]') as HTMLButtonElement;

    // Not a control that silently does nothing: it cannot even be armed here.
    expect(shift().disabled).toBe(true);
    await fireEvent.click(shift());
    expect(shift().getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(host.container.querySelector('[data-testid="ime-key-z"]')!);
    expect(onkey.mock.calls.map((c) => c[0])).toEqual(["z"]);
  });

  test("an armed shift does not outlive English mode", async () => {
    const onkey = vi.fn();
    const host = mount({ onkey, mode: "en" });
    const shift = () =>
      host.container.querySelector('[data-testid="ime-shift"]') as HTMLButtonElement;
    await fireEvent.click(shift());
    expect(shift().getAttribute("aria-pressed")).toBe("true");

    await host.rerender({ mode: "zh" });
    await tick();
    expect(shift().getAttribute("aria-pressed")).toBe("false"); // the arm is dropped…

    await host.rerender({ mode: "en" });
    await tick();
    await fireEvent.click(host.container.querySelector('[data-testid="ime-key-a"]')!);
    expect(onkey.mock.calls.map((c) => c[0])).toEqual(["a"]); // …so nothing is secretly uppercase
  });
});

describe("ImeKeyboard.svelte — candidate bar", () => {
  test("shows the raw pinyin and commits by absolute index", async () => {
    const oncommit = vi.fn();
    const candidates = Array.from({ length: 12 }, (_, i) => ({ text: `c${i}`, kind: "dict" }));
    const host = mount({
      oncommit,
      page: 1,
     session: state({ input: "shi", composing: true, candidates }),
    });

    expect(host.container.querySelector('[data-testid="ime-input"]')?.textContent).toBe("shi");
    const shown = host.container.querySelectorAll('[data-testid="ime-candidate"]');
    expect(shown.length).toBe(4); // 12 candidates, page size 8 → page 1 holds 4
    expect(shown[0]?.textContent?.trim()).toBe("c8");

    await fireEvent.click(shown[0]!);
    // Absolute index: page 1 starts at candidate 8.
    expect(oncommit).toHaveBeenCalledWith(8);
  });

  test("the pager only appears when there is more than one page", () => {
    const host = mount({
     session: state({ input: "wo", composing: true, candidates: [{ text: "我", kind: "dict" }] }),
    });
    expect(host.container.querySelector('[data-testid="ime-page"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="ime-page-next"]')).toBeNull();
  });

  test("a long candidate list is paged and the ends are not offered", async () => {
    const onpage = vi.fn();
    const candidates = Array.from({ length: 20 }, (_, i) => ({ text: `c${i}`, kind: "dict" }));
    const host = mount({
      onpage,
      page: 0,
      session: state({ input: "shi", composing: true, candidates }),
    });
    const prev = () =>
      host.container.querySelector<HTMLButtonElement>('[data-testid="ime-page-prev"]');
    const next = () =>
      host.container.querySelector<HTMLButtonElement>('[data-testid="ime-page-next"]');

    expect(host.container.querySelector('[data-testid="ime-page"]')?.textContent).toContain("1 / 3");
    expect(prev()?.disabled).toBe(true); // first page: there is no way back
    await fireEvent.click(prev()!);
    expect(onpage).not.toHaveBeenCalled();

    await fireEvent.click(next()!);
    expect(onpage).toHaveBeenCalledWith(1);
  });

  test("an over-range page renders the last page and reports its own candidates", async () => {
    const oncommit = vi.fn();
    const candidates = Array.from({ length: 20 }, (_, i) => ({ text: `c${i}`, kind: "dict" }));
    // The overlay can briefly hold a page past the end; the label, the slice and
    // the index a candidate reports must still agree, or a visible candidate would
    // commit nothing.
    const host = mount({
      oncommit,
      page: 7,
      session: state({ input: "shi", composing: true, candidates }),
    });

    expect(host.container.querySelector('[data-testid="ime-page"]')?.textContent).toContain("3 / 3");
    expect(
      host.container.querySelector<HTMLButtonElement>('[data-testid="ime-page-next"]')?.disabled,
    ).toBe(true);
    const shown = host.container.querySelectorAll('[data-testid="ime-candidate"]');
    expect(shown[0]?.textContent?.trim()).toBe("c16");

    await fireEvent.click(shown[0]!);
    expect(oncommit).toHaveBeenCalledWith(16); // last page: 2 * 8 + 0, never 7 * 8
  });

  test("a sentence candidate is labelled and its kind survives", () => {
    const host = mount({
     session: state({
        input: "zhongguorenmin",
        composing: true,
        candidates: [{ text: "中国人民", kind: "sentence" }],
      }),
    });
    const button = host.container.querySelector('[data-testid="ime-candidate"]');
    expect(button?.textContent).toContain("中国人民");
    expect(button?.textContent).toContain("整句");
  });

  test("an empty candidate list says so instead of rendering nothing", () => {
    const host = mount({ session: state({ input: "zzz", composing: true, candidates: [] }) });
    expect(host.container.querySelector('[data-testid="ime-no-candidates"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="ime-candidate"]')).toBeNull();
  });

  test("composing shows a working clear button", async () => {
    const onclear = vi.fn();
    const host = mount({
      onclear,
     session: state({ input: "zhong", composing: true, candidates: [] }),
    });
    await fireEvent.click(host.container.querySelector('[data-testid="ime-composition-clear"]')!);
    expect(onclear).toHaveBeenCalledTimes(1);
  });
});

describe("ImeKeyboard.svelte — settings and chrome", () => {
  test("the settings panel lists all nine fuzzy pairs with their pressed state", () => {
    const fuzzy = {
      z_zh: true,
      c_ch: false,
      s_sh: false,
      n_l: true,
      f_h: false,
      r_l: false,
      in_ing: false,
      en_eng: false,
      an_ang: false,
    };
    const host = mount({ settingsOpen: true, session: state({ fuzzy }) });
    expect(host.container.querySelector('[data-testid="ime-settings-panel"]')).toBeTruthy();
    expect(host.container.querySelectorAll('[data-testid^="ime-fuzzy-"]').length).toBe(9);
    expect(
      host.container.querySelector('[data-testid="ime-fuzzy-z_zh"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      host.container.querySelector('[data-testid="ime-fuzzy-c_ch"]')?.getAttribute("aria-pressed"),
    ).toBe("false");
    // The key grid is hidden while the settings panel is open.
    expect(host.container.querySelector('[data-testid="ime-key-q"]')).toBeNull();
  });

  test("the settings actions report their intent", async () => {
    const onfuzztoggle = vi.fn();
    const onpreset = vi.fn();
    const onlearnclear = vi.fn();
    const ondisable = vi.fn();
    const host = mount({ settingsOpen: true, onfuzztoggle, onpreset, onlearnclear, ondisable });

    await fireEvent.click(host.container.querySelector('[data-testid="ime-fuzzy-n_l"]')!);
    await fireEvent.click(host.container.querySelector('[data-testid="ime-preset-strict"]')!);
    await fireEvent.click(host.container.querySelector('[data-testid="ime-preset-permissive"]')!);
    // Destructive: the first tap only asks (see the case below).
    await fireEvent.click(host.container.querySelector('[data-testid="ime-learn-clear"]')!);
    await fireEvent.click(host.container.querySelector('[data-testid="ime-learn-clear"]')!);
    await fireEvent.click(host.container.querySelector('[data-testid="ime-disable"]')!);

    expect(onfuzztoggle).toHaveBeenCalledWith("n_l");
    expect(onpreset.mock.calls.map((c) => c[0])).toEqual(["strict", "permissive"]);
    expect(onlearnclear).toHaveBeenCalledTimes(1);
    expect(ondisable).toHaveBeenCalledTimes(1);
  });

  test("the settings panel reports the dictionary size and the fuzzy mode", () => {
    const strict = mount({ settingsOpen: true });
    expect(
      strict.container.querySelector('[data-testid="ime-mode-summary"]')?.textContent?.trim(),
    ).toBe("严格");
    expect(
      strict.container.querySelector('[data-testid="ime-dict-entries"]')?.textContent,
    ).toContain("165361");

    const custom = mount({
      settingsOpen: true,
      session: state({
        strict: false,
        fuzzy: {
          z_zh: true,
          c_ch: false,
          s_sh: false,
          n_l: false,
          f_h: false,
          r_l: false,
          in_ing: false,
          en_eng: false,
          an_ang: false,
        },
      }),
    });
    expect(
      custom.container.querySelector('[data-testid="ime-mode-summary"]')?.textContent?.trim(),
    ).toBe("自定义");
  });

  test("forgetting every learned word asks once before it destroys anything", async () => {
    const onlearnclear = vi.fn();
    const host = mount({ settingsOpen: true, onlearnclear });
    const button = () => host.container.querySelector('[data-testid="ime-learn-clear"]');

    await fireEvent.click(button()!);
    expect(onlearnclear).not.toHaveBeenCalled();
    expect(button()?.textContent).toContain("确认");
    expect(button()?.getAttribute("aria-pressed")).toBe("true");

    // The question survives a re-render…
    await tick();
    expect(button()?.textContent).toContain("确认");
    await fireEvent.click(button()!);
    expect(onlearnclear).toHaveBeenCalledTimes(1);
    // …and is not asked again afterwards.
    expect(button()?.textContent).not.toContain("确认");
  });

  test("closing the settings panel drops a pending confirmation", async () => {
    const onlearnclear = vi.fn();
    const host = mount({ settingsOpen: true, onlearnclear });
    await fireEvent.click(host.container.querySelector('[data-testid="ime-learn-clear"]')!);

    // `settingsOpen` is a prop: the overlay closes the panel from its own state.
    await host.rerender({ settingsOpen: false });
    await host.rerender({ settingsOpen: true });
    await tick();

    const button = host.container.querySelector('[data-testid="ime-learn-clear"]');
    expect(button?.textContent).not.toContain("确认");
    await fireEvent.click(button!);
    expect(onlearnclear).not.toHaveBeenCalled(); // it asked again instead of acting
  });

  test("the toolbar opens settings and hides the keyboard", async () => {
    const onsettings = vi.fn();
    const onhide = vi.fn();
    const host = mount({ onsettings, onhide });
    await fireEvent.click(host.container.querySelector('[data-testid="ime-settings"]')!);
    await fireEvent.click(host.container.querySelector('[data-testid="ime-hide"]')!);
    expect(onsettings).toHaveBeenCalledTimes(1);
    expect(onhide).toHaveBeenCalledTimes(1);
  });

  test("the offline banner shows exactly when the bridge is unavailable", () => {
    expect(mount({ online: true }).container.querySelector('[data-testid="ime-offline"]')).toBeNull();
    const offline = mount({ online: false, session: null });
    expect(offline.container.querySelector('[data-testid="ime-offline"]')).toBeTruthy();
    // Keys still render, so the device is never left with a blank keyboard.
    expect(offline.container.querySelector('[data-testid="ime-key-z"]')).toBeTruthy();
    // The two controls that would need the engine are visibly unavailable: nothing
    // is silently ignored, and the banner says what still works.
    expect(
      offline.container.querySelector('[data-testid="ime-mode"]')?.hasAttribute("disabled"),
    ).toBe(true);
    expect(
      offline.container.querySelector('[data-testid="ime-settings"]')?.hasAttribute("disabled"),
    ).toBe(true);
  });

  test("every label follows the locale (no hard-coded Chinese)", async () => {
    setLocale("en");
    const host = mount({ session: state({ input: "wo", composing: true, candidates: [] }) });
    const text = host.container.textContent ?? "";
    expect(text).toContain("No candidates"); // ime.empty
    expect(text).toContain("space"); // ime.space
    expect(text).toContain("Keyboard settings"); // ime.settings
    // The Chinese *copy* is gone (the 中 mode glyph is a label, not copy).
    expect(text).not.toContain("没有候选");
    expect(text).not.toContain("输入法设置");
  });
});

describe("ImeKeyboard.svelte — commit hint", () => {
  test("a remembered commit says what was inserted and offers the undo", async () => {
    const onforget = vi.fn();
    const host = mount({
      onforget,
      session: state({ last_committed: "中国", last_pick_code: "zhongguo", learned_pins: 1 }),
    });
    const chip = host.container.querySelector('[data-testid="ime-last-committed"]');
    expect(chip?.textContent).toContain("中国");

    await fireEvent.click(host.container.querySelector('[data-testid="ime-forget"]')!);
    expect(onforget).toHaveBeenCalledTimes(1);
  });

  test("a sentence composition shows the hint but offers no undo", () => {
    const host = mount({
      session: state({ last_committed: "中国人民", last_pick_code: null }),
    });
    expect(
      host.container.querySelector('[data-testid="ime-last-committed"]')?.textContent,
    ).toContain("中国人民");
    // Nothing was learned, so a "forget" button would do nothing — it is absent.
    expect(host.container.querySelector('[data-testid="ime-forget"]')).toBeNull();
  });

  test("the hint gives way to the candidate bar while composing", () => {
    const host = mount({
      session: state({
        input: "zhong",
        composing: true,
        candidates: [{ text: "中", kind: "dict" }],
        last_committed: "中国",
        last_pick_code: "zhongguo",
      }),
    });
    expect(host.container.querySelector('[data-testid="ime-last-committed"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="ime-composition"]')).toBeTruthy();
  });

  test("no hint is shown before anything is committed", () => {
    const host = mount();
    expect(host.container.querySelector('[data-testid="ime-last-committed"]')).toBeNull();
  });
});

describe("ImeKeyboard.svelte — a command the engine never saw", () => {
  test("a failed command is shown, not swallowed", () => {
    expect(mount({ error: false }).container.querySelector('[data-testid="ime-bridge-error"]')).toBeNull();

    const failed = mount({ error: true });
    const notice = failed.container.querySelector('[data-testid="ime-bridge-error"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain("无响应");
    // The keys stay usable, so the notice never becomes a dead end.
    expect(failed.container.querySelector('[data-testid="ime-key-z"]')).toBeTruthy();
  });

  test("the notice is visible while a composition is in flight too", () => {
    const host = mount({
      error: true,
      session: state({ input: "zhong", composing: true, candidates: [{ text: "中", kind: "dict" }] }),
    });
    expect(host.container.querySelector('[data-testid="ime-bridge-error"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="ime-composition"]')).toBeTruthy();
  });
});
