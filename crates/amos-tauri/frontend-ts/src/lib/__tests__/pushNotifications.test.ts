import { describe, expect, test } from "bun:test";
import {
  isValidDeviceToken,
  generateMockDeviceToken,
  parsePushPayload,
  extractBadge,
  extractAlertText,
  isSilentPush,
  hasMutableContent,
  normalizePushConfig,
  normalizeRegistrationStatus,
  normalizeAppBadgeState,
  normalizePushNotification,
  normalizePushStatistics,
  updateAppBadge,
  clearAppBadge,
  getTotalBadgeCount,
  getAppBadgeCount,
  addNotificationToHistory,
  removeExpiredNotifications,
  updatePushStatistics,
  generateNotificationId,
  shouldPresentNotification,
  DEFAULT_PUSH_CONFIG,
  MAX_NOTIFICATION_HISTORY,
  type PushPayload,
  type PushNotification,
  type AppBadgeState,
  type PushStatistics,
} from "../pushNotifications";

describe("推送通知服务 - 航空航天级审计", () => {
  describe("设备令牌管理", () => {
    test("验证生产环境设备令牌格式（64位十六进制）", () => {
      expect(isValidDeviceToken("")).toBe(false);
      expect(isValidDeviceToken("abc")).toBe(false);
      expect(isValidDeviceToken("not-hex-string-12345678901234567890123456789012345678901234567890123456")).toBe(false);
      
      // 生产环境令牌：64 位十六进制
      const validToken = "a".repeat(64);
      expect(isValidDeviceToken(validToken)).toBe(true);
      
      // 混合大小写
      expect(isValidDeviceToken("A1b2C3d4".repeat(8))).toBe(true);
      
      // 沙盒令牌：32-63 位十六进制
      expect(isValidDeviceToken("abc123def456")).toBe(false); // 太短（<32）
      expect(isValidDeviceToken("1234567890abcdef1234567890abcdef")).toBe(true); // 32 位
      expect(isValidDeviceToken("a".repeat(32))).toBe(true); // 最小有效长度
      expect(isValidDeviceToken("a".repeat(63))).toBe(true); // 63 位也有效
    });

    test("生成模拟设备令牌（仅用于测试）", () => {
      const token1 = generateMockDeviceToken();
      const token2 = generateMockDeviceToken();
      
      expect(token1.length).toBe(64);
      expect(token2.length).toBe(64);
      expect(token1).not.toBe(token2);
      expect(isValidDeviceToken(token1)).toBe(true);
      expect(isValidDeviceToken(token2)).toBe(true);
      expect(/^[0-9a-f]{64}$/.test(token1)).toBe(true);
    });

    test("注册状态标准化", () => {
      // 默认状态
      expect(normalizeRegistrationStatus(null)).toEqual({
        registered: false,
        token: null,
        registeredAt: 0,
        error: null,
      });

      // 有效注册
      const token = generateMockDeviceToken();
      const registered = normalizeRegistrationStatus({
        registered: true,
        token,
        registeredAt: 1000,
        error: null,
      });
      expect(registered.registered).toBe(true);
      expect(registered.token).toBe(token);
      expect(registered.registeredAt).toBe(1000);

      // 无效令牌被拒绝
      expect(normalizeRegistrationStatus({ token: "invalid" }).token).toBeNull();

      // 错误状态
      expect(normalizeRegistrationStatus({ error: "Network error" }).error).toBe("Network error");
    });
  });

  describe("推送载荷解析", () => {
    test("解析标准 APNs 载荷", () => {
      const payload: PushPayload = {
        aps: {
          alert: {
            title: "新消息",
            body: "您有一条新消息",
          },
          badge: 5,
          sound: "default",
        },
        customData: { orderId: "12345" },
      };

      const parsed = parsePushPayload(JSON.stringify(payload));
      expect(parsed).not.toBeNull();
      expect(parsed?.aps.alert).toEqual({ title: "新消息", body: "您有一条新消息" });
      expect(parsed?.aps.badge).toBe(5);
      expect((parsed as any)?.customData?.orderId).toBe("12345");
    });

    test("解析已解析的对象载荷", () => {
      const payload: PushPayload = {
        aps: { alert: "测试消息" },
      };
      const parsed = parsePushPayload(payload);
      expect(parsed).toEqual(payload);
    });

    test("拒绝格式错误的载荷", () => {
      expect(parsePushPayload("not json")).toBeNull();
      expect(parsePushPayload("[]")).toBeNull();
      expect(parsePushPayload("null")).toBeNull();
      expect(parsePushPayload({})).toBeNull(); // 缺少 aps
      expect(parsePushPayload({ aps: "wrong type" })).toBeNull();
      expect(parsePushPayload({ aps: [] })).toBeNull();
    });

    test("提取徽章计数", () => {
      expect(extractBadge({ aps: { badge: 5 } })).toBe(5);
      expect(extractBadge({ aps: { badge: 0 } })).toBe(0);
      expect(extractBadge({ aps: {} })).toBeNull();
      expect(extractBadge({ aps: { badge: -1 } })).toBeNull();
      expect(extractBadge({ aps: { badge: 3.7 } })).toBe(3); // 向下取整
      expect(extractBadge({ aps: { badge: NaN } })).toBeNull();
      expect(extractBadge({ aps: { badge: Infinity } })).toBeNull();
    });

    test("提取通知文本（字符串格式）", () => {
      const text = extractAlertText({ aps: { alert: "简单消息" } });
      expect(text).toEqual({ body: "简单消息" });
    });

    test("提取通知文本（结构化格式）", () => {
      const text = extractAlertText({
        aps: {
          alert: {
            title: "标题",
            subtitle: "副标题",
            body: "正文内容",
          },
        },
      });
      expect(text?.title).toBe("标题 副标题");
      expect(text?.body).toBe("正文内容");
    });

    test("提取通知文本（仅标题）", () => {
      const text = extractAlertText({
        aps: { alert: { title: "仅标题" } },
      });
      expect(text?.title).toBe("仅标题");
      expect(text?.body).toBeUndefined();
    });

    test("无通知文本时返回 null", () => {
      expect(extractAlertText({ aps: {} })).toBeNull();
      expect(extractAlertText({ aps: { alert: {} } })).toBeNull();
    });
  });

  describe("静默推送与可变内容", () => {
    test("识别静默推送（content-available）", () => {
      const silent: PushPayload = {
        aps: { "content-available": 1 },
        data: { sync: true },
      };
      expect(isSilentPush(silent)).toBe(true);

      // 有通知或声音则不是静默推送
      expect(isSilentPush({ aps: { "content-available": 1, alert: "提示" } })).toBe(false);
      expect(isSilentPush({ aps: { "content-available": 1, sound: "default" } })).toBe(false);
      expect(isSilentPush({ aps: {} })).toBe(false);
    });

    test("识别可变内容（mutable-content）", () => {
      expect(hasMutableContent({ aps: { "mutable-content": 1 } })).toBe(true);
      expect(hasMutableContent({ aps: {} })).toBe(false);
    });
  });

  describe("服务配置", () => {
    test("标准化推送服务配置", () => {
      expect(normalizePushConfig(null)).toEqual(DEFAULT_PUSH_CONFIG);
      expect(normalizePushConfig({})).toEqual(DEFAULT_PUSH_CONFIG);

      const custom = normalizePushConfig({
        enabled: false,
        soundEnabled: false,
        maxHistorySize: 50,
      });
      expect(custom.enabled).toBe(false);
      expect(custom.soundEnabled).toBe(false);
      expect(custom.maxHistorySize).toBe(50);
      expect(custom.badgeEnabled).toBe(DEFAULT_PUSH_CONFIG.badgeEnabled);
    });

    test("历史记录大小上限", () => {
      const huge = normalizePushConfig({ maxHistorySize: 999999 });
      expect(huge.maxHistorySize).toBe(MAX_NOTIFICATION_HISTORY);

      const negative = normalizePushConfig({ maxHistorySize: -1 });
      expect(negative.maxHistorySize).toBe(DEFAULT_PUSH_CONFIG.maxHistorySize);
    });
  });

  describe("徽章管理", () => {
    test("更新应用徽章计数", () => {
      const badges: AppBadgeState[] = [];
      const updated = updateAppBadge(badges, "com.amos.messages", 5, 1000);
      
      expect(updated.length).toBe(1);
      expect(updated[0]?.appId).toBe("com.amos.messages");
      expect(updated[0]?.count).toBe(5);
      expect(updated[0]?.updatedAt).toBe(1000);

      // 更新现有徽章
      const updated2 = updateAppBadge(updated, "com.amos.messages", 10, 2000);
      expect(updated2.length).toBe(1);
      expect(updated2[0]?.count).toBe(10);
      expect(updated2[0]?.updatedAt).toBe(2000);

      // 添加另一个应用
      const updated3 = updateAppBadge(updated2, "com.amos.mail", 3, 3000);
      expect(updated3.length).toBe(2);
    });

    test("徽章计数向下取整且非负", () => {
      const badges = updateAppBadge([], "app1", 3.9, 1000);
      expect(badges[0]?.count).toBe(3);

      const negative = updateAppBadge([], "app2", -5, 1000);
      expect(negative[0]?.count).toBe(0);
    });

    test("清除应用徽章", () => {
      const badges: AppBadgeState[] = [
        { appId: "app1", count: 5, updatedAt: 1000 },
        { appId: "app2", count: 3, updatedAt: 1000 },
      ];

      const cleared = clearAppBadge(badges, "app1");
      expect(cleared.length).toBe(1);
      expect(cleared[0]?.appId).toBe("app2");

      // 清除不存在的应用不报错
      const unchanged = clearAppBadge(badges, "nonexistent");
      expect(unchanged.length).toBe(2);
    });

    test("计算总徽章计数", () => {
      const badges: AppBadgeState[] = [
        { appId: "app1", count: 5, updatedAt: 1000 },
        { appId: "app2", count: 3, updatedAt: 1000 },
        { appId: "app3", count: 0, updatedAt: 1000 },
      ];
      expect(getTotalBadgeCount(badges)).toBe(8);
      expect(getTotalBadgeCount([])).toBe(0);
    });

    test("获取特定应用徽章计数", () => {
      const badges: AppBadgeState[] = [
        { appId: "app1", count: 5, updatedAt: 1000 },
        { appId: "app2", count: 3, updatedAt: 1000 },
      ];
      expect(getAppBadgeCount(badges, "app1")).toBe(5);
      expect(getAppBadgeCount(badges, "nonexistent")).toBe(0);
    });

    test("徽章状态标准化", () => {
      expect(normalizeAppBadgeState(null)).toBeNull();
      expect(normalizeAppBadgeState({ count: 5 })).toBeNull(); // 缺少 appId

      const valid = normalizeAppBadgeState({
        appId: "com.amos.app",
        count: 5,
        updatedAt: 1000,
      });
      expect(valid?.appId).toBe("com.amos.app");
      expect(valid?.count).toBe(5);

      // 负数徽章计数归零
      const negative = normalizeAppBadgeState({ appId: "app", count: -3 });
      expect(negative?.count).toBe(0);
    });
  });

  describe("通知历史管理", () => {
    test("添加通知到历史记录", () => {
      const notification: PushNotification = {
        payload: { aps: { alert: "测试" } },
        metadata: {
          id: "n1",
          timestamp: 1000,
          priority: "high",
          foreground: false,
          expiry: null,
        },
      };

      const history = addNotificationToHistory([], notification, 100);
      expect(history.length).toBe(1);
      expect(history[0]).toEqual(notification);

      // 新通知在最前面（LIFO）
      const notification2: PushNotification = {
        payload: { aps: { alert: "测试2" } },
        metadata: {
          id: "n2",
          timestamp: 2000,
          priority: "normal",
          foreground: true,
          expiry: null,
        },
      };
      const history2 = addNotificationToHistory(history, notification2, 100);
      expect(history2.length).toBe(2);
      expect(history2[0]?.metadata.id).toBe("n2");
    });

    test("历史记录达到上限时截断", () => {
      let history: PushNotification[] = [];
      for (let i = 0; i < 10; i++) {
        history = addNotificationToHistory(
          history,
          {
            payload: { aps: { alert: `msg${i}` } },
            metadata: {
              id: `n${i}`,
              timestamp: i,
              priority: "normal",
              foreground: false,
              expiry: null,
            },
          },
          5,
        );
      }
      expect(history.length).toBe(5);
      expect(history[0]?.metadata.id).toBe("n9"); // 最新的
      expect(history[4]?.metadata.id).toBe("n5");
    });

    test("移除过期通知", () => {
      const now = 10000;
      const history: PushNotification[] = [
        {
          payload: { aps: { alert: "未过期" } },
          metadata: {
            id: "n1",
            timestamp: 9000,
            priority: "normal",
            foreground: false,
            expiry: now + 1000, // 未来
          },
        },
        {
          payload: { aps: { alert: "已过期" } },
          metadata: {
            id: "n2",
            timestamp: 5000,
            priority: "normal",
            foreground: false,
            expiry: now - 1000, // 过去
          },
        },
        {
          payload: { aps: { alert: "无过期时间" } },
          metadata: {
            id: "n3",
            timestamp: 8000,
            priority: "normal",
            foreground: false,
            expiry: null, // 永不过期
          },
        },
      ];

      const cleaned = removeExpiredNotifications(history, now);
      expect(cleaned.length).toBe(2);
      expect(cleaned.find((n) => n.metadata.id === "n1")).toBeDefined();
      expect(cleaned.find((n) => n.metadata.id === "n3")).toBeDefined();
      expect(cleaned.find((n) => n.metadata.id === "n2")).toBeUndefined();
    });

    test("通知标准化", () => {
      expect(normalizePushNotification(null)).toBeNull();
      expect(normalizePushNotification({ payload: {} })).toBeNull(); // 无效载荷

      const valid = normalizePushNotification({
        payload: { aps: { alert: "测试" } },
        metadata: {
          id: "n1",
          timestamp: 1000,
          priority: "high",
          foreground: true,
          expiry: 5000,
        },
      });
      expect(valid?.metadata.id).toBe("n1");
      expect(valid?.metadata.priority).toBe("high");

      // 无效优先级默认为 normal
      const invalidPriority = normalizePushNotification({
        payload: { aps: { alert: "测试" } },
        metadata: { id: "n2", timestamp: 1000, priority: "invalid" },
      });
      expect(invalidPriority?.metadata.priority).toBe("normal");
    });
  });

  describe("推送统计", () => {
    test("更新推送统计（成功投递）", () => {
      const stats: PushStatistics = {
        totalReceived: 10,
        foregroundReceived: 3,
        backgroundReceived: 7,
        silentPushReceived: 2,
        failedDeliveries: 0,
        lastNotificationAt: 9000,
      };

      const notification: PushNotification = {
        payload: { aps: { alert: "新消息" } },
        metadata: {
          id: "n1",
          timestamp: 10000,
          priority: "high",
          foreground: true,
          expiry: null,
        },
      };

      const updated = updatePushStatistics(stats, notification, true);
      expect(updated.totalReceived).toBe(11);
      expect(updated.foregroundReceived).toBe(4);
      expect(updated.backgroundReceived).toBe(7);
      expect(updated.lastNotificationAt).toBe(10000);
    });

    test("更新推送统计（失败投递）", () => {
      const stats: PushStatistics = {
        totalReceived: 10,
        foregroundReceived: 3,
        backgroundReceived: 7,
        silentPushReceived: 2,
        failedDeliveries: 1,
        lastNotificationAt: 9000,
      };

      const notification: PushNotification = {
        payload: { aps: { alert: "新消息" } },
        metadata: {
          id: "n1",
          timestamp: 10000,
          priority: "high",
          foreground: false,
          expiry: null,
        },
      };

      const updated = updatePushStatistics(stats, notification, false);
      expect(updated.totalReceived).toBe(10); // 失败不计入接收
      expect(updated.failedDeliveries).toBe(2);
    });

    test("统计静默推送", () => {
      const stats = normalizePushStatistics(null);
      const silentNotification: PushNotification = {
        payload: { aps: { "content-available": 1 } },
        metadata: {
          id: "s1",
          timestamp: 1000,
          priority: "normal",
          foreground: false,
          expiry: null,
        },
      };

      const updated = updatePushStatistics(stats, silentNotification, true);
      expect(updated.silentPushReceived).toBe(1);
      expect(updated.backgroundReceived).toBe(1);
    });

    test("统计标准化", () => {
      expect(normalizePushStatistics(null)).toEqual({
        totalReceived: 0,
        foregroundReceived: 0,
        backgroundReceived: 0,
        silentPushReceived: 0,
        failedDeliveries: 0,
        lastNotificationAt: 0,
      });

      // 负数归零
      const invalid = normalizePushStatistics({
        totalReceived: -5,
        failedDeliveries: 3.7,
      });
      expect(invalid.totalReceived).toBe(0);
      expect(invalid.failedDeliveries).toBe(3);
    });
  });

  describe("通知标识符生成", () => {
    test("生成唯一通知 ID", () => {
      const id1 = generateNotificationId();
      const id2 = generateNotificationId();

      expect(id1).toMatch(/^push_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^push_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("通知展示决策", () => {
    const config = DEFAULT_PUSH_CONFIG;

    test("后台通知始终展示", () => {
      const payload: PushPayload = {
        aps: { alert: "新消息", sound: "default", badge: 1 },
      };
      const options = shouldPresentNotification(payload, config, false);
      expect(options.alert).toBe(true);
      expect(options.sound).toBe(true);
      expect(options.badge).toBe(true);
    });

    test("前台通知根据载荷决定", () => {
      const payload: PushPayload = {
        aps: { alert: "新消息", sound: "default", badge: 1 },
      };
      const options = shouldPresentNotification(payload, config, true);
      expect(options.alert).toBe(true);
      expect(options.sound).toBe(true);
      expect(options.badge).toBe(true);
    });

    test("静默推送永不展示 UI", () => {
      const silent: PushPayload = {
        aps: { "content-available": 1 },
      };
      const options = shouldPresentNotification(silent, config, false);
      expect(options.alert).toBeUndefined();
      expect(options.sound).toBeUndefined();
      expect(options.badge).toBeUndefined();
    });

    test("配置禁用声音时不播放", () => {
      const noSound = { ...config, soundEnabled: false };
      const payload: PushPayload = {
        aps: { alert: "新消息", sound: "default" },
      };
      const options = shouldPresentNotification(payload, noSound, true);
      expect(options.alert).toBe(true);
      expect(options.sound).toBe(false);
    });

    test("配置禁用徽章时不更新", () => {
      const noBadge = { ...config, badgeEnabled: false };
      const payload: PushPayload = {
        aps: { alert: "新消息", badge: 5 },
      };
      const options = shouldPresentNotification(payload, noBadge, false);
      expect(options.badge).toBe(false);
    });
  });

  describe("边界条件与安全性", () => {
    test("超大历史记录限制在硬上限", () => {
      const config = normalizePushConfig({ maxHistorySize: 999999 });
      expect(config.maxHistorySize).toBeLessThanOrEqual(MAX_NOTIFICATION_HISTORY);
    });

    test("NaN/Infinity 徽章计数被拒绝", () => {
      expect(extractBadge({ aps: { badge: NaN } })).toBeNull();
      expect(extractBadge({ aps: { badge: Infinity } })).toBeNull();
      expect(extractBadge({ aps: { badge: -Infinity } })).toBeNull();
    });

    test("恶意载荷注入防护", () => {
      // 测试 JSON 注入尝试（通过字符串解析）
      const maliciousJSON = JSON.stringify({
        aps: { alert: "正常消息" },
        __proto__: { polluted: true },
        constructor: { hack: true },
      });
      const parsed = parsePushPayload(maliciousJSON);
      expect(parsed).not.toBeNull();
      expect(parsed?.aps.alert).toBe("正常消息");
      
      // 验证原型链未被污染（通过 JSON.parse 安全处理）
      expect(Object.prototype.hasOwnProperty("polluted")).toBe(false);
      
      // 验证载荷结构完整性
      expect(typeof parsed?.aps).toBe("object");
      expect(Array.isArray(parsed?.aps)).toBe(false);
    });

    test("空载荷或缺少必需字段被拒绝", () => {
      expect(parsePushPayload({})).toBeNull();
      expect(parsePushPayload({ aps: null })).toBeNull();
      expect(parsePushPayload({ aps: [] })).toBeNull();
      expect(parsePushPayload({ notAps: {} })).toBeNull();
    });

    test("时间戳验证（防止负数或无效值）", () => {
      const invalid = normalizePushNotification({
        payload: { aps: { alert: "测试" } },
        metadata: { id: "n1", timestamp: -1000 },
      });
      expect(invalid).toBeNull();

      const nan = normalizePushNotification({
        payload: { aps: { alert: "测试" } },
        metadata: { id: "n1", timestamp: NaN },
      });
      expect(nan).toBeNull();
    });
  });

  describe("航空航天级可靠性", () => {
    test("所有标准化函数处理 null/undefined 不崩溃", () => {
      expect(() => normalizePushConfig(null)).not.toThrow();
      expect(() => normalizeRegistrationStatus(undefined)).not.toThrow();
      expect(() => normalizeAppBadgeState(null)).not.toThrow();
      expect(() => normalizePushNotification(undefined)).not.toThrow();
      expect(() => normalizePushStatistics(null)).not.toThrow();
    });

    test("所有操作保持不可变性", () => {
      const badges: AppBadgeState[] = [{ appId: "app1", count: 5, updatedAt: 1000 }];
      updateAppBadge(badges, "app1", 10, 2000);
      expect(badges[0]?.count).toBe(5); // 原数组未变

      const stats: PushStatistics = {
        totalReceived: 10,
        foregroundReceived: 3,
        backgroundReceived: 7,
        silentPushReceived: 2,
        failedDeliveries: 0,
        lastNotificationAt: 9000,
      };
      const notification: PushNotification = {
        payload: { aps: { alert: "测试" } },
        metadata: {
          id: "n1",
          timestamp: 10000,
          priority: "normal",
          foreground: true,
          expiry: null,
        },
      };
      updatePushStatistics(stats, notification, true);
      expect(stats.totalReceived).toBe(10); // 原对象未变
    });

    test("大量通知处理不导致性能降级", () => {
      let history: PushNotification[] = [];
      const start = Date.now();
      
      for (let i = 0; i < 1000; i++) {
        history = addNotificationToHistory(
          history,
          {
            payload: { aps: { alert: `msg${i}` } },
            metadata: {
              id: `n${i}`,
              timestamp: i,
              priority: "normal",
              foreground: false,
              expiry: null,
            },
          },
          MAX_NOTIFICATION_HISTORY,
        );
      }
      
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000); // 1000次操作应在1秒内完成
      expect(history.length).toBe(MAX_NOTIFICATION_HISTORY);
    });

    test("并发场景下徽章计数一致性", () => {
      let badges: AppBadgeState[] = [];
      const appId = "com.amos.test";

      // 模拟并发更新（10次增量）
      for (let i = 0; i < 10; i++) {
        badges = updateAppBadge(badges, appId, i + 1, 1000 + i);
      }

      expect(badges.length).toBe(1);
      expect(badges[0]?.count).toBe(10); // 最后一次更新生效
    });
  });
});
