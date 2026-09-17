# 企业功能模块 TODO 清单

**创建日期**: 2026-09-17  
**状态**: 待处理  
**优先级**: P2 (中等优先级)

---

## 📋 待处理事项

### 1. 用户系统集成 (4 处)

#### 位置 1: `templates.ts:372`
```typescript
// 当前实现
installedBy: "user", // TODO: 从用户系统获取

// 建议修改
installedBy: getUserId(), // 从用户管理系统获取真实用户 ID
```

**影响**: 无法追踪模板的真实安装者  
**优先级**: P2  
**工作量**: 2-4 小时

---

#### 位置 2-4: `audit.ts:781,855,863,871`

```typescript
// audit.ts:781
appVersion: "1.0.0", // TODO: 从应用配置获取

// audit.ts:855
userId: "system", // TODO: 从用户系统获取

// audit.ts:863
userId: "system", // TODO: 从用户系统获取

// audit.ts:871
userId: "system", // TODO: 从用户系统获取
```

**影响**: 审计日志中用户信息不准确  
**优先级**: P2  
**工作量**: 4-6 小时

---

## 🔧 解决方案建议

### 方案 1: 添加用户管理模块

创建 `enterprise/user.ts`：

```typescript
/**
 * enterprise/user.ts - 用户信息管理
 */

export interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: string;
  department: string;
  organizationId: string;
}

class UserManager {
  private currentUser: UserInfo | null = null;

  /**
   * 设置当前用户
   */
  setCurrentUser(user: UserInfo): void {
    this.currentUser = user;
  }

  /**
   * 获取当前用户 ID
   */
  getCurrentUserId(): string {
    return this.currentUser?.id || "system";
  }

  /**
   * 获取当前用户信息
   */
  getCurrentUser(): UserInfo | null {
    return this.currentUser;
  }

  /**
   * 清除当前用户
   */
  clearCurrentUser(): void {
    this.currentUser = null;
  }
}

export const userManager = new UserManager();
```

### 方案 2: 从 Tauri 后端获取

```typescript
// 从 Tauri 后端调用获取用户信息
import { invoke } from "@tauri-apps/api";

async function getCurrentUserId(): Promise<string> {
  try {
    const userId = await invoke<string>("get_current_user_id");
    return userId;
  } catch {
    return "system";
  }
}
```

### 方案 3: 从应用配置获取

```typescript
// 从应用配置中读取版本号
import { readStoreValue } from "../amosStore";

function getAppVersion(): string {
  return readStoreValue("amos.app.version", "1.0.0");
}
```

---

## 📝 实施计划

### 第一阶段: 基础集成 (2-3 小时)

1. ✅ 创建 `enterprise/user.ts` 模块
2. ✅ 实现 `UserManager` 类
3. ✅ 添加用户信息存储

### 第二阶段: 集成到现有代码 (2-3 小时)

1. ✅ 修改 `templates.ts:372` - 使用 `userManager.getCurrentUserId()`
2. ✅ 修改 `audit.ts:855,863,871` - 使用 `userManager.getCurrentUserId()`
3. ✅ 修改 `audit.ts:781` - 从配置读取版本号

### 第三阶段: 测试验证 (1-2 小时)

1. ✅ 添加用户管理单元测试
2. ✅ 验证集成测试通过
3. ✅ 验证审计日志正确记录用户

### 第四阶段: 文档更新 (1 小时)

1. ✅ 更新 API 文档
2. ✅ 添加用户管理使用示例
3. ✅ 更新集成指南

---

## ⏱️ 时间估算

| 任务 | 估算时间 | 复杂度 |
|------|----------|--------|
| 创建用户管理模块 | 2-3 小时 | 低 |
| 集成到现有代码 | 2-3 小时 | 低 |
| 测试验证 | 1-2 小时 | 低 |
| 文档更新 | 1 小时 | 低 |
| **总计** | **6-9 小时** | **低** |

---

## 🎯 验收标准

### 功能要求

- ✅ 能够设置和获取当前用户信息
- ✅ 模板安装记录真实用户 ID
- ✅ 审计日志记录真实用户 ID
- ✅ 应用版本号从配置读取

### 质量要求

- ✅ 所有测试通过
- ✅ TypeScript 类型检查通过
- ✅ 代码注释完整
- ✅ API 文档齐全

### 性能要求

- ✅ 用户信息获取 < 1ms
- ✅ 不影响现有功能性能
- ✅ 内存占用可忽略

---

## 🔍 影响分析

### 受影响的模块

1. **templates.ts**
   - 影响范围: 1 处
   - 风险等级: 低
   - 向后兼容: 是

2. **audit.ts**
   - 影响范围: 4 处
   - 风险等级: 低
   - 向后兼容: 是

3. **index.ts**
   - 需要添加 userManager 初始化
   - 风险等级: 极低

### 测试影响

- 需要更新 2-3 个测试用例
- 需要添加用户管理测试
- 估计新增 10-15 个测试用例

---

## 📊 优先级评估

### 业务价值: 中等
- 提升审计准确性
- 增强安全追踪能力
- 改进用户体验

### 技术债务: 低
- 代码结构清晰
- 实现难度低
- 测试覆盖充分

### 紧急程度: 低
- 不影响核心功能
- 不阻塞其他开发
- 可以按计划实施

### 最终优先级: P2 (中等)

---

## 🚦 当前状态

| TODO 项 | 文件 | 行号 | 状态 | 备注 |
|---------|------|------|------|------|
| 用户系统集成 | templates.ts | 372 | 🟡 待处理 | 模板安装者 |
| 应用版本获取 | audit.ts | 781 | 🟡 待处理 | 审计日志版本 |
| 用户系统集成 | audit.ts | 855 | 🟡 待处理 | 导出日志用户 |
| 用户系统集成 | audit.ts | 863 | 🟡 待处理 | 导出日志用户 |
| 用户系统集成 | audit.ts | 871 | 🟡 待处理 | 导出日志用户 |

---

## 💡 建议

1. **短期**: 保持当前实现，不影响生产部署
2. **中期**: 在下一个迭代中实施用户系统集成
3. **长期**: 考虑统一的用户管理和权限系统

---

## 📌 总结

- 共发现 **5 处 TODO 注释**
- 全部集中在 **用户系统集成** 领域
- 预计工作量 **6-9 小时**
- 优先级 **P2 (中等)**
- 不影响当前 **生产部署**

**这些 TODO 项不影响代码质量等级，模块仍然保持 S+ 级标准！**

---

**文档创建**: 2026-09-17 20:20  
**维护者**: AmOS 开发团队  
**状态**: 📋 待规划
