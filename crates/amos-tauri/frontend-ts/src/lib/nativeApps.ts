/**
 * nativeApps.ts — typed bridge to the desktop **native application** surfaces:
 * Windows apps that Wine can run (`wine_*`) and native Linux desktop apps
 * (`linux_*`).
 *
 * Trust boundary, mirrored from Rust: the WebView only ever names an **id the host
 * itself enumerated**. `nativeLaunch` re-derives nothing and passes no path — Rust
 * re-scans, refuses an unknown id, and runs the program its own listing produced.
 * Before this module existed the commands took an `exe_path` / `exec` string from
 * the caller, i.e. any script in any WebView (third-party web bundles run in one)
 * could ask the host to execute an arbitrary path.
 *
 * Every normalizer here is **total** (never throws): a malformed payload degrades to
 * "no apps", which the screen shows as an honest empty state rather than a crash or
 * an invented row.
 */
import { invoke, bridgeDiag } from "./backend";
import { amosWarn } from "./debugLog";

/** Which surface an app came from (also the launch channel). */
export type NativeAppKind = "wine" | "linux";

/** One application the host found, normalized for display. */
export interface NativeApp {
  kind: NativeAppKind;
  id: string;
  name: string;
  /** The program the host would run — shown for diagnosis, never sent back. */
  program: string;
  /** The entry file the host read it from (or `""`). */
  entryPath: string;
}

/** What the host can actually offer on this machine. */
export interface NativeAvailability {
  /** `wine` is on `PATH`. */
  wine: boolean;
  /** The host itself is Linux (Linux apps only exist there). */
  linux: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** Normalize the `wine_apps` reply. Unknown rows are dropped **and reported**. */
export function normalizeWineApps(raw: unknown): NativeApp[] {
  if (!Array.isArray(raw)) return [];
  const out: NativeApp[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const row = asRecord(entry);
    const id = asString(row?.["id"]);
    const name = asString(row?.["name"]);
    if (id === "" || name === "") {
      dropped += 1;
      continue;
    }
    out.push({
      kind: "wine",
      id,
      name,
      program: asString(row?.["exePath"]),
      entryPath: asString(row?.["desktopPath"]),
    });
  }
  if (dropped > 0) {
    amosWarn("nativeapps", "wine listing had rows without an id/name", { dropped });
  }
  return out;
}

/** Normalize the `linux_apps` reply. Unknown rows are dropped **and reported**. */
export function normalizeLinuxApps(raw: unknown): NativeApp[] {
  if (!Array.isArray(raw)) return [];
  const out: NativeApp[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const row = asRecord(entry);
    const id = asString(row?.["id"]);
    const name = asString(row?.["name"]);
    if (id === "" || name === "") {
      dropped += 1;
      continue;
    }
    const args = Array.isArray(row?.["args"])
      ? (row["args"] as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    const program = asString(row?.["exec"]);
    out.push({
      kind: "linux",
      id,
      name,
      program: args.length > 0 ? `${program} ${args.join(" ")}` : program,
      entryPath: asString(row?.["desktopPath"]),
    });
  }
  if (dropped > 0) {
    amosWarn("nativeapps", "linux listing had rows without an id/name", { dropped });
  }
  return out;
}

/**
 * What this host can offer. `null` when the bridge did not answer at all (not
 * running inside AmOS) — the screen then says so instead of claiming "no apps".
 */
export async function nativeAvailability(): Promise<NativeAvailability | null> {
  const wine = await invoke<boolean>("wine_is_available");
  const linux = await invoke<boolean>("linux_is_available");
  if (wine === null && linux === null) return null;
  return { wine: wine === true, linux: linux === true };
}

/**
 * The host's own listings, merged. `null` when neither command answered (no bridge);
 * `[]` means the host answered and found nothing — two different states the screen
 * must not conflate.
 */
export async function nativeApps(): Promise<NativeApp[] | null> {
  const [wine, linux] = await Promise.all([
    invoke<unknown>("wine_apps"),
    invoke<unknown>("linux_apps"),
  ]);
  if (wine === null && linux === null) return null;
  return [...normalizeWineApps(wine), ...normalizeLinuxApps(linux)];
}

/**
 * The Tauri command that launches one enumerated app kind.
 *
 * Exported so a caller can ask `bridgeDiag(...)` about **its own** launch instead of the
 * bridge's global last-outcome slot (which any other command can overwrite — REQ-A296).
 */
export function launchCommand(kind: NativeAppKind): string {
  return kind === "wine" ? "wine_launch" : "linux_launch";
}

/**
 * Launch one enumerated app. Returns the display name on success, `null` on any
 * refusal (unknown id, no Wine, not a Linux host, spawn failure) — the caller shows
 * the reason via `lastFailureReason(launchCommand(kind))`.
 */
export async function nativeLaunch(kind: NativeAppKind, id: string): Promise<string | null> {
  if (id === "") return null;
  return invoke<string>(launchCommand(kind), { id });
}

/**
 * Why *that command's* last call failed, as text the screen can show.
 *
 * `invoke` collapses every failure into `null` (by design — callers keep a simple
 * contract), while `bridgeDiag(command)` keeps that command's root cause. Returning it as
 * a string here is what lets the screen say "not running inside AmOS" or the host's own
 * refusal sentence ("no Linux app with id 'x' is installed") instead of a shrug.
 * `""` when that command's last call was fine (or was never made).
 *
 * The command is **required** on purpose: reading the bridge's global slot here meant an
 * unrelated command finishing in between could be reported as this launch's reason.
 */
export function lastFailureReason(command: string): string {
  const d = bridgeDiag(command);
  if (d.ok) return "";
  if (d.kind === "not-bridged") return "not-bridged";
  const detail: unknown = d.detail;
  // Tauri rejects a `Result::Err(String)` with the string itself, which is the
  // useful case (the host's own sentence). Anything else still usually has a
  // message — show that rather than a shrug.
  if (typeof detail === "string" && detail !== "") return detail;
  if (detail instanceof Error && detail.message !== "") return detail.message;
  return "command-failed";
}
