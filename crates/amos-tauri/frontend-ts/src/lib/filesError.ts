/**
 * filesError.ts — 航空航天级错误处理与用户反馈
 * 
 * 提供文件操作失败的详细反馈、重试机制和错误恢复策略。
 * 所有函数都是纯函数或带显式副作用标注，便于测试和审计。
 */

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export interface FileOperationError {
  /** 操作类型 (用于生成用户可读消息) */
  operation: "create" | "rename" | "delete" | "move" | "read" | "write";
  /** 错误原因代码 */
  reason: 
    | "store_full"       // 存储配额耗尽
    | "store_locked"     // 存储被锁定 (并发写入冲突)
    /**
     * **本机存储写不进去 —— 不可用或已满**（REQ-A510）。
     *
     * 为什么需要它：`writeJson` / `writeStoreValueChecked` 只回答"落没落地"，答不出**是哪一种**
     * （其文档原话：a rejected write (full/unavailable storage) has to be visible；`common.storeWriteFailed`
     * 的文案也是"本机存储写入失败（**不可用或已满**）"）。而在此之前，三处拒写都标成 `store_locked`
     * （"存储繁忙 / 并发写锁"）—— 这个应用**没有**能观测到写锁的生产者（`localStorage.setItem` 不加锁），
     * 于是用户读到"存储繁忙，请重试"，而真实条件可能是"空间已满"：按钮按了也不会成功，除非他先腾出空间。
     * 这个 reason 就是不猜：名字、文案与"写不进去"这件事本身对齐，而 `retryable` 仍为 `true`
     * （存储状态确实可能变化 —— 腾出空间、或存储恢复可用；REQ-A468 的测试正是这一半）。
     *
     * `store_full` / `store_locked` 保留：它们对**能分辨**的生产者仍然正确，今天没有这样的生产者。
     */
    | "store_unavailable"
    | "name_conflict"    // 文件名冲突
    | "not_found"        // 条目不存在
    | "invalid_name"     // 非法文件名
    | "cycle_detected"   // 移动操作会产生循环引用
    | "permission_denied" // 权限拒绝 (未来扩展)
    | "unknown";         // 未知错误
  /** 严重程度 */
  severity: ErrorSeverity;
  /** 可选的上下文信息 (如文件名) */
  context?: Record<string, string | number>;
  /** 错误发生时间戳 */
  timestamp: number;
  /** 是否可重试 */
  retryable: boolean;
}

/**
 * 根据错误信息生成用户友好的消息键 (用于 i18n)
 */
export function getErrorMessageKey(error: FileOperationError): string {
  return `files.error.${error.operation}.${error.reason}`;
}

/**
 * 创建标准化的错误对象
 */
export function createFileError(
  operation: FileOperationError["operation"],
  reason: FileOperationError["reason"],
  context?: Record<string, string | number>
): FileOperationError {
  const severity = getSeverity(reason);
  const retryable = isRetryable(reason);
  
  return {
    operation,
    reason,
    severity,
    context,
    timestamp: Date.now(),
    retryable,
  };
}

/**
 * 根据错误原因推断严重程度
 */
function getSeverity(reason: FileOperationError["reason"]): ErrorSeverity {
  switch (reason) {
    case "store_full":
    case "store_unavailable": // 写不进去就是"这次改动没保存"——与 store_full 同一量级
    case "permission_denied":
      return "critical";
    case "store_locked":
    case "cycle_detected":
      return "error";
    case "name_conflict":
    case "not_found":
      return "warning";
    case "invalid_name":
      return "info";
    default:
      return "error";
  }
}

/**
 * 判断错误是否可重试
 */
function isRetryable(reason: FileOperationError["reason"]): boolean {
  switch (reason) {
    case "store_locked":  // 并发锁可能释放
    case "store_unavailable": // 存储**可能**恢复：腾出空间、或禁用状态被解除（REQ-A510）
    case "unknown":       // 未知错误可能是临时故障
      return true;
    case "store_full":    // 配额耗尽需要用户清理
    case "name_conflict": // 名称冲突需要用户重命名
    case "cycle_detected": // 逻辑错误无法重试
    case "permission_denied": // 权限问题无法重试
    case "not_found":     // 条目已删除无法重试
    case "invalid_name":  // 非法名称无法重试
      return false;
    default:
      return false;
  }
}

/**
 * 错误历史管理 (用于防止错误风暴)
 */
export interface ErrorHistory {
  errors: FileOperationError[];
  maxSize: number;
}

export function createErrorHistory(maxSize = 10): ErrorHistory {
  return { errors: [], maxSize };
}

/**
 * 添加错误到历史记录
 */
export function addError(
  history: ErrorHistory,
  error: FileOperationError
): ErrorHistory {
  const errors = [...history.errors, error];
  // 保留最近 N 个错误
  if (errors.length > history.maxSize) {
    errors.shift();
  }
  return { ...history, errors };
}

/**
 * 检测错误风暴 (短时间内大量相同错误)
 */
export function detectErrorStorm(
  history: ErrorHistory,
  windowMs = 5000,
  threshold = 3
): boolean {
  const now = Date.now();
  const recentErrors = history.errors.filter(
    (e) => now - e.timestamp < windowMs
  );
  
  if (recentErrors.length < threshold) return false;
  
  // 检查是否有相同类型的错误超过阈值
  const reasonCounts = new Map<string, number>();
  for (const err of recentErrors) {
    const key = `${err.operation}:${err.reason}`;
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  
  return Array.from(reasonCounts.values()).some((count) => count >= threshold);
}

/**
 * 获取最近的错误 (用于 UI 展示)
 */
export function getRecentError(
  history: ErrorHistory
): FileOperationError | null {
  return history.errors[history.errors.length - 1] ?? null;
}

/**
 * 清除错误历史
 */
export function clearErrorHistory(history: ErrorHistory): ErrorHistory {
  return { ...history, errors: [] };
}

/**
 * 重试策略配置
 */
export interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_CONFIG: Readonly<RetryConfig> = {
  maxAttempts: 3,
  delayMs: 500,
  backoffMultiplier: 2,
} as const;

/**
 * 计算重试延迟 (指数退避)
 */
export function getRetryDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  return config.delayMs * Math.pow(config.backoffMultiplier, attempt - 1);
}

/**
 * 判断是否应该重试
 */
export function shouldRetry(
  error: FileOperationError,
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): boolean {
  return error.retryable && attempt < config.maxAttempts;
}

/**
 * A stable identity for **the same failed action across its retries** (REQ-A607).
 *
 * Every failed attempt mints a fresh `FileOperationError` with its own `timestamp`, so
 * neither object identity nor the timestamp can tell a *retry of one action* from a
 * *new failure* — yet a retry budget has to survive the former and reset on the latter.
 * Operation + reason + the (sorted) context is that identity: a retry re-enters **the
 * same** user action with the same arguments and so reproduces the signature, while a
 * different action — or the same action on a different entry — does not.
 */
export function retrySignature(error: FileOperationError | null): string | null {
  if (!error) return null;
  const ctx = error.context ?? {};
  const parts = Object.keys(ctx)
    .sort()
    .map((k) => `${k}=${String(ctx[k])}`);
  return `${error.operation}:${error.reason}${parts.length ? `:${parts.join(",")}` : ""}`;
}

/**
 * 清理错误上下文中的敏感信息 (如完整文件路径)
 * 用于日志记录和错误报告，避免泄露用户隐私
 */
export function sanitizeContext(
  context: Record<string, string | number>
): Record<string, string | number> {
  const sanitized: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string") {
      // 移除完整路径，只保留文件名
      if (key === "path" || key === "name" || key.toLowerCase().includes("file")) {
        const parts = value.split("/");
        sanitized[key] = parts[parts.length - 1] || value;
      } else {
        sanitized[key] = value;
      }
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
