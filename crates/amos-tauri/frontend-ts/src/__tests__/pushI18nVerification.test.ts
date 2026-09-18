/**
 * 推送通知国际化完整性验证测试
 *
 * 验证所有推送通知相关的 i18n 字符串在中文和英文翻译中都已完整定义。
 */

import { describe, test, expect } from "bun:test";
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";

const zhTranslations: Record<string, any> = zh;
const enTranslations: Record<string, any> = en;

// 提取所有 push 相关的翻译键
function extractPushKeys(translations: Record<string, any>, prefix: string = "push"): string[] {
  const keys: string[] = [];
  for (const key in translations) {
    if (key.startsWith(prefix)) {
      keys.push(key);
    }
  }
  return keys;
}

describe("推送通知国际化完整性", () => {
  const zhPushKeys = extractPushKeys(zhTranslations);
  const enPushKeys = extractPushKeys(enTranslations);

  test("中文翻译包含推送通知相关键", () => {
    expect(zhPushKeys.length).toBeGreaterThan(0);
    // 验证关键键存在
    expect(zhPushKeys).toContain("pushPermission.title");
    expect(zhPushKeys).toContain("pushSettings.deviceToken");
    expect(zhPushKeys).toContain("pushSettings.statistics");
  });

  test("英文翻译包含推送通知相关键", () => {
    expect(enPushKeys.length).toBeGreaterThan(0);
    expect(enPushKeys).toContain("pushPermission.title");
    expect(enPushKeys).toContain("pushSettings.deviceToken");
    expect(enPushKeys).toContain("pushSettings.statistics");
  });

  test("中英文推送键数量一致", () => {
    expect(zhPushKeys.length).toBe(enPushKeys.length);
  });

  test("所有中文键在英文中都有对应", () => {
    zhPushKeys.forEach((key) => {
      expect(enPushKeys).toContain(key);
    });
  });

  test("所有英文键在中文中都有对应", () => {
    enPushKeys.forEach((key) => {
      expect(zhPushKeys).toContain(key);
    });
  });

  test("翻译值不为空", () => {
    zhPushKeys.forEach((key) => {
      expect(zhTranslations[key]).toBeTruthy();
      expect(typeof zhTranslations[key]).toBe("string");
    });

    enPushKeys.forEach((key) => {
      expect(enTranslations[key]).toBeTruthy();
      expect(typeof enTranslations[key]).toBe("string");
    });
  });

  test("翻译键命名规范", () => {
    // 验证键名格式: pushPermission.* 或 pushSettings.* 或 pushNotification.*
    const validPrefixes = ["pushPermission.", "pushSettings.", "pushNotification."];

    [...zhPushKeys, ...enPushKeys].forEach((key) => {
      const isValid = validPrefixes.some((prefix) => key.startsWith(prefix));
      expect(isValid).toBe(true);
    });
  });

  test("时间格式化键包含插值参数（如果存在）", () => {
    const minutesAgoZh = zhTranslations["pushSettings.minutesAgo"];
    const minutesAgoEn = enTranslations["pushSettings.minutesAgo"];

    if (minutesAgoZh && typeof minutesAgoZh === "string") {
      expect(minutesAgoZh).toContain("{count}");
    }
    if (minutesAgoEn && typeof minutesAgoEn === "string") {
      expect(minutesAgoEn).toContain("{count}");
    }
  });

  test("页面键包含插值参数（如果存在）", () => {
    const pageZh = zhTranslations["pushSettings.page"];
    const pageEn = enTranslations["pushSettings.page"];

    if (pageZh) {
      expect(pageZh).toContain("{current}");
      expect(pageZh).toContain("{total}");
    }
    if (pageEn) {
      expect(pageEn).toContain("{current}");
      expect(pageEn).toContain("{total}");
    }
  });

  test("通知权限状态翻译", () => {
    const permissionStates = [
      "pushPermission.denied",
      "pushPermission.requesting",
      "pushPermission.description",
      "pushPermission.successDescription",
    ];

    permissionStates.forEach((key) => {
      expect(zhTranslations[key]).toBeDefined();
      expect(enTranslations[key]).toBeDefined();
    });
  });

  test("统计指标翻译", () => {
    const statsKeys = [
      "pushSettings.totalReceived",
      "pushSettings.withBadge",
      "pushSettings.withSound",
      "pushSettings.silent",
    ];

    statsKeys.forEach((key) => {
      expect(zhTranslations[key]).toBeDefined();
      expect(enTranslations[key]).toBeDefined();
    });
  });

  test("环境标识翻译", () => {
    const envKeys = [
      "pushSettings.environment",
      "pushSettings.envProduction",
      "pushSettings.envDevelopment",
    ];

    envKeys.forEach((key) => {
      expect(zhTranslations[key]).toBeDefined();
      expect(enTranslations[key]).toBeDefined();
    });
  });

  test("开发者工具翻译", () => {
    const devToolsKeys = [
      "pushSettings.sendTest",
    ];

    devToolsKeys.forEach((key) => {
      expect(zhTranslations[key]).toBeDefined();
      expect(enTranslations[key]).toBeDefined();
    });
  });
});

describe("翻译质量检查", () => {
  test("中文翻译非空且有意义", () => {
    expect(zhTranslations["pushPermission.title"]).toBe("启用推送通知");
    expect(zhTranslations["pushSettings.deviceToken"]).toBe("设备令牌");
    expect(zhTranslations["pushSettings.statistics"]).toBe("通知统计");
  });

  test("英文翻译非空且有意义", () => {
    expect(enTranslations["pushPermission.title"]).toBe("Enable Push Notifications");
    expect(enTranslations["pushSettings.deviceToken"]).toBe("Device Token");
    expect(enTranslations["pushSettings.statistics"]).toBe("Statistics");
  });

  test("翻译没有未替换的占位符", () => {
    [...extractPushKeys(zhTranslations), ...extractPushKeys(enTranslations)].forEach((key) => {
      const zhValue = zhTranslations[key];
      const enValue = enTranslations[key];

      // 检查是否有未格式化的双花括号
      expect(zhValue).not.toMatch(/\{\{[^}]+\}\}/);
      expect(enValue).not.toMatch(/\{\{[^}]+\}\}/);
    });
  });

  test("翻译长度合理", () => {
    // 翻译不应该过长或过短
    const keys = extractPushKeys(zhTranslations);
    keys.forEach((key) => {
      const value = zhTranslations[key];
      expect(value.length).toBeGreaterThan(0);
      expect(value.length).toBeLessThan(200);
    });
  });
});
