/**
 * appRegistry.ts — map of app id → Svelte screen loader.
 *
 * The single table `Shell.svelte` uses to mount an app by id. It uses dynamic
 * `import()` loaders so screens stay code-split and the shell needs no static
 * reference to every screen. Pure TS — usable from Svelte or tests.
 */

export interface SvelteAppLoaderLike {
  (): Promise<{ default: unknown }>;
}

export const SVELTE_APP_LOADERS: Record<string, SvelteAppLoaderLike> = {
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
  privacy: () => import("./PermissionsApp.svelte"),
  contacts: () => import("./ContactsApp.svelte"),
  magnifier: () => import("./MagnifierApp.svelte"),
  monitor: () => import("./MonitorApp.svelte"),
  devocare: () => import("./DeviceCareApp.svelte"),
};

/** Resolve the Svelte screen loader for an app id; undefined if unregistered. */
export function svelteAppLoader(id: string): SvelteAppLoaderLike | undefined {
  return SVELTE_APP_LOADERS[id];
}
