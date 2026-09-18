/**
 * shellModules.ts — the desktop chrome's **table**: which widget lives where, in
 * what order. This is the file a person adds a widget to, and the only file that
 * knows the full set (the containers read it through `modulesFor`, the tests hold
 * it to its invariants).
 *
 * What lives here and what does not: `id` / `slot` / `order` / `titleKey` /
 * `testId` / the component — plus the three facts that are *layout data* rather than
 * widget internals: `shortcuts` (which keys toggle an overlay), `separatorBefore`
 * (the dock's one divider) and `windowLabel` (which window draws a dock item's
 * running dot). Not styling (that is `lib/shellChrome.ts`), not layout (the container
 * + `lib/desktopLayout.ts`), and not data (each widget owns its own subscription).
 *
 * `order` gaps are deliberate (10, 20, 30…): inserting a widget between two others
 * must not mean renumbering the table, and the gap is where a *config-driven*
 * order would slide in later without touching the ids.
 *
 * Round 2 (REQ-A262): the table now covers **all five slots** — the bar's left group
 * (Apple menu / app name / main menu), the bar's right group, the stage clock, the
 * dock's system items and the three overlays — and the overlay rows are the shell's
 * **shortcut list** (see `DesktopShell.svelte`: the key handler matches the event against the
 * **merged** bindings — this table's defaults plus the user's keyboard settings
 * (`mergeOverlayBindings`) — so the shell does not know F4 from ⌘Space by heart).
 */
import type { ShellModule } from "../lib/shellModule";
import BatteryWidget from "./modules/BatteryWidget.svelte";
import ClockWidget from "./modules/ClockWidget.svelte";
import ControlCenterButton from "./modules/ControlCenterButton.svelte";
import ControlCenter from "./ControlCenter.svelte";
import DockFinderItem from "./modules/DockFinderItem.svelte";
import DockLaunchpadItem from "./modules/DockLaunchpadItem.svelte";
import DockTrashItem from "./modules/DockTrashItem.svelte";
import LaunchpadTrigger from "./modules/LaunchpadTrigger.svelte";
import RadiosWidget from "./modules/RadiosWidget.svelte";
import SpotlightTrigger from "./modules/SpotlightTrigger.svelte";
import StageClock from "./modules/StageClock.svelte";
import TopbarAppleMenu from "./modules/TopbarAppleMenu.svelte";
import TopbarAppName from "./modules/TopbarAppName.svelte";
import TopbarMainMenu from "./modules/TopbarMainMenu.svelte";
import Launchpad from "./Launchpad.svelte";
import MissionControl from "./MissionControl.svelte";
import SpotlightOverlay from "./SpotlightOverlay.svelte";
import SpacesPanel from "./SpacesPanel.svelte";

/**
 * Every chrome widget, in registry order (`order` decides what a container draws).
 *
 * The right-hand group is the bar's original set, and the **order matches the bar
 * that shipped** — Launchpad, Spotlight, control centre, radios, clock, battery
 * (`order` 10…60). The left group was still inlined in the bar's template after
 * round 1; it is three widgets now, in the same left-to-right order (Apple menu, app
 * name, main menu).
 */
export const SHELL_MODULES: ShellModule[] = [
  // ── 顶栏左侧：Apple 菜单 / 当前 app 名 / 主菜单（macOS 语义的一体三件）─────────
  {
    id: "apple-menu",
    slot: "topbar-left",
    order: 10,
    titleKey: "desktop.appleMenu",
    testId: "menu-apple",
    component: TopbarAppleMenu,
  },
  {
    id: "app-name",
    slot: "topbar-left",
    order: 20,
    titleKey: "desktop.currentApp",
    testId: "menu-app-name",
    component: TopbarAppName,
  },
  {
    id: "main-menu",
    slot: "topbar-left",
    order: 30,
    titleKey: "desktop.mainMenu",
    testId: "menu-main",
    component: TopbarMainMenu,
  },

  // ── 顶栏右侧：原样搬进来的六个挂件（顺序与改造前逐一对应）────────────────────
  {
    id: "launchpad-trigger",
    slot: "topbar-right",
    order: 10,
    titleKey: "desktop.launchpad",
    testId: "chrome-launchpad",
    component: LaunchpadTrigger,
  },
  {
    id: "spotlight-trigger",
    slot: "topbar-right",
    order: 20,
    titleKey: "desktop.spotlight",
    testId: "chrome-spotlight",
    component: SpotlightTrigger,
  },
  {
    id: "control-center",
    slot: "topbar-right",
    order: 30,
    titleKey: "desktop.controlCenter",
    testId: "chrome-control-center",
    component: ControlCenterButton,
  },
  {
    id: "radios",
    slot: "topbar-right",
    order: 40,
    titleKey: "a11y.networkStatus",
    testId: "chrome-radios",
    component: RadiosWidget,
  },
  {
    id: "clock",
    slot: "topbar-right",
    order: 50,
    titleKey: "desktop.clock",
    testId: "chrome-clock",
    component: ClockWidget,
  },
  {
    id: "battery",
    slot: "topbar-right",
    order: 60,
    titleKey: "a11y.batteryLevel",
    testId: "chrome-battery",
    component: BatteryWidget,
  },

  // ── 舞台：桌面右上角的时钟（原来是 DesktopStage 模板里的一段）────────────────
  {
    id: "desktop-clock",
    slot: "stage",
    order: 10,
    titleKey: "desktop.clock",
    testId: "stage-clock",
    component: StageClock,
  },

  // ── Dock：系统项（用户 app 由 Dock 容器按 home layout 铺，不在这张表里）──────
  {
    id: "dock-launchpad",
    slot: "dock",
    order: 10,
    titleKey: "desktop.launchpad",
    testId: "dock-launchpad",
    component: DockLaunchpadItem,
  },
  {
    id: "dock-finder",
    slot: "dock",
    order: 20,
    titleKey: "desktop.finder",
    testId: "dock-finder",
    // 「正在运行」白点来自这个窗口标签——模块 id（`dock-finder`）不是窗口名。
    windowLabel: "files",
    component: DockFinderItem,
  },
  {
    id: "dock-trash",
    slot: "dock",
    order: 30,
    titleKey: "desktop.trashUnavailable",
    testId: "dock-trash",
    separatorBefore: true,
    component: DockTrashItem,
  },

  // ── 浮层：**这张表就是快捷键表**（F4 / ⌘Space / F3 / ⌘Tab）──────────────────
  {
    id: "launchpad",
    slot: "overlay",
    order: 10,
    titleKey: "desktop.launchpad",
    testId: "launchpad-overlay",
    // Apple 键盘：F4 打开启动台。
    shortcuts: [{ key: "F4" }],
    component: Launchpad,
  },
  {
    id: "spotlight",
    slot: "overlay",
    order: 20,
    titleKey: "desktop.spotlight",
    testId: "spotlight-overlay",
    shortcuts: [{ key: "Space", meta: true }],
    component: SpotlightOverlay,
  },
  {
    id: "mission-control",
    slot: "overlay",
    order: 30,
    titleKey: "desktop.missionControl",
    testId: "mission-control",
    // macOS 一个动作有两个入口：F3（Mission Control 键）与 ⌘Tab（应用切换器）。
    shortcuts: [{ key: "F3" }, { key: "Tab", meta: true }],
    component: MissionControl,
  },
  {
    id: "control-center-panel",
    slot: "overlay",
    order: 40,
    titleKey: "desktop.controlCenter",
    testId: "control-center-panel",
    // No `shortcuts`: macOS has no default key for Control Center, and inventing one would
    // be a binding nobody asked for. This row is also what proves the field is optional.
    component: ControlCenter,
  },
  /**
   * SpacesPanel — virtual-desktop manager. Its GLOBAL entry shortcut is **the
   * Ctrl+↑ documented in the macOS Spaces spec** (open the panel from anywhere),
   * AND IT MUST NOT LIVE HERE: the chrome registry only owns the four launch
   * shortcuts documented at the top of the overlay block (F4 / ⌘Space / F3 /
   * ⌘Tab). Putting more in here would (a) break the doc-vs-code invariant the
   * shellModule tests pin (`["F3", "F4", "Meta+Space", "Meta+Tab"]`) and
   * (b) hijack Ctrl+ArrowLeft / Ctrl+ArrowRight from any text editor the user
   * is typing in.
   *
   * The Ctrl+↑ binding is **not owned here** either: it lives in the keyboard
   * config's `spaces` domain (`SPACES_DEFAULTS.spacesPanel`, overridable or
   * disable-able from the keyboard settings page) and `DesktopShell` dispatches it
   * from the **merged** `bindings.spaces` — so the registry stays a four-entry
   * launch list while the panel still has a documented global key.
   *
   * (It used to be swallowed: the old shell had a hand-written `Ctrl+↑` branch that
   * called `preventDefault()` + `stopPropagation()` and then did nothing — an
   * earlier version of this comment claimed the binding was "registered locally in
   * `SpacesPanel.svelte` and dispatched by `DesktopShell`", which described a path
   * that did not exist. REQ-A395 replaced both with the config-driven dispatch.)
   *
   * The list order keeps the registry in the order documented by
   * `__tests__/shellModule.test.ts` ("the order the bar documents") — order 50
   * comes after `control-center-panel (40)` so the invariant `["launchpad",
   * "spotlight", "mission-control", "control-center-panel"]` stays green.
   */
  {
    id: "spaces-panel",
    slot: "overlay",
    order: 50,
    titleKey: "desktop.spaces",
    testId: "spaces-overlay",
    // No `shortcuts:` field — see the block comment above. REQ-A268 phase-2
    // (§4.3 7-knock audit) made this invariant load-bearing for the
    // accessibility-first keyboard contract.
    component: SpacesPanel,
  },
];

