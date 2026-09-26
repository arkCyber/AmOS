/**
 * REQ-A1472 / F-SH-716 — 输入法设置面板在引擎没答话时替它陈述状态（REQ-A1472）。
 *
 * `ImeKeyboard` 头部逐字写着 `state` 为 `null` 就是「宿主桥不可用（浏览器预览 ∕ 没有守护进程的
 * 构建）」。而设置面板（`{#if settingsOpen}` 那一支）逐字把这份「没答」折成引擎的**读数**：
 * `t("ime.dictEntries", { n: session?.dict_entries ?? 0 })` 画出「词典 0 码」、
 * `{t("ime.learned", { n: learned })}`（`learned` 由 `?? 0` 求和）画出「已学习 0 个词」、
 * `{session?.strict ? t("ime.presetStrict") : t("ime.fuzzyCustom")}` 画出「自定义」，九枚
 * 模糊开关又一律 `aria-pressed={!!session?.fuzzy[pair]}` = `false`（全 off）—— 五个「0」与
 * 九个「关」都是替一台没答话的引擎说的。**而且**面板与离线横幅互斥（横幅在 `{:else}` 支），
 * 所以打开设置面板时那句「输入法后端未连接」被换掉了：面板里没有任何一处说明「没答」这件事。
 *
 * 修法：`session === null` 时读数画「—」（既有的「设备没上报就画 —」纪律），引擎开关
 * `disabled`（同文件 `ime-mode` ∕ `ime-settings` 对 `!online` 的既有做法，注释逐字「The two
 * controls that would need the engine are visibly unavailable」），并把离线那句话搬进面板。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import ImeKeyboard from "../src/svelte/ImeKeyboard.svelte";
import type { ImeState } from "../src/lib/ime";
import { t } from "../src/svelte/locale.svelte";

const noop = () => {};

/** A minimal engine state — the settings panel only reads `strict`, `dict_entries`, `fuzzy`. */
function state(over: Partial<ImeState> = {}): ImeState {
  return {
    composing: false,
    input: "",
    candidates: [],
    strict: true,
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
    dict_entries: 165_361,
    learned_pins: 3,
    learned_pending: 1,
    last_committed: null,
    last_pick_code: null,
    ...over,
  } as ImeState;
}

function mount(props: Record<string, unknown> = {}) {
  return render(ImeKeyboard, {
    props: {
      session: state(),
      online: true,
      error: false,
      mode: "zh",
      page: 0,
      settingsOpen: true,
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

const text = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null;
/** The learned-count span (the row's second span); it had no hook before this round either. */
const learnedText = (c: HTMLElement): string | null => {
  const row = c.querySelector('[data-testid="ime-dict-entries"]')?.parentElement;
  const spans = row ? [...row.querySelectorAll("span")] : [];
  return spans[spans.length - 1]?.textContent?.trim() ?? null;
};
const off = { session: null, online: false };

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("REQ-A1472 — 设置面板不得替没答话的引擎陈述状态", () => {
  test("引擎没答话：两处读数画「—」，不是「0 码」「已学习 0 个词」", () => {
    const { container: c } = mount(off);
    expect(text(c, "ime-dict-entries")).toBe("—");
    expect(learnedText(c)).toBe("—");
    // 而不是修前那两个被 `?? 0` 折叠出来的假读数。
    expect(text(c, "ime-dict-entries")).not.toBe(t("ime.dictEntries", { n: 0 }));
    expect(learnedText(c)).not.toBe(t("ime.learned", { n: 0 }));
  });

  test("引擎没答话：模式摘要画「—」，不是「自定义」", () => {
    const { container: c } = mount(off);
    expect(text(c, "ime-mode-summary")).toBe("—");
    expect(text(c, "ime-mode-summary")).not.toBe(t("ime.fuzzyCustom"));
  });

  test("引擎没答话：面板里要说出为什么（离线那句话被 `{:else}` 支换掉了）", () => {
    const { container: c } = mount(off);
    expect(text(c, "ime-settings-offline")).toBe(t("ime.offline"));
  });

  test("引擎没答话：需要引擎的开关全禁用（九枚模糊 + 两枚预设 + 学习清除）", () => {
    const { container: c } = mount(off);
    const fuzzy = [...c.querySelectorAll('[data-testid^="ime-fuzzy-"]')];
    expect(fuzzy.length).toBe(9);
    for (const b of fuzzy) expect(b.hasAttribute("disabled")).toBe(true);
    expect(c.querySelector('[data-testid="ime-preset-strict"]')?.hasAttribute("disabled")).toBe(true);
    expect(c.querySelector('[data-testid="ime-preset-permissive"]')?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(c.querySelector('[data-testid="ime-learn-clear"]')?.hasAttribute("disabled")).toBe(true);
    // 而「关闭输入法」是 store 动作、不需要引擎，必须仍然可用（不能顺手把它也关掉）。
    expect(c.querySelector('[data-testid="ime-disable"]')?.hasAttribute("disabled")).toBe(false);
  });

  test("正控 · 引擎答了话：真读数照画、开关可用、面板里没有那句离线话", () => {
    const { container: c } = mount({ session: state() });
    expect(text(c, "ime-dict-entries")).toBe(t("ime.dictEntries", { n: 165_361 }));
    expect(learnedText(c)).toBe(t("ime.learned", { n: 4 }));
    expect(text(c, "ime-mode-summary")).toBe(t("ime.presetStrict"));
    expect(c.querySelector('[data-testid="ime-settings-offline"]')).toBeNull();
    expect(
      c.querySelector('[data-testid="ime-fuzzy-z_zh"]')?.hasAttribute("disabled"),
    ).toBe(false);
  });
});
