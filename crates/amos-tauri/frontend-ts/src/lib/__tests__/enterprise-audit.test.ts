/**
 * enterprise-audit.test.ts — 企业审计日志测试套件
 * 
 * 测试标准: 航空航天级
 * 覆盖率目标: 95%+
 */

import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import { auditLogger, AuditLogger, type AuditLog } from "../enterprise/audit";
import { UNATTRIBUTED_USER_ID, UNATTRIBUTED_USER_NAME } from "../buildIdentity";
import { AMOS_UI_VERSION } from "../version";

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
      // 版本是**真实构建常量**（REQ-A695），不是 `audit.ts` 里那份会腐烂的第二份 `"0.1.0"`。
      expect(log.metadata.appVersion).toBe(AMOS_UI_VERSION);
      expect(log.metadata.tags).toBeDefined();
      expect(log.metadata.tags).toEqual(expect.arrayContaining(["update", "management"]));
      expect(log.metadata.custom).toEqual({ version: "2.0" });
    });

    it("条目上的操作主体在缺席时如实标记 unattributed（不冒充真人，REQ-A695）", async () => {
      await auditLogger.log({
        eventType: "setting_change",
        eventCategory: "system",
        eventDescription: "切换一个设置",
        result: "success",
      });
      await auditLogger.flushBuffer();

      const log = auditLogger.query({}).find((l) => l.eventDescription === "切换一个设置")!;
      expect(log.userId).toBe(UNATTRIBUTED_USER_ID);
      expect(log.userName).toBe(UNATTRIBUTED_USER_NAME);
      expect(log.userEmail).toBeUndefined();
      // 旧实现会把这里写成会被读成真实账号的 "user-default" / "Default User"。
      expect(log.userName).not.toBe("Default User");
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

    /**
     * REQ-A897。这条是**唯一**能钉住本轮缺陷的断言：写一条日志，然后**不刷新**就查。
     *
     * 从前这条会失败（`query()` 只读 `this.logs`，而刚写的行在 `buffer` 里），而
     * 生产里把行搬过去的只有「缓冲满 1000 条」和「`initialize()` 起的刷新定时器」
     * 两条路 —— 后者从没启动过（`initializeEnterprise()` 零调用者），所以挂载着的
     * 审计查看器在设备上一行都看不到。旧测试写的是「刷新前 count、刷新后
     * count 变大」，也就是**它自己补上了生产从不做的那一步**，所以一直是绿的。
     */
    it("写下来的一条日志，不刷新也能被读到", async () => {
      await auditLogger.log({
        eventType: "shortcut_create",
        eventCategory: "management",
        eventDescription: "不刷新就该看得见",
        result: "success",
      });

      const logs = auditLogger.query({});
      expect(logs.map((l) => l.eventDescription)).toContain("不刷新就该看得见");
      // 统计读的是同一份并集，否则列表和数字会互相打架。
      expect(auditLogger.getStatistics().totalLogs).toBe(logs.length);
    });

    /**
     * 上面那条的对照：`flushBuffer()` 仍然要把行从缓冲**移动**进主数组（落盘 + 进同步
     * 队列），并且**不重复计数** —— 少了这一条，「并集」写成「复制」也能通过上面那条。
     */
    it("刷新把行搬进主数组，且不重复计数", async () => {
      await auditLogger.log({
        eventType: "shortcut_create",
        eventCategory: "management",
        eventDescription: "搬一次",
        result: "success",
      });
      const before = auditLogger.query({});

      // 缓冲区是私有字段：这里要看的是**移动**（而不是拷贝），所以直接读它 ——
      // 公开面只能看到「并集里还是那一条」，两种实现都会通过。
      const priv = auditLogger as unknown as { buffer: AuditLog[] };
      expect(priv.buffer).toHaveLength(1);

      await auditLogger.flushBuffer();

      expect(priv.buffer).toHaveLength(0);
      const after = auditLogger.query({});
      expect(after).toHaveLength(before.length);
      expect(new Set(after.map((l) => l.id)).size).toBe(after.length);
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

/**
 * REQ-A897 —— 流水线**自己站起来**，因为它唯一的启动器在生产里没人调。
 *
 * 这一组用的是**全新实例**（不走共享 `beforeEach` 的 `initialize()`），因为要问的
 * 正是「没有任何人调 `initialize()` 时会怎样」。观测点是 `globalThis.setInterval`：
 * 它同时是「起没起来」和「起了一次还是两次」的判据 —— 从前重复 `initialize()` 会把
 * 旧句柄覆盖掉，那只定时器再也没人能停（REQ-A385 的形状）。
 */
describe("审计流水线的自启动（REQ-A897）", () => {
  const withIntervalSpy = async (body: () => Promise<void>) => {
    const real = globalThis.setInterval;
    const started: number[] = [];
    globalThis.setInterval = ((fn: TimerHandler, ms?: number) => {
      started.push(ms ?? 0);
      return real(fn as never, ms as never);
    }) as unknown as typeof globalThis.setInterval;
    try {
      await body();
      return started;
    } finally {
      globalThis.setInterval = real;
    }
  };

  /**
   * 只数**刷新**那一只（`DEFAULT_CONFIG.flushInterval` = 30s）。
   *
   * `setInterval` 在一个观察窗口里被叫两次是**有正当理由的**：`config.syncEnabled` 且
   * `mdmManager.isEnabled()` 时还会起一只同步定时器（`syncInterval` = 300s），而
   * `mdmManager` 是**模块级单例** —— 在一个进程里跑整个纯批次时，别的测试文件把它 enable
   * 过，于是这条测试的窗口里就多出一只不属于本文件的定时器。实测（`bun run test` 的纯批次里
   * 收到 2 只；确定性复现：`bun test --preload <打开 MDM 的脚本> <本文件>` ⇒ `Received
   * length: 2`，筛掉之后 1），不筛就断言「恰好一只」，读的其实是**别人的全局状态**，
   * 这正是本仓库那类「单跑绿、批次红」的假断言。筛掉延时不是 30_000 的调用之后，断言的
   * 才是本文件自己的性质：刷新定时器恰好一只、且不被叠起来。
   */
  const FLUSH_MS = 30_000; // DEFAULT_CONFIG.flushInterval(30s) * 1000
  const flushTimers = (ms: number[]) => ms.filter((m) => m === FLUSH_MS);

  it("没被 initialize 过的实例，第一条 log() 就把刷新定时器起起来（且只有一只）", async () => {
    const fresh = new AuditLogger();
    // 观察窗口里**只有** `log()` 这一句：`shutdown()` 自己也会写一条
    // `system_stop` → `log()` → 自启动，把它圈进来就会让这条断言失去意义
    // （实测：把 `log()` 里的 `ensureInitialized()` 删掉，它照样绿）。
    const started = flushTimers(
      await withIntervalSpy(async () => {
        await fresh.log({
          eventType: "shortcut_create",
          eventCategory: "management",
          eventDescription: "自启动",
          result: "success",
        });
      }),
    );
    // 0 = 从没起来（本轮修的就是这个）；2 = 叠了两只；1 = 恰好一只。
    expect(started).toHaveLength(1);
    await fresh.shutdown();
  });

  it("只读的一条路也会把它起起来 —— 查看器先于任何 log() 打开时同样看得见", async () => {
    const fresh = new AuditLogger();
    // 同上：窗口里只有 `query()`（`getStatistics()` 走的是同一条路，一并断言）。
    const afterQuery = flushTimers(
      await withIntervalSpy(async () => {
        fresh.query({});
      }),
    ).length;
    const started2 = flushTimers(
      await withIntervalSpy(async () => {
        fresh.getStatistics();
      }),
    );
    expect(afterQuery).toBe(1);
    // 幂等：已经在跑就不再起第二只。
    expect(started2).toHaveLength(0);
    await fresh.shutdown();
  });
});
