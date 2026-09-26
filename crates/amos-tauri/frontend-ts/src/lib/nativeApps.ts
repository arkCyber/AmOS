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

/**
 * What the host can actually offer on this machine — **per kind**, so a probe the host
 * did not answer stays `null` instead of becoming a claim about the machine.
 *
 * The whole-read `null` (no bridge at all) is not enough: `wine_is_available` and
 * `linux_is_available` are two commands, and one can be refused while the other answers.
 * A folded `false` there is not neutral — the screen renders it as 「本机没有安装 Wine」 ∕
 * 「当前宿主不是 Linux」, a positive statement about the host's PATH and OS (REQ-A1363 /
 * F-SH-627). Same rule the sibling listing read carries (`NativeAppsRead`), for the same
 * reason.
 */
export type NativeAvailability = Record<NativeAppKind, boolean | null>;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * One row of the `wine_apps` reply **as it comes off the wire** (`wine::WineApp`).
 *
 * Declared for the wire audit rather than for this module's runtime (REQ-A555): the
 * normalizer below is deliberately `unknown`-in, because a malformed row must degrade to
 * "no app", but the *reply type* is a fact about the host and `scripts/tauri-reply-scan.mjs`
 * can only compare it when the `invoke<T>` generic names it. The spellings are the host's:
 * that struct sets `rename_all = "camelCase"`, so `exe_path`/`desktop_path` arrive as
 * `exePath`/`desktopPath` — and those two are exactly what the normalizer reads, which is
 * why a Rust-side rename would now fail a gate instead of silently emptying the list.
 *
 * Not exported: nothing outside this module needs it, and an unused export is what
 * `frontend-ts/scripts/unwired-scan.mjs` reports.
 */
interface WineAppWire {
  id: string;
  name: string;
  /** Windows-style `C:\…\app.exe`, or Wine's own `/unix` path, verbatim. */
  exePath: string;
  /** The `.desktop` entry it came from; `null` when it came from an exe's parent. */
  desktopPath: string | null;
  /** The `WINEPREFIX` it belongs to, when the entry or the scan named one. */
  prefix: string | null;
}

/** One row of the `linux_apps` reply as it comes off the wire (`linux_apps::LinuxApp`). */
interface LinuxAppWire {
  id: string;
  name: string;
  /** `Icon=` — a name or a path, as written; `null` when absent. */
  icon: string | null;
  desktopPath: string;
  /** The program the host would run (`argv[0]` of `Exec=`). */
  exec: string;
  /** `Exec=`'s arguments, with `%` field codes removed. */
  args: string[];
  /** First `Categories=` token, when the entry has one. */
  category: string | null;
}

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
 * What this host can offer. `null` when the bridge did not answer **either** probe (not
 * running inside AmOS) — the screen then says so instead of claiming "no apps".
 *
 * Per kind, a refused probe is `null`, not `false` (REQ-A1363 / F-SH-627): the body used
 * to fold it with `wine === true`, so an unanswered probe reached the screen as the
 * sentence 「本机没有安装 Wine」. `false` now means only what it says — the host answered
 * *no*. A malformed non-boolean answer is still `false`, not `null`: junk is an answer,
 * and "no answer" is a different thing.
 */
export async function nativeAvailability(): Promise<NativeAvailability | null> {
  const [wine, linux] = await Promise.all([
    invoke<boolean>("wine_is_available"),
    invoke<boolean>("linux_is_available"),
  ]);
  if (wine === null && linux === null) return null;
  return {
    wine: wine === null ? null : wine === true,
    linux: linux === null ? null : linux === true,
  };
}

/**
 * The host's own listings, **per kind** (REQ-A836 / F-SH-266).
 *
 * `[]` for a kind means the host answered and found nothing there; `null` means the
 * host did not answer *that* enumeration. Those are different claims and the screen
 * words them differently. The merged form this used to return could not carry the
 * difference — `[...normalizeWineApps(wine), ...normalizeLinuxApps(linux)]` turned a
 * refused half into an empty half inside the same array, so a partial refusal reached
 * the screen as 「Wine 已安装，但它的前缀里没有可启动的 Windows 应用」. The doc
 * directly above already stated the rule that the body broke.
 *
 * `null` for the whole read only when **neither** command answered (no bridge at all),
 * which is what lets the screen keep its separate "not running inside AmOS" state.
 */
export type NativeAppsRead = Record<NativeAppKind, NativeApp[] | null>;

export async function nativeApps(): Promise<NativeAppsRead | null> {
  const [wine, linux] = await Promise.all([
    invoke<WineAppWire[]>("wine_apps"),
    invoke<LinuxAppWire[]>("linux_apps"),
  ]);
  if (wine === null && linux === null) return null;
  return {
    wine: wine === null ? null : normalizeWineApps(wine),
    linux: linux === null ? null : normalizeLinuxApps(linux),
  };
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
