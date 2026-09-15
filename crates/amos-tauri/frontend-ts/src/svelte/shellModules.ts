/**
 * shellModules.ts — the desktop chrome's **table**: which widget lives where, in
 * what order. This is the file a person adds a widget to, and the only file that
 * knows the full set (the containers read it through `modulesFor`, the tests hold
 * it to its invariants).
 *
 * What lives here and what does not: `id` / `slot` / `order` / `titleKey` /
 * `testId` / the component. Not styling (that is `lib/shellChrome.ts`), not layout
 * (the container + `lib/desktopLayout.ts`), and not data (each widget owns its own
 * subscription).
 *
 * `order` gaps are deliberate (10, 20, 30…): inserting a widget between two others
 * must not mean renumbering the table, and the gap is where a *config-driven*
 * order would slide in later without touching the ids.
 */
import type { ShellModule } from "../lib/shellModule";
import BatteryWidget from "./modules/BatteryWidget.svelte";
import ClockWidget from "./modules/ClockWidget.svelte";
import ControlCenterButton from "./modules/ControlCenterButton.svelte";
import LaunchpadTrigger from "./modules/LaunchpadTrigger.svelte";
import RadiosWidget from "./modules/RadiosWidget.svelte";
import SpotlightTrigger from "./modules/SpotlightTrigger.svelte";

/**
 * Every chrome widget, in registry order (`order` decides what a container draws).
 *
 * The right-hand group is the bar's original set, and the **order matches the bar
 * that shipped** — Launchpad, Spotlight, control centre, radios, clock, battery
 * (`order` 10…60). The split into six modules is invisible on screen; what changed
 * is that each one is now a file with its own test instead of a block inside the
 * bar's template.
 */
export const SHELL_MODULES: ShellModule[] = [
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
    titleKey: "desktop.controlCenterUnavailable",
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
];

