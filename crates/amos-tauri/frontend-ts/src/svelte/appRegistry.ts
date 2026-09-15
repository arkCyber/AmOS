/**
 * appRegistry.ts — map of app id → Svelte screen loader.
 *
 * The single table `Shell.svelte` uses to mount an app by id. It uses dynamic
 * `import()` loaders so screens stay code-split and the shell needs no static
 * reference to every screen. Pure TS — usable from Svelte or tests.
 *
 * Phone apps (apps that require real cellular hardware) are removed from the
 * loader on desktop form factor (no SIM / cellular modem). They are still
 * available on phone / tablet / robot.
 */

import { desktopFormActive } from "../lib/desktopApps";
import { isPhoneApp } from "../lib/phoneApps";

export interface SvelteAppLoaderLike {
  (): Promise<{ default: unknown }>;
}

const ALL_APP_LOADERS: Record<string, SvelteAppLoaderLike> = {
  clock: () => import("./ClockApp.svelte"),
  settings: () => import("./SettingsApp.svelte"),
  calculator: () => import("./CalculatorApp.svelte"),
  weather: () => import("./WeatherApp.svelte"),
  notes: () => import("./NotesApp.svelte"),
  reminders: () => import("./RemindersApp.svelte"),
  calendar: () => import("./CalendarApp.svelte"),
  vmemos: () => import("./VoiceMemosApp.svelte"),
  photos: () => import("./PhotosApp.svelte"),
  files: () => import("./FilesApp.svelte"),
  android: () => import("./AndroidApp.svelte"),
  messages: () => import("./MessagesApp.svelte"),
  phone: () => import("./PhoneApp.svelte"),
  music: () => import("./MusicApp.svelte"),
  player: () => import("./PlayerApp.svelte"),
  maps: () => import("./MapsApp.svelte"),
  camera: () => import("./CameraApp.svelte"),
  terminal: () => import("./TerminalApp.svelte"),
  ai: () => import("./AiApp.svelte"),
  interpreter: () => import("./InterpApp.svelte"),
  mail: () => import("./MailApp.svelte"),
  store: () => import("./StoreApp.svelte"),
  pwa: () => import("./PwaHubApp.svelte"),
  nativeapps: () => import("./NativeAppsApp.svelte"),
  privacy: () => import("./PermissionsApp.svelte"),
  contacts: () => import("./ContactsApp.svelte"),
  magnifier: () => import("./MagnifierApp.svelte"),
  monitor: () => import("./MonitorApp.svelte"),
  devocare: () => import("./DeviceCareApp.svelte"),
};

/**
 * Resolve the Svelte screen loader for an app id; undefined if unregistered
 * or unavailable in the current form factor (e.g. `phone` on desktop).
 *
 * The decision is **deterministic + side-effect free** so the same caller
 * (Shell.svelte's mounted effect) gets the same answer within one tick. The
 * form factor is read once from the same host authority `Shell` uses, so a
 * layout-changed push that flips the form will (on the next effect) re-resolve.
 */
export function svelteAppLoader(id: string): SvelteAppLoaderLike | undefined {
  if (desktopFormActive() && isPhoneApp(id)) {
    return undefined;
  }
  return ALL_APP_LOADERS[id];
}
