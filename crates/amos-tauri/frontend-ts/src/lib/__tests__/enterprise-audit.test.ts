/**
 * enterprise-audit.test.ts — 企业审计日志测试套件
 * 
 * 测试标准: 航空航天级
 * 覆盖率目标: 95%+
 */

import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import { auditLogger } from "../enterprise/audit";

// Note: No mocking needed - audit logger works with real storage in test environment

describe("企业审计日志系统", () => {
  beforeEach(async () => {
    // 重置审计日志系统
    await auditLogger.initialize();
    // 清除所有日志，确保测试隔离
    auditLogger.clearAllLogs();
  });

  afterEach(async () => {
    await auditLogger.shutdown();
  });

  describe("日志记录", () => {
    it("应该记录基本审计日志", async () => {
      const logId = await auditLogger.log({
        eventType: "shortcut_create",
        eventCategory: "management",
        eventDescription: "创建快捷指令: 测试快捷指令",
        result: "success",
      });

      expect(logId).toBeTruthy();
      expect(logId).toMatch(/^audit-/);
    });

    it("应该记录快捷指令执行日志", async () => {
      await auditLogger.logExecution({
        shortcutId: "shortcut-123",
        shortcutName: "测试快捷指令",
        success: true,
        duration: 1500,
        actionCount: 5,
      });

      await auditLogger.flushBuffer();

      const logs = auditLogger.query({
        eventTypes: ["shortcut_execute_success"],
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]!.resourceId).toBe("shortcut-123");
      expect(logs[0]!.duration).toBe(1500);
    });

    it("应该记录执行失败日志", async () => {
      await auditLogger.logExecution({
        shortcutId: "shortcut-456",
        shortcutName: "失败的快捷指令",
        success: false,
        duration: 500,
        actionCount: 3,
        errorMessage: "网络连接失败",
      });

      await auditLogger.flushBuffer();

      const logs = auditLogger.query({
        eventTypes: ["shortcut_execute_failure"],
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]!.result).toBe("failure");
      expect(logs[0]!.errorMessage).toBe("网络连接失败");
      expect(logs[0]!.level).toBe("error");
    });

    it("应该包含完整的日志元数据", async () => {
      await auditLogger.log({
        eventType: "shortcut_update",
        eventCategory: "management",
        eventDescription: "更新快捷指令",
        result: "success",
        tags: ["update", "management"],
        custom: { version: "2.0" },
      });

      await auditLogger.flushBuffer();

      const logs = auditLogger.query({});
      const log = logs[0]!;

      expect(log.metadata).toBeDefined();
      expect(log.metadata.platform).toBeTruthy();
      expect(log.metadata.appVersion).toBeTruthy();
      expect(log.metadata.tags).toBeDefined();
      expect(log.metadata.tags).toEqual(expect.arrayContaining(["update", "management"]));
      expect(log.metadata.custom).toEqual({ version: "2.0" });
    });
  });

  describe("日志级别过滤", () => {
    it("应该根据配置的最小级别过滤日志", async () => {
      // 设置只记录 warning 及以上
      auditLogger.updateConfig({ minLevel: "warning" });
      // 清除之前可能记录的日志（在 updateConfig 之后）
      auditLogger.clearAllLogs();

      // 记录不同级别的日志
      await auditLogger.log({
        eventType: "shortcut_create",
        eventCategory: "management",
        eventDescription: "Info 日志",
        level: "info",
        result: "success",
      });

      await auditLogger.log({
        eventType: "error_occurred",
        eventCategory: "system",
        eventDescription: "Error 日志",
        level: "error",
        result: "failure",
      });

      await auditLogger.flushBuffer();

      const logs = auditLogger.query({});
      expect(logs.length).toBe(1); // 只有 error 日志
      // 验证没有 info 级别的日志
      const infoLogs = logs.filter(l => l.level === "info");
      expect(infoLogs).toHaveLength(0);
      
      // 重置配置
      auditLogger.updateConfig({ minLevel: "info" });
    });

    it("应该正确推断日志级别", async () => {
      await auditLogger.log({
        eventType: "shortcut_execute_failure",
        eventCategory: "execution",
        eventDescription: "执行失败",
        result: "failure",
      });

      await auditLogger.flushBuffer();

      const logs = auditLogger.query({
        eventTypes: ["shortcut_execute_failure"],
      });
      expect(logs[0]!.level).toBe("error");
    });
  });

  describe("日志查询", () => {
    beforeEach(async () => {
      // 创建测试数据
      const testLogs = [
        {
          eventType: "shortcut_create" as const,
          eventCategory: "management" as const,
          eventDescription: "创建快捷指令 A",
          result: "success" as const,
          resourceType: "shortcut" as const,
          resourceId: "shortcut-1",
          resourceName: "快捷指令 A",
        },
        {
          eventType: "shortcut_execute_success" as const,
          eventCategory: "execution" as const,
          eventDescription: "执行快捷指令 A",
          result: "success" as const,
          resourceType: "shortcut" as const,
          resourceId: "shortcut-1",
          duration: 1000,
        },
        {
          eventType: "shortcut_execute_failure" as const,
          eventCategory: "execution" as const,
          eventDescription: "执行快捷指令 B 失败",
          result: "failure" as const,
          resourceType: "shortcut" as const,
          resourceId: "shortcut-2",
          errorMessage: "超时",
          duration: 5000,
        },
      ];

      for (const log of testLogs) {
        await auditLogger.log(log);
      }

      await auditLogger.flushBuffer();
    });

    it("应该按事件类型查询", () => {
      const logs = auditLogger.query({
        eventTypes: ["shortcut_execute_success"],
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]!.eventType).toBe("shortcut_execute_success");
    });

    it("应该按事件类别查询", () => {
      const logs = auditLogger.query({
        eventCategories: ["execution"],
      });

      expect(logs).toHaveLength(2);
      logs.forEach(log => {
        expect(log.eventCategory).toBe("execution");
      });
    });

    it("应该按结果查询", () => {
      const logs = auditLogger.query({
        results: ["failure"],
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]!.result).toBe("failure");
    });

    it("应该按资源 ID 查询", () => {
      const logs = auditLogger.query({
        resourceId: "shortcut-1",
      });

      expect(logs).toHaveLength(2);
      logs.forEach(log => {
        expect(log.resourceId).toBe("shortcut-1");
      });
    });

    it("应该支持关键词搜索", () => {
      const logs = auditLogger.query({
        search: "失败",
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]!.eventDescription).toContain("失败");
    });

    it("应该支持分页", () => {
      const allLogs = auditLogger.query({});
      expect(allLogs.length).toBeGreaterThanOrEqual(3);
      
      const page1 = auditLogger.query({
        limit: 2,
        offset: 0,
      });

      const page2 = auditLogger.query({
        limit: 2,
        offset: 2,
      });

      expect(page1).toHaveLength(2);
      expect(page2.length).toBeGreaterThanOrEqual(1);
      if (page2.length > 0 && page1.length > 0) {
        expect(page1[0]!.id).not.toBe(page2[0]!.id);
      }
    });

    it("应该支持排序", () => {
      const asc = auditLogger.query({
        sortBy: "timestamp",
        sortOrder: "asc",
      });

      const desc = auditLogger.query({
        sortBy: "timestamp",
        sortOrder: "desc",
      });

      expect(asc.length).toBeGreaterThanOrEqual(3);
      expect(desc.length).toBeGreaterThanOrEqual(3);
      
      if (asc.length > 0 && desc.length > 0) {
        // 验证排序是相反的
        expect(asc[0]!.timestamp).toBeLessThanOrEqual(asc[asc.length - 1]!.timestamp);
        expect(desc[0]!.timestamp).toBeGreaterThanOrEqual(desc[desc.length - 1]!.timestamp);
      }
    });
  });

  describe("统计信息", () => {
    beforeEach(async () => {
      // 创建测试数据
      await auditLogger.log({
        eventType: "shortcut_execute_success",
        eventCategory: "execution",
        eventDescription: "成功 1",
        result: "success",
        duration: 1000,
      });

      await auditLogger.log({
        eventType: "shortcut_execute_success",
        eventCategory: "execution",
        eventDescription: "成功 2",
        result: "success",
        duration: 2000,
      });

      await auditLogger.log({
        eventType: "shortcut_execute_failure",
        eventCategory: "execution",
        eventDescription: "失败 1",
        result: "failure",
        duration: 500,
      });

      await auditLogger.flushBuffer();
    });

    it("应该统计总日志数", () => {
      const stats = auditLogger.getStatistics();
      expect(stats.totalLogs).toBe(3);
    });

    it("应该统计成功/失败数量", () => {
      const stats = auditLogger.getStatistics();
      expect(stats.successCount).toBe(2);
      expect(stats.failureCount).toBe(1);
    });

    it("应该统计平均执行时间", () => {
      const stats = auditLogger.getStatistics();
      // 平均值可能因为浮点数精度有微小差异
      expect(stats.avgDuration).toBeCloseTo(1166.67, 1); // (1000 + 2000 + 500) / 3
      expect(stats.maxDuration).toBe(2000);
      expect(stats.minDuration).toBe(500);
    });

    it("应该按事件类型统计", () => {
      const stats = auditLogger.getStatistics();
      expect(stats.byEventType["shortcut_execute_success"]).toBe(2);
      expect(stats.byEventType["shortcut_execute_failure"]).toBe(1);
    });

    it("应该按类别统计", () => {
      const stats = auditLogger.getStatistics();
      expect(stats.byCategory["execution"]).toBe(3);
    });
  });

  describe("敏感数据脱敏", () => {
    it("应该脱敏密码字段", async () => {
      await auditLogger.log({
        eventType: "config_change",
        eventCategory: "management",
        eventDescription: "更新配置",
        result: "success",
        actionDetails: {
          password: "my-secret-password",
          apiKey: "sk-1234567890",
          username: "john",
        },
      });

      await auditLogger.flushBuffer();

      const logs = auditLogger.query({});
      const details = logs[0]!.actionDetails;

      expect(details.password).toBe("***MASKED***");
      expect(details.apiKey).toBe("***MASKED***");
      expect(details.username).toBe("john");
    });

    it("应该脱敏嵌套对象中的敏感字段", async () => {
      await auditLogger.log({
        eventType: "config_change",
        eventCategory: "management",
        eventDescription: "更新嵌套配置",
        result: "success",
        actionDetails: {
          server: {
            url: "https://api.example.com",
            token: "bearer-token-123",
          },
        },
      });

      await auditLogger.flushBuffer();

      const logs = auditLogger.query({});
      const details = logs[0]!.actionDetails as any;

      expect(details.server.url).toBe("https://api.example.com");
      expect(details.server.token).toBe("***MASKED***");
    });
  });

  describe("日志导出", () => {
    beforeEach(async () => {
      await auditLogger.log({
        eventType: "shortcut_create",
        eventCategory: "management",
        eventDescription: "创建快捷指令",
        result: "success",
      });

      await auditLogger.log({
        eventType: "shortcut_execute_success",
        eventCategory: "execution",
        eventDescription: "执行快捷指令",
        result: "success",
        duration: 1500,
      });

      await auditLogger.flushBuffer();
    });

    it("应该导出为 JSON 格式", async () => {
      const exported = await auditLogger.exportLogs({}, "json");
      const parsed = JSON.parse(exported);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toHaveProperty("id");
      expect(parsed[0]).toHaveProperty("eventType");
    });

    it("应该导出为 CSV 格式", async () => {
      const exported = await auditLogger.exportLogs({}, "csv");

      expect(exported).toContain("时间,级别,用户,事件类型");
      expect(exported).toContain("shortcut_create");
      expect(exported).toContain("shortcut_execute_success");

      const lines = exported.split("\n");
      expect(lines).toHaveLength(3); // header + 2 rows
    });

    it("应该支持查询条件导出", async () => {
      const exported = await auditLogger.exportLogs({
        eventCategories: ["execution"],
      }, "json");

      const parsed = JSON.parse(exported);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.eventCategory).toBe("execution");
    });
  });

  describe("缓冲区管理", () => {
    it("应该在缓冲区满时自动刷新", async () => {
      // 设置小缓冲区
      auditLogger.updateConfig({ bufferSize: 3 });

      // 添加 4 条日志
      for (let i = 0; i < 4; i++) {
        await auditLogger.log({
          eventType: "shortcut_create",
          eventCategory: "management",
          eventDescription: `日志 ${i}`,
          result: "success",
        });
      }

      // 应该自动刷新
      const logs = auditLogger.query({});
      expect(logs.length).toBeGreaterThanOrEqual(3);
    });

    it("应该支持手动刷新缓冲区", async () => {
      await auditLogger.log({
        eventType: "shortcut_create",
        eventCategory: "management",
        eventDescription: "测试日志",
        result: "success",
      });

      // 刷新前日志数
      let logs = auditLogger.query({});
      const countBefore = logs.length;

      // 手动刷新
      await auditLogger.flushBuffer();

      // 刷新后日志数应增加
      logs = auditLogger.query({});
      expect(logs.length).toBeGreaterThan(countBefore);
    });
  });

  describe("配置管理", () => {
    it("应该返回当前配置", () => {
      const config = auditLogger.getConfig();

      expect(config).toBeDefined();
      expect(config).toHaveProperty("enabled");
      expect(config).toHaveProperty("minLevel");
      expect(config).toHaveProperty("retentionDays");
    });

    it("应该更新配置", () => {
      auditLogger.updateConfig({
        retentionDays: 180,
        minLevel: "warning",
      });

      const config = auditLogger.getConfig();
      expect(config.retentionDays).toBe(180);
      expect(config.minLevel).toBe("warning");
    });
  });

  describe("边界条件", () => {
    it("应该处理空查询", () => {
      const logs = auditLogger.query({});
      expect(Array.isArray(logs)).toBe(true);
    });

    it("应该处理不存在的资源 ID", () => {
      const logs = auditLogger.query({
        resourceId: "non-existent",
      });

      expect(logs).toHaveLength(0);
    });

    it("应该处理无效的时间范围", () => {
      const logs = auditLogger.query({
        startTime: Date.now() + 10000,
        endTime: Date.now() + 20000,
      });

      expect(logs).toHaveLength(0);
    });

    it("应该处理负数分页参数", () => {
      const logs = auditLogger.query({
        limit: -10,
        offset: -5,
      });

      expect(Array.isArray(logs)).toBe(true);
    });
  });

  describe("并发安全", () => {
    it("应该处理并发日志记录", async () => {
      // 先确保 logger 已完全初始化
      await auditLogger.initialize();
      auditLogger.clearAllLogs();

      // 过滤掉空 ID（可能因为级别过滤返回空字符串）
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          auditLogger.log({
            eventType: "shortcut_execute_success",
            eventCategory: "execution",
            eventDescription: `并发日志 ${i}`,
            result: "success",
            level: "info", // 明确指定级别确保不被过滤
          })
        );
      }

      const logIds = (await Promise.all(promises)).filter(id => id !== "");

      // 所有日志 ID 应该唯一
      const uniqueIds = new Set(logIds);
      expect(uniqueIds.size).toBe(10);
    });
  });
});
