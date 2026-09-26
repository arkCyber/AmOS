/**
 * Push Notifications Service - APNs-compatible architecture
 *
 * Provides remote push notification capabilities similar to Apple Push Notification
 * service (APNs), including device registration, token management, notification
 * delivery, and badge management. Designed for aerospace-grade reliability.
 *
 * Architecture:
 * - Device Token Management: Register/unregister for remote notifications
 * - Notification Delivery: Receive and process remote push payloads
 * - Badge Management: App icon badge counts with persistence
 * - Background Processing: Handle notifications in background/foreground
 * - Silent Notifications: Background content updates without alerts
 * - Priority Handling: Critical alerts and time-sensitive notifications
 */
import { bridgeDiag, invoke } from "./backend";
import { localId } from "./localId";
import type { Notif } from "./settings";

/** Device token for remote push notifications (64 hex chars in production). */
export type DeviceToken = string;

/** Push notification priority levels (mirrors APNs priority). */
export type PushPriority = "high" | "normal" | "low";

/** Notification presentation options (when app is foreground). */
export interface NotificationPresentationOptions {
  /** Show banner/alert. */
  alert?: boolean;
  /** Play sound. */
  sound?: boolean;
  /** Update badge count. */
  badge?: boolean;
}

/** Remote notification payload (APNs-compatible aps structure). */
export interface PushPayload {
  /** APNs standard payload. */
  aps: {
    /** Alert content. */
    alert?: {
      title?: string;
      subtitle?: string;
      body?: string;
    } | string;
    /** Badge count (absolute value or increment). */
    badge?: number;
    /** Sound identifier or default. */
    sound?: string | { name: string; volume?: number };
    /** Category for actionable notifications. */
    category?: string;
    /** Thread identifier for grouping. */
    "thread-id"?: string;
    /** Content available for silent push. */
    "content-available"?: 1;
    /** Mutable content for notification service extensions. */
    "mutable-content"?: 1;
  };
  /** Custom data payload (app-specific). */
  [key: string]: unknown;
}

/** Notification delivery metadata. */
export interface NotificationMetadata {
  /** Unique notification identifier. */
  id: string;
  /** Delivery timestamp (ms since epoch). */
  timestamp: number;
  /** Priority level. */
  priority: PushPriority;
  /** Whether delivered while app was in foreground. */
  foreground: boolean;
  /** Expiration time (ms since epoch, null = no expiry). */
  expiry: number | null;
}

/** Complete notification record with payload and metadata. */
export interface PushNotification {
  payload: PushPayload;
  metadata: NotificationMetadata;
}

/** Device registration status. */
export interface RegistrationStatus {
  /** Whether device is registered for remote notifications. */
  registered: boolean;
  /** Device token (null if not registered). */
  token: DeviceToken | null;
  /** Registration timestamp (ms since epoch, 0 if never registered). */
  registeredAt: number;
  /** Last registration error (null if no error). */
  error: string | null;
}

/** Badge count state for an app. */
export interface AppBadgeState {
  /** Application bundle identifier. */
  appId: string;
  /** Current badge count. */
  count: number;
  /** Last update timestamp (ms since epoch). */
  updatedAt: number;
}

/** Push notification statistics. */
export interface PushStatistics {
  /** Total notifications received. */
  totalReceived: number;
  /** Notifications received while foreground. */
  foregroundReceived: number;
  /** Notifications received while background. */
  backgroundReceived: number;
  /** Silent push notifications (content-available). */
  silentPushReceived: number;
  /** Failed deliveries. */
  failedDeliveries: number;
  /** Last notification timestamp (ms since epoch, 0 if none). */
  lastNotificationAt: number;
}

/** Push notification service configuration. */
export interface PushServiceConfig {
  /** Enable/disable push notifications. */
  enabled: boolean;
  /** Enable badge management. */
  badgeEnabled: boolean;
  /** Enable sound for notifications. */
  soundEnabled: boolean;
  /** Maximum notifications to keep in history. */
  maxHistorySize: number;
  /** Enable background fetch for silent push. */
  backgroundFetchEnabled: boolean;
  /** Auto-register on app launch. */
  autoRegister: boolean;
}

/** Default push service configuration. */
export const DEFAULT_PUSH_CONFIG: PushServiceConfig = {
  enabled: true,
  badgeEnabled: true,
  soundEnabled: true,
  maxHistorySize: 100,
  backgroundFetchEnabled: true,
  autoRegister: false,
};

/** Maximum notification history size (hard cap for safety). */
export const MAX_NOTIFICATION_HISTORY = 500;

/** Device token validation regex (64 hex characters for production). */
const DEVICE_TOKEN_REGEX = /^[0-9a-f]{64}$/i;

/**
 * Validate device token format.
 * Production tokens are 64 hex characters; sandbox tokens may vary.
 */
export function isValidDeviceToken(token: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  // Production tokens: 64 hex chars; sandbox tokens: typically 32+ hex chars
  if (token.length === 64) return DEVICE_TOKEN_REGEX.test(token);
  // Accept shorter sandbox/test tokens (minimum 32 chars, all hex)
  return token.length >= 32 && token.length < 64 && /^[0-9a-f]+$/i.test(token);
}

/**
 * Generate a mock device token for testing (NOT for production).
 * Production tokens come from APNs registration.
 */
export function generateMockDeviceToken(): DeviceToken {
  const hex = "0123456789abcdef";
  let token = "";
  for (let i = 0; i < 64; i++) {
    token += hex[Math.floor(Math.random() * 16)];
  }
  return token;
}

/**
 * Parse APNs payload from raw data.
 * Handles both JSON string and pre-parsed object.
 */
export function parsePushPayload(raw: unknown): PushPayload | null {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const payload = obj as Record<string, unknown>;
    // Must have aps dictionary
    if (!payload.aps || typeof payload.aps !== "object" || Array.isArray(payload.aps)) return null;
    return payload as PushPayload;
  } catch {
    return null;
  }
}

/**
 * Extract badge count from push payload.
 * Returns null if no badge specified or invalid.
 */
export function extractBadge(payload: PushPayload): number | null {
  const badge = payload.aps.badge;
  if (typeof badge !== "number" || !Number.isFinite(badge) || badge < 0) return null;
  return Math.floor(badge);
}

/**
 * Extract alert text from push payload.
 * Handles both string and structured alert formats.
 */
export function extractAlertText(payload: PushPayload): { title?: string; body?: string } | null {
  const alert = payload.aps.alert;
  if (!alert) return null;
  if (typeof alert === "string") {
    return { body: alert };
  }
  if (typeof alert === "object" && !Array.isArray(alert)) {
    const a = alert as Record<string, unknown>;
    const result: { title?: string; body?: string } = {};
    if (typeof a.title === "string") result.title = a.title;
    if (typeof a.body === "string") result.body = a.body;
    if (typeof a.subtitle === "string") result.title = `${result.title ?? ""}${result.title ? " " : ""}${a.subtitle}`.trim();
    return Object.keys(result).length > 0 ? result : null;
  }
  return null;
}

/**
 * Check if payload is a silent push (background content-available).
 */
export function isSilentPush(payload: PushPayload): boolean {
  return payload.aps["content-available"] === 1 && !payload.aps.alert && !payload.aps.sound;
}

/**
 * Check if payload has mutable content (requires notification service extension).
 */
export function hasMutableContent(payload: PushPayload): boolean {
  return payload.aps["mutable-content"] === 1;
}

/**
 * Normalize push service configuration.
 * Provides defaults and validates bounds.
 */
export function normalizePushConfig(raw: unknown): PushServiceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_PUSH_CONFIG;
  const c = raw as Record<string, unknown>;
  return {
    enabled: typeof c.enabled === "boolean" ? c.enabled : DEFAULT_PUSH_CONFIG.enabled,
    badgeEnabled: typeof c.badgeEnabled === "boolean" ? c.badgeEnabled : DEFAULT_PUSH_CONFIG.badgeEnabled,
    soundEnabled: typeof c.soundEnabled === "boolean" ? c.soundEnabled : DEFAULT_PUSH_CONFIG.soundEnabled,
    maxHistorySize:
      typeof c.maxHistorySize === "number" && Number.isFinite(c.maxHistorySize) && c.maxHistorySize > 0
        ? Math.min(Math.floor(c.maxHistorySize), MAX_NOTIFICATION_HISTORY)
        : DEFAULT_PUSH_CONFIG.maxHistorySize,
    backgroundFetchEnabled:
      typeof c.backgroundFetchEnabled === "boolean" ? c.backgroundFetchEnabled : DEFAULT_PUSH_CONFIG.backgroundFetchEnabled,
    autoRegister: typeof c.autoRegister === "boolean" ? c.autoRegister : DEFAULT_PUSH_CONFIG.autoRegister,
  };
}

/**
 * Normalize registration status from storage.
 */
export function normalizeRegistrationStatus(raw: unknown): RegistrationStatus {
  const defaults: RegistrationStatus = {
    registered: false,
    token: null,
    registeredAt: 0,
    error: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const r = raw as Record<string, unknown>;
  const token = typeof r.token === "string" && isValidDeviceToken(r.token) ? r.token : null;
  return {
    registered: typeof r.registered === "boolean" ? r.registered : !!token,
    token,
    registeredAt:
      typeof r.registeredAt === "number" && Number.isFinite(r.registeredAt) && r.registeredAt >= 0
        ? r.registeredAt
        : defaults.registeredAt,
    error: typeof r.error === "string" ? r.error : null,
  };
}

/**
 * Normalize app badge state from storage.
 */
export function normalizeAppBadgeState(raw: unknown): AppBadgeState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.appId !== "string" || b.appId === "") return null;
  return {
    appId: b.appId,
    count: typeof b.count === "number" && Number.isFinite(b.count) && b.count >= 0 ? Math.floor(b.count) : 0,
    updatedAt:
      typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) && b.updatedAt >= 0 ? b.updatedAt : Date.now(),
  };
}

/**
 * Normalize push notification from storage.
 */
export function normalizePushNotification(raw: unknown): PushNotification | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const n = raw as Record<string, unknown>;
  const payload = parsePushPayload(n.payload);
  if (!payload) return null;
  if (!n.metadata || typeof n.metadata !== "object" || Array.isArray(n.metadata)) return null;
  const m = n.metadata as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id === "") return null;
  if (typeof m.timestamp !== "number" || !Number.isFinite(m.timestamp) || m.timestamp <= 0) return null;
  return {
    payload,
    metadata: {
      id: m.id,
      timestamp: m.timestamp,
      priority: ["high", "normal", "low"].includes(m.priority as string) ? (m.priority as PushPriority) : "normal",
      foreground: typeof m.foreground === "boolean" ? m.foreground : false,
      expiry:
        m.expiry === null || (typeof m.expiry === "number" && Number.isFinite(m.expiry) && m.expiry > 0)
          ? (m.expiry as number | null)
          : null,
    },
  };
}

/**
 * Normalize push statistics from storage.
 */
export function normalizePushStatistics(raw: unknown): PushStatistics {
  const defaults: PushStatistics = {
    totalReceived: 0,
    foregroundReceived: 0,
    backgroundReceived: 0,
    silentPushReceived: 0,
    failedDeliveries: 0,
    lastNotificationAt: 0,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const s = raw as Record<string, unknown>;
  const safeCount = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  return {
    totalReceived: safeCount(s.totalReceived),
    foregroundReceived: safeCount(s.foregroundReceived),
    backgroundReceived: safeCount(s.backgroundReceived),
    silentPushReceived: safeCount(s.silentPushReceived),
    failedDeliveries: safeCount(s.failedDeliveries),
    lastNotificationAt: safeCount(s.lastNotificationAt),
  };
}

/**
 * Update badge count for an app (immutable).
 */
export function updateAppBadge(badges: AppBadgeState[], appId: string, count: number, now: number): AppBadgeState[] {
  const normalized = Math.max(0, Math.floor(count));
  const existing = badges.findIndex((b) => b.appId === appId);
  if (existing >= 0) {
    const updated = [...badges];
    updated[existing] = { appId, count: normalized, updatedAt: now };
    return updated;
  }
  return [...badges, { appId, count: normalized, updatedAt: now }];
}

/**
 * Clear badge for an app (immutable).
 */
export function clearAppBadge(badges: AppBadgeState[], appId: string): AppBadgeState[] {
  return badges.filter((b) => b.appId !== appId);
}

/**
 * Get total badge count across all apps.
 */
export function getTotalBadgeCount(badges: AppBadgeState[]): number {
  return badges.reduce((sum, b) => sum + b.count, 0);
}

/**
 * Get badge count for a specific app.
 */
export function getAppBadgeCount(badges: AppBadgeState[], appId: string): number {
  const badge = badges.find((b) => b.appId === appId);
  return badge ? badge.count : 0;
}

/**
 * Add notification to history (immutable, capped).
 */
export function addNotificationToHistory(
  history: PushNotification[],
  notification: PushNotification,
  maxSize: number,
): PushNotification[] {
  const capped = Math.min(maxSize, MAX_NOTIFICATION_HISTORY);
  return [notification, ...history].slice(0, capped);
}

/**
 * Remove expired notifications from history (immutable).
 */
export function removeExpiredNotifications(history: PushNotification[], now: number): PushNotification[] {
  return history.filter((n) => {
    if (n.metadata.expiry === null) return true;
    return n.metadata.expiry > now;
  });
}

/**
 * Update push statistics (immutable).
 */
export function updatePushStatistics(
  stats: PushStatistics,
  notification: PushNotification,
  success: boolean,
): PushStatistics {
  if (!success) {
    return {
      ...stats,
      failedDeliveries: stats.failedDeliveries + 1,
    };
  }
  return {
    ...stats,
    totalReceived: stats.totalReceived + 1,
    foregroundReceived: stats.foregroundReceived + (notification.metadata.foreground ? 1 : 0),
    backgroundReceived: stats.backgroundReceived + (notification.metadata.foreground ? 0 : 1),
    silentPushReceived: stats.silentPushReceived + (isSilentPush(notification.payload) ? 1 : 0),
    failedDeliveries: stats.failedDeliveries,
    lastNotificationAt: notification.metadata.timestamp,
  };
}

/**
 * Generate unique notification identifier.
 */
/**
 * A new notification id.
 *
 * Uses the shared `localId` (REQ-A401). The old form
 * (`` `push_${Date.now()}_${Math.random().toString(36).substring(2, 11)}` ``) is the same
 * "time + luck" family as the rest of the shell's ids, and an id here is identity: the
 * notification centre keys rows by it, and `amos.notifications` is re-read through
 * `normalizeNotifs`, which **drops duplicate ids**. The `push` prefix is kept.
 */
export function generateNotificationId(): string {
  return localId("push");
}

/**
 * Check if notification should be presented (based on config and state).
 */
export function shouldPresentNotification(
  payload: PushPayload,
  config: PushServiceConfig,
  foreground: boolean,
): NotificationPresentationOptions {
  // Silent push never presents UI
  if (isSilentPush(payload)) {
    return {};
  }
  // Background notifications always present (system handles)
  if (!foreground) {
    return {
      alert: true,
      sound: config.soundEnabled,
      badge: config.badgeEnabled,
    };
  }
  // Foreground notifications: app decides
  return {
    alert: !!payload.aps.alert,
    sound: config.soundEnabled && !!payload.aps.sound,
    badge: config.badgeEnabled && typeof payload.aps.badge === "number",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tauri Backend Integration
// ═══════════════════════════════════════════════════════════════════════════
//
// Every command below goes through **`lib/backend.ts`'s `invoke`** — the shell's
// one bridge. It used to reach for `@tauri-apps/api/core` with a top-level
// `await import(…)`: that package is **not a dependency of this workspace**, so the
// import always failed, `invoke` became an always-throwing stub, and every `push_*`
// command silently answered its empty fallback. The push backend was therefore
// never actually reachable from the UI, in any environment
// (`PUSH_PHASE3_DAY3_RESEARCH_AND_DESIGN.md` §2). `backend.invoke` returns `null`
// when the host is not bridged or the command fails, and records *why* in the
// bridge diagnostics ledger instead of throwing.

/** The `kind` tags of Rust `PushResult` (`#[serde(tag = "kind", rename_all = "lowercase")]`).
 * The array is the one declaration; {@link PushResultKind} derives from it. A rename on
 * either side is a wire break — `vocabMirror.test.ts` reads `push_notifications.rs` and
 * requires the two to agree, rather than trusting this copy (REQ-A668). */
export const PUSH_RESULT_KINDS = [
  "ok",
  "unavailable",
  "permissiondenied",
  "invalidtoken",
  "failed",
] as const;
export type PushResultKind = (typeof PUSH_RESULT_KINDS)[number];

/** Rust PushResult type — every `push_*` command answers with one of these kinds
 * instead of throwing, so "the platform said no" stays distinguishable from
 * "the call failed". Mirrors `push_notifications.rs`' published `kind` strings. */
export interface PushResult {
  kind: PushResultKind;
  reason?: string;
}

/** Rust DeviceToken type. */
export interface RustDeviceToken {
  token: string;
  environment: string;
  registered_at: string;
}

/** Rust NotificationRecord type (the shape `push_get_history` really returns:
 * `received_at` is an **ISO 8601 string**, not a millisecond number, and the
 * device's own read flag is `read` — not `is_read`). */
export interface RustNotificationRecord {
  id: string;
  payload: PushPayload;
  received_at: string;
  read: boolean;
}

/** Rust PushStatistics type (snake_case, straight from Rust). */
export interface RustPushStatistics {
  total_received: number;
  with_badge: number;
  with_sound: number;
  silent: number;
  last_received: string | null;
}

/** The variants of Rust `PermissionStatus` (`#[serde(rename_all = "lowercase")]`). The array is
 * the one declaration; {@link RustPermissionStatus} derives from it. Bound to
 * `push_notifications.rs` by `vocabMirror.test.ts` (REQ-A668). */
export const PERMISSION_STATUSES = [
  "notdetermined",
  "denied",
  "authorized",
  "provisional",
] as const;
/** Rust PermissionStatus type. */
export type RustPermissionStatus = (typeof PERMISSION_STATUSES)[number];

/**
 * The field names of Rust `PushStatus`, bound to `push_notifications.rs` by
 * `vocabMirror.test.ts` (REQ-A865).
 *
 * The interface below cannot be derived from an array (its fields have six different
 * types), so this is the census the mirror compares — added in the same round as
 * `permission_backend` because a **new wire field with no mirror is exactly how the panel
 * would go back to reading `undefined`**: `undefined` is falsy, so a rename would silently
 * hide the request button everywhere instead of failing loudly.
 */
export const PUSH_STATUS_FIELDS = [
  "available",
  "permission_backend",
  "device_token",
  "permission",
  "badge_count",
  "statistics",
] as const;

/** Rust PushStatus type. */
export interface RustPushStatus {
  available: boolean;
  /**
   * The OS API the host would ask for a push permission, or `null` when no target binds
   * one (REQ-A865 / F-DEV-116).
   *
   * **Not a second spelling of `available`.** `available` means "this device has a push
   * subsystem" — true, the host really does hold a token and a history — while this field
   * answers the button's question, "can the OS be asked". They were one `bool`, which is
   * how the panel came to draw 「允许通知」 and then print 「你现在可以接收推送通知了」 for a
   * grant nothing had issued. `null` is the honest value on every target this build can
   * produce; the panel reads it to decide whether the button may exist at all.
   */
  permission_backend: string | null;
  device_token: RustDeviceToken | null;
  permission: RustPermissionStatus;
  badge_count: number;
  statistics: RustPushStatistics;
}

/**
 * Register device token for push notifications.
 *
 * `null` = the host did not answer (no bridge, or the command was refused). It is its own
 * fact and must not be folded into a `PushResult`: the old `?? noBridge()` synthesized
 * `{ kind: "failed", reason: "push backend unreachable (no host bridge)" }` — an English
 * **cause** this module made up — and `PushSettings.askPermission` renders `reason`
 * verbatim, so a Chinese screen read 「无法申请通知权限：push backend unreachable (no host
 * bridge)」 about a request nobody ever carried out (REQ-A1352). `null` is unambiguous
 * because the Rust command answers a `PushResult` variant, never JSON `null`.
 */
export async function registerDeviceToken(token: string, environment: string = "production"): Promise<PushResult | null> {
  return await invoke<PushResult>("push_register_token", { token, environment });
}

/** Get current device token. */
export async function getDeviceToken(): Promise<RustDeviceToken | null> {
  return await invoke<RustDeviceToken>("push_get_token");
}

/**
 * Request push notification permission.
 *
 * `null` = the host did not answer (REQ-A1352). This is the sharper of the two: the panel
 * only draws its 「允许通知」 button inside `{#if pushStatus?.available}`, which is on screen
 * only because the host *did* answer with a push subsystem present — so the old
 * `?? noBridge()`'s 「no host bridge」 was a cause contradicting a fact already rendered
 * beside it. A host that really refuses answers `PushResult::Unavailable` in its own words,
 * and those words still reach the screen unchanged.
 */
export async function requestPushPermission(): Promise<PushResult | null> {
  return await invoke<PushResult>("push_request_permission");
}

/**
 * Get current permission status, or `null` when the host did not answer.
 *
 * `null` is unambiguous because `push_get_permission` answers a status *string*, never
 * JSON `null`. The old `?? "notdetermined"` folded "I could not ask" into the same value a
 * host uses for "you have not been asked yet", so a refused read drew a device state
 * (REQ-A1335 / F-SH-601 — the family `project_one_null_two_facts`).
 */
export async function getPushPermission(): Promise<RustPermissionStatus | null> {
  return await invoke<RustPermissionStatus>("push_get_permission");
}

/**
 * Simulate receiving a push notification (for testing).
 *
 * Answers the new record's id, or `null` when the host could not be reached — the
 * caller must not treat a missing id as "delivered".
 */
export async function simulateReceivePush(payload: PushPayload): Promise<string | null> {
  return await invoke<string>("push_simulate_receive", { payload });
}


/**
 * Get badge count, or `null` when the host did not answer.
 *
 * A zero badge is a *fact the host states* ("nothing is pending"); it must not be the
 * answer this reader invents when it could not ask (REQ-A1335 / F-SH-601).
 */
export async function getBadgeCount(): Promise<number | null> {
  return await invoke<number>("push_get_badge");
}

/** Set badge count. */
export async function setBadgeCount(count: number): Promise<void> {
  await invoke("push_set_badge", { count });
}

/**
 * Get notification history (newest first, as the Rust manager returns it), or `null` when
 * the host did not answer.
 *
 * The empty list and the refusal used to be one value, and they are not: `[]` is the host
 * saying "there is nothing", `null` is this reader saying "I could not ask". Callers treat
 * both as *no news* today (`svelte/osPushWatcher`), but only the second means the fetch
 * failed — and the old `?? []` made that undecidable (REQ-A1335 / F-SH-601).
 */
export async function getNotificationHistory(limit?: number): Promise<RustNotificationRecord[] | null> {
  return await invoke<RustNotificationRecord[]>("push_get_history", { limit: limit ?? null });
}

/**
 * Mark notification as read.
 *
 * `null` = the host did not answer (REQ-A1352). `false` is a real answer — "the device did
 * not mark it" — and folding the two made a command that was never carried out look like a
 * device that declined. The callers are best-effort (`void markNotificationRead(id)`), so
 * nothing renders the wrong thing today; that is a property of the callers, not of the value.
 */
export async function markNotificationRead(id: string): Promise<boolean | null> {
  return await invoke<boolean>("push_mark_read", { id });
}

/**
 * Delete one delivery from the device's push history.
 *
 * The shell's list is a *projection* of that history — `push_get_history` is asked again on
 * every poll (`svelte/osPushWatcher`) — so removing a row from the store without this leaves
 * the device still holding it, and the next poll writes it straight back.
 *
 * `false` is the device answering "I never held that id" and it is a **success** — removing
 * the row locally is right. `null` (REQ-A1352) is the other thing entirely: a command that
 * never reached the device, over which nothing about the device was established. The old
 * `?? false` merged them, and the callers then had to recover the distinction from the
 * *global* `bridgeDiag("push_delete_notification").ok` slot — a per-command ledger entry, so
 * two dismissals in flight at once could each read the other's outcome. The value is now the
 * answer, and the ledger is only the explanation.
 */
export async function deleteNotification(id: string): Promise<boolean | null> {
  return await invoke<boolean>("push_delete_notification", { id });
}

/**
 * Relay a **local** removal to the device, for every push delivery among `rows` (REQ-A1260).
 *
 * The shell's list is a projection of the device's push history, so every control that removes
 * a row has to delete it on the device too, or the next `osPushWatcher` poll writes it straight
 * back. `NotificationCenter` / `DesktopNotificationCenter` state that for `dismiss`, and the
 * settings pages for 「清空」; the three **acknowledge-on-tap** paths — the two arrival banners
 * (`NotificationBanner` / `DesktopNotificationBanner`) and the desktop panel's
 * open-the-source-app — wrote only the local store. The consequence there is worse than a row
 * returning: the reappearing id is a *new* id set for the banner's arrival detector, so the
 * delivery is announced a second time (chime + haptic) for something that never arrived twice.
 *
 * `rows` is the set about to be dropped, read **before** the local write. Fire-and-forget by
 * the same reasoning as `dismiss`: these surfaces hold a transient toast / a panel that is
 * closing, neither has a place to draw a refusal, and the failure is visible as the row coming
 * back. No host bridge ⇒ no device history and no poll to write one back, so the call is a
 * no-op exactly when it should be.
 */
export function deleteDeliveriesOnDevice(rows: readonly Notif[]): void {
  for (const row of rows) if (row.source === "push") void deleteNotification(row.id);
}

/**
 * Clear the device's push-notification history.
 *
 * `push_clear_history` answers unit (JSON `null`), which is also what the bridge produces for a
 * refusal — so the reply cannot carry the verdict and the diagnostic ledger has to (the same
 * rule `lib/dockBadge.ts` / `lib/spaces.ts` use for their unit-reply mutations). `true` only
 * when the command actually succeeded; `false` means the device **still has** the history, and a
 * caller must not report it as cleared (REQ-A845 / F-SH-270).
 */
export async function clearNotificationHistory(): Promise<boolean> {
  await invoke("push_clear_history");
  return bridgeDiag("push_clear_history").ok;
}

/**
 * Get push statistics, or `null` when the host did not answer.
 *
 * An all-zero snapshot is a *measurement* ("this device has received nothing"); inventing
 * one for a refused read reports an unasked question as a measured zero (REQ-A1335 / F-SH-601).
 */
export async function getPushStatistics(): Promise<RustPushStatistics | null> {
  return await invoke<RustPushStatistics>("push_get_statistics");
}

/**
 * Get push notification status, or `null` when the host did not answer.
 *
 * **This is the whole point of the round (REQ-A1335 / F-SH-601).** The old fallback
 * synthesised a complete status with `available: false` for a *reachable but refusing* host,
 * and the panel renders `available: false` as 「此设备上没有可用的推送后端」 — a claim about the
 * device, drawn from a question nobody answered — while the same branch dropped the retry
 * (only the no-bridge path offered one). Its own comment said the two loss modes "must not
 * be merged back"; `null` is what keeps them apart. `push_get_status` answers a struct, never
 * JSON `null`, so a `null` here can only mean "not answered".
 */
export async function getPushStatus(): Promise<RustPushStatus | null> {
  return await invoke<RustPushStatus>("push_get_status");
}
