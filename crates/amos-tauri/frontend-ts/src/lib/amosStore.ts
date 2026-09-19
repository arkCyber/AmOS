/** Typed access to the *same* `amos.*` shared-store keys the legacy vanilla UI
 * uses (amos.home.layout / amos.recents / …), so both UIs interoperate and, in the
 * Tauri shell, the value is mirrored to the Rust `SharedStore` — the durable copy
 * and cross-window bus (`store_set` / `store_snapshot`). */
import { bridged, systemStoreSet as _systemStoreSet, systemStoreSnapshot } from "./backend";
import { amosError } from "./debugLog";

/** Write-through helper: update `localStorage` AND the Rust `SharedStore` mirror.
 *  Re-exported so callers that already depend on `amosStore` don't have to reach
 *  into `backend.ts` for a single function. */
export const systemStoreSet = _systemStoreSet;
export interface HomeLayout {
  page: string[];
  dock: string[];
  hidden: string[];
}

export const LAYOUT_KEY = "amos.home.layout";
export const RECENTS_KEY = "amos.recents";

// The three most important apps on the dock, first-run layout: 电话 Phone,
// AI assistant, and 语音翻译/同传 Interpreter.
export const DEFAULT_DOCK = ["phone", "ai", "interpreter"];

/** Quarantine key suffix that keeps the raw bytes of a corrupt value so a later
 *  "seed + write" cannot silently destroy them. Bounded: one slot per key. */
export const CORRUPT_SUFFIX = ".corrupt";

/**
 * Window event fired after a store value is written, so same-window components
 * (e.g. the StatusBar radio indicators) can re-read reactively even though
 * `storage` only fires cross-tab. Detail: `{ key }`.
 */
export const STORE_CHANGED_EVENT = "amos-store-changed";

/**
 * Read + parse a stored value, returning `fallback` when absent.
 *
 * When the stored JSON is *corrupt* (not merely absent) we do NOT silently drop
 * it: we log a warning and quarantine a copy of the original raw text under
 * `${key}.corrupt`. This keeps corrupt user data recoverable even though the
 * caller then falls back to a default / seed value.
 */
function readJson<T>(key: string, fallback: T): T {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return fallback; // storage unavailable (e.g. private mode) — not corruption
  }
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    quarantineCorrupt(key, raw);
    return fallback;
  }
}

function quarantineCorrupt(key: string, raw: string): void {
  const backupKey = `${key}${CORRUPT_SUFFIX}`;
  try {
    // One bounded slot per key: if a copy is already there it is about to be replaced,
    // and *that* is a further loss of the user's bytes — say so instead of doing it
    // silently.
    const previous = window.localStorage.getItem(backupKey);
    window.localStorage.setItem(backupKey, raw);
    // Data loss is an **error**, not a warning: the user's stored value is gone and
    // the shell must be able to show that (audit P1-3).
    amosError(
      "store",
      previous === null
        ? `corrupt value for "${key}"; original preserved at "${backupKey}"`
        : `corrupt value for "${key}"; replaced an earlier quarantine at "${backupKey}" ` +
            `(${previous.length} byte(s) dropped)`,
    );
  } catch {
    amosError("store", `corrupt value for "${key}" (and it could not be backed up)`);
  }
}

/**
 * The quarantined (corrupt) values the shell has preserved, newest-first by key:
 * `{ key, bytes }` where `key` is the **original** store key. The read side of the
 * P1-1 quarantine — without it the preserved bytes were a dead end nobody could reach.
 */
export function listQuarantined(): Array<{ key: string; bytes: number }> {
  const out: Array<{ key: string; bytes: number }> = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || !k.endsWith(CORRUPT_SUFFIX)) continue;
      const raw = window.localStorage.getItem(k) ?? "";
      out.push({ key: k.slice(0, -CORRUPT_SUFFIX.length), bytes: raw.length });
    }
  } catch {
    return []; // storage unavailable — report nothing rather than invent entries
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** The raw preserved bytes for an original store key, or `null` when none. */
export function readQuarantine(key: string): string | null {
  try {
    return window.localStorage.getItem(`${key}${CORRUPT_SUFFIX}`);
  } catch {
    return null;
  }
}

/**
 * Persist `value` under `key`. Returns `true` only when the value actually landed
 * in `localStorage` — the same JSON string the Rust `store_set` mirror receives.
 *
 * Failures are deliberately **not** silent: a full or unavailable localStorage
 * means the value the user acted on is not stored (data loss, audit P1-3 — the same
 * rule the corrupt-value quarantine follows), so it is logged as a `store` **error**
 * and reported to the caller instead of being swallowed.
 */
function writeJson(key: string, value: unknown): boolean {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return false; // unencodable value (e.g. circular) — nothing was written
  }
  // Write through to the Rust `SharedStore` (durable copy + cross-window bus).
  // Fire-and-forget: localStorage is this window's immediate source of truth, and a
  // bridge failure must never break a settings write.
  void systemStoreSet(key, json);
  try {
    window.localStorage.setItem(key, json);
  } catch {
    amosError("store", `write failed for "${key}" (storage unavailable or full)`);
    return false;
  }
  // Notify same-window consumers that this store key changed. Only after the write
  // landed: a failed write changed nothing, so nothing may be announced. Best-effort
  // — announcing a change must never break the write itself, and some hosts expose a
  // `window` without an event bus.
  try {
    window.dispatchEvent(new CustomEvent(STORE_CHANGED_EVENT, { detail: { key } }));
  } catch {
    /* no event bus in this host */
  }
  return true;
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

/**
 * On boot, pull the durable Rust system store into localStorage. Every write goes
 * through `systemStoreSet` (`store_set`), so the Rust side holds the same values
 * and this recovers settings/notifications/layout from disk even if localStorage
 * was cleared. Best-effort: no-ops outside the Tauri shell.
 */
export async function hydrateFromSystemStore(): Promise<void> {
  if (!bridged()) return;
  const snap = await systemStoreSnapshot();
  if (!snap) return;
  try {
    for (const [key, value] of Object.entries(snap)) window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — ignore */
  }
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

/**
 * The new **dock order** for a drag that ends on `hoveredId` (REQ-A456). Pure; returns its
 * input (same reference) when nothing moves.
 *
 * Why this is not `moveBefore`: that one is a *cross-list* move ("take this out, drop it in
 * front of that"), and it always inserts **before** the target. In a dock that is wrong
 * half the time — dragging an icon to the right and dropping it on a neighbour would put it
 * *on the left of* that neighbour, i.e. one slot short of where the user pointed. macOS's
 * rule is positional: the dragged icon lands **in the hovered icon's slot**, and the others
 * close ranks around it. That is what `from < to ? anchor + 1 : anchor` expresses: moving
 * right inserts *after* the hovered item, moving left inserts *before* it.
 */
export function dockReorderIds(dock: string[], dragId: string, hoveredId: string): string[] {
  const from = dock.indexOf(dragId);
  const to = dock.indexOf(hoveredId);
  if (from < 0 || to < 0 || from === to) return dock;
  const rest = dock.filter((id) => id !== dragId);
  const anchor = rest.indexOf(hoveredId);
  const at = from < to ? anchor + 1 : anchor;
  const next = [...rest];
  next.splice(at, 0, dragId);
  return next;
}

/**
 * Apply a dock reorder to the **layout**, moving only the entries the surface actually
 * shows (REQ-A456).
 *
 * The dock's displayed list is a **subsequence** of `layout.dock`: the desktop filters out
 * phone-only apps (`withoutPhone`) and ids with no screen (`appTitleKey === null`). Writing
 * a reorder of the displayed list straight back would therefore **delete the hidden
 * entries** — and the worst case is the default layout itself: `DEFAULT_DOCK` contains
 * `phone`, which the desktop never draws, so the first drag on a fresh install would have
 * silently dropped it from the phone form's dock. `visible` is passed in (rather than
 * recomputed here) because the filter belongs to the surface; this function keeps every
 * non-displayed id in the slot it occupies and permutes only the visible ones.
 *
 * Returns `layout` unchanged (same reference) when the reorder is a no-op.
 */
export function reorderVisibleDock(
  layout: HomeLayout,
  visible: readonly string[],
  dragId: string,
  hoveredId: string,
): HomeLayout {
  const shown = new Set(visible);
  const visibleNow = layout.dock.filter((id) => shown.has(id));
  const ordered = dockReorderIds(visibleNow, dragId, hoveredId);
  if (ordered === visibleNow) return layout;
  let i = 0;
  return { ...layout, dock: layout.dock.map((id) => (shown.has(id) ? ordered[i++]! : id)) };
}

/**
 * Pin `ids` to the home DOCK (used when the user asks to send a custom group's
 * apps to the main screen). An app is shown once: it is moved out of the page
 * grid and out of `hidden` into the dock (dedup). Ids already docked are left in
 * place.
 *
 * REQ-A406: this function takes no `available` list, so it **cannot** tell a
 * known id from a stale one — an id it has never seen is appended like any other.
 * (The comment here used to claim "unknown ids are ignored", which the signature
 * makes impossible; the caller is what filters.) `Shell.svelte` passes a custom
 * group's members, and the App Library has already dropped uninstalled members
 * when the group was opened, so the list it hands over is known-ids-only.
 */
export function addAppsToDock(layout: HomeLayout, ids: readonly string[]): HomeLayout {
  const page = [...layout.page];
  const dock = [...layout.dock];
  const hidden = [...layout.hidden];
  for (const id of ids) {
    if (!id) continue;
    if (dock.includes(id)) {
      // already pinned — just make sure it isn't hidden
      const hi = hidden.indexOf(id);
      if (hi >= 0) hidden.splice(hi, 1);
      continue;
    }
    const pi = page.indexOf(id);
    if (pi >= 0) page.splice(pi, 1);
    const hi = hidden.indexOf(id);
    if (hi >= 0) hidden.splice(hi, 1);
    dock.push(id);
  }
  return { page, dock, hidden };
}

export function getRecents(): string[] {
  return readJson<string[]>(RECENTS_KEY, []);
}

/** Generic typed read/write against the shared amos.* store. Writes go through
 * `writeJson` (localStorage + `store_set` write-through to the Rust `SharedStore`).
 * Reused by ported apps for their own `amos.<app>` keys. */
export function readStoreValue<T>(key: string, fallback: T): T {
  return readJson<T>(key, fallback);
}
export function writeStoreValue(key: string, value: unknown): void {
  writeJson(key, value);
}

/**
 * Remove a key from **both** stores (localStorage and the Rust mirror) and report success.
 *
 * The mirror receives the JSON literal `null` rather than an empty string, for two reasons: an
 * empty string is not JSON, so a reader that parses the mirrored value would *throw* instead of
 * seeing "absent"; and `null` is this store's own "no value" (a reader's fallback fires either
 * way). The local removal happens after the mirror write so the visible state changes even when
 * the bridge is gone — the bridge call is fire-and-forget here exactly as it is in [`writeJson`].
 *
 * Added in REQ-A412 because `filesCloud.deleteSnapshot` had hand-rolled both halves and got the
 * mirror wrong; passing every removal through one function is what keeps them from drifting.
 */
export function removeStoreValue(key: string): boolean {
  void systemStoreSet(key, "null");
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    amosError("store", `remove failed for "${key}" (storage unavailable)`);
    return false;
  }
}

/**
 * Like `writeStoreValue`, but **reports whether the value actually landed** in the
 * local store. Callers that must not over-claim use this: the Settings backup shows a
 * summary and a "last synced" time, so a rejected write (full/unavailable storage)
 * has to be visible rather than leaving the page describing a backup that was never
 * stored.
 */
export function writeStoreValueChecked(key: string, value: unknown): boolean {
  return writeJson(key, value);
}

export function pushRecent(id: string): void {
  const next = [id, ...getRecents().filter((x) => x !== id)].slice(0, 8);
  writeJson(RECENTS_KEY, next);
}
