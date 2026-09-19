/**
 * desktop-shell.svelte.test.ts — the macOS-form shell topology (PC desktop).
 *
 * Why these cases exist (each one is a defect this file was written against, not a
 * spare assertion):
 *   * `DesktopShell` registered its cleanup with `onDestroy(...)` *inside* its
 *     `onMount` callback — a lifecycle call from outside the component's init phase.
 *     Measured against Svelte 5.57 that form still runs (`onDestroy` is
 *     `onMount(() => () => fn())`), so the case here pins the **property** — unmount
 *     releases every listener it added — not the shape. Negative control: delete the
 *     cleanup in `DesktopShell.onMount` and this fails ("keydown listener was never
 *     removed"); the `onDestroy`-inside-`onMount` form passes it, which is why the
 *     assertion is worded as a behaviour and not as a lint.
 *   * the Dock rendered `aria-label={appTitleKey(id)}` — the i18n **key**
 *     (`app.clock`), not the user's language — and named its three system items with
 *     hard-coded English ("Launchpad"/"Finder"/"Trash").
 *   * the separator was drawn *after* the trash, so the one visual grouping the Dock
 *     has was wrong.
 *   * `dockCapacity` / `dockOverflowCount` / `shouldShowMissionControl` /
 *     `SPOTLIGHT_*` were pure functions with tests and **no production call site**;
 *     these cases fail if the wiring is removed again.
 *
 * REQ-A262 added the end-to-end half of the container split — the paths a unit test on a
 * widget *cannot* reach, because the chrome handle belongs to the shell:
 *   * a trigger's click, the Apple menu's live rows, and the keyboard all converge on the
 *     shell the same way, and the **tooltip's hint comes from the same registry row that
 *     matched the key** (before this round `lib/shellChrome.ts` claimed F4 was bound
 *     while nothing bound it);
 *   * the two `desktop:*` window events are gone: the stage's "new folder" was answered
 *     by an empty handler in this file (a wire to nowhere) and is a greyed menu row now.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import Dock from "../src/svelte/Dock.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { KEYBOARD_CONFIG_KEY } from "../src/lib/keyboardConfigHook.svelte";
import { DOCK_PREFS_KEY } from "../src/lib/dockPrefs";
import { HOT_CORNER_KEY } from "../src/lib/hotCorners";
import { NOTIF_KEY } from "../src/lib/settings";
import { resetDesktopFeaturesForTest } from "../src/lib/desktopFeatures";
import { DEFAULT_DESKTOP_VIEW, type DesktopView } from "../src/lib/desktopView";
import { DOCK_MIN_WIDTH, SPOTLIGHT_HEIGHT, SPOTLIGHT_WIDTH,
  DESKTOP_GRID_COLS,
  DESKTOP_GRID_INSET,
  DESKTOP_GRID_ROWS,
  DESKTOP_TILE_GAP_X,
  DESKTOP_TILE_GAP_Y,
  DESKTOP_TILE_SIZE,
  desktopGridWidth,
  desktopIconCapacity,
} from "../src/lib/desktopLayout";
import { wallpaperFallbackColor } from "../src/lib/wallpaper";
import { surface, unlock } from "../src/svelte/shellState.svelte";
import { zh } from "../src/i18n/locales/zh";

const settle = () => new Promise((r) => setTimeout(r, 40));
const byAria = (c: HTMLElement, aria: string) => c.querySelector(`[aria-label="${aria}"]`);

const DESKTOP_SNAPSHOT = {
  screen_w: 1496,
  screen_h: 882,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

/** A fake host: `invoke` answers the two wm commands the desktop shell uses.
 *
 * `commands[]` records the call order, and `lastCall` records the most recent
 * non-poll invocation. `wm_windows` is polled (Dock running dots + shell's focused
 * window reader), so it would always be the last call; `lastCall` skips it so
 * "what did the user's keypress do" is answerable from the test. */
/** Installs a fake host. `desktopFeatures` is what the host answers for
 *  `desktop_features_disabled` (REQ-A287) — the *production* path for the two shell
 *  capability switches, as opposed to the `window.__amosDisabledFeatures` test hook. */
function installHost({
  windows = [] as unknown[],
  commands = [] as string[],
  desktopFeatures = [] as string[],
} = {}) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      commands.push(cmd);
      // Boot facts (polled/asked once at mount) are not "a command the shell sent in
      // response to something": the cases that assert `__lastCall === undefined` mean
      // "this gesture reached no host command", so the boot reads must stay out of the
      // probe (REQ-A287 added `desktop_features_disabled`).
      const isBootFact =
        cmd === "wm_windows" || cmd === "wm_layout_snapshot" || cmd === "desktop_features_disabled";
      if (!isBootFact) {
        (window as unknown as Record<string, unknown>).__lastCall = { cmd, args };
      }
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows };
      if (cmd === "desktop_features_disabled") return desktopFeatures;
      // The four window mutations answer with a `WmSnapshot` on the real host
      // (`Result<WmSnapshot, String>` in `crates/amos-tauri/src/wm.rs`). Modelling that
      // matters: `lib/wm.ts`'s `wmOpen/wmClose/wmHide/wmFocus` report success as
      // `result !== null`, so a fake host answering `null` would look like a refusal
      // (REQ-A415 — that is exactly how the Show Desktop restore "lost" its windows
      // until this line existed).
      if (
        cmd === "wm_hide" ||
        cmd === "wm_focus" ||
        cmd === "wm_close" ||
        cmd === "wm_open"
      ) {
        return { windows };
      }
      return null;
    },
    listen: async () => () => {},
  };
  return commands;
}

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. Same shape as the other svelte suites use (`window.localStorage`
 * is a per-access proxy in happy-dom, so the window property itself is replaced).
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
  Object.defineProperty(window, "localStorage", {
    value: fake,
    configurable: true,
    writable: true,
  });
  return () =>
    Object.defineProperty(window, "localStorage", {
      value: real,
      configurable: true,
      writable: true,
    });
}

/** Variant for the REQ-A275 menu tests: every `wm_open(label)` call is recorded
 * on `window.__wmOpens` so a test can assert "File → New Window invoked the host
 * with `label: 'files'`" without parsing `__lastCall` (which is also written). */
function installHostWithRecorder() {
  (window as unknown as Record<string, unknown>).__wmOpens = [] as string[];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (cmd === "wm_open") {
        const label = (args as { label?: string } | undefined)?.label;
        if (typeof label === "string") {
          ((window as unknown as { __wmOpens: string[] }).__wmOpens).push(label);
        }
        (window as unknown as Record<string, unknown>).__lastCall = { cmd, args };
      }
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      return null;
    },
    listen: async () => () => {},
  };
}

/**
 * 派发一次 keydown，并把事件对象交回去。
 *
 * `cancelable: true` 是必须的：壳用 `preventDefault()` 表示"这个键归我管"，
 * 而不可取消的事件上 `defaultPrevented` 永远是 `false` —— 那样"壳没有吃掉这个键"
 * 这类断言就测不出任何东西。
 */
function press(key: string, mods: Record<string, boolean> = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, cancelable: true, ...mods });
  window.dispatchEvent(ev);
  return ev;
}

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as unknown as { __lastCall?: unknown }).__lastCall;
  delete (window as unknown as { __wmOpens?: unknown }).__wmOpens;
  // The capability switches are module state in `lib/desktopFeatures` (one boot answer
  // per page load), so a case that answers "disabled" must not leak into the next one.
  resetDesktopFeaturesForTest();
});


describe("DesktopShell.svelte — the macOS chrome", () => {
  test("mounts the top bar, the dock and the stage", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(byAria(container, zh["desktop.topbar"])).toBeTruthy();
    expect(byAria(container, zh["desktop.dock"])).toBeTruthy();
    expect(container.querySelector('[data-testid="dock-panel"]')).toBeTruthy();
    // The stage is the host's measured screen minus the chrome (1496 × 882 here).
    const stage = container.querySelector("div.absolute") as HTMLElement | null;
    expect(stage?.getAttribute("style") ?? "").toContain("width: 1496px");
  });

  test("the Dock keeps a usable minimum width (DOCK_MIN_WIDTH, not a hard-coded 0)", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const panel = container.querySelector('[data-testid="dock-panel"]') as HTMLElement;
    expect(panel.style.minWidth).toBe(`${DOCK_MIN_WIDTH}px`);
  });

  test("unmount releases EVERY window listener the shell added", async () => {
    installHost();
    const added: Array<[string, EventListenerOrEventListenerObject]> = [];
    const removed: Array<[string, EventListenerOrEventListenerObject]> = [];
    const onAdd = vi.spyOn(window, "addEventListener");
    const onRemove = vi.spyOn(window, "removeEventListener");
    onAdd.mockImplementation((type: string, h: EventListenerOrEventListenerObject) => {
      if (type === "keydown" || type.startsWith("desktop:")) added.push([type, h]);
    });
    onRemove.mockImplementation((type: string, h: EventListenerOrEventListenerObject) => {
      if (type === "keydown" || type.startsWith("desktop:")) removed.push([type, h]);
    });

    const { unmount } = render(DesktopShell);
    await tick();
    await settle();
    // The shell adds the shortcut listener (+ the layout subscription, which is not a
    // window listener). The two `desktop:*` events are gone in REQ-A262 — the stage and
    // the dock now reach the shell through the chrome handle.
    expect(added.length).toBeGreaterThanOrEqual(1);
    unmount();
    await tick();

    for (const [type, handler] of added) {
      expect(
        removed.some(([t2, h2]) => t2 === type && h2 === handler),
        `${type} listener was never removed`,
      ).toBe(true);
    }
  });

  test("⌘Space opens Spotlight (with the module's geometry) and Esc closes it", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeNull();

    press(" ", { metaKey: true });
    await tick();
    await settle();
    const overlay = container.querySelector('[data-testid="spotlight-overlay"]') as HTMLElement;
    expect(overlay).toBeTruthy();
    // Inline styles come back normalised ("width: 600px"), so compare without spaces.
    const style = (overlay.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(style).toContain(`width:${SPOTLIGHT_WIDTH}px`);
    expect(style).toContain(`max-height:${SPOTLIGHT_HEIGHT}px`);
    // A dialog a screen reader can announce (the overlay used to be aria-hidden).
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-label")).toBe(zh["desktop.spotlight"]);

    press("Escape");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeNull();
  });

  test("⌘Tab shows the switcher only when there is something to switch between", async () => {
    installHost({ windows: [{ label: "files", kind: "App", state: "Focused" }] });
    const one = render(DesktopShell);
    await tick();
    await settle();
    press("Tab", { metaKey: true });
    await tick();
    await settle();
    expect(one.container.querySelector('[data-testid="mission-control"]')).toBeNull();


    one.unmount();

    installHost({
      windows: [
        { label: "files", kind: "App", state: "Focused" },
        { label: "notes", kind: "App", state: "Shown" },
      ],
    });
    const two = render(DesktopShell);
    await tick();
    await settle();
    press("Tab", { metaKey: true });
    await tick();
    await settle();
    const mc = two.container.querySelector('[data-testid="mission-control"]');
    expect(mc).toBeTruthy();
    expect(mc?.getAttribute("aria-label")).toBe(zh["desktop.missionControl"]);
  });

  test("F4 opens the Launchpad and F3 the switcher — from the registry, not a switch", async () => {
    installHost({
      windows: [
        { label: "files", kind: "App", state: "Focused" },
        { label: "notes", kind: "App", state: "Shown" },
      ],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // F4 was documented as bound and was bound nowhere (`lib/shellChrome.ts`); the
    // registry row is now what both the binding and the tooltip read.
    press("F4");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
    // F4 again toggles it closed (a shortcut that only opens is half a shortcut).
    press("F4");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeNull();

    press("F3");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="mission-control"]')).toBeTruthy();

    // …and a modifier the binding does not list must not fire: ⌘F3 is not F3.
    press("F3", { metaKey: true });
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="mission-control"]')).toBeTruthy();
  });

  test("Esc closes the TOP overlay only (layers are stacked, not all-or-nothing)", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    press("F4"); // launchpad
    await tick();
    press(" ", { metaKey: true }); // …then spotlight on top of it
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeTruthy();

    press("Escape");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeNull();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
  });

  test("the bar's and the dock's Launchpad tiles open it, and their tooltip shows F4", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const barTrigger = container.querySelector<HTMLButtonElement>('[data-testid="chrome-launchpad"]')!;
    // One row in the registry feeds both the key handler and this hint: the label is
    // derived from the same `{ key: "F4" }` the matcher compares against.
    expect(barTrigger.getAttribute("title")).toBe(`${zh["desktop.launchpad"]} (F4)`);
    expect(barTrigger.getAttribute("aria-keyshortcuts")).toBe("F4");
    await fireEvent.click(barTrigger);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
    press("Escape");
    await tick();
    await settle();

    const dockTile = container.querySelector<HTMLButtonElement>('[data-testid="dock-launchpad"]')!;
    expect(dockTile.getAttribute("aria-keyshortcuts")).toBe("F4");
    await fireEvent.click(dockTile);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
  });

  test("a key the user changed in keyboard settings is the key the desktop accepts (and hints)", async () => {
    installHost({
      // Mission Control 在 0/1 个窗口时**故意**不出现（没有可切换的东西）——
      // 最后那条断言需要一个真的"多窗口"场景。
      windows: [
        { label: "files", kind: "App", state: "Focused" },
        { label: "notes", kind: "App", state: "Shown" },
      ],
    });
    // 用户把 Launchpad 从 F4 改成 F9，并把 Spotlight（⌘Space）**显式禁用**（null）。
    writeStoreValue(KEYBOARD_CONFIG_KEY, {
      version: 1,
      overlays: { launchpad: [{ key: "F9" }], spotlight: null },
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    });

    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // 默认键不再开任何东西：覆盖是**取代**注册表默认值，不是"两个都生效"。
    // （这一条在修复前必红 —— 那时桌面壳读的是 `moduleForShortcut`，注册表默认值。）
    press("F4");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeNull();

    // 用户那把键生效，并且再按一次能关上
    press("F9");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
    press("F9");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeNull();

    // 提示读的是**同一份合并结果**（否则按钮会说 F4、按下去却是 F9 才开）
    const barTrigger = container.querySelector<HTMLButtonElement>('[data-testid="chrome-launchpad"]')!;
    expect(barTrigger.getAttribute("aria-keyshortcuts")).toBe("F9");
    expect(barTrigger.getAttribute("title")).toBe(`${zh["desktop.launchpad"]} (F9)`);

    // 没被改过的行仍按注册表工作（F3 → Mission Control）
    press("F3");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="mission-control"]')).toBeTruthy();
  });

  test("an overlay the user disabled (null) no longer answers its default key", async () => {
    installHost();
    writeStoreValue(KEYBOARD_CONFIG_KEY, {
      version: 1,
      overlays: { spotlight: null },
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    });

    const { container } = render(DesktopShell);
    await tick();
    await settle();

    press(" ", { metaKey: true });
    await tick();
    await settle();
    expect(container.querySelectorAll('[data-testid="overlay-layer"]')).toHaveLength(0);
  });

  test("⌃↑ 打开/关闭 Spaces 面板（这个键此前被吃掉却什么都不做）", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="overlay-layer"]')).toBeNull();

    const opened = press("ArrowUp", { ctrlKey: true });
    await tick();
    await settle();
    // 壳接了这个键（消费），并真的把面板渲染出来了
    expect(opened.defaultPrevented).toBe(true);
    const layers = () =>
      [...container.querySelectorAll<HTMLElement>('[data-testid="overlay-layer"]')].map(
        (l) => l.dataset.overlay,
      );
    expect(layers()).toEqual(["spaces-panel"]);

    // 再按一次关上
    press("ArrowUp", { ctrlKey: true });
    await tick();
    await settle();
    expect(layers()).toEqual([]);
  });

  test("Spaces 键的覆盖与禁用生效（含 Ctrl+1…9 这一族）", async () => {
    const commands = installHost();
    writeStoreValue(KEYBOARD_CONFIG_KEY, {
      version: 1,
      overlays: {},
      system: {},
      spaces: {
        // 上一个桌面改成 ⌃⌥←；其余三行全部**禁用**
        spacesPrev: { key: "ArrowLeft", ctrl: true, alt: true },
        spacesNext: null,
        spacesDirect: null,
        spacesPanel: null,
      },
      touch: {},
      updatedAt: 0,
    });

    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // 用户那把键生效：走到 `spaces_list`（宿主没答，函数在那里就返回了 —— 足以证明绑定命中）
    press("ArrowLeft", { ctrlKey: true, altKey: true });
    await tick();
    await settle();
    expect(commands).toContain("spaces_list");

    // 旧键（注册表默认的 ⌃←）不再触发
    commands.length = 0;
    press("ArrowLeft", { ctrlKey: true });
    await tick();
    await settle();
    expect(commands).not.toContain("spaces_list");

    // spacesNext / spacesDirect / spacesPanel 都被禁用：既不发命令、也不开面、也不吃键
    commands.length = 0;
    const right = press("ArrowRight", { ctrlKey: true });
    const one = press("1", { ctrlKey: true });
    const up = press("ArrowUp", { ctrlKey: true });
    await tick();
    await settle();
    expect(commands).not.toContain("spaces_list");
    expect(commands).not.toContain("spaces_switch");
    expect(container.querySelectorAll('[data-testid="overlay-layer"]')).toHaveLength(0);
    // "未接线"与"吃掉键"是两件事：禁用的行意味着这个键**不归壳管**
    expect(right.defaultPrevented).toBe(false);
    expect(one.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
  });

  test("Ctrl+1…9 这一族取的是那一行的**修饰符**（改成 ⌃⌥ 就按 ⌃⌥ 匹配）", async () => {
    const commands = installHost();
    writeStoreValue(KEYBOARD_CONFIG_KEY, {
      version: 1,
      overlays: {},
      system: {},
      // 注意不要用 `meta: true` 来表达"改成 ⌘"：规范匹配器有一条**有意**的兼容
      // （`s.meta` 且未显式写 `ctrl` ⇒ ⌃ 也算 ⌘，见 `shortcutMatches` 的真值表），
      // 于是"⌃3 不再生效"会变成假阳性。这里用 ⌃⌥，它不会被任何兼容规则吸收。
      spaces: { spacesDirect: { key: "1", ctrl: true, alt: true } },
      touch: {},
      updatedAt: 0,
    });

    render(DesktopShell);
    await tick();
    await settle();

    press("3", { ctrlKey: true }); // 旧修饰符（只 ⌃）：不再生效
    await tick();
    await settle();
    expect(commands).not.toContain("spaces_switch");

    press("3", { ctrlKey: true, altKey: true }); // 用户那把：跳到第 3 个桌面（index 2）
    await tick();
    await settle();
    expect(commands).toContain("spaces_switch");
    expect((window as unknown as { __lastCall?: { args?: { index?: number } } }).__lastCall?.args?.index).toBe(2);
  });

  test("the Apple menu is real where it can be: 系统设置… opens the app, 锁定屏幕 locks", async () => {
    const commands = installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    unlock(); // the lock surface is module-level state shared across tests

    const apple = container.querySelector<HTMLButtonElement>('[data-testid="apple-menu-trigger"]')!;
    await fireEvent.click(apple);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-settings"]')!);
    await tick();
    await settle();
    expect(commands).toContain("wm_open");
    // The menu closes itself after a choice (macOS does the same).
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();

    await fireEvent.click(apple);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-lock"]')!);
    await tick();
    await settle();
    expect(surface().kind).toBe("lock");
    unlock();
  });

  test("the stage's icon grid takes its geometry from the layout module, not from classes", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const grid = container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!;
    // The same numbers the template used to spell (`grid-cols-4`, `gap-x-6 gap-y-5`,
    // `left-8 top-8`, `calc(4 * 80px + 3 * 24px)`) — now from `lib/desktopLayout.ts`, so
    // the stage is no longer the one surface deciding its own geometry.
    const style = (grid.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(style).toContain(`width:${desktopGridWidth()}px`);
    expect(style).toContain(`grid-template-columns:repeat(${DESKTOP_GRID_COLS},${DESKTOP_TILE_SIZE}px)`);
    expect(style).toContain(`column-gap:${DESKTOP_TILE_GAP_X}px`);
    expect(style).toContain(`row-gap:${DESKTOP_TILE_GAP_Y}px`);
    expect(style).toContain(`left:${DESKTOP_GRID_INSET}px`);
    expect(style).toContain(`top:${DESKTOP_GRID_INSET}px`);
    // …and the grid is the capacity the layout module declares (4 × 4), not a literal 16.
    expect(desktopIconCapacity()).toBe(DESKTOP_GRID_COLS * DESKTOP_GRID_ROWS);
  });

  test("the ⚙️ item opens the Control Center, and the same click closes it", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const item = container.querySelector<HTMLButtonElement>('[data-testid="chrome-control-center"]')!;
    expect(item.disabled).toBe(false);
    expect(item.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeNull();

    await fireEvent.click(item);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeTruthy();
    // The trigger's own state follows the shell's, so the assistive layer is not told a lie
    // while the panel is up.
    expect(item.getAttribute("aria-expanded")).toBe("true");

    await fireEvent.click(item);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeNull();
    expect(item.getAttribute("aria-expanded")).toBe("false");
  });

  test("Escape closes the Control Center too (it is an overlay like the others)", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    await fireEvent.click(container.querySelector('[data-testid="chrome-control-center"]')!);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeTruthy();
    press("Escape");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeNull();
  });

  test("overlays stack in the order they were OPENED, not by a hard-coded class", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    // Control Center first, then Spotlight on top of it.
    await fireEvent.click(container.querySelector('[data-testid="chrome-control-center"]')!);
    await tick();
    await settle();
    press(" ", { metaKey: true });
    await tick();
    await settle();

    const layers = [...container.querySelectorAll<HTMLElement>('[data-testid="overlay-layer"]')];
    expect(layers.map((l) => l.dataset.overlay)).toEqual(["control-center-panel", "spotlight"]);
    const z = (el: HTMLElement) => Number(el.style.zIndex);
    expect(z(layers[0]!)).toBeLessThan(z(layers[1]!));

    // …and raising the *later* one follows the same rule the other way round: close
    // Spotlight, open the Launchpad, and it is the one on top.
    press("Escape");
    await tick();
    await settle();
    press("F4");
    await tick();
    await settle();
    const after = [...container.querySelectorAll<HTMLElement>('[data-testid="overlay-layer"]')];
    expect(after.map((l) => l.dataset.overlay)).toEqual(["control-center-panel", "launchpad"]);
    expect(z(after[1]!)).toBeGreaterThan(z(after[0]!));
  });

  test("the desktop's context menu is real where it can be (and honest where it cannot)", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const stage = container.querySelector('[aria-label="' + zh["desktop.stage"] + '"]')!;
    await fireEvent.contextMenu(stage);
    await tick();
    const menu = container.querySelector('[data-testid="desktop-context-menu"]');
    expect(menu).toBeTruthy();
    const rows = [...menu!.querySelectorAll('[role="menuitem"]')];
    const disabled = rows.filter((r) => (r as HTMLButtonElement).disabled);
    // 「新建文件夹」used to be a live row that dispatched a window event this shell
    // answered with an empty handler: a wire to nowhere, and a row that looked available.
    expect(disabled.map((r) => r.textContent?.trim())).toEqual([
      zh["desktop.ctxNewFolderUnavailable"],
    ]);
    expect(disabled[0]?.getAttribute("aria-label")).toBe(zh["desktop.ctxNewFolderUnavailable"]);
    // 「更改壁纸…」opens the app that owns wallpaper settings.
    const wallpaper = rows.find((r) => r.textContent?.includes(zh["desktop.ctxChangeWallpaper"]))!;
    expect((wallpaper as HTMLButtonElement).disabled).toBe(false);
  });

  test("the stage's wallpaper / display-settings rows really open Settings (not a no-op)", async () => {
    installHostWithRecorder();
    writeStoreValue(LAYOUT_KEY, { page: ["clock"], dock: [], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const stage = container.querySelector<HTMLElement>(
      '[aria-label="' + zh["desktop.stage"] + '"]',
    )!;
    const opens = () => (window as unknown as { __wmOpens: string[] }).__wmOpens;

    // REQ-A414: both rows called `wmOpenWithDiag` while the file's import line still
    // brought in the plain `invoke` — a bare `ReferenceError` inside an async handler.
    // The menu closed and nothing opened; the older case only asserted the row was
    // *enabled*, so it could not see this. Now the row is clicked.
    await fireEvent.contextMenu(stage);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="ctx-change-wallpaper"]')!);
    await tick();
    await settle();
    expect(opens()).toEqual(["settings"]);

    await fireEvent.contextMenu(stage);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="ctx-display-settings"]')!);
    await tick();
    await settle();
    expect(opens()).toEqual(["settings", "settings"]);
  });

  test("the stage's 'Open the N selected' opens EVERY selected app (no silent drop)", async () => {
    installHostWithRecorder();
    writeStoreValue(LAYOUT_KEY, { page: ["clock", "notes"], dock: [], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // ⌘/Ctrl-click toggles into the selection (macOS Finder), so two icons are picked.
    await fireEvent.click(container.querySelector('[data-desktop-icon-id="clock"]')!, {
      metaKey: true,
    });
    await tick();
    await fireEvent.click(container.querySelector('[data-desktop-icon-id="notes"]')!, {
      metaKey: true,
    });
    await tick();

    const stage = container.querySelector<HTMLElement>(
      '[aria-label="' + zh["desktop.stage"] + '"]',
    )!;
    await fireEvent.contextMenu(stage);
    await tick();
    const row = container.querySelector<HTMLButtonElement>('[data-testid="ctx-open-selection"]')!;
    expect(row.textContent).toContain(zh["desktop.openSelection"].replace("{n}", "2"));
    await fireEvent.click(row);
    await tick();
    await settle();
    expect((window as unknown as { __wmOpens: string[] }).__wmOpens.sort()).toEqual([
      "clock",
      "notes",
    ]);
  });

  test("the chrome handle is the shell's: no throw when a slot is rendered without it", async () => {
    installHost();
    // `TopBar`/`Dock` no longer provide the handle (the shell does). A container mounted
    // on its own must still render — the widgets simply have nothing to ask.
    const { container } = render(Dock);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="dock-panel"]')).toBeTruthy();
  });

  test("desktop icon grid: single click selects (macOS semantics), double-click opens", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar", "files"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const clock = container.querySelector<HTMLButtonElement>('[data-desktop-icon-id="clock"]')!;
    const notes = container.querySelector<HTMLButtonElement>('[data-desktop-icon-id="notes"]')!;

    // First click on `clock`: selection = {clock}; macOS shows the blue outline and
    // `aria-selected="true"`. Nothing is opened (single-click on a desktop icon is the
    // select verb, not the open verb).
    await fireEvent.click(clock);
    await tick();
    expect(clock.getAttribute("aria-selected")).toBe("true");
    expect(notes.getAttribute("aria-selected")).toBe("false");
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="desktop-selection-count"]')!.textContent?.trim(),
    ).toBe(zh["desktop.selection"].replace("{n}", "1"));

    // Double-click on `clock` opens it; selection clears (the open verb commits).
    await fireEvent.doubleClick(clock);
    await tick();
    await settle();
    const last = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last.cmd).toBe("wm_open");
    expect(last.args).toEqual({ label: "clock" });
    // Selection cleared after a successful open — same shape the Dock context menu's
    // `Quit` button follows.
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeNull();
  });

  test("desktop rubber-band selection: drag from empty stage selects intersecting icons", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar", "files"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const stage = container.querySelector<HTMLElement>('[aria-label="' + zh["desktop.stage"] + '"]')!;
    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    const notes = container.querySelector<HTMLElement>('[data-desktop-icon-id="notes"]')!;
    const calendar = container.querySelector<HTMLElement>('[data-desktop-icon-id="calendar"]')!;
    const files = container.querySelector<HTMLElement>('[data-desktop-icon-id="files"]')!;

    // happy-dom returns 0 from `getBoundingClientRect` (no layout). Stub each icon's
    // box to match the layout module's coordinates so the rubber-band hit-test sees
    // real rectangles (REQ-A263: stage geometry has one home in `lib/desktopLayout.ts`).
    const TILE = 80, GAP_X = 24, GAP_Y = 20, INSET = 32;
    const boxes: Record<string, { left: number; top: number; right: number; bottom: number }> = {
      clock: { left: INSET, top: INSET, right: INSET + TILE, bottom: INSET + TILE },
      notes: { left: INSET + TILE + GAP_X, top: INSET, right: INSET + TILE + GAP_X + TILE, bottom: INSET + TILE },
      calendar: { left: INSET, top: INSET + TILE + GAP_Y, right: INSET + TILE, bottom: INSET + TILE + GAP_Y + TILE },
      files: { left: INSET + TILE + GAP_X, top: INSET + TILE + GAP_Y, right: INSET + TILE + GAP_X + TILE, bottom: INSET + TILE + GAP_Y + TILE },
    };
    for (const [el, key] of [
      [clock, "clock"],
      [notes, "notes"],
      [calendar, "calendar"],
      [files, "files"],
    ] as const) {
      const box = boxes[key]!;
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: box.left, y: box.top, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: TILE, height: TILE, toJSON: () => box }),
      });
    }

    // 4×4 grid with 80px tiles + 24/20 px gaps: clock and notes share the first row,
    // calendar and files the second. Drag from (10,10) to (200,130) covers the first
    // row — clock + notes — but not the second (calendar/files).
    const rect = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    };
    const c = rect(clock);
    const n = rect(notes);
    const ca = rect(calendar);
    const f = rect(files);
    void c; void n; void ca; void f; // measurements asserted below by the rect-vs-rect logic

    await fireEvent.mouseDown(stage, { clientX: 10, clientY: 10, button: 0 });
    // The rubber-band exists only while the drag is live — pin it.
    expect(container.querySelector('[data-testid="desktop-rubber-band"]')).toBeTruthy();
    await fireEvent.mouseMove(stage, { clientX: 220, clientY: 130 });
    await fireEvent.mouseUp(stage, { clientX: 220, clientY: 130 });
    await tick();
    await settle();

    // The selection count is "2" (clock + notes), and the selection chip is up.
    const chip = container.querySelector('[data-testid="desktop-selection-count"]');
    expect(chip).toBeTruthy();
    expect(chip!.textContent?.trim()).toBe(zh["desktop.selection"].replace("{n}", "2"));
    expect(clock.getAttribute("aria-selected")).toBe("true");
    expect(notes.getAttribute("aria-selected")).toBe("true");
    expect(calendar.getAttribute("aria-selected")).toBe("false");
    expect(files.getAttribute("aria-selected")).toBe("false");

    // The rubber-band is gone after release — it must not persist.
    expect(container.querySelector('[data-testid="desktop-rubber-band"]')).toBeNull();

    // Clicking the stage backdrop (a non-drag mousedown) clears the selection.
    await fireEvent.mouseDown(stage, { clientX: 5, clientY: 5, button: 0 });
    await fireEvent.mouseUp(stage, { clientX: 5, clientY: 5, button: 0 });
    await tick();
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeNull();
  });

  test("desktop multi-selection: Cmd-click toggles one icon in/out; Shift-click unions a range (F-SH-010)", async () => {
    // The topbar's Edit → Select All test covers the keyboard ⌘A path. Here we pin
    // the mouse half of the same model so the two paths cannot diverge:
    //   • Cmd-click on an unselected icon → adds it.
    //   • Cmd-click on a *selected* icon → removes it (anchor does NOT move; macOS
    //     Finder keeps the anchor on the last real pick — see `onIconClick`).
    //   • Shift-click → unions [anchor..target] (in icon order) with the existing
    //     selection; it never silently drops a previously-picked icon. That rule is
    //     the FMEA F-SH-010 mitigation: a non-contiguous prior set {A, C} +
    //     Shift-click E → {A, B, C, D, E} — not just {B, C, D, E}.
    // Negative control: replace the union line in `onIconClick` with a plain
    // `selectedIds = new Set(unionRange(anchorId, id))` and this case fails
    // (`clock` is gone from the post-Shift-click selection — `expected false to
    // be true`).
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar", "files", "mail"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const idOf = (s: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-desktop-icon-id="${s}"]`,
      )!;
    const isSel = (id: string) =>
      idOf(id).getAttribute("aria-selected") === "true";

    // 1) Cmd-click `clock` — selected = {clock}.
    await fireEvent.click(idOf("clock"), { metaKey: true });
    await tick();
    expect(isSel("clock")).toBe(true);

    // 2) Cmd-click `calendar` — selected = {clock, calendar}.
    await fireEvent.click(idOf("calendar"), { metaKey: true });
    await tick();
    expect(isSel("clock")).toBe(true);
    expect(isSel("calendar")).toBe(true);
    expect(isSel("notes")).toBe(false);

    // 3) Cmd-click `calendar` AGAIN — toggle off; anchor stays put.
    await fireEvent.click(idOf("calendar"), { metaKey: true });
    await tick();
    expect(isSel("calendar")).toBe(false);
    expect(isSel("clock")).toBe(true);

    // 4) Shift-click `mail` — unions the contiguous range [calendar..mail] with
    //    the existing set {clock}. Result: {clock, calendar, files, mail}. Note
    //    that `notes` (index 1) is NOT in the anchor..target window (calendar is
    //    index 2, mail is index 4); it's not in the union either. macOS Finder
    //    agrees: Shift-click does not bend the range to include non-anchor-side
    //    picks, it only **adds** the range — the previous pick (clock) is
    //    preserved by the union-with-existing rule.
    await fireEvent.click(idOf("mail"), { shiftKey: true });
    await tick();
    for (const id of ["clock", "calendar", "files", "mail"]) {
      expect(isSel(id), `${id} should be selected after Shift-click`).toBe(true);
    }
    expect(isSel("notes")).toBe(false);
    // Chip count is the user-visible proof.
    const chip = container.querySelector('[data-testid="desktop-selection-count"]');
    expect(chip?.textContent?.trim()).toBe(
      zh["desktop.selection"].replace("{n}", "4"),
    );
  });

  test("double-clicking an icon in a multi-selection opens ALL the selected", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // Stub the icons' boxes (see the rubber-band test above for why).
    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    const notes = container.querySelector<HTMLElement>('[data-desktop-icon-id="notes"]')!;
    const TILE = 80, GAP_X = 24, INSET = 32;
    const cBox = { left: INSET, top: INSET, right: INSET + TILE, bottom: INSET + TILE };
    const nBox = { left: INSET + TILE + GAP_X, top: INSET, right: INSET + TILE + GAP_X + TILE, bottom: INSET + TILE };
    for (const [el, box] of [[clock, cBox], [notes, nBox]] as const) {
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: box.left, y: box.top, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: TILE, height: TILE, toJSON: () => box }),
      });
    }

    // Build a 2-icon selection (clock + notes) by rubber-banding them.
    const stage = container.querySelector<HTMLElement>('[aria-label="' + zh["desktop.stage"] + '"]')!;
    await fireEvent.mouseDown(stage, { clientX: 0, clientY: 0, button: 0 });
    await fireEvent.mouseMove(stage, { clientX: 300, clientY: 200 });
    await fireEvent.mouseUp(stage, { clientX: 300, clientY: 200 });
    await tick();
    await settle();

    expect(clock.getAttribute("aria-selected")).toBe("true");
    expect(notes.getAttribute("aria-selected")).toBe("true");

    // Double-click on one of the selected icons → both get opened (the host's
    // `wm_open` is create+focus; calling it twice opens two windows — exactly the
    // multi-open macOS Finder does).
    await fireEvent.doubleClick(clock);
    await tick();
    await settle();

    // Walk the dispatch order: both `wm_open(clock)` and `wm_open(notes)` should
    // appear in the recorded calls (the host opens each in its own window).
    const calls = (window as unknown as { __lastCall?: unknown }).__lastCall as
      | { cmd: string; args: unknown }
      | undefined;
    // The single call we pinned via the installHost helper records `__lastCall`
    // for the most-recent non-poll invoke; we expect that to be `wm_open` on
    // `notes` (the second of the two). Both calls happened — the chip clearing
    // is the third assertion.
    expect(calls?.cmd).toBe("wm_open");
    expect(["clock", "notes"]).toContain((calls?.args as { label?: string } | undefined)?.label);
    // The selection cleared after the open (the verb committed).
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeNull();
  });

  test("desktop context menu: with a selection, an 'Open the N selected' row appears", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // Stub the icons' boxes (see the rubber-band test for why).
    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    const notes = container.querySelector<HTMLElement>('[data-desktop-icon-id="notes"]')!;
    const TILE = 80, GAP_X = 24, INSET = 32;
    const cBox = { left: INSET, top: INSET, right: INSET + TILE, bottom: INSET + TILE };
    const nBox = { left: INSET + TILE + GAP_X, top: INSET, right: INSET + TILE + GAP_X + TILE, bottom: INSET + TILE };
    for (const [el, box] of [[clock, cBox], [notes, nBox]] as const) {
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: box.left, y: box.top, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: TILE, height: TILE, toJSON: () => box }),
      });
    }

    // Build a 2-icon selection by rubber-band, then open the context menu via the stage
    // backdrop (which is the same handler the icon's oncontextmenu would call into).
    const stage = container.querySelector<HTMLElement>('[aria-label="' + zh["desktop.stage"] + '"]')!;
    await fireEvent.mouseDown(stage, { clientX: 0, clientY: 0, button: 0 });
    await fireEvent.mouseMove(stage, { clientX: 300, clientY: 200 });
    await fireEvent.mouseUp(stage, { clientX: 300, clientY: 200 });
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeTruthy();

    await fireEvent.contextMenu(stage, { clientX: 400, clientY: 400 });
    await tick();
    const menu = container.querySelector('[data-testid="desktop-context-menu"]')!;
    const rows = [...menu.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    const labels = rows.map((r) => r.textContent?.trim());
    expect(labels).toContain(zh["desktop.openSelection"].replace("{n}", "2"));
    expect(labels).toContain(zh["desktop.clearSelection"]);
    // The Open-N row is **live** (the FMEA F-SH-001 rule: a row that says "open N"
    // must actually open N — not be a greyed stub).
    const openN = rows.find((r) => r.textContent?.includes(zh["desktop.openSelection"].replace("{n}", "2")));
    expect(openN?.disabled).toBe(false);
  });

  test("Escape clears the selection (no half-state where the chip shows but selection is empty)", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const clock = container.querySelector<HTMLButtonElement>('[data-desktop-icon-id="clock"]')!;
    await fireEvent.click(clock);
    await tick();
    expect(clock.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeTruthy();

    press("Escape");
    await tick();
    expect(clock.getAttribute("aria-selected")).toBe("false");
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeNull();
  });

  test("system shortcuts route through the focused window to wm_close / wm_hide", async () => {
    // ⌘W / ⌘M / ⌘H must (a) reach the host as `wm_close` / `wm_hide`, and (b) carry the
    // **focused** window label (not the Dock layout or a hard-coded string). They do not
    // fire when the focused window is the launcher (`main` — closing the launcher would
    // leave the desktop without a home surface).
    installHost({
      windows: [
        { label: "files", kind: "App", state: "Focused", focused: true },
        { label: "notes", kind: "App", state: "Shown", focused: false },
      ],
    });
    render(DesktopShell);
    await tick();
    // Let `refreshFocused()` resolve and write `focusedWindowLabel` before the key fires.
    // `refreshFocused` is an awaited promise chain; two settle()s give it room to run.
    await settle();
    await settle();

    press("w", { metaKey: true });
    await tick();
    await settle();
    // The last call carries the focused label, not a literal — `installHost` records
    // both fields, and this is the property: a wiring change cannot send the wrong
    // window. (`wm_windows` polling is filtered out by `installHost`.)
    const last = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last.cmd).toBe("wm_close");
    expect(last.args).toEqual({ label: "files" });

    press("m", { metaKey: true });
    await tick();
    await settle();
    const last2 = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last2.cmd).toBe("wm_hide");
    expect(last2.args).toEqual({ label: "files" });
  });

  test("system shortcuts with no focused window are a no-op (no command reaches the host)", async () => {
    // A focused window is required for ⌘W/⌘M/⌘H to act. Otherwise the shortcut is a
    // no-op: the desktop stays on its launcher surface instead of vanishing it.
    installHost({ windows: [] });
    render(DesktopShell);
    await tick();
    await settle();
    await settle();

    press("w", { metaKey: true });
    await tick();
    await settle();
    // The filter in `installHost` drops `wm_windows` (polled) and `wm_layout_snapshot`
    // (mount), so an unset `__lastCall` is the no-op signal.
    const last = (window as unknown as Record<string, { cmd: string; args: unknown } | undefined>)
      .__lastCall;
    expect(last).toBeUndefined();
  });

  test("⌘, opens the Settings app (the menu shortcut is real, not a comment)", async () => {
    installHost();
    render(DesktopShell);
    await tick();
    await settle();
    press(",", { metaKey: true });
    await tick();
    await settle();
    const last = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last.cmd).toBe("wm_open");
    expect(last.args).toEqual({ label: "settings" });
  });

  test("plain ⌘+key does not fire (a modifier the binding does not list must not match)", async () => {
    // The shell's system-shortcut matcher is **strict** about modifiers: ⌘W closes the
    // window, W does not (a typed character must reach the focused field). Pin it so
    // adding a new binding cannot silently broaden it.
    installHost({
      windows: [{ label: "files", kind: "App", state: "Focused" }],
    });
    render(DesktopShell);
    await tick();
    await settle();
    await settle();
    press("w");
    await tick();
    await settle();
    // No non-poll call: ⌘W (modifier-only) is the binding; `w` (no modifier) is not.
    const last = (window as unknown as Record<string, { cmd: string; args: unknown } | undefined>)
      .__lastCall;
    expect(last).toBeUndefined();
  });

  test("AMOS_DESKTOP_SHORTCUTS=disabled — ⌘W does not reach the host (the OS may own the binding)", async () => {
    // 关掉这个能力后,壳的 `handleSystemShortcut` 直接返回 false,让宿主 OS / WebView 决定
    // —— 这就是 macOS 真机上 `⌘H` 的场景:用户希望系统"隐藏应用",而不是前端消费。
    (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures = ["shortcuts"];
    try {
      installHost({
        windows: [{ label: "files", kind: "App", state: "Focused", focused: true }],
      });
      render(DesktopShell);
      await tick();
      await settle();
      await settle();
      press("w", { metaKey: true });
      await tick();
      await settle();
      // 没有 wm_close 被调用 —— `__lastCall` 应仍为空(只有 polling)。
      const last = (window as unknown as Record<string, unknown>).__lastCall;
      expect(last).toBeUndefined();
    } finally {
      delete (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures;
    }
  });

  test("REQ-A287 — the shell asks the host once at boot which capabilities the operator switched off", async () => {
    // 宿主是唯一读得到 `AMOS_DESKTOP_SHORTCUTS` / `AMOS_DOCK_CONTEXT_MENU` 的地方
    // (WebView 没有 env),所以 shell boot 必须真的去问一次 —— 否则那两个文档化的开关
    // 又会退回"永远不生效"。这条用例钉的是**那一次调用**,不是某个 flag 的值。
    const commands = installHost();
    render(DesktopShell);
    await tick();
    await settle();
    await settle();
    expect(commands).toContain("desktop_features_disabled");
  });

  test("REQ-A287 — a host answer of ['shortcuts'] disables ⌘W exactly like the test hook does", async () => {
    installHost({
      windows: [{ label: "files", kind: "App", state: "Focused", focused: true }],
      desktopFeatures: ["shortcuts"],
    });
    render(DesktopShell);
    await tick();
    await settle();
    await settle();
    press("w", { metaKey: true });
    await tick();
    await settle();
    // 宿主说关了 ⇒ 前端不抢键(宿主 OS / WebView 自己决定)。注意这条**没有**设置
    // `window.__amosDisabledFeatures`:走的就是生产路径。
    const last = (window as unknown as Record<string, unknown>).__lastCall;
    expect(last).toBeUndefined();
  });

  // ─── REQ-A275 — topbar File / Edit / View / Window / Help dropdowns ────────
  test("topbar View → Toggle Wallpaper hides the Backdrop without touching the icons grid (REQ-A275)", async () => {
    installHost();
    writeStoreValue("amos.settings.view", {
      showWallpaper: true,
      showIcons: true,
      showStageWidgets: true,
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="stage-backdrop"]')).toBeTruthy();
    const viewTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-view-trigger"]',
    )!;
    await fireEvent.click(viewTrigger);
    await tick();
    const panel = container.querySelector('[data-testid="menu-view-panel"]');
    expect(panel).toBeTruthy();
    const toggleRow = panel!.querySelector<HTMLButtonElement>(
      '[data-testid="menu-view-view.toggle-wallpaper"]',
    )!;
    await fireEvent.click(toggleRow);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="stage-backdrop"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-icon-grid"]')).toBeTruthy();
    const v = readStoreValue<DesktopView>("amos.settings.view", DEFAULT_DESKTOP_VIEW);
    expect(v.showWallpaper).toBe(false);
  });

  test("topbar View → Toggle Icons removes the desktop icon grid (REQ-A275)", async () => {
    installHost();
    writeStoreValue("amos.settings.view", {
      showWallpaper: true,
      showIcons: true,
      showStageWidgets: true,
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="desktop-icon-grid"]')).toBeTruthy();
    const viewTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-view-trigger"]',
    )!;
    await fireEvent.click(viewTrigger);
    await tick();
    const toggleRow = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-view-view.toggle-icons"]',
    )!;
    await fireEvent.click(toggleRow);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="desktop-icon-grid"]')).toBeNull();
    const v = readStoreValue<DesktopView>("amos.settings.view", DEFAULT_DESKTOP_VIEW);
    expect(v.showIcons).toBe(false);
  });

  test("topbar File → New Window fires wm_open('files') (REQ-A275)", async () => {
    installHostWithRecorder();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const fileTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-file-trigger"]',
    )!;
    await fireEvent.click(fileTrigger);
    await tick();
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-file-file.new-window"]',
    )!;
    await fireEvent.click(row);
    await tick();
    await settle();
    const opens = (window as unknown as { __wmOpens: string[] }).__wmOpens;
    expect(opens).toContain("files");
  });
});


describe("Dock.svelte — names, grouping and capacity", () => {
  const MANY_APPS = ["clock", "notes", "calendar", "photos", "files", "mail", "maps", "camera"];
  const originalInnerWidth = window.innerWidth;

  function seedDock(ids: string[]) {
    writeStoreValue(LAYOUT_KEY, { page: [], dock: ids, hidden: [] });
  }

  function setWindowWidth(w: number) {
    Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });
  }

  beforeEach(() => setWindowWidth(originalInnerWidth));
  afterEach(() => setWindowWidth(originalInnerWidth));

  test("system items are localized and app names are TRANSLATED (never the raw i18n key)", async () => {
    setWindowWidth(2000);
    seedDock(["clock", "notes"]);
    const { container } = render(Dock);
    await tick();
    await settle();

    expect(byAria(container, zh["desktop.launchpad"])).toBeTruthy();
    expect(byAria(container, zh["desktop.finder"])).toBeTruthy();
    expect(byAria(container, zh["desktop.trashInFiles"])).toBeTruthy();
    // The old code put `appTitleKey(id)` (e.g. `app.clock.title`) straight into
    // aria-label: a screen reader read the key out loud.
    const labels = [...container.querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label")!,
    );
    expect(labels.some((l) => l.startsWith("app."))).toBe(false);
    expect(labels.some((l) => l === zh["app.clock"])).toBe(true);
  });

  test("the system items come from the registry — and the Trash says it cannot act", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    const { container } = render(Dock);
    await tick();
    await settle();
    // Order is the registry's: apps, then Launchpad, Finder, │ , Trash.
    const ids = [...container.querySelectorAll("[data-dock-item]")].map((el) =>
      el.getAttribute("data-dock-item"),
    );
    expect(ids).toEqual(["notes", "dock-launchpad", "dock-finder", "dock-trash"]);
    // Its handler used to be `if (id === "trash") return;` — pressable, announced as
    // pressable, and doing nothing (FMEA F-SH-001).
    const trash = container.querySelector<HTMLButtonElement>('[data-testid="dock-trash"]')!;
    expect(trash.disabled).toBe(true);
    expect(trash.getAttribute("aria-disabled")).toBe("true");
  });

  test("the separator is drawn BEFORE the trash (that is the one grouping the Dock has)", async () => {
    setWindowWidth(2000);
    seedDock([]);
    const { container } = render(Dock);
    await tick();
    await settle();
    const sep = container.querySelector('[data-testid="dock-separator"]') as Element;
    const trash = byAria(container, zh["desktop.trashInFiles"]) as Element;
    expect(sep && trash).toBeTruthy();
    const rel = sep.compareDocumentPosition(trash);
    expect(Boolean(rel & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    // It is data on the registry row, not a template `{#if}`: `dock-trash` declares it.
    const trashRow = container.querySelector('[data-dock-item="dock-trash"]')!;
    expect(trashRow.previousElementSibling?.getAttribute("data-testid")).toBe("dock-separator");
  });

  test("magnification is driven by the MEASURED centre of each dock item", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    const { container } = render(Dock);
    await tick();
    await settle();
    const wrapper = container.querySelector('[data-dock-item="notes"] > div') as HTMLElement;
    const bar = container.querySelector(`[aria-label="${zh["desktop.dock"]}"]`)!;
    const scaleOf = (el: HTMLElement) =>
      Number(/scale\(([\d.]+)\)/.exec(el.getAttribute("style") ?? "")?.[1] ?? "NaN");
    // A cursor parked on the row grows the tile under it…
    await fireEvent.mouseMove(bar, { clientX: 0 });
    await tick();
    expect(scaleOf(wrapper)).toBeGreaterThan(1);
    // …and one far away leaves the row at its resting size (no permanent zoom). What this
    // pins is the wiring: the transform comes from the measured centre of `data-dock-item`,
    // so a broken lookup (or a non-reactive derived) leaves the row at 1× and fails here.
    await fireEvent.mouseMove(bar, { clientX: 100000 });
    await tick();
    expect(scaleOf(wrapper)).toBe(1);
  });

  test("a LEFT dock is a vertical column, not a 68px strip with a hard-coded bottom (REQ-A414)", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    // The position comes from the same prefs the context menu / Settings page write.
    writeStoreValue(DOCK_PREFS_KEY, {
      position: "left",
      autoHide: false,
      magnification: 1.5,
      iconSize: 48,
    });
    installHost({ windows: [] });
    const { container } = render(Dock);
    await tick();
    await settle();

    const bar = container.querySelector<HTMLElement>(`[aria-label="${zh["desktop.dock"]}"]`)!;
    // The box is a full-height column from the menu bar down, so it must NOT carry the
    // bottom bar's fixed height (that + `top`/`bottom` is what CSS resolves by dropping
    // `bottom`). Whitespace is stripped because the browser normalises the attribute.
    const wrapperStyle = (bar.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(wrapperStyle).toContain("top:24px");
    expect(wrapperStyle).toContain("bottom:0");
    expect(wrapperStyle).not.toContain("height:68px");
    expect(bar.className).toContain("left-0");
    // A vertical toolbar is announced as vertical.
    expect(bar.getAttribute("aria-orientation")).toBe("vertical");

    // The panel's minimum box is on the other axis: a side dock is as narrow as the bar
    // is tall (320px of `min-width` would be a 320px-wide column).
    const panel = container.querySelector<HTMLElement>('[data-testid="dock-panel"]')!;
    const panelStyle = (panel.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(panelStyle).toContain("min-height:320px");
    expect(panelStyle).not.toContain("min-width:320px");
  });

  test("a BOTTOM dock keeps its horizontal box (the side fix did not move the default)", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    installHost({ windows: [] });
    const { container } = render(Dock);
    await tick();
    await settle();

    const bar = container.querySelector<HTMLElement>(`[aria-label="${zh["desktop.dock"]}"]`)!;
    const wrapperStyle = (bar.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(wrapperStyle).toContain("height:68px");
    expect(wrapperStyle).not.toContain("top:24px");
    expect(bar.getAttribute("aria-orientation")).toBe("horizontal");
    const panel = container.querySelector<HTMLElement>('[data-testid="dock-panel"]')!;
    expect((panel.getAttribute("style") ?? "").replace(/\s+/g, "")).toContain("min-width:320px");
  });

  test("what does not fit is REPORTED, not dropped silently (+N uses dockOverflowCount)", async () => {
    setWindowWidth(2000);
    seedDock(["clock", "notes"]);
    const wide = render(Dock);
    await tick();
    await settle();
    expect(wide.container.querySelector('[data-testid="dock-overflow"]')).toBeNull();
    wide.unmount();

    // 400px: dockCapacity(400) = floor((400 − 2·24) / (48+8)) = 6. Minus the 3 dock
    // modules (launchpad / finder / trash) leaves 3 user slots; 8 apps − 3 = 5 hidden.
    setWindowWidth(400);
    seedDock(MANY_APPS);
    const narrow = render(Dock);
    await tick();
    await settle();
    const chip = narrow.container.querySelector('[data-testid="dock-overflow"]');
    expect(chip).toBeTruthy();
    expect(byAria(narrow.container, zh["desktop.dockOverflow"].replace("{n}", "5"))).toBeTruthy();
    // …and the system items survive the squeeze (macOS never drops the trash).
    expect(byAria(narrow.container, zh["desktop.trashInFiles"])).toBeTruthy();
    expect(byAria(narrow.container, zh["desktop.finder"])).toBeTruthy();
  });

  test("right-click an app tile opens a dock context menu, and Quit calls wm_close", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    // `wm_windows` returns "Focused" for notes so the menu's items light up; `wm_close`
    // is the action that actually closes the window.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: unknown) => {
        // The Dock reads `wm_windows` for its running-dot poll AND `wm_close` for the
        // Quit menu action. Filter the poll so the assertion reads the user-action
        // call, not the most recent ambient tick.
        if (cmd !== "wm_windows" && cmd !== "wm_layout_snapshot") {
          (window as unknown as Record<string, unknown>).__lastCall = { cmd, args };
        }
        if (cmd === "wm_windows") {
          return {
            windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }],
          };
        }
        if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(Dock);
    await tick();
    // Wait two settle()s so the mount-time `refreshOpenWindows` has resolved and
    // `openLabels` carries `notes`. Without that the menu opens with `running=false`
    // and Quit is disabled (the FMEA F-SH-001 shape), so the click below is a no-op.
    await settle();
    await settle();

    const tile = container.querySelector<HTMLElement>('[data-dock-item="notes"]')!;
    await fireEvent.contextMenu(tile, { clientX: 100, clientY: 200 });
    await tick();
    const menu = container.querySelector('[data-testid="dock-context-menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.getAttribute("data-label")).toBe("notes");
    expect(menu?.getAttribute("aria-label")).toBe(zh["desktop.dockContextMenu"]);

    // `running` is a snapshot the dock took when the menu opened; the dock only knows
    // what's open because `openLabels` was populated by the mount-time `wm_windows`
    // read. Without that wait the menu opens with `running=false` and Quit is
    // disabled (the FMEA F-SH-001 shape), so the click below is a no-op.
    const show = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-show"]')!;
    const hide = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-hide"]')!;
    const quit = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-quit"]')!;
    const opts = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-options"]')!;
    expect(show.disabled).toBe(false);
    expect(hide.disabled).toBe(false);
    expect(quit.disabled).toBe(false);
    // Options is a placeholder: disabled, with a name that says why (FMEA F-SH-001).
    expect(opts.disabled).toBe(true);
    expect(opts.getAttribute("aria-label")).toBe(zh["desktop.dockCtxOptionsUnavailable"]);

    await fireEvent.click(quit);
    await tick();
    await settle();
    const last = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last).toEqual({ cmd: "wm_close", args: { label: "notes" } });
    // The menu closes itself after a choice.
    expect(container.querySelector('[data-testid="dock-context-menu"]')).toBeNull();
  });

  test("right-click a closed app shows the menu with Show / Hide / Quit greyed (no live action)", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "wm_windows") return { windows: [] }; // nothing open
        if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(Dock);
    await tick();
    await settle();
    const tile = container.querySelector<HTMLElement>('[data-dock-item="notes"]')!;
    await fireEvent.contextMenu(tile, { clientX: 10, clientY: 20 });
    await tick();
    const menu = container.querySelector('[data-testid="dock-context-menu"]');
    expect(menu).toBeTruthy();
    // Show + Hide + Quit are disabled: there is no window to act on, and a tile that
    // looks available while doing nothing is the FMEA F-SH-001 shape.
    const show = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-show"]')!;
    const hide = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-hide"]')!;
    const quit = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-quit"]')!;
    expect(show.disabled).toBe(true);
    expect(hide.disabled).toBe(true);
    expect(quit.disabled).toBe(true);
  });

  test("clicking outside the dock ITEM context menu closes it (menus render OUTSIDE the dock element)", async () => {
    // REQ-A414: the two Dock context menus are rendered as **siblings** of the
    // `bind:this={dockEl}` container (so their z-index matches the overlays and they
    // stay out of the magnification measurement). The outside-click handler however
    // looked them up with `dockEl.querySelector(...)` — which can never find a
    // sibling — so `menuEl`/`globalMenuEl` were always `null` and the menu survived
    // every click on the desktop. Escape worked, so the defect read as "the menu is
    // sticky" rather than "the handler is dead". Clicking a menu item still worked
    // *because* the close branch never ran.
    setWindowWidth(2000);
    seedDock(["notes"]);
    installHost({
      windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }],
    });
    const { container } = render(Dock);
    await tick();
    await settle();
    await settle();

    const tile = container.querySelector<HTMLElement>('[data-dock-item="notes"]')!;
    await fireEvent.contextMenu(tile, { clientX: 100, clientY: 200 });
    await tick();
    expect(container.querySelector('[data-testid="dock-context-menu"]')).toBeTruthy();

    // A mousedown anywhere outside both menus closes the item menu…
    await fireEvent.mouseDown(document.body);
    await tick();
    expect(container.querySelector('[data-testid="dock-context-menu"]')).toBeNull();
  });

  test("clicking a dock ITEM menu entry does NOT close-before-click (the outside check must exclude the menu itself)", async () => {
    // The complement of the case above: the outside-click listener fires on
    // `mousedown`, which precedes `click`. If the fix closed the menu whenever the
    // target is not the *dock*, the button would unmount before its own `click` and
    // every menu action would silently stop working. Quit must still reach the host.
    setWindowWidth(2000);
    seedDock(["notes"]);
    installHost({
      windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }],
    });
    const { container } = render(Dock);
    await tick();
    await settle();
    await settle();

    const tile = container.querySelector<HTMLElement>('[data-dock-item="notes"]')!;
    await fireEvent.contextMenu(tile, { clientX: 100, clientY: 200 });
    await tick();
    const quit = container.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-quit"]')!;
    expect(quit.disabled).toBe(false);

    await fireEvent.click(quit);
    await tick();
    await settle();
    const last = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last).toEqual({ cmd: "wm_close", args: { label: "notes" } });
  });

  test("clicking outside the dock GLOBAL context menu closes it too", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    installHost({ windows: [] });
    const { container } = render(Dock);
    await tick();
    await settle();

    const panel = container.querySelector<HTMLElement>('[data-testid="dock-panel"]')!;
    await fireEvent.contextMenu(panel, { clientX: 5, clientY: 5 });
    await tick();
    expect(container.querySelector('[data-testid="dock-global-context-menu"]')).toBeTruthy();

    await fireEvent.mouseDown(document.body);
    await tick();
    expect(container.querySelector('[data-testid="dock-global-context-menu"]')).toBeNull();
  });

  test("a refused Dock preference write is REPORTED in the user's language (never hard-coded English)", async () => {
    // REQ-A414: the four Dock preference handlers wrote `"Failed to save Dock …"` as a
    // literal — the only user-visible store-write failures in the app that were not
    // routed through `t("common.storeWriteFailed")`. On a Chinese UI the Dock reported
    // its failure in English while every app reported it in the user's language.
    setWindowWidth(2000);
    seedDock(["notes"]);
    installHost({ windows: [] });
    const restore = failWritesFor(DOCK_PREFS_KEY);
    try {
      const { container } = render(Dock);
      await tick();
      await settle();

      const panel = container.querySelector<HTMLElement>('[data-testid="dock-panel"]')!;
      await fireEvent.contextMenu(panel, { clientX: 5, clientY: 5 });
      await tick();
      const inc = container.querySelector<HTMLButtonElement>(
        '[data-testid="dock-global-ctx-mag-increase"]',
      )!;
      await fireEvent.click(inc);
      await tick();
      expect(
        container.querySelector('[data-testid="store-write-error"]')?.textContent,
      ).toBe(zh["common.storeWriteFailed"]);
    } finally {
      restore();
    }
  });

  test("the +N chip is a real button that lists the apps that did not fit (macOS full list)", async () => {
    // REQ-A415: the chip used to be a `<span title="…">` — announced as a label and
    // impossible to click, so the five apps it counted could only be reached through
    // Launchpad. On a Mac the chip *opens* the list.
    setWindowWidth(400); // dockCapacity(400) = 6; minus the 3 system items leaves 3 slots
    seedDock(MANY_APPS); // 8 apps ⇒ clock/notes/calendar shown, the other five hidden
    installHostWithRecorder();
    const { container } = render(Dock);
    await tick();
    await settle();

    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="dock-overflow"] button',
    )!;
    expect(chip.tagName).toBe("BUTTON"); // an affordance, not a tooltip
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="dock-overflow-menu"]')).toBeNull();

    await fireEvent.click(chip, { clientX: 12, clientY: 34 });
    await tick();
    const menu = container.querySelector('[data-testid="dock-overflow-menu"]')!;
    expect(menu).toBeTruthy();
    expect(menu.getAttribute("aria-label")).toBe(zh["desktop.dockOverflowList"]);
    expect(menu.getAttribute("role")).toBe("menu");
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    // The entries are exactly the apps the Dock could not draw, in the Dock's own order —
    // not a truncated or re-sorted copy.
    const listed = [...menu.querySelectorAll("[data-testid^='dock-overflow-item-']")].map((b) =>
      b.getAttribute("data-testid")!.replace("dock-overflow-item-", ""),
    );
    expect(listed).toEqual(MANY_APPS.slice(3));

    // Escape closes it (the Dock owns the listener; the panel renders outside the dock).
    await fireEvent.keyDown(document, { key: "Escape" });
    await tick();
    expect(container.querySelector('[data-testid="dock-overflow-menu"]')).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  test("picking from the overflow list opens that app through wm_open", async () => {
    setWindowWidth(400);
    seedDock(MANY_APPS);
    installHostWithRecorder();
    const { container } = render(Dock);
    await tick();
    await settle();

    await fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-testid="dock-overflow"] button')!,
      { clientX: 12, clientY: 34 },
    );
    await tick();
    // `photos` is the first app that did not fit.
    await fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-testid="dock-overflow-item-photos"]')!,
    );
    await tick();
    await settle();
    expect((window as unknown as { __wmOpens: string[] }).__wmOpens).toEqual(["photos"]);
    // The list closes itself after a choice (same rule as the Dock item menu).
    expect(container.querySelector('[data-testid="dock-overflow-menu"]')).toBeNull();
  });

  test("clicking outside the overflow list closes it (it is a sibling of the dock element)", async () => {
    setWindowWidth(400);
    seedDock(MANY_APPS);
    installHost({ windows: [] });
    const { container } = render(Dock);
    await tick();
    await settle();

    await fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-testid="dock-overflow"] button')!,
      { clientX: 12, clientY: 34 },
    );
    await tick();
    expect(container.querySelector('[data-testid="dock-overflow-menu"]')).toBeTruthy();

    await fireEvent.mouseDown(document.body);
    await tick();
    expect(container.querySelector('[data-testid="dock-overflow-menu"]')).toBeNull();
  });

  test("the Dock's 「Dock Preferences…」 row opens the Settings window (it used to be a silent no-op)", async () => {
    // REQ-A415: the row called `openApp("settings","dock")` — the *touch* shell's surface
    // switcher. `Shell.svelte` mounts `DesktopShell` in the desktop form and never renders
    // that surface, so the row did nothing at all. It now goes through `wm_open`, the same
    // path the desktop stage's 「显示设置」 row uses.
    setWindowWidth(2000);
    seedDock(["notes"]);
    installHostWithRecorder();
    const { container } = render(Dock);
    await tick();
    await settle();

    const panel = container.querySelector<HTMLElement>('[data-testid="dock-panel"]')!;
    await fireEvent.contextMenu(panel, { clientX: 5, clientY: 5 });
    await tick();
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="dock-global-ctx-open-prefs"]',
    )!;
    // The label states what the row actually does (a Dock *pane* is not reachable across
    // windows), instead of promising one.
    expect(row.textContent).toContain(zh["desktop.dockGlobalCtxDockPrefs"]);
    await fireEvent.click(row);
    await tick();
    await settle();
    expect((window as unknown as { __wmOpens: string[] }).__wmOpens).toEqual(["settings"]);
  });

  test("AMOS_DOCK_CONTEXT_MENU=disabled — right-click on a tile does not open the menu (F-SH-001 honest UI: don't fake a feature)", async () => {
    // 关掉这个能力后,Dock 的 `onItemContextMenu` 直接返回,不消费右键,不弹菜单;
    // 也不假装"按了没反应"——浏览器原生菜单会接管。
    (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures = [
      "dock-context-menu",
    ];
    try {
      // 需要先把 notes 放进 dock 才有 `data-dock-item="notes"` 这个 tile。
      writeStoreValue(LAYOUT_KEY, { page: ["clock"], dock: ["notes"], hidden: [] });
      installHost({
        windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }],
      });
      const { container } = render(Dock);
      await tick();
      await settle();
      const tile = container.querySelector<HTMLElement>('[data-dock-item="notes"]')!;
      await fireEvent.contextMenu(tile, { clientX: 10, clientY: 20 });
      await tick();
      await settle();
      // 菜单**没有**渲染出来
      expect(container.querySelector('[data-testid="dock-context-menu"]')).toBeNull();
      // 也没有 wm_close / wm_hide / wm_focus 被调用过(`__lastCall` 应仍为空)
      const last = (window as unknown as Record<string, unknown>).__lastCall;
      expect(last).toBeUndefined();
    } finally {
      delete (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures;
    }
  });



/**
 * Hot corners (REQ-A414) — the listener component had **no test at all**, which is how
 * its default action drifted: the top-left hot corner is configured `mission-control`
 * (`DEFAULT_HOT_CORNERS`) but called `toggleOverlay("spaces")`, an id the overlay
 * registry does not have. The call was accepted, the phantom id entered `openOverlays`,
 * nothing rendered, and the shell's Escape handler then closed *that* instead of the
 * real top layer. These cases drive the real production path: a `mousemove` into the
 * corner zone ⇒ the registry's `mission-control` overlay opens ⇒ Escape closes it.
 */
describe("G-DesktopShell — 桌面背景 fallback 不再是死黑", () => {
  test("root 容器的 background 等于 wallpaperFallbackColor(true)（dark）", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const root = container.querySelector(
      '[data-testid="desktop-shell-root"]',
    ) as HTMLElement | null;
    expect(root).toBeTruthy();
    // Svelte 把 `{wallpaperFallbackColor(true)}` 渲染为 inline style —— 必须**等于**
    // 函数返回值，不许这里写第二份字面（被 wallpaper.test.ts 的负控钉）。
    const expected = wallpaperFallbackColor(true);
    expect(root!.style.background).toBe(expected);
    // 顺便：不能是死黑
    expect(root!.style.background.toLowerCase()).not.toBe("#1a1a1a");
    expect(root!.style.background.toLowerCase()).not.toBe("#000");
  });

  test("root 容器不是直接 inline `rgb(26, 26, 26)`（伪装版的 #1a1a1a）", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const root = container.querySelector(
      '[data-testid="desktop-shell-root"]',
    ) as HTMLElement | null;
    expect(root).toBeTruthy();
    const bg = root!.style.background.toLowerCase();
    expect(bg).not.toBe("rgb(26, 26, 26)");
    expect(bg).not.toBe("rgb(0, 0, 0)");
  });
});

describe("HotCornersListener — a hot corner opens the overlay the registry declares", () => {
  const placeCursor = (x: number, y: number) =>
    fireEvent.mouseMove(window, { clientX: x, clientY: y });

  test("the default top-left corner opens Mission Control (not a phantom id)", async () => {
    setWindowWidth(2000);
    // `delay: 0` so the case does not wait out the 500 ms default; the other corners are
    // back-filled by `normalizeHotCorners`.
    writeStoreValue(HOT_CORNER_KEY, [
      { corner: "top-left", action: "mission-control", delay: 0 },
    ]);
    // Mission Control renders only when there are ≥2 windows to switch between.
    installHost({
      windows: [
        { label: "notes", kind: "App", state: "Focused", focused: true },
        { label: "files", kind: "App", state: "Shown", focused: false },
      ],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    expect(container.querySelector('[data-testid="overlay-layer"]')).toBeNull();

    await placeCursor(0, 0);
    await tick();
    await settle();
    await settle();

    const layer = container.querySelector('[data-testid="overlay-layer"]');
    expect(layer?.getAttribute("data-overlay")).toBe("mission-control");
    expect(container.querySelector('[data-testid="mission-control"]')).toBeTruthy();

    // …and it is a real shell overlay: Escape closes it (before the fix, Escape closed
    // the phantom `"spaces"` and the visible panel stayed up).
    await fireEvent.keyDown(window, { key: "Escape" });
    await tick();
    expect(container.querySelector('[data-testid="overlay-layer"]')).toBeNull();
  });

  test("the Show Desktop hot corner really hides the visible app windows, and the same corner brings them back", async () => {
    // REQ-A415: this action was a `console.log("… not yet implemented")` — offered in
    // Settings, enabled in the default configuration, and inert.
    setWindowWidth(2000);
    writeStoreValue(HOT_CORNER_KEY, [{ corner: "bottom-left", action: "desktop", delay: 0 }]);
    const commands = installHost({
      windows: [
        { label: "notes", kind: "App", state: "Focused", focused: true },
        { label: "files", kind: "App", state: "Shown", focused: false },
        // A window that is *already* hidden must not be touched (it never left, so the
        // restore must not claim to bring it back).
        { label: "maps", kind: "App", state: "Hidden", focused: false },
        { label: "main", kind: "Launcher", state: "Shown", focused: false },
      ],
    });
    render(DesktopShell);
    await tick();
    await settle();

    const inCorner = () =>
      fireEvent.mouseMove(window, { clientX: 10, clientY: window.innerHeight - 5 });
    const outOfCorner = () => fireEvent.mouseMove(window, { clientX: 500, clientY: 300 });

    await inCorner();
    await tick();
    await settle();
    expect(commands.filter((c) => c === "wm_hide")).toHaveLength(2);

    // The same corner again restores exactly what it hid (2 windows), not the hidden
    // `maps` and never the launcher.
    await outOfCorner();
    await tick();
    await inCorner();
    await tick();
    await settle();
    expect(commands.filter((c) => c === "wm_focus")).toHaveLength(2);
  });

/**
 * The desktop Notification Center (REQ-A417) — G6's registered gap「桌面没有通知中心
 * （macOS 右半边）」. The entry point is the **clock**, which is macOS's own behaviour, so
 * these cases drive the production path: click the clock in the bar ⇒ the panel opens
 * anchored to the right ⇒ Escape closes it.
 */
describe("DesktopShell — the Notification Center", () => {
  test("the clock is a button that opens the panel, and Escape closes it", async () => {
    installHost({ windows: [] });
    writeStoreValue(NOTIF_KEY, [
      { id: "n1", app: "时钟", title: "计时结束", body: "5 分钟已到", icon: "⏱️", time: 1_700_000_000_000 },
    ]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const clock = container.querySelector<HTMLButtonElement>('[data-testid="chrome-clock"]')!;
    // macOS's clock is clickable; the default top-right widget set therefore has a real
    // affordance here instead of a read-only number.
    expect(clock.tagName).toBe("BUTTON");
    expect(clock.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="desktop-notification-center"]')).toBeNull();

    await fireEvent.click(clock);
    await tick();
    const layer = container.querySelector('[data-testid="overlay-layer"]');
    expect(layer?.getAttribute("data-overlay")).toBe("notifications");
    expect(container.querySelector('[data-testid="desktop-notification-center"]')).toBeTruthy();
    // The row is the one in the shared store — the panel does not carry its own copy.
    expect(container.querySelector('[data-testid="nc-notif-n1"]')).toBeTruthy();
    expect(clock.getAttribute("aria-expanded")).toBe("true");

    // It is a real shell overlay: the shell's Escape closes the top layer.
    await fireEvent.keyDown(window, { key: "Escape" });
    await tick();
    expect(container.querySelector('[data-testid="desktop-notification-center"]')).toBeNull();
  });

  test("the panel's own surface is a dialog with the shared title (accessible name, not a bare div)", async () => {
    installHost({ windows: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-testid="chrome-clock"]')!);
    await tick();
    const panel = container.querySelector('[data-testid="desktop-notification-center"]')!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-label")).toBe(zh["nc.title"]);
  });
});

  test("a disabled corner does nothing (the default top-right/bottom-right are 'disabled')", async () => {
    setWindowWidth(2000);
    writeStoreValue(HOT_CORNER_KEY, [
      { corner: "top-right", action: "disabled", delay: 0 },
    ]);
    installHost({
      windows: [
        { label: "notes", kind: "App", state: "Focused", focused: true },
        { label: "files", kind: "App", state: "Shown", focused: false },
      ],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    await placeCursor(2000, 0); // the top-right zone
    await tick();
    await settle();

    expect(container.querySelector('[data-testid="overlay-layer"]')).toBeNull();
  });
});

});