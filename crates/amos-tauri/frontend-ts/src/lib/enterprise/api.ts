/**
 * enterprise/api.ts — API 集成和 Webhook 支持
 * 
 * 功能:
 * - RESTful API 客户端
 * - Webhook 管理
 * - 认证和授权
 * - 速率限制
 * 
 * 安全特性:
 * - API Key 管理
 * - 请求签名
 * - 速率限制
 * - IP 白名单
 */

import { readStoreValue, writeStoreValueChecked } from "../amosStore";
// import { logger } from "./logger";
// import { mdmManager } from "./mdm";
import type { AuditEventType } from "./audit";
import { auditLogger } from "./audit";

// ============================================================================
// 类型定义
// ============================================================================

/** API 认证类型 */
export type APIAuthType = "api_key" | "bearer_token" | "oauth2" | "basic";

/** HTTP 方法 */
export type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** API 配置 */
export interface APIConfig {
  enabled: boolean;
  baseUrl: string;
  authType: APIAuthType;
  apiKey?: string;
  bearerToken?: string;
  username?: string;
  password?: string;
  
  // 超时和重试
  timeout: number;              // 毫秒
  retryCount: number;
  retryDelay: number;           // 毫秒
  
  // 速率限制
  rateLimits: RateLimitConfig;
  
  // 请求头
  defaultHeaders: Record<string, string>;
  
  // 代理
  proxyUrl?: string;
  
  // 调试
  debug: boolean;
}

/** 速率限制配置 */
export interface RateLimitConfig {
  enabled: boolean;
  requestsPerMinute: number;
  requestsPerHour: number;
  requestsPerDay: number;
}

/** Webhook 配置 */
export interface WebhookConfig {
  id: string;
  name: string;
  description: string;
  url: string;
  
  // 触发事件
  events: AuditEventType[];
  
  // 认证
  secret: string;               // 用于签名验证
  headers: Record<string, string>;
  
  // 配置
  enabled: boolean;
  method: HTTPMethod;
  timeout: number;
  retryCount: number;
  
  // 过滤器
  filters?: {
    userIds?: string[];
    organizationIds?: string[];
    resourceTypes?: string[];
  };
  
  // 统计
  successCount: number;
  failureCount: number;
  lastTriggeredAt?: number;
  lastStatus?: "success" | "failure";
  lastError?: string;
  
  // 元数据
  createdAt: number;
  updatedAt: number;
}

/** API 请求选项 */
export interface APIRequestOptions {
  method: HTTPMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  skipRateLimit?: boolean;
}

/** API 响应 */
export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode: number;
  headers: Record<string, string>;
}

/** Webhook 事件 */
export interface WebhookEvent {
  id: string;
  webhookId: string;
  eventType: AuditEventType;
  payload: Record<string, unknown>;
  timestamp: number;
  signature: string;
}

// ============================================================================
// 常量
// ============================================================================

const STORE_KEYS = {
  API_CONFIG: "amos.shortcuts.api.config",
  WEBHOOKS: "amos.shortcuts.api.webhooks",
  RATE_LIMITS: "amos.shortcuts.api.rate_limits",
};

const DEFAULT_API_CONFIG: APIConfig = {
  enabled: false,
  baseUrl: "",
  authType: "api_key",
  timeout: 30000,
  retryCount: 3,
  retryDelay: 1000,
  rateLimits: {
    enabled: true,
    requestsPerMinute: 60,
    requestsPerHour: 1000,
    requestsPerDay: 10000,
  },
  defaultHeaders: {
    "Content-Type": "application/json",
    "User-Agent": "AmOS-Shortcuts/1.0",
  },
  debug: false,
};

// ============================================================================
// API 客户端
// ============================================================================

export class APIClient {
  private config: APIConfig = DEFAULT_API_CONFIG;
  private requestCounts: Map<string, number[]> = new Map();

  /**
   * 初始化 API 客户端
   */
  async initialize(): Promise<void> {
    this.loadConfig();
    this.loadRateLimits();
  }

  /**
   * 发送 API 请求
   */
  async request<T = unknown>(options: APIRequestOptions): Promise<APIResponse<T>> {
    if (!this.config.enabled) {
      return {
        success: false,
        error: "API 未启用",
        statusCode: 0,
        headers: {},
      };
    }

    // 速率限制检查
    if (!options.skipRateLimit && this.config.rateLimits.enabled) {
      const rateLimitCheck = this.checkRateLimit();
      if (!rateLimitCheck.allowed) {
        await auditLogger.log({
          eventType: "error_occurred",
          eventCategory: "system",
          eventDescription: "API 请求被速率限制阻止",
          level: "warning",
          result: "blocked",
        });

        return {
          success: false,
          error: rateLimitCheck.message,
          statusCode: 429,
          headers: {},
        };
      }
    }

    // 构建完整 URL
    const url = this.buildUrl(options.path, options.queryParams);

    // 构建请求头
    const headers = this.buildHeaders(options.headers);

    // 构建请求体
    const body = options.body ? JSON.stringify(options.body) : undefined;

    let lastError: Error | null = null;
    let attempt = 0;

    // 重试逻辑
    while (attempt <= this.config.retryCount) {
      try {
        const startTime = Date.now();

        const response = await fetch(url, {
          method: options.method,
          headers,
          body,
          signal: AbortSignal.timeout(this.config.timeout),
        });

        const duration = Date.now() - startTime;
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        let data: T | undefined;
        const contentType = response.headers.get("content-type");
        if (contentType?.includes("application/json")) {
          data = await response.json();
        }

        // 记录请求
        this.recordRequest();

        // 审计日志
        await auditLogger.log({
          eventType: "system_start",
          eventCategory: "system",
          eventDescription: `API 请求: ${options.method} ${options.path}`,
          result: response.ok ? "success" : "failure",
          duration,
          actionDetails: {
            method: options.method,
            path: options.path,
            statusCode: response.status,
          },
        });

        if (response.ok) {
          return {
            success: true,
            data,
            statusCode: response.status,
            headers: responseHeaders,
          };
        } else {
          return {
            success: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
            statusCode: response.status,
            headers: responseHeaders,
          };
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        
        if (this.config.debug) {
          console.error(`[API] 请求失败 (尝试 ${attempt + 1}/${this.config.retryCount + 1}):`, err);
        }

        // 如果不是最后一次尝试，等待后重试
        if (attempt < this.config.retryCount) {
          await this.sleep(this.config.retryDelay * Math.pow(2, attempt)); // 指数退避
        }
      }

      attempt++;
    }

    // 所有重试都失败
    return {
      success: false,
      error: lastError?.message || "请求失败",
      statusCode: 0,
      headers: {},
    };
  }

  /**
   * 快捷方法: GET
   */
  async get<T = unknown>(path: string, queryParams?: Record<string, string>): Promise<APIResponse<T>> {
    return this.request<T>({ method: "GET", path, queryParams });
  }

  /**
   * 快捷方法: POST
   */
  async post<T = unknown>(path: string, body?: unknown): Promise<APIResponse<T>> {
    return this.request<T>({ method: "POST", path, body });
  }

  /**
   * 快捷方法: PUT
   */
  async put<T = unknown>(path: string, body?: unknown): Promise<APIResponse<T>> {
    return this.request<T>({ method: "PUT", path, body });
  }

  /**
   * 快捷方法: DELETE
   */
  async delete<T = unknown>(path: string): Promise<APIResponse<T>> {
    return this.request<T>({ method: "DELETE", path });
  }

  /**
   * 构建完整 URL
   */
  private buildUrl(path: string, queryParams?: Record<string, string>): string {
    let url = this.config.baseUrl + path;

    if (queryParams && Object.keys(queryParams).length > 0) {
      const params = new URLSearchParams(queryParams);
      url += `?${params.toString()}`;
    }

    return url;
  }

  /**
   * 构建请求头
   */
  private buildHeaders(customHeaders?: Record<string, string>): Record<string, string> {
    const headers = { ...this.config.defaultHeaders, ...customHeaders };

    // 添加认证
    if (this.config.authType === "api_key" && this.config.apiKey) {
      headers["X-API-Key"] = this.config.apiKey;
    } else if (this.config.authType === "bearer_token" && this.config.bearerToken) {
      headers["Authorization"] = `Bearer ${this.config.bearerToken}`;
    } else if (this.config.authType === "basic" && this.config.username && this.config.password) {
      const credentials = btoa(`${this.config.username}:${this.config.password}`);
      headers["Authorization"] = `Basic ${credentials}`;
    }

    return headers;
  }

  /**
   * 检查速率限制
   */
  private checkRateLimit(): { allowed: boolean; message?: string } {
    const now = Date.now();
    const key = "api_requests";
    const timestamps = this.requestCounts.get(key) || [];

    // 清理过期时间戳
    const oneDay = 24 * 60 * 60 * 1000;
    const validTimestamps = timestamps.filter(ts => now - ts < oneDay);

    // 检查每分钟限制
    const oneMinuteAgo = now - 60 * 1000;
    const requestsLastMinute = validTimestamps.filter(ts => ts > oneMinuteAgo).length;
    if (requestsLastMinute >= this.config.rateLimits.requestsPerMinute) {
      return { allowed: false, message: "超过每分钟请求限制" };
    }

    // 检查每小时限制
    const oneHourAgo = now - 60 * 60 * 1000;
    const requestsLastHour = validTimestamps.filter(ts => ts > oneHourAgo).length;
    if (requestsLastHour >= this.config.rateLimits.requestsPerHour) {
      return { allowed: false, message: "超过每小时请求限制" };
    }

    // 检查每天限制
    if (validTimestamps.length >= this.config.rateLimits.requestsPerDay) {
      return { allowed: false, message: "超过每天请求限制" };
    }

    return { allowed: true };
  }

  /**
   * 记录请求
   */
  private recordRequest(): void {
    const key = "api_requests";
    const timestamps = this.requestCounts.get(key) || [];
    timestamps.push(Date.now());
    this.requestCounts.set(key, timestamps);
    this.saveRateLimits();
  }

  /**
   * 休眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 加载配置
   */
  private loadConfig(): void {
    const raw = readStoreValue(STORE_KEYS.API_CONFIG, "");
    if (!raw) {
      this.config = DEFAULT_API_CONFIG;
      return;
    }

    try {
      this.config = { ...DEFAULT_API_CONFIG, ...JSON.parse(raw) };
    } catch (err) {
      console.error("[API] 加载配置失败:", err);
      this.config = DEFAULT_API_CONFIG;
    }
  }

  /**
   * 保存配置
   */
  saveConfig(config: Partial<APIConfig>): void {
    this.config = { ...this.config, ...config };
    const serialized = JSON.stringify(this.config);
    writeStoreValueChecked(STORE_KEYS.API_CONFIG, serialized);
  }

  /**
   * 加载速率限制
   */
  private loadRateLimits(): void {
    const raw = readStoreValue(STORE_KEYS.RATE_LIMITS, "");
    if (!raw) return;

    try {
      const data = JSON.parse(raw) as Record<string, number[]>;
      this.requestCounts = new Map(Object.entries(data));
    } catch (err) {
      console.error("[API] 加载速率限制失败:", err);
    }
  }

  /**
   * 保存速率限制
   */
  private saveRateLimits(): void {
    const data: Record<string, number[]> = {};
    this.requestCounts.forEach((timestamps, key) => {
      data[key] = timestamps;
    });
    const serialized = JSON.stringify(data);
    writeStoreValueChecked(STORE_KEYS.RATE_LIMITS, serialized);
  }

  /**
   * 获取配置
   */
  getConfig(): APIConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<APIConfig>): void {
    this.saveConfig(config);
  }

  /**
   * 配置 API（updateConfig 的别名，用于向后兼容）
   */
  configure(config: Partial<APIConfig>): void {
    this.updateConfig(config);
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.config.enabled) {
      return { success: false, message: "API 未启用" };
    }

    if (!this.config.baseUrl) {
      return { success: false, message: "基础 URL 未配置" };
    }

    try {
      // 尝试向 baseUrl 发送 HEAD 或 GET 请求
      const response = await fetch(this.config.baseUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (response.ok) {
        return { success: true, message: "连接成功" };
      } else {
        return { success: false, message: `连接失败: HTTP ${response.status}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `连接失败: ${message}` };
    }
  }
}

// ============================================================================
// Webhook 管理器
// ============================================================================

export class WebhookManager {
  private webhooks: Map<string, WebhookConfig> = new Map();
  private eventQueue: WebhookEvent[] = [];
  private processingTimer: number | null = null;

  /**
   * 初始化 Webhook 管理器
   */
  async initialize(): Promise<void> {
    this.loadWebhooks();
    this.startProcessing();
  }

  /**
   * 添加 Webhook
   */
  addWebhook(config: Omit<WebhookConfig, "id" | "successCount" | "failureCount" | "createdAt" | "updatedAt">): string {
    const webhook: WebhookConfig = {
      ...config,
      id: this.generateWebhookId(),
      successCount: 0,
      failureCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.webhooks.set(webhook.id, webhook);
    this.saveWebhooks();

    return webhook.id;
  }

  /**
   * 更新 Webhook
   */
  updateWebhook(id: string, updates: Partial<WebhookConfig>): boolean {
    const webhook = this.webhooks.get(id);
    if (!webhook) return false;

    const updated = {
      ...webhook,
      ...updates,
      id: webhook.id,
      updatedAt: Date.now(),
    };

    this.webhooks.set(id, updated);
    this.saveWebhooks();

    return true;
  }

  /**
   * 删除 Webhook
   */
  deleteWebhook(id: string): boolean {
    const deleted = this.webhooks.delete(id);
    if (deleted) {
      this.saveWebhooks();
    }
    return deleted;
  }

  /**
   * 获取所有 Webhook
   */
  getWebhooks(): WebhookConfig[] {
    return Array.from(this.webhooks.values());
  }

  /**
   * 获取 Webhook
   */
  getWebhook(id: string): WebhookConfig | null {
    return this.webhooks.get(id) || null;
  }

  /**
   * 触发 Webhook
   */
  async trigger(eventType: AuditEventType, payload: Record<string, unknown>): Promise<void> {
    // 查找匹配的 webhook
    const matchingWebhooks = Array.from(this.webhooks.values()).filter(
      webhook => webhook.enabled && webhook.events.includes(eventType)
    );

    for (const webhook of matchingWebhooks) {
      // 应用过滤器
      if (webhook.filters) {
        if (webhook.filters.userIds && !webhook.filters.userIds.includes(payload.userId as string)) {
          continue;
        }
        if (webhook.filters.organizationIds && !webhook.filters.organizationIds.includes(payload.organizationId as string)) {
          continue;
        }
        if (webhook.filters.resourceTypes && !webhook.filters.resourceTypes.includes(payload.resourceType as string)) {
          continue;
        }
      }

      // 创建事件
      const event: WebhookEvent = {
        id: this.generateEventId(),
        webhookId: webhook.id,
        eventType,
        payload,
        timestamp: Date.now(),
        signature: await this.signPayload(payload, webhook.secret),
      };

      // 添加到队列
      this.eventQueue.push(event);
    }
  }

  /**
   * 处理事件队列
   */
  private async processQueue(): Promise<void> {
    if (this.eventQueue.length === 0) return;

    const event = this.eventQueue.shift();
    if (!event) return;

    const webhook = this.webhooks.get(event.webhookId);
    if (!webhook) return;

    try {
      const response = await fetch(webhook.url, {
        method: webhook.method,
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": event.signature,
          "X-Webhook-Event": event.eventType,
          "X-Webhook-Timestamp": event.timestamp.toString(),
          ...webhook.headers,
        },
        body: JSON.stringify({
          event: event.eventType,
          timestamp: event.timestamp,
          payload: event.payload,
        }),
        signal: AbortSignal.timeout(webhook.timeout),
      });

      if (response.ok) {
        webhook.successCount++;
        webhook.lastTriggeredAt = Date.now();
        webhook.lastStatus = "success";
        delete webhook.lastError;
      } else {
        webhook.failureCount++;
        webhook.lastTriggeredAt = Date.now();
        webhook.lastStatus = "failure";
        webhook.lastError = `HTTP ${response.status}: ${response.statusText}`;
      }

      this.saveWebhooks();
    } catch (err) {
      webhook.failureCount++;
      webhook.lastTriggeredAt = Date.now();
      webhook.lastStatus = "failure";
      webhook.lastError = err instanceof Error ? err.message : String(err);
      this.saveWebhooks();

      console.error(`[Webhook] 触发失败 (${webhook.name}):`, err);
    }
  }

  /**
   * 启动处理循环
   */
  private startProcessing(): void {
    if (typeof globalThis.setInterval !== "function") {
      console.warn("[Webhook] setInterval not available, skipping processing");
      return;
    }

    this.processingTimer = globalThis.setInterval(() => {
      this.processQueue().catch(err => {
        console.error("[Webhook] 处理队列失败:", err);
      });
    }, 1000) as unknown as number; // 每秒处理一次
  }

  /**
   * 停止处理
   */
  shutdown(): void {
    if (this.processingTimer) {
      globalThis.clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
  }

  /**
   * 签名 payload - 使用标准 HMAC-SHA256
   */
  private async signPayload(payload: Record<string, unknown>, secret: string): Promise<string> {
    const data = JSON.stringify(payload);
    const encoder = new TextEncoder();
    const messageData = encoder.encode(data);
    const keyData = encoder.encode(secret);

    // 使用 Web Crypto API 生成真正的 HMAC-SHA256
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign("HMAC", key, messageData);
    const hashArray = Array.from(new Uint8Array(signature));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * 生成 Webhook ID
   */
  private generateWebhookId(): string {
    return `webhook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 生成事件 ID
   */
  private generateEventId(): string {
    return `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 加载 Webhook
   */
  private loadWebhooks(): void {
    const raw = readStoreValue(STORE_KEYS.WEBHOOKS, "");
    if (!raw) {
      this.webhooks = new Map();
      return;
    }

    try {
      const data = JSON.parse(raw) as WebhookConfig[];
      this.webhooks = new Map(data.map(w => [w.id, w]));
    } catch (err) {
      console.error("[Webhook] 加载失败:", err);
      this.webhooks = new Map();
    }
  }

  /**
   * 保存 Webhook
   */
  private saveWebhooks(): void {
    const data = Array.from(this.webhooks.values());
    const serialized = JSON.stringify(data);
    writeStoreValueChecked(STORE_KEYS.WEBHOOKS, serialized);
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const apiClient = new APIClient();
export const webhookManager = new WebhookManager();
