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

/**
 * 产品**真的会发出**的事件名（REQ-A980）。
 *
 * 与设置面板里那份勾选清单（`svelte/modules/APISettings.svelte::availableEvents`）是
 * **同一组七个字面量**，两者由 {@link emitWebhookEvent} 的入参类型绑在一起：面板上勾一个
 * 事件，只有在有人用这个名字调 `emitWebhookEvent` 时才真的会响。这份声明存在的理由是
 * **发射侧原来一个都没有** —— 七个事件在面板上全部可勾，`trigger` 在生产里零调用者，
 * 于是 `triggerCount` 恒为 0、成功率恒显示 0，用户会以为自己的 webhook 坏了。
 *
 * 诚实边界：这条绑定是**类型级的**，不是门禁级的 —— 往面板上加第八个事件而忘了加发射点，
 * 编译器不会红（面板那份清单是字面量数组）。这一轮没有造门（见 §8.11 的教训：
 * 跑链，不造门）；这里给出的是一条**已经存在的链**：每个发射点都跟在与它同名的
 * `auditLogger` 调用旁边，审计日志有的那七个时刻，webhook 就有。
 */
export const WEBHOOK_EVENTS = [
  "shortcut_create",
  "shortcut_run",
  "shortcut_update",
  "shortcut_delete",
  "shortcut_share",
  "template_install",
  "mdm_policy_change",
] as const;

/** {@link WEBHOOK_EVENTS} 里的一个名字。 */
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

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

/**
 * 导出这个类（而不只是下面的单例）是**为了能测「一个从没被 `initialize()` 的管理器」**：
 * 单例的事件队列是跨用例共享的（`enterprise-webhooks.test.ts` 的溢出用例会往队尾压 1000
 * 条没人订阅的事件，一秒只走一条），所以任何「入队后等它被投递」的断言都不能用单例写。
 * 生产里仍然只有 {@link webhookManager} 一个实例。
 */
export class WebhookManager {
  private webhooks: Map<string, WebhookConfig> = new Map();
  private eventQueue: WebhookEvent[] = [];
  private processing: boolean = false;
  private processInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_QUEUE_SIZE = 1000;  // 队列大小限制
  /** `ensureInitialized()` 是否已经跑过（见那里为什么读写路径要自己把它叫起来）。 */
  private initialized = false;
  /** Screens waiting to hear that a write was refused (REQ-A806) — see {@link onWriteRefused}. */
  private refusalListeners = new Set<() => void>();

  /**
   * 初始化
   *
   * **不要只靠它**——它唯一的调用者是 `enterprise/index.ts` 的 `initializeEnterprise()`，
   * 而后者在生产里**零调用者**（同一事实 `audit.ts::ensureInitialized`（REQ-A897）与
   * `mdm.ts::ensureInitialized` 各记过一次）。见 {@link ensureInitialized}。
   */
  async initialize(): Promise<void> {
    this.initialized = true;
    this.bootstrap();
  }

  /**
   * 引导「读回配置 + 事件处理器」，**幂等**，由使用者自己触发（REQ-A980）。
   *
   * 为什么不能只依赖 `initialize()`：`initializeEnterprise()` 在生产里零调用者，于是
   * `startEventProcessor()` 从未在设备上跑过 —— 那个 1 秒的间隔**从来没有存在**，
   * `eventQueue` 只进不出。两个后果都是用户看得见的：①`trigger` 入队的事件永远躺在内存里，
   * `triggerCount` 恒为 0（`APISettings.svelte` 的成功率因此恒显示 0）；②`getWebhooks()`
   * 读到的是**空表** —— 上一次会话落盘的 Webhook，重启后没有任何人读回来，于是面板上
   * 一条都不显示，用户会以为配置丢了。
   *
   * 所以把「我起来了」这句话系在**真正需要它的那两个动作**上：入队一次（`trigger`）
   * 与读一次（`getWebhooks`）。任何一条被用到，流水线就先自己站起来。
   * `initialized` 在**任何读取/重入之前**置位 —— `bootstrap()` 里的两步都在它之后跑，
   * 顺序反了就是递归。
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.bootstrap();
  }

  /**
   * 「读回配置 + 起处理器」这一份，只有这一处（`initialize()` 与 `ensureInitialized()`
   * 共用；两份字节相同的引导正是 `audit.ts` 上一轮在修的形状）。
   */
  private bootstrap(): void {
    this.loadFromStore();
    this.startEventProcessor();
  }

  /**
   * 从存储读回配置。**失败不抛**：`initialize()` 原先就是吞掉并记一行，这里保持那个
   * 契约（引导路径现在挂在每一次入队/读取上，抛出去会让一次读取变成一次崩溃）。
   */
  private loadFromStore(): void {
    try {
      const raw = readStoreValue(STORE_KEY, "");
      if (raw) {
        const data = JSON.parse(raw) as WebhookConfig[];
        data.forEach(config => {
          this.webhooks.set(config.id!, config);
        });
        logger.info("webhooks", `Loaded ${data.length} webhooks`);
      }
    } catch (err) {
      logger.error("webhooks", "Failed to initialize webhooks", err);
    }
  }

  /**
   * 关闭。**同时清掉「我起来了」的标记**：停机之后再被用到（`trigger`／`getWebhooks`）
   * 必须重新站起来。否则 `shutdown()` 之后的第一次入队会把事件推进一个没有处理器的队列
   * —— 正是本轮在修的形状（一个「随时可能不在」的处理器，和一个从不启动的处理器，
   * 对队列里的那条事件是同一件事）。
   */
  shutdown(): void {
    this.initialized = false;
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
   *
   * 读之前先把流水线叫起来：否则**落盘的那份配置从未被读回**，面板显示空表
   * （REQ-A980，见 {@link ensureInitialized}）。
   */
  getWebhooks(filter?: { enabled?: boolean }): WebhookConfig[] {
    this.ensureInitialized();
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
   *
   * 入队**之前**先把流水线叫起来（顺序不是装饰）：`processEventQueue` 是按存储里那份
   * 配置去匹配订阅者的，处理器先跑、配置后读，这条事件就会被记成「没有 webhook 订阅它」
   * 而丢掉 —— 一个静默丢事件比一条报错更难查（REQ-A980）。
   */
  async trigger(event: string, data: unknown): Promise<void> {
    this.ensureInitialized();

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
   * Subscribe to **persistence refusals** (REQ-A806). Returns an unsubscribe.
   *
   * Why a subscription and not just a returned boolean: `save()` persists the *whole* collection
   * from four different entry points (`addWebhook`／`updateWebhook`／`deleteWebhook`／the enable
   * toggle), and `addWebhook` must keep returning the new id — so the outcome has no place to
   * ride on the return value without turning `string` into `string | null`, which would make
   * every caller handle a "there is no id" case that the in-memory map contradicts.
   *
   * What it is for: a refused write leaves the manager describing a webhook list that is **gone
   * after the next launch**, and the refusal alone cannot say so — a log line has no place on a
   * screen. The screen is the only surface that can, and this is how it hears. (The line itself
   * now also reaches the rendered ledger: REQ-A807 made `logger` an adapter onto it.)
   */
  onWriteRefused(cb: () => void): () => void {
    this.refusalListeners.add(cb);
    return () => {
      this.refusalListeners.delete(cb);
    };
  }

  /**
   * 保存到存储，并报告是否真的写进去了（REQ-A806）。
   */
  private save(): boolean {
    try {
      const data = Array.from(this.webhooks.values());
      if (writeStoreValueChecked(STORE_KEY, JSON.stringify(data))) return true;
      logger.error("webhooks", "Webhook 配置写入被存储拒绝 —— 重启后这些 Webhook 会消失");
    } catch (err) {
      logger.error("webhooks", "Webhook 配置写入抛异常 —— 重启后这些 Webhook 会消失", err);
    }
    for (const cb of this.refusalListeners) {
      // A broken listener must not break the write path it was told about.
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
    return false;
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

    /**
     * **一拍清空当前排队的所有事件**，而不是一拍一条（REQ-A980）。
     *
     * 为什么：`trigger` 不再是死代码之后，这条流水线第一次真的跑起来了，于是"1 秒一拍、
     * 一拍一条"变成了一个用户看得见的**延迟**：入队速率只要超过 1/s，投递延迟就等于队列
     * 深度，而队列深度是**累积**的。实测（修复前的形状）：`enterprise.test.ts` 里同一个文件
     * 先前的用例各自 `mdmManager.configure()` 一次（每次都发一条 `mdm_policy_change`，而这
     * 个进程里没有任何 webhook 订阅它），于是那条"应该能够触发 Webhook"的用例要等自己的
     * 事件前面那 7 条先被一拍一条地走掉 —— 40×100ms 的窗口到点，**单独跑这个文件就红**
     * （`[4044.99ms]`），而它的 `trigger` 与处理器都是好用的。
     *
     * 形状不变的部分：`processing` 仍然是重入闸（一拍还没走完，下一拍直接返回），发送仍然
     * 逐条、仍然只在 `finally` 里放开闸；没有引入并发爆炸 —— 队列上限 1000，且每条都要
     * await 完才走下一个。**语义没有变**：任何已经入队的事件仍然会被投递（包括在这一拍
     * 之前一刻才被注册的订阅者），只是不再"每条各占一秒"。
     */
    try {
      while (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift();
        if (!event) break;

        const enabledWebhooks = this.getWebhooks({ enabled: true });
        const matchingWebhooks = enabledWebhooks.filter(w =>
          w.events.includes(event.event) || w.events.includes("*")
        );

        if (matchingWebhooks.length === 0) {
          logger.debug("webhooks", `No webhooks for event: ${event.event}`);
          continue;
        }

        logger.info("webhooks", `Processing event: ${event.event} for ${matchingWebhooks.length} webhooks`);

        await Promise.all(
          matchingWebhooks.map(webhook => this.sendWebhook(webhook, event))
        );
      }
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

    // `retryCount` 是**重试次数**，不是尝试次数（REQ-A1533）。
    //
    // 修前这里是 `while (attempts < webhook.retryCount)`，于是界面明说合法的 0
    // （`APISettings.svelte` 那个输入框逐字 `min="0" max="5"`，标签 `api.retryCount`
    // 英文作 `Retries`）意味着**一次请求都不发**：循环体一次没进，`lastError` 停在
    // `""`，面板把它折成「未知错误」。判据是同一目录里**同一个字段名**的兄弟
    // `api.ts`：`while (attempt <= this.config.retryCount)` —— 0 次重试 = 发一次，
    // `retryCount: N` 是最多 N+1 次尝试。
    while (attempts <= webhook.retryCount) {
      attempts++;

      try {
        logger.debug("webhooks", `Sending webhook (attempt ${attempts}/${webhook.retryCount + 1}): ${webhook.name}`, event.event);

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

        // 4xx／5xx 是一个**回答**：投递被拒了，不是一次投递成功。
        //
        // 修前这里不看 `response.ok`，任何状态码都走下面的成功分支 —— `successCount` 照涨，
        // 面板那行「成功: N (100%)」（英文 `Delivered:`）与「测试成功！」都被点亮，而返回
        // 对象自己就自相矛盾（`success: true` 与 `statusCode: 500` 并存）。判据是**同一目录
        // 同一件事**的兄弟实现 `api.ts`（`response.ok` ⇒ `success:false, "HTTP 500: …"`），
        // 以及 `APISettings.svelte::testConnection`（REQ-A819）修掉的同一个折（REQ-A1529）。
        //
        // 非 2xx **不重试**，与 `api.ts` 对非 2xx 的处理一致（那边只有传输层抛才重试）：
        // 一个状态码是终局回答，重发同一份 payload 不会改变它。状态码原样带回去，好让
        // 调用方能把「端点拒了」与「根本没连上」（无 `statusCode`）分开。
        if (!response.ok) {
          this.updateWebhookStats(webhook.id!, false);

          logger.warn("webhooks", `Webhook rejected: ${webhook.name}`, {
            statusCode: response.status,
            duration,
          });

          return {
            success: false,
            statusCode: response.status,
            body,
            error: `HTTP ${response.status}: ${response.statusText}`,
            duration,
          };
        }

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

/**
 * 入队一条产品事件 —— **生产里唯一的发射入口**（REQ-A980）。
 *
 * 为什么要有这一个函数，而不是每个调用点直接 `webhookManager.trigger(...)`：
 * ①`trigger` 的参数是裸 `string`，那样每个调用点都能发明一个新事件名，而设置面板只会
 * 展示它认识的那七个；这里把名字收紧成 {@link WebhookEventName}，写错一个字母就是编译错误。
 * ②入队是**一件不产生返回值的事**（事件是否送达由投递侧记账），所以调用方不需要、也不应该
 * `await` 它 —— 但一个被丢弃的 promise 连拒绝都吞掉，于是这里就地挂 `.catch` 记一行，
 * 与 `shortcuts.ts` 里 `auditLogger.log(...).catch(...)` 是同一个形状。
 *
 * **不 await 是设计，不是偷懒**：发射点都在用户动作的同步路径上（建/改/删/跑一条指令），
 * 让它们等一次网络往返会把 UI 卡住；投递本身由 1 秒一拍的事件处理器负责。
 */
export function emitWebhookEvent(event: WebhookEventName, data: Record<string, unknown>): void {
  webhookManager.trigger(event, data).catch((err) => {
    logger.error("webhooks", `Failed to queue "${event}"`, err);
  });
}
