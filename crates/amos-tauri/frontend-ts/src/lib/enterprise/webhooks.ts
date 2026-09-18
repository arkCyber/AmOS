/**
 * enterprise/webhooks.ts — Webhook 管理
 * 
 * 功能:
 * - Webhook 注册与管理
 * - 事件触发与分发
 * - 重试机制
 * - 签名验证
 * - 批量通知
 */

import { logger } from "./logger";
import { readStoreValue, writeStoreValueChecked } from "../amosStore";
import { localId } from "../localId";

// ============================================================================
// 类型定义
// ============================================================================

/** Webhook 配置 */
export interface WebhookConfig {
  id?: string;
  name: string;
  description: string;
  url: string;
  events: string[];
  secret: string;
  headers: Record<string, string>;
  enabled: boolean;
  method: "POST" | "PUT" | "PATCH";
  timeout: number;
  retryCount: number;
  createdAt?: number;
  updatedAt?: number;
  lastTriggeredAt?: number;
  triggerCount?: number;
  successCount?: number;
  failureCount?: number;
}

/** Webhook 事件 */
export interface WebhookEvent {
  event: string;
  timestamp: number;
  data: unknown;
}

/** Webhook 响应 */
export interface WebhookResponse {
  success: boolean;
  statusCode?: number;
  body?: string;
  error?: string;
  duration: number;
}

// ============================================================================
// 常量
// ============================================================================

const STORE_KEY = "amos.shortcuts.webhooks";
// const MAX_RETRY_ATTEMPTS = 3;  // Defined but referenced in sendWebhook logic
const RETRY_DELAY_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10000;

// ============================================================================
// Webhook 管理器
// ============================================================================

class WebhookManager {
  private webhooks: Map<string, WebhookConfig> = new Map();
  private eventQueue: WebhookEvent[] = [];
  private processing: boolean = false;
  private processInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_QUEUE_SIZE = 1000;  // 队列大小限制

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    try {
      const raw = readStoreValue(STORE_KEY, "");
      if (raw) {
        const data = JSON.parse(raw) as WebhookConfig[];
        data.forEach(config => {
          this.webhooks.set(config.id!, config);
        });
        logger.info("webhooks", `Loaded ${data.length} webhooks`);
      }

      // 启动事件处理器
      this.startEventProcessor();
    } catch (err) {
      logger.error("webhooks", "Failed to initialize webhooks", err);
    }
  }

  /**
   * 关闭
   */
  shutdown(): void {
    this.stopEventProcessor();
  }

  /**
   * 添加 Webhook
   */
  addWebhook(config: Omit<WebhookConfig, "id" | "createdAt" | "updatedAt" | "lastTriggeredAt" | "triggerCount" | "successCount" | "failureCount">): string {
    const id = localId("webhook");
    const now = Date.now();

    const webhook: WebhookConfig = {
      ...config,
      id,
      createdAt: now,
      updatedAt: now,
      lastTriggeredAt: 0,
      triggerCount: 0,
      successCount: 0,
      failureCount: 0,
    };

    this.webhooks.set(id, webhook);
    this.save();

    logger.info("webhooks", `Added webhook: ${webhook.name}`, id);
    return id;
  }

  /**
   * 获取 Webhook
   */
  getWebhook(id: string): WebhookConfig | null {
    return this.webhooks.get(id) || null;
  }

  /**
   * 获取所有 Webhooks
   */
  getWebhooks(filter?: { enabled?: boolean }): WebhookConfig[] {
    const all = Array.from(this.webhooks.values());
    
    if (filter?.enabled !== undefined) {
      return all.filter(w => w.enabled === filter.enabled);
    }
    
    return all;
  }

  /**
   * 更新 Webhook
   */
  updateWebhook(id: string, updates: Partial<WebhookConfig>): boolean {
    const webhook = this.webhooks.get(id);
    if (!webhook) {
      logger.error("webhooks", `Webhook not found: ${id}`);
      return false;
    }

    const updated: WebhookConfig = {
      ...webhook,
      ...updates,
      id, // 不允许修改 ID
      updatedAt: Date.now(),
    };

    this.webhooks.set(id, updated);
    this.save();

    logger.info("webhooks", `Updated webhook: ${id}`);
    return true;
  }

  /**
   * 删除 Webhook
   */
  deleteWebhook(id: string): boolean {
    const deleted = this.webhooks.delete(id);
    if (deleted) {
      this.save();
      logger.info("webhooks", `Deleted webhook: ${id}`);
    } else {
      logger.warn("webhooks", `Webhook not found for deletion: ${id}`);
    }
    return deleted;
  }

  /**
   * 触发 Webhook
   */
  async trigger(event: string, data: unknown): Promise<void> {
    // 检查队列大小，防止内存溢出
    if (this.eventQueue.length >= this.MAX_QUEUE_SIZE) {
      logger.warn("webhooks", `Event queue full (${this.MAX_QUEUE_SIZE}), dropping oldest event`);
      this.eventQueue.shift();
    }

    const webhookEvent: WebhookEvent = {
      event,
      timestamp: Date.now(),
      data,
    };

    this.eventQueue.push(webhookEvent);
    logger.debug("webhooks", `Queued event: ${event}`, data);
  }

  /**
   * 测试 Webhook
   */
  async testWebhook(id: string): Promise<WebhookResponse> {
    const webhook = this.webhooks.get(id);
    if (!webhook) {
      return {
        success: false,
        error: "Webhook 不存在",
        duration: 0,
      };
    }

    return this.sendWebhook(webhook, {
      event: "webhook_test",
      timestamp: Date.now(),
      data: { message: "This is a test webhook" },
    });
  }

  /**
   * 保存到存储
   */
  private save(): void {
    try {
      const data = Array.from(this.webhooks.values());
      const success = writeStoreValueChecked(STORE_KEY, JSON.stringify(data));
      if (!success) {
        logger.error("webhooks", "Failed to save webhooks");
      }
    } catch (err) {
      logger.error("webhooks", "Failed to save webhooks", err);
    }
  }

  /**
   * 启动事件处理器
   */
  private startEventProcessor(): void {
    if (this.processInterval) return;

    if (typeof globalThis.setInterval !== "function") {
      logger.warn("webhooks", "setInterval not available, skipping event processor");
      return;
    }

    this.processInterval = globalThis.setInterval(() => {
      this.processEventQueue();
    }, 1000);

    logger.info("webhooks", "Started event processor");
  }

  /**
   * 停止事件处理器
   */
  private stopEventProcessor(): void {
    if (this.processInterval) {
      globalThis.clearInterval(this.processInterval);
      this.processInterval = null;
      logger.info("webhooks", "Stopped event processor");
    }
  }

  /**
   * 处理事件队列
   */
  private async processEventQueue(): Promise<void> {
    if (this.processing || this.eventQueue.length === 0) return;

    this.processing = true;

    try {
      const event = this.eventQueue.shift();
      if (!event) return;

      const enabledWebhooks = this.getWebhooks({ enabled: true });
      const matchingWebhooks = enabledWebhooks.filter(w => 
        w.events.includes(event.event) || w.events.includes("*")
      );

      if (matchingWebhooks.length === 0) {
        logger.debug("webhooks", `No webhooks for event: ${event.event}`);
        return;
      }

      logger.info("webhooks", `Processing event: ${event.event} for ${matchingWebhooks.length} webhooks`);

      await Promise.all(
        matchingWebhooks.map(webhook => this.sendWebhook(webhook, event))
      );
    } catch (err) {
      logger.error("webhooks", "Failed to process event queue", err);
    } finally {
      this.processing = false;
    }
  }

  /**
   * 发送 Webhook
   */
  private async sendWebhook(webhook: WebhookConfig, event: WebhookEvent): Promise<WebhookResponse> {
    const startTime = Date.now();
    let attempts = 0;
    let lastError: string = "";

    while (attempts < webhook.retryCount) {
      attempts++;

      try {
        logger.debug("webhooks", `Sending webhook (attempt ${attempts}/${webhook.retryCount}): ${webhook.name}`, event.event);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), webhook.timeout || DEFAULT_TIMEOUT_MS);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "User-Agent": "AmOS-Shortcuts/1.0",
          "X-Webhook-Event": event.event,
          "X-Webhook-Timestamp": event.timestamp.toString(),
          ...webhook.headers,
        };

        // 添加签名
        if (webhook.secret) {
          const signature = await this.generateSignature(event, webhook.secret);
          headers["X-Webhook-Signature"] = signature;
        }

        const response = await fetch(webhook.url, {
          method: webhook.method,
          headers,
          body: JSON.stringify(event),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const duration = Date.now() - startTime;
        const body = await response.text();

        // 更新统计
        this.updateWebhookStats(webhook.id!, true);

        logger.info("webhooks", `Webhook sent successfully: ${webhook.name}`, {
          statusCode: response.status,
          duration,
        });

        return {
          success: true,
          statusCode: response.status,
          body,
          duration,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn("webhooks", `Webhook attempt ${attempts} failed: ${webhook.name}`, lastError);

        if (attempts < webhook.retryCount) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    // 所有尝试都失败
    const duration = Date.now() - startTime;
    this.updateWebhookStats(webhook.id!, false);

    logger.error("webhooks", `Webhook failed after ${attempts} attempts: ${webhook.name}`, lastError);

    return {
      success: false,
      error: lastError,
      duration,
    };
  }

  /**
   * 生成签名 - 使用标准 HMAC-SHA256
   */
  private async generateSignature(event: WebhookEvent, secret: string): Promise<string> {
    const payload = JSON.stringify(event);
    const encoder = new TextEncoder();
    const messageData = encoder.encode(payload);
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
   * 更新统计信息
   */
  private updateWebhookStats(id: string, success: boolean): void {
    const webhook = this.webhooks.get(id);
    if (!webhook) return;

    const updated: WebhookConfig = {
      ...webhook,
      lastTriggeredAt: Date.now(),
      triggerCount: (webhook.triggerCount || 0) + 1,
      successCount: success ? (webhook.successCount || 0) + 1 : webhook.successCount,
      failureCount: !success ? (webhook.failureCount || 0) + 1 : webhook.failureCount,
    };

    this.webhooks.set(id, updated);
    this.save();
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const webhookManager = new WebhookManager();
