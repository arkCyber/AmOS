/**
 * webman.ts — WebMan 浏览器核心逻辑 (航空航天级)
 *
 * 安全标准:
 * - 严格的输入验证
 * - XSS/CSRF 防护
 * - 运行时类型检查
 * - 完整的错误处理
 * - 并发安全
 */
import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "./amosStore";
import { localId } from "./localId";

// ==================== 常量定义 ====================

/** WebMan 存储键 */
export const BOOKMARKS_KEY = "amos.webman.bookmarks";
export const HISTORY_KEY = "amos.webman.history";
export const DOWNLOADS_KEY = "amos.webman.downloads";
export const SETTINGS_KEY = "amos.webman.settings";
export const TABS_KEY = "amos.webman.tabs";

/** 系统限制 */
export const LIMITS = {
  URL_MAX_LENGTH: 2048,
  TITLE_MAX_LENGTH: 200,
  FILENAME_MAX_LENGTH: 255,
  BOOKMARK_MAX_COUNT: 1000,
  HISTORY_MAX_COUNT: 500,
  TAB_MAX_COUNT: 50,
  DOWNLOAD_MAX_COUNT: 100,
} as const;

/** 危险协议列表 */
const DANGEROUS_PROTOCOLS = [
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'about:',
  'blob:',
  'filesystem:',
] as const;

// ==================== 类型定义 ====================

/** 书签条目 */
export interface Bookmark {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  createdAt: number;
}

/** 历史记录条目 */
export interface HistoryEntry {
  url: string;
  title: string;
  favicon?: string;
  visitedAt: number;
}

/** 下载条目 */
export interface Download {
  id: string;
  url: string;
  filename: string;
  progress: number; // 0-100
  status: "pending" | "downloading" | "completed" | "failed";
  createdAt: number;
}

/** 浏览器设置 */
export interface WebManSettings {
  /** 搜索引擎 */
  searchEngine: "google" | "bing" | "baidu" | "duckduckgo";
  /** 默认主页 */
  homepage: string;
  /** 隐私模式 */
  privateMode: boolean;
  /** 阻止弹窗 */
  blockPopups: boolean;
  /** JavaScript 启用 */
  javaScriptEnabled: boolean;
  /** 家长控制 */
  safeSearch: boolean;
}

export const DEFAULT_SETTINGS: WebManSettings = {
  searchEngine: "google",
  homepage: "https://www.google.com",
  privateMode: false,
  blockPopups: true,
  javaScriptEnabled: true,
  safeSearch: true,
};

/** 标签页 */
export interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  /** 是否正在加载 */
  loading: boolean;
  /** 滚动位置 */
  scrollY: number;
  /** 是否是固定标签 */
  pinned: boolean;
}

/** 验证结果 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: string;
}

// ==================== 日志系统 ====================

export const logger = {
  debug: (message: string, ...args: unknown[]): void => {
    if (import.meta.env?.DEV) {
      console.debug(`[WebMan DEBUG] ${message}`, ...args);
    }
  },

  info: (message: string, ...args: unknown[]): void => {
    console.info(`[WebMan INFO] ${message}`, ...args);
  },

  warn: (message: string, ...args: unknown[]): void => {
    console.warn(`[WebMan WARN] ${message}`, ...args);
  },

  error: (message: string, error?: Error | unknown): void => {
    console.error(`[WebMan ERROR] ${message}`, error);
  },
};

// ==================== 安全函数 ====================

/**
 * 生成唯一 ID。
 *
 * 走共享的 `localId`（REQ-A401）。旧实现把计数器挂在函数对象上
 * （`(generateId as any).counter`，1000 取模）并只保留 8 位 base36 随机尾巴 ——
 * 计数器一绕回就只剩运气。这个 id 是书签/历史/下载/标签页这些**持久化行**的身份，
 * 所以它必须由构造保证唯一，而不是大概率唯一。
 */
export function generateId(): string {
  return localId("wm");
}

/** 安全的 URL 验证 */
export function isValidUrl(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `hostname` 是否只在本机 / 局域网内有意义（生产模式的黑名单）。
 *
 * REQ-A405 修的是这条边界**既漏又误杀**：
 *  * 漏：只比了 IPv4 的字符串前缀，于是 IPv6 回环 `[::1]`、唯一本地 `fc00::/7`、链路
 *    本地 `fe80::/10`、IPv4 链路本地 `169.254.0.0/16`、以及 RFC 6761 的 `*.localhost`
 *    全部**放行** —— 一个"生产环境不允许访问本地地址"的门，绕过去只要换一种写法。
 *  * 误杀：`hostname.startsWith("172.")` 把整个 172/8 当私网，而 RFC 1918 的私网只有
 *    172.16.0.0/12 ⇒ 公网的 `172.32.1.1` 在生产环境被拒（用户打不开的站点）。
 *
 * WHATWG `URL` 已经把各种 IPv4 怪写法（`0x7f.1`、`2130706433`、八进制）规范化成
 * dotted-quad，所以这里只需要按十进制四段判断；IPv6 由 `URL` 规范化为压缩小写形式
 * （`hostname` 带方括号）。
 */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = octets[0] ?? -1; // 长度已判为 4；`?? -1` 只是为了不用非空断言
  const b = octets[1] ?? -1;
  return (
    a === 0 || // 0.0.0.0/8 — "this network"
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 — loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 — link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (NOT all of 172/8)
    (a === 192 && b === 168) // 192.168.0.0/16
  );
}

/** `hostname` 指向本机 / 内网？（导出以便直接测这条安全边界。） */
export function isLocalHostname(hostname: string): boolean {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true; // RFC 6761
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true; // unspecified / loopback
    // IPv4-mapped (`::ffff:a.b.c.d`) — **两种写法都要认**：`new URL("http://[::ffff:127.0.0.1]/")`
    // 交给你的 hostname 是 `[::ffff:7f00:1]`（WHATWG 把点分改写成十六进制），所以只匹配点分的
    // 判断会放行一个真正的回环地址（生产模式下就是绕过本地地址门）。实测见测试文件。
    const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    if (mappedDotted) return isPrivateIPv4(mappedDotted[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(host.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 — unique-local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
    return false;
  }
  return isPrivateIPv4(host);
}

/** 清理和验证 URL (P0 安全修复) */
export function sanitizeUrl(url: string): ValidationResult {
  // 1. 基础验证
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL 不能为空' };
  }

  if (url.length > LIMITS.URL_MAX_LENGTH) {
    return { 
      valid: false, 
      error: `URL 超过最大长度 ${LIMITS.URL_MAX_LENGTH} 字符` 
    };
  }

  // 2. 去除前后空格和危险字符
  const trimmed = url.trim()
    .replace(/[\r\n\t]/g, '') // 移除换行符
    .replace(/[<>]/g, '');     // 移除 HTML 字符

  // 3. 检查危险协议 (P0 XSS 防护)
  const lower = trimmed.toLowerCase();
  for (const proto of DANGEROUS_PROTOCOLS) {
    if (lower.startsWith(proto)) {
      logger.error(`Blocked dangerous protocol: ${proto} in URL: ${url}`);
      return { 
        valid: false, 
        error: `不允许的协议: ${proto}` 
      };
    }
  }

  // 4. 验证 URL 格式
  try {
    const parsed = new URL(trimmed);
    
    // 只允许 HTTP/HTTPS
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { 
        valid: false, 
        error: '只支持 HTTP 和 HTTPS 协议' 
      };
    }

    // 阻止本地 IP (生产环境) - 但测试/开发环境允许
    const isDev = import.meta.env?.DEV !== false; // 默认允许开发模式
    if (!isDev && isLocalHostname(parsed.hostname)) {
      return {
        valid: false,
        error: '生产环境不允许访问本地地址'
      };
    }

    return { 
      valid: true, 
      sanitized: parsed.toString() 
    };
  } catch (error) {
    return { 
      valid: false, 
      error: 'URL 格式无效' 
    };
  }
}

/**
 * 验证标题。
 *
 * REQ-A404: `sanitized` **任何情况都给**（清洗 + 截断到上限），不再只在 `valid` 时给。
 * 原实现里超长标题只回 `{valid:false}` ⇒ 调用方若要"仍然记录这次访问"就**没有可用的
 * 清洗值**，只能退回落盘**原始**标题（`addToHistory` 当时正是这么做的：带 `<>`、
 * 超限长度原样入库）；而 `addBookmark` 用 `valid` 直接拒绝 —— 同一份输入两条相反处理。
 * 现在两种策略都能拿到同一个清洗值：拒绝的继续拒绝，要记录的记**清洗后**的。
 */
export function validateTitle(title: string): ValidationResult {
  const clean = (t: string) =>
    t
      .replace(/[<>]/g, '')       // HTML
      .replace(/[\r\n\t]/g, ' ')  // 换行符
      .trim()
      .slice(0, LIMITS.TITLE_MAX_LENGTH);

  if (!title || typeof title !== 'string') {
    return { valid: false, error: '标题不能为空', sanitized: '' };
  }

  if (title.length > LIMITS.TITLE_MAX_LENGTH) {
    return {
      valid: false,
      error: `标题超过最大长度 ${LIMITS.TITLE_MAX_LENGTH} 字符`,
      sanitized: clean(title),
    };
  }

  return { valid: true, sanitized: clean(title) };
}

/** 解析输入 (URL 或搜索) - 增强安全版 */
export function parseInput(input: string, searchEngine: WebManSettings["searchEngine"]): string {
  // 非字符串入参（地址栏在 DOM 事件里可能拿到 null）回空串：与"没输入"同一答复，
  // 而不是把 `input.trim is not a function` 抛给调用方（REQ-A405 A 的同一类修复）。
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  
  // 空输入
  if (!trimmed) return "";
  
  // 1. 先检查是否是有效 URL
  if (isValidUrl(trimmed)) {
    const result = sanitizeUrl(trimmed);
    if (result.valid && result.sanitized) {
      return result.sanitized;
    }
    logger.warn(`Invalid URL rejected: ${trimmed}`);
    return "";
  }
  
  // 2. 检查是否需要添加协议
  if (trimmed.startsWith("localhost") || trimmed.match(/^\d+\.\d+\.\d+\.\d+/)) {
    const withProtocol = `http://${trimmed}`;
    const result = sanitizeUrl(withProtocol);
    if (result.valid && result.sanitized) {
      return result.sanitized;
    }
    return "";
  }
  
  // 3. 作为搜索查询 (需要转义)
  const safeQuery = encodeURIComponent(trimmed);
  const engines: Record<typeof searchEngine, string> = {
    google: "https://www.google.com/search?q=",
    bing: "https://www.bing.com/search?q=",
    baidu: "https://www.baidu.com/s?wd=",
    duckduckgo: "https://duckduckgo.com/?q=",
  };
  
  return engines[searchEngine] + safeQuery;
}

// ==================== 工具函数 ====================

/** 防抖函数 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  
  return function(...args: Parameters<T>) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
}

/** 节流函数 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  
  return function(...args: Parameters<T>) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn(...args);
    }
  };
}

/**
 * `hostname` 是否**就是** `domain`，或它的一个子域。
 *
 * 为什么不用 `hostname.includes(domain)`（原实现）：`notgoogle.com` 与
 * `google.com.evil.example` 都**包含** `google.com` 子串，于是 safe-search 会被加到
 * 根本不是该搜索引擎的站点上；反过来，一个真域名若只是恰好包含子串也会被误认。
 * 边界必须是**点分边界**：等于，或以 `"." + domain` 结尾。
 */
function hostMatches(hostname: string, domain: string): boolean {
  const h = hostname.toLowerCase();
  return h === domain || h.endsWith("." + domain);
}

/** 安全搜索过滤器 */
export function applySafeSearch(url: string, enabled: boolean): string {
  if (!enabled) return url;
  
  try {
    const parsed = new URL(url);
    
    // Google
    if (hostMatches(parsed.hostname, 'google.com')) {
      parsed.searchParams.set('safe', 'active');
    }
    // Bing
    else if (hostMatches(parsed.hostname, 'bing.com')) {
      parsed.searchParams.set('adlt', 'strict');
    }
    // DuckDuckGo
    else if (hostMatches(parsed.hostname, 'duckduckgo.com')) {
      parsed.searchParams.set('kp', '1');
    }
    
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 非字符串输入下的降级值（REQ-A405 A）。
 *
 * `extractDomain` / `extractTitle` 的 `catch` 原先写的是 `url.slice(0, 50)` —— 也就是
 * **刚刚失败的那个表达式**。非字符串输入（`null` / 数字 / 对象）先被 `sanitizeUrl`
 * 判为无效，走到 `return url.slice(0, 50)` 抛 TypeError，被 `catch` 接住，然后在
 * `catch` 里**又抛一次**，这次直接交给调用方：一个自称"增强错误处理"的函数成了崩溃点。
 * 兜底值只算一次、放在 `try` 外面，两条路径都吐它，且它本身不可能抛。
 */
function shortFallback(input: unknown): string {
  return typeof input === "string" ? input.slice(0, 50) : "";
}

/** 提取域名 - 增强错误处理 */
export function extractDomain(url: string): string {
  const fallback = shortFallback(url);
  try {
    const result = sanitizeUrl(url);
    if (!result.valid || !result.sanitized) {
      return fallback;
    }
    const u = new URL(result.sanitized);
    return u.hostname;
  } catch (error) {
    logger.warn(`Failed to extract domain from: ${url}`, error);
    return fallback;
  }
}

/** 提取标题 (从 URL) - 增强错误处理 */
export function extractTitle(url: string): string {
  const fallback = shortFallback(url);
  try {
    const result = sanitizeUrl(url);
    if (!result.valid || !result.sanitized) {
      return fallback;
    }
    const u = new URL(result.sanitized);
    return (u.hostname + u.pathname).slice(0, LIMITS.TITLE_MAX_LENGTH);
  } catch (error) {
    logger.warn(`Failed to extract title from: ${url}`, error);
    return fallback;
  }
}

/** 获取网站图标 URL - 安全版 */
export function getFaviconUrl(url: string): string {
  try {
    const result = sanitizeUrl(url);
    if (!result.valid || !result.sanitized) {
      return "";
    }
    const u = new URL(result.sanitized);
    // 使用 Google Favicon 服务
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=64`;
  } catch (error) {
    logger.warn(`Failed to get favicon for: ${url}`, error);
    return "";
  }
}

// ==================== 书签管理 (并发安全) ====================

/** 书签存储版本化结构 */
interface BookmarkStore {
  version: number;
  data: Bookmark[];
}

/**
 * 一个 store 的 version**归一化**读法：不是数字就当 0（读侧本来就这么做）。
 *
 * REQ-A404: 写侧原先拿**原值**比对（`current.version !== expectedVersion`），而读侧把
 * 非数字 version 归一化成 0 ⇒ 一个"有行、没 version"的 store（旧版本 / 导入器 / 手工编辑）
 * 永远 `undefined !== 0`，**每一次写都失败**、重试 3 次后放弃；`addToHistory` 的返回值是
 * void ⇒ 用户看不到任何提示。四处 store（书签/历史/下载/标签）同形。归一化不会掩盖真正的
 * 并发写：写者一律写数字 version。
 */
function normalizedVersion(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 加载书签存储 */
function loadBookmarkStore(): BookmarkStore {
  try {
    const stored = readStoreValue<BookmarkStore>(BOOKMARKS_KEY, { version: 0, data: [] });
    
    // 运行时类型检查
    if (!stored || typeof stored !== 'object') {
      logger.warn('Invalid bookmark store, resetting');
      return { version: 0, data: [] };
    }

    if (!Array.isArray(stored.data)) {
      logger.warn('Invalid bookmark data, resetting');
      return { version: 0, data: [] };
    }

    // 验证每个书签
    const validBookmarks = stored.data.filter((b): b is Bookmark => {
      return (
        b &&
        typeof b === 'object' &&
        typeof b.id === 'string' &&
        typeof b.url === 'string' &&
        typeof b.title === 'string' &&
        typeof b.createdAt === 'number' &&
        sanitizeUrl(b.url).valid
      );
    });

    return {
      version: normalizedVersion(stored.version),
      data: validBookmarks.slice(0, LIMITS.BOOKMARK_MAX_COUNT),
    };
  } catch (error) {
    logger.error('Failed to load bookmarks', error);
    return { version: 0, data: [] };
  }
}

/** 保存书签存储 (带版本检查) */
function saveBookmarkStore(bookmarks: Bookmark[], expectedVersion: number): boolean {
  try {
    const current = readStoreValue<BookmarkStore>(BOOKMARKS_KEY, { version: 0, data: [] });
    
    // 版本检查 (乐观锁)
    if (normalizedVersion(current.version) !== expectedVersion) {
      logger.warn(`Bookmark version mismatch: expected ${expectedVersion}, got ${current.version}`);
      return false;
    }

    const newStore: BookmarkStore = {
      version: expectedVersion + 1,
      data: bookmarks.slice(0, LIMITS.BOOKMARK_MAX_COUNT),
    };

    // 书签是**用户内容**（在 `cloud.ts` 的 SYNC_STORES 里）：写盘被拒必须让调用方
    // 看到，不能在这里 `return true` —— 那等于告诉用户"书签存好了"，而它没存下。
    if (!writeStoreValueChecked(BOOKMARKS_KEY, newStore)) {
      logger.error('Failed to save bookmarks (the store rejected the write)');
      return false;
    }
    return true;
  } catch (error) {
    logger.error('Failed to save bookmarks', error);
    return false;
  }
}

/** 加载书签 (公共接口) */
export function loadBookmarks(): Bookmark[] {
  return loadBookmarkStore().data;
}

/** 添加书签 - 并发安全版 */
export function addBookmark(url: string, title?: string): Bookmark | null {
  // 验证 URL
  const urlResult = sanitizeUrl(url);
  if (!urlResult.valid || !urlResult.sanitized) {
    logger.error(`Invalid URL for bookmark: ${url}`, urlResult.error);
    return null;
  }

  // 验证标题
  const titleText = title || extractTitle(urlResult.sanitized);
  const titleResult = validateTitle(titleText);
  if (!titleResult.valid) {
    logger.error(`Invalid title for bookmark: ${titleText}`, titleResult.error);
    return null;
  }

  // 重试逻辑 (乐观锁)
  let retries = 3;
  while (retries > 0) {
    const store = loadBookmarkStore();
    const { version, data: bookmarks } = store;

    // 检查是否已存在
    if (bookmarks.some((b) => b.url === urlResult.sanitized)) {
      logger.info(`Bookmark already exists: ${url}`);
      return null;
    }

    // 检查数量限制
    if (bookmarks.length >= LIMITS.BOOKMARK_MAX_COUNT) {
      logger.warn(`Bookmark limit reached: ${LIMITS.BOOKMARK_MAX_COUNT}`);
      return null;
    }

    const bookmark: Bookmark = {
      id: generateId(),
      url: urlResult.sanitized,
      title: titleResult.sanitized || titleText,
      favicon: getFaviconUrl(urlResult.sanitized),
      createdAt: Date.now(),
    };

    bookmarks.unshift(bookmark);

    // 尝试保存
    if (saveBookmarkStore(bookmarks, version)) {
      logger.info(`Bookmark added: ${bookmark.title}`);
      return bookmark;
    }

    retries--;
    logger.warn(`Bookmark save retry, attempts left: ${retries}`);
  }

  logger.error(`Failed to add bookmark after retries: ${url}`);
  return null;
}

/** 删除书签 - 并发安全版 */
export function removeBookmark(id: string): boolean {
  if (!id || typeof id !== 'string') {
    logger.error('Invalid bookmark ID');
    return false;
  }

  let retries = 3;
  while (retries > 0) {
    const store = loadBookmarkStore();
    const { version, data: bookmarks } = store;

    const index = bookmarks.findIndex((b) => b.id === id);
    if (index === -1) {
      logger.warn(`Bookmark not found: ${id}`);
      return false;
    }

    bookmarks.splice(index, 1);

    if (saveBookmarkStore(bookmarks, version)) {
      logger.info(`Bookmark removed: ${id}`);
      return true;
    }

    retries--;
  }

  logger.error(`Failed to remove bookmark after retries: ${id}`);
  return false;
}

/** 检查 URL 是否已收藏 */
export function isBookmarked(url: string): boolean {
  const result = sanitizeUrl(url);
  if (!result.valid || !result.sanitized) {
    return false;
  }
  return loadBookmarks().some((b) => b.url === result.sanitized);
}

// ==================== 历史记录管理 (性能优化) ====================

/** 历史记录存储版本化结构 */
interface HistoryStore {
  version: number;
  data: HistoryEntry[];
}

/** 加载历史记录存储 */
function loadHistoryStore(): HistoryStore {
  try {
    const stored = readStoreValue<HistoryStore>(HISTORY_KEY, { version: 0, data: [] });
    
    if (!stored || typeof stored !== 'object' || !Array.isArray(stored.data)) {
      logger.warn('Invalid history store, resetting');
      return { version: 0, data: [] };
    }

    // 验证每条历史记录
    const validHistory = stored.data.filter((h): h is HistoryEntry => {
      return (
        h &&
        typeof h === 'object' &&
        typeof h.url === 'string' &&
        typeof h.title === 'string' &&
        typeof h.visitedAt === 'number' &&
        sanitizeUrl(h.url).valid
      );
    });

    return {
      version: normalizedVersion(stored.version),
      data: validHistory.slice(0, LIMITS.HISTORY_MAX_COUNT),
    };
  } catch (error) {
    logger.error('Failed to load history', error);
    return { version: 0, data: [] };
  }
}

/** 保存历史记录存储 */
function saveHistoryStore(history: HistoryEntry[], expectedVersion: number): boolean {
  try {
    const current = readStoreValue<HistoryStore>(HISTORY_KEY, { version: 0, data: [] });
    
    if (normalizedVersion(current.version) !== expectedVersion) {
      logger.warn(`History version mismatch: expected ${expectedVersion}, got ${current.version}`);
      return false;
    }

    const newStore: HistoryStore = {
      version: expectedVersion + 1,
      data: history.slice(0, LIMITS.HISTORY_MAX_COUNT),
    };

    writeStoreValue(HISTORY_KEY, newStore);
    return true;
  } catch (error) {
    logger.error('Failed to save history', error);
    return false;
  }
}

/** 加载历史记录 (公共接口) */
export function loadHistory(): HistoryEntry[] {
  return loadHistoryStore().data;
}

/** 添加历史记录 (性能优化 + 隐私模式) */
export function addToHistory(url: string, title?: string, privateMode = false): void {
  // 隐私模式不记录
  if (privateMode) {
    logger.debug('Private mode: history not recorded');
    return;
  }

  // 验证 URL
  const urlResult = sanitizeUrl(url);
  if (!urlResult.valid || !urlResult.sanitized) {
    logger.error(`Invalid URL for history: ${url}`, urlResult.error);
    return;
  }

  // 验证标题
  const titleText = title || extractTitle(urlResult.sanitized);
  const titleResult = validateTitle(titleText);

  let retries = 3;
  while (retries > 0) {
    const store = loadHistoryStore();
    const { version, data: history } = store;

    // 使用 Map 提升性能 (O(1) 查找)
    const historyMap = new Map(history.map(h => [h.url, h]));
    
    // 删除旧记录
    historyMap.delete(urlResult.sanitized);
    
    // 添加新记录
    historyMap.set(urlResult.sanitized, {
      url: urlResult.sanitized,
      // REQ-A404: 用 `validateTitle` 给的**清洗值**，而不是在它判 `valid:false` 时回落到
      // 原始标题 —— 那条回落路径会把超长/带 `<>` 的标题原样写进历史（实测落盘 220+ 字符
      // 含 `<img src=x onerror=…>`）。`sanitized` 现在任何情况都有值。
      title: titleResult.sanitized ?? titleText,
      favicon: getFaviconUrl(urlResult.sanitized),
      visitedAt: Date.now(),
    });

    // 转回数组，保持最新的在前
    const updated = Array.from(historyMap.values())
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, LIMITS.HISTORY_MAX_COUNT);

    if (saveHistoryStore(updated, version)) {
      logger.debug(`History recorded: ${titleText}`);
      return;
    }

    retries--;
  }

  logger.error(`Failed to add history after retries: ${url}`);
}

/** 清除历史记录 */
export function clearHistory(): void {
  try {
    writeStoreValue(HISTORY_KEY, { version: 0, data: [] });
    logger.info('History cleared');
  } catch (error) {
    logger.error('Failed to clear history', error);
  }
}

/**
 * 搜索历史记录 (防抖建议配合使用)。
 *
 * 「没有查询」= 去掉首尾空白后为空 ⇒ 给最近的 20 条。原实现里守卫写的是
 * `if (!query || …) return []`，于是**空串**直接回空，而下面那支 `if (!q) …`
 * 只有**纯空白**（`"   "`）可达 —— 同一件事的两条路径给出不同答案，而那支代码
 * 看上去像是在承诺"空查询给最近记录"。现在按"trim 后再判空"统一到一支。
 * （唯一调用方 `WebManApp` 自己在 `query` 为空时给最近 20 条，故这不是行为扩张。）
 * 非字符串入参仍回空数组：那是"没给查询"，不是"查询为空"。
 */
export function searchHistory(query: string): HistoryEntry[] {
  if (typeof query !== 'string') {
    return [];
  }

  const history = loadHistory();
  const q = query.toLowerCase().trim();

  if (!q) return history.slice(0, 20);

  return history.filter(
    (h) =>
      h.url.toLowerCase().includes(q) ||
      h.title.toLowerCase().includes(q),
  ).slice(0, 20);
}

// ==================== 下载管理 ====================

/** 下载存储结构 */
interface DownloadStore {
  version: number;
  data: Download[];
}

/**
 * 下载状态是**存储契约**的一部分：`loadDownloadStore` 按它过滤，所以写侧也必须按它
 * 校验（REQ-A405）。原来两边各抄了一份四值列表，而写侧（`updateDownload`）根本不校验：
 * 一个协议外的 status 会**顺利落盘**，然后在下一次加载时被读侧丢掉 —— 用户看到"进度更新
 * 成功"，再打开时**整行消失**（静默的数据丢失）。现在列表只有一处。
 */
const DOWNLOAD_STATUSES: readonly Download["status"][] = [
  "pending",
  "downloading",
  "completed",
  "failed",
];

/** 加载下载存储 */
function loadDownloadStore(): DownloadStore {
  try {
    const stored = readStoreValue<DownloadStore>(DOWNLOADS_KEY, { version: 0, data: [] });
    
    if (!stored || typeof stored !== 'object' || !Array.isArray(stored.data)) {
      return { version: 0, data: [] };
    }

    // 验证每个下载项
    const validDownloads = stored.data.filter((d): d is Download => {
      return (
        d &&
        typeof d === 'object' &&
        typeof d.id === 'string' &&
        typeof d.url === 'string' &&
        typeof d.filename === 'string' &&
        typeof d.progress === 'number' &&
        Number.isFinite(d.progress) &&
        typeof d.status === 'string' &&
        typeof d.createdAt === 'number' &&
        DOWNLOAD_STATUSES.includes(d.status as Download["status"]) &&
        d.progress >= 0 &&
        d.progress <= 100
      );
    });

    return {
      version: normalizedVersion(stored.version),
      data: validDownloads.slice(0, LIMITS.DOWNLOAD_MAX_COUNT),
    };
  } catch (error) {
    logger.error('Failed to load downloads', error);
    return { version: 0, data: [] };
  }
}

/** 保存下载存储 */
function saveDownloadStore(downloads: Download[], expectedVersion: number): boolean {
  try {
    const current = readStoreValue<DownloadStore>(DOWNLOADS_KEY, { version: 0, data: [] });
    
    if (normalizedVersion(current.version) !== expectedVersion) {
      return false;
    }

    const newStore: DownloadStore = {
      version: expectedVersion + 1,
      data: downloads.slice(0, LIMITS.DOWNLOAD_MAX_COUNT),
    };

    // 下载列表同样是用户内容：被拒的写入必须回报，而不是假装已保存。
    if (!writeStoreValueChecked(DOWNLOADS_KEY, newStore)) {
      logger.error('Failed to save downloads (the store rejected the write)');
      return false;
    }
    return true;
  } catch (error) {
    logger.error('Failed to save downloads', error);
    return false;
  }
}

/** 加载下载列表 */
export function loadDownloads(): Download[] {
  return loadDownloadStore().data;
}

/** 添加下载任务 */
export function addDownload(url: string, filename?: string): Download | null {
  const urlResult = sanitizeUrl(url);
  if (!urlResult.valid || !urlResult.sanitized) {
    logger.error(`Invalid URL for download: ${url}`);
    return null;
  }

  let fname = filename || urlResult.sanitized.split("/").pop() || "download";
  
  // 验证文件名
  if (fname.length > LIMITS.FILENAME_MAX_LENGTH) {
    fname = fname.slice(0, LIMITS.FILENAME_MAX_LENGTH);
  }
  fname = fname.replace(/[<>:"/\\|?*]/g, '_'); // 移除非法字符

  let retries = 3;
  while (retries > 0) {
    const store = loadDownloadStore();
    const { version, data: downloads } = store;

    if (downloads.length >= LIMITS.DOWNLOAD_MAX_COUNT) {
      logger.warn(`Download limit reached: ${LIMITS.DOWNLOAD_MAX_COUNT}`);
      return null;
    }

    const download: Download = {
      id: generateId(),
      url: urlResult.sanitized,
      filename: fname,
      progress: 0,
      status: "pending",
      createdAt: Date.now(),
    };

    downloads.unshift(download);

    if (saveDownloadStore(downloads, version)) {
      logger.info(`Download added: ${fname}`);
      return download;
    }

    retries--;
  }

  logger.error(`Failed to add download after retries: ${url}`);
  return null;
}

/** 更新下载进度 */
export function updateDownload(id: string, progress: number, status?: Download["status"]): boolean {
  if (!id || typeof id !== 'string') {
    logger.error('Invalid download ID');
    return false;
  }

  // REQ-A405: `NaN` 是 `typeof === 'number'` 且**所有比较都为 false**，所以原来
  // `NaN < 0` / `NaN > 100` 都放行 ⇒ `NaN` 进度被写进 store，而读侧的
  // `d.progress >= 0 && d.progress <= 100` 又必然为 false ⇒ 下次加载**整行消失**。
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100) {
    logger.error(`Invalid progress value: ${progress}`);
    return false;
  }

  // 同上：协议外的 status 写进去就是一条读不回来的行（读侧按 DOWNLOAD_STATUSES 过滤）。
  if (status !== undefined && !DOWNLOAD_STATUSES.includes(status)) {
    logger.error(`Invalid download status: ${status}`);
    return false;
  }

  let retries = 3;
  while (retries > 0) {
    const store = loadDownloadStore();
    const { version, data: downloads } = store;

    const download = downloads.find((d) => d.id === id);
    if (!download) {
      logger.warn(`Download not found: ${id}`);
      return false;
    }

    download.progress = Math.min(100, Math.max(0, progress));
    if (status) download.status = status;

    if (saveDownloadStore(downloads, version)) {
      logger.debug(`Download updated: ${id} - ${progress}%`);
      return true;
    }

    retries--;
  }

  logger.error(`Failed to update download after retries: ${id}`);
  return false;
}

/** 移除下载记录 */
export function removeDownload(id: string): boolean {
  if (!id || typeof id !== 'string') {
    return false;
  }

  let retries = 3;
  while (retries > 0) {
    const store = loadDownloadStore();
    const { version, data: downloads } = store;

    const index = downloads.findIndex((d) => d.id === id);
    if (index === -1) {
      return false;
    }

    downloads.splice(index, 1);

    if (saveDownloadStore(downloads, version)) {
      logger.info(`Download removed: ${id}`);
      return true;
    }

    retries--;
  }

  return false;
}

/** 清除已完成下载 */
export function clearCompletedDownloads(): void {
  let retries = 3;
  while (retries > 0) {
    const store = loadDownloadStore();
    const { version, data: downloads } = store;

    const filtered = downloads.filter((d) => d.status !== "completed");

    if (saveDownloadStore(filtered, version)) {
      logger.info('Completed downloads cleared');
      return;
    }

    retries--;
  }

  logger.error('Failed to clear completed downloads');
}

// ==================== 设置管理 ====================

/** 加载设置 */
export function loadSettings(): WebManSettings {
  try {
    const stored = readStoreValue<Partial<WebManSettings>>(SETTINGS_KEY, {});
    
    if (!stored || typeof stored !== 'object') {
      // 返回**副本**，不是 `DEFAULT_SETTINGS` 本身：那是一个导出常量，把它直接交出去
      // 等于把模块状态借给调用方 —— 谁改一下 `settings.safeSearch`，之后**每一次**
      // `loadSettings()` 都会"读到"那个改动，而它从未落盘（设置"看起来被保存了"）。
      return { ...DEFAULT_SETTINGS };
    }

    // 合并默认设置
    return {
      searchEngine: ['google', 'bing', 'baidu', 'duckduckgo'].includes(stored.searchEngine as string)
        ? (stored.searchEngine as WebManSettings['searchEngine'])
        : DEFAULT_SETTINGS.searchEngine,
      homepage: typeof stored.homepage === 'string' ? stored.homepage : DEFAULT_SETTINGS.homepage,
      privateMode: typeof stored.privateMode === 'boolean' ? stored.privateMode : DEFAULT_SETTINGS.privateMode,
      blockPopups: typeof stored.blockPopups === 'boolean' ? stored.blockPopups : DEFAULT_SETTINGS.blockPopups,
      javaScriptEnabled: typeof stored.javaScriptEnabled === 'boolean' ? stored.javaScriptEnabled : DEFAULT_SETTINGS.javaScriptEnabled,
      safeSearch: typeof stored.safeSearch === 'boolean' ? stored.safeSearch : DEFAULT_SETTINGS.safeSearch,
    };
  } catch (error) {
    logger.error('Failed to load settings', error);
    // 同上：catch 分支也必须给副本，否则一次读失败就把模块常量泄给调用方。
    return { ...DEFAULT_SETTINGS };
  }
}

/** 保存设置 */
export function saveSettings(settings: Partial<WebManSettings>): void {
  try {
    const current = loadSettings();
    const updated = { ...current, ...settings };
    writeStoreValue(SETTINGS_KEY, updated);
    logger.info('Settings saved');
  } catch (error) {
    logger.error('Failed to save settings', error);
  }
}

// ==================== 标签页管理 ====================

/** 标签页存储结构 */
interface TabStore {
  version: number;
  data: Tab[];
}

/** 加载标签页存储 */
function loadTabStore(): TabStore {
  try {
    const stored = readStoreValue<TabStore>(TABS_KEY, { version: 0, data: [] });
    
    if (!stored || typeof stored !== 'object' || !Array.isArray(stored.data)) {
      // REQ-A405: 这条早退**绕过了**下面的"至少一个标签"不变量（它与 catch 分支的
      // `{ version: 0, data: [createTab()] }` 是同一条契约）。原来它回 `data: []` ⇒ 一条
      // **形状**不对的 store（旧版本 / 导入器 / 手工编辑）让浏览器打开时**零标签** ——
      // 而同一个文件里 `closeTab` 关掉最后一个标签都会补一个。同一个"坏 store"的两种
      // 形状给出两种行为，其中一种违反自己的不变量。
      return { version: 0, data: [createTab()] };
    }

    const validTabs = stored.data.filter((t): t is Tab => {
      return (
        t &&
        typeof t === 'object' &&
        typeof t.id === 'string' &&
        typeof t.url === 'string' &&
        typeof t.title === 'string' &&
        typeof t.loading === 'boolean' &&
        typeof t.scrollY === 'number' &&
        typeof t.pinned === 'boolean' &&
        (t.url === '' || sanitizeUrl(t.url).valid)
      );
    });

    // 确保至少有一个标签
    if (validTabs.length === 0) {
      validTabs.push(createTab());
    }

    return {
      version: normalizedVersion(stored.version),
      data: validTabs.slice(0, LIMITS.TAB_MAX_COUNT),
    };
  } catch (error) {
    logger.error('Failed to load tabs', error);
    return { version: 0, data: [createTab()] };
  }
}

/** 保存标签页存储 */
function saveTabStore(tabs: Tab[], expectedVersion: number): boolean {
  try {
    const current = readStoreValue<TabStore>(TABS_KEY, { version: 0, data: [] });
    
    if (normalizedVersion(current.version) !== expectedVersion) {
      return false;
    }

    // 确保至少有一个标签
    const safeTabs = tabs.length > 0 ? tabs : [createTab()];

    const newStore: TabStore = {
      version: expectedVersion + 1,
      data: safeTabs.slice(0, LIMITS.TAB_MAX_COUNT),
    };

    writeStoreValue(TABS_KEY, newStore);
    return true;
  } catch (error) {
    logger.error('Failed to save tabs', error);
    return false;
  }
}

/** 加载标签页 (公共接口) */
export function loadTabs(): Tab[] {
  return loadTabStore().data;
}

/** 保存标签页 (公共接口) */
export function saveTabs(tabs: Tab[]): void {
  let retries = 3;
  while (retries > 0) {
    const store = loadTabStore();
    if (saveTabStore(tabs, store.version)) {
      return;
    }
    retries--;
  }
  logger.error('Failed to save tabs after retries');
}

/** 创建新标签 */
export function createTab(url = "", pinned = false): Tab {
  let safeUrl = "";
  if (url) {
    const result = sanitizeUrl(url);
    safeUrl = result.valid && result.sanitized ? result.sanitized : "";
  }

  return {
    id: generateId(),
    url: safeUrl,
    title: safeUrl ? extractTitle(safeUrl) : "新标签页",
    favicon: safeUrl ? getFaviconUrl(safeUrl) : "",
    loading: false,
    scrollY: 0,
    pinned,
  };
}

/** 关闭标签 */
export function closeTab(tabs: Tab[], tabId: string): Tab[] {
  if (!tabId || typeof tabId !== 'string') {
    logger.error('Invalid tab ID');
    return tabs;
  }

  const index = tabs.findIndex((t) => t.id === tabId);
  if (index === -1) {
    logger.warn(`Tab not found: ${tabId}`);
    return tabs;
  }

  const newTabs = [...tabs];
  newTabs.splice(index, 1);

  // 确保至少有一个标签
  if (newTabs.length === 0) {
    newTabs.push(createTab());
    logger.info('Last tab closed, created new tab');
  }

  return newTabs;
}

// ==================== 工具函数 ====================

/** 格式化时间戳 */
export function formatTime(timestamp: number): string {
  try {
    if (typeof timestamp !== 'number' || timestamp < 0 || !isFinite(timestamp)) {
      return '未知时间';
    }

    const date = new Date(timestamp);
    
    // 检查日期是否有效
    if (isNaN(date.getTime())) {
      return '未知时间';
    }
    
    const now = new Date();
    const diff = now.getTime() - timestamp;

    // 今天
    if (diff < 86400000 && date.getDate() === now.getDate()) {
      return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }

    // 昨天
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return "昨天";
    }

    // 一周内
    if (diff < 604800000) {
      const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      return weekdays[date.getDay()] ?? "未知";
    }

    // 更早
    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  } catch (error) {
    logger.error('Failed to format time', error);
    return '未知时间';
  }
}

/** 格式化文件大小 */
export function formatFileSize(bytes: number): string {
  try {
    if (typeof bytes !== 'number' || bytes < 0 || !isFinite(bytes)) {
      return '0 B';
    }

    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  } catch (error) {
    logger.error('Failed to format file size', error);
    return '0 B';
  }
}