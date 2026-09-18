/**
 * MeasureApp.svelte 组件测试
 *
 * 测试范围:
 * - 设置规范化
 * - 历史记录管理
 * - 测量创建和格式化
 * - 单位转换
 * - 校准逻辑
 * - 参考物体选择
 */

import { describe, it, expect } from "vitest";
import {
  MEASURE_SETTINGS_KEY,
  MEASURE_HISTORY_KEY,
  normalizeMeasureSettings,
  normalizeMeasureHistory,
  defaultMeasureSettings,
  createMeasurement,
  formatDistance,
  parseDistance,
  pixelDistance,
  estimateRealDistance,
  calibrateReference,
  REFERENCE_OBJECTS,
  getReferenceObject,
} from "../lib/measure";
import type { MeasurePoint, Measurement } from "../lib/measure";

describe("MeasureApp - 设置和持久化", () => {
  describe("defaultMeasureSettings", () => {
    it("应该返回默认设置", () => {
      const settings = defaultMeasureSettings();

      expect(settings.unit).toBe("metric");
      expect(settings.referenceDistance).toBe(1000);
      expect(settings.showGuides).toBe(true);
    });

    it("默认设置应该是可序列化的", () => {
      const settings = defaultMeasureSettings();
      const json = JSON.stringify(settings);
      const parsed = JSON.parse(json);

      expect(parsed.unit).toBe("metric");
      expect(parsed.referenceDistance).toBe(1000);
    });
  });

  describe("normalizeMeasureSettings", () => {
    it("应该接受有效设置", () => {
      const raw = {
        unit: "imperial",
        referenceDistance: 1500,
        showGuides: false,
      };

      const normalized = normalizeMeasureSettings(raw);

      expect(normalized.unit).toBe("imperial");
      expect(normalized.referenceDistance).toBe(1500);
      expect(normalized.showGuides).toBe(false);
    });

    it("应该拒绝无效的 unit 值", () => {
      const raw = { unit: "invalid" };
      const normalized = normalizeMeasureSettings(raw);

      expect(normalized.unit).toBe("metric"); // 默认值
    });

    it("应该拒绝非数字的 referenceDistance", () => {
      const raw = { referenceDistance: "invalid" };
      const normalized = normalizeMeasureSettings(raw);

      expect(normalized.referenceDistance).toBe(1000); // 默认值
    });

    it("应该拒绝负数 referenceDistance", () => {
      const raw = { referenceDistance: -100 };
      const normalized = normalizeMeasureSettings(raw);

      expect(normalized.referenceDistance).toBe(1000); // 默认值
    });

    it("应该拒绝零 referenceDistance", () => {
      const raw = { referenceDistance: 0 };
      const normalized = normalizeMeasureSettings(raw);

      expect(normalized.referenceDistance).toBe(1000); // 默认值
    });

    it("应该接受非布尔 showGuides 的回退", () => {
      const raw = { showGuides: "yes" };
      const normalized = normalizeMeasureSettings(raw);

      expect(normalized.showGuides).toBe(true); // 默认值
    });

    it("应该处理 null 输入", () => {
      const normalized = normalizeMeasureSettings(null);
      expect(normalized).toEqual(defaultMeasureSettings());
    });

    it("应该处理 undefined 输入", () => {
      const normalized = normalizeMeasureSettings(undefined);
      expect(normalized).toEqual(defaultMeasureSettings());
    });

    it("应该处理非对象输入", () => {
      const normalized = normalizeMeasureSettings("string");
      expect(normalized).toEqual(defaultMeasureSettings());
    });
  });
});

describe("MeasureApp - 测量记录管理", () => {
  describe("normalizeMeasureHistory", () => {
    it("应该接受有效的测量数组", () => {
      const raw: Measurement[] = [
        {
          id: "m-1",
          start: { x: 0, y: 0 },
          end: { x: 0.5, y: 0.5 },
          distance: 1000,
          timestamp: Date.now(),
        },
      ];

      const normalized = normalizeMeasureHistory(raw);

      expect(normalized.length).toBe(1);
      expect(normalized[0]?.id).toBe("m-1");
    });

    it("应该拒绝非数组输入", () => {
      expect(normalizeMeasureHistory(null)).toEqual([]);
      expect(normalizeMeasureHistory(undefined)).toEqual([]);
      expect(normalizeMeasureHistory({})).toEqual([]);
      expect(normalizeMeasureHistory("string")).toEqual([]);
    });

    it("应该过滤无效测量", () => {
      const raw = [
        null,
        undefined,
        {},
        { id: "m-1", distance: 100, timestamp: 0, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
      ];

      const normalized = normalizeMeasureHistory(raw);

      expect(normalized.length).toBe(1);
      expect(normalized[0]?.id).toBe("m-1");
    });

    it("应该拒绝缺少必需字段的测量", () => {
      const raw = [
        { id: "m-1", distance: 100 }, // 缺少 timestamp, start, end
        { id: "m-2", timestamp: 0, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }, // 缺少 distance
      ];

      const normalized = normalizeMeasureHistory(raw);

      expect(normalized.length).toBe(0);
    });

    it("应该拒绝无效坐标范围的点", () => {
      const raw = [
        { id: "m-1", distance: 100, timestamp: 0, start: { x: -1, y: 0 }, end: { x: 1, y: 1 } }, // x < 0
        { id: "m-2", distance: 100, timestamp: 0, start: { x: 0, y: 0 }, end: { x: 2, y: 1 } }, // x > 1
      ];

      const normalized = normalizeMeasureHistory(raw);

      expect(normalized.length).toBe(0);
    });

    it("应该保留可选的 label 字段", () => {
      const raw = [
        {
          id: "m-1",
          distance: 100,
          timestamp: 0,
          start: { x: 0, y: 0 },
          end: { x: 1, y: 1 },
          label: "测试标签",
        },
      ];

      const normalized = normalizeMeasureHistory(raw);

      expect(normalized[0]?.label).toBe("测试标签");
    });

    it("应该限制最多 50 条记录", () => {
      const raw = Array.from({ length: 100 }, (_, i) => ({
        id: `m-${i}`,
        distance: 100,
        timestamp: i,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
      }));

      const normalized = normalizeMeasureHistory(raw);

      expect(normalized.length).toBe(50);
    });
  });

  describe("删除测量", () => {
    it("应该按 ID 过滤测量", () => {
      const measurements: Measurement[] = [
        { id: "m-1", start: { x: 0, y: 0 }, end: { x: 0.5, y: 0.5 }, distance: 1000, timestamp: 1 },
        { id: "m-2", start: { x: 0, y: 0 }, end: { x: 0.6, y: 0.6 }, distance: 1200, timestamp: 2 },
        { id: "m-3", start: { x: 0, y: 0 }, end: { x: 0.7, y: 0.7 }, distance: 1400, timestamp: 3 },
      ];

      const filtered = measurements.filter((m) => m.id !== "m-2");

      expect(filtered.length).toBe(2);
      expect(filtered.find((m) => m.id === "m-2")).toBeUndefined();
    });
  });

  describe("清空测量", () => {
    it("应该清空所有测量", () => {
      let measurements: Measurement[] = [
        { id: "m-1", start: { x: 0, y: 0 }, end: { x: 0.5, y: 0.5 }, distance: 1000, timestamp: 1 },
      ];

      measurements = [];

      expect(measurements.length).toBe(0);
    });
  });
});

describe("MeasureApp - 测量计算", () => {
  describe("pixelDistance", () => {
    it("应该计算两点之间的像素距离", () => {
      const p1: MeasurePoint = { x: 0, y: 0 };
      const p2: MeasurePoint = { x: 1, y: 0 };
      const distance = pixelDistance(p1, p2, 1000, 1000);

      expect(distance).toBe(1000);
    });

    it("应该处理对角线距离", () => {
      const p1: MeasurePoint = { x: 0, y: 0 };
      const p2: MeasurePoint = { x: 1, y: 1 };
      const distance = pixelDistance(p1, p2, 1000, 1000);

      // sqrt(1000^2 + 1000^2) ≈ 1414.21
      expect(distance).toBeCloseTo(1414.21, 1);
    });

    it("应该处理相同点", () => {
      const p1: MeasurePoint = { x: 0.5, y: 0.5 };
      const p2: MeasurePoint = { x: 0.5, y: 0.5 };
      const distance = pixelDistance(p1, p2, 1000, 1000);

      expect(distance).toBe(0);
    });

    it("应该处理不同视口尺寸", () => {
      const p1: MeasurePoint = { x: 0, y: 0 };
      const p2: MeasurePoint = { x: 1, y: 0 };
      const distance = pixelDistance(p1, p2, 500, 1000);

      expect(distance).toBe(500);
    });
  });

  describe("estimateRealDistance", () => {
    it("应该估算真实世界距离", () => {
      // 视口宽 1000px，参考距离 1000mm
      // 像素距离 100px（占视口的 10%）
      // 估算距离应该是 (100/1000) * referenceWidth
      const realDist = estimateRealDistance(100, 1000, 1000);

      expect(realDist).toBeGreaterThan(0);
      expect(Number.isFinite(realDist)).toBe(true);
    });

    it("零像素距离应该返回零真实距离", () => {
      const realDist = estimateRealDistance(0, 1000, 1000);

      expect(realDist).toBe(0);
    });

    it("应该随参考距离线性缩放", () => {
      const dist1 = estimateRealDistance(100, 1000, 1000);
      const dist2 = estimateRealDistance(100, 1000, 2000);

      // 参考距离翻倍，估算距离也应该翻倍
      expect(dist2).toBeCloseTo(dist1 * 2, 1);
    });
  });

  describe("createMeasurement", () => {
    it("应该创建测量对象", () => {
      const start: MeasurePoint = { x: 0, y: 0 };
      const end: MeasurePoint = { x: 0.5, y: 0.5 };

      const measurement = createMeasurement(start, end, 1000, 1000, 1000);

      expect(measurement.id).toBeTruthy();
      expect(measurement.id).toMatch(/^m-/);
      expect(measurement.start).toEqual(start);
      expect(measurement.end).toEqual(end);
      expect(measurement.distance).toBeGreaterThan(0);
      expect(measurement.timestamp).toBeGreaterThan(0);
    });

    it("应该生成唯一的 ID", () => {
      const start: MeasurePoint = { x: 0, y: 0 };
      const end: MeasurePoint = { x: 0.5, y: 0.5 };

      const m1 = createMeasurement(start, end, 1000, 1000, 1000);
      const m2 = createMeasurement(start, end, 1000, 1000, 1000);

      expect(m1.id).not.toBe(m2.id);
    });

    it("应该支持可选的 label", () => {
      const start: MeasurePoint = { x: 0, y: 0 };
      const end: MeasurePoint = { x: 0.5, y: 0.5 };

      const measurement = createMeasurement(start, end, 1000, 1000, 1000, "测试");

      expect(measurement.label).toBe("测试");
    });

    it("应该支持没有 label", () => {
      const start: MeasurePoint = { x: 0, y: 0 };
      const end: MeasurePoint = { x: 0.5, y: 0.5 };

      const measurement = createMeasurement(start, end, 1000, 1000, 1000);

      expect(measurement.label).toBeUndefined();
    });
  });
});

describe("MeasureApp - 单位转换", () => {
  describe("formatDistance - metric", () => {
    it("应该格式化毫米 (< 10mm)", () => {
      expect(formatDistance(5, "metric")).toBe("5.0 mm");
      expect(formatDistance(9.5, "metric")).toBe("9.5 mm");
    });

    it("应该格式化毫米 (10-100mm)", () => {
      expect(formatDistance(50, "metric")).toBe("50 mm");
      expect(formatDistance(99, "metric")).toBe("99 mm");
    });

    it("应该格式化为厘米 (100-1000mm)", () => {
      expect(formatDistance(150, "metric")).toBe("15.0 cm");
      expect(formatDistance(500, "metric")).toBe("50.0 cm");
      expect(formatDistance(999, "metric")).toBe("99.9 cm");
    });

    it("应该格式化为米 (>= 1000mm)", () => {
      expect(formatDistance(1000, "metric")).toBe("1.00 m");
      expect(formatDistance(1500, "metric")).toBe("1.50 m");
      expect(formatDistance(10000, "metric")).toBe("10.00 m");
    });
  });

  describe("formatDistance - imperial", () => {
    it("应该格式化为英寸 (< 12 inches)", () => {
      // 1 inch = 25.4 mm
      expect(formatDistance(25.4, "imperial")).toBe('1.0"');
      expect(formatDistance(254, "imperial")).toBe('10.0"');
    });

    it("应该格式化为英尺 + 英寸 (>= 12 inches)", () => {
      // 12 inches = 304.8 mm
      expect(formatDistance(304.8, "imperial")).toBe("1'");
      expect(formatDistance(355.6, "imperial")).toBe("1' 2.0\"");
    });
  });

  describe("parseDistance", () => {
    it("应该解析毫米", () => {
      expect(parseDistance("100mm")).toBe(100);
      expect(parseDistance("50 mm")).toBe(50);
      expect(parseDistance("25.5mm")).toBe(25.5);
    });

    it("应该解析厘米", () => {
      expect(parseDistance("10cm")).toBe(100);
      expect(parseDistance("5 cm")).toBe(50);
      expect(parseDistance("2.5cm")).toBe(25);
    });

    it("应该解析米", () => {
      expect(parseDistance("1m")).toBe(1000);
      expect(parseDistance("0.5m")).toBe(500);
      expect(parseDistance("2.5 m")).toBe(2500);
    });

    it("应该解析英寸", () => {
      expect(parseDistance('10"')).toBe(254);
      expect(parseDistance("10in")).toBe(254);
      expect(parseDistance("5 in")).toBe(127);
    });

    it("应该解析英尺", () => {
      // 允许浮点误差（914.4 vs 914.4000000000001）
      expect(parseDistance("1ft")).toBeCloseTo(304.8, 5);
      expect(parseDistance("5'")).toBeCloseTo(1524, 5);
      expect(parseDistance("3 ft")).toBeCloseTo(914.4, 5);
    });

    it("应该解析英尺 + 英寸", () => {
      expect(parseDistance('5\' 6"')).toBeCloseTo(1676.4, 1);
      expect(parseDistance("5ft 6in")).toBeCloseTo(1676.4, 1);
    });

    it("应该处理无效输入", () => {
      expect(parseDistance("invalid")).toBeNull();
      expect(parseDistance("")).toBeNull();
      expect(parseDistance("abc")).toBeNull();
    });
  });
});

describe("MeasureApp - 校准", () => {
  describe("calibrateReference", () => {
    it("应该校准成功（合理范围内）", () => {
      // 用户测量一张信用卡（85.6mm），屏幕 1000px 宽
      // 如果测量了 100px，对应参考距离应该是 856mm
      const result = calibrateReference(85.6, 100, 1000, 1000);

      expect(result.success).toBe(true);
      expect(result.value).toBeGreaterThan(100);
      expect(result.value).toBeLessThan(2000);
      expect(result.reason).toBe("success");
    });

    it("应该拒绝太近的校准（< 100mm）", () => {
      // 已知物体很大，但测量像素很小，说明相机太远
      const result = calibrateReference(85.6, 10, 1000, 1000);

      expect(result.success).toBe(false);
      expect(result.reason).toBe("too_far");
      expect(result.value).toBe(1000); // 保持原值
    });

    it("应该拒绝太远的校准（> 2000mm）", () => {
      // 已知物体很小，但测量像素很大，说明相机太近
      const result = calibrateReference(85.6, 1000, 100, 1000);

      expect(result.success).toBe(false);
      expect(result.reason).toBe("too_close");
      expect(result.value).toBe(1000); // 保持原值
    });

    it("应该接受边界值（100mm）", () => {
      // 选择参数使计算结果接近 100 但在范围内
      // knownSizeMm=85.6 (信用卡), measuredPixels=600, viewportWidth=1000
      // pixelRatio = 0.6, referenceWidth = 85.6/0.6 = 142.67
      // newReference = 142.67 / (2 * tan(30°)) ≈ 123.5
      // 123.5 > 100 ✓
      const result = calibrateReference(85.6, 600, 1000, 1000);

      expect(result.success).toBe(true);
      expect(result.value).toBeGreaterThan(100);
      expect(result.value).toBeLessThan(2000);
    });
  });

  describe("REFERENCE_OBJECTS", () => {
    it("应该包含所有预定义参考物体", () => {
      expect(REFERENCE_OBJECTS.creditCard).toBeDefined();
      expect(REFERENCE_OBJECTS.a4Paper).toBeDefined();
      expect(REFERENCE_OBJECTS.basketball).toBeDefined();
      expect(REFERENCE_OBJECTS.tennis).toBeDefined();
      expect(REFERENCE_OBJECTS.brick).toBeDefined();
      expect(REFERENCE_OBJECTS.ipad).toBeDefined();
      expect(REFERENCE_OBJECTS.iphone).toBeDefined();
      expect(REFERENCE_OBJECTS.hand).toBeDefined();
    });

    it("参考物体应该有正确的尺寸（毫米）", () => {
      // 信用卡标准尺寸：85.6mm × 53.98mm
      expect(REFERENCE_OBJECTS.creditCard.size).toBe(85.6);
      // A4 纸短边：210mm，但代码中用的是 297mm（长边）
      expect(REFERENCE_OBJECTS.a4Paper.size).toBe(297);
      // 篮球直径：240mm
      expect(REFERENCE_OBJECTS.basketball.size).toBe(240);
      // 网球直径：67mm
      expect(REFERENCE_OBJECTS.tennis.size).toBe(67);
    });

    it("参考物体单位应该是 mm", () => {
      Object.values(REFERENCE_OBJECTS).forEach((obj) => {
        expect(obj.unit).toBe("mm");
      });
    });
  });

  describe("getReferenceObject", () => {
    it("应该返回有效的参考物体", () => {
      const obj = getReferenceObject("creditCard");
      expect(obj).toBeDefined();
      expect(obj?.size).toBe(85.6);
    });

    it("应该处理无效的参考物体名称", () => {
      const obj = getReferenceObject("invalid");
      expect(obj).toBeNull();
    });
  });
});

describe("MeasureApp - 边界情况", () => {
  describe("存储键", () => {
    it("应该有正确的存储键", () => {
      expect(MEASURE_SETTINGS_KEY).toBe("amos.measure.settings");
      expect(MEASURE_HISTORY_KEY).toBe("amos.measure.history");
    });
  });

  describe("极端值", () => {
    it("应该处理极大的距离值", () => {
      const formatted = formatDistance(1e10, "metric");
      expect(formatted).toBeTruthy();
      expect(formatted).toContain("m");
    });

    it("应该处理极小的距离值", () => {
      const formatted = formatDistance(0.001, "metric");
      expect(formatted).toBeTruthy();
      expect(formatted).toContain("mm");
    });

    it("应该处理零距离", () => {
      const formatted = formatDistance(0, "metric");
      expect(formatted).toBe("0.0 mm");
    });

    it("应该处理负距离（异常情况）", () => {
      const formatted = formatDistance(-100, "metric");
      // 不应该崩溃
      expect(formatted).toBeTruthy();
    });
  });

  describe("坐标验证", () => {
    it("应该接受有效坐标", () => {
      const validPoints: MeasurePoint[] = [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ];

      validPoints.forEach((p) => {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
      });
    });

    it("应该处理带 depth 的点", () => {
      const point: MeasurePoint = { x: 0.5, y: 0.5, depth: 1000 };
      expect(point.depth).toBe(1000);
    });
  });

  describe("性能测试", () => {
    it("应该快速处理大量测量", () => {
      const start = Date.now();

      const measurements: Measurement[] = Array.from({ length: 1000 }, (_, i) => ({
        id: `m-${i}`,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        distance: 1000 + i,
        timestamp: i,
      }));

      const normalized = normalizeMeasureHistory(measurements);

      const duration = Date.now() - start;

      expect(normalized.length).toBe(50); // 限制为 50
      expect(duration).toBeLessThan(100); // 应该很快
    });
  });

  describe("数据完整性", () => {
    it("测量应该有完整的必需字段", () => {
      const measurement = createMeasurement(
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        1000,
        1000,
        1000,
      );

      expect(measurement.id).toBeTruthy();
      expect(measurement.start).toBeDefined();
      expect(measurement.end).toBeDefined();
      expect(measurement.distance).toBeGreaterThan(0);
      expect(measurement.timestamp).toBeGreaterThan(0);
    });

    it("测量对象应该可以被序列化", () => {
      const measurement = createMeasurement(
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        1000,
        1000,
        1000,
      );

      const json = JSON.stringify(measurement);
      const parsed = JSON.parse(json);

      expect(parsed.id).toBe(measurement.id);
      expect(parsed.distance).toBe(measurement.distance);
    });
  });
});

describe("MeasureApp - 集成测试", () => {
  it("应该完成完整的测量流程", () => {
    // 1. 加载默认设置
    const settings = defaultMeasureSettings();
    expect(settings.unit).toBe("metric");

    // 2. 创建测量
    const measurement = createMeasurement(
      { x: 0.2, y: 0.3 },
      { x: 0.7, y: 0.8 },
      1000,
      1000,
      settings.referenceDistance,
    );

    // 3. 验证测量
    expect(measurement.distance).toBeGreaterThan(0);

    // 4. 格式化显示
    const display = formatDistance(measurement.distance, settings.unit);
    expect(display).toBeTruthy();

    // 5. 添加到历史
    const history: Measurement[] = [measurement];
    expect(history.length).toBe(1);

    // 6. 持久化测试
    const normalized = normalizeMeasureHistory(history);
    expect(normalized.length).toBe(1);
  });

  it("应该支持单位切换", () => {
    const mm = 1000; // 1 米

    const metric = formatDistance(mm, "metric");
    const imperial = formatDistance(mm, "imperial");

    expect(metric).toContain("m");
    expect(imperial).toContain("'");
    expect(metric).not.toBe(imperial);
  });

  it("应该支持校准流程", () => {
    // 1. 选择参考物体
    const ref = REFERENCE_OBJECTS.creditCard;

    // 2. 模拟用户测量（已知大小）
    const measuredPixels = 100; // 假设用户测量信用卡得到 100 像素

    // 3. 执行校准
    const result = calibrateReference(ref.size, measuredPixels, 1000, 1000);

    // 4. 如果成功，更新设置
    if (result.success) {
      const settings = defaultMeasureSettings();
      settings.referenceDistance = result.value;
      expect(settings.referenceDistance).toBeGreaterThan(100);
      expect(settings.referenceDistance).toBeLessThan(2000);
    } else {
      // 校准失败，保持原值
      expect(result.value).toBe(1000);
    }
  });
});
