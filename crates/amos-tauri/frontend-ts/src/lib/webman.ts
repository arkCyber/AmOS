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
// REQ-A1329 / REQ-A1330 / REQ-A1331：本模块**每一处**落盘现在都走 `writeStoreValueChecked`
// —— 写盘裁决一律上抛（四个 `save*Store` + `clearHistory` + `saveSettings`），没有一个
// 「写失败也 return true」的写者。`writeStoreValue`（吞掉拒绝的那个）在本文件里已无调用者，
// 所以不再从这里导入。
import { readStoreValue, writeStoreValueChecked } from "./amosStore";
import { localId } from "./localId";
import { intlTag, type Locale } from "../i18n/types";
// The download status vocabulary has **one** declaration (`webmanDownloads.ts::STATUSES`,
// which `vocabMirror.test.ts` binds to the Rust `DownloadStatus` enum). The store's read
// filter and `Download.status` are derived from it rather than re-typed (REQ-A405).
import { STATUSES as DOWNLOAD_STATUSES, type DownloadStatus } from "./webmanDownloads";

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
  /**
   * 「最近关闭的标签页」可撤销的条数上限（REQ-A496）。
   *
   * `⌘⇧T` 可以被反复按，所以这个栈必须是**有界**的；无界的撤销栈就是一条只涨不落的内存。
   * 25 与 Chromium 的会话级撤销深度同量级，且远小于 `TAB_MAX_COUNT`。
   */
  CLOSED_TAB_MAX_COUNT: 25,
  /**
   * 每个标签页的导航历史深度上限（← / → 那条栈）。
   *
   * 与 `HISTORY_MAX_COUNT`（落盘的"访问历史"）是两件事：这一条只活在**会话内存**里、
   * 每个标签页一份。有界的理由同 `CLOSED_TAB_MAX_COUNT` —— 一条只涨不落的栈就是内存泄漏。
   */
  NAV_HISTORY_MAX_COUNT: 50,
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
  /**
   * 这一行显示的**文件名**。`addDownload` 存进来的是**我们提议的**那一个
   * （`downloadCurrentPage` 给的是 `activeTab.title || url`）；宿主真正写盘时名字会被改两次
   * —— `sanitize_filename`，以及目的地自己（重名时 `MediaStoreSink` ∕ `pick_path` 追加
   * ` (1)`）。完成事件把**它采用的那个**报回来，由 `updateDownload` 的第五个参数覆盖到这里，
   * 免得界面上挂着一个**设备上不存在**的名字（REQ-A1370；宿主那一侧的话在
   * `webman_download.rs::place` 的注释里）。
   */
  filename: string;
  /**
   * 这一行的完成百分比（0–100），或 **`null`：这颗响应没带 `Content-Length`，所以百分比
   * *说不出来*。宿主在分块传输（chunked）上如实报 `total: null`
   * （`webman_download.rs::run_job` 逐字 `response.header("Content-Length").and_then(...)`，
   * 缺席即 `None`），折成百分比无从谈起。把 `null` 折成 `0` 会在进度条与标签上印出「0%」，
   * 而**同一张卡**下面的字节行（`WebManApp.svelte` 的 `bytes.total ? … : ""`）此刻正**不**印
   * 总数 —— 同一个事件，一个面如实保留未知、一个面把它说成测量值（REQ-A1613 / F-SH-822）。
   */
  progress: number | null;
  /**
   * `canceled` is a real terminal state now that the download pipeline exists
   * (`lib/webmanDownloads.ts`): a transfer the user stopped ends here rather
   * than being coerced into `failed`. The union is `DownloadStatus`, derived
   * from the bridge's single `STATUSES` declaration, not re-typed here.
   */
  status: DownloadStatus;
  createdAt: number;
  /**
   * 宿主把文件**放到了哪里**，只在 `completed` 时才有。
   *
   * 与 `downloadBytes` ∕ `downloadErrors` 那些"只在内存"的活传输读数不同，这一条**随行落盘**：
   * 完成的文件是**留在**盘上的，重启后哪一行说的仍是真话（`webman_download.rs::place`：
   * `DirSink` 给绝对路径，`MediaStoreSink` 给 `content://` URI —— 是"它实际采用的名字"，
   * 不是我们提议的那个）。`downloading` ∕ `failed` ∕ `canceled` 报的是 `.part` 暂存路径
   * （那个文件要么还会被改名、要么已经被 `remove_file` 删掉），所以从来不写进来（REQ-A1367）。
   */
  location?: string;
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

/**
 * 每个搜索引擎「安全搜索」的查询参数 —— **一张显式的表**，而不是一串 `if / else`。
 *
 * 表存在的理由是**覆盖范围必须可读**：`WebManSettings.searchEngine` 有四个可选值，而这张表
 * 只覆盖三个。`baidu.com` **不在表里**（见 {@link SAFE_SEARCH_UNMAPPED_HOSTS}），因为百度
 * 没有一个**我们能核实的** URL 参数可以打开安全搜索 —— 第三方参数汇总里偶有提到 `safe`
 * 键，但没有任何可验证的出处。本仓的纪律是"不发布一个没有人验证过的数"
 * （同 `lib/snapZones.ts` 拒绝为边缘吸附编一个阈值），所以这里**记录**这个缺口
 * （REQ-A1314 / F-SH-587），而不是往里塞一个看起来像答案的字符串。
 *
 * 后果是明确的、也是被说出来的：**选中百度时，"安全搜索"开关没有效果**。
 * 想补的一方只需往这张表里加一行，并放开 `webman.test.ts` 里那条覆盖断言。
 *
 * 键是 **host 后缀**（走 `hostMatches` 的点分边界比较），不是"当前选中的引擎" ——
 * 用户直接在地址栏输入 `bing.com` 时同样要生效。
 */
const SAFE_SEARCH_PARAMS: ReadonlyArray<{ host: string; param: string; value: string }> = [
  { host: "google.com", param: "safe", value: "active" },
  { host: "bing.com", param: "adlt", value: "strict" },
  { host: "duckduckgo.com", param: "kp", value: "1" },
];

/**
 * UI 里可以选中、但**没有**安全搜索参数的引擎宿主（REQ-A1314）。
 *
 * 导出的理由与 `SAFE_SEARCH_PARAMS` 是私有的相反：这是一条**缺口清单**，测试要能逐字钉住它，
 * 下一个改这张表的人也就必须同时改这里 —— 少改一处，测试红。
 */
export const SAFE_SEARCH_UNMAPPED_HOSTS = ["baidu.com"] as const;

/**
 * 设置里每个可选引擎的宿主 —— `applySafeSearch` 是按**宿主**判生效的，所以「当前选中的
 * 引擎有没有安全搜索」这个问题必须先落到宿主上。表本身只覆盖三个宿主，第四行由
 * `safeSearchGapForEngine` 对着上面那张缺口清单回答（REQ-A1333）。
 */
export const SEARCH_ENGINE_HOSTS: Readonly<Record<WebManSettings["searchEngine"], string>> = {
  google: "google.com",
  bing: "bing.com",
  baidu: "baidu.com",
  duckduckgo: "duckduckgo.com",
};

/**
 * 「安全搜索」这个开关在**当前选中的引擎**上有没有效果？有效 ⇒ `null`，无效 ⇒ 那个宿主。
 *
 * 这份函数的理由是那句「后果是明确的、也是**被说出来的**」（见 `SAFE_SEARCH_PARAMS` 的注释）：
 * 那句话原先只写在代码与测试里 —— `SAFE_SEARCH_UNMAPPED_HOSTS` 一个生产读者都没有，于是设置
 * 面板里「安全搜索」亮着，而在百度上它什么都不做，**用户那边一个字都没说**（REQ-A1333）。
 *
 * 判据取自 `SAFE_SEARCH_UNMAPPED_HOSTS`（缺口清单）而不是另抄一份，所以把某一行从清单里
 * 去掉、同时往 `SAFE_SEARCH_PARAMS` 加一行，界面上的提示会自动消失。
 */
export function safeSearchGapForEngine(engine: WebManSettings["searchEngine"]): string | null {
  const host = SEARCH_ENGINE_HOSTS[engine];
  return (SAFE_SEARCH_UNMAPPED_HOSTS as readonly string[]).includes(host) ? host : null;
}

/** 安全搜索过滤器 */
export function applySafeSearch(url: string, enabled: boolean): string {
  if (!enabled) return url;

  try {
    const parsed = new URL(url);
    const match = SAFE_SEARCH_PARAMS.find((p) => hostMatches(parsed.hostname, p.host));
    // 表里没有这个宿主（例如百度）⇒ 原样返回。**不是**一个静默的 bug，而是一处被记录的
    // 覆盖缺口 —— 表与 `SAFE_SEARCH_UNMAPPED_HOSTS` 一起就是那句话的证据。
    if (!match) return url;

    parsed.searchParams.set(match.param, match.value);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 内联 iframe 的 `sandbox` 令牌串 —— 由**设置**派生，而不是写死（REQ-A600）。
 *
 * **修的是什么**：`WebManSettings` 声明了 `blockPopups`（默认 `true`，源码注释就写
 * 「阻止弹窗」）与 `javaScriptEnabled`（默认 `true`），那是两个面向用户的安全开关；
 * 而修前 `WebManApp.svelte` 的 `sandbox` 是**字面量** `"allow-scripts allow-popups allow-forms"`
 * —— 两个设置在**全 crate 里没有任何代码路径读取**（`grep` 只有定义 / 默认值 / 反序列化三处）。
 * 于是「默认阻止弹窗」是**假声明**：`allow-popups` 恒被授予；而把 `javaScriptEnabled` 关掉
 * 也不会有任何效果。这是 F-SH-046 同族的又一次现身 —— **判据住在组件模板里 ⇒ 无头测试够不着**。
 *
 * **三条规则**（对着 Chrome 的「网站设置」语义定的）：
 *  1. `allow-forms` **恒有**：表单是网页的基本面，Chrome 也不把它放进可关的开关里。
 *  2. `allow-scripts` **当且仅当** `javaScriptEnabled`（关掉 = 脚本不执行，同 Chrome 的
 *     "JavaScript → 不允许"）。
 *  3. `allow-popups` **当且仅当不阻止弹窗**（`blockPopups === false`）—— 默认 `true`
 *     ⇒ 默认**不**授予 `allow-popups`，用户页面的 `window.open` / `target=_blank` 被沙箱挡下
 *     （同 Chrome 的"弹出式窗口和重定向 → 已屏蔽"）。
 *  4. **永不**包含 `allow-same-origin`：那条由 `webman-iframe-posture` 测试钉住 ——
 *     这个帧必须运行在不透明来源上。
 *
 * 令牌顺序固定（`allow-scripts` → `allow-popups` → `allow-forms`），输出可被逐字节断言。
 */
export function iframeSandbox(settings: WebManSettings): string {
  const tokens: string[] = [];
  if (settings.javaScriptEnabled) tokens.push("allow-scripts");
  if (!settings.blockPopups) tokens.push("allow-popups");
  tokens.push("allow-forms");
  return tokens.join(" ");
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
 * 永远 `undefined !== 0`，**每一次写都失败**、重试 3 次后放弃；`addToHistory` 当时签 void
 * ⇒ 用户看不到任何提示（REQ-A1357 已让它回报裁决，并把「拒写」说给历史面板）。四处 store
 * （书签/历史/下载/标签）同形。归一化不会掩盖真正的并发写：写者一律写数字 version。
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

/**
 * 这条书签是不是 `url` 那条？（REQ-A1347 / FMEA F-SH-612）
 *
 * `isBookmarked` 判的是**规范化后**的 URL（`sanitizeUrl(url).sanitized`），而存储里的
 * `b.url` 是写入时那一份 —— `loadTabStore` 只校验存下来的标签页 URL 合法，**不**改写它
 * （`旧版本 / 导入器 / 手工编辑` 写进来的、以及宿主镜像 hydrate 回来的都可能带大写 scheme
 * 或空路径）。所以「判在不在」与「找那一条」必须是**同一个**谓词：收藏星原先用
 * `bookmarks.find((b) => b.url === activeTab.url)`（**原始**串）去删，两个问题于是可以
 * 给出两个答案 —— 星是实心的、点下去却找不到那一条，于是什么都不发生。
 */
export function bookmarkMatches(bookmark: Bookmark, url: string): boolean {
  return !!bookmark.url && bookmark.url === bookmarkKey(url);
}

/** 一条 URL 在书签表里的键（规范化后的形态），或 `null`（无法规范化）。 */
function bookmarkKey(url: string): string | null {
  const result = sanitizeUrl(url);
  return result.valid ? (result.sanitized ?? null) : null;
}

/** 检查 URL 是否已收藏 */
export function isBookmarked(url: string): boolean {
  const key = bookmarkKey(url);
  if (!key) return false;
  return loadBookmarks().some((b) => b.url === key);
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

    // 同 `saveBookmarkStore` / `saveDownloadStore`：写盘被拒必须让调用方看到。
    // 这里原先是无条件 `return true`，于是 `addToHistory` 的 3 次重试循环在第 1 次
    // 之后就被这个假成功短路掉 —— 一次**瞬时**拒写（配额刚好满、桥抖了一下）就永久
    // 丢掉那条历史，而下一句 `logger.debug("History recorded")` 还在说它记下了（REQ-A1329）。
    if (!writeStoreValueChecked(HISTORY_KEY, newStore)) {
      logger.error('Failed to save history (the store rejected the write)');
      return false;
    }
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

/**
 * 添加历史记录 (性能优化 + 隐私模式)，并**回报这一条访问有没有落进存储**。
 *
 * 原先签成 `void`：`saveHistoryStore` 早就问过存储才作答（REQ-A1329 修的就是它被一个无条件
 * `return true` 短路掉的那件事），可这个写者把裁决一扔了之，失败时只剩一句 `logger.error`。
 * 于是「存储拒写（满 ∕ 不可用）」与「记下了」在屏幕上**完全一样**：用户导航过去、历史面板里
 * 却没有这一条，没有任何一个字解释它为什么不在 —— 而这是本文件最后一个签 `void` 的写者
 * （REQ-A1357 / FMEA F-SH-621；同族的 `clearHistory` ∕ `addBookmark` ∕ `saveTabs` 都已回报）。
 *
 * 返回 `false` 的两种来路**不是同一件事**，读裁决的调用方要分得开：
 *  - **隐私模式**有意**不**记（本文件不写盘，也不应该写）—— 那是用户要的，不是缺陷；
 *  - **存储拒写**（3 次重试后放弃）—— 这一条访问真的没进历史。
 *
 * 布尔只承载一个事实：**这条访问此刻在不在历史里**。调用方（`WebManApp.loadUrl`）自己手里就
 * 有 `settings.privateMode`，由它决定要不要把「不在」当成一次失败说出口 —— 不在这里造一个
 * 「为什么不在」的枚举（没有读者的裁决不必造出来）。
 */
export function addToHistory(url: string, title?: string, privateMode = false): boolean {
  // 隐私模式不记录
  if (privateMode) {
    logger.debug('Private mode: history not recorded');
    return false;
  }

  // 验证 URL
  const urlResult = sanitizeUrl(url);
  if (!urlResult.valid || !urlResult.sanitized) {
    logger.error(`Invalid URL for history: ${url}`, urlResult.error);
    return false;
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
      return true;
    }

    retries--;
  }

  logger.error(`Failed to add history after retries: ${url}`);
  return false;
}

/**
 * 清除历史记录，并**回报这次清除有没有落地**。
 *
 * 原先签成 `void`：`writeStoreValue` 把拒绝吞掉，调用方无从知道清没清掉。面板那颗
 * 「清空历史」既不播报成功也不播报失败 —— 存储拒了就一行不少地留在屏幕上，看上去
 * 像按了个空的按钮。兄弟 `clearCompletedDownloads(): boolean` 早就问过存储才作答
 * （REQ-A1068 修的就是同一件事）、`onClearCompleted` 两向都说话；这一侧漏了（REQ-A1330）。
 */
export function clearHistory(): boolean {
  try {
    if (!writeStoreValueChecked(HISTORY_KEY, { version: 0, data: [] })) {
      logger.error('Failed to clear history (the store rejected the write)');
      return false;
    }
    logger.info('History cleared');
    return true;
  } catch (error) {
    logger.error('Failed to clear history', error);
    return false;
  }
}

/**
 * 列出历史记录 —— 空查询给**整段历史**，否则给**全部命中**（防抖建议配合使用）。
 *
 * 「没有查询」= 去掉首尾空白后为空。原实现里守卫写的是
 * `if (!query || …) return []`，于是**空串**直接回空，而下面那支 `if (!q) …`
 * 只有**纯空白**（`"   "`）可达 —— 同一件事的两条路径给出不同答案，而那支代码
 * 看上去像是在承诺"空查询给最近记录"。现在按"trim 后再判空"统一到一支。
 * （唯一调用方 `WebManApp` 的防抖就传原样的 `historyQuery` 进来。）
 * 非字符串入参仍回空数组：那是"没给查询"，不是"查询为空"。
 *
 * 两支都**不再截到 20 条**（REQ-A1292）。那个 20 是"侧栏不会滚"时期的产物：面板把
 * 它画在标题「历史记录」下、上方就是清空**全部**历史的那颗按钮，于是用户数到 20 行
 * 就以为那是全部。REQ-A1291 已把面板体做成滚动容器（`min-h-0 flex-1 overflow-y-auto`），
 * 布局那半个理由没有了 —— 列表长度由数据源自己决定（同 REQ-A1290）。存储本身有上限
 * （`LIMITS.HISTORY_MAX_COUNT`），所以这不是无界渲染。
 */
export function searchHistory(query: string): HistoryEntry[] {
  if (typeof query !== 'string') {
    return [];
  }

  const history = loadHistory();
  const q = query.toLowerCase().trim();

  if (!q) return history;

  return history.filter(
    (h) =>
      h.url.toLowerCase().includes(q) ||
      h.title.toLowerCase().includes(q),
  );
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
 * 成功"，再打开时**整行消失**（静默的数据丢失）。
 *
 * REQ-A659: 那次修复只让 `webman.ts` **文件内**只剩一处，而同一份词汇在
 * `lib/webmanDownloads.ts` 里还有一份（`STATUSES`，且它是**被 `vocabMirror.test.ts` 绑到
 * Rust `DownloadStatus` 的那一份**）。于是本文件的副本既不绑定权威、又与它可能各自漂移：
 * Rust 新增一个状态、开发者把它加进 `STATUSES`（否则 `vocabMirror` 红）却漏了本文件 ——
 * 读侧过滤会**静默丢掉**这个新状态的行，正是 REQ-A405 修的那类数据丢失，又以一种更隐蔽的
 * 方式回来。现在本文件不再自己声明，直接引用桥的那**一份**（`STATUSES`）。
 */

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
        // `null` 是**合法**的进度：它表示「这颗响应没有总长，百分比说不出来」（REQ-A1613）。
        // 把它当非法丢掉，会让一条正在下载（总量未知）的行在下次加载时**整行消失** —— 正是
        // `updateDownload` 里那条 `NaN` 注释警告的形状，只是换成了另一个"合法的未知"。
        (d.progress === null ||
          (typeof d.progress === 'number' &&
            Number.isFinite(d.progress) &&
            d.progress >= 0 &&
            d.progress <= 100)) &&
        typeof d.status === 'string' &&
        typeof d.createdAt === 'number' &&
        DOWNLOAD_STATUSES.includes(d.status as Download["status"])
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

/**
 * 更新下载进度。
 *
 * `location` 只在**文件真的落到了那里**时给（宿主完成事件的那一支，REQ-A1367）：其余各支报的
 * 是 `.part` 暂存路径，写进行里就是替一个不存在的文件背书。
 *
 * `filename` 同理，而且**只有完成那一支**是权威（REQ-A1370）：`run_job` 的 `emit` 只在该支
 * 传 `placed.filename`，其余各支传 `None` ⇒ 报回来的是 `run_job` 收到的那份**提议名**。而
 * 名字在写盘路上会被改 —— `sanitize_filename`，以及重名时目的地自己追加 ` (1)`。所以完成
 * 之前行里留着提议名是诚实的（那个名字此刻还不是它有的），完成之后必须换成采用名，否则行上
 * 挂着一个**设备上不存在**的名字。
 */
export function updateDownload(
  id: string,
  progress: number | null,
  status?: Download["status"],
  location?: string,
  filename?: string,
): boolean {
  if (!id || typeof id !== 'string') {
    logger.error('Invalid download ID');
    return false;
  }

  // REQ-A405: `NaN` 是 `typeof === 'number'` 且**所有比较都为 false**，所以原来
  // `NaN < 0` / `NaN > 100` 都放行 ⇒ `NaN` 进度被写进 store，而读侧的
  // `d.progress >= 0 && d.progress <= 100` 又必然为 false ⇒ 下次加载**整行消失**。
  //
  // `null` 不是非法值 —— 它是「这颗响应没有总长，百分比说不出来」的**如实**表示
  // （REQ-A1613 / F-SH-822），读侧同样放行它（否则会写进一条读不回来的行）。只有
  // **非 `null` 的**非法数字才拒绝。
  if (
    progress !== null &&
    (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100)
  ) {
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

    // `null` 原样存下（未知保持未知）；只有真数字才夹进 0–100。
    download.progress = progress === null ? null : Math.min(100, Math.max(0, progress));
    if (status) download.status = status;
    // 桥已经校验过它是字符串（`asProgressEvent`），这里只是别让一个非字符串从别的调用点混进来。
    if (typeof location === "string") download.location = location;
    // 同上（`asProgressEvent` 见 `filename` 非字符串就丢掉整条事件）。
    if (typeof filename === "string") download.filename = filename;

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

/** 进度事件带来的**实时**字节计数（`WebManApp` 的 `downloadBytes` 就是一张 id → 这个）。 */
export interface DownloadByteCount {
  received: number;
  total: number | null;
}

/**
 * 从字节计数表里剪掉一批下载 id —— **单一所有者**。
 *
 * 两个入口共用同一份账：`removeDownloadEntry`（删一行）与 `onClearCompleted`（一次清掉一批）。
 * 修前只有前者剪，后者留下了一批**永远不再被读**的条目（`downloadBytes` 按 id 建，行没了 id 也不会复用）
 * —— 「清除已完成」每点一次就在内存里多沉淀一批死计数。
 */
export function pruneDownloadBytes(
  bytes: Record<string, DownloadByteCount>,
  ids: readonly string[],
): Record<string, DownloadByteCount> {
  return pruneById(bytes, ids);
}

/**
 * 从任意一张「下载 id → 值」的表里剪掉一批 id。
 *
 * 这张表按 id 建、行没了 id 也不会复用，所以**每一张这样的表**都要在删行 / 清除时剪同一批 id
 * —— `downloadBytes` 与失败原因表（`WebManApp` 的 `downloadErrors`）是同一份账的两个字段，
 * 各有自己的生命周期（失败原因在该 id 重试 / 完成 / 取消时也要清），故共用这一条。
 */
export function pruneById<T>(
  map: Record<string, T>,
  ids: readonly string[],
): Record<string, T> {
  const rest = { ...map };
  for (const id of ids) delete rest[id];
  return rest;
}

/**
 * 清除已完成下载，返回**存储是否收下了这次写入**。
 *
 * 与 `removeDownload` / `updateDownload` 走同一条判定链（`saveDownloadStore` →
 * `writeStoreValueChecked`）：版本冲突 / 存储拒写 / 抛错都会耗尽重试后回 `false`。原先这里是
 * `void`，调用方**无从知道**清没清掉 —— 无论存储收没收都播报「已清除」，屏幕一行没少却说着
 * 清完了。
 *
 * 只清 `completed`：`failed` / `canceled` 行各自带着「重试」按钮，是**可恢复**的状态，不是
 * 垃圾；把它们当作没发生过才是丢用户的东西。
 */
export function clearCompletedDownloads(): boolean {
  let retries = 3;
  while (retries > 0) {
    const store = loadDownloadStore();
    const { version, data: downloads } = store;

    const filtered = downloads.filter((d) => d.status !== "completed");

    if (saveDownloadStore(filtered, version)) {
      logger.info('Completed downloads cleared');
      return true;
    }

    retries--;
  }

  logger.error('Failed to clear completed downloads');
  return false;
}

// 这里原来有 `addDownloadEntry` / `cancelDownload` 两个「接线」函数：它们只是把
// `addDownload` / `updateDownload` 包一层，好让下载面板的 4 个函数从
// `unwired-baseline.json` 里撤下。那两个函数**没有任何真实下载行为**——面板点了
// 「下载当前页」，字节一个都没动。现在真正的管线在 Rust（`src/webman_download.rs`），
// 前端桥在 `lib/webmanDownloads.ts`；本模块只保留**落盘的下载行**（列表 / 进度 /
// 状态），由组件同时驱动真实管线与这些行。空的语义包装就此删掉，而不是留着假装。

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

/**
 * 保存设置，并**回报这次保存有没有落地**。
 *
 * 原先签成 `void`（`writeStoreValue` 把拒绝吞掉）：调用方只能猜。设置面板的「主页」保存
 * 按钮据此播报「主页已保存」—— 而它的判据其实是**输入校验通过**，不是写盘成功；存储拒了，
 * toast 照样说存好了，重启后主页回到旧值（REQ-A1331）。
 *
 * 组件侧的**每一个**调用点都读这个裁决（REQ-A1353 / F-SH-617 补上了最后五个）：`saveHomepage`
 * 以及隐私 / 引擎 / 安全搜索 / 弹窗 / JS 五个开关都经 `commitSettings()`，拒写 ⇒ 退回内存里的
 * 原值 + 说 `webman.toast.settingsSaveFailed`。此前这里写着这五个开关「不分叉，因为它们的 UI 不
 * 作出肯定性声明 —— 它们只改本会话的 `settings`」；那条策略是可查的，而它不成立：它们调的正是
 * `saveSettings(settings)`（一次存储写入），而 `settings` 又在挂载时由 `loadSettings()` 读回
 * —— 一枚拨到 ON 的开关**就是**那句肯定性声明，只是它说的是一件只活到下一次挂载的事。
 */
export function saveSettings(settings: Partial<WebManSettings>): boolean {
  try {
    const current = loadSettings();
    const updated = { ...current, ...settings };
    if (!writeStoreValueChecked(SETTINGS_KEY, updated)) {
      logger.error('Failed to save settings (the store rejected the write)');
      return false;
    }
    logger.info('Settings saved');
    return true;
  } catch (error) {
    logger.error('Failed to save settings', error);
    return false;
  }
}

// ==================== 标签页管理 ====================

/** 标签页存储结构 */
interface TabStore {
  version: number;
  data: Tab[];
}

/**
 * 盘上回来的 `scrollY` → 一个非负有限数（REQ-A1384）。
 *
 * 输入是**不可信**的：它可能来自旧版本、导入器或手工编辑过的 store，所以类型收窄之后
 * 仍要按运行期事实判一次（`typeof` 而非断言）。口径与 `reopenClosedTab` 对
 * `ClosedTab.scrollY` 的那一次归一化逐字相同 —— 滚动位置不可能是负数 ∕ NaN ∕ 无穷。
 */
function normalizeTabScrollY(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
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
        // REQ-A1384: 这里此前还要求 `typeof t.scrollY === 'number'` —— 而 `scrollY` 是本文件
        // 里**唯一一个读者为零**的必填字段（写侧唯一的写者 `createTab` 恒写 0，`src/svelte/**`
        // 里一处都没读过它、也没有 `scrollTo`），代价却是**丢掉整行标签页**：URL、标题、
        // 固定状态一起没。缺字段的行与 REQ-A405 那条注释点名的三种来源同形（旧版本 ∕
        // 导入器 ∕ 手工编辑），每一行都缺这一位时整个会话只剩一张空白页。一条必填清单里
        // 唯一没有读者的那一项不该承重 —— 值改在下面 `.map()` 里归一（那里早就归一化了
        // `title` 与 `loading`）。真正被画出来的 `favicon` 一直不在清单里，是同一条道理的
        // 正面对照：**必填集合 == 渲染 ∕ 安全真正需要的集合**。
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
      data: validTabs.slice(0, LIMITS.TAB_MAX_COUNT).map((t) => ({
        ...t,
        // REQ-A405: 无 URL 的标签不该带标题 —— 旧版本把 `"新标签页"` 落进了盘，直接渲染就会在
        // en 界面里显示中文。清掉它，让 UI 层的 `t("webman.newTab")` 接管（不是按字面匹配那个
        // 中文串，而是"没有 URL ⇒ 没有标题"这条不变量）。
        title: t.url === "" ? "" : t.title,
        // REQ-A1384: `scrollY` 不再是准入条件（见上面过滤里的注释），所以在**同一个**归一化
        // 位置把它收成一个非负有限数。口径与 `reopenClosedTab` 对 `ClosedTab.scrollY` 的那一次
        // 逐字相同（`Number.isFinite(x) && x > 0 ? x : 0`：滚动位置不可能是负数 ∕ NaN ∕ 无穷）。
        // 与 `loading` 那条不同的是，这里**不能**一律归零 —— 一个真值必须原样留下，否则
        // 写进盘里的滚动位置会读一次就没（那正是这个字段存在的理由）。
        scrollY: normalizeTabScrollY((t as { scrollY?: unknown }).scrollY),
        // REQ-A1376: 从盘上回来的这一行**不可能**正在加载。「加载完」是由
        // `WebManApp::markLoading` 排的一枚 800ms 定时器宣布的，而那枚定时器挂在组件的生命
        // 周期上（`onDestroy` 把它们 `clearTimeout` 掉 —— 那是对的）。可一旦会话在
        // 那 800ms 窗口里结束（关掉浏览器窗口 ∕ 宿主崩溃 ∕ 断电），盘上这一行**停**在
        // `loading: true`，而新的组件里没有任何东西能再熄掉它：标签条永远转圈，地址栏左端
        // 那个字形 —— 隐私模式的**唯一**那一面 —— 被那个圈永久盖住。一个瞬时指示位不是会话
        // 状态：读侧把它归零，因为"做那次加载的东西"已经随上一个会话消失了。
        loading: false,
      })),
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

    // 同 `saveBookmarkStore` / `saveDownloadStore`：写盘被拒必须让调用方看到 —— 否则
    // `saveTabs` 的 3 次重试循环在第 1 次之后就被短路，一次瞬时拒写就让整份会话
    // （标签页、URL、滚动位置）静默停在旧内容上（REQ-A1329）。
    if (!writeStoreValueChecked(TABS_KEY, newStore)) {
      logger.error('Failed to save tabs (the store rejected the write)');
      return false;
    }
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

/**
 * 保存标签页 (公共接口)，并**回报这份会话有没有落盘**。
 *
 * 原先签成 `void`：3 次重试跑完只在 `logger.error` 里留一行，调用方一个字也收不到。
 * REQ-A1329 / F-SH-595 修的是「重试循环还能不能工作」，当时把返回值这一半如实留下，
 * 理由是「给 `saveTabs` 加返回值只会造出一个**没有读者**的裁决」。那个理由是可查的，
 * 而它已经不成立（REQ-A1350 / F-SH-613）：`WebManApp.svelte` 本来就有播报面，而且有
 * 两处**已经在说话** —— `toggleActiveTabPinned` 与 `restoreLastClosedTab` 在 `saveTabs`
 * 之后**无条件**播报「已固定此标签页」∕「已恢复关闭的标签页」。存储拒写时那两句是对一次
 * **没发生**的保存所下的断言。裁决的读者一直都在，只是读的是错的东西。
 */
export function saveTabs(tabs: Tab[]): boolean {
  let retries = 3;
  while (retries > 0) {
    const store = loadTabStore();
    if (saveTabStore(tabs, store.version)) {
      return true;
    }
    retries--;
  }
  logger.error('Failed to save tabs after retries');
  return false;
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
    // REQ-A405: 空 URL 的标签**没有**标题 —— 这里原来写死 `"新标签页"`，于是 `i18n-scan`
    // 看不见的中文从这个 lib 函数漏进 en 界面（同一个"标签条 / 内容区"上，`tab.title || t(...)`
    // 的兜底永远轮不到）。空标题让 UI 层的 `t("webman.newTab")` 生效；带 URL 的标签照旧用
    // `extractTitle`。
    title: safeUrl ? extractTitle(safeUrl) : "",
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

/**
 * 固定 / 取消固定一个标签（REQ-A1315 / F-SH-588）。
 *
 * 存在的理由是一条**单向门**：`Tab.pinned` 本来只在 `createTab(url, true)` 时被**写一次**，
 * 而 `WebManApp.removeTab` 见到 `pinned` 就 `return` —— 于是"固定标签页"这个菜单项一旦点下，
 * 用户再也无法取消固定，也无法关掉它（除非重开整个窗口）。**一个只能进不能出的开关不是开关，
 * 是一道坏掉的门。**
 *
 * 纯函数：不碰 DOM、不落盘（落盘仍由调用方 `saveTabs` 负责），因此可以直接测。
 * 找不到 id 或 `pinned` 与现状相同时原样返回（同一个数组引用），调用方据此可以判断"什么也没发生"。
 */
export function setTabPinned(tabs: Tab[], tabId: string, pinned: boolean): Tab[] {
  const index = tabs.findIndex((t) => t.id === tabId);
  if (index === -1) return tabs;
  if (tabs[index]!.pinned === pinned) return tabs;

  const newTabs = [...tabs];
  newTabs[index] = { ...newTabs[index]!, pinned };
  return newTabs;
}

// ==================== 最近关闭的标签页（⌘⇧T） ====================

/**
 * 一条「刚被关掉的标签」记录。
 *
 * **边界（有意，且必须说出来）**：撤销栈活在**会话内存**里，不落盘。理由不是省事：
 * 落盘需要一个新的 `amos.webman.*` 存储键，而每个键都要过 `store-scan` 的分类
 * （以及 `cloud.ts` 的 `SYNC_STORES` 决定它能不能同步）——那是一块**独立的面**，
 * 不该作为这条快捷键的副产品被顺手加进来。浏览器自己的语义也是会话级的：
 * 重启之后「重新打开关闭的标签页」本来就不该跨会话。
 */
export interface ClosedTab {
  url: string;
  title: string;
  pinned: boolean;
  scrollY: number;
  /** 关闭时它在标签条上的位置；恢复时尽量放回原处（越界则夹到末尾）。 */
  index: number;
}

/** 把一个**活**标签变成一条关闭记录。 */
export function closedTabFrom(tab: Tab, index: number): ClosedTab {
  return {
    url: tab.url,
    title: tab.title,
    pinned: tab.pinned,
    scrollY: tab.scrollY,
    index: Math.max(0, Math.floor(index)),
  };
}

/**
 * 记录一次关闭：**LIFO + 有界**。
 *
 * 满了从**最旧的一端**丢，最近关掉的那条永远在栈顶 —— 否则 `⌘⇧T` 会去恢复一条
 * 用户早已忘记的页面，而刚关掉的那条被挤出去。
 */
export function pushClosedTab(
  stack: ClosedTab[],
  entry: ClosedTab,
  max: number = LIMITS.CLOSED_TAB_MAX_COUNT,
): ClosedTab[] {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : LIMITS.CLOSED_TAB_MAX_COUNT;
  const next = [...stack, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** 恢复的结果类别 —— 三种「没恢复」的原因必须分得开（一句提醒说不了三件事）。 */
export type ReopenOutcome = "restored" | "empty" | "at-capacity";

export interface ReopenResult {
  /** 恢复之后的标签条（未恢复时**原样**返回）。 */
  tabs: Tab[];
  /** 恢复之后的关闭栈（未恢复时**原样**返回 —— 一次失败的尝试不消耗历史）。 */
  stack: ClosedTab[];
  /** 被恢复的那一页（未恢复时为 `null`）。 */
  tab: Tab | null;
  outcome: ReopenOutcome;
}

/**
 * 恢复最近关闭的一个标签（`⌘⇧T`）。
 *
 * 三条规则，都是对着真实浏览器行为定的：
 *  1. **重新过一遍 URL 清洗**：`createTab` 是本文件**唯一**的清洗入口，这里走它而不是
 *     直接复制字段 —— 「不要相信一个不是刚刚由自己生成的值」（这条记录虽然来自本会话，
 *     但它经过了一次组件状态往返）。清洗不过就得到一张空白标签页，而不是一条野链接。
 *  2. **空白占位页可以被顶掉**：`loadTabs` / `closeTab` 保证「至少一个标签」，所以
 *     「关掉最后一个页，再 ⌘⇧T」这个最常用的路径面对的正是一张占位空页；往它旁边追加
 *     等于让用户同时拿到被恢复的页**和**一张多余的空页。
 *  3. **到顶就不恢复、也不消耗历史**：`TAB_MAX_COUNT` 满了时栈原样留着（改小窗口再按
 *     仍然有效），而不是把这条记录吃掉。
 */
export function reopenClosedTab(tabs: Tab[], stack: ClosedTab[]): ReopenResult {
  const entry = stack.length > 0 ? stack[stack.length - 1]! : null;
  if (!entry) return { tabs, stack, tab: null, outcome: "empty" };

  const revived = createTab(entry.url, entry.pinned);
  const tab: Tab = {
    ...revived,
    title: validateTitle(entry.title || revived.title).sanitized || revived.title,
    scrollY: Number.isFinite(entry.scrollY) && entry.scrollY > 0 ? entry.scrollY : 0,
  };

  const onlyTab = tabs.length === 1 ? tabs[0]! : null;
  const placeholderOnly = onlyTab !== null && !onlyTab.pinned && onlyTab.url === "";

  if (!placeholderOnly && tabs.length >= LIMITS.TAB_MAX_COUNT) {
    return { tabs, stack, tab: null, outcome: "at-capacity" };
  }

  const rest = stack.slice(0, stack.length - 1);

  if (placeholderOnly) {
    return { tabs: [tab], stack: rest, tab, outcome: "restored" };
  }

  const at = Math.min(Math.max(0, Math.floor(entry.index)), tabs.length);
  const next = [...tabs];
  next.splice(at, 0, tab);
  return { tabs: next, stack: rest, tab, outcome: "restored" };
}

// ==================== 每个标签页的导航历史（地址栏 ← / →） ====================

/**
 * 一个标签页的**导航历史** —— 地址栏左边那两个按钮（← / →）的真源（REQ-A598）。
 *
 * 为什么是自己的一条栈，而不是 `iframe.contentWindow.history`：跨源 iframe 的
 * `history` 读不到（`contentDocument` 为 `null`），而且这个帧的 `sandbox` 不含
 * `allow-same-origin` ⇒ 它运行在**不透明来源**上，回退既不由我们驱动、也读不回来。
 * 所以这里记的是**我们派发过的那些 URL**（用户经地址栏 / 书签 / 历史 / 快速链接 /
 * 恢复关闭标签走到过的页），← / → 在它们之间移动。
 *
 * **诚实边界**：页面内部的锚点跳转与站内重定向不经过 `navigate`，因此不进这条栈；
 * 它也是**会话内存**（不落盘，同 `ClosedTab` 的理由），应用重启后从零开始。
 */
export interface NavStack {
  /** 按访问顺序排列的 URL，最旧在 `0`、当前页在 `index`。 */
  entries: string[];
  /** 当前页在 `entries` 里的下标（空栈为 `-1`）。 */
  index: number;
}

/** 空栈：新标签页 / 尚未导航过的标签。 */
export function emptyNavStack(): NavStack {
  return { entries: [], index: -1 };
}

/**
 * 记录一次导航：落在当前页之后，并丢掉"前进"那一段支路。
 *
 * 三条规则对着真实浏览器语义：
 *  1. **同一页重复不入栈**：刷新、再点一次同一链接，不该产生一条新历史条目
 *     （否则 ← 要按两次才离开当前页）。
 *  2. **新导航截断前进支路**：走过 A→B→C、回退到 B、再导航到 D ⇒ C 必须消失。
 *  3. **有界**：超过 `NAV_HISTORY_MAX_COUNT` 从**最旧**一端丢，`index` 随之平移。
 */
export function pushNavEntry(stack: NavStack, url: string): NavStack {
  if (!url) return stack; // 空白标签页不是一条历史
  // 导航到**当前页**（刷新 / 重按同一链接）：整条栈原样返回 —— 既不加条目，也不截断
  // 前进支路（否则在 A 上"刷新"一次，从 A 回退再前进的 B 就凭空没了）。
  if (stack.index >= 0 && stack.entries[stack.index] === url) return stack;
  const entries = stack.entries.slice(0, Math.max(0, stack.index + 1));
  entries.push(url);
  const overflow = entries.length - LIMITS.NAV_HISTORY_MAX_COUNT;
  if (overflow > 0) entries.splice(0, overflow);
  return { entries, index: entries.length - 1 };
}

/** 能否后退 / 前进 —— 地址栏那两个按钮的 `disabled` 就是这两个值。 */
export function canGoBackNav(stack: NavStack): boolean {
  return stack.index > 0;
}

export function canGoForwardNav(stack: NavStack): boolean {
  return stack.index >= 0 && stack.index < stack.entries.length - 1;
}

/** 后退一步：给出新的栈与要加载的 URL；已在最旧端则 `url` 为 `null` 且栈原样返回。 */
export function goBackNav(stack: NavStack): { stack: NavStack; url: string | null } {
  if (!canGoBackNav(stack)) return { stack, url: null };
  const index = stack.index - 1;
  return { stack: { entries: stack.entries, index }, url: stack.entries[index] ?? null };
}

/** 前进一步：给出新的栈与要加载的 URL；已在最新端则 `url` 为 `null` 且栈原样返回。 */
export function goForwardNav(stack: NavStack): { stack: NavStack; url: string | null } {
  if (!canGoForwardNav(stack)) return { stack, url: null };
  const index = stack.index + 1;
  return { stack: { entries: stack.entries, index }, url: stack.entries[index] ?? null };
}

// ==================== 浏览器快捷键（唯一解释器） ====================

/** 地址栏这一类**浏览器自己的**意图（与桌面壳的系统意图是两套，勿混）。 */
export type BrowserIntent =
  | "new-tab"
  | "close-tab"
  | "restore-tab"
  | "focus-address"
  | "reload"
  | "next-tab"
  | "prev-tab"
  | "tab-1"
  | "tab-2"
  | "tab-3"
  | "tab-4"
  | "tab-5"
  | "tab-6"
  | "tab-7"
  | "tab-8"
  | "tab-9";

/** `browserIntent` 只需要 `KeyboardEvent` 的这几个字段 —— 纯函数因此可以被直接测。 */
export interface ShortcutEventLike {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * 把一次按键翻译成浏览器意图 —— **唯一**一处解释 `⌘T` / `⌘W` / `⌘⇧T` / `⌘L` / `⌘R`。
 *
 * REQ-A496（审计发现）：这一段逻辑原来散在 `WebManApp.svelte` 的 `handleGlobalKeydown`
 * 里，而且 `⌘⇧T` 那一支写的是 `e.key === 't'` —— 物理键盘上 `Shift+T` 的 `e.key` 是
 * **`"T"`**（UI Events：`key` 是按住修饰键之后产生的那个字符），所以那一支在真实键盘上
 * **永远不成立**：这就是它旁边那句 `logger.info('Restore closed tab (not implemented yet)')`
 * 从来没有被执行过的原因。`e.key.length === 1` 的键一律按大小写无关比较（本文件
 * `keyboardConfig.eventToShortcut` 用 `toUpperCase()` 归一化，同一条纪律）。
 *
 * 修饰键规则与桌面壳一致：`⌘` 或 `Ctrl` 皆可，**但 `⌥` 出现时一律不认**（原来
 * `⌥⌘T` 也会新开标签页）。
 *
 * REQ-A1316 / F-SH-589（审计发现）：标签条上**没有任何键盘模型** —— 有 N 个标签却只能用鼠标点。
 * 这里补上 `⌘1`…`⌘9`（跳到第 N 个 / 第 9 个永远是最后一个）与 `⇧⌘[` / `⇧⌘]`（上一个 /
 * 下一个，循环），判据表见 {@link TAB_ORDINAL_INTENTS}。
 */
export function browserIntent(e: ShortcutEventLike): BrowserIntent | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;

  const key = String(e.key ?? "").toLowerCase();
  if (!key) return null;

  if (e.shiftKey) {
    switch (key) {
      case "t":
        return "restore-tab";
      // `Shift+[` 在 US 布局上产出 `{`，`Shift+]` 产出 `}` —— 与 REQ-A496 那个 `"T"`
      // 是同一课：**两个字形都要认**，否则真实键盘上这一支永不成立。
      case "[":
      case "{":
        return "prev-tab";
      case "]":
      case "}":
        return "next-tab";
      default:
        return null;
    }
  }

  switch (key) {
    case "t":
      return "new-tab";
    case "w":
      return "close-tab";
    case "l":
      return "focus-address";
    case "r":
      return "reload";
    default:
      return TAB_ORDINAL_INTENTS[key] ?? null;
  }
}

/**
 * 数字键 → 「跳到第 N 个标签」意图。
 *
 * 写成**一张表**而不是 `\`tab-${key}\` as BrowserIntent`：强转会把拼错的键也悄悄放行，
 * 而这张表的键集就是 `BrowserIntent` 里 `tab-*` 那一组的全部 —— 加一个意图就得加一行。
 */
const TAB_ORDINAL_INTENTS: Readonly<Record<string, BrowserIntent>> = {
  "1": "tab-1",
  "2": "tab-2",
  "3": "tab-3",
  "4": "tab-4",
  "5": "tab-5",
  "6": "tab-6",
  "7": "tab-7",
  "8": "tab-8",
  "9": "tab-9",
};

/**
 * `⌘N` 落在哪个**下标**上；`null` 表示"这个按键在这里没有意思"。
 *
 * 规则（与被广泛使用的浏览器一致，且**说得出为什么**）：
 *  - `1`…`8` 指向第 N 个标签；标签不够时**夹到最后一个**（不是"什么都不做"）——
 *    因为 `9` 的语义本来就是"最后一个"，若 `9` 夹而 `8` 不夹，同一件事就有两套答案。
 *  - `9` **永远**是最后一个（Chromium / Safari / Firefox 皆然）。
 *  - 越界的 ordinal（0、10）或空标签条 → `null`，调用方据此**不施加任何变化**。
 */
export function tabIndexForOrdinal(ordinal: number, count: number): number | null {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 9) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  const total = Math.floor(count);
  // `9` 是**最后一个**，而不是"第 9 个"：三个标签时 `⌘9` 必须去第 3 个。
  if (ordinal === 9) return total - 1;
  return Math.min(ordinal, total) - 1;
}

/**
 * 在当前下标上移动 `delta` 步并**环绕**（`⇧⌘]` 用 `+1`，`⇧⌘[` 用 `-1`）。
 *
 * 环绕而不是夹到两端：标签条是一个**环**，`→` 在最右边回到第一个是浏览器通行语义，
 * 夹住会让"下一个"在最右端**沉默**（用户以为快捷键坏了）。`count <= 0` 或 `delta === 0`
 * → `null`；`current` 越界时按 `0` 处理（调用方给的是"当前选中项"，不可信时回到第一个）。
 */
export function cycleTabIndex(current: number, count: number, delta: number): number | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const n = Math.floor(count);
  const d = Math.trunc(delta);
  if (!Number.isFinite(d) || d === 0) return null;
  const cur = Number.isInteger(current) && current >= 0 && current < n ? current : 0;
  return (((cur + d) % n) + n) % n;
}

/**
 * 菜单里画给人看的键帽（不是判据 —— 判据是 `browserIntent`）。
 *
 * 画 `⌘`：AmOS 桌面壳自己的键帽惯例（`docs/DESKTOP_SHORTCUTS.md`、`desktopShortcutLabel`），
 * 而 `browserIntent` 同时接受 `Ctrl`（非 Apple 键盘）—— 提示只是提示。
 */
export const BROWSER_SHORTCUT_HINTS: Readonly<Record<BrowserIntent, string>> = {
  "new-tab": "⌘T",
  "close-tab": "⌘W",
  "restore-tab": "⇧⌘T",
  "focus-address": "⌘L",
  "reload": "⌘R",
  "next-tab": "⇧⌘]",
  "prev-tab": "⇧⌘[",
  "tab-1": "⌘1",
  "tab-2": "⌘2",
  "tab-3": "⌘3",
  "tab-4": "⌘4",
  "tab-5": "⌘5",
  "tab-6": "⌘6",
  "tab-7": "⌘7",
  "tab-8": "⌘8",
  "tab-9": "⌘9",
};

/**
 * 把 URL 交给**系统浏览器**（宿主的新窗口处理），返回"有没有真的举手"。
 *
 * 这条出口存在的理由：内容帧 `<iframe>` 能否渲染由**站点自己**决定 ——
 * `X-Frame-Options: DENY` / `CSP frame-ancestors` 是逐站点的，WebMan 无从绕过。
 * 那种情况下用户眼前是一片空白，而 `onerror` 通常**不触发**（引擎把拒绝画成一张
 * 空文档，不是一次加载失败），于是屏幕既没有内容也没有解释。一条可靠的"用外部浏览器
 * 打开"是唯一的真实去路 —— 它必须在，而且**举没举手要可观测**。
 *
 * 机制复用仓库既有做法（`lib/shortcuts.ts::openExternal`）：`globalThis.open(url, …)`。
 * 返回 `boolean` 而不是 `void`：没有 opener 时（无头测试 / 宿主未提供 new-window 处理）
 * 调用方必须**如实说退出失败**，而不是播报"已打开"却什么都没发生 —— 那正是本仓
 * 反复记录的"用 void 把成功与失败说成同一句话"。
 *
 * **诚实边界**：该调用是否真的把 http(s) 交到系统浏览器，取决于宿主 WebView 的
 * new-window 处理，本仓**未在真机验证**。
 */
export function openInExternalBrowser(url: string): boolean {
  const open = (globalThis as { open?: (u: string, t?: string, f?: string) => unknown }).open;
  if (typeof open !== "function") return false;
  open(url, "_blank", "noopener,noreferrer");
  return true;
}

// ==================== 工具函数 ====================

/**
 * 一条历史的**时间标签**，语言无关 —— 它把"这句话该怎么说"与"现在什么语言"分开。
 *
 * **修的是什么**：`formatTime(ts)` 原来直接返回**中文**字符串（`"昨天"` / `"未知时间"` /
 * 硬编码的 `["周日"…]`），而它被渲染进**双语**的历史列表（`WebManApp.svelte`）。于是英文界面的
 * 历史条目会写"昨天"。`i18n-scan` 看不见它：那个扫描器只读 `.svelte` 的 markup 与 script 块，
 * 够不着 `src/lib/**` 里一个普通函数返回的字符串。
 *
 * **为什么返回描述符而不是直接给字符串**：`clock` / `weekday` / `date` 三支可以用 `Intl`
 * 按目标语言格式化，但 `yesterday` / `unknown` 是**词**——它们必须走 `t()` 字典（en/zh 各一份），
 * 而字典在组件层。返回一个判别式联合，组件便能把"词"交给 `t()`、把"格式化的量"直接渲染，
 * 两边都不需要在库层偷偷塞一种语言。
 */
export type TimeLabel =
  | { kind: "clock"; text: string }
  | { kind: "weekday"; text: string }
  | { kind: "date"; text: string }
  | { kind: "yesterday" }
  | { kind: "unknown" };

/** 把时间戳化成语言无关的时间标签（`locale` 决定 clock/weekday/date 的语言）。 */
export function timeLabel(timestamp: number, locale: Locale = "zh"): TimeLabel {
  try {
    if (typeof timestamp !== 'number' || timestamp < 0 || !isFinite(timestamp)) {
      return { kind: "unknown" };
    }

    const date = new Date(timestamp);

    // 检查日期是否有效
    if (isNaN(date.getTime())) {
      return { kind: "unknown" };
    }

    const tag = intlTag(locale);
    const now = new Date();
    const diff = now.getTime() - timestamp;

    // 今天
    if (diff < 86400000 && date.getDate() === now.getDate()) {
      return { kind: "clock", text: date.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" }) };
    }

    // 昨天
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return { kind: "yesterday" };
    }

    // 一周内
    if (diff < 604800000) {
      return { kind: "weekday", text: date.toLocaleDateString(tag, { weekday: "short" }) };
    }

    // 更早
    return { kind: "date", text: date.toLocaleDateString(tag, { month: "short", day: "numeric" }) };
  } catch (error) {
    logger.error('Failed to format time', error);
    return { kind: "unknown" };
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