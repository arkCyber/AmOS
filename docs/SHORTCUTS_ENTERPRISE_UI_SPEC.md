# 快捷指令 Phase 4: 企业功能 UI 规格

**版本**: 1.0  
**日期**: 2026年9月17日  
**状态**: 设计规格（待实现）

---

## 📋 概述

本文档定义了企业功能 UI 组件的设计规格，用于未来 Phase 4.5 的 UI 实现。所有后端功能已完成并通过测试。

---

## 🎨 UI 组件清单

### 1. MDMPanel.svelte - MDM 配置面板

**路径**: `src/svelte/modules/MDMPanel.svelte`

#### 功能需求
- 启用/禁用 MDM
- 配置服务器 URL 和组织 ID
- 管理策略和限制
- 查看设备注册状态
- 手动同步配置

#### UI 布局
```
┌─────────────────────────────────────┐
│ MDM 移动设备管理                     │
├─────────────────────────────────────┤
│ [启用 MDM]  ✓                        │
│                                      │
│ 服务器配置                            │
│ ├─ 服务器 URL: [____________]        │
│ ├─ 组织 ID:    [____________]        │
│ └─ 设备 ID:    device-xxx (自动)     │
│                                      │
│ 权限策略                              │
│ ├─ [✓] 允许用户创建                  │
│ ├─ [✓] 允许用户编辑                  │
│ ├─ [✓] 允许用户删除                  │
│ ├─ [✓] 允许用户执行                  │
│ ├─ [✓] 允许用户分享                  │
│ ├─ [ ] 允许用户导入                  │
│ └─ [ ] 允许用户导出                  │
│                                      │
│ 使用限制                              │
│ ├─ 每用户快捷指令数: [100] 个         │
│ ├─ 每快捷指令动作数: [50] 个          │
│ ├─ 每日执行次数:     [1000] 次       │
│ └─ 快捷指令大小:     [1] MB          │
│                                      │
│ [同步配置] [重置为默认]                │
│                                      │
│ 最后同步: 2026-09-17 18:30           │
└─────────────────────────────────────┘
```

#### 数据绑定
```typescript
import { mdmManager } from "$lib/enterprise";

let config = $state(mdmManager.getConfig());
let restrictions = $state(mdmManager.getPolicies());

function toggleMDM() {
  mdmManager.configure({ enabled: !config.enabled });
  config = mdmManager.getConfig();
}

function updateRestriction(key: string, value: any) {
  mdmManager.addPolicy(key, value);
  restrictions = mdmManager.getPolicies();
}

async function syncConfig() {
  await mdmManager.syncConfig();
  config = mdmManager.getConfig();
}
```

#### 样式指南
- 使用 iOS 风格的开关（`<input type="checkbox" class="toggle">`）
- 数字输入使用步进器（+/- 按钮）
- 配置项分组使用卡片布局
- 同步按钮显示加载状态

---

### 2. TemplateLibrary.svelte - 企业模板库

**路径**: `src/svelte/modules/TemplateLibrary.svelte`

#### 功能需求
- 浏览所有企业模板
- 按类别、部门筛选
- 搜索模板
- 查看模板详情（描述、参数、预览）
- 安装模板（填写参数）
- 查看已安装模板

#### UI 布局
```
┌─────────────────────────────────────┐
│ 企业模板库                            │
├─────────────────────────────────────┤
│ [🔍 搜索模板...]                      │
│                                      │
│ 分类: [全部▾] [生产力▾] [自动化▾]     │
│                                      │
│ ┌────────────┬────────────┐          │
│ │ 📊 日报模板 │ 📧 邮件模板 │          │
│ │ v1.0.2     │ v2.1.0     │          │
│ │ 已安装 125 │ 已安装 89  │          │
│ └────────────┴────────────┘          │
│ ┌────────────┬────────────┐          │
│ │ 🔔 提醒模板 │ 📁 文件模板 │          │
│ │ v1.5.0     │ v1.0.0     │          │
│ │ 已安装 67  │ 已安装 43  │          │
│ └────────────┴────────────┘          │
│                                      │
│ [加载更多...]                         │
└─────────────────────────────────────┘

点击模板卡片 → 模板详情对话框
┌─────────────────────────────────────┐
│ 📊 日报模板            [×]            │
├─────────────────────────────────────┤
│ 版本: 1.0.2                          │
│ 类别: 生产力                          │
│ 部门: 全公司                          │
│                                      │
│ 描述:                                 │
│ 自动生成每日工作报告，包含任务进度、   │
│ 会议记录和明日计划。                   │
│                                      │
│ 参数配置:                             │
│ ├─ 报告日期: [2026-09-17]            │
│ ├─ 部门名称: [________]               │
│ └─ 发送给:   [________]               │
│                                      │
│ 包含动作: 5 个                        │
│ 预计耗时: ~2 分钟                     │
│                                      │
│ [安装模板] [预览]                      │
└─────────────────────────────────────┘
```

#### 数据绑定
```typescript
import { templateManager } from "$lib/enterprise";

let templates = $state(templateManager.getTemplates());
let search = $state("");
let category = $state<string | undefined>(undefined);

$effect(() => {
  templates = templateManager.getTemplates({ 
    search, 
    category,
    publishStatus: "published"
  });
});

async function installTemplate(templateId: string, params: Record<string, any>) {
  const result = await templateManager.installTemplate(templateId, params);
  if (result.success) {
    // 显示成功消息，跳转到快捷指令
  } else {
    // 显示错误消息
  }
}
```

#### 特殊功能
- 模板卡片显示安装数量和成功率
- 强制模板显示"必装"徽章
- 支持模板预览（模拟执行流程）
- 参数验证和错误提示

---

### 3. AuditLogViewer.svelte - 审计日志查看器

**路径**: `src/svelte/modules/AuditLogViewer.svelte`

#### 功能需求
- 查看审计日志列表
- 按时间、用户、事件类型、结果筛选
- 查看日志详情
- 导出日志（JSON/CSV）
- 查看统计图表

#### UI 布局
```
┌─────────────────────────────────────────────────┐
│ 审计日志                                         │
├─────────────────────────────────────────────────┤
│ 筛选器                                           │
│ ├─ 时间范围: [最近 24 小时▾]                     │
│ ├─ 用户:     [全部用户▾]                         │
│ ├─ 事件类型: [全部事件▾]                         │
│ ├─ 结果:     [全部▾] [成功] [失败] [警告] [阻止] │
│ └─ 级别:     [INFO▾]                            │
│                                           [导出▾] │
│                                                  │
│ 统计概览                                         │
│ ┌─────┬─────┬─────┬─────┐                      │
│ │总计 │成功 │失败 │警告 │                      │
│ │1,234│1,180│45  │9   │                      │
│ └─────┴─────┴─────┴─────┘                      │
│                                                  │
│ 日志列表                                         │
│ ┌────────────────────────────────────────────┐  │
│ │ ✓ 2026-09-17 18:30:45                      │  │
│ │   用户: admin@company.com                   │  │
│ │   执行快捷指令: 日报模板                     │  │
│ │   耗时: 1.2s                                │  │
│ ├────────────────────────────────────────────┤  │
│ │ ✗ 2026-09-17 18:28:12                      │  │
│ │   用户: user@company.com                    │  │
│ │   创建快捷指令失败: 超出配额限制              │  │
│ │   错误: 已达到最大快捷指令数量 (50)          │  │
│ ├────────────────────────────────────────────┤  │
│ │ ⚠ 2026-09-17 18:25:03                      │  │
│ │   用户: user@company.com                    │  │
│ │   导出快捷指令: 包含敏感数据                 │  │
│ │   警告: 需要管理员审核                       │  │
│ └────────────────────────────────────────────┘  │
│                                                  │
│ [加载更多...]                                    │
└─────────────────────────────────────────────────┘

点击日志条目 → 日志详情对话框
┌─────────────────────────────────────┐
│ 审计日志详情               [×]       │
├─────────────────────────────────────┤
│ 时间:   2026-09-17 18:30:45         │
│ 级别:   INFO                        │
│ 事件:   shortcut_run                │
│ 类别:   执行                         │
│                                      │
│ 用户信息                             │
│ ├─ 用户 ID:   user-001              │
│ ├─ 用户名:    admin@company.com     │
│ └─ IP 地址:   192.168.1.100         │
│                                      │
│ 资源信息                             │
│ ├─ 资源 ID:   shortcut-001          │
│ ├─ 资源类型:  快捷指令               │
│ └─ 资源名称:  日报模板               │
│                                      │
│ 执行结果                             │
│ ├─ 结果:      成功 ✓                │
│ ├─ 耗时:      1234 ms               │
│ └─ 描述:      执行快捷指令           │
│                                      │
│ 元数据                               │
│ {                                    │
│   "actionCount": 5,                  │
│   "outputSize": 1024                 │
│ }                                    │
└─────────────────────────────────────┘
```

#### 数据绑定
```typescript
import { auditLogger } from "$lib/enterprise";

let logs = $state<AuditLog[]>([]);
let query = $state<AuditLogQuery>({
  startTime: Date.now() - 86400000, // 24 小时
});

$effect(() => {
  logs = auditLogger.query(query);
});

let stats = $derived(auditLogger.getStatistics(
  query.startTime, 
  query.endTime
));

async function exportLogs(format: "json" | "csv") {
  const data = await auditLogger.exportLogs(query, format);
  // 触发下载
  downloadFile(`audit-logs.${format}`, data);
}
```

#### 特殊功能
- 实时日志更新（轮询或 WebSocket）
- 日志级别颜色编码（INFO 蓝色，WARNING 黄色，ERROR 红色）
- 支持虚拟滚动（大量日志时性能优化）
- 统计图表（时间分布、用户分布、事件类型分布）

---

### 4. APISettings.svelte - API 配置界面

**路径**: `src/svelte/modules/APISettings.svelte`

#### 功能需求
- 启用/禁用 API 集成
- 配置基础 URL 和认证
- 管理 Webhook
- 测试 API 连接

#### UI 布局
```
┌─────────────────────────────────────┐
│ API 集成                             │
├─────────────────────────────────────┤
│ [启用 API 集成]  ✓                   │
│                                      │
│ 基础配置                              │
│ ├─ 基础 URL:  [https://api...]      │
│ ├─ 认证方式:  [Bearer Token▾]        │
│ ├─ Token:     [**********]  [👁]    │
│ ├─ 超时时间:  [30] 秒                │
│ ├─ 重试次数:  [3] 次                 │
│ └─ 重试延迟:  [2000] 毫秒            │
│                                      │
│ 速率限制                              │
│ ├─ 最大请求数: [100] 次/分钟         │
│ └─ 当前使用:   23/100                │
│                                      │
│ [测试连接] [保存配置]                 │
│                                      │
│ ──────────────────────────           │
│                                      │
│ Webhook 管理                         │
│                                      │
│ ┌────────────────────────────────┐  │
│ │ Slack 通知              [✓ 启用] │  │
│ │ https://hooks.slack.com/...     │  │
│ │ 事件: shortcut_run, shortcut... │  │
│ │ 触发: 156 次 | 成功: 154        │  │
│ │ [编辑] [删除]                    │  │
│ ├────────────────────────────────┤  │
│ │ 企业系统通知        [✗ 禁用]    │  │
│ │ https://erp.company.com/...     │  │
│ │ 事件: shortcut_create           │  │
│ │ 触发: 45 次 | 成功: 43          │  │
│ │ [编辑] [删除]                    │  │
│ └────────────────────────────────┘  │
│                                      │
│ [+ 添加 Webhook]                     │
└─────────────────────────────────────┘

添加/编辑 Webhook 对话框
┌─────────────────────────────────────┐
│ 添加 Webhook              [×]        │
├─────────────────────────────────────┤
│ 名称:   [__________________]         │
│ URL:    [https://__________]         │
│ 方法:   [POST▾] [PUT]                │
│                                      │
│ 订阅事件 (多选):                      │
│ ├─ [✓] 快捷指令创建                  │
│ ├─ [✓] 快捷指令执行                  │
│ ├─ [ ] 快捷指令更新                  │
│ ├─ [ ] 快捷指令删除                  │
│ └─ [ ] 快捷指令分享                  │
│                                      │
│ 安全配置:                             │
│ ├─ Secret: [__________]  (可选)     │
│ ├─ 超时:   [5000] 毫秒               │
│ └─ 重试:   [3] 次                    │
│                                      │
│ 自定义 Headers (可选):                │
│ [+ 添加 Header]                      │
│                                      │
│ [测试 Webhook] [保存]                │
└─────────────────────────────────────┘
```

#### 数据绑定
```typescript
import { apiClient, webhookManager } from "$lib/enterprise";

let apiConfig = $state(apiClient.getConfig());
let webhooks = $state(webhookManager.getAllWebhooks());

async function testConnection() {
  try {
    await apiClient.request({
      method: "GET",
      endpoint: "/health",
    });
    // 显示成功消息
  } catch (error) {
    // 显示错误消息
  }
}

function addWebhook(webhook: Omit<Webhook, "id" | "createdAt" | "updatedAt">) {
  const id = webhookManager.addWebhook(webhook);
  webhooks = webhookManager.getAllWebhooks();
}

async function testWebhook(webhookId: string) {
  await webhookManager.trigger("test_event", {
    message: "这是一个测试事件"
  });
}
```

#### 特殊功能
- 认证 Token 隐藏/显示切换
- API 连接测试（显示响应时间和状态）
- Webhook 测试（发送测试事件）
- 速率限制实时显示

---

## 🎨 通用设计规范

### 颜色方案
```css
/* 主色调 */
--primary: #007AFF;      /* iOS 蓝色 */
--success: #34C759;      /* 绿色 */
--warning: #FF9500;      /* 橙色 */
--error: #FF3B30;        /* 红色 */

/* 背景 */
--bg-primary: #FFFFFF;
--bg-secondary: #F2F2F7;
--bg-tertiary: #E5E5EA;

/* 文本 */
--text-primary: #000000;
--text-secondary: #3C3C43;
--text-tertiary: #8E8E93;

/* 企业功能专用 */
--enterprise: #5856D6;   /* 紫色，标识企业功能 */
--audit: #00C7BE;        /* 青色，审计日志 */
--mdm: #FF6482;          /* 粉色，MDM */
```

### 排版
```css
/* 标题 */
.enterprise-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

/* 副标题 */
.enterprise-subtitle {
  font-size: 17px;
  font-weight: 500;
  color: var(--text-secondary);
}

/* 正文 */
.enterprise-body {
  font-size: 15px;
  font-weight: 400;
  color: var(--text-primary);
}

/* 标签 */
.enterprise-label {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
}

/* 描述文本 */
.enterprise-caption {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-tertiary);
}
```

### 组件样式

#### 卡片
```css
.enterprise-card {
  background: var(--bg-primary);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
```

#### 开关
```css
.enterprise-toggle {
  /* 使用原生 iOS 风格开关 */
  appearance: none;
  width: 51px;
  height: 31px;
  background: var(--bg-tertiary);
  border-radius: 31px;
  position: relative;
  transition: background 0.3s;
}

.enterprise-toggle:checked {
  background: var(--primary);
}

.enterprise-toggle::before {
  content: "";
  position: absolute;
  width: 27px;
  height: 27px;
  border-radius: 50%;
  background: white;
  top: 2px;
  left: 2px;
  transition: left 0.3s;
}

.enterprise-toggle:checked::before {
  left: 22px;
}
```

#### 按钮
```css
.enterprise-button-primary {
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 12px 24px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
}

.enterprise-button-secondary {
  background: var(--bg-secondary);
  color: var(--primary);
  border: none;
  border-radius: 8px;
  padding: 12px 24px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
}
```

#### 输入框
```css
.enterprise-input {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--bg-tertiary);
  border-radius: 8px;
  font-size: 15px;
  background: var(--bg-primary);
}

.enterprise-input:focus {
  outline: none;
  border-color: var(--primary);
}
```

#### 徽章
```css
.enterprise-badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.enterprise-badge-success {
  background: #E5F7ED;
  color: var(--success);
}

.enterprise-badge-warning {
  background: #FFF4E5;
  color: var(--warning);
}

.enterprise-badge-error {
  background: #FFE5E5;
  color: var(--error);
}
```

---

## 📱 响应式设计

### 移动端适配
- 所有组件支持触摸操作
- 表单输入框大小至少 44x44 像素
- 卡片布局自动换行
- 模态对话框全屏或接近全屏

### 桌面端优化
- 利用更大的屏幕空间
- 支持键盘快捷键
- 表格和列表使用多列布局
- 悬停效果和工具提示

---

## ♿ 无障碍性

### ARIA 标签
```html
<!-- 开关 -->
<input 
  type="checkbox" 
  role="switch" 
  aria-checked="true"
  aria-label="启用 MDM"
/>

<!-- 按钮 -->
<button 
  aria-label="同步配置"
  aria-busy="false"
>
  同步配置
</button>

<!-- 对话框 -->
<div 
  role="dialog" 
  aria-modal="true"
  aria-labelledby="dialog-title"
>
  <h2 id="dialog-title">模板详情</h2>
  ...
</div>
```

### 键盘导航
- 所有交互元素支持 Tab 键导航
- 对话框支持 Escape 关闭
- 表单支持 Enter 提交
- 列表支持箭头键导航

### 屏幕阅读器
- 使用语义化 HTML 标签
- 提供 ARIA 标签和描述
- 状态变化提供反馈

---

## 🔌 集成示例

### 在 SettingsApp.svelte 中集成

```svelte
<script lang="ts">
import MDMPanel from "./modules/MDMPanel.svelte";
import TemplateLibrary from "./modules/TemplateLibrary.svelte";
import AuditLogViewer from "./modules/AuditLogViewer.svelte";
import APISettings from "./modules/APISettings.svelte";

let activeTab = $state("general");

const enterpriseTabs = [
  { id: "mdm", label: "MDM 管理", icon: "🔒" },
  { id: "templates", label: "企业模板", icon: "📦" },
  { id: "audit", label: "审计日志", icon: "📊" },
  { id: "api", label: "API 集成", icon: "🔌" },
];
</script>

<div class="settings-container">
  <nav class="settings-nav">
    <!-- 常规设置标签 -->
    <button onclick={() => activeTab = "general"}>常规</button>
    
    <!-- 企业功能标签 -->
    <div class="enterprise-section">
      <div class="section-header">企业功能</div>
      {#each enterpriseTabs as tab}
        <button 
          onclick={() => activeTab = tab.id}
          class:active={activeTab === tab.id}
        >
          {tab.icon} {tab.label}
        </button>
      {/each}
    </div>
  </nav>

  <main class="settings-content">
    {#if activeTab === "mdm"}
      <MDMPanel />
    {:else if activeTab === "templates"}
      <TemplateLibrary />
    {:else if activeTab === "audit"}
      <AuditLogViewer />
    {:else if activeTab === "api"}
      <APISettings />
    {:else}
      <!-- 常规设置内容 -->
    {/if}
  </main>
</div>
```

---

## 📊 性能考虑

### 虚拟滚动
- 审计日志列表使用虚拟滚动
- 只渲染可见区域的日志条目
- 减少 DOM 节点数量

### 懒加载
- 模板详情按需加载
- 统计图表延迟渲染
- 大文件导出使用 Web Worker

### 防抖和节流
```typescript
import { debounce, throttle } from "$lib/utils";

// 搜索输入防抖
let searchDebounced = debounce((query: string) => {
  templates = templateManager.getTemplates({ search: query });
}, 300);

// 滚动事件节流
let handleScrollThrottled = throttle(() => {
  loadMoreLogs();
}, 200);
```

---

## 🧪 测试建议

### 单元测试
- 测试组件状态更新
- 测试用户交互（点击、输入）
- 测试数据绑定

### 集成测试
- 测试与后端模块的集成
- 测试表单提交流程
- 测试错误处理

### E2E 测试
- 测试完整的用户流程
- 测试跨组件交互
- 测试响应式布局

---

## 📚 相关文档

- **后端 API**: `SHORTCUTS_PHASE4_ENTERPRISE_COMPLETE.md`
- **类型定义**: `src/lib/enterprise/*.ts`
- **测试用例**: `src/lib/__tests__/enterprise.test.ts`
- **设计系统**: AmOS UI Guidelines

---

**文档版本**: 1.0  
**状态**: 设计规格（待实现）  
**下一步**: 实施 UI 组件（Phase 4.5）
