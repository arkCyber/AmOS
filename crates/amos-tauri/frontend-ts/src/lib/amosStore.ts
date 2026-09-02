/**
 * Typed access to the *same* `amos.*` shared-store keys the legacy vanilla UI
 * uses (amos.home.layout / amos.recents / …), so both UIs interoperate and, in
 * the Tauri shell, sync across windows via window.Amos (if present).
 */
export interface HomeLayout {
  page: string[];
  dock: string[];
  hidden: string[];
}

export const LAYOUT_KEY = "amos.home.layout";
export const RECENTS_KEY = "amos.recents";

export const DEFAULT_DOCK = ["phone", "messages", "camera", "settings", "ai", "interpreter"];

declare global {
  interface Window {
    Amos?: {
      safeGet?(k: string, d: string): string;
      storeWrite?(k: string, v: string): void;
      applyTheme?(): void;
    };
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  const text = JSON.stringify(value);
  try {
    window.localStorage.setItem(key, text);
    window.Amos?.storeWrite?.(key, text);
  } catch {
    /* ignore */
  }
}

/** Default layout: dock apps first-class, everything else on a page. */
export function defaultLayout(available: string[]): HomeLayout {
  const dock = DEFAULT_DOCK.filter((id) => available.includes(id));
  const page = available.filter((id) => !dock.includes(id));
  return { page, dock, hidden: [] };
}

/** Load amos.home.layout, repair it against the available app ids, and merge
 * newly-registered apps onto the last page. */
export function getLayout(available: string[]): HomeLayout {
  const raw = readJson<Partial<HomeLayout> | null>(LAYOUT_KEY, null);
  const base =
    raw && Array.isArray(raw.page) && Array.isArray(raw.dock)
      ? { page: raw.page, dock: raw.dock, hidden: Array.isArray(raw.hidden) ? raw.hidden : [] }
      : defaultLayout(available);
  const page = base.page.filter((id) => available.includes(id));
  const dock = base.dock.filter((id) => available.includes(id));
  const hidden = base.hidden.filter((id) => available.includes(id));
  const placed = new Set([...page, ...dock, ...hidden]);
  for (const id of available) if (!placed.has(id)) page.push(id);
  return { page, dock, hidden };
}

export function saveLayout(layout: HomeLayout): void {
  writeJson(LAYOUT_KEY, layout);
}

/* ---- Home layout editing (pure) ---- */
export function hideFromHome(layout: HomeLayout, id: string): HomeLayout {
  const page = [...layout.page];
  const dock = [...layout.dock];
  const hidden = [...layout.hidden];
  const pi = page.indexOf(id);
  const di = dock.indexOf(id);
  if (pi >= 0) {
    page.splice(pi, 1);
    hidden.push(id);
  } else if (di >= 0) {
    dock.splice(di, 1);
    page.push(id); // dock icons return to the page (iOS-like)
  }
  return { page, dock, hidden };
}

export function restoreToHome(layout: HomeLayout, id: string): HomeLayout {
  const hidden = layout.hidden.filter((x) => x !== id);
  return { page: [...layout.page, id], dock: [...layout.dock], hidden };
}

/** Move `dragId` so it sits just before `targetId` (cross-list aware). */
export function moveBefore(layout: HomeLayout, dragId: string, targetId: string): HomeLayout {
  const page = [...layout.page];
  const dock = [...layout.dock];
  const hidden = [...layout.hidden];
  const remove = (arr: string[], id: string) => {
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    return i >= 0;
  };
  const removedFrom = remove(page, dragId) ? page : remove(dock, dragId) ? dock : null;
  if (!removedFrom) return layout;
  const tp = page.indexOf(targetId);
  const td = dock.indexOf(targetId);
  if (tp >= 0) page.splice(tp, 0, dragId);
  else if (td >= 0) dock.splice(td, 0, dragId);
  else page.push(dragId);
  return { page, dock, hidden };
}

export function getRecents(): string[] {
  return readJson<string[]>(RECENTS_KEY, []);
}

/** Generic typed read/write against the shared amos.* store (localStorage +
 * window.Amos bridge). Reused by ported apps for their own `amos.<app>` keys. */
export function readStoreValue<T>(key: string, fallback: T): T {
  return readJson<T>(key, fallback);
}
export function writeStoreValue(key: string, value: unknown): void {
  writeJson(key, value);
}

export function pushRecent(id: string): void {
  const next = [id, ...getRecents().filter((x) => x !== id)].slice(0, 8);
  writeJson(RECENTS_KEY, next);
}
