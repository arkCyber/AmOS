/**
 * appRegistry.ts — React-free map of app id → Svelte screen loader.
 *
 * Phase-3 (exit React) foundation: a future Svelte top-level shell must mount an
 * app screen by id (like the React `AppComponent`/`COMPONENTS`), but importing
 * `apps.tsx` would drag React in. This plain module owns that mapping using the
 * same dynamic-import `.svelte` loaders, so it can run without any React on the
 * import graph. Pure TS — usable from Svelte or tests.
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
  vmemos: () => import("./VoiceMemosApp.svelte"),
  photos: () => import("./PhotosApp.svelte"),
  files: () => import("./FilesApp.svelte"),
  android: () => import("./AndroidApp.svelte"),
  messages: () => import("./MessagesApp.svelte"),
  phone: () => import("./PhoneApp.svelte"),
  music: () => import("./MusicApp.svelte"),
  maps: () => import("./MapsApp.svelte"),
  camera: () => import("./CameraApp.svelte"),
  ai: () => import("./AiApp.svelte"),
  interpreter: () => import("./InterpApp.svelte"),
  mail: () => import("./MailApp.svelte"),
  store: () => import("./StoreApp.svelte"),
  privacy: () => import("./PermissionsApp.svelte"),
  contacts: () => import("./ContactsApp.svelte"),
  magnifier: () => import("./MagnifierApp.svelte"),
  monitor: () => import("./MonitorApp.svelte"),
};

/** Resolve the Svelte screen loader for an app id; undefined if unregistered. */
export function svelteAppLoader(id: string): SvelteAppLoaderLike | undefined {
  return SVELTE_APP_LOADERS[id];
}

/** All ids the Svelte shell can mount (mirrors the built-in APPS registry). */
export function svelteAppIds(): string[] {
  return Object.keys(SVELTE_APP_LOADERS);
}
