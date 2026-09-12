/**
 * Media / external-storage domain view + typed bridge to the Tauri `media_*`
 * commands (in-process MediaManager over mock / later Android MediaStore).
 * Pure normalize helpers render a deterministic view without a bridge; the
 * `media*` wrappers return `null` when not bridged so the UI shows an
 * "external storage unavailable" state instead of throwing.
 * Wire shapes: crates/amos-tauri/src/media.rs ↔ crates/amos-media (serde).
 */
export type StandardDir =
  | "root"
  | "camera" // DCIM/Camera
  | "screenshots" // Pictures/Screenshots
  | "pictures"
  | "download"
  | "recordings"
  | "movies"
  | "music";

export type MediaKind = "image" | "video" | "audio" | "file" | "download";
export type AccessKind = "read" | "write";

export interface MediaItem {
  id: string;
  kind: MediaKind;
  collection: StandardDir;
  name: string;
  /** Opaque handle (content:// on device, mock:// on host). */
  uri: string;
  mime: string | null;
  size_bytes: number | null;
  /** Last-modified epoch ms (0 = unknown). */
  ts: number;
}

export interface Grant {
  access: AccessKind;
  collection: StandardDir;
}

const DIRS: readonly StandardDir[] = [
  "root",
  "camera",
  "screenshots",
  "pictures",
  "download",
  "recordings",
  "movies",
  "music",
];

const KINDS: readonly MediaKind[] = ["image", "video", "audio", "file", "download"];
const ACCESS: readonly AccessKind[] = ["read", "write"];

/** Human-readable relative path under /storage/emulated/0 (display only). */
export function canonicalPath(dir: StandardDir): string {
  switch (dir) {
    case "root":
      return "";
    case "camera":
      return "DCIM/Camera";
    case "screenshots":
      return "Pictures/Screenshots";
    case "pictures":
      return "Pictures";
    case "download":
      return "Download";
    case "recordings":
      return "Recordings";
    case "movies":
      return "Movies";
    case "music":
      return "Music";
  }
}

/** Coerce an unknown to a StandardDir, falling back to `root` (never throws). */
export function normalizeDir(raw: unknown): StandardDir {
  return typeof raw === "string" && (DIRS as readonly string[]).includes(raw)
    ? (raw as StandardDir)
    : "root";
}

function isKind(raw: unknown): raw is MediaKind {
  return typeof raw === "string" && (KINDS as readonly string[]).includes(raw);
}

function isAccess(raw: unknown): raw is AccessKind {
  return typeof raw === "string" && (ACCESS as readonly string[]).includes(raw);
}

/** Coerce a raw `media_list` item; null when id/name missing. Never throws. */
export function normalizeMediaItem(raw: unknown): MediaItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<MediaItem>;
  if (typeof o.id !== "string" || o.id === "") return null;
  if (typeof o.name !== "string" || o.name === "") return null;
  return {
    id: o.id,
    kind: isKind(o.kind) ? o.kind : "file",
    collection: normalizeDir(o.collection),
    name: o.name,
    uri: typeof o.uri === "string" ? o.uri : "",
    mime: typeof o.mime === "string" ? o.mime : null,
    size_bytes: typeof o.size_bytes === "number" ? o.size_bytes : null,
    ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0,
  };
}

/** Coerce a raw grant; null when either field is malformed. */
export function normalizeGrant(raw: unknown): Grant | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<Grant>;
  if (!isAccess(o.access) || !DIRS.includes(o.collection as StandardDir)) return null;
  return { access: o.access as AccessKind, collection: o.collection as StandardDir };
}

interface Bridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

function bridge(): Bridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: Bridge };
  return w && typeof w.__TAURI_INTERNALS__ === "object"
    ? (w.__TAURI_INTERNALS__ as Bridge)
    : null;
}

/** Whether a Tauri media bridge is present (false = offline → wrappers return null). */
export function hasMediaBridge(): boolean {
  return bridge() !== null;
}

/**
 * Invoke a command. **Offline (no bridge) → `null`**; with a bridge present, a
 * real command error (e.g. an Unauthorized list) **rejects** with the Rust error
 * string so the UI can distinguish "offline" from "permission needed" — it must
 * never collapse a denial into a fake empty list.
 */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const b = bridge();
  if (!b) return null;
  return (await b.invoke(command, args)) as T;
}

/** Backend name, e.g. "mock" (null offline). */
export function mediaProviderName(): Promise<string | null> {
  return call<string>("media_provider_name");
}

/** Standard collections the backend serves (null offline). */
export function mediaAvailableCollections(): Promise<StandardDir[] | null> {
  return call<StandardDir[]>("media_available_collections");
}

/**
 * Current grant set (null offline). The raw reply is run through
 * `normalizeGrant`: a row that is not an `{access, collection}` pair this build
 * understands is **dropped** (an unknown/evolved daemon grant must never reach
 * the privacy UI as if it were a real typed grant), and a reply that is not an
 * array is treated as **"could not read"** (`null`) rather than a fabricated
 * empty set.
 */
export async function mediaGrants(): Promise<Grant[] | null> {
  const raw = await call<unknown>("media_grants");
  if (!Array.isArray(raw)) return null;
  return raw.map(normalizeGrant).filter((g): g is Grant => g !== null);
}

/** Authorize reading a collection (no-op offline). */
export function mediaGrantRead(collection: StandardDir): Promise<void | null> {
  return call<void>("media_grant_read", { collection });
}

/** Authorize writing into a collection (no-op offline). */
export function mediaGrantWrite(collection: StandardDir): Promise<void | null> {
  return call<void>("media_grant_write", { collection });
}

/** Revoke `access` on a collection (no-op offline). */
export function mediaRevoke(access: AccessKind, collection: StandardDir): Promise<void | null> {
  return call<void>("media_revoke", { access, collection });
}

/** List media in a collection (null offline; rejects on a real error like denial). */
export function mediaList(collection: StandardDir): Promise<MediaItem[] | null> {
  return call<MediaItem[]>("media_list", { collection });
}

/** Save `bytes` as `name` in a collection; returns the created item (null offline). */
export function mediaSave(
  collection: StandardDir,
  kind: MediaKind,
  name: string,
  bytes: Uint8Array,
): Promise<MediaItem | null> {
  return call<MediaItem>("media_save", { collection, kind, name, data: Array.from(bytes) });
}

/** Decode a byte-array (as the bridge delivers it, a plain number[]) → Uint8Array. */
export function bytesFromNumbers(numbers: readonly number[]): Uint8Array {
  return Uint8Array.from(numbers);
}

/** Read back the bytes of a previously-saved item (null offline; rejects on a real error). */
export async function mediaLoad(item: MediaItem): Promise<Uint8Array | null> {
  const arr = await call<number[]>("media_load", { item });
  return arr === null ? null : bytesFromNumbers(arr);
}
