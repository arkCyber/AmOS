/**
 * devcare.ts — typed bridge to the Tauri `devcare_*` commands (手机管家) plus the
 * pure normalizers the screen uses.
 *
 * Wire shapes mirror `crates/amos-tauri/src/devcare.rs`. Every normalizer is
 * **total** (never throws): a malformed payload degrades to an empty/unknown view
 * instead of crashing the screen. The `devcare*` wrappers return `null` when not
 * bridged (or when the command failed) so the UI shows an honest state rather
 * than a fabricated one — see `bridgeDiag()` for the root cause.
 *
 * Invariant mirrored from Rust: the WebView only ever names **category keys**,
 * never a path. `devcareClean` re-plans inside Rust from the bridge's own scan.
 */
import { invoke } from "./backend";

/** The junk categories the domain models (mirror of the Rust `JunkKind` tags). */
export const JUNK_KINDS = [
  "app_cache",
  "apk_installer",
  "log_file",
  "temp_file",
  "thumbnail",
  "crash_dump",
  "empty_dir",
  "stale_download",
] as const;
export type JunkKindKey = (typeof JUNK_KINDS)[number];

/** The sensitive resources the review can mention (mirror of `SensitiveResource`). */
export const SENSITIVE_RESOURCES = [
  "microphone",
  "camera",
  "location",
  "contacts",
  "storage",
  "sms",
  "phone",
] as const;
export type ResourceKey = (typeof SENSITIVE_RESOURCES)[number];

export type CareAreaKey = "storage" | "apps" | "battery" | "permissions";
export type SeverityKey = "info" | "suggestion" | "warning" | "critical";

const JUNK_I18N: Record<JunkKindKey, string> = {
  app_cache: "care.junk.appCache",
  apk_installer: "care.junk.apkInstaller",
  log_file: "care.junk.logFile",
  temp_file: "care.junk.tempFile",
  thumbnail: "care.junk.thumbnail",
  crash_dump: "care.junk.crashDump",
  empty_dir: "care.junk.emptyDir",
  stale_download: "care.junk.staleDownload",
};

const AREA_I18N: Record<CareAreaKey, string> = {
  storage: "care.area.storage",
  apps: "care.area.apps",
  battery: "care.area.battery",
  permissions: "care.area.permissions",
};

const SEVERITY_I18N: Record<SeverityKey, string> = {
  info: "care.severity.info",
  suggestion: "care.severity.suggestion",
  warning: "care.severity.warning",
  critical: "care.severity.critical",
};

const RESOURCE_I18N: Record<ResourceKey, string> = {
  microphone: "perm.cap.microphone",
  camera: "perm.cap.camera",
  location: "perm.cap.location",
  contacts: "perm.cap.contacts",
  storage: "perm.cap.storage",
  sms: "perm.cap.sms",
  phone: "perm.cap.phone",
};

const OP_I18N: Record<string, string> = {
  "devcare.clean": "care.op.clean",
  "devcare.clean.item": "care.op.cleanItem",
  "app.uninstall": "care.op.uninstall",
  "devcare.boost": "care.op.boost",
  "devcare.boost.item": "care.op.boostItem",
};

const OUTCOME_I18N: Record<string, string> = {
  success: "care.outcome.success",
  granted: "care.outcome.granted",
  denied: "care.outcome.denied",
  rejected: "care.outcome.rejected",
  error: "care.outcome.error",
};

/** i18n key for an audit op (an unknown op falls back, never renders raw). */
export function opLabelKey(op: string): string {
  return OP_I18N[op] ?? "care.op.unknown";
}

/** i18n key for an audit outcome. */
export function outcomeLabelKey(outcome: string): string {
  return OUTCOME_I18N[outcome] ?? "care.outcome.unknown";
}

/** i18n key for a junk category tag (unknown tags fall back honestly). */
export function junkKindLabelKey(kind: string): string {
  return JUNK_I18N[kind as JunkKindKey] ?? "care.junk.unknown";
}

/** i18n key for a care area tag. */
export function areaLabelKey(area: string): string {
  return AREA_I18N[area as CareAreaKey] ?? "care.area.unknown";
}

/** i18n key for a severity tag. */
export function severityLabelKey(severity: string): string {
  return SEVERITY_I18N[severity as SeverityKey] ?? "care.severity.unknown";
}

/** i18n key for a sensitive-resource tag. */
export function resourceLabelKey(resource: string): string {
  return RESOURCE_I18N[resource as ResourceKey] ?? "perm.cap.unknown";
}

export interface DevCareStatusView {
  available: boolean;
  backend: string;
  root: string | null;
  can_clean: boolean;
  scanned_items: number;
  unreadable_dirs: number;
  last_error: string | null;
}

export interface JunkGroupView {
  kind: string;
  count: number;
  bytes: number;
}

export interface JunkReportView {
  groups: JunkGroupView[];
  total_items: number;
  total_bytes: number;
  reclaimable_bytes: number;
  review_bytes: number;
}

export interface ScanView {
  status: DevCareStatusView;
  report: JunkReportView;
  auto_kinds: string[];
  review_kinds: string[];
}

/**
 * The storage overview (「总 / 已用 / 可回收」+ category breakdown).
 *
 * `measured: false` means the backend could not read the device filesystem, so
 * every byte total is `null` and the UI **must** render "—" rather than `0 B`.
 * The `groups` rows always come from the bridge's own scan snapshot.
 */
export interface StorageView {
  total_bytes: number | null;
  used_bytes: number | null;
  free_bytes: number | null;
  /** 0–100; `null` unless total and used are both known. */
  used_pct: number | null;
  /** Whether the filesystem totals were actually read. */
  measured: boolean;
  backend: string;
  groups: JunkGroupView[];
  reclaimable_bytes: number;
  review_bytes: number;
}

export interface CleanFailureView {
  uri: string;
  kind: string;
  message: string;
}

/** Whether an action reached the daemon's unified audit trail. */
export interface AuditStatusView {
  /** Records the daemon confirmed persisted. */
  recorded: number;
  /** Records the bridge asked the daemon to persist. */
  attempted: number;
  /** Why not everything was persisted (`null` when all were). */
  reason: string | null;
}

export interface CleanView {
  planned_items: number;
  planned_bytes: number;
  freed_bytes: number;
  removed: number;
  failed: number;
  partial: boolean;
  failures: CleanFailureView[];
  audit: AuditStatusView;
}

/** The outcome of an uninstall driven through the device-care policy. */
export interface UninstallView {
  id: string;
  /** True only when the app was actually removed. */
  removed: boolean;
  /**
   * True when a removal **request** reached the platform (Android
   * `ACTION_DELETE`) but the platform confirms it asynchronously — the app is not
   * known to be gone, so the UI must say "waiting for confirmation".
   */
  launched: boolean;
  /** `allowed` | `system_app` | `protected` | `unknown`. */
  verdict: string;
  /** i18n key for the refusal reason (`null` when removed). */
  reason_key: string | null;
  /** Non-localized diagnostic (refused / not installed / backend error). */
  message: string;
  audit: AuditStatusView;
}

export interface AppView {
  id: string;
  name: string;
  system: boolean;
  /** Declared package size; `null` = unknown (never fabricated as `0`). */
  size_bytes: number | null;
  /** `allowed` | `system_app` | `protected` (or `unknown` for a bad payload). */
  verdict: string;
  reason_key: string | null;
}

export interface PermRowView {
  app_id: string;
  resources: string[];
}

/** One app the governor holds in a reclaimable tier. */
export interface MemoryAppView {
  id: string;
  /** `cached` | `background`. */
  state: string;
}

/** The memory view a「内存加速」card renders. */
export interface MemoryView {
  total_bytes: number | null;
  available_bytes: number | null;
  /** Cached before background (domain policy); protected tiers never appear. */
  reclaimable: MemoryAppView[];
  /** The governor's current energy sensor mode, when reported. */
  mode: string | null;
  /** False ⇒ the governor could not be **asked** (not "nothing to reclaim"). */
  governor: boolean;
}

/** One app a boost could not reclaim. */
export interface BoostFailureView {
  id: string;
  message: string;
}

/** What a boost asked for, and the readings around it. */
export interface BoostView {
  requested: string[];
  reclaimed: number;
  failures: BoostFailureView[];
  available_before: number | null;
  available_after: number | null;
  /** False ⇒ the governor was unreachable and nothing was requested. */
  governor: boolean;
  /** Whether the boost reached the daemon's unified audit trail. */
  audit: AuditStatusView;
}

export interface PermReviewView {
  rows: PermRowView[];
  /** `daemon` when the rows came from the authority; else `unavailable`. */
  authority: string;
}

/** One entry of the unified audit trail. */
export interface TrailEntryView {
  ts: number;
  op: string;
  resource: string;
  outcome: string;
  details: string;
}

/** A window of the unified durable trail. */
export interface TrailView {
  entries: TrailEntryView[];
  /**
   * False when the daemon has **no durable sink**: the trail cannot exist, so an
   * empty `entries` must not be read as "nothing ever happened".
   */
  durable: boolean;
}

export interface FindingView {
  area: string;
  severity: string;
  /** A ready-to-use i18n key (the domain emits stable keys). */
  key: string;
  detail: string | null;
  reclaimable_bytes: number;
}

export interface ReportView {
  score: number;
  grade: string;
  findings: FindingView[];
  /** The areas that were actually observed. Empty ⇒ show "unknown", not "100". */
  assessed: string[];
}

/* ------------------------------ normalizers ------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
/** A finite number, or `null` when absent/unusable (never a fabricated 0). */
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const bool = (v: unknown, d = false): boolean => (typeof v === "boolean" ? v : d);
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function normalizeStatus(raw: unknown): DevCareStatusView {
  const s = isObj(raw) ? raw : {};
  return {
    available: bool(s.available),
    backend: str(s.backend, "none"),
    root: strOrNull(s.root),
    can_clean: bool(s.can_clean),
    scanned_items: num(s.scanned_items),
    unreadable_dirs: num(s.unreadable_dirs),
    last_error: strOrNull(s.last_error),
  };
}

export function normalizeJunkReport(raw: unknown): JunkReportView {
  const r = isObj(raw) ? raw : {};
  const groups: JunkGroupView[] = Array.isArray(r.groups)
    ? r.groups
        .filter(isObj)
        // A group we cannot even *name* is dropped, not shown as a fabricated
        // "unknown" row. A well-formed but unrecognized tag is kept, and the
        // label mapper renders it as "other".
        .filter((g) => typeof g.kind === "string" && g.kind.length > 0)
        .map((g) => ({
          kind: g.kind as string,
          count: num(g.count),
          bytes: num(g.bytes),
        }))
    : [];
  return {
    groups,
    total_items: num(r.total_items),
    total_bytes: num(r.total_bytes),
    reclaimable_bytes: num(r.reclaimable_bytes),
    review_bytes: num(r.review_bytes),
  };
}

/** `null` when the payload is not an object (i.e. the scan did not happen). */
export function normalizeScan(raw: unknown): ScanView | null {
  if (!isObj(raw)) return null;
  return {
    status: normalizeStatus(raw.status),
    report: normalizeJunkReport(raw.report),
    auto_kinds: strArr(raw.auto_kinds),
    review_kinds: strArr(raw.review_kinds),
  };
}

/**
 * Normalize the storage overview. `null` when the payload is not an object
 * (i.e. the command never reached a backend).
 *
 * A payload that claims `measured: false` degrades **every** byte total to
 * `null`, so a backend that cannot measure can never render as `0 B`.
 */
export function normalizeStorage(raw: unknown): StorageView | null {
  if (!isObj(raw)) return null;
  const measured = bool(raw.measured);
  return {
    total_bytes: measured ? numOrNull(raw.total_bytes) : null,
    used_bytes: measured ? numOrNull(raw.used_bytes) : null,
    free_bytes: measured ? numOrNull(raw.free_bytes) : null,
    used_pct: measured ? numOrNull(raw.used_pct) : null,
    measured,
    backend: str(raw.backend, "none"),
    // The category rows share the scan report's shape.
    groups: normalizeJunkReport(raw).groups,
    reclaimable_bytes: num(raw.reclaimable_bytes),
    review_bytes: num(raw.review_bytes),
  };
}

export function normalizeClean(raw: unknown): CleanView | null {
  if (!isObj(raw)) return null;
  const failures: CleanFailureView[] = Array.isArray(raw.failures)
    ? raw.failures.filter(isObj).map((f) => ({
        uri: str(f.uri),
        kind: str(f.kind, "unknown"),
        message: str(f.message),
      }))
    : [];
  return {
    planned_items: num(raw.planned_items),
    planned_bytes: num(raw.planned_bytes),
    freed_bytes: num(raw.freed_bytes),
    removed: num(raw.removed),
    failed: num(raw.failed),
    partial: bool(raw.partial),
    failures,
    audit: normalizeAudit(raw.audit),
  };
}

/** Total: a malformed audit payload degrades to "nothing recorded". */
export function normalizeAudit(raw: unknown): AuditStatusView {
  const a = isObj(raw) ? raw : {};
  return {
    recorded: num(a.recorded),
    attempted: num(a.attempted),
    reason: strOrNull(a.reason),
  };
}

/**
 * Whether an action was **fully** recorded in the daemon's audit trail.
 *
 * `false` (including for an absent status) means the UI must not imply a trail:
 * the honest wording is "not recorded".
 */
export function auditComplete(a: AuditStatusView | null | undefined): boolean {
  return !!a && a.attempted > 0 && a.recorded === a.attempted;
}

export function normalizeUninstall(raw: unknown): UninstallView {
  const u = isObj(raw) ? raw : {};
  return {
    id: str(u.id),
    removed: bool(u.removed),
    launched: bool(u.launched),
    verdict: str(u.verdict, "unknown"),
    reason_key: strOrNull(u.reason_key),
    message: str(u.message),
    audit: normalizeAudit(u.audit),
  };
}

export function normalizeApps(raw: unknown): AppView[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((a) => ({
    id: str(a.id),
    name: str(a.name) || str(a.id),
    system: bool(a.system),
    size_bytes: numOrNull(a.size_bytes),
    verdict: str(a.verdict, "unknown"),
    reason_key: strOrNull(a.reason_key),
  }));
}

export function normalizePermRows(raw: unknown): PermRowView[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((r) => ({
    app_id: str(r.app_id),
    resources: strArr(r.resources),
  }));
}

export function normalizeMemory(raw: unknown): MemoryView {
  const m = isObj(raw) ? raw : {};
  const reclaimable: MemoryAppView[] = Array.isArray(m.reclaimable)
    ? m.reclaimable
        .filter(isObj)
        // An app we cannot even name is dropped, not shown as a fake row.
        .filter((a) => typeof a.id === "string" && a.id.length > 0)
        .map((a) => ({ id: a.id as string, state: str(a.state, "unknown") }))
    : [];
  return {
    total_bytes: numOrNull(m.total_bytes),
    available_bytes: numOrNull(m.available_bytes),
    reclaimable,
    mode: strOrNull(m.mode),
    governor: bool(m.governor),
  };
}

export function normalizeBoost(raw: unknown): BoostView {
  const b = isObj(raw) ? raw : {};
  const failures: BoostFailureView[] = Array.isArray(b.failures)
    ? b.failures.filter(isObj).map((f) => ({
        id: str(f.id),
        message: str(f.message),
      }))
    : [];
  return {
    requested: strArr(b.requested),
    reclaimed: num(b.reclaimed),
    failures,
    available_before: numOrNull(b.available_before),
    available_after: numOrNull(b.available_after),
    governor: bool(b.governor),
    audit: normalizeAudit(b.audit),
  };
}

/** Used memory from a memory view (`null` when it cannot be derived). */
export function memUsedBytes(m: MemoryView | null): number | null {
  if (!m || m.total_bytes === null || m.available_bytes === null) return null;
  return Math.max(0, m.total_bytes - m.available_bytes);
}

/** Used memory as a 0..100 percentage (`null` when it cannot be derived). */
export function memUsedPct(m: MemoryView | null): number | null {
  const total = m?.total_bytes ?? null;
  const used = memUsedBytes(m);
  if (total === null || used === null || total <= 0) return null;
  return (used / total) * 100;
}

/** The permission review, with the authority it was read from. */
export function normalizePermReview(raw: unknown): PermReviewView {
  const r = isObj(raw) ? raw : {};
  return {
    rows: normalizePermRows(r.rows),
    authority: str(r.authority, "unavailable"),
  };
}

/**
 * Whether the review really came from the authority.
 *
 * `false` means the daemon was unreachable, so an empty `rows` must be rendered
 * as "unavailable" — never as "nothing is granted".
 */
export function permReviewAuthoritative(v: PermReviewView | null | undefined): boolean {
  return !!v && v.authority === "daemon";
}

export function normalizeTrail(raw: unknown): TrailView {
  const t = isObj(raw) ? raw : {};
  const entries: TrailEntryView[] = Array.isArray(t.records)
    ? t.records.filter(isObj).map((r) => ({
        ts: num(r.ts),
        op: str(r.op),
        resource: str(r.resource),
        outcome: str(r.outcome, "unknown"),
        details: str(r.details),
      }))
    : [];
  return { entries, durable: bool(t.durable) };
}

/** `HH:MM` in the viewer's local zone (`""` for a zero/invalid stamp). */
export function hhmm(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function normalizeReport(raw: unknown): ReportView {
  const r = isObj(raw) ? raw : {};
  const findings: FindingView[] = Array.isArray(r.findings)
    ? r.findings.filter(isObj).map((f) => ({
        area: str(f.area, "unknown"),
        severity: str(f.severity, "info"),
        key: str(f.key),
        detail: strOrNull(f.detail),
        reclaimable_bytes: num(f.reclaimable_bytes),
      }))
    : [];
  return {
    score: num(r.score),
    grade: str(r.grade, "?"),
    findings,
    assessed: strArr(r.assessed),
  };
}

/**
 * Whether a report observed anything at all.
 *
 * When this is `false` the score is vacuous (the domain still reports 100), so
 * the screen must show "no data" — never "100 / grade A".
 */
export function reportHasData(r: ReportView | null): boolean {
  return r !== null && r.assessed.length > 0;
}

/**
 * The areas a care report can assess, in the domain's `CareArea` enum order
 * (mirrors `amos-devocare`'s `CareArea`: Storage → Apps → Battery → Permissions).
 */
export const CARE_AREAS: readonly CareAreaKey[] = [
  "storage",
  "apps",
  "battery",
  "permissions",
];

/**
 * Split a report's `assessed` list into the modelled areas that **were observed**
 * and those that were **not**.
 *
 * The score is only meaningful for what was seen (`docs/devcare.md` §4.1), so a
 * *partial* report must not render as a confident grade with no hint that, say,
 * the battery was never measured — that is "unknown rendered as healthy"
 * (aerospace P0-3). Keys the screen does not model are ignored: they are reported
 * as neither observed nor missing rather than invented into one of the lists.
 */
export function careAreaSplit(r: ReportView | null): {
  observed: CareAreaKey[];
  missing: CareAreaKey[];
} {
  const seen = new Set(r?.assessed ?? []);
  return {
    observed: CARE_AREAS.filter((a) => seen.has(a)),
    missing: CARE_AREAS.filter((a) => !seen.has(a)),
  };
}

/* -------------------------------- commands ------------------------------- */

export async function devcareStatus(): Promise<DevCareStatusView | null> {
  const raw = await invoke<unknown>("devcare_status");
  return raw === null ? null : normalizeStatus(raw);
}

/** Re-scan the backend. `null` ⇒ not bridged / no backend / the command failed. */
export async function devcareScan(): Promise<ScanView | null> {
  const raw = await invoke<unknown>("devcare_scan");
  return raw === null ? null : normalizeScan(raw);
}

/**
 * The storage overview（总 / 已用 / 可回收 + 分类）.
 *
 * The filesystem totals come from the device backend (Android `StatFs`); when
 * nothing can measure them the view is `measured: false` with `null` totals, so
 * the card renders "—" instead of a fabricated `0 B`. `null` ⇒ not bridged.
 */
export async function devcareStorage(): Promise<StorageView | null> {
  const raw = await invoke<unknown>("devcare_storage");
  return raw === null ? null : normalizeStorage(raw);
}

/**
 * Clean the named categories. Only category **keys** are accepted — the Rust
 * side re-plans from its own scan, so a path can never reach the cleaner.
 */
export async function devcareClean(
  kinds: string[],
  acknowledgeReview: boolean,
): Promise<CleanView | null> {
  const raw = await invoke<unknown>("devcare_clean", { kinds, acknowledgeReview });
  return raw === null ? null : normalizeClean(raw);
}

/** A package as sent to `devcare_apps` (serde field names, snake_case). */
/**
 * The **bridge-owned** uninstall preview: what the manager may offer to remove.
 *
 * Takes no inventory: Rust owns it (the store registry today, the package
 * manager on a device), so this list and `devcareUninstall`'s enforcement cannot
 * disagree, and the UI cannot influence the policy. `null` ⇒ not bridged / the
 * command failed.
 */
export async function devcareApps(): Promise<AppView[] | null> {
  const raw = await invoke<unknown>("devcare_apps");
  return raw === null ? null : normalizeApps(raw);
}

/**
 * Uninstall an app through the **device-care policy** (guard first) and record
 * the attempt — including a refusal — in the daemon's unified audit trail.
 *
 * This is the path the manager uses (not `storeUninstall`) so the policy cannot
 * be bypassed and every removal is auditable. The returned `removed` is the only
 * source of truth for whether the app is gone.
 */
export async function devcareUninstall(id: string): Promise<UninstallView | null> {
  const raw = await invoke<unknown>("devcare_uninstall", { id });
  return raw === null ? null : normalizeUninstall(raw);
}

/**
 * Fold grant observations into the read-only review rows.
 *
 * The data is the **daemon's** (the authority for grants); the UI supplies
 * nothing, and deny-by-default means its answer is the truth. `null` ⇒ not
 * bridged. `authority: "unavailable"` ⇒ the daemon was unreachable, which is
 * **not** the same as "nothing is granted".
 */
export async function devcarePermissions(): Promise<PermReviewView | null> {
  const raw = await invoke<unknown>("devcare_permissions");
  return raw === null ? null : normalizePermReview(raw);
}

/** Build the care report from this process's real observations. */
export async function devcareReport(
  sensitiveGrants: number | null,
  reviewableApps: number | null,
): Promise<ReportView | null> {
  const raw = await invoke<unknown>("devcare_report", {
    sensitiveGrants,
    reviewableApps,
  });
  return raw === null ? null : normalizeReport(raw);
}

/**
 * The **read side** of the audit loop: the device-care slice of the daemon's
 * unified durable trail (filtered by the actor in Rust).
 *
 * `null` ⇒ not bridged / the daemon is unreachable. `durable: false` ⇒ the
 * daemon has no durable sink, so an empty list means "no trail exists", not
 * "nothing ever happened".
 */
export async function devcareTrail(limit = 20): Promise<TrailView | null> {
  const raw = await invoke<unknown>("devcare_trail", { limit });
  return raw === null ? null : normalizeTrail(raw);
}

/**
 * The memory view for the「内存加速」card (sampler reading + the governor's
 * reclaim target list). `null` ⇒ not bridged.
 */
export async function devcareMemory(): Promise<MemoryView | null> {
  const raw = await invoke<unknown>("devcare_memory");
  return raw === null ? null : normalizeMemory(raw);
}

/**
 * Ask the governor to reclaim its cached/background apps.
 *
 * The manager only **requests**: the governor owns every lifecycle transition,
 * and the result reports what it accepted (`requested`/`reclaimed`/`failures`)
 * plus the readings around it. `null` ⇒ not bridged.
 */
export async function devcareBoost(): Promise<BoostView | null> {
  const raw = await invoke<unknown>("devcare_boost");
  return raw === null ? null : normalizeBoost(raw);
}

/* --------------------------- request validation --------------------------- */

/**
 * Client-side guard mirroring the Rust policy, so the UI does not fire a request
 * the backend would refuse.
 *
 * Returns an i18n key describing the problem, or `null` when the request is
 * well-formed. This is a *convenience*, not the security boundary — Rust still
 * validates (its `plan` refuses unknown and unacknowledged review kinds) and is
 * the only authority.
 */
export function validateCleanRequest(
  kinds: string[],
  acknowledgeReview: boolean,
): string | null {
  if (kinds.length === 0) return "care.err.noSelection";
  const known = new Set<string>(JUNK_KINDS);
  if (kinds.some((k) => !known.has(k))) return "care.err.unknownKind";
  // `stale_download` is review-only: it needs the explicit acknowledgement.
  if (kinds.includes("stale_download") && !acknowledgeReview) return "care.err.needsReview";
  return null;
}
