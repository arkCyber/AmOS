# 指南针 (Compass) - 航空航天级审计与补全计划

**日期**: 2026年9月17日  
**优先级**: P2 (工具类应用)  
**当前状态**: 已实现核心功能，需增强测试与错误处理  
**预估工作量**: 2-3 天

---

## 一、当前状态评估

### 1.1 已实现功能

✅ **核心逻辑** (`compass.ts` - 226 行)
- 设备方向支持检测
- iOS 13+ 权限请求
- 磁北/真北切换
- 磁偏角计算与缓存
- 罗盘方向解析（8 个方位）
- 水平仪功能（倾斜角度）
- 坐标计算（Haversine 公式）

✅ **测试覆盖** (`compass.test.ts` - 173 行)
- 设置标准化测试
- 方向解析测试（中英文）
- 角度标准化测试
- 磁偏角应用测试
- 水平仪百分比测试
- 水平检测测试

### 1.2 代码质量指标

| 指标 | 当前值 | 目标值 | 状态 |
|------|--------|--------|------|
| 代码行数 | 226 | N/A | ✅ |
| 测试用例 | 30 | 50+ | ⚠️ 需增强 |
| 测试覆盖率 | ~70% | >95% | ⚠️ 需提升 |
| 圈复杂度 | 2-5 | <10 | ✅ |
| 外部依赖 | 1 (Web API) | <3 | ✅ |
| 文档注释 | 部分 | 完整 | ⚠️ 需补充 |

### 1.3 发现的问题

#### 高优先级问题
1. **磁偏角缓存逻辑未完全测试** - `isCachedDeclinationValid`, `fetchDeclinationWithCache` 无单元测试
2. **API 错误处理不够健壮** - `fetchDeclination` 仅返回 0，无错误上下文
3. **边界条件测试不足** - 极地坐标、日期线跨越等
4. **性能测试缺失** - Haversine 计算性能未基准测试

#### 中优先级问题
5. **日志记录缺失** - 无 Logger 集成，难以调试
6. **类型定义不完整** - `cachedLocation` 在 `normalizeCompassSettings` 中缺失
7. **国际化支持受限** - 仅支持中英文，缺少其他语言
8. **配置验证不严格** - `declination` 应验证范围 (-180, 180)

#### 低优先级问题
9. **缓存策略可优化** - 7 天过期时间硬编码，应可配置
10. **API 依赖单一** - 仅 NOAA，无备用 API

---

## 二、航空航天级标准要求

### 2.1 可靠性
- [ ] 所有公共函数有错误处理
- [ ] 所有异步操作有超时保护
- [ ] 网络故障时有降级方案
- [ ] 数据验证严格（经纬度范围、角度范围）

### 2.2 安全性
- [ ] 输入验证（防止注入攻击）
- [ ] API 响应验证（防止恶意数据）
- [ ] 权限请求安全处理
- [ ] 缓存数据完整性验证

### 2.3 性能
- [ ] Haversine 计算 < 1ms
- [ ] 磁偏角获取 < 5s (含网络)
- [ ] 缓存命中率 > 90%
- [ ] 内存占用 < 1MB

### 2.4 可维护性
- [ ] 完整 JSDoc 注释
- [ ] 函数单一职责
- [ ] 纯函数设计（无副作用）
- [ ] 类型安全（TypeScript strict 模式）

### 2.5 可观测性
- [ ] 关键操作日志记录
- [ ] 性能指标收集
- [ ] 错误追踪集成
- [ ] 调试信息输出

### 2.6 测试覆盖
- [ ] 单元测试覆盖率 > 95%
- [ ] 边界条件测试
- [ ] 错误路径测试
- [ ] 性能基准测试

---

## 三、审计任务清单

### Phase 1: 代码审计与修复 (1 天)

#### 任务 1.1: 类型系统增强
- [ ] 为 `normalizeCompassSettings` 添加 `cachedLocation` 处理
- [ ] 添加 `declination` 范围验证 (-180 ~ 180)
- [ ] 添加经纬度范围验证 (-90~90, -180~180)
- [ ] 定义 API 响应类型

#### 任务 1.2: 错误处理增强
- [ ] `fetchDeclination` 返回 `Result<number, Error>` 类型
- [ ] 添加详细错误上下文（网络、解析、超时）
- [ ] 添加重试逻辑（3 次重试，指数退避）
- [ ] 添加降级策略（使用上次成功值）

#### 任务 1.3: 输入验证
- [ ] 验证 `lat/lon` 范围
- [ ] 验证 `heading` 范围
- [ ] 验证 `tilt` 范围
- [ ] 验证 `declination` 范围

#### 任务 1.4: 日志集成
- [ ] 集成企业级 Logger
- [ ] 记录 API 调用（成功/失败）
- [ ] 记录缓存命中/未命中
- [ ] 记录权限请求结果

### Phase 2: 测试套件扩展 (1 天)

#### 任务 2.1: 磁偏角缓存测试
- [ ] `isCachedDeclinationValid` - 时间过期场景
- [ ] `isCachedDeclinationValid` - 距离超限场景
- [ ] `isCachedDeclinationValid` - 有效缓存场景
- [ ] `fetchDeclinationWithCache` - 缓存命中
- [ ] `fetchDeclinationWithCache` - 缓存失效后重新获取
- [ ] `fetchDeclinationWithCache` - 网络错误处理

#### 任务 2.2: 边界条件测试
- [ ] 极地坐标测试（lat = ±90）
- [ ] 日期线跨越测试（lon = ±180）
- [ ] 超大距离计算测试（> 20000km）
- [ ] 零距离测试
- [ ] 负时间戳测试
- [ ] NaN/Infinity 输入测试

#### 任务 2.3: API 测试
- [ ] Mock `fetchDeclination` 成功响应
- [ ] Mock `fetchDeclination` 网络错误
- [ ] Mock `fetchDeclination` 超时
- [ ] Mock `fetchDeclination` 无效 JSON
- [ ] Mock `fetchDeclination` 缺少字段

#### 任务 2.4: 性能基准测试
- [ ] Haversine 计算性能（1000 次）
- [ ] 角度标准化性能（10000 次）
- [ ] 方向解析性能（1000 次）
- [ ] 缓存验证性能（1000 次）

#### 任务 2.5: 安全性测试
- [ ] 恶意 API 响应注入测试
- [ ] 原型链污染测试
- [ ] 超大数值输入测试
- [ ] 特殊字符输入测试

### Phase 3: 功能增强 (0.5 天)

#### 任务 3.1: 配置增强
- [ ] 缓存过期时间可配置
- [ ] 距离阈值可配置
- [ ] API 超时可配置
- [ ] 添加备用 API 列表

#### 任务 3.2: 错误恢复
- [ ] 添加本地磁偏角数据库（离线降级）
- [ ] 添加重试策略配置
- [ ] 添加降级模式开关

### Phase 4: 文档与验收 (0.5 天)

#### 任务 4.1: 文档补充
- [ ] 所有函数完整 JSDoc
- [ ] 添加使用示例
- [ ] 添加架构说明
- [ ] 添加 API 依赖说明

#### 任务 4.2: 验收测试
- [ ] 运行完整测试套件
- [ ] 验证测试覆盖率 > 95%
- [ ] 验证性能基准达标
- [ ] 代码质量检查（lint）

---

## 四、测试用例设计

### 4.1 磁偏角缓存测试

```typescript
describe("磁偏角缓存管理", () => {
  it("缓存在有效期内且距离未超限时有效", () => {
    const cached = {
      lat: 40.7128,
      lon: -74.0060,
      timestamp: Date.now() - 1000 * 60 * 60, // 1 hour ago
    };
    expect(isCachedDeclinationValid(cached, 40.72, -74.01)).toBe(true);
  });

  it("缓存超过 7 天后失效", () => {
    const cached = {
      lat: 40.7128,
      lon: -74.0060,
      timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
    };
    expect(isCachedDeclinationValid(cached, 40.7128, -74.0060)).toBe(false);
  });

  it("移动超过 50km 后缓存失效", () => {
    const cached = {
      lat: 40.7128,
      lon: -74.0060,
      timestamp: Date.now() - 1000 * 60, // 1 min ago
    };
    // Move ~100km away
    expect(isCachedDeclinationValid(cached, 41.7128, -74.0060)).toBe(false);
  });

  it("缓存未定义时返回 false", () => {
    expect(isCachedDeclinationValid(undefined, 40.7128, -74.0060)).toBe(false);
  });
});
```

### 4.2 边界条件测试

```typescript
describe("边界条件测试", () => {
  it("处理北极坐标", () => {
    const distance = calculateDistance(90, 0, 89, 0);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(200); // ~111km per degree at equator
  });

  it("处理南极坐标", () => {
    const distance = calculateDistance(-90, 0, -89, 0);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(200);
  });

  it("处理日期线跨越", () => {
    const distance = calculateDistance(0, 179, 0, -179);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(300); // ~222km for 2° at equator
  });

  it("处理零距离", () => {
    const distance = calculateDistance(40.7128, -74.0060, 40.7128, -74.0060);
    expect(distance).toBe(0);
  });

  it("处理超大距离（对跖点）", () => {
    // New York to antipode (near Perth)
    const distance = calculateDistance(40.7128, -74.0060, -40.7128, 105.9940);
    expect(distance).toBeGreaterThan(19000); // ~20000km
    expect(distance).toBeLessThan(21000);
  });

  it("拒绝无效纬度", () => {
    expect(() => normalizeCoordinate(91, "lat")).toThrow();
    expect(() => normalizeCoordinate(-91, "lat")).toThrow();
  });

  it("拒绝无效经度", () => {
    expect(() => normalizeCoordinate(181, "lon")).toThrow();
    expect(() => normalizeCoordinate(-181, "lon")).toThrow();
  });
});
```

### 4.3 性能基准测试

```typescript
describe("性能基准测试", () => {
  it("Haversine 计算性能 < 1ms/1000次", () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      calculateDistance(40.7128, -74.0060, 34.0522, -118.2437);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1);
  });

  it("角度标准化性能 < 1ms/10000次", () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      normalizeHeading(i * 37); // Various angles
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1);
  });

  it("方向解析性能 < 2ms/1000次", () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      cardinalDirection(i % 360, "en");
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2);
  });
});
```

---

## 五、验收标准

### 5.1 功能完整性
- [x] 磁北/真北支持
- [x] 磁偏角自动获取
- [x] 磁偏角缓存
- [x] 8 方位显示
- [x] 水平仪功能
- [ ] 离线降级支持
- [ ] 错误提示用户

### 5.2 代码质量
- [ ] 测试覆盖率 > 95%
- [ ] 所有函数有 JSDoc
- [ ] 通过 TypeScript strict 检查
- [ ] 通过 ESLint 检查
- [ ] 圈复杂度 < 10

### 5.3 性能指标
- [ ] Haversine 计算 < 1ms/1000次
- [ ] 角度标准化 < 1ms/10000次
- [ ] 磁偏角获取 < 5s
- [ ] 缓存命中率 > 90%

### 5.4 安全性
- [ ] 所有输入验证
- [ ] API 响应验证
- [ ] 无注入漏洞
- [ ] 无原型链污染

### 5.5 文档完整性
- [ ] 审计计划文档
- [ ] 审计报告文档
- [ ] 完成总结文档
- [ ] 代码内联文档

---

## 六、风险评估

### 6.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| NOAA API 不稳定 | 中 | 高 | 添加备用 API、离线数据库 |
| iOS 权限被拒绝 | 高 | 中 | 提供清晰说明、降级到磁北 |
| 极地/日期线边界 bug | 低 | 中 | 完整边界测试 |
| 性能不达标 | 低 | 低 | 算法优化、缓存优化 |

### 6.2 进度风险

| 里程碑 | 预估 | 缓冲 | 总计 |
|--------|------|------|------|
| Phase 1 | 1 天 | 0.2 天 | 1.2 天 |
| Phase 2 | 1 天 | 0.3 天 | 1.3 天 |
| Phase 3 | 0.5 天 | 0.1 天 | 0.6 天 |
| Phase 4 | 0.5 天 | 0.1 天 | 0.6 天 |
| **总计** | **3 天** | **0.7 天** | **3.7 天** |

---

## 七、实施计划

### 时间线

```
Day 1 (AM):   代码审计 + 类型增强 + 错误处理
Day 1 (PM):   日志集成 + 输入验证
Day 2 (AM):   测试套件扩展 - 缓存 + 边界
Day 2 (PM):   测试套件扩展 - API + 性能 + 安全
Day 3 (AM):   功能增强 + 文档补充
Day 3 (PM):   验收测试 + 报告生成
```

### 里程碑

- **M1** (Day 1 结束): 代码增强完成，错误处理健壮
- **M2** (Day 2 结束): 测试覆盖率 > 95%，所有边界测试通过
- **M3** (Day 3 结束): 功能完整，文档齐全，通过验收

---

## 八、交付物清单

### 代码交付物
- [x] `compass.ts` - 核心逻辑（已存在）
- [ ] `compass.ts` - 增强版本（错误处理、验证、日志）
- [ ] `compass.test.ts` - 扩展测试套件（50+ 测试）

### 文档交付物
- [x] `COMPASS_AUDIT_PLAN.md` - 本文档
- [ ] `COMPASS_AUDIT_REPORT.md` - 详细审计报告
- [ ] `COMPASS_COMPLETION_SUMMARY.md` - 完成总结

### 测试报告
- [ ] 单元测试报告（覆盖率 + 通过率）
- [ ] 性能基准报告
- [ ] 安全测试报告

---

## 九、参考资料

### API 文档
- NOAA World Magnetic Model: https://www.ngdc.noaa.gov/geomag/
- DeviceOrientationEvent: https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent
- Geolocation API: https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API

### 算法参考
- Haversine Formula: https://en.wikipedia.org/wiki/Haversine_formula
- Magnetic Declination: https://en.wikipedia.org/wiki/Magnetic_declination

### 标准参考
- DO-178C (航空软件标准)
- ISO 26262 (汽车安全标准)
- IEC 61508 (功能安全标准)

---

**创建日期**: 2026年9月17日  
**预计开始**: 2026年9月18日  
**预计完成**: 2026年9月21日  
**责任人**: AmOS 开发团队
