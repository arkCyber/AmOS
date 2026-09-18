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
import { invoke } from "./backend";

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
export function generateNotificationId(): string {
  return `push_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
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

/** Rust PushResult type — every `push_*` command answers with one of these kinds
 * instead of throwing, so "the platform said no" stays distinguishable from
 * "the call failed". Mirrors `push_notifications.rs`' published `kind` strings. */
export interface PushResult {
  kind: "ok" | "unavailable" | "permissiondenied" | "invalidtoken" | "failed";
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

/** Rust PermissionStatus type. */
export type RustPermissionStatus = "notdetermined" | "denied" | "authorized" | "provisional";

/** Rust PushStatus type. */
export interface RustPushStatus {
  available: boolean;
  device_token: RustDeviceToken | null;
  permission: RustPermissionStatus;
  badge_count: number;
  statistics: RustPushStatistics;
}

/**
 * Register device token for push notifications.
 */
export async function registerDeviceToken(token: string, environment: string = "production"): Promise<PushResult> {
  return (await invoke<PushResult>("push_register_token", { token, environment })) ?? noBridge();
}

/** Get current device token. */
export async function getDeviceToken(): Promise<RustDeviceToken | null> {
  return await invoke<RustDeviceToken>("push_get_token");
}

/** Request push notification permission. */
export async function requestPushPermission(): Promise<PushResult> {
  return (await invoke<PushResult>("push_request_permission")) ?? noBridge();
}

/** Get current permission status. */
export async function getPushPermission(): Promise<RustPermissionStatus> {
  return (await invoke<RustPermissionStatus>("push_get_permission")) ?? "notdetermined";
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

/** The honest answer when there is no host to ask. */
function noBridge(): PushResult {
  return { kind: "failed", reason: "push backend unreachable (no host bridge)" };
}

/** One push _statistics snapshot with every counter at zero. */
function emptyPushStatistics(): RustPushStatistics {
  return { total_received: 0, with_badge: 0, with_sound: 0, silent: 0, last_received: null };
}

/** Get badge count. */
export async function getBadgeCount(): Promise<number> {
  return (await invoke<number>("push_get_badge")) ?? 0;
}

/** Set badge count. */
export async function setBadgeCount(count: number): Promise<void> {
  await invoke("push_set_badge", { count });
}

/**
 * Get notification history (newest first, as the Rust manager returns it).
 *
 * An unreachable host answers `[]` — "I could not ask", which every caller must
 * treat as *no news*, never as *nothing exists* (see `mergePushHistory`).
 */
export async function getNotificationHistory(limit?: number): Promise<RustNotificationRecord[]> {
  return (await invoke<RustNotificationRecord[]>("push_get_history", { limit: limit ?? null })) ?? [];
}

/** Mark notification as read. */
export async function markNotificationRead(id: string): Promise<boolean> {
  return (await invoke<boolean>("push_mark_read", { id })) ?? false;
}

/** Clear notification history. */
export async function clearNotificationHistory(): Promise<void> {
  await invoke("push_clear_history");
}

/** Get push statistics. */
export async function getPushStatistics(): Promise<RustPushStatistics> {
  return (await invoke<RustPushStatistics>("push_get_statistics")) ?? emptyPushStatistics();
}

/** Get push notification status. */
export async function getPushStatus(): Promise<RustPushStatus> {
  return (
    (await invoke<RustPushStatus>("push_get_status")) ?? {
      available: false,
      device_token: null,
      permission: "notdetermined",
      badge_count: 0,
      statistics: emptyPushStatistics(),
    }
  );
}
