# 企业功能 P1-P3 优化任务清单

**创建日期**: 2026-09-17  
**优先级**: P1 (高) / P2 (中) / P3 (低)  
**预计完成**: 1-3 个月

---

## 📋 总览

根据《ENTERPRISE_CODE_AUDIT_REPORT.md》，除 P0-2 (MDM 加密存储) 外，还有 **13 个优化项** 待完成。

| 优先级 | 数量 | 预计工期 |
|--------|------|----------|
| **P1** | 7 个 | 2-3 周 |
| **P2** | 4 个 | 1-2 周 |
| **P3** | 2 个 | 1 周 |
| **合计** | 13 个 | ~6 周 |

---

## 🔴 P1 高优先级 (7 个)

### P1-1: 输入验证增强 ⚠️
**文件**: `templates.ts:validateShortcutParams()`  
**问题**: `select` 类型参数未验证选项范围

**状态**: ✅ **已完成** (2026-09-17)

```typescript
// 已修复代码
if (param.type === "select" && param.options) {
  if (!param.options.includes(value)) {
    return { valid: false, error: `选项 "${value}" 不在允许范围内` };
  }
}
```

**测试**: ✅ 已验证  
**文档**: ✅ 已更新

---

### P1-2: 内存溢出保护 ⚠️
**文件**: `webhooks.ts:queueWebhook()`  
**问题**: Webhook 队列无上限，可能导致内存溢出

**状态**: ✅ **已完成** (2026-09-17)

```typescript
// 已修复代码
private queueWebhook(event: WebhookEvent): void {
  const MAX_QUEUE_SIZE = 1000;
  
  if (this.webhookQueue.length >= MAX_QUEUE_SIZE) {
    console.warn(`[Enterprise] Webhook 队列已满 (${MAX_QUEUE_SIZE})，丢弃最旧事件`);
    this.webhookQueue.shift(); // 删除最旧的
  }
  
  this.webhookQueue.push(event);
  this.scheduleWebhookFlush();
}
```

**测试**: ✅ 已验证  
**文档**: ✅ 已更新

---

### P1-3: localStorage 写入失败处理 ⚠️
**文件**: `mdm.ts`, `audit.ts`  
**问题**: 写入失败时用户无感知，数据丢失

**当前状态**: 🟡 部分完成
- ✅ `mdm.ts`: 已使用 `writeStoreValueChecked()` + 审计日志
- ⏳ `audit.ts`: 需要增强错误处理

**任务**:
```typescript
// audit.ts:exportAuditLog()
export async function exportAuditLog(): Promise<{ success: boolean; data?: string; error?: string }> {
  try {
    const logs = getAuditLog();
    const json = JSON.stringify(logs, null, 2);
    
    // 添加: 写入失败时返回错误
    const success = writeStoreValueChecked(STORE_KEYS.AUDIT_LOG, json);
    
    if (!success) {
      return { 
        success: false, 
        error: "存储空间不足或不可用" 
      };
    }
    
    return { success: true, data: json };
  } catch (err) {
    return { 
      success: false, 
      error: String(err) 
    };
  }
}
```

**预计工时**: 2-3 小时  
**优先级**: P1 (需在 MDM 加密完成后立即处理)

---

### P1-4: 错误信息国际化 🌐
**文件**: 多个文件  
**问题**: 错误消息硬编码中文，不支持多语言

**影响范围**:
- `mdm.ts`: ~15 处错误消息
- `audit.ts`: ~8 处错误消息
- `webhooks.ts`: ~10 处错误消息
- `templates.ts`: ~5 处错误消息

**任务**:
1. 在 `i18n/locales/en.ts` 和 `zh.ts` 中添加企业功能错误消息
2. 替换硬编码字符串为 `t("enterprise.error.xxx")`

**示例**:
```typescript
// 修改前
throw new Error("MDM 配置无效");

// 修改后
import { t } from "../i18n";
throw new Error(t("enterprise.mdm.error.invalidConfig"));
```

**i18n 键值设计**:
```typescript
// en.ts
enterprise: {
  mdm: {
    error: {
      invalidConfig: "Invalid MDM configuration",
      enrollFailed: "MDM enrollment failed",
      syncFailed: "Policy sync failed",
      // ... 20+ 条消息
    }
  },
  audit: {
    error: {
      exportFailed: "Audit log export failed",
      // ...
    }
  }
}
```

**预计工时**: 1 天  
**优先级**: P1 (国际化需求)

---

### P1-5: 日志敏感信息脱敏 🔒
**文件**: `webhooks.ts`, `api.ts`  
**问题**: 日志可能泄露 API 密钥

**当前状态**: 🔴 未修复

**任务**:
```typescript
// webhooks.ts
private async sendWebhook(event: WebhookEvent): Promise<boolean> {
  // 修改前
  console.log("[Webhook] 发送事件:", event);
  
  // 修改后
  console.log("[Webhook] 发送事件:", {
    ...event,
    headers: Object.keys(event.headers || {}).length + " headers" // 不记录实际值
  });
  
  // 签名计算失败时
  console.error("[Webhook] 签名生成失败:", 
    err instanceof Error ? err.message : "Unknown error" // 不记录密钥
  );
}
```

**检查清单**:
- [ ] `webhooks.ts`: 移除 `apiKey` 日志
- [ ] `api.ts`: 移除 `organizationId` 明文日志
- [ ] `mdm.ts`: 确保配置对象不被直接 `console.log`

**预计工时**: 2-3 小时  
**优先级**: P1 (安全性)

---

### P1-6: 事务一致性 💾
**文件**: `mdm.ts:unenroll()`  
**问题**: 取消注册时部分数据可能未清理

**当前状态**: 🟡 部分完成

**任务**:
```typescript
async unenroll(): Promise<void> {
  try {
    // 清理所有相关数据
    this.config = null;
    this.executionCounts.clear();
    this.auditLog = [];
    
    // 原子性操作：全部成功或全部回滚
    const results = await Promise.allSettled([
      this.deleteStoreKey(STORE_KEYS.MDM_CONFIG),
      this.deleteStoreKey(STORE_KEYS.MDM_EXECUTION_COUNT),
      this.deleteStoreKey(STORE_KEYS.MDM_AUDIT_LOG)
    ]);
    
    // 检查失败项
    const failed = results.filter(r => r.status === "rejected");
    if (failed.length > 0) {
      console.error("[MDM] 部分数据清理失败:", failed);
      // 记录到审计日志（如果可用）
      this.auditLog.push({
        action: "unenroll_partial_failure",
        timestamp: Date.now(),
        failedCount: failed.length
      });
    }
    
  } catch (err) {
    console.error("[MDM] 取消注册失败:", err);
    throw err;
  }
}

private async deleteStoreKey(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      localStorage.removeItem(key);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}
```

**预计工时**: 3-4 小时  
**优先级**: P1 (数据一致性)

---

### P1-7: 并发控制 🔄
**文件**: `webhooks.ts:flushWebhooks()`  
**问题**: 并发调用可能导致重复发送

**当前状态**: 🔴 未修复

**任务**:
```typescript
export class EnterpriseManager {
  private isFlushingWebhooks = false; // 添加锁标志
  
  private async flushWebhooks(): Promise<void> {
    // 防止并发调用
    if (this.isFlushingWebhooks) {
      console.debug("[Enterprise] Webhook 正在发送中，跳过");
      return;
    }
    
    this.isFlushingWebhooks = true;
    
    try {
      const queue = [...this.webhookQueue];
      this.webhookQueue = [];
      
      for (const event of queue) {
        await this.sendWebhook(event);
      }
    } finally {
      this.isFlushingWebhooks = false; // 确保锁释放
    }
  }
}
```

**预计工时**: 2 小时  
**优先级**: P1 (防止重复发送)

---

## 🟡 P2 中优先级 (4 个)

### P2-1: TypeScript 严格模式 📘
**文件**: 所有企业功能文件  
**问题**: 部分类型标注不够严格

**任务**:
- [ ] 移除 `any` 类型（~10 处）
- [ ] 添加明确的返回类型
- [ ] 使用 `unknown` 替代 `any`（catch 块）

**示例**:
```typescript
// 修改前
catch (err: any) {
  console.error("Error:", err);
}

// 修改后
catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Error:", message);
}
```

**预计工时**: 1 天  
**优先级**: P2 (代码质量)

---

### P2-2: 性能优化 ⚡
**文件**: `audit.ts`, `mdm.ts`  
**问题**: 大数组操作未优化

**任务**:

#### 2.1 审计日志分页
```typescript
// audit.ts
export function getAuditLog(options?: {
  limit?: number;
  offset?: number;
  filter?: (log: AuditEntry) => boolean;
}): AuditEntry[] {
  const { limit = 100, offset = 0, filter } = options || {};
  
  let logs = [...auditLog];
  
  if (filter) {
    logs = logs.filter(filter);
  }
  
  return logs.slice(offset, offset + limit);
}
```

#### 2.2 MDM 策略缓存
```typescript
// mdm.ts
private policyCache = new Map<string, MDMPolicy>();

getPolicy(policyId: string): MDMPolicy | undefined {
  // 使用缓存
  if (this.policyCache.has(policyId)) {
    return this.policyCache.get(policyId);
  }
  
  const policy = this.config?.policies.find(p => p.id === policyId);
  if (policy) {
    this.policyCache.set(policyId, policy);
  }
  
  return policy;
}
```

**预计工时**: 1 天  
**优先级**: P2 (性能)

---

### P2-3: 单元测试覆盖 🧪
**文件**: 新增测试文件  
**问题**: 边界条件测试不足

**当前覆盖率**: ~75%  
**目标覆盖率**: 90%+

**缺失测试**:
- [ ] Webhook 重试机制
- [ ] MDM 策略冲突处理
- [ ] 审计日志轮转
- [ ] 大数据量压力测试（1000+ 策略）

**预计工时**: 2 天  
**优先级**: P2 (质量保证)

---

### P2-4: 文档完善 📚
**文件**: 新增文档  
**问题**: 缺少开发者指南

**任务**:
- [ ] `docs/ENTERPRISE_DEVELOPER_GUIDE.md` - 开发者接入指南
- [ ] `docs/ENTERPRISE_API_REFERENCE.md` - API 完整文档
- [ ] `docs/ENTERPRISE_SECURITY_GUIDE.md` - 安全最佳实践
- [ ] `docs/ENTERPRISE_TROUBLESHOOTING.md` - 故障排查手册

**预计工时**: 2 天  
**优先级**: P2 (可维护性)

---

## 🟢 P3 低优先级 (2 个)

### P3-1: Webhook 重试策略优化 🔄
**文件**: `webhooks.ts`  
**问题**: 固定延迟，未考虑服务器负载

**当前**: 固定 1s 延迟  
**优化**: 指数退避 (1s → 2s → 4s → 8s)

**任务**:
```typescript
private async sendWebhookWithRetry(event: WebhookEvent, maxRetries = 3): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const success = await this.sendWebhook(event);
    
    if (success) return true;
    
    // 指数退避
    const delay = Math.pow(2, attempt) * 1000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  return false;
}
```

**预计工时**: 3-4 小时  
**优先级**: P3 (优化)

---

### P3-2: 审计日志导出格式 📊
**文件**: `audit.ts`  
**问题**: 仅支持 JSON，企业可能需要 CSV

**任务**:
```typescript
export function exportAuditLogCSV(): string {
  const logs = getAuditLog();
  const headers = ["Timestamp", "Action", "User", "IP", "Details"];
  
  const rows = logs.map(log => [
    new Date(log.timestamp).toISOString(),
    log.action,
    log.userId || "",
    log.ip || "",
    JSON.stringify(log.metadata || {})
  ]);
  
  return [headers, ...rows]
    .map(row => row.map(cell => `"${cell}"`).join(","))
    .join("\n");
}
```

**预计工时**: 2-3 小时  
**优先级**: P3 (功能增强)

---

## 📅 实施计划

### Month 1: P1 高优先级 (2-3 周)

| 周 | 任务 | 工时 |
|----|------|------|
| **Week 1** | P0-2 (MDM 加密存储) | 40h |
| **Week 2** | P1-3, P1-4, P1-5 | 24h |
| **Week 3** | P1-6, P1-7 | 16h |

### Month 2: P2 中优先级 (2 周)

| 周 | 任务 | 工时 |
|----|------|------|
| **Week 4** | P2-1, P2-2 | 16h |
| **Week 5** | P2-3, P2-4 | 32h |

### Month 3: P3 低优先级 (1 周)

| 周 | 任务 | 工时 |
|----|------|------|
| **Week 6** | P3-1, P3-2 | 8h |

**总工时**: ~136 小时 (~3.5 周人力)

---

## 📊 进度跟踪

| 优先级 | 总数 | 已完成 | 进行中 | 未开始 | 完成率 |
|--------|------|--------|--------|--------|--------|
| **P0** | 1 | 0 | 1 | 0 | 0% |
| **P1** | 7 | 2 | 0 | 5 | 29% |
| **P2** | 4 | 0 | 0 | 4 | 0% |
| **P3** | 2 | 0 | 0 | 2 | 0% |
| **合计** | 14 | 2 | 1 | 11 | **21%** |

---

## 🎯 里程碑

| 里程碑 | 预计日期 | 状态 |
|--------|----------|------|
| P0-2 完成（MDM 加密） | 2026-09-28 | ⏳ |
| P1 全部完成 | 2026-10-12 | ⬜ |
| P2 全部完成 | 2026-10-26 | ⬜ |
| P3 全部完成 | 2026-11-02 | ⬜ |
| **生产就绪** | **2026-11-02** | ⬜ |

---

## ✅ 验收标准

### 功能完整性
- [ ] 所有 P0/P1 问题已修复
- [ ] 所有 P2/P3 问题已修复或有合理延期理由
- [ ] 新增功能通过验收测试

### 质量标准
- [ ] 代码覆盖率 >= 90%
- [ ] 所有 Lint/TypeScript 错误已修复
- [ ] Code Review 通过

### 文档标准
- [ ] 开发者文档完整
- [ ] API 文档更新
- [ ] 故障排查手册可用

### 部署标准
- [ ] Beta 测试 2 周无 P0/P1 bug
- [ ] 性能指标达标
- [ ] 安全审查通过

---

## 📞 责任人

| 任务类型 | 负责人 | 备注 |
|---------|--------|------|
| P0-2 MDM 加密 | [待分配] | 本周完成 |
| P1 高优先级 | [待分配] | 1 个月内 |
| P2 中优先级 | [待分配] | 2 个月内 |
| P3 低优先级 | [待分配] | 3 个月内 |

---

**文档状态**: ✅ 已完成  
**最后更新**: 2026-09-17  
**下次更新**: 每周五更新进度
