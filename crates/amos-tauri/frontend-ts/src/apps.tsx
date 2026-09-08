import type { FC } from "react";
import ExtApp from "./components/ExtApp";
import { isExtId } from "./lib/storeApps";
import { useI18n } from "./i18n";
import SvelteAppHost from "./components/SvelteAppHost";

export { APP_META as APPS, appIcon, appTitleKey } from "./lib/appMeta";
export type { AppMeta } from "./lib/appMeta";


/* ---- Svelte single-source seam (React → Svelte) ----
 * Every built-in app screen is implemented once in Svelte and mounted by a thin
 * React host (`SvelteAppHost`). The React shell (App.tsx) also uses
 * `svelteEnabled()` below for its own chrome islands, so the seam stays even
 * though no app still ships a React fallback. */
export function svelteEnabled(): boolean {
  try {
    // `import.meta.env.PROD` is only defined by Vite; absent under bun (→ React).
    const env = (import.meta as { env?: { PROD?: boolean } }).env;
    if (env?.PROD) return true;
  } catch {
    /* non-Vite runtime */
  }
  try {
    // dev opt-in: localStorage.setItem("amos.ui.svelteCalc", "1")
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("amos.ui.svelteCalc") === "1"
    );
  } catch {
    return false;
  }
}

// Stable module-level loaders (identity must not change per render — the host
// mounts once per loader identity).
const loadCalculator = () => import("./svelte/CalculatorApp.svelte");
const loadWeather = () => import("./svelte/WeatherApp.svelte");
const loadContacts = () => import("./svelte/ContactsApp.svelte");
const loadPermissions = () => import("./svelte/PermissionsApp.svelte");
const loadClock = () => import("./svelte/ClockApp.svelte");
const loadMessages = () => import("./svelte/MessagesApp.svelte");
const loadMusic = () => import("./svelte/MusicApp.svelte");
const loadNotes = () => import("./svelte/NotesApp.svelte");
const loadFiles = () => import("./svelte/FilesApp.svelte");
const loadPhotos = () => import("./svelte/PhotosApp.svelte");
const loadPhone = () => import("./svelte/PhoneApp.svelte");
const loadReminders = () => import("./svelte/RemindersApp.svelte");
const loadMail = () => import("./svelte/MailApp.svelte");
const loadSettings = () => import("./svelte/SettingsApp.svelte");
const loadMaps = () => import("./svelte/MapsApp.svelte");
const loadVmem = () => import("./svelte/VoiceMemosApp.svelte");
const loadMagnifier = () => import("./svelte/MagnifierApp.svelte");
const loadAndroid = () => import("./svelte/AndroidApp.svelte");
const loadStore = () => import("./svelte/StoreApp.svelte");
const loadCamera = () => import("./svelte/CameraApp.svelte");
const loadInterp = () => import("./svelte/InterpApp.svelte");
const loadAi = () => import("./svelte/AiApp.svelte");
const loadMonitor = () => import("./svelte/MonitorApp.svelte");

const CalculatorEntry: FC = () => <SvelteAppHost load={loadCalculator} />;

const WeatherEntry: FC = () => <SvelteAppHost load={loadWeather} />;

const ContactsEntry: FC = () => <SvelteAppHost load={loadContacts} />;

const PermissionsEntry: FC = () => <SvelteAppHost load={loadPermissions} />;

const ClockEntry: FC = () => <SvelteAppHost load={loadClock} />;

const MessagesEntry: FC = () => <SvelteAppHost load={loadMessages} />;

const MusicEntry: FC = () => <SvelteAppHost load={loadMusic} />;

const NotesEntry: FC = () => <SvelteAppHost load={loadNotes} />;

const FilesEntry: FC = () => <SvelteAppHost load={loadFiles} />;

const PhotosEntry: FC = () => <SvelteAppHost load={loadPhotos} />;

const PhoneEntry: FC = () => <SvelteAppHost load={loadPhone} />;

const RemindersEntry: FC = () => <SvelteAppHost load={loadReminders} />;

const MailEntry: FC = () => <SvelteAppHost load={loadMail} />;

const SettingsEntry: FC = () => <SvelteAppHost load={loadSettings} />;

const MapsEntry: FC = () => <SvelteAppHost load={loadMaps} />;

const VmemosEntry: FC = () => <SvelteAppHost load={loadVmem} />;

const MagnifierEntry: FC = () => <SvelteAppHost load={loadMagnifier} />;

const AndroidEntry: FC = () => <SvelteAppHost load={loadAndroid} />;

const StoreEntry: FC = () => <SvelteAppHost load={loadStore} />;

const CameraEntry: FC = () => <SvelteAppHost load={loadCamera} />;

const InterpEntry: FC = () => <SvelteAppHost load={loadInterp} />;

const AiEntry: FC = () => <SvelteAppHost load={loadAi} />;

const MonitorEntry: FC = () => <SvelteAppHost load={loadMonitor} />;



/** Map of ported app id → React component. Unported ids fall back to a stub. */
const COMPONENTS: Record<string, FC> = {
  clock: ClockEntry,
  settings: SettingsEntry,
  calculator: CalculatorEntry,
  weather: WeatherEntry,
  notes: NotesEntry,
  reminders: RemindersEntry,
  vmemos: VmemosEntry,
  photos: PhotosEntry,
  files: FilesEntry,
  android: AndroidEntry,
  messages: MessagesEntry,
  phone: PhoneEntry,
  music: MusicEntry,
  maps: MapsEntry,
  camera: CameraEntry,
  ai: AiEntry,
  interpreter: InterpEntry,
  mail: MailEntry,
  store: StoreEntry,
  privacy: PermissionsEntry,
  contacts: ContactsEntry,
  magnifier: MagnifierEntry,
  monitor: MonitorEntry,
};

/** Get the component for an app id, or a "not ported yet" placeholder. */
export function AppComponent({ id }: { id: string }): ReturnType<FC> {
  if (isExtId(id)) return <ExtApp id={id} />;
  const Comp = COMPONENTS[id] ?? NotFound;
  return <Comp />;
}

const NotFound: FC = () => {
  const { t } = useI18n();
  return <div className="p-8 text-center text-sm opacity-60">{t("app.notFound")}</div>;
};
