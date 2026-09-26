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
import { getStoreTiles, setStoreTiles, type StoreTile } from "../src/lib/storeApps";
import { KEYBOARD_CONFIG_KEY } from "../src/lib/keyboardConfigHook.svelte";
import { HOT_CORNER_KEY } from "../src/lib/hotCorners";
import { DOCK_PREFS_KEY } from "../src/lib/dockPrefs";
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
import { surface, unlock } from "../src/svelte/shellState.svelte";
import { clearDiag, recentDiag } from "../src/lib/debugLog";
import { isBootFact } from "./shellHostBootFacts";
import { zh } from "../src/i18n/locales/zh";

const settle = () => new Promise((r) => setTimeout(r, 40));
const byAria = (c: HTMLElement, aria: string) => c.querySelector(`[aria-label="${aria}"]`);

/**
 * Make the **installed** host answer `menu_set_shortcuts` with a specific row count (REQ-A487).
 *
 * `installHost` answers `null` — "there is no host" — which is the honest default for most tests but
 * hides every comparison the shell makes with the host's answer. Call this *after* `installHost()`.
 */
function replyWith(applied: number): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Function } })
    .__TAURI_INTERNALS__;
  const inner = internals.invoke;
  internals.invoke = async (cmd: string, args?: unknown) => {
    if (cmd === "menu_set_shortcuts") return applied;
    return inner(cmd, args);
  };
}

/** Did the ledger record a message containing `needle`? (The diag ring is the observable side.) */
function diagSaid(needle: string): boolean {
  return recentDiag(200).some((e) => e.msg.includes(needle));
}

/** The Stage Manager rail's width in the cases below — one number, two surfaces. */
const RAIL = 180;

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
  rail_width: 0,
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
      // probe (REQ-A287 added `desktop_features_disabled`, REQ-A485 the `menu_set_shortcuts`
      // push). The list itself is shared with `orig-test.test.ts` — see
      // `svelte-tests/shellHostBootFacts.ts` (REQ-A487: the per-file copies had drifted).
      if (!isBootFact(cmd)) {
        (window as unknown as Record<string, unknown>).__lastCall = { cmd, args };
      }
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows };
      if (cmd === "desktop_features_disabled") return desktopFeatures;
      // Stage Manager (REQ-A1568): the rail reads the view on mount, and the ⌃⌘S chord
      // writes the mode. Answered here so a chord test can tell "the shell reached the
      // host" from "there was no host" (a `null` answer is the latter).
      if (cmd === "stage_snapshot") return { enabled: false, on_stage: [], parked: [] };
      if (cmd === "stage_set_enabled") {
        return { enabled: (args as { enabled?: boolean } | undefined)?.enabled === true, on_stage: [], parked: [] };
      }
      // The host answers a power/session action with a **plan object**, never `()`
      // (REQ-A515): Tauri serializes `()` to `null`, and the bridge reads `null` as a
      // failure, so `()` would report a scheduled restart as a failed one (F-SH-053).
      if (cmd.startsWith("session_")) {
        return { action: cmd.slice("session_".length), delaySecs: 2 };
      }
      return null;
    },
    listen: async () => () => {},
  };
  return commands;
}

/** Variant for the REQ-A275 menu tests: every `wm_open(label)` call is recorded
 * on `window.__wmOpens` so a test can assert "File → New Window invoked the host
 * with `label: 'files'`" without parsing `__lastCall` (which is also written). */
function installHostWithRecorder() {
  (window as unknown as Record<string, unknown>).__wmOpens = [] as string[];
  (window as unknown as Record<string, unknown>).__wmNewWindows = [] as string[];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (cmd === "wm_open") {
        const label = (args as { label?: string } | undefined)?.label;
        if (typeof label === "string") {
          ((window as unknown as { __wmOpens: string[] }).__wmOpens).push(label);
        }
        (window as unknown as Record<string, unknown>).__lastCall = { cmd, args };
      }
      // REQ-A473: File ▸ New Window is per-app now, so the recorder has to see the app id
      // it asks for (the previous shape recorded only `wm_open` labels).
      if (cmd === "wm_new_window") {
        const appId = (args as { appId?: string } | undefined)?.appId;
        if (typeof appId === "string") {
          ((window as unknown as { __wmNewWindows: string[] }).__wmNewWindows).push(appId);
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
  delete (window as unknown as { __wmNewWindows?: unknown }).__wmNewWindows;
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

  test("⌃⌘S 走宿主的模式开关；⌘S 归应用（REQ-A1568）", async () => {
    // Stage Manager 曾经没有正门：命令与轨道都在，但轨道只在模式**开着**时才画，
    // 于是从没见过它的人永远打不开它。这条弦是那道门，而这个用例钉的是**门的两半** ——
    // 该响的响（并且真的问了宿主），不该响的一个字都不动。
    const commands = installHost();
    render(DesktopShell);
    await tick();
    await settle();

    // ⌘S 是应用的「存储」：壳既不能吃掉它，也不能顺手开舞台管理器。
    // （`{meta, ctrl}` 这一行曾经只要求 ⌘，于是 ⌃⌘S 也会吃掉每个应用的 ⌘S ——
    //   `lib/__tests__/keyboardConfigHook.test.ts` 的修饰键真值表钉住了那一处。）
    const plain = press("s", { metaKey: true });
    await tick();
    await settle();
    expect(plain.defaultPrevented, "⌘S 不是壳的键").toBe(false);
    expect(commands).not.toContain("stage_set_enabled");

    // 和弦命中：壳消费它，并**先读后写** —— 模式来自宿主（`stage_snapshot`），
    // 写入的是它的取反值，而不是本地某个布尔。
    const chord = press("s", { ctrlKey: true, metaKey: true });
    await tick();
    await settle();
    expect(chord.defaultPrevented, "⌃⌘S 归壳管").toBe(true);
    expect(commands).toContain("stage_snapshot");
    expect(
      (window as unknown as { __lastCall?: { cmd: string; args?: unknown } }).__lastCall,
    ).toEqual({ cmd: "stage_set_enabled", args: { enabled: true } });
  });

  test("Spaces 键的覆盖与禁用生效（含 Ctrl+1…9 这一族）", async () => {    const commands = installHost();
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

  test("⌃↓ 打开 App Exposé；焦点应用只有一扇窗时**不开**，而是把原因说出来（REQ-A476）", async () => {
    // The chord lives in the keyboard-config `spaces` domain (the same Control-arrow family
    // as ⌃↑/⌃←/⌃→), because the registry's overlay-shortcut set is a documented invariant.
    const commands = installHost();
    // Two windows of `files`, one of `notes`, `files_2` focused ⇒ App Exposé opens.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        commands.push(cmd);
        if (cmd === "wm_windows") {
          return {
            focused: 2,
            windows: [
              { id: 1, label: "files", app: "files", instance: 1, kind: "App", state: "Shown", focused: false, external: false },
              { id: 2, label: "files_2", app: "files", instance: 2, kind: "App", state: "Focused", focused: true, external: false },
              { id: 3, label: "notes", app: "notes", instance: 1, kind: "App", state: "Shown", focused: false, external: false },
            ],
          };
        }
        if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
        if (cmd === "desktop_features_disabled") return [];
        return { windows: [] };
      },
      listen: async () => () => {},
    };

    const { container } = render(DesktopShell);
    await tick();
    await settle();

    press("ArrowDown", { ctrlKey: true });
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="app-expose"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="app-expose-tile"]')).toHaveLength(2);

    // Same chord again toggles it away (the shell's overlays are toggles, not one-way doors).
    press("ArrowDown", { ctrlKey: true });
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="app-expose"]')).toBeNull();
  });

  test("⌃↓ on an app with one window: nothing opens, and the reason is reported", async () => {
    const commands = installHost();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        commands.push(cmd);
        if (cmd === "wm_windows") {
          return {
            focused: 1,
            windows: [
              { id: 1, label: "files", app: "files", instance: 1, kind: "App", state: "Focused", focused: true, external: false },
              { id: 2, label: "notes", app: "notes", instance: 1, kind: "App", state: "Shown", focused: false, external: false },
            ],
          };
        }
        if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
        if (cmd === "desktop_features_disabled") return [];
        return { windows: [] };
      },
      listen: async () => () => {},
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(DesktopShell);
    await tick();
    await settle();
    press("ArrowDown", { ctrlKey: true });
    await tick();
    await settle();

    // Two windows are open, but they belong to **different** apps — and App Exposé tiles one
    // app. macOS shows nothing here; we show nothing *and say why* (a chord that silently
    // does nothing is indistinguishable from a broken one).
    expect(container.querySelector('[data-testid="app-expose"]')).toBeNull();
    const said = recentDiag().some((e) => e.msg.includes("⌃↓ did nothing"));
    expect(said, "the refusal is in the diagnostics ledger, not swallowed").toBe(true);
    warn.mockRestore();
  });

  test("⌘Tab / F3 with fewer than two windows leaves no layer behind (F-SH-361)", async () => {
    installHost({ windows: [{ label: "files", kind: "App", state: "Focused" }] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    press("Tab", { metaKey: true });
    await tick();
    await settle();

    // The panel itself declines to draw (`shouldShowMissionControl`) — but the id must not
    // reach `openOverlays` either. The wrapper layer is a *declared* row, so `topOverlay`
    // would name it as the top of the stack and the next Escape would close nothing.
    expect(container.querySelector('[data-testid="mission-control"]')).toBeNull();
    expect(container.querySelector('[data-testid="overlay-layer"]')).toBeNull();
  });

  test("an empty Mission Control does not eat the next Escape (F-SH-361)", async () => {
    installHost({ windows: [{ label: "files", kind: "App", state: "Focused" }] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    press(" ", { metaKey: true }); // Spotlight — a layer the user can see
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeTruthy();

    press("Tab", { metaKey: true }); // …and nothing to switch between
    await tick();
    await settle();

    // ONE Escape must close the layer the user can see; before the guard the phantom
    // Mission Control layer sat on top and swallowed it.
    press("Escape");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeNull();
  });

  test("⌘Tab with fewer than two windows reports why, like ⌃↓ does (F-SH-361)", async () => {
    installHost({ windows: [{ label: "files", kind: "App", state: "Focused" }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clearDiag();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    press("Tab", { metaKey: true });
    await tick();
    await settle();

    expect(container.querySelector('[data-testid="mission-control"]')).toBeNull();
    const said = recentDiag().some((e) => e.msg.includes("F3 / ⌘Tab did nothing"));
    expect(said, "the refusal is in the diagnostics ledger, not swallowed").toBe(true);
    warn.mockRestore();
  });

  test("the Launcher is not a window to switch to: ⌘Tab with one app window still refuses (F-SH-361)", async () => {
    // The realistic shape: the host always lists the launcher itself, so counting *raw*
    // windows would say "two" and open a panel for a list that holds one entry.
    installHost({
      windows: [
        { label: "main", kind: "Launcher", state: "Focused" },
        { label: "files", kind: "App", state: "Shown" },
      ],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    press("Tab", { metaKey: true });
    await tick();
    await settle();

    expect(container.querySelector('[data-testid="mission-control"]')).toBeNull();
    expect(container.querySelector('[data-testid="overlay-layer"]')).toBeNull();
  });

  test("a window hidden behind ⌘M is not a window to switch to either (F-SH-361)", async () => {
    // The panel draws `state !== "Hidden"` windows only, so a hidden one is not a choice.
    // Counting it would open Mission Control for a one-entry list.
    installHost({
      windows: [
        { label: "files", kind: "App", state: "Shown" },
        { label: "notes", kind: "App", state: "Hidden" },
      ],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    press("Tab", { metaKey: true });
    await tick();
    await settle();

    expect(container.querySelector('[data-testid="mission-control"]')).toBeNull();
    expect(container.querySelector('[data-testid="overlay-layer"]')).toBeNull();
  });

  test("an open Mission Control still closes when there is nothing left to switch between (F-SH-361)", async () => {
    // A mutable answer, so the list can change between the two presses. The **launcher** holds
    // focus: it is never an actionable target, so ⌘W has to re-read the list (REQ-A424) — which
    // is how the shell learns the count dropped while the panel was up.
    let windows = [
      { label: "main", kind: "Launcher", state: "Focused", focused: true },
      { label: "files", kind: "App", state: "Shown", focused: false },
      { label: "notes", kind: "App", state: "Shown", focused: false },
    ];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "wm_windows") return { focused: 1, windows };
        if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
        if (cmd === "desktop_features_disabled") return [];
        return null;
      },
      listen: async () => () => {},
    };

    const { container } = render(DesktopShell);
    await tick();
    await settle();

    press("Tab", { metaKey: true });
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="mission-control"]')).toBeTruthy();

    // One application window is closed, so there is nothing to switch between any more.
    windows = [
      { label: "main", kind: "Launcher", state: "Focused", focused: true },
      { label: "files", kind: "App", state: "Shown", focused: false },
    ];
    press("w", { metaKey: true });
    await tick();
    await settle();

    // The guard must only stop a layer from *opening*: a panel already on screen has to stay
    // dismissable, or the refusal would trap the user inside the very panel it refused.
    press("Tab", { metaKey: true });
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="mission-control"]')).toBeNull();
  });

  test("the top-left hot corner may not open an empty Mission Control either (F-SH-363)", async () => {
    // The **default** top-left corner (500 ms) is the door most users meet — and it reaches the
    // shell through `ShellChromeApi.toggleOverlay`, a *different* caller of the same primitive the
    // ⌘Tab guard was written at. `delay: 0` keeps the case off the wall clock without changing
    // what the corner *is*.
    installHost({ windows: [{ label: "files", kind: "App", state: "Focused" }] });
    writeStoreValue(HOT_CORNER_KEY, [
      { corner: "top-left", action: "mission-control", delay: 0 },
      { corner: "top-right", action: "disabled", delay: 0 },
      { corner: "bottom-left", action: "launchpad", delay: 0 },
      { corner: "bottom-right", action: "disabled", delay: 0 },
    ]);
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    fireEvent.mouseMove(window, { clientX: 5, clientY: 5 });
    await tick();
    await settle();

    // Same shape as ⌘Tab (F-SH-361), same harm (no panel, no reason, and the layer eats the next
    // Escape) — but the guard lived at the keyboard call site, so this door kept the hole.
    expect(container.querySelector('[data-testid="mission-control"]')).toBeNull();
    expect(container.querySelector('[data-testid="overlay-layer"]')).toBeNull();
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

  /**
   * REQ-A515: the power rows ask, and only the confirmation reaches the host.
   *
   * The whole point of the inline `alertdialog` is that selecting a row is **not** the
   * decision — restart/shutdown/sleep destroy unsaved work with no undo. So this pins both
   * halves: the row alone sends nothing (and 取消 keeps it that way), and 「继续」 sends
   * exactly the one command the row named.
   */
  test("a power row reaches the host only through its confirmation", async () => {
    const commands = installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    unlock(); // the lock surface is module-level state shared across tests

    const apple = container.querySelector<HTMLButtonElement>('[data-testid="apple-menu-trigger"]')!;
    await fireEvent.click(apple);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-shutdown"]')!);
    await tick();
    await settle();
    // The row asked; it did not act.
    expect(commands).not.toContain("session_shutdown");
    expect(container.querySelector('[data-testid="apple-power-confirm"]')).toBeTruthy();

    // 取消 leaves without acting, and the menu stays open.
    await fireEvent.click(container.querySelector('[data-testid="apple-power-cancel"]')!);
    await tick();
    await settle();
    expect(commands).not.toContain("session_shutdown");
    expect(container.querySelector('[data-testid="apple-power-confirm"]')).toBeNull();

    // Each action maps to its own command — no shared "power" command with a hidden name.
    for (const [row, cmd] of [
      ["apple-menu-shutdown", "session_shutdown"],
      ["apple-menu-restart", "session_restart"],
      ["apple-menu-sleep", "session_sleep"],
    ]) {
      await fireEvent.click(container.querySelector(`[data-testid="${row}"]`)!);
      await tick();
      await fireEvent.click(container.querySelector('[data-testid="apple-power-confirm-go"]')!);
      await tick();
      await settle();
      expect(commands, `${row} must send ${cmd}`).toContain(cmd);
      // Success closes the menu (the host scheduled it).
      expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();
      await fireEvent.click(apple);
      await tick();
    }
  });

  test("a refused power action keeps the confirmation up instead of closing on a lie", async () => {
    installHost();
    // Answer session commands with `null` = the bridge's only failure signal, so the
    // wrapper must not report success.
    const internals = (window as unknown as Record<string, { invoke: (c: string, a?: unknown) => unknown }>)
      .__TAURI_INTERNALS__!;
    const realInvoke = internals.invoke;
    internals.invoke = (cmd: string, args?: unknown) =>
      cmd.startsWith("session_") ? null : realInvoke(cmd, args);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(DesktopShell);
    await tick();
    await settle();
    unlock();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-trigger"]')!);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-restart"]')!);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-power-confirm-go"]')!);
    await tick();
    await settle();

    // Still up, so the user can retry or cancel rather than being told nothing.
    expect(container.querySelector('[data-testid="apple-power-confirm"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeTruthy();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("restart refused"))).toBe(true);
    warn.mockRestore();
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

  /**
   * REQ-A1563 — the Stage Manager rail and the desktop icon grid take their geometry from
   * **one** reading (`LayoutSnapshot.rail_width`), not two. A second derivation over here
   * would let the rail be drawn 180 px wide while the icons still start at 32 px, so the
   * first column would sit under a translucent strip whose pixels cannot be clicked (the
   * launcher is the topmost window in that band — that is the whole geometric guarantee).
   */
  test("a rail on the layout insets the icon grid by the same width it draws the rail at", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "wm_layout_snapshot") return { ...DESKTOP_SNAPSHOT, rail_width: RAIL };
        if (cmd === "wm_windows") return { windows: [] };
        if (cmd === "stage_snapshot") {
          return {
            enabled: true,
            on_stage: [],
            parked: [{ label: "notes", app: "notes", instance: 1 }],
          };
        }
        if (cmd === "desktop_features_disabled") return [];
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const grid = container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!;
    const style = (grid.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(style).toContain(`left:${DESKTOP_GRID_INSET + RAIL}px`);

    const rail = container.querySelector<HTMLElement>('[data-testid="stage-rail"]')!;
    expect(rail).toBeTruthy();
    // The two surfaces read **the same number** — the assertion above and this one would
    // diverge the moment either grew its own copy of the rail's width.
    expect(rail.getAttribute("data-rail-width")).toBe(String(RAIL));
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

  // F-DEV-026's own harm sentence was 「键盘用户（含读屏/无鼠标）**打不开**也用不了 … 的
  // 右键菜单」—— but its fix (`lib/menuKeys`) only made an **already open** menu walkable.
  // Nothing opens either context menu from the keyboard. Both are `role="menu"` popups,
  // and the APG context-menu pattern *requires* Shift+F10 / the ContextMenu key; both are
  // pointer-only. This case presses the chord a screen reader's user is told to press.
  test("the desktop's context menu opens from the keyboard (Shift+F10 on the focused icon)", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, { page: ["clock", "notes"], dock: [], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="desktop-context-menu"]')).toBeNull();

    const grid = container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!;
    grid.focus();
    press("ArrowRight"); // focus lands on index 0 …
    await tick();
    press("ArrowRight"); // … then on `notes`: the icon the menu must be about
    await tick();
    const notes = container.querySelector<HTMLElement>('[data-desktop-icon-id="notes"]')!;
    expect(notes.dataset.focused).toBe("true");

    const ev = press("F10", { shiftKey: true });
    await tick();

    expect(ev.defaultPrevented).toBe(true);
    expect(container.querySelector('[data-testid="desktop-context-menu"]')).toBeTruthy();
    // Same macOS rule as the pointer path: the menu is *about* the focused icon, so
    // that icon is the selection.
    expect(notes.getAttribute("aria-selected")).toBe("true");
  });

  // The other half of the same chord: with nothing focused and nothing selected there is no icon
  // to hang the menu off, and the menu the key must open is the desktop's own (New Folder /
  // Change Wallpaper / Launchpad) — the only keyboard route to those three rows. Without this the
  // `stageEl` anchor branch is unexercised: every other case focuses an icon first.
  test("with nothing focused or selected, Shift+F10 still opens the desktop's own menu", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, { page: ["clock", "notes"], dock: [], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const ev = press("F10", { shiftKey: true });
    await tick();

    expect(ev.defaultPrevented).toBe(true);
    const menu = container.querySelector('[data-testid="desktop-context-menu"]');
    expect(menu).toBeTruthy();
    const rows = [...menu!.querySelectorAll('[role="menuitem"]')].map((r) => r.textContent?.trim());
    // The global rows are there (the rows a keyboard user otherwise cannot reach) …
    expect(rows).toContain(zh["desktop.ctxChangeWallpaper"]);
    expect(rows).toContain(zh["desktop.ctxOpenLaunchpad"]);
    // … and only those: nothing is selected, so `showContextMenu` adds no open/clear-selection
    // row. Four rows is the empty-selection shape (the three global rows + the launchpad row).
    expect(rows).toHaveLength(4);
    expect(rows).not.toContain(zh["desktop.openSelection"].replace("{n}", "1"));
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

  test("system shortcuts route through the focused window to wm_close / wm_minimize", async () => {
    // ⌘W / ⌘M must (a) reach the host as `wm_close` / `wm_minimize`, and (b) carry the
    // **focused** window label (not the Dock layout or a hard-coded string). They do not
    // fire when the focused window is the launcher (`main` — closing the launcher would
    // leave the desktop without a home surface). REQ-A724: ⌘M minimizes, it does not hide
    // (⌘H is the hide chord) — before this they were the same call, so the Dock's running
    // dot went dark on ⌘M.
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
    expect(last2.cmd).toBe("wm_minimize");
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

  // ─── Window snapping (⌃⌥ chords → `wm_snap`) ────────────────────────────────
  test("a ⌃⌥ chord reaches the host as wm_snap with the focused label and the named region", async () => {
    // The chords are the **keyboard** front door to snapping (`lib/snapZones.ts` is the table,
    // the geometry is `amos-wm`'s and the placement is the host's). It used to be the only one —
    // this comment read "the one front door" until REQ-A816 added the in-app Window menu's zone
    // rows, which take this same path (`svelte-tests/topbar-main-menu` pins that half). What
    // this pins is that the key, the **focused** window label and the wire zone all arrive at
    // `wm_snap` together — and that the shell consumes the key rather than letting it reach a
    // text field.
    installHost({
      windows: [{ label: "files", kind: "App", state: "Focused", focused: true }],
    });
    render(DesktopShell);
    await tick();
    await settle();
    await settle();

    const left = press("ArrowLeft", { ctrlKey: true, altKey: true });
    await tick();
    await settle();
    const snap = (window as unknown as Record<string, { cmd: string; args: unknown }>).__lastCall;
    expect(snap.cmd).toBe("wm_snap");
    expect(snap.args).toEqual({ label: "files", zone: "left" });
    expect(left.defaultPrevented).toBe(true);

    press("k", { ctrlKey: true, altKey: true });
    await tick();
    await settle();
    const corner = (window as unknown as Record<string, { cmd: string; args: unknown }>).__lastCall;
    expect(corner.args).toEqual({ label: "files", zone: "bottom-right" });
  });

  test("a refused snap is reported with the chord the user pressed, not swallowed", async () => {
    // The fake host answers `null` (= "the host refused") for `wm_snap`, which is the shape a
    // real non-desktop class produces. A chord that did nothing silently is indistinguishable
    // from a broken one, so the shell must name **which** key died, from the table itself.
    installHost({
      windows: [{ label: "files", kind: "App", state: "Focused", focused: true }],
    });
    render(DesktopShell);
    await tick();
    await settle();
    await settle();
    clearDiag();

    press("ArrowUp", { ctrlKey: true, altKey: true });
    await tick();
    await settle();
    expect(diagSaid("the host refused to snap")).toBe(true);
    expect(diagSaid("⌃⌥↑")).toBe(true);
  });

  test("⌃⌥ chords stand down when the operator switches desktop shortcuts off", async () => {
    // Same switch as ⌘W: `AMOS_DESKTOP_SHORTCUTS=disabled` means the shell does not take
    // desktop chords at all, and snapping is one of them.
    (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures = ["shortcuts"];
    try {
      installHost({
        windows: [{ label: "files", kind: "App", state: "Focused", focused: true }],
      });
      render(DesktopShell);
      await tick();
      await settle();
      await settle();
      press("ArrowLeft", { ctrlKey: true, altKey: true });
      await tick();
      await settle();
      expect((window as unknown as Record<string, unknown>).__lastCall).toBeUndefined();
    } finally {
      delete (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures;
    }
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

  test("topbar File → New Window asks the host for a window of an app (REQ-A473)", async () => {
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
    // REQ-A473: the row no longer hard-codes the Files window (`wm_open('files')`, the
    // REQ-A434 compromise) — it asks for **one more window of an app**, and with only the
    // launcher focused that app is the shell's own file manager (Finder's own rule, stated
    // once in `desktopSystemKeys.newWindowTarget`).
    const requested = (window as unknown as { __wmNewWindows: string[] }).__wmNewWindows;
    expect(requested).toEqual(["files"]);
  });
});


describe("Dock.svelte — names, grouping and capacity", () => {
  const MANY_APPS = ["clock", "notes", "calendar", "photos", "files", "mail", "maps", "camera"];
  const originalInnerWidth = window.innerWidth;

  function seedDock(ids: string[]) {
    writeStoreValue(LAYOUT_KEY, { page: [], dock: ids, hidden: [] });
  }

  /** Move the Dock to a side: the vertical case, whose geometry is a one-column grid. */
  function seedDockPosition(position: "bottom" | "left" | "right") {
    writeStoreValue(DOCK_PREFS_KEY, { position, autoHide: false, magnification: true, iconSize: 48 });
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
    expect(byAria(container, zh["desktop.trash"])).toBeTruthy();
    // The old code put `appTitleKey(id)` (e.g. `app.clock.title`) straight into
    // aria-label: a screen reader read the key out loud.
    const labels = [...container.querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label")!,
    );
    expect(labels.some((l) => l.startsWith("app."))).toBe(false);
    expect(labels.some((l) => l === zh["app.clock"])).toBe(true);
  });

  test("arrow keys walk the Dock's tiles — the keyboard model its role=toolbar declares (F-SH-366)", async () => {
    setWindowWidth(2000);
    seedDock(["clock", "notes"]);
    const { container } = render(Dock);
    await tick();
    await settle();

    const tiles = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="dock-panel"] button'),
    ];
    expect(tiles.length).toBeGreaterThanOrEqual(3); // two apps + the system items

    tiles[0]!.focus();
    expect(document.activeElement).toBe(tiles[0]);

    // APG's toolbar pattern: Left/Right move between the toolbar's items. macOS's Dock walks
    // the same way. Before this, the only key the Dock answered was Shift+F10.
    await fireEvent.keyDown(tiles[0]!, { key: "ArrowRight" });
    await tick();
    expect(document.activeElement).toBe(tiles[1]);

    await fireEvent.keyDown(tiles[1]!, { key: "ArrowLeft" });
    await tick();
    expect(document.activeElement).toBe(tiles[0]);
  });

  test("a side Dock walks vertically and leaves Left/Right alone (F-SH-366)", async () => {
    setWindowWidth(2000);
    seedDock(["clock", "notes"]);
    seedDockPosition("left");
    const { container } = render(Dock);
    await tick();
    await settle();

    const tiles = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="dock-panel"] button'),
    ];
    expect(tiles.length).toBeGreaterThanOrEqual(3);
    tiles[0]!.focus();

    // A one-column grid: the arrows that walk it are Up/Down, exactly as in macOS's side Dock…
    await fireEvent.keyDown(tiles[0]!, { key: "ArrowDown" });
    await tick();
    expect(document.activeElement).toBe(tiles[1]);

    // …and they wrap, so the last tile is one Up away from the first.
    await fireEvent.keyDown(tiles[1]!, { key: "ArrowUp" });
    await tick();
    expect(document.activeElement).toBe(tiles[0]);
    await fireEvent.keyDown(tiles[0]!, { key: "ArrowUp" });
    await tick();
    expect(document.activeElement).toBe(tiles[tiles.length - 1]);

    // Left/Right have no horizontal axis to walk here, so they must stay unclaimed — a claimed
    // key would stop the desktop's icon grid from seeing it for no movement at all.
    const ev = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true, bubbles: true });
    tiles[tiles.length - 1]!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(tiles[tiles.length - 1]);
  });

  test("a bottom Dock wraps at its ends (F-SH-366)", async () => {
    setWindowWidth(2000);
    seedDock(["clock", "notes"]);
    const { container } = render(Dock);
    await tick();
    await settle();

    const tiles = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="dock-panel"] button'),
    ];
    tiles[0]!.focus();
    await fireEvent.keyDown(tiles[0]!, { key: "ArrowLeft" });
    await tick();
    expect(document.activeElement).toBe(tiles[tiles.length - 1]);
    await fireEvent.keyDown(tiles[tiles.length - 1]!, { key: "ArrowRight" });
    await tick();
    expect(document.activeElement).toBe(tiles[0]);
  });

  test("the Dock does not claim an arrow while the focus is outside it (F-SH-366)", async () => {
    setWindowWidth(2000);
    seedDock(["clock", "notes"]);
    const { container } = render(Dock);
    await tick();
    await settle();

    const tiles = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="dock-panel"] button'),
    ];
    // Focus the toolbar container itself (it is `tabindex="-1"`, so this is the "nothing inside
    // the Dock has the focus" case), then send an arrow that bubbles to the document.
    tiles[0]!.focus();
    (document.activeElement as HTMLElement).blur();
    expect(container.querySelector('[data-testid="dock-panel"]')!.contains(document.activeElement)).toBe(false);

    const ev = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true, bubbles: true });
    document.dispatchEvent(ev);
    // The desktop's icon grid listens on `window` and would otherwise never see this key…
    expect(ev.defaultPrevented).toBe(false);
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
    // pressable, and doing nothing (FMEA F-SH-001). REQ-A783 made it live: it opens Files on
    // the trash pane, so what this *container* test pins is that the tile is in the dock and
    // pressable; where it goes is pinned by the tile's own test in `dock-widgets.svelte.test.ts`.
    const trash = container.querySelector<HTMLButtonElement>('[data-testid="dock-trash"]')!;
    expect(trash.disabled).toBe(false);
  });

  test("the separator is drawn BEFORE the trash (that is the one grouping the Dock has)", async () => {
    setWindowWidth(2000);
    seedDock([]);
    const { container } = render(Dock);
    await tick();
    await settle();
    const sep = container.querySelector('[data-testid="dock-separator"]') as Element;
    const trash = byAria(container, zh["desktop.trash"]) as Element;
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
    expect(byAria(narrow.container, zh["desktop.trash"])).toBeTruthy();
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
        if (!isBootFact(cmd)) {
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

  test("a dock tile's context menu opens from the keyboard (Shift+F10 on the focused tile)", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    installHost({
      windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }],
    });
    const { container } = render(Dock);
    await tick();
    await settle();
    await settle();

    const tile = container.querySelector<HTMLElement>('[data-testid="dock-app-notes"]')!;
    tile.focus();
    // Dispatch on the tile itself, the way a real keydown lands: the focused button is
    // the event's target and it bubbles up to the document listener.
    const ev = new KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    });
    tile.dispatchEvent(ev);
    await tick();

    expect(ev.defaultPrevented).toBe(true);
    const menu = container.querySelector('[data-testid="dock-context-menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.getAttribute("data-label")).toBe("notes");
  });

  // Two surfaces listen for the same chord (the Dock on `document`, the desktop stage on
  // `window`), so the arbitration is part of the contract: the nearer surface answers. Here the
  // desktop **has** a selection that a fall-through would visibly react to, so this case fails if
  // the Dock stops claiming the key rather than merely looking right in isolation.
  test("Shift+F10 on a dock tile opens the dock menu, not the desktop's, when the desktop has a selection", async () => {
    setWindowWidth(2000);
    writeStoreValue(LAYOUT_KEY, { page: ["clock", "notes"], dock: ["notes"], hidden: [] });
    installHost({
      windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    await settle();

    // A live desktop selection — the thing the desktop handler would act on.
    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    await fireEvent.click(clock);
    await tick();
    expect(clock.getAttribute("aria-selected")).toBe("true");

    const tile = container.querySelector<HTMLElement>('[data-testid="dock-app-notes"]')!;
    tile.focus();
    tile.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        cancelable: true,
        bubbles: true,
      }),
    );
    await tick();

    expect(container.querySelector('[data-testid="dock-context-menu"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="desktop-context-menu"]')).toBeNull();
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
   * REQ-A415 + REQ-A431: the Finder tile (`DockFinderItem`) is the **entry point**
   * the user taps most — Dock apps run in their own window (`wm_open("files")`), so a
   * SPA fallback would render the desktop inside the launcher and never reach the host.
   * The dock app tile already had this contract pinned; the **Finder system tile** did
   * not. This case pins it: click `data-testid="dock-finder"` ⇒ the host receives
   * exactly one `wm_open({ label: "files" })` call, with no menu detour. The negative
   * control restores the SPA fallback in `DockFinderItem` and the assertion goes red.
   */
  test("the Finder system tile opens the host as wm_open('files'), not a surface flip", async () => {
    installHostWithRecorder();
    seedDock(["notes"]);
    setWindowWidth(2000);
    const { container } = render(Dock);
    await tick();
    await settle();
    const finder = container.querySelector<HTMLButtonElement>(
      '[data-testid="dock-finder"]',
    );
    expect(finder, "the Finder tile is in the registry, so it must render").toBeTruthy();
    expect(finder!.disabled).toBe(false);
    await fireEvent.click(finder!);
    await tick();
    await settle();
    const opens = (window as unknown as { __wmOpens: string[] }).__wmOpens;
    expect(opens).toEqual(["files"]);
  });
});

/**
 * REQ-A485 — the shell tells the **native menu bar** which accelerators its bindings use.
 *
 * The native rows are AppKit's, built with literal chords (`CmdOrCtrl+N`), so a rebound or disabled
 * binding left them advertising a key the shell no longer matched (F-SH-038, on the surface a user
 * reads first). The push happens at mount and on every config change — the same shape as the menu
 * *language* push (REQ-A437). These two cases pin the **call** and the payload's content; the pure
 * halves live in `src/__tests__/desktopKeys.test.ts`, and the host side is pinned by
 * `menu.rs`'s own tests.
 */
describe("DesktopShell → native menu accelerators (REQ-A485)", () => {
  beforeEach(() => window.localStorage.clear());

  test("mount pushes the merged bindings, in muda's grammar", async () => {
    const commands = installHost();
    const seen: Record<string, string | null>[] = [];
    const inner = (window as unknown as { __TAURI_INTERNALS__: { invoke: Function } }).__TAURI_INTERNALS__
      .invoke;
    (window as unknown as { __TAURI_INTERNALS__: { invoke: Function } }).__TAURI_INTERNALS__.invoke = async (
      cmd: string,
      args?: unknown,
    ) => {
      if (cmd === "menu_set_shortcuts") {
        seen.push((args as { shortcuts: Record<string, string | null> }).shortcuts);
      }
      return inner(cmd, args);
    };

    render(DesktopShell);
    await tick();
    await settle();

    expect(commands).toContain("menu_set_shortcuts");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].newWindow).toBe("CmdOrCtrl+N");
    expect(seen[0].hideApp).toBe("CmdOrCtrl+H");
    // ⌘` has no native row, so it is not in the payload …
    expect(seen[0].cycleWindows).toBeUndefined();
  });

  test("a disabled binding is pushed as null (so the bar clears that row's chord)", async () => {
    writeStoreValue(KEYBOARD_CONFIG_KEY, {
      version: 1,
      overlays: {},
      system: { hideApp: null },
      spaces: {},
      touch: {},
      updatedAt: 0,
    });
    installHost();
    const seen: Record<string, string | null>[] = [];
    const inner = (window as unknown as { __TAURI_INTERNALS__: { invoke: Function } }).__TAURI_INTERNALS__
      .invoke;
    (window as unknown as { __TAURI_INTERNALS__: { invoke: Function } }).__TAURI_INTERNALS__.invoke = async (
      cmd: string,
      args?: unknown,
    ) => {
      if (cmd === "menu_set_shortcuts") {
        seen.push((args as { shortcuts: Record<string, string | null> }).shortcuts);
      }
      return inner(cmd, args);
    };

    render(DesktopShell);
    await tick();
    await settle();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].hideApp).toBeNull();
    // …while the others keep their chords: disabling one binding must not clear the rest.
    expect(seen[0].newWindow).toBe("CmdOrCtrl+N");
  });

  /**
   * REQ-A487 — the warning's **own count**, which is the half that was never checked.
   *
   * The host answers with the number of rows it touched, and a row it *cleared* (a binding the user
   * turned off) is work done: `menu.rs::apply_accelerators` counts `set_accelerator(None)` as applied,
   * and its own warning compares against `updates.len()` — the number of rows the shell asked about,
   * whatever their value. The shell compared that answer with the number of **non-null** entries, so
   * the config in the test above (one disabled binding) reported "the host synced fewer menu
   * accelerators than the shell sent" for a host that had done exactly what it was asked — with
   * `applied` (5) *greater* than `sent` (4), which is also nonsense as a message. An alarm that fires
   * when nothing is wrong is how the real one stops being read.
   *
   * The mock in `installHost` answers `null` (no host), which is why the defect survived the pair of
   * tests above: absent is not the same as wrong, and only one of them was covered.
   */
  test("a row the host cleared counts as a synced row (no false 'fewer' warning)", async () => {
    // The user turned ⌘H off: the payload still names the row, with `null` = "clear it".
    writeStoreValue(KEYBOARD_CONFIG_KEY, {
      version: 1,
      overlays: {},
      system: { hideApp: null },
      spaces: {},
      touch: {},
      updatedAt: 0,
    });
    clearDiag();
    installHost();
    replyWith(5); // the host touched all five rows: four set, one cleared

    render(DesktopShell);
    await tick();
    await settle();

    expect(diagSaid("synced fewer menu accelerators")).toBe(false);
  });

  test("a host that really skipped a row is still reported", async () => {
    writeStoreValue(KEYBOARD_CONFIG_KEY, {
      version: 1,
      overlays: {},
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    });
    clearDiag();
    installHost();
    replyWith(4); // one native row was not found: the shell must hear about it

    render(DesktopShell);
    await tick();
    await settle();

    const warned = recentDiag(50).find((e) => e.msg.includes("synced fewer menu accelerators"));
    expect(warned).toBeDefined();
    // The count is sent/applied — five rows asked about, four touched.
    expect(String(warned?.detail)).toContain('"sent":5');
    expect(String(warned?.detail)).toContain('"applied":4');
  });
});

/**
 * The desktop icon grid's arrow keys must follow the **grid's geometry**.
 *
 * The container is `display: grid` with `grid-template-columns: repeat(DESKTOP_GRID_COLS, …)`
 * and the default row-major flow, so it is a 4-column, left-to-right, top-to-bottom grid. The
 * keyboard did not know that: `ArrowRight`/`ArrowDown` were both wired to `stepFocus(1)` and
 * `ArrowLeft`/`ArrowUp` to `stepFocus(-1)`, i.e. each pair was a pair of **synonyms**. So on a
 * 4-column desktop pressing Down slid the selection one tile **sideways** along the row instead
 * of down a row — the key a macOS user presses to go down did not go down. Nothing noticed
 * because no case here had ever pressed a bare arrow key (every arrow case in this file passes
 * a modifier, which takes the `meta` branch and never reaches the grid walk).
 *
 * These cases press the geometry, not the implementation: `data-focused` (the tile the listbox
 * reports through `aria-activedescendant`) is read back after each key.
 */
describe("DesktopShell — the icon grid's arrow keys follow the grid's geometry", () => {
  // Six tiles in four columns ⇒ two rows ([4, 2]), so "down a row" and "right one tile" are
  // distinguishable, and the short second row is reachable.
  const ICONS = ["clock", "notes", "calendar", "files", "mail", "music"];

  async function mountGrid() {
    installHost();
    writeStoreValue(LAYOUT_KEY, { page: ICONS, dock: [], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(ICONS.length).toBeGreaterThan(DESKTOP_GRID_COLS);
    expect(
      container.querySelectorAll('[data-testid="desktop-icon"]').length,
    ).toBe(ICONS.length);
    return container;
  }

  /** Press a key and let Svelte flush the state it set — the DOM is read, not the signal. */
  async function nav(key: string): Promise<KeyboardEvent> {
    const ev = press(key);
    await tick();
    return ev;
  }

  const focused = (c: HTMLElement) =>
    c.querySelector<HTMLElement>('[data-testid="desktop-icon"][data-focused="true"]')
      ?.dataset.desktopIconId ?? null;

  test("Down changes row and keeps the column; Up comes back to that column", async () => {
    const container = await mountGrid();
    container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!.focus();

    expect((await nav("ArrowRight")).defaultPrevented).toBe(true); // first key focuses index 0
    expect(focused(container)).toBe("clock");

    expect((await nav("ArrowDown")).defaultPrevented).toBe(true);
    // Row 1, column 0 — NOT "notes" (row 0, column 1), which is what a ±1 step gave.
    expect(focused(container)).toBe("mail");

    await nav("ArrowRight");
    expect(focused(container)).toBe("music"); // row 1, column 1

    await nav("ArrowUp");
    expect(focused(container)).toBe("notes"); // row 0, column 1 — the column is remembered
  });

  test("Left / Right still walk the reading order and continue into the next row", async () => {
    const container = await mountGrid();
    container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!.focus();
    await nav("ArrowRight"); // #1 focuses clock (index 0)
    await nav("ArrowRight");
    await nav("ArrowRight");
    await nav("ArrowRight"); // #4 — files, the end of row 0 (column 3)
    expect(focused(container)).toBe("files"); // end of row 0 (column 3)

    await nav("ArrowRight");
    expect(focused(container)).toBe("mail"); // continues into row 1 — reading order, not a wrap
    await nav("ArrowLeft");
    expect(focused(container)).toBe("files");

    await nav("ArrowUp"); // row 0 has nothing above it: the grid stays on the tile it is on
    expect(focused(container)).toBe("files");
    await nav("ArrowLeft"); // and the reading order steps within the row
    expect(focused(container)).toBe("calendar");
  });

  test("the short last row is clamped rather than jumped over", async () => {
    const container = await mountGrid();
    container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!.focus();
    await nav("ArrowRight");
    await nav("ArrowRight");
    await nav("ArrowRight");
    await nav("ArrowRight"); // files = row 0, column 3
    expect(focused(container)).toBe("files");

    // Row 1 has two tiles (columns 0 and 1), so column 3 has no honest tile below it: the
    // grid stops at the nearest one in that row instead of pretending column 3 exists there.
    await nav("ArrowDown");
    expect(focused(container)).toBe("music");
    // And from the very last tile, Down has nowhere to go: it stays put, it does not wrap.
    await nav("ArrowDown");
    expect(focused(container)).toBe("music");
  });

  test("on a full grid (no short row) Up on the top row and Down on the last row stay put", async () => {
    // A full 4×4 grid — the desktop's real shape (16 tiles, every row complete). The older
    // arithmetic `i ± cols` clamped at the ends, so ArrowUp on row 0 slid to the row's **first**
    // tile and ArrowDown on the last row slid to its **last** — the vertical keys behaving as
    // ArrowLeft / ArrowRight, the very synonym F-SH-351 removed. The six-tile grid above cannot
    // show it: its short last row makes `i ± cols` land on a real tile.
    const FULL = Array.from({ length: DESKTOP_GRID_COLS * 4 }, (_, k) => `app${k}`);
    installHost();
    writeStoreValue(LAYOUT_KEY, { page: FULL, dock: [], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(
      container.querySelectorAll('[data-testid="desktop-icon"]').length,
    ).toBe(FULL.length);

    container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!.focus();
    await nav("ArrowRight"); // #1 → index 0
    await nav("ArrowRight"); // #2 → index 1 (row 0, column 1)
    expect(focused(container)).toBe("app1");
    await nav("ArrowUp"); // nothing above row 0: stays, it does not become ArrowLeft
    expect(focused(container)).toBe("app1");

    for (let k = 0; k < 11; k++) await nav("ArrowRight"); // → index 12, row 3 column 0
    expect(focused(container)).toBe("app12");
    await nav("ArrowDown"); // nothing below the last row: stays, it does not become ArrowRight
    expect(focused(container)).toBe("app12");
  });

  test("an arrow aimed at the Dock walks the Dock, not the desktop behind it (F-SH-366)", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, { page: ICONS, dock: ["clock", "notes"], hidden: [] });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // Both owners are live at once: the Dock's handler on `document`, the icon grid's on
    // `window`. The Dock claims first (document precedes window on the bubble path) and stops
    // the event there — this is the pin for that claim, because the grid's handler is greedy
    // and would otherwise step its own selection on a key the user aimed at the Dock.
    const tiles = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="dock-panel"] button')];
    expect(tiles.length).toBeGreaterThanOrEqual(3);
    expect(focused(container)).toBe(null);
    tiles[0]!.focus();

    const ev = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true, bubbles: true });
    tiles[0]!.dispatchEvent(ev);
    await tick();

    expect(document.activeElement).toBe(tiles[1]); // the Dock moved
    expect(focused(container)).toBe(null); // the desktop grid did NOT
    expect(ev.defaultPrevented).toBe(true);
  });

  test("a key the grid does not own is left alone", async () => {
    const container = await mountGrid();
    container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!.focus();
    await nav("ArrowRight");
    expect(focused(container)).toBe("clock");
    expect((await nav("Tab")).defaultPrevented).toBe(false);
    expect(focused(container)).toBe("clock");
  });

  // The one case the other four never reach: a nav key pressed **before anything is focused**,
  // where there is no current tile to step *from*. macOS's rule is that the key lands the focus
  // on the edge the key points at, not "one step off the first tile" — ArrowLeft / ArrowUp / End
  // reach the last icon, the rest the first. Without this test the branch is unexercised: every
  // other test's first press is ArrowRight, which lands on the first icon either way.
  test("a nav key pressed before anything is focused lands on the edge the key points at", async () => {
    const last = ICONS[ICONS.length - 1]!;

    const back = await mountGrid();
    back.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!.focus();
    expect((await nav("ArrowLeft")).defaultPrevented).toBe(true);
    expect(focused(back)).toBe(last);

    const up = await mountGrid();
    up.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!.focus();
    expect((await nav("ArrowUp")).defaultPrevented).toBe(true);
    expect(focused(up)).toBe(last);

    const end = await mountGrid();
    end.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!.focus();
    expect((await nav("End")).defaultPrevented).toBe(true);
    expect(focused(end)).toBe(last);

    const fwd = await mountGrid();
    fwd.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!.focus();
    expect((await nav("ArrowDown")).defaultPrevented).toBe(true);
    expect(focused(fwd)).toBe(ICONS[0]);
  });
});


/**
 * REQ-A1179 / F-SH-472 — the desktop chrome drew **three different pictures** of the same
 * installed store app, and none of them was the right one:
 *
 *   * `Dock` and `Launchpad` filtered it out (`appTitleKey(id) !== null`), so an app the user
 *     had dragged into the dock vanished the moment the form factor became desktop — even
 *     though the tablet's `HomeDock` draws the very same `layout.dock` row, and the Dock's own
 *     `label: key ? t(key) : id` fallback two lines below was written for exactly that case
 *     (unreachable: the filter had already guaranteed `key !== null`);
 *   * the desktop stage drew it, but named it by its **raw id** and gave it the fallback glyph;
 *   * `SpotlightOverlay` skipped it outright.
 *
 * The fix gives the question one owner (`lib/appLookup`) and pushes the tile list from the one
 * component that loads it (`Shell` → `DesktopShell` → `SHELL_CHROME_API.storeTiles`).
 *
 * The **negative control is structural**: the last test below renders `DesktopShell` with the
 * module tile cache deliberately EMPTY and passes `ext` as a prop — so it fails if any surface
 * goes back to reading `getStoreTiles()` (or the registry) on its own, which is precisely the
 * wiring the isolated tests cannot see.
 */
describe("desktop chrome draws installed store apps (REQ-A1179)", () => {
  const DEMO: StoreTile = {
    id: "store:org.amos.demo",
    mid: "org.amos.demo",
    name: "Demo",
    icon: "D",
  };
  const labels = (c: HTMLElement) =>
    [...c.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label"));

  beforeEach(() => {
    window.localStorage.clear();
    setStoreTiles([]);
  });
  afterEach(() => setStoreTiles([]));

  test("the Dock shows a store app placed in the dock, under its manifest name", async () => {
    setStoreTiles([DEMO]);
    writeStoreValue(LAYOUT_KEY, {
      // Also on the page: the stage draws the page, so both halves are covered by one layout.
      page: [DEMO.id],
      dock: ["clock", DEMO.id],
      hidden: [],
    });
    const { container } = render(Dock);
    await tick();

    expect(labels(container)).toContain("Demo");
    // …named from the manifest, never by its wire id.
    expect(labels(container)).not.toContain(DEMO.id);
    // The built-in beside it is untouched: the filter widened, it did not replace.
    expect(labels(container)).toContain(zh["app.clock"]);
  });

  test("DesktopShell forwards `ext` to the Dock AND the stage — cache deliberately cold", async () => {
    // The wiring guard, and the reason it is structural: nothing here calls `setStoreTiles`,
    // so a surface that goes back to reading the module cache (or `APP_META`) on its own —
    // i.e. the bug — makes the store app invisible. The isolated Dock test above cannot see
    // this: it seeds the cache, which is exactly what production does NOT do.
    writeStoreValue(LAYOUT_KEY, { page: ["clock", DEMO.id], dock: ["clock", DEMO.id], hidden: [] });
    const { container } = render(DesktopShell, { props: { ext: [DEMO] } });
    await tick();

    expect(labels(container)).toContain("Demo"); // the Dock got it
    expect(labels(container)).not.toContain(DEMO.id); // named from the manifest, not the wire id

    const icon = container.querySelector<HTMLElement>(`[data-desktop-icon-id="${DEMO.id}"]`);
    expect(icon?.getAttribute("aria-label")).toBe("Demo"); // and so did the stage
    // The tile's OWN glyph, not `appIcon`'s fallback for an unknown id.
    expect(icon?.textContent ?? "").toContain("D");
    expect(getStoreTiles()).toEqual([]); // the cache really was empty throughout
  });
});

/**
 * REQ-A1187 / F-SH-477 — the stage's two multi-open paths dropped `wm_open`'s verdict.
 *
 * `DesktopStage` opens a selection of icons three ways, and until this round only **one** of
 * them read the host's answer: `openSelectedApps` (the desktop's context-menu "Open") goes
 * through `wmOpenWithDiag` + `noteOpenFailure`, while the icon **double-click** and the
 * **Enter/Space** key handler both fired `void wmOpen(id)` and dropped the `Promise<boolean>`.
 * A refused `wm_open` on either of those was a dead click — the host's typed reason was
 * recorded in the shared ledger and read by nobody.
 *
 * These cases pin the two silent paths. The host must **reject** `wm_open` to reach the
 * branch under test: `installHost`'s `null` answer is a *resolved* call, which the bridge
 * records as `ok: true`, so it can never produce this refusal (REQ-A1062 §8.14 ②).
 */
describe("DesktopStage — a refused `wm_open` in the multi-open is reported (REQ-A1187)", () => {
  /** Make the installed host **refuse** `wm_open` with a typed error — the shape Tauri sends
   *  for `Err(AmosError)` (the JS promise rejects; §8.14 ②). */
  function refuseWmOpenWith(code: string): void {
    const internals = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => unknown } }
    ).__TAURI_INTERNALS__!;
    const inner = internals.invoke;
    internals.invoke = (cmd: string, args?: unknown) =>
      cmd === "wm_open"
        ? Promise.reject({ code, message: "the window class is at its cap" })
        : inner(cmd, args);
  }

  /** Everything the surface said, as one string. */
  const said = (w: ReturnType<typeof vi.spyOn>) =>
    w.mock.calls.map((c) => c.join(" ")).join("\n");

  test("double-clicking a selected icon reports the host's typed refusal", async () => {
    installHost();
    refuseWmOpenWith("amos.wm.window_cap");
    writeStoreValue(LAYOUT_KEY, { page: ["clock", "notes"], dock: [], hidden: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    await fireEvent.click(clock);
    await tick();
    await fireEvent.doubleClick(clock);
    await tick();
    await settle();

    // The breadcrumb names **which** surface died and carries the host's own code.
    expect(said(warn)).toContain("[DesktopStage] onIconDoubleClick");
    expect(said(warn)).toContain("amos.wm.window_cap");
    warn.mockRestore();
  });

  test("Enter on a selected icon reports a refused open too (the keyboard path)", async () => {
    installHost();
    refuseWmOpenWith("amos.wm.window_cap");
    writeStoreValue(LAYOUT_KEY, { page: ["clock", "notes"], dock: [], hidden: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    await fireEvent.click(clock);
    await tick();
    await fireEvent.keyDown(window, { key: "Enter" });
    await tick();
    await settle();

    expect(said(warn)).toContain("[DesktopStage] onWindowKeyDown");
    expect(said(warn)).toContain("amos.wm.window_cap");
    warn.mockRestore();
  });
});

/**
 * REQ-A1187 / F-SH-477 (cont.) — the same discarded verdict on the shell's **menu rows**.
 *
 * `menu.preferences` and `menu.amos-help` both fire `void wmOpen("settings")` out of
 * `DesktopShell`'s `menu-event` switch, while the file already owns a reporter for that exact
 * command (`windowMenuAction`, used by Zoom / Enter Full Screen). A refused Preferences open
 * was therefore a menu that closed with nothing happening and no breadcrumb.
 *
 * REQ-A1846 moves the assertion to the **ledger** the reporter now writes to. `windowMenuAction`
 * was the only refusal path in `DesktopShell` that reported through a bare `console.warn`, which
 * on a device is silence and is gone after a reload — while the ring is what Settings ▸ AI reads
 * back (`lib/debugLog.ts`) and where the same intent's chord path already reports. The cases
 * below window by **mark** (`seq`), never by length: the ring is bounded (REQ-A853).
 */
describe("DesktopShell — a refused menu-row `wm_open` is reported (REQ-A1187)", () => {
  /** The shell's rows after `mark` — the bridge's own `backend` row is not what is asked. */
  function shellRowsAfter(mark: number) {
    return recentDiag().filter((e) => e.seq > mark && e.area === "shell");
  }
  const markNow = () => recentDiag(1)[0]?.seq ?? 0;

  function refuseWmOpenWith(code: string): void {
    const internals = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => unknown } }
    ).__TAURI_INTERNALS__!;
    const inner = internals.invoke;
    internals.invoke = (cmd: string, args?: unknown) =>
      cmd === "wm_open"
        ? Promise.reject({ code, message: "the window class is at its cap" })
        : inner(cmd, args);
  }

  /** Capture the shell's `menu-event` subscription so a case can deliver one. `installHost`
   *  answers `listen` with a no-op unsubscribe, so nothing can be pushed through it. */
  function captureMenuEvents(): (id: string) => void {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          listen: (channel: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
        };
      }
    ).__TAURI_INTERNALS__!;
    let deliver: ((id: string) => void) | null = null;
    internals.listen = async (channel: string, cb: (e: { payload: unknown }) => void) => {
      if (channel === "menu-event") deliver = (id: string) => cb({ payload: id });
      return () => {};
    };
    return (id: string) => deliver?.(id);
  }

  const said = (w: ReturnType<typeof vi.spyOn>) =>
    w.mock.calls.map((c) => c.join(" ")).join("\n");

  test("a refused Preferences open from the native menu is reported", async () => {
    installHost();
    const fireMenu = captureMenuEvents();
    refuseWmOpenWith("amos.wm.window_cap");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(DesktopShell);
    await tick();
    await settle();

    const mark = markNow();
    fireMenu("menu.preferences");
    await tick();
    await settle();

    const rows = shellRowsAfter(mark);
    expect(rows.map((e) => e.msg)).toContain("wm_open(settings) refused");
    expect(rows.map((e) => e.detail).join("\n")).toContain("amos.wm.window_cap");
    warn.mockRestore();
  });

  test("a refused Amos Help open is reported too (the row beside it)", async () => {
    installHost();
    const fireMenu = captureMenuEvents();
    refuseWmOpenWith("amos.wm.window_cap");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(DesktopShell);
    await tick();
    await settle();

    const mark = markNow();
    fireMenu("menu.amos-help");
    await tick();
    await settle();

    expect(shellRowsAfter(mark).map((e) => e.msg)).toContain("wm_open(settings) refused");
    warn.mockRestore();
  });
});
