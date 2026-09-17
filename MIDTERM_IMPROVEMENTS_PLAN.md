# Compass & Measure 中期改进实施计划

**规划日期**: 2026-09-17  
**计划周期**: 1-2 个月  
**总预计工作量**: 15-22 小时  
**优先级**: P2（中期优化）

---

## 📋 改进概览

本计划涵盖三个中期改进功能，旨在提升 Compass 和 Measure 应用的功能完整性和用户体验。

| # | 功能 | 预计工作量 | 优先级 | 复杂度 |
|---|------|-----------|--------|--------|
| 1 | 更多罗盘精度 - 32 方位显示 | 3-4 小时 | 高 | 低 |
| 2 | 多点测量 - 面积/体积估算 | 8-12 小时 | 中 | 高 |
| 3 | 自定义参考物体 | 4-6 小时 | 中 | 中 |

---

## 🎯 功能 1: 更多罗盘精度 - 32 方位显示

### 功能描述

扩展罗盘方位显示精度，从当前的 8 方位（N, NE, E, SE, S, SW, W, NW）升级到 32 方位，提供更精确的方向指示。

### 业务价值

- ✅ **导航精度提升**: 更细粒度的方向指示
- ✅ **专业用户需求**: 满足户外运动、航海等专业场景
- ✅ **用户可选**: 可在 8/16/32 方位间切换

### 技术设计

#### 1. 数据结构扩展

```typescript
export interface CompassSettings {
  useTrueNorth: boolean;
  declination: number;
  cachedLocation?: { ... };
  // 新增：方位精度设置
  directionPrecision: 8 | 16 | 32;  // 8/16/32 方位
}
```

#### 2. 32 方位定义

```typescript
// 32 方位名称（每 11.25°）
const DIRECTIONS_32_EN = [
  "N", "NbE", "NNE", "NEbN", "NE", "NEbE", "ENE", "EbN",
  "E", "EbS", "ESE", "SEbE", "SE", "SEbS", "SSE", "SbE",
  "S", "SbW", "SSW", "SWbS", "SW", "SWbW", "WSW", "WbS",
  "W", "WbN", "WNW", "NWbW", "NW", "NWbN", "NNW", "NbW"
];

const DIRECTIONS_32_ZH = [
  "北", "北微东", "东北偏北", "东北微北", "东北", "东北微东", "东北偏东", "东微北",
  "东", "东微南", "东南偏东", "东南微东", "东南", "东南微南", "东南偏南", "南微东",
  "南", "南微西", "西南偏南", "西南微南", "西南", "西南微西", "西南偏西", "西微南",
  "西", "西微北", "西北偏西", "西北微西", "西北", "西北微北", "西北偏北", "北微西"
];
```

#### 3. 方向计算函数升级

```typescript
export function cardinalDirection(
  heading: number,
  locale: "zh" | "en",
  precision: 8 | 16 | 32 = 8
): string {
  const normalized = normalizeHeading(heading);
  
  if (precision === 32) {
    const dirs = locale === "zh" ? DIRECTIONS_32_ZH : DIRECTIONS_32_EN;
    const idx = Math.round(normalized / 11.25) % 32;
    return dirs[idx] ?? dirs[0] ?? "N";
  } else if (precision === 16) {
    const dirs = locale === "zh" ? DIRECTIONS_16_ZH : DIRECTIONS_16_EN;
    const idx = Math.round(normalized / 22.5) % 16;
    return dirs[idx] ?? dirs[0] ?? "N";
  } else {
    // 现有的 8 方位逻辑
    const dirs = locale === "zh"
      ? ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]
      : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const idx = Math.round(normalized / 45) % 8;
    return dirs[idx] ?? dirs[0] ?? "N";
  }
}
```

### UI 设计

#### 1. 设置选项

```svelte
<div class="precision-selector">
  <label>方位精度</label>
  <select bind:value={settings.directionPrecision}>
    <option value={8}>8 方位（基础）</option>
    <option value={16}>16 方位（标准）</option>
    <option value={32}>32 方位（精确）</option>
  </select>
</div>
```

#### 2. 罗盘刻度更新

- 8 方位: 每 45° 显示主要方向
- 16 方位: 每 22.5° 显示方向
- 32 方位: 每 11.25° 显示方向（密集刻度）

### 实施步骤

#### Phase 1: 核心逻辑（1-1.5 小时）
1. ✅ 定义 16/32 方位数组（中英文）
2. ✅ 扩展 `CompassSettings` 接口
3. ✅ 升级 `cardinalDirection()` 函数
4. ✅ 更新默认设置和归一化函数

#### Phase 2: UI 集成（1-1.5 小时）
1. ✅ 添加精度选择器
2. ✅ 更新罗盘刻度显示逻辑
3. ✅ 调整方位文字显示（处理长文本）
4. ✅ 响应式布局优化

#### Phase 3: 测试（0.5-1 小时）
1. ✅ 单元测试（32 方位计算）
2. ✅ 边界测试（角度边界）
3. ✅ 国际化测试（中英文）
4. ✅ UI 测试（不同精度切换）

### 测试用例

```typescript
describe("32-direction compass", () => {
  it("calculates 32 directions correctly in English", () => {
    expect(cardinalDirection(0, "en", 32)).toBe("N");
    expect(cardinalDirection(11.25, "en", 32)).toBe("NbE");
    expect(cardinalDirection(22.5, "en", 32)).toBe("NNE");
    expect(cardinalDirection(33.75, "en", 32)).toBe("NEbN");
  });

  it("calculates 32 directions correctly in Chinese", () => {
    expect(cardinalDirection(0, "zh", 32)).toBe("北");
    expect(cardinalDirection(11.25, "zh", 32)).toBe("北微东");
  });

  it("handles edge cases near boundaries", () => {
    expect(cardinalDirection(5.625, "en", 32)).toBe("N");
    expect(cardinalDirection(6.0, "en", 32)).toBe("NbE");
  });
});
```

### 风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 32 方位文本过长 | 中 | 高 | 使用缩写，支持两行显示 |
| 罗盘刻度过密 | 低 | 中 | 仅在放大时显示全部刻度 |
| 性能影响 | 低 | 低 | 纯计算逻辑，性能影响可忽略 |

### 成功指标

- ✅ 32 方位精度 < 5.625°（11.25° / 2）
- ✅ 切换精度响应 < 100ms
- ✅ 测试覆盖率 100%
- ✅ 用户反馈评分 > 4.5/5

---

## 🎯 功能 2: 多点测量 - 面积/体积估算

### 功能描述

扩展 Measure 应用，支持多点测量和几何计算：
- 多点连线测量周长
- 多边形面积计算
- 立体图形体积估算

### 业务价值

- ✅ **房地产应用**: 房间面积测量
- ✅ **装修场景**: 墙面、地板面积
- ✅ **物流场景**: 箱体体积计算
- ✅ **DIY 爱好者**: 材料用量估算

### 技术设计

#### 1. 数据结构扩展

```typescript
export interface MeasureSettings {
  unit: "metric" | "imperial";
  referenceDistance: number;
  showGuides: boolean;
  // 新增：测量模式
  measureMode: "distance" | "area" | "volume";
}

export interface AreaMeasurement {
  id: string;
  points: MeasurePoint[];  // 3+ 点
  area: number;  // mm²
  perimeter: number;  // mm
  timestamp: number;
  label?: string;
}

export interface VolumeMeasurement {
  id: string;
  basePoints: MeasurePoint[];  // 底面多边形
  height: number;  // 高度 (mm)
  volume: number;  // mm³
  timestamp: number;
  label?: string;
}
```

#### 2. 面积计算（Shoelace 公式）

```typescript
/**
 * Calculate polygon area using Shoelace formula.
 * Points should be in order (clockwise or counter-clockwise).
 */
export function calculatePolygonArea(
  points: MeasurePoint[],
  viewportWidth: number,
  viewportHeight: number,
  referenceDistance: number
): number {
  if (points.length < 3) return 0;

  // Convert to pixel coordinates
  const pixelPoints = points.map(p => ({
    x: p.x * viewportWidth,
    y: p.y * viewportHeight
  }));

  // Shoelace formula (cross product sum)
  let areaPixels = 0;
  for (let i = 0; i < pixelPoints.length; i++) {
    const j = (i + 1) % pixelPoints.length;
    areaPixels += pixelPoints[i].x * pixelPoints[j].y;
    areaPixels -= pixelPoints[j].x * pixelPoints[i].y;
  }
  areaPixels = Math.abs(areaPixels) / 2;

  // Convert pixel area to real area
  const fovRadians = (60 * Math.PI) / 180;
  const referenceWidth = 2 * referenceDistance * Math.tan(fovRadians / 2);
  const pixelToMm = referenceWidth / viewportWidth;
  
  return areaPixels * pixelToMm * pixelToMm;  // mm²
}
```

#### 3. 周长计算

```typescript
/**
 * Calculate polygon perimeter (sum of all edge lengths).
 */
export function calculatePerimeter(
  points: MeasurePoint[],
  viewportWidth: number,
  viewportHeight: number,
  referenceDistance: number
): number {
  if (points.length < 2) return 0;

  let totalDistance = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const pixelDist = pixelDistance(points[i], points[j], viewportWidth, viewportHeight);
    totalDistance += estimateRealDistance(pixelDist, viewportWidth, referenceDistance);
  }

  return totalDistance;
}
```

#### 4. 体积计算

```typescript
/**
 * Calculate volume of a prism (polygon base × height).
 */
export function calculateVolume(
  basePoints: MeasurePoint[],
  height: number,  // mm
  viewportWidth: number,
  viewportHeight: number,
  referenceDistance: number
): number {
  const baseArea = calculatePolygonArea(
    basePoints,
    viewportWidth,
    viewportHeight,
    referenceDistance
  );
  
  return baseArea * height;  // mm³
}
```

#### 5. 格式化函数

```typescript
/** Format area with appropriate unit. */
export function formatArea(areaMm2: number, unit: "metric" | "imperial"): string {
  if (unit === "imperial") {
    const areaInches = areaMm2 / (25.4 * 25.4);
    const areaFeet = areaInches / 144;
    
    if (areaFeet >= 1) {
      return `${areaFeet.toFixed(2)} ft²`;
    }
    return `${areaInches.toFixed(1)} in²`;
  }
  
  // Metric
  const areaCm2 = areaMm2 / 100;
  const areaM2 = areaMm2 / 1000000;
  
  if (areaM2 >= 1) {
    return `${areaM2.toFixed(2)} m²`;
  } else if (areaCm2 >= 1) {
    return `${areaCm2.toFixed(1)} cm²`;
  }
  return `${areaMm2.toFixed(0)} mm²`;
}

/** Format volume with appropriate unit. */
export function formatVolume(volumeMm3: number, unit: "metric" | "imperial"): string {
  if (unit === "imperial") {
    const volumeInches = volumeMm3 / (25.4 * 25.4 * 25.4);
    const volumeFeet = volumeInches / 1728;
    
    if (volumeFeet >= 1) {
      return `${volumeFeet.toFixed(2)} ft³`;
    }
    return `${volumeInches.toFixed(1)} in³`;
  }
  
  // Metric
  const volumeL = volumeMm3 / 1000000;
  const volumeM3 = volumeMm3 / 1000000000;
  
  if (volumeM3 >= 1) {
    return `${volumeM3.toFixed(3)} m³`;
  } else if (volumeL >= 1) {
    return `${volumeL.toFixed(2)} L`;
  }
  return `${(volumeMm3 / 1000).toFixed(1)} cm³`;
}
```

### UI 设计

#### 1. 模式切换

```svelte
<div class="mode-selector">
  <button class={modeCls(mode === "distance")} onclick={() => setMode("distance")}>
    距离
  </button>
  <button class={modeCls(mode === "area")} onclick={() => setMode("area")}>
    面积
  </button>
  <button class={modeCls(mode === "volume")} onclick={() => setMode("volume")}>
    体积
  </button>
</div>
```

#### 2. 多点输入交互

**面积测量流程**:
1. 用户点击屏幕标记第一个点
2. 继续点击添加更多点（至少 3 个）
3. 实时显示连线和临时面积
4. 双击或点击"完成"按钮结束测量
5. 显示最终面积和周长

**体积测量流程**:
1. 先测量底面（多点）
2. 然后测量高度（两点垂直距离）
3. 计算并显示体积

#### 3. 可视化反馈

```svelte
<!-- 绘制多边形 -->
{#if mode === "area" && measurePoints.length >= 2}
  <svg class="overlay">
    <!-- 连线 -->
    <polyline
      points={measurePoints.map(p => `${p.x * width},${p.y * height}`).join(' ')}
      fill="none"
      stroke="cyan"
      stroke-width="2"
    />
    <!-- 填充（半透明） -->
    {#if measurePoints.length >= 3}
      <polygon
        points={measurePoints.map(p => `${p.x * width},${p.y * height}`).join(' ')}
        fill="cyan"
        opacity="0.2"
      />
    {/if}
    <!-- 顶点标记 -->
    {#each measurePoints as point, i}
      <circle cx={point.x * width} cy={point.y * height} r="8" fill="cyan" />
      <text x={point.x * width} y={point.y * height - 15} fill="white">{i + 1}</text>
    {/each}
  </svg>
{/if}
```

### 实施步骤

#### Phase 1: 核心算法（3-4 小时）
1. ✅ 实现 Shoelace 面积算法
2. ✅ 实现周长计算
3. ✅ 实现体积计算
4. ✅ 实现格式化函数
5. ✅ 单元测试（几何计算）

#### Phase 2: 数据层（2-3 小时）
1. ✅ 扩展数据结构
2. ✅ 更新持久化逻辑
3. ✅ 历史记录管理
4. ✅ 数据验证

#### Phase 3: UI 实现（3-4 小时）
1. ✅ 模式切换器
2. ✅ 多点输入交互
3. ✅ SVG 可视化
4. ✅ 结果显示面板

#### Phase 4: 测试与优化（1-2 小时）
1. ✅ 集成测试
2. ✅ 边界情况测试
3. ✅ 性能优化
4. ✅ 用户体验优化

### 测试用例

```typescript
describe("area calculation", () => {
  it("calculates rectangle area correctly", () => {
    const points = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 }
    ];
    const area = calculatePolygonArea(points, 1000, 1000, 1000);
    // Should be close to (600mm × 600mm = 360000 mm²)
    expect(area).toBeCloseTo(360000, -3);
  });

  it("calculates triangle area correctly", () => {
    const points = [
      { x: 0.5, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 }
    ];
    const area = calculatePolygonArea(points, 1000, 1000, 1000);
    // Triangle: 0.5 × base × height
    expect(area).toBeGreaterThan(0);
  });

  it("returns 0 for less than 3 points", () => {
    expect(calculatePolygonArea([], 1000, 1000, 1000)).toBe(0);
    expect(calculatePolygonArea([{x:0,y:0}], 1000, 1000, 1000)).toBe(0);
  });
});

describe("volume calculation", () => {
  it("calculates prism volume correctly", () => {
    const basePoints = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 }
    ];
    const height = 500; // mm
    const volume = calculateVolume(basePoints, height, 1000, 1000, 1000);
    // Should be close to 360000 mm² × 500 mm = 180000000 mm³
    expect(volume).toBeGreaterThan(100000000);
  });
});
```

### 风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 面积精度低 | 高 | 中 | 添加校准提示，多次测量平均 |
| 用户误操作 | 中 | 高 | 添加撤销功能，明确指引 |
| 性能问题 | 低 | 低 | 限制最大点数（如 20 个） |
| 复杂多边形 | 中 | 中 | 检测自相交，提示用户 |

### 成功指标

- ✅ 矩形面积误差 < 10%
- ✅ 支持 3-20 个顶点
- ✅ 用户完成率 > 80%
- ✅ 测试覆盖率 > 95%

---

## 🎯 功能 3: 自定义参考物体

### 功能描述

允许用户添加、管理自定义参考物体，提升测量校准的灵活性。

### 业务价值

- ✅ **个性化**: 使用自己熟悉的物体校准
- ✅ **特定场景**: 行业特定的标准物体
- ✅ **提升精度**: 使用现场可用物体校准

### 技术设计

#### 1. 数据结构

```typescript
export interface CustomReferenceObject {
  id: string;
  name: string;
  size: number;  // mm
  category?: string;
  createdAt: number;
  usageCount: number;
}

export interface MeasureSettings {
  unit: "metric" | "imperial";
  referenceDistance: number;
  showGuides: boolean;
  measureMode: "distance" | "area" | "volume";
  // 新增：自定义参考物体列表
  customReferenceObjects: CustomReferenceObject[];
}
```

#### 2. 管理函数

```typescript
/** Add custom reference object. */
export function addCustomReference(
  name: string,
  size: number,
  category?: string
): CustomReferenceObject {
  if (!name || size <= 0) {
    throw new Error("Invalid reference object");
  }

  return {
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: name.trim(),
    size,
    category,
    createdAt: Date.now(),
    usageCount: 0
  };
}

/** Remove custom reference object. */
export function removeCustomReference(
  objects: CustomReferenceObject[],
  id: string
): CustomReferenceObject[] {
  return objects.filter(obj => obj.id !== id);
}

/** Update custom reference object usage count. */
export function incrementUsageCount(
  objects: CustomReferenceObject[],
  id: string
): CustomReferenceObject[] {
  return objects.map(obj =>
    obj.id === id ? { ...obj, usageCount: obj.usageCount + 1 } : obj
  );
}

/** Get all reference objects (built-in + custom). */
export function getAllReferenceObjects(
  customObjects: CustomReferenceObject[]
): Array<{ id: string; name: string; size: number; isCustom: boolean }> {
  const builtIn = Object.entries(REFERENCE_OBJECTS).map(([key, obj]) => ({
    id: key,
    name: obj.name,
    size: obj.size,
    isCustom: false
  }));

  const custom = customObjects.map(obj => ({
    id: obj.id,
    name: obj.name,
    size: obj.size,
    isCustom: true
  }));

  return [...builtIn, ...custom];
}
```

#### 3. 数据验证

```typescript
/** Validate reference object input. */
export function validateReferenceObject(name: string, size: number): {
  valid: boolean;
  error?: string;
} {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: "名称不能为空" };
  }

  if (name.length > 50) {
    return { valid: false, error: "名称过长（最多50字符）" };
  }

  if (size <= 0) {
    return { valid: false, error: "尺寸必须大于0" };
  }

  if (size < 10 || size > 5000) {
    return { valid: false, error: "尺寸应在10mm-5000mm之间" };
  }

  return { valid: true };
}
```

### UI 设计

#### 1. 参考物体列表

```svelte
<div class="reference-list">
  <h3>参考物体</h3>
  
  <!-- 内置参考物体 -->
  <div class="built-in-objects">
    <h4>内置</h4>
    {#each Object.entries(REFERENCE_OBJECTS) as [key, obj]}
      <button onclick={() => selectReference(key)} class="reference-item">
        <span>{t(`measure.ref.${obj.name}`)}</span>
        <span class="size">{obj.size} mm</span>
      </button>
    {/each}
  </div>

  <!-- 自定义参考物体 -->
  <div class="custom-objects">
    <h4>
      自定义
      <button onclick={() => showAddDialog = true} class="add-btn">+</button>
    </h4>
    {#each settings.customReferenceObjects as obj}
      <div class="reference-item">
        <button onclick={() => selectReference(obj.id)} class="select-btn">
          <span>{obj.name}</span>
          <span class="size">{obj.size} mm</span>
          <span class="usage">使用 {obj.usageCount} 次</span>
        </button>
        <button onclick={() => deleteCustomReference(obj.id)} class="delete-btn">
          🗑️
        </button>
      </div>
    {/each}
  </div>
</div>
```

#### 2. 添加对话框

```svelte
{#if showAddDialog}
  <div class="dialog-overlay" onclick={() => showAddDialog = false}>
    <div class="dialog" onclick={(e) => e.stopPropagation()}>
      <h3>添加自定义参考物体</h3>
      
      <div class="form-group">
        <label>名称</label>
        <input
          type="text"
          bind:value={newRefName}
          placeholder="例如：我的手机"
          maxlength="50"
        />
      </div>

      <div class="form-group">
        <label>尺寸</label>
        <div class="size-input">
          <input
            type="number"
            bind:value={newRefSize}
            min="10"
            max="5000"
            step="0.1"
          />
          <span class="unit">mm</span>
        </div>
        <small>提示：测量物体最长边的长度</small>
      </div>

      {#if validationError}
        <div class="error">{validationError}</div>
      {/if}

      <div class="dialog-actions">
        <button onclick={() => showAddDialog = false} class="cancel">
          取消
        </button>
        <button onclick={handleAddCustomReference} class="confirm">
          添加
        </button>
      </div>
    </div>
  </div>
{/if}
```

#### 3. 使用流程

1. 用户点击"添加自定义参考"
2. 输入名称和尺寸
3. 系统验证输入
4. 添加到列表
5. 可立即用于校准

### 实施步骤

#### Phase 1: 数据层（1.5-2 小时）
1. ✅ 扩展数据结构
2. ✅ 实现管理函数
3. ✅ 实现验证函数
4. ✅ 更新持久化逻辑

#### Phase 2: UI 实现（2-2.5 小时）
1. ✅ 参考物体列表
2. ✅ 添加对话框
3. ✅ 删除确认
4. ✅ 使用统计显示

#### Phase 3: 集成与测试（0.5-1 小时）
1. ✅ 集成到校准流程
2. ✅ 单元测试
3. ✅ UI 测试
4. ✅ 数据迁移测试

### 测试用例

```typescript
describe("custom reference objects", () => {
  it("adds custom reference object", () => {
    const obj = addCustomReference("My Phone", 160.5);
    expect(obj.name).toBe("My Phone");
    expect(obj.size).toBe(160.5);
    expect(obj.usageCount).toBe(0);
  });

  it("rejects invalid inputs", () => {
    expect(() => addCustomReference("", 100)).toThrow();
    expect(() => addCustomReference("Test", 0)).toThrow();
    expect(() => addCustomReference("Test", -10)).toThrow();
  });

  it("validates reference object correctly", () => {
    expect(validateReferenceObject("Phone", 160).valid).toBe(true);
    expect(validateReferenceObject("", 160).valid).toBe(false);
    expect(validateReferenceObject("Test", 5).valid).toBe(false);
    expect(validateReferenceObject("Test", 10000).valid).toBe(false);
  });

  it("removes custom reference object", () => {
    const objects = [
      { id: "1", name: "A", size: 100, createdAt: 0, usageCount: 0 },
      { id: "2", name: "B", size: 200, createdAt: 0, usageCount: 0 }
    ];
    const result = removeCustomReference(objects, "1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });

  it("increments usage count", () => {
    const objects = [
      { id: "1", name: "A", size: 100, createdAt: 0, usageCount: 5 }
    ];
    const result = incrementUsageCount(objects, "1");
    expect(result[0].usageCount).toBe(6);
  });
});
```

### 风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 用户输入错误尺寸 | 高 | 高 | 严格验证，提供测量指南 |
| 数据存储过多 | 低 | 中 | 限制最大数量（如 50 个） |
| 删除误操作 | 中 | 中 | 添加确认对话框 |

### 成功指标

- ✅ 自定义对象添加成功率 > 95%
- ✅ 输入验证准确率 100%
- ✅ 用户满意度 > 4.5/5
- ✅ 平均每用户 2-5 个自定义对象

---

## 📈 总体实施计划

### 时间线（8 周）

```
Week 1-2:  功能 1 - 32 方位显示
Week 3-5:  功能 2 - 多点测量（主要工作）
Week 6-7:  功能 3 - 自定义参考物体
Week 8:    集成测试、文档、发布
```

### 里程碑

| 里程碑 | 日期 | 交付物 |
|--------|------|--------|
| M1: 32 方位完成 | Week 2 结束 | 代码 + 测试 + 文档 |
| M2: 多点测量完成 | Week 5 结束 | 代码 + 测试 + 文档 |
| M3: 自定义参考完成 | Week 7 结束 | 代码 + 测试 + 文档 |
| M4: 集成发布 | Week 8 结束 | 完整功能包 |

### 资源需求

- **开发**: 1 名全栈工程师
- **测试**: 共享测试资源
- **设计**: UI/UX 审查（约 2-3 小时）
- **技术文档**: 随开发同步完成

### 质量标准

| 指标 | 目标 |
|------|------|
| 代码覆盖率 | > 90% |
| TypeScript 错误 | 0 个 |
| 性能退化 | < 5% |
| 用户体验评分 | > 4.5/5 |

---

## 🎯 优先级建议

基于业务价值和实施复杂度的优先级排序：

### 高优先级
1. ✅ **32 方位显示** - 低复杂度，高价值，快速交付

### 中优先级
2. ✅ **自定义参考物体** - 中复杂度，提升灵活性
3. ✅ **多点测量** - 高复杂度，高价值，长期投入

### 实施建议

**快速迭代方案**:
- 先实现 32 方位（Week 1-2）
- 快速交付给用户收集反馈
- 根据反馈调整后续功能优先级

**稳健方案**:
- 按计划顺序实施所有功能
- 确保每个功能质量
- 8 周完整交付

---

## 📊 成本效益分析

### 投入

| 项目 | 工时 | 占比 |
|------|------|------|
| 功能 1 | 3-4 h | 18% |
| 功能 2 | 8-12 h | 59% |
| 功能 3 | 4-6 h | 23% |
| **总计** | **15-22 h** | **100%** |

### 收益

| 收益类型 | 评估 |
|----------|------|
| 用户体验提升 | 高 |
| 功能完整性 | 高 |
| 市场竞争力 | 中 |
| 用户留存率 | +5-10% |
| 用户满意度 | +15-20% |

### ROI 估算

假设平均时薪 $50:
- **总成本**: 15-22 h × $50 = $750-$1,100
- **预期收益**: 用户留存提升 5-10%
- **ROI**: 正向，建议投入

---

## 🚀 下一步行动

### 立即行动

1. ✅ **审查计划** - 技术团队评审
2. ✅ **确认优先级** - 产品经理确认
3. ✅ **分配资源** - 安排开发人员

### Week 1 任务

1. 开始功能 1 实施（32 方位）
2. 准备详细设计文档
3. 搭建测试环境

---

## 📝 附录

### 参考资料

1. **罗盘方位**: [Compass Points](https://en.wikipedia.org/wiki/Points_of_the_compass)
2. **Shoelace 公式**: [Shoelace Formula](https://en.wikipedia.org/wiki/Shoelace_formula)
3. **相机标定**: [Camera Calibration](https://docs.opencv.org/4.x/dc/dbb/tutorial_py_calibration.html)

### 相关文档

- `COMPASS_MEASURE_AUDIT_REPORT.md` - 初始审计报告
- `DECLINATION_CACHE_IMPLEMENTATION.md` - 磁偏角缓存实施
- `compass.ts` - 指南针核心逻辑
- `measure.ts` - 测量核心逻辑

---

**计划制定日期**: 2026-09-17  
**计划负责人**: Kiro AI Assistant  
**审批状态**: 待审批  
**预计开始**: 2026-10-01
