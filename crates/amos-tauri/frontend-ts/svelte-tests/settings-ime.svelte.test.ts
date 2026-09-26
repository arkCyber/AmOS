/**
 * DOM tests for the Settings → Input Method page.
 *
 * This page is what makes the input method *discoverable*: without it the keyboard
 * only exists for someone who already focused a text field, and its preferences can
 * only be changed with the keyboard on screen. These cases pin the contract — the
 * switch writes the same `amos-ui.ime` preference the keyboard reads, the fuzzy
 * controls go through the same `ime_*` commands as the keyboard's own panel, the
 * destructive reset asks first, and with no engine the page says so instead of
 * showing controls that would silently do nothing.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ImePage from "../src/svelte/settings/ImePage.svelte";
import { IME_ENABLED_KEY, writeImeEnabled } from "../src/lib/ime";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(cleanup);
afterEach(() => setLocale("zh"));
afterEach(() => window.localStorage.removeItem(IME_ENABLED_KEY));
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const PAIRS = ["z_zh", "c_ch", "s_sh", "n_l", "f_h", "r_l", "in_ing", "en_eng", "an_ang"];

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function (the same helper `messages.svelte.test.ts` uses — `window.localStorage`
 * is a per-access proxy, so the window property itself is replaced).
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

/** A minimal `ime_*` engine: enough state to drive the page's controls. */
function installFakeEngine(): string[] {
  const calls: string[] = [];
  let fuzzy: Record<string, boolean> = Object.fromEntries(PAIRS.map((p) => [p, false]));
  let pins = 3;
  const state = () => ({
    input: "",
    candidates: [],
    composing: false,
    strict: PAIRS.every((p) => !fuzzy[p]),
    fuzzy,
    dict_entries: 165_361,
    learned_pins: pins,
    learned_pending: 0,
    last_committed: null,
    last_pick_code: null,
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      switch (command) {
        case "ime_status":
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
          pins = 0;
          return Promise.resolve(state());
        default:
          return Promise.resolve(null);
      }
    },
  };
  return calls;
}

const q = (host: { container: HTMLElement }, testid: string) =>
  host.container.querySelector(`[data-testid="${testid}"]`);

describe("Settings → Input Method", () => {
  test("the switch reflects and writes the same preference the keyboard reads", async () => {
    const host = render(ImePage);
    await tick();
    const sw = host.container.querySelector('[role="switch"]');
    expect(sw?.getAttribute("aria-checked")).toBe("false");

    await fireEvent.click(sw!);
    await tick();
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("true");
    expect(host.container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");

    await fireEvent.click(host.container.querySelector('[role="switch"]')!);
    await tick();
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("false");
  });

  test("the switch follows the keyboard, not only its own taps", async () => {
    const host = render(ImePage);
    await tick();
    const sw = () => host.container.querySelector('[role="switch"]');
    expect(sw()?.getAttribute("aria-checked")).toBe("false");

    // The keyboard's own panel turned the input method off: same key, same window —
    // the page must not keep describing a preference that has moved.
    writeImeEnabled(true);
    await tick();
    expect(sw()?.getAttribute("aria-checked")).toBe("true");

    writeImeEnabled(false);
    await tick();
    expect(sw()?.getAttribute("aria-checked")).toBe("false");
  });

  test("with an engine it offers the fuzzy pairs, the presets and a real readout", async () => {
    const calls = installFakeEngine();
    const host = render(ImePage);
    await tick();
    await settle();

    expect(q(host, "settings-ime-offline")).toBeNull();
    expect(host.container.querySelectorAll('[data-testid^="settings-ime-pair-"]').length).toBe(9);
    expect(q(host, "settings-ime-mode")?.textContent).toContain("严格");
    expect(q(host, "settings-ime-dict")?.textContent).toContain("165361");

    await fireEvent.click(q(host, "settings-ime-pair-n_l")!);
    await tick();
    expect(calls).toContain("ime_fuzzy_toggle");
    expect(q(host, "settings-ime-mode")?.textContent).toContain("自定义");
    expect(q(host, "settings-ime-pair-n_l")?.getAttribute("aria-pressed")).toBe("true");

    await fireEvent.click(q(host, "settings-ime-strict")!);
    await tick();
    expect(calls).toContain("ime_fuzzy_preset");
    expect(q(host, "settings-ime-mode")?.textContent).toContain("严格");

    await fireEvent.click(q(host, "settings-ime-permissive")!);
    await tick();
    expect(q(host, "settings-ime-mode")?.textContent).toContain("自定义");
  });

  test("forgetting every learned word asks once here too", async () => {
    const calls = installFakeEngine();
    const host = render(ImePage);
    await tick();
    await settle();

    const button = () => q(host, "settings-ime-forget");
    await fireEvent.click(button()!);
    expect(calls).not.toContain("ime_learning_clear");
    expect(button()?.textContent).toContain("确认");

    await fireEvent.click(button()!);
    expect(calls).toContain("ime_learning_clear");
  });

  test("a refused write leaves the switch where the store still is, and says so (REQ-A1432)", async () => {
    window.localStorage.setItem(IME_ENABLED_KEY, "false");
    const host = render(ImePage);
    await tick();
    const sw = () => host.container.querySelector('[role="switch"]');
    expect(sw()?.getAttribute("aria-checked")).toBe("false");

    const restore = failWritesFor(IME_ENABLED_KEY);
    try {
      await fireEvent.click(sw()!);
      await tick();
      // 开关本身就是「已保存」这条断言：写没落盘，它就不能亮。
      expect(sw()?.getAttribute("aria-checked")).toBe("false");
      expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("false");
      expect(q(host, "settings-ime-store-error")?.textContent).toContain("未保存");
    } finally {
      restore();
    }

    // 存储回来可写：这一次真的落盘，开关动，拒绝句消失。
    await fireEvent.click(sw()!);
    await tick();
    expect(sw()?.getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem(IME_ENABLED_KEY)).toBe("true");
    expect(q(host, "settings-ime-store-error")).toBeNull();
  });

  test("with no engine it says so instead of showing inert controls", async () => {
    const host = render(ImePage); // no fake bridge: invoke degrades to null
    await tick();
    await settle();

    expect(q(host, "settings-ime-offline")).toBeTruthy();
    expect(host.container.querySelectorAll('[data-testid^="settings-ime-pair-"]').length).toBe(0);
    expect(q(host, "settings-ime-forget")).toBeNull();
    // The switch is a local preference and stays usable.
    expect(host.container.querySelector('[role="switch"]')).toBeTruthy();
  });
});

/**
 * 系统输入法那一节（REQ-A1904）。上面那个开关管的是 WebView 里的屏幕键盘；这一节管的是
 * **平台自己的**输入法列表里那一个。在此之前产品里没有任何入口：用户只能离开 AmOS 去系统
 * 设置里手动开启。
 *
 * 这里钉的是**读数与拒绝**：三件不同的事（问不到 ∕ 平台答"没启用" ∕ 平台答"在用别的键盘"）
 * 必须画出三句不同的话 —— 把「问不到」折成「未启用」就是把平台的句子塞进一个没人回答过的
 * 问题（F-AND-007 那一族）。
 */
describe("Settings → Input Method → the system keyboard (REQ-A1904)", () => {
  /** A fake bridge that answers `ime_system_status` with `status` and records the calls. */
  function installSystemIme(
    status: unknown,
    opts: { refuseOpen?: string; log?: string[] } = {},
  ): string[] {
    const calls: string[] = opts.log ?? [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: (command: string) => {
        calls.push(command);
        switch (command) {
          case "ime_system_status":
            return Promise.resolve(status);
          case "ime_system_open_picker":
          case "ime_system_open_settings":
            return opts.refuseOpen
              ? Promise.reject({ code: opts.refuseOpen, message: "the launch was refused" })
              : Promise.resolve(null);
          case "ime_status":
            return Promise.resolve(null);
          default:
            return Promise.resolve(null);
        }
      },
    };
    return calls;
  }

  test("the platform's three answers are three different sentences", async () => {
    installSystemIme({
      available: true,
      reason: "",
      enabled: true,
      selected: true,
      current_id: "com.amos.ai/.glue.AmosImeService",
    });
    const host = render(ImePage);
    await tick();
    await settle();
    expect(q(host, "settings-ime-system-state")?.textContent).toContain("使用中");
    expect(q(host, "settings-ime-system-current")?.textContent).toContain("com.amos.ai");
    expect(q(host, "settings-ime-system-picker")).toBeTruthy();

    // Enabled but not in force — the ordinary Gboard case, and a *different* sentence.
    cleanup();
    installSystemIme({
      available: true,
      reason: "",
      enabled: true,
      selected: false,
      current_id: "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME",
    });
    const host2 = render(ImePage);
    await tick();
    await settle();
    expect(q(host2, "settings-ime-system-state")?.textContent).toContain("已启用");
    expect(q(host2, "settings-ime-system-current")?.textContent).toContain("LatinIME");

    // The platform says it is not enabled at all.
    cleanup();
    installSystemIme({
      available: true,
      reason: "",
      enabled: false,
      selected: false,
      current_id: "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME",
    });
    const host3 = render(ImePage);
    await tick();
    await settle();
    expect(q(host3, "settings-ime-system-state")?.textContent).toContain("未启用");
  });

  /**
   * 「问不到」**不是**「未启用」。宿主自己写下了它为什么问不到，那一句原样给出 —— 这一节还
   * 得让用户看见两个按钮都没有了（点了不会有任何事发生）。
   */
  test("an unasked platform is not a disabled keyboard", async () => {
    installSystemIme({
      available: false,
      reason: "this build has no Android input-method glue (host/desktop target)",
      enabled: null,
      selected: null,
      current_id: null,
    });
    const host = render(ImePage);
    await tick();
    await settle();

    expect(q(host, "settings-ime-system-state")?.textContent).toContain("不适用");
    expect(q(host, "settings-ime-system-state")?.textContent).not.toContain("未启用");
    expect(q(host, "settings-ime-system-unavailable")?.textContent).toContain(
      "no Android input-method glue",
    );
    expect(q(host, "settings-ime-system-picker")).toBeNull();
    expect(q(host, "settings-ime-system-settings")).toBeNull();
  });

  test("both launchers reach the host", async () => {
    const calls = installSystemIme({
      available: true,
      reason: "",
      enabled: false,
      selected: false,
      current_id: "",
    });
    const host = render(ImePage);
    await tick();
    await settle();

    await fireEvent.click(q(host, "settings-ime-system-settings")!);
    await tick();
    expect(calls).toContain("ime_system_open_settings");

    await fireEvent.click(q(host, "settings-ime-system-picker")!);
    await tick();
    expect(calls).toContain("ime_system_open_picker");
    // Neither is a refusal, so the page says nothing.
    expect(q(host, "settings-ime-system-open-error")).toBeNull();
  });

  /**
   * 一次被拒的启动必须留话：按钮按下去什么也没发生、也不说话，读起来就是按钮坏了。
   */
  test("a refused launch says so next to the button", async () => {
    installSystemIme(
      { available: true, reason: "", enabled: false, selected: false, current_id: "" },
      { refuseOpen: "amos.ime.system_open_failed" },
    );
    const host = render(ImePage);
    await tick();
    await settle();

    await fireEvent.click(q(host, "settings-ime-system-settings")!);
    await tick();
    await settle();
    expect(q(host, "settings-ime-system-open-error")?.textContent).toContain("没能打开");
  });

  /**
   * 「切换键盘」被平台的前提挡下时，说的一句**不一样**的话（REQ-A1904）。这不是「重试一下」：
   * 没有任何输入框在用键盘时，平台不会画出切换列表（真机实测：`mServedInputConnection=null`
   * ⇒ 无窗口、无对话框），再按一次永远不会成功 —— 用户该做的是把光标放进输入框，或改用
   * 不需要输入连接的「系统输入法设置」。把它渲染成通用失败句，用户就会一直按一个死按钮。
   */
  test("the picker's missing-input-connection refusal is not the retry sentence", async () => {
    installSystemIme(
      { available: true, reason: "", enabled: true, selected: false, current_id: "LatinIME" },
      { refuseOpen: "amos.ime.system_no_text_editor" },
    );
    const host = render(ImePage);
    await tick();
    await settle();

    await fireEvent.click(q(host, "settings-ime-system-picker")!);
    await tick();
    await settle();
    const said = q(host, "settings-ime-system-open-error")?.textContent ?? "";
    expect(said).toContain("输入框");
    expect(said).not.toContain("请重试");
  });

  /**
   * 用户从这一页跳到平台的界面里启用键盘 → 回到 AmOS。这一页手里的答案是**离开那一刻**的，
   * 不重问就会继续写着「未启用」。`visibilitychange` 是它唯一能知道自己被留在后台的时机。
   */
  test("the state is re-asked when the user comes back from the platform's screen", async () => {
    const calls = installSystemIme({
      available: true,
      reason: "",
      enabled: false,
      selected: false,
      current_id: "",
    });
    const host = render(ImePage);
    await tick();
    await settle();
    const asked = calls.filter((c) => c === "ime_system_status").length;

    // The user is on the platform's settings screen; the keyboard was enabled there.
    // The replacement bridge shares the call log, so the count below is the re-ask.
    installSystemIme(
      {
        available: true,
        reason: "",
        enabled: true,
        selected: false,
        current_id: "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME",
      },
      { log: calls },
    );
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    await settle();

    expect(q(host, "settings-ime-system-state")?.textContent).toContain("已启用");
    expect(calls.length).toBeGreaterThan(asked);
  });
});
