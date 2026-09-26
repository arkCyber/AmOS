/**
 * enterprise/api.ts — API 集成
 * 
 * 功能:
 * - RESTful API 客户端
 * - 认证和授权
 * - 速率限制
 * 
 * 安全特性:
 * - API Key 管理
 * - 请求签名
 * - 速率限制
 * - IP 白名单
 *
 * **Webhook 不在这里**：本文件曾自带一份 `WebhookManager`，与 `enterprise/webhooks.ts`
 * 的那一份重复，而 `enterprise/index.ts` 只把后者接进生产（`APISettings.svelte` 用的是
 * `webhooks.ts` 的 `testWebhook` 等方法，本文件那份没有）。按仓库判据
 * （"wire it, delete it, or baseline it"）删掉重复实现 —— 它那份的 `retryCount`
 * 从未被使用、`eventQueue` 也没有上限，留着只是"两处真相"。
 */

import { readStoreValue, writeStoreValueChecked } from "../amosStore";
import { logger } from "./logger";
import { auditLogger } from "./audit";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * API 认证类型 —— the **one** declaration. `APIAuthType` is derived from it, so the type the
 * request path switches on and the list the settings screen renders cannot drift apart
 * (`vocab-mirror-scan`: a hand-written union next to an array of the same literals is two
 * spellings of one vocabulary, and the array is the one the code actually consults).
 */
export const AUTH_TYPES = ["api_key", "bearer_token", "oauth2", "basic"] as const;
export type APIAuthType = (typeof AUTH_TYPES)[number];

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

// ============================================================================
// 常量
// ============================================================================

const STORE_KEYS = {
  API_CONFIG: "amos.shortcuts.api.config",
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

/**
 * One credential input an auth type reads off {@link APIConfig}, named by its own field.
 *
 * The name **is** the `APIConfig` key (this is a `keyof`-style union, not a label), so the
 * screen that renders the inputs and the code that reads them cannot drift apart.
 */
export type AuthField = "apiKey" | "bearerToken" | "username" | "password";

/** What one auth type contributes to a request: a `[header, value]` pair, or `null`. */
type AuthHeader = (config: APIConfig) => [name: string, value: string] | null;

/** Everything the shell knows about one auth type — one declaration, read by the request path
 *  and by the screen that configures it. */
export interface AuthTypeInfo {
  /** Whether this build can authenticate with this type at all. `false` means the vocabulary
   *  member exists with no flow behind it, and the screen must offer it as an unavailable
   *  choice **with that reason** rather than as a working one (REQ-A801). */
  implemented: boolean;
  /** The credential inputs this type reads, in the order they are shown. */
  fields: readonly AuthField[];
  /** The header a configured request carries, or `null` when there is nothing to send. */
  header: AuthHeader;
}

/**
 * **The one declaration of what each auth type means** (REQ-A801) — read by `buildHeaders` on
 * the request path and by `APISettings.svelte` to build its select and its credential inputs.
 *
 * **Why a table and not the `if`/`else if` chain this replaced.** The chain had **three**
 * branches for a **four**-member vocabulary, so `oauth2` fell off the end and the request went
 * out with **no authentication header at all** — a 401 the user could not explain from anything
 * on screen, produced by a config value the type system said was perfectly fine. A chain cannot
 * be exhaustive; a `Record` over the union can, so a new member now has to be given a header or
 * an explicit "no flow" instead of silently inheriting "no auth".
 *
 * `header`'s `null` carries two different — and both honest — meanings, which is why this holds
 * *builders* rather than strings:
 *   • **no credential entered yet** (`api_key` with an empty key, `basic` with a missing half):
 *     sending nothing is right, because there is nothing to send. Where the user has to be able
 *     to see that is the screen, and it says so;
 *   • **this build implements no such flow** (`oauth2`): the `null` is a statement about the
 *     build, not about the config. `implemented: false` is the flag that keeps the two apart —
 *     it is asserted to agree with `fields`/`header` by
 *     `src/lib/__tests__/enterprise-api.test.ts` → `describe("认证方式的词表是全的（REQ-A801）")`.
 */
export const AUTH_TYPE_INFO: Record<APIAuthType, AuthTypeInfo> = {
  api_key: {
    implemented: true,
    fields: ["apiKey"],
    header: (c) => (c.apiKey ? ["X-API-Key", c.apiKey] : null),
  },
  bearer_token: {
    implemented: true,
    fields: ["bearerToken"],
    header: (c) => (c.bearerToken ? ["Authorization", `Bearer ${c.bearerToken}`] : null),
  },
  basic: {
    implemented: true,
    fields: ["username", "password"],
    header: (c) =>
      c.username && c.password
        ? ["Authorization", `Basic ${btoa(`${c.username}:${c.password}`)}`]
        : null,
  },
  // Declared in `APIAuthType`, **not implemented**: no request this build sends carries an
  // OAuth2 token, and there is no flow to obtain one. Written down here rather than left as
  // the residue of a missing `else`.
  oauth2: { implemented: false, fields: [], header: () => null },
};

// ============================================================================
// API 客户端
// ============================================================================

export class APIClient {
  private config: APIConfig = DEFAULT_API_CONFIG;
  private requestCounts: Map<string, number[]> = new Map();
  /** `ensureInitialized()` 是否已经跑过（见那里为什么读写路径要自己把它叫起来）。 */
  private initialized = false;

  /**
   * 引导流水线，**幂等**，由使用者自己触发（REQ-A982 / F-SH-309）。
   *
   * 为什么不能只依赖 `initialize()`：它只被 `enterprise/index.ts` 的
   * `initializeEnterprise()` 调用，而后者在生产里**零调用者**（同一事实 `audit.ts` /
   * `mdm.ts` / `webhooks.ts` 各记过一次，它自己也在 `scripts/unwired-baseline.json` 里）。
   * 于是 `loadConfig()` 从来没有在设备上跑过，`this.config` 永远是编译期的
   * `DEFAULT_API_CONFIG`（`enabled: false`、空 `baseUrl`）。
   *
   * 后果是**两件**事，第二件比第一件重：①`APISettings.svelte` 挂载时
   * `getConfig()` 拿到的是默认值 —— 用户上一轮存下的配置在面板上根本不存在；②面板把它
   * 读到的那一份**原样写回**（`configure(apiConfig)` 传的是整份配置），于是**按一次保存
   * 就把存储里那份覆盖成默认值**，而且面板还会显示「配置已保存」。
   *
   * `initialized` 在任何重入之前置位（与 `audit.ts` 同形）。
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.bootstrap();
  }

  /**
   * 「装载」这一份，只有这一处（`initialize()` 与 `ensureInitialized()` 共用；两份字节
   * 相同的装载正是本模块反复修掉的形状）。
   */
  private bootstrap(): void {
    this.loadConfig();
    this.loadRateLimits();
  }

  /**
   * 初始化 API 客户端
   *
   * 显式初始化 = 「采纳存储里那一份」，每次都重新装载（与从前一致）。
   */
  async initialize(): Promise<void> {
    this.bootstrap();
    this.initialized = true;
  }

  /**
   * 发送 API 请求
   */
  async request<T = unknown>(options: APIRequestOptions): Promise<APIResponse<T>> {
    // 判的是 `config.enabled`，所以那份配置必须先真的读过存储 —— 否则这里判的是
    // 编译期默认的 `false`，用户明明启用了 API 也会拿到「API 未启用」。
    this.ensureInitialized();
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
   *
   * The auth decision is a table lookup (REQ-A801), not a chain — see {@link AUTH_TYPE_INFO}
   * for why the chain was a defect rather than a style choice.
   */
  private buildHeaders(customHeaders?: Record<string, string>): Record<string, string> {
    const headers = { ...this.config.defaultHeaders, ...customHeaders };

    const auth = AUTH_TYPE_INFO[this.config.authType].header(this.config);
    if (auth) headers[auth[0]] = auth[1];

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
   * Persist the merged config and **report whether it landed** (REQ-A806).
   *
   * The refusal used to stop at `logger.error` — a `console.*` wrapper with **no reader anywhere
   * in the app** — so the one surface that could have told the user was the one that cannot.
   * Meanwhile `APISettings.svelte` showed 「配置已保存」 for every write, including the rejected
   * ones, and the sentence stayed true only until the next launch. Same family as F-SH-043／
   * F-INK-005: the page draws a conclusion on the store's behalf.
   *
   * The refusal now reaches the ledger `settings/AiPage.svelte` renders — because a returned
   * boolean answers exactly one caller, while the diagnostics ring answers "what has been going
   * wrong lately", which is the question someone whose config keeps vanishing actually has. It
   * gets there through {@link logger}, **not** a second channel: REQ-A807 made `logger` itself an
   * adapter onto that ledger, so this one call is the whole mechanism.
   *
   * **REQ-A982 的补充**：上面那句「next launch 会回落默认」在 REQ-A806 写下的当天对
   * **每一次**成功写入也成立 —— 只是原因在别处（`loadConfig()` 没有生产调用者，
   * 见 {@link ensureInitialized}），于是这句话把用户指向了存储，而存储是无辜的。
   * 现在 `false` 真的只意味着「这次写入没落盘」。
   *
   * @returns `true` when the config is durably stored, `false` when it lives only in this
   *   process and will be replaced by {@link DEFAULT_API_CONFIG} on the next launch.
   */
  saveConfig(config: Partial<APIConfig>): boolean {
    // **先装载再合并**：`this.config` 是合并的底座，底座若是编译期默认值，这一次写入
    // 就会用默认值覆盖掉用户此前存下的每一个字段（REQ-A982 / F-SH-309）。
    this.ensureInitialized();
    this.config = { ...this.config, ...config };
    const serialized = JSON.stringify(this.config);
    if (writeStoreValueChecked(STORE_KEYS.API_CONFIG, serialized)) return true;
    logger.error("api", "API 配置写入被存储拒绝 —— 重启后会回落到默认配置");
    return false;
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
    // 速率限制只是本会话的窗口；丢了会放宽限制，仍要说出来。
    if (!writeStoreValueChecked(STORE_KEYS.RATE_LIMITS, serialized)) {
      logger.warn("api", "速率限制写入被存储拒绝 —— 重启后计数从零开始（限制会短暂放宽）");
    }
  }

  /**
   * 获取配置
   */
  getConfig(): APIConfig {
    // 面板挂载时读的就是这一句：不先装载，用户看到的是默认值而不是他存下的那一份。
    this.ensureInitialized();
    return { ...this.config };
  }

  /**
   * 更新配置
   *
   * Returns what {@link saveConfig} returns — **not** `void`, so a caller that shows the user a
   * 「已保存」 claim can only make it when the write landed (REQ-A806).
   */
  updateConfig(config: Partial<APIConfig>): boolean {
    return this.saveConfig(config);
  }

  /**
   * 配置 API（updateConfig 的别名，用于向后兼容）
   *
   * See {@link updateConfig} for why this reports the write's outcome.
   */
  configure(config: Partial<APIConfig>): boolean {
    return this.updateConfig(config);
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    // 同 `request()`：这两条判据读的都是 `this.config`，它必须先真的读过存储。
    this.ensureInitialized();
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
// 导出单例
// ============================================================================

export const apiClient = new APIClient();
