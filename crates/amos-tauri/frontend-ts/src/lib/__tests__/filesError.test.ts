/**
 * Tests for filesError.ts — 错误处理与重试策略
 */

import { describe, test, expect } from "vitest";
import {
  createFileError,
  getErrorMessageKey,
  createErrorHistory,
  addError,
  detectErrorStorm,
  getRecentError,
  clearErrorHistory,
  getRetryDelay,
  shouldRetry,
  sanitizeContext,
  DEFAULT_RETRY_CONFIG,
  type FileOperationError,
} from "../filesError";

describe("filesError.ts", () => {
  describe("createFileError", () => {
    test("creates error with correct severity and retryability", () => {
      const err = createFileError("create", "store_full", { name: "test.txt" });
      expect(err.operation).toBe("create");
      expect(err.reason).toBe("store_full");
      expect(err.severity).toBe("critical");
      expect(err.retryable).toBe(false);
      expect(err.context).toEqual({ name: "test.txt" });
      expect(err.timestamp).toBeGreaterThan(0);
    });

    test("store_locked is retryable with error severity", () => {
      const err = createFileError("write", "store_locked");
      expect(err.severity).toBe("error");
      expect(err.retryable).toBe(true);
    });

    test("name_conflict is non-retryable with warning severity", () => {
      const err = createFileError("rename", "name_conflict");
      expect(err.severity).toBe("warning");
      expect(err.retryable).toBe(false);
    });

    test("cycle_detected is non-retryable with error severity", () => {
      const err = createFileError("move", "cycle_detected");
      expect(err.severity).toBe("error");
      expect(err.retryable).toBe(false);
    });
  });

  describe("getErrorMessageKey", () => {
    test("generates correct i18n key", () => {
      const err = createFileError("delete", "not_found");
      expect(getErrorMessageKey(err)).toBe("files.error.delete.not_found");
    });

    test("generates key for all operations", () => {
      const operations: Array<FileOperationError["operation"]> = [
        "create", "rename", "delete", "move", "read", "write"
      ];
      for (const op of operations) {
        const err = createFileError(op, "unknown");
        expect(getErrorMessageKey(err)).toBe(`files.error.${op}.unknown`);
      }
    });
  });

  describe("ErrorHistory", () => {
    test("createErrorHistory initializes empty history", () => {
      const history = createErrorHistory(5);
      expect(history.errors).toEqual([]);
      expect(history.maxSize).toBe(5);
    });

    test("addError appends error to history", () => {
      let history = createErrorHistory(3);
      const err1 = createFileError("create", "store_full");
      history = addError(history, err1);
      expect(history.errors).toHaveLength(1);
      expect(history.errors[0]).toBe(err1);
    });

    test("addError maintains maxSize limit", () => {
      let history = createErrorHistory(2);
      const err1 = createFileError("create", "store_full");
      const err2 = createFileError("delete", "not_found");
      const err3 = createFileError("rename", "name_conflict");
      
      history = addError(history, err1);
      history = addError(history, err2);
      history = addError(history, err3);
      
      expect(history.errors).toHaveLength(2);
      expect(history.errors[0]).toBe(err2); // err1 removed
      expect(history.errors[1]).toBe(err3);
    });

    test("getRecentError returns last error", () => {
      let history = createErrorHistory(3);
      const err1 = createFileError("create", "store_full");
      const err2 = createFileError("delete", "not_found");
      
      history = addError(history, err1);
      history = addError(history, err2);
      
      expect(getRecentError(history)).toBe(err2);
    });

    test("getRecentError returns null for empty history", () => {
      const history = createErrorHistory(3);
      expect(getRecentError(history)).toBe(null);
    });

    test("clearErrorHistory removes all errors", () => {
      let history = createErrorHistory(3);
      const err1 = createFileError("create", "store_full");
      history = addError(history, err1);
      history = clearErrorHistory(history);
      expect(history.errors).toEqual([]);
    });
  });

  describe("detectErrorStorm", () => {
    test("returns false for no errors", () => {
      const history = createErrorHistory(10);
      expect(detectErrorStorm(history)).toBe(false);
    });

    test("returns false for errors below threshold", () => {
      let history = createErrorHistory(10);
      const err1 = createFileError("create", "store_full");
      const err2 = createFileError("delete", "not_found");
      history = addError(history, err1);
      history = addError(history, err2);
      
      expect(detectErrorStorm(history, 5000, 3)).toBe(false);
    });

    test("detects storm when same error repeats rapidly", () => {
      let history = createErrorHistory(10);
      const now = Date.now();
      
      // 3 个相同的 store_full 错误在 5s 内
      for (let i = 0; i < 3; i++) {
        const err = createFileError("write", "store_full");
        // 手动覆盖时间戳以确保在窗口内
        history = addError(history, { ...err, timestamp: now });
      }
      
      expect(detectErrorStorm(history, 5000, 3)).toBe(true);
    });

    test("ignores old errors outside time window", () => {
      let history = createErrorHistory(10);
      const now = Date.now();
      
      // 旧错误 (超出窗口)
      const oldErr = createFileError("write", "store_full");
      history = addError(history, { ...oldErr, timestamp: now - 10000 });
      
      // 新错误 (窗口内, 但数量不足)
      const newErr = createFileError("write", "store_full");
      history = addError(history, { ...newErr, timestamp: now });
      
      expect(detectErrorStorm(history, 5000, 3)).toBe(false);
    });
  });

  describe("Retry Logic", () => {
    test("getRetryDelay calculates exponential backoff", () => {
      expect(getRetryDelay(1)).toBe(500);   // 500 * 2^0
      expect(getRetryDelay(2)).toBe(1000);  // 500 * 2^1
      expect(getRetryDelay(3)).toBe(2000);  // 500 * 2^2
      expect(getRetryDelay(4)).toBe(4000);  // 500 * 2^3
    });

    test("getRetryDelay respects custom config", () => {
      const config = { maxAttempts: 5, delayMs: 1000, backoffMultiplier: 3 };
      expect(getRetryDelay(1, config)).toBe(1000);  // 1000 * 3^0
      expect(getRetryDelay(2, config)).toBe(3000);  // 1000 * 3^1
      expect(getRetryDelay(3, config)).toBe(9000);  // 1000 * 3^2
    });

    test("shouldRetry returns true for retryable error within maxAttempts", () => {
      const err = createFileError("write", "store_locked");
      expect(shouldRetry(err, 1)).toBe(true);
      expect(shouldRetry(err, 2)).toBe(true);
    });

    test("shouldRetry returns false when maxAttempts exceeded", () => {
      const err = createFileError("write", "store_locked");
      expect(shouldRetry(err, 3)).toBe(false); // maxAttempts = 3
      expect(shouldRetry(err, 5)).toBe(false);
    });

    test("shouldRetry returns false for non-retryable errors", () => {
      const err1 = createFileError("create", "store_full");
      const err2 = createFileError("rename", "name_conflict");
      const err3 = createFileError("move", "cycle_detected");
      
      expect(shouldRetry(err1, 1)).toBe(false);
      expect(shouldRetry(err2, 1)).toBe(false);
      expect(shouldRetry(err3, 1)).toBe(false);
    });

    test("DEFAULT_RETRY_CONFIG has sensible defaults", () => {
      expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(3);
      expect(DEFAULT_RETRY_CONFIG.delayMs).toBe(500);
      expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
    });
  });

  describe("sanitizeContext", () => {
    test("removes full path from file names", () => {
      const context = {
        path: "/home/user/documents/secret.txt",
        name: "/var/log/app.log",
      };
      const sanitized = sanitizeContext(context);
      expect(sanitized.path).toBe("secret.txt");
      expect(sanitized.name).toBe("app.log");
    });

    test("preserves non-path string values", () => {
      const context = {
        operation: "delete",
        reason: "not_found",
      };
      const sanitized = sanitizeContext(context);
      expect(sanitized.operation).toBe("delete");
      expect(sanitized.reason).toBe("not_found");
    });

    test("preserves numeric values", () => {
      const context = {
        size: 1024,
        attempts: 3,
      };
      const sanitized = sanitizeContext(context);
      expect(sanitized.size).toBe(1024);
      expect(sanitized.attempts).toBe(3);
    });

    test("handles keys containing 'file' keyword", () => {
      const context = {
        fileName: "/path/to/document.pdf",
        filePath: "/home/user/file.txt",
      };
      const sanitized = sanitizeContext(context);
      expect(sanitized.fileName).toBe("document.pdf");
      expect(sanitized.filePath).toBe("file.txt");
    });

    test("handles empty context", () => {
      const sanitized = sanitizeContext({});
      expect(sanitized).toEqual({});
    });

    test("handles single-level filenames without path", () => {
      const context = {
        name: "document.txt",
      };
      const sanitized = sanitizeContext(context);
      expect(sanitized.name).toBe("document.txt");
    });
  });
});
