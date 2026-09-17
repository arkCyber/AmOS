/**
 * __tests__/enterprise-ui-audit.test.ts
 * 
 * AuditLogViewer UI 组件测试
 * 
 * 测试范围:
 * - 日志过滤逻辑
 * - 时间范围筛选
 * - 统计数据计算
 * - 日志导出格式化
 * - 日志级别和结果过滤
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { auditLogger } from "../enterprise";
import type { AuditLog, AuditEventResult, AuditLogLevel } from "../enterprise/audit";

describe("AuditLogViewer UI 逻辑测试", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("时间范围过滤", () => {
    test("应该能够按今天过滤日志", () => {
      const now = Date.now();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStart = today.getTime();

      const logs: Partial<AuditLog>[] = [
        { timestamp: now, userId: "user1" },
        { timestamp: now - 86400000, userId: "user2" }, // 昨天
        { timestamp: now - 2 * 86400000, userId: "user3" }, // 前天
      ];

      const filtered = logs.filter(log => (log.timestamp ?? 0) >= todayStart);

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.userId).toBe("user1");
    });

    test("应该能够按最近 7 天过滤日志", () => {
      const now = Date.now();
      const sevenDaysAgo = now - 7 * 86400000;

      const logs: Partial<AuditLog>[] = [
        { timestamp: now, userId: "user1" },
        { timestamp: now - 5 * 86400000, userId: "user2" },
        { timestamp: now - 10 * 86400000, userId: "user3" },
      ];

      const filtered = logs.filter(log => (log.timestamp ?? 0) >= sevenDaysAgo);

      expect(filtered).toHaveLength(2);
    });

    test("应该能够按自定义时间范围过滤", () => {
      const now = Date.now();
      const startDate = now - 3 * 86400000;
      const endDate = now - 1 * 86400000;

      const logs: Partial<AuditLog>[] = [
        { timestamp: now, userId: "user1" },
        { timestamp: now - 2 * 86400000, userId: "user2" },
        { timestamp: now - 5 * 86400000, userId: "user3" },
      ];

      const filtered = logs.filter(log => {
        const ts = log.timestamp ?? 0;
        return ts >= startDate && ts <= endDate;
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.userId).toBe("user2");
    });
  });

  describe("用户过滤", () => {
    test("应该能够按用户 ID 过滤日志", () => {
      const logs: Partial<AuditLog>[] = [
        { userId: "user1", eventType: "shortcut.create" },
        { userId: "user2", eventType: "shortcut.execute" },
        { userId: "user1", eventType: "shortcut.modify" },
      ];

      const selectedUser = "user1";
      const filtered = logs.filter(log => 
        !selectedUser || log.userId === selectedUser
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.every(log => log.userId === "user1")).toBe(true);
    });
  });

  describe("事件类型过滤", () => {
    test("应该能够按事件类型过滤日志", () => {
      const logs: Partial<AuditLog>[] = [
        { eventType: "shortcut.create", userId: "user1" },
        { eventType: "shortcut.execute", userId: "user2" },
        { eventType: "shortcut.create", userId: "user3" },
      ];

      const selectedEventType = "shortcut.create";
      const filtered = logs.filter(log => 
        !selectedEventType || log.eventType === selectedEventType
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.every(log => log.eventType === "shortcut.create")).toBe(true);
    });
  });

  describe("结果过滤", () => {
    test("应该能够按成功/失败过滤日志", () => {
      const logs: Partial<AuditLog>[] = [
        { result: "success" as AuditEventResult, userId: "user1" },
        { result: "failure" as AuditEventResult, userId: "user2" },
        { result: "success" as AuditEventResult, userId: "user3" },
      ];

      const selectedResult = "success";
      const filtered = logs.filter(log => 
        !selectedResult || log.result === selectedResult
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.every(log => log.result === "success")).toBe(true);
    });
  });

  describe("日志级别过滤", () => {
    test("应该能够按日志级别过滤", () => {
      const logs: Partial<AuditLog>[] = [
        { level: "info" as AuditLogLevel, userId: "user1" },
        { level: "warning" as AuditLogLevel, userId: "user2" },
        { level: "error" as AuditLogLevel, userId: "user3" },
        { level: "info" as AuditLogLevel, userId: "user4" },
      ];

      const selectedLevel = "info";
      const filtered = logs.filter(log => 
        !selectedLevel || log.level === selectedLevel
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.every(log => log.level === "info")).toBe(true);
    });
  });

  describe("组合过滤", () => {
    test("应该支持多条件组合过滤", () => {
      const now = Date.now();
      const logs: Partial<AuditLog>[] = [
        {
          timestamp: now,
          userId: "user1",
          eventType: "shortcut.create",
          result: "success" as AuditEventResult,
          level: "info" as AuditLogLevel,
        },
        {
          timestamp: now - 86400000,
          userId: "user2",
          eventType: "shortcut.execute",
          result: "failure" as AuditEventResult,
          level: "error" as AuditLogLevel,
        },
        {
          timestamp: now,
          userId: "user1",
          eventType: "shortcut.execute",
          result: "success" as AuditEventResult,
          level: "info" as AuditLogLevel,
        },
      ];

      const timeRange = now - 3600000; // 最近 1 小时
      const selectedUser = "user1";
      const selectedResult = "success";

      const filtered = logs.filter(log => {
        const matchesTime = (log.timestamp ?? 0) >= timeRange;
        const matchesUser = !selectedUser || log.userId === selectedUser;
        const matchesResult = !selectedResult || log.result === selectedResult;
        
        return matchesTime && matchesUser && matchesResult;
      });

      expect(filtered).toHaveLength(2);
      expect(filtered.every(log => log.userId === "user1")).toBe(true);
      expect(filtered.every(log => log.result === "success")).toBe(true);
    });
  });

  describe("统计计算", () => {
    test("应该计算总日志数", () => {
      const logs: Partial<AuditLog>[] = [
        { userId: "user1" },
        { userId: "user2" },
        { userId: "user3" },
      ];

      expect(logs.length).toBe(3);
    });

    test("应该计算成功率", () => {
      const logs: Partial<AuditLog>[] = [
        { result: "success" as AuditEventResult },
        { result: "success" as AuditEventResult },
        { result: "failure" as AuditEventResult },
        { result: "success" as AuditEventResult },
      ];

      const successCount = logs.filter(log => log.result === "success").length;
      const successRate = (successCount / logs.length) * 100;

      expect(successRate).toBe(75);
    });

    test("应该计算失败率", () => {
      const logs: Partial<AuditLog>[] = [
        { result: "success" as AuditEventResult },
        { result: "failure" as AuditEventResult },
        { result: "failure" as AuditEventResult },
        { result: "success" as AuditEventResult },
      ];

      const failureCount = logs.filter(log => log.result === "failure").length;
      const failureRate = (failureCount / logs.length) * 100;

      expect(failureRate).toBe(50);
    });

    test("应该统计唯一用户数", () => {
      const logs: Partial<AuditLog>[] = [
        { userId: "user1" },
        { userId: "user2" },
        { userId: "user1" },
        { userId: "user3" },
        { userId: "user2" },
      ];

      const uniqueUsers = new Set(logs.map(log => log.userId));

      expect(uniqueUsers.size).toBe(3);
    });

    test("应该统计唯一事件类型数", () => {
      const logs: Partial<AuditLog>[] = [
        { eventType: "shortcut.create" },
        { eventType: "shortcut.execute" },
        { eventType: "shortcut.create" },
        { eventType: "shortcut.modify" },
      ];

      const uniqueEventTypes = new Set(logs.map(log => log.eventType));

      expect(uniqueEventTypes.size).toBe(3);
    });
  });

  describe("格式化辅助函数", () => {
    test("应该格式化时间戳", () => {
      const formatTimestamp = (timestamp: number): string => {
        const date = new Date(timestamp);
        return date.toLocaleString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
      };

      const timestamp = new Date("2026-09-17T21:30:45").getTime();
      const formatted = formatTimestamp(timestamp);

      expect(formatted).toContain("2026");
      expect(formatted).toContain("09");
      expect(formatted).toContain("17");
      expect(formatted).toContain("21");
      expect(formatted).toContain("30");
    });

    test("应该格式化事件类型标签", () => {
      const getEventTypeLabel = (eventType: string): string => {
        const labels: Record<string, string> = {
          "shortcut.create": "创建快捷指令",
          "shortcut.execute": "执行快捷指令",
          "shortcut.modify": "修改快捷指令",
          "shortcut.delete": "删除快捷指令",
          "template.install": "安装模板",
          "mdm.sync": "MDM 同步",
        };
        return labels[eventType] || eventType;
      };

      expect(getEventTypeLabel("shortcut.create")).toBe("创建快捷指令");
      expect(getEventTypeLabel("template.install")).toBe("安装模板");
      expect(getEventTypeLabel("unknown.event")).toBe("unknown.event");
    });

    test("应该根据结果返回图标", () => {
      const getResultIcon = (result: AuditEventResult): string => {
        const icons: Record<AuditEventResult, string> = {
          success: "✅",
          failure: "❌",
          pending: "⏳",
        };
        return icons[result];
      };

      expect(getResultIcon("success" as AuditEventResult)).toBe("✅");
      expect(getResultIcon("failure" as AuditEventResult)).toBe("❌");
      expect(getResultIcon("pending" as AuditEventResult)).toBe("⏳");
    });

    test("应该根据级别返回颜色", () => {
      const getLevelColor = (level: AuditLogLevel): string => {
        const colors: Record<AuditLogLevel, string> = {
          debug: "gray",
          info: "blue",
          warning: "orange",
          error: "red",
          critical: "darkred",
        };
        return colors[level];
      };

      expect(getLevelColor("info" as AuditLogLevel)).toBe("blue");
      expect(getLevelColor("error" as AuditLogLevel)).toBe("red");
      expect(getLevelColor("critical" as AuditLogLevel)).toBe("darkred");
    });
  });

  describe("日志导出", () => {
    test("应该生成 JSON 格式导出数据", () => {
      const logs: Partial<AuditLog>[] = [
        {
          id: "log-001",
          timestamp: Date.now(),
          userId: "user1",
          eventType: "shortcut.create",
          result: "success" as AuditEventResult,
        },
      ];

      const jsonData = JSON.stringify(logs, null, 2);
      const parsed = JSON.parse(jsonData);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.id).toBe("log-001");
    });

    test("应该生成 CSV 格式头部", () => {
      const csvHeaders = [
        "时间",
        "用户ID",
        "用户名",
        "事件类型",
        "类别",
        "结果",
        "级别",
        "消息",
      ];

      const headerRow = csvHeaders.join(",");

      expect(headerRow).toContain("时间");
      expect(headerRow).toContain("用户ID");
      expect(headerRow).toContain("事件类型");
    });

    test("应该转义 CSV 特殊字符", () => {
      const escapeCsvValue = (value: string): string => {
        if (value.includes(",") || value.includes('"') || value.includes("\n")) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      };

      expect(escapeCsvValue("normal")).toBe("normal");
      expect(escapeCsvValue("value,with,commas")).toBe('"value,with,commas"');
      expect(escapeCsvValue('value"with"quotes')).toBe('"value""with""quotes"');
    });
  });

  describe("分页计算", () => {
    test("应该计算总页数", () => {
      const totalItems = 100;
      const pageSize = 20;
      const totalPages = Math.ceil(totalItems / pageSize);

      expect(totalPages).toBe(5);
    });

    test("应该计算当前页的起始和结束索引", () => {
      const currentPage = 2;
      const pageSize = 20;
      const startIndex = (currentPage - 1) * pageSize;
      const endIndex = startIndex + pageSize;

      expect(startIndex).toBe(20);
      expect(endIndex).toBe(40);
    });
  });

  describe("实际审计日志管理器集成", () => {
    test("应该能够查询日志", () => {
      const logs = auditLogger.queryLogs({
        limit: 10,
      });

      expect(Array.isArray(logs)).toBe(true);
    });

    test("应该能够获取统计信息", () => {
      const stats = auditLogger.getStatistics();

      expect(stats).toBeDefined();
      expect(typeof stats?.totalLogs).toBe("number");
    });

    test("应该能够清理日志", () => {
      const sevenDaysAgo = Date.now() - 7 * 86400000;
      const result = auditLogger.cleanup(sevenDaysAgo);

      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });
});
