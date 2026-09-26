/**
 * hostFs.ts — typed wrapper over the `host_fs_*` commands that hand the
 * WebView real filesystem access through the Rust chokepoint
 * (`crates/amos-tauri/src/host_fs.rs`).
 *
 * ## Why this module is a thin wrapper
 *
 * Every command goes through one canonicalize-then-`starts_with(allowed_root)`
 * boundary on the Rust side (see the module header in `host_fs.rs`). The
 * WebView's responsibility is shaped: a path can be **root-relative** (`a.txt`,
 * `sub/file.md`) or **absolute but inside the root** (`/Users/me/doc.md`). The
 * chokepoint canonicalizes either form, so a caller never has to think about
 * which the root is — only that the path is, or is rooted at, something the
 * operator intends to expose via `AMOS_HOST_FS_ROOT`.
 *
 * ## Error model
 *
 * The Rust side returns `Result<_, AmosError>`. `backend.invoke` collapses that
 * into `T | null` so off-bridge calls degrade silently. **This wrapper restores
 * the shape**: every call resolves with the typed payload **or** a
 * [`HostFsError`] carrying the stable `code`. The UI i18n layer branches on
 * `code`, not on the human-readable message (a rewrite of `message` is *not* a
 * wire contract break, an addition or rename of a `code` **is** — exactly the
 * REQ-A268 ledger's "stable codes, ephemeral messages" rule).
 *
 * ## Watch
 *
 * `host_fs_watch_subscribe` returns a `subscription_id`; events arrive on the
 * [`HOST_FS_EVENT`] Tauri channel with a payload that already carries that id.
 * The UI uses the id to decide whether an event is its own write (and can be
 * ignored) or someone else's (and must refresh). `onHostFsEvent` wraps the
 * subscribe/unsubscribe dance so a Svelte component's `onMount`/`onDestroy`
 * pairing is a one-liner each way.
 */

import { bridgeDiag, invoke, subscribe } from "./backend";

/* ---- Wire types (mirror host_fs.rs serde `rename_all = "camelCase"`) ---- */

export interface FsDirEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface FsReadTextResult {
  path: string;
  size: number;
  body: string;
  truncated: boolean;
}

export interface FsReadBytesResult {
  path: string;
  size: number;
  /** Standard base64 of the (possibly truncated) bytes. */
  body: string;
  truncated: boolean;
}

export interface FsWriteResult {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface FsStatResult {
  path: string;
  exists: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

/** `host_fs_remove` result. `kind` is `"file"` or `"dir"`. */
export interface FsRemovedResult {
  path: string;
  removed: boolean;
  kind: string;
}

export interface FsRootStatus {
  /** The configured root, or `null` when `AMOS_HOST_FS_ROOT` is unset. */
  root: string | null;
  exists: boolean;
  reason: string | null;
}

export interface FsSubscribeResult {
  subscriptionId: number;
}

export interface FsUnsubscribeResult {
  removed: boolean;
}

export interface FsWatchEvent {
  subscriptionId: number;
  path: string;
  /** "create" | "write" | "remove" | "rename" — verbatim from notify-debouncer-mini. */
  kind: string;
}

/* ---- Typed error envelope ---- */

/** A `host_fs_*` failure, carrying the stable i18n code. */
export interface HostFsError {
  /** One of the `amos.host_fs.*` codes listed below — **never** `null`. */
  code: HostFsErrorCode;
  /** Developer-facing diagnostic, English, free to change without notice. */
  message: string;
  /** Upstream `io::Error` (or similar) when the bridge attached one. */
  cause?: string;
}

/**
 * Stable `host_fs` error codes — the frontend mirror of the `amos.host_fs.*`
 * strings `crates/amos-tauri/src/error.rs` declares (one `ErrorCode` variant
 * each). Add a new code == wire break; rename/remove same.
 *
 * **This array is the one declaration.** {@link HostFsErrorCode} is *derived*
 * from it (`(typeof HOST_FS_CODES)[number]`), so the type and the membership
 * test in {@link extractEnvelope} cannot drift. They used to be two hand-written
 * spellings of the same twelve strings, and a code present in one but not the
 * other still compiled — the `as` cast in the membership test defeats the
 * checker — so a stale array silently dropped the envelope for a real refusal
 * and downgraded it to the generic `read_failed`. `hostFs.test.ts` freezes the
 * contents and asserts set-equality with the Rust enum in both directions.
 */
export const HOST_FS_CODES = [
  "amos.host_fs.root_not_configured",
  "amos.host_fs.root_not_found",
  "amos.host_fs.root_not_a_dir",
  "amos.host_fs.path_not_found",
  "amos.host_fs.path_is_a_dir",
  "amos.host_fs.path_is_not_a_dir",
  "amos.host_fs.path_escapes_root",
  "amos.host_fs.file_too_large",
  "amos.host_fs.read_failed",
  "amos.host_fs.write_failed",
  "amos.host_fs.read_not_utf8",
  "amos.host_fs.write_atomics_failed",
  "amos.host_fs.target_exists",
  "amos.host_fs.dir_not_empty",
  "amos.host_fs.recursion_limit",
  "amos.host_fs.create_dir_failed",
  "amos.host_fs.remove_failed",
  "amos.host_fs.rename_failed",
  "amos.host_fs.copy_failed",
] as const;

/** A stable `host_fs` wire code: an element of {@link HOST_FS_CODES}. */
export type HostFsErrorCode = (typeof HOST_FS_CODES)[number];

/**
 * The Rust side's `AmosError` reaches the WebView as the JSON envelope
 * `{code: "amos.host_fs.*", message: "...", cause: [...]?}`. `backend.invoke`
 * does not turn that into a `HostFsError` for us — its contract is "either
 * success or `null`" — so this wrapper inspects the raw envelope that fell
 * out of the bridge and turns it into a typed failure when the call did
 * not produce the expected result.
 *
 * `null`-when-not-bridged stays: a caller that asked the bridge a question
 * on a host running outside the Tauri shell still gets `null` and not a
 * fabricated `HostFsError`. Only an *envelope-bearing* failure becomes a
 * {@link HostFsError}.
 */
function extractEnvelope(error: unknown): HostFsError | null {
  if (!error || typeof error !== "object") return null;
  const obj = error as Record<string, unknown>;
  const code = obj["code"];
  if (typeof code !== "string") return null;
  // Membership in this module's own vocabulary keeps the typed `code` to its
  // namespace — a future bridge that adds another subsystem can't accidentally
  // make us accept its codes. The list *is* the type (`HostFsErrorCode` derives
  // from it), so the cast below is sound rather than a way to silence the checker.
  if (!(HOST_FS_CODES as readonly string[]).includes(code)) return null;
  const message = typeof obj["message"] === "string" ? (obj["message"] as string) : code;
  const causeRaw = obj["cause"];
  const cause = Array.isArray(causeRaw) && causeRaw[0] !== undefined ? String(causeRaw[0]) : undefined;
  return { code: code as HostFsErrorCode, message, cause };
}

/**
 * Run `op` against the bridge and turn its return into the typed shape.
 *
 * Backend's contract is `T | null`, and its `invoke` **catches** the rejection
 * rather than re-throwing it — so the `AmosError` envelope never arrives here as
 * a thrown value. It is not lost, though: `backend.invoke` records it in the
 * per-command diagnostic ledger (`noteDiag(command, {kind:"command-failed",
 * detail: err})`). Reading that ledger back is what makes the typed `code`
 * reachable at all; without it this module's "restores the shape" claim was a
 * fiction (every failure collapsed to one generic code).
 *
 * `null` still means `null` when the bridge is simply absent (`not-bridged`): a
 * build running outside the Tauri shell must not fabricate an `AmosError`.
 *
 * REQ-A542: reading the ledger back is what makes the typed `code` reachable at
 * all — the `catch`/`extractEnvelope` pair that used to sit here could never run.
 */
async function call<T>(
  command: string,
  op: () => Promise<T | null>,
): Promise<{ ok: true; value: T } | (HostFsFailure & { ok: false })> {
  const v = await op();
  if (v !== null && v !== undefined) return { ok: true, value: v };
  const diag = bridgeDiag(command);
  if (!diag.ok && diag.kind === "command-failed") {
    const env = extractEnvelope(diag.detail);
    if (env) return { ok: false, ...env };
    return {
      ok: false,
      code: "amos.host_fs.read_failed",
      message: "host_fs: command failed without a host envelope",
      cause: diag.detail === undefined ? undefined : String(diag.detail),
    };
  }
  return {
    ok: false,
    code: "amos.host_fs.read_failed",
    message: "host_fs: not bridged (no host filesystem available)",
    isOffline: true,
  };
}

/**
 * Either-or result shape: every `hostFs*` call resolves to `{ok:true,value:T}`
 * **or** a {@link HostFsError} with a stable `code`. Exposed as the discriminated
 * union `Result<T>` so a UI component can switch on `result.ok` once.
 */
export type Result<T> = { ok: true; value: T } | HostFsFailure;

/**
 * The "offline / typed error" half of {@link Result}. Carries the
 * `isOffline` hint so a UI can show "the host filesystem is unavailable"
 * instead of a per-error code. **Not exported publicly** — users only see
 * `Result<T>` and branch on `result.ok`.
 */
interface HostFsFailure extends HostFsError {
  /** The discriminant — without it `Result<T>` is not a discriminated union and a
   *  caller's `if (r.ok)` cannot narrow, so the TS checks fail on the failure arm. */
  ok: false;
  isOffline?: boolean;
}

/* ---- Command wrappers ---- */

/**
 * Probe the configured root. **Never errors**: an unset / missing / wrong-kind
 * env var is data, so the UI can show "Files system is not enabled — set
 * AMOS_HOST_FS_ROOT at startup". Returns `null` only when the bridge is
 * offline.
 */
export async function hostFsRootStatus(): Promise<FsRootStatus | null> {
  return invoke<FsRootStatus>("host_fs_root_status");
}

/** List a directory (root-relative or absolute-inside-root). */
export async function hostFsReadDir(path: string): Promise<Result<FsDirEntry[]>> {
  return call("host_fs_read_dir", () => invoke<FsDirEntry[]>("host_fs_read_dir", { args: { path, cap: null } }));
}

/** Read a file as UTF-8 text. `cap` is bytes (default 8 MiB, ceiling 64 MiB). */
export async function hostFsReadText(path: string, cap?: number): Promise<Result<FsReadTextResult>> {
  return call("host_fs_read_text", () => invoke<FsReadTextResult>("host_fs_read_text", { args: { path, cap: cap ?? null } }));
}

/**
 * Read a file as raw bytes (base64 on the wire). `cap` is bytes (default 8 MiB,
 * ceiling 64 MiB). The decoded `body` round-trips through `btoa` for full
 * portability across browsers; a node-style Buffer consumer can `Buffer.from(b64, "base64")`.
 */
export async function hostFsReadBytes(path: string, cap?: number): Promise<Result<FsReadBytesResult>> {
  return call("host_fs_read_bytes", () => invoke<FsReadBytesResult>("host_fs_read_bytes", { args: { path, cap: cap ?? null } }));
}

/**
 * Write UTF-8 text atomically (`.tmp` + rename). `cap` is bytes (default 8 MiB,
 * ceiling 64 MiB), the write-side twin of the read `cap`. `createOnly` makes an
 * existing target a typed `target_exists` refusal instead of a save-over — the
 * "New File" contract, so a name collision cannot silently eat a file's bytes.
 *
 * `path` + `content` travel **nested under `args`**: the Rust command takes a
 * single `WriteArgs` parameter (`host_fs_write_text(args: WriteArgs)`), and Tauri
 * looks the payload up by that parameter name. Sending them at the top level
 * (`{ path, content }`) is the inverse of the read commands' mistake — the key
 * `args` is then absent, the command rejects before touching the disk, and
 * **every** write fails while the TS types still say it compiles.
 */
export async function hostFsWriteText(
  path: string,
  content: string,
  cap?: number,
  createOnly = false,
): Promise<Result<FsWriteResult>> {
  return call("host_fs_write_text", () =>
    invoke<FsWriteResult>("host_fs_write_text", { args: { path, content, cap: cap ?? null, createOnly } }),
  );
}

/**
 * Write raw bytes (passed as base64, the wire key `dataB64`). Binary Arrays
 * round-trip through `bytesToBase64`. `cap` is the **decoded**-byte ceiling
 * (default 8 MiB, ceiling 64 MiB); raise it for a buffer larger than the default
 * rather than chunking, since each call replaces the file atomically.
 */
export async function hostFsWriteBytes(path: string, dataB64: string, cap?: number): Promise<Result<FsWriteResult>> {
  return call("host_fs_write_bytes", () => invoke<FsWriteResult>("host_fs_write_bytes", { args: { path, dataB64, cap: cap ?? null } }));
}

/** Stat a file or directory. */
export async function hostFsStat(path: string): Promise<Result<FsStatResult>> {
  return call("host_fs_stat", () => invoke<FsStatResult>("host_fs_stat", { args: { path, cap: null } }));
}

/**
 * Create a directory inside the allowed root. Refuses an existing target
 * (`target_exists`); pass `recursive` for `mkdir -p`.
 */
export async function hostFsCreateDir(path: string, recursive = false): Promise<Result<FsStatResult>> {
  return call("host_fs_create_dir", () => invoke<FsStatResult>("host_fs_create_dir", { args: { path, recursive } }));
}

/**
 * Rename or move a file/directory. Refuses an existing destination unless
 * `overwrite` is set, and refuses moving a directory into its own subtree.
 */
export async function hostFsRename(from: string, to: string, overwrite = false): Promise<Result<FsStatResult>> {
  return call("host_fs_rename", () => invoke<FsStatResult>("host_fs_rename", { args: { from, to, overwrite } }));
}

/**
 * Delete a file, or a directory. A non-empty directory needs `recursive: true`;
 * without it the host refuses with `dir_not_empty` rather than emptying it.
 */
export async function hostFsRemove(path: string, recursive = false): Promise<Result<FsRemovedResult>> {
  return call("host_fs_remove", () => invoke<FsRemovedResult>("host_fs_remove", { args: { path, recursive } }));
}

/**
 * Copy a file or directory tree. Refuses an existing destination unless
 * `overwrite` is set, and refuses copying a directory into its own subtree.
 */
export async function hostFsCopy(from: string, to: string, overwrite = false): Promise<Result<FsStatResult>> {
  return call("host_fs_copy", () => invoke<FsStatResult>("host_fs_copy", { args: { from, to, overwrite } }));
}

/** Subscribe to events under a directory. Returns the subscription id on success. */
export async function hostFsWatchSubscribe(path: string): Promise<Result<FsSubscribeResult>> {
  return call("host_fs_watch_subscribe", () => invoke<FsSubscribeResult>("host_fs_watch_subscribe", { args: { path, cap: null } }));
}

/** Stop a subscription. `result.value.removed === false` is data, not error. */
export async function hostFsWatchUnsubscribe(subscriptionId: number): Promise<Result<FsUnsubscribeResult>> {
  return call("host_fs_watch_unsubscribe", () => invoke<FsUnsubscribeResult>("host_fs_watch_unsubscribe", { subscriptionId }));
}

/** All currently active subscription ids (sorted). */
export async function hostFsWatchList(): Promise<number[] | null> {
  return invoke<number[]>("host_fs_watch_list");
}

/** Event channel name. Mirrors `host_fs::WATCH_EVENT`. */
export const HOST_FS_EVENT = "host-fs-event";

/**
 * Subscribe to host-fs events. Returns a synchronous unsubscribe (matches
 * `onTelephonyEvent` / `onMenuEvent` in `backend.ts`). Outside Tauri there is no bridge, so the
 * cleanup is a no-op — but note it is the *same* cleanup in that case: releasing a subscription
 * that was never established does nothing, and it is not evidence that one exists.
 *
 * REQ-A838: the events a `hostFsWatch*` call is waiting on are pushed here and nowhere else, so
 * a refused listen means a registered watch never reports and the file tree silently stops
 * updating. `subscribe` records that verdict as `listen-failed` under `HOST_FS_EVENT` in the
 * diagnosis ledger; `/tmp/…`-style "nothing changed" and "we are not listening" must not read
 * alike, and `bridgeDiag(HOST_FS_EVENT)` is what tells them apart.
 */
export function onHostFsEvent(onEvent: (ev: FsWatchEvent) => void): () => void {
  let cancelled = false;
  let unsub: (() => void) | null = null;
  void subscribe(HOST_FS_EVENT, (payload) => {
    const ev = payload as FsWatchEvent;
    if (
      ev &&
      typeof ev.subscriptionId === "number" &&
      typeof ev.path === "string" &&
      typeof ev.kind === "string"
    ) {
      onEvent(ev);
    }
  }).then((u) => {
    if (u === null) return; // never established — nothing to release
    if (cancelled) u();
    else unsub = u;
  });
  return () => {
    cancelled = true;
    unsub?.();
  };
}

/* ---- Pure helpers: small conversions the test layer needs ---- */

/**
 * Standard base64 of a `Uint8Array`, for the `dataB64` wire key.
 *
 * Chunked so a large buffer does not blow the call stack via
 * `String.fromCharCode(...bytes)`. `btoa` is present in every runtime this
 * ships to (browser, happy-dom, Bun, Node ≥ 16), so there is no hand-rolled
 * fallback: the one that used to live here emitted a **5-character** group for
 * a 1-byte remainder, and nothing could reach it to notice.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    s += String.fromCharCode(...slice);
  }
  return btoa(s);
}

/** Decode a standard base64 string into bytes. `null` on malformed input. */
export function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * The parent directory of a fence-relative path, or `null` at the fence root.
 *
 * Pure string work on the forward-slash form the host returns — **not** a `..`
 * segment, which `host_fs::resolve` refuses outright (`host_fs_path_escapes_root`).
 * A path with no separator is already at the root, so "up" is `null`, not `""`:
 * an empty path is itself a typed error (`host_fs_path_not_found`).
 */
export function hostParent(path: string): string | null {
  const clean = path.replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  if (cut < 0) return null;
  return cut === 0 ? null : clean.slice(0, cut);
}

/** Coerce one raw `host_fs_read_dir` entry; `null` when it is not a real entry. */
export function normalizeHostEntry(raw: unknown): FsDirEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || typeof r.name !== "string") return null;
  return {
    path: r.path,
    name: r.name,
    isDir: r.isDir === true,
    size: typeof r.size === "number" ? r.size : 0,
    mtimeMs: typeof r.mtimeMs === "number" ? r.mtimeMs : 0,
  };
}

/** Normalize a whole listing, dropping the unparseable — never a fabricated entry. */
export function normalizeHostDir(raw: unknown): FsDirEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FsDirEntry[] = [];
  for (const item of raw) {
    const e = normalizeHostEntry(item);
    if (e) out.push(e);
  }
  return out;
}
