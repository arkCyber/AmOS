/**
 * webman.test.ts — WebMan 浏览器核心逻辑测试 (航空航天级)
 * 
 * 测试标准:
 * - 功能完整性
 * - 安全边界验证
 * - 并发安全
 * - 性能基准
 * - 错误恢复
 */
import { describe, expect, test } from "vitest";
import { fastest, PERF_ATTEMPTS } from "../../__tests__/perfBudget";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  isValidUrl,
  parseInput,
  extractDomain,
  extractTitle,
  getFaviconUrl,
  generateId,
  createTab,
  closeTab,
  timeLabel,
  formatFileSize,
  sanitizeUrl,
  validateTitle,
  applySafeSearch,
  SAFE_SEARCH_UNMAPPED_HOSTS,
  SEARCH_ENGINE_HOSTS,
  safeSearchGapForEngine,
  addBookmark,
  removeBookmark,
  bookmarkMatches,
  isBookmarked,
  loadBookmarks,
  addToHistory,
  loadHistory,
  clearHistory,
  searchHistory,
  addDownload,
  updateDownload,
  removeDownload,
  loadDownloads,
  clearCompletedDownloads,
  loadSettings,
  saveSettings,
  loadTabs,
  saveTabs,
  debounce,
  throttle,
  LIMITS,
  DEFAULT_SETTINGS,
} from "../webman";

// 书签/下载/标签都写 `amos.webman.*` 共享存储（localStorage）。没有 DOM 时
// `writeStoreValueChecked` 一律返回 false ⇒ 保存函数**如实地**回报失败，而这 8
// 条断言此前之所以"通过"，是因为保存函数把被拒的写入当成成功说出口了 ——
// 测试断言的是那句谎话。与其他 lib 测试同样注册 happy-dom。
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}


// Types and beforeEach available if needed

describe("URL 解析", () => {
  test("isValidUrl 识别有效 URL", () => {
    expect(isValidUrl("https://www.google.com")).toBe(true);
    expect(isValidUrl("http://localhost:3000")).toBe(true);
    expect(isValidUrl("http://192.168.1.1")).toBe(true);
  });

  test("isValidUrl 拒绝无效输入", () => {
    expect(isValidUrl("hello world")).toBe(false);
    expect(isValidUrl("")).toBe(false);
  });

  test("parseInput 处理 URL", () => {
    // URL 构造函数会规范化 URL，添加尾部斜杠
    expect(parseInput("https://example.com", "google")).toBe("https://example.com/");
    expect(parseInput("http://localhost:8080", "google")).toBe("http://localhost:8080/");
  });

  test("parseInput 处理搜索查询", () => {
    const result = parseInput("hello world", "google");
    expect(result).toContain("google.com/search");
    expect(result).toContain("hello%20world");
  });

  test("parseInput 处理不同搜索引擎", () => {
    const google = parseInput("test", "google");
    const bing = parseInput("test", "bing");
    const baidu = parseInput("test", "baidu");
    const duckduckgo = parseInput("test", "duckduckgo");

    expect(google).toContain("google.com/search");
    expect(bing).toContain("bing.com/search");
    expect(baidu).toContain("baidu.com/s?wd");
    expect(duckduckgo).toContain("duckduckgo.com/?q");
  });

  test("extractDomain 提取域名", () => {
    expect(extractDomain("https://www.google.com/search?q=test")).toBe("www.google.com");
    expect(extractDomain("https://github.com/user/repo")).toBe("github.com");
  });

  test("extractTitle 生成标题", () => {
    expect(extractTitle("https://github.com/user/repo")).toBe("github.com/user/repo");
  });

  test("getFaviconUrl 生成图标 URL", () => {
    const favicon = getFaviconUrl("https://www.google.com");
    expect(favicon).toContain("google.com");
    expect(favicon).toContain("favicons");
  });
});

describe("ID 生成", () => {
  test("generateId 生成唯一 ID", () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
    expect(typeof id1).toBe("string");
    expect(id1.length).toBeGreaterThan(10);
  });
});

describe("书签数据模型", () => {
  test("addBookmark 落盘一条可读回的记录（不是只验证函数存在）", () => {
    // 这两条曾经是**假测试**：`expect(typeof createTab).toBe("function")` 与
    // `expect(typeof extractDomain).toBe("function")` —— 断言的是**别的**函数的存在性，
    // 与它们所命名的功能（书签/历史）毫无关系，永远为绿。真契约在
    // `webman-persistence.test.ts` 里已逐条钉住；这里保留一条最小但真实的往返断言，
    // 让"书签/历史"两个 describe 至少验证自己名字所指的东西。
    localStorage.removeItem("amos.webman.bookmarks");
    const added = addBookmark("https://example.com/bookmarked", "书签");
    expect(added).not.toBeNull();
    expect(loadBookmarks().map((b) => b.url)).toEqual(["https://example.com/bookmarked"]);
  });

  test("「判在不在」与「找那一条」是同一个谓词（REQ-A1347 / FMEA F-SH-612）", () => {
    // 星是实心还是空心由 `isBookmarked` 决定，它比的是 `sanitizeUrl` **规范化后**的 URL
    // （`new URL(x).toString()`：主机名折小写、无路径的地址补上结尾 `/`）。而点下去之后
    // 要删的那一条，原先是用**原始串**去 `find` 的 —— 同一个 URL 两种形态，于是两个判据
    // 可以给出两个答案：★ 亮着、点下去找不到那一行、连一句提示都没有。
    localStorage.removeItem("amos.webman.bookmarks");
    const raw = "https://Example.COM"; // 页签里可能就是这个形态（大小写、无路径）
    addBookmark(raw);
    const stored = loadBookmarks()[0]!;
    expect(stored.url, "存储里是规范化形态").not.toBe(raw);

    expect(isBookmarked(raw), "「判在不在」认它").toBe(true);
    expect(bookmarkMatches(stored, raw), "「找那一条」也必须认它").toBe(true);
    // 旧写法（`b.url === url`）在这里是 false —— 这正是那个静默的空点，钉住它别再回来。
    expect(stored.url === raw).toBe(false);
  });
});

describe("历史记录数据模型", () => {
  test("addToHistory 落盘一条可读回的记录（不是只验证函数存在）", () => {
    localStorage.removeItem("amos.webman.history");
    addToHistory("https://example.com/visited", "访问过");
    const rows = loadHistory();
    expect(rows.map((h) => h.url)).toEqual(["https://example.com/visited"]);
    expect(rows[0]!.title).toBe("访问过");
  });
});

describe("标签页管理", () => {
  test("createTab 创建标签（空 URL ⇒ 空标题，文案交给 UI）", () => {
    const tab = createTab();
    expect(tab).toMatchObject({
      id: expect.any(String),
      url: "",
      // REQ-A405: 标题不由 lib 兜底 —— 空标题让 `tab.title || t("webman.newTab")` 生效。
      title: "",
      loading: false,
      scrollY: 0,
      pinned: false,
    });
  });

  test("createTab 带 URL 创建", () => {
    const tab = createTab("https://example.com");
    expect(tab.url).toBe("https://example.com/");
    expect(tab.title).not.toBe("");
  });

  test("closeTab 关闭标签", () => {
    const tabs = [
      createTab("https://a.com"),
      createTab("https://b.com"),
      createTab("https://c.com"),
    ];
    
    // 关闭中间标签
    const newTabs = closeTab(tabs, tabs[1]!.id);
    expect(newTabs).toHaveLength(2);
    expect(newTabs.find((t) => t.id === tabs[1]!.id)).toBeUndefined();
    
    // 关闭最后一个标签
    const singleTab = closeTab([tabs[0]!], tabs[0]!.id);
    expect(singleTab).toHaveLength(1);
  });

  test("closeTab 保证至少一个标签", () => {
    const tabs = [createTab()];
    const result = closeTab(tabs, tabs[0]!.id);
    expect(result).toHaveLength(1);
  });
});

describe("设置", () => {
  test("默认设置正确", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      searchEngine: "google",
      homepage: "https://www.google.com",
      privateMode: false,
      blockPopups: true,
      javaScriptEnabled: true,
      safeSearch: true,
    });
  });
});

describe("工具函数", () => {
  test("timeLabel 给出语言无关的时间描述符", () => {
    const now = Date.now();

    // 今天只给钟点，文案由 UI 层按 locale 渲染
    const today = timeLabel(now);
    expect(today.kind).toBe("clock");
    if (today.kind === "clock") expect(today.text).toMatch(/\d{2}:\d{2}/);

    // 昨天是**词**，不由 lib 决定语言
    expect(timeLabel(now - 86400000).kind).toBe("yesterday");
  });

  test("formatFileSize 格式化文件大小", () => {
    expect(formatFileSize(500)).toBe("500 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1048576)).toBe("1.0 MB");
    expect(formatFileSize(1073741824)).toBe("1.0 GB");
  });
});

describe("搜索引擎配置", () => {
  test("所有搜索引擎可用", () => {
    const engines = ["google", "bing", "baidu", "duckduckgo"] as const;
    
    for (const engine of engines) {
      const url = parseInput("test query", engine);
      expect(url).toContain(engine === "baidu" ? "baidu.com" : `${engine}.com`);
    }
  });
});

describe("边界条件", () => {
  test("空输入处理", () => {
    expect(parseInput("", "google")).toBe("");
  });

  test("localhost 处理", () => {
    const result = parseInput("localhost:3000", "google");
    expect(result).toBe("http://localhost:3000/");
  });

  test("IP地址处理", () => {
    const result = parseInput("192.168.1.1", "google");
    expect(result).toBe("http://192.168.1.1/");
  });
});

// ==================== 航空航天级测试 ====================

describe("安全测试 - URL 清理与验证", () => {
  test("sanitizeUrl 接受有效的 HTTPS URL", () => {
    const result = sanitizeUrl("https://www.example.com");
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe("https://www.example.com/");
  });

  test("sanitizeUrl 接受有效的 HTTP URL", () => {
    const result = sanitizeUrl("http://example.com");
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe("http://example.com/");
  });

  test("sanitizeUrl 拒绝空输入", () => {
    expect(sanitizeUrl("").valid).toBe(false);
    expect(sanitizeUrl("").error).toContain("不能为空");
  });

  test("sanitizeUrl 拒绝 null/undefined", () => {
    expect(sanitizeUrl(null as any).valid).toBe(false);
    expect(sanitizeUrl(undefined as any).valid).toBe(false);
  });

  test("sanitizeUrl 拒绝超长 URL", () => {
    const longUrl = "https://example.com/" + "a".repeat(3000);
    const result = sanitizeUrl(longUrl);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("超过最大长度");
  });

  test("sanitizeUrl 拒绝 javascript: 协议 (XSS 防护)", () => {
    const result = sanitizeUrl("javascript:alert('XSS')");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("不允许的协议");
  });

  test("sanitizeUrl 拒绝 data: 协议", () => {
    const result = sanitizeUrl("data:text/html,<script>alert('XSS')</script>");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("不允许的协议");
  });

  test("sanitizeUrl 拒绝 file: 协议", () => {
    const result = sanitizeUrl("file:///etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("不允许的协议");
  });

  test("sanitizeUrl 拒绝 vbscript: 协议", () => {
    const result = sanitizeUrl("vbscript:msgbox('XSS')");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("不允许的协议");
  });

  test("sanitizeUrl 拒绝 about: 协议", () => {
    const result = sanitizeUrl("about:blank");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("不允许的协议");
  });

  test("sanitizeUrl 拒绝 blob: 协议", () => {
    const result = sanitizeUrl("blob:https://example.com/uuid");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("不允许的协议");
  });

  test("sanitizeUrl 移除换行符", () => {
    const result = sanitizeUrl("https://example.com\r\n/path");
    expect(result.valid).toBe(true);
    expect(result.sanitized).not.toContain("\r");
    expect(result.sanitized).not.toContain("\n");
  });

  test("sanitizeUrl 移除 HTML 尖括号", () => {
    const result = sanitizeUrl("https://example.com/<script>");
    expect(result.valid).toBe(true);
    expect(result.sanitized).not.toContain("<");
    expect(result.sanitized).not.toContain(">");
  });

  test("sanitizeUrl 拒绝 FTP 协议", () => {
    const result = sanitizeUrl("ftp://example.com");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("只支持 HTTP 和 HTTPS");
  });

  test("sanitizeUrl 大小写不敏感协议检测", () => {
    expect(sanitizeUrl("JavaScript:alert(1)").valid).toBe(false);
    expect(sanitizeUrl("JAVASCRIPT:alert(1)").valid).toBe(false);
    expect(sanitizeUrl("JaVaScRiPt:alert(1)").valid).toBe(false);
  });
});

describe("安全测试 - 标题验证", () => {
  test("validateTitle 接受有效标题", () => {
    const result = validateTitle("Example Website");
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe("Example Website");
  });

  test("validateTitle 拒绝空标题", () => {
    expect(validateTitle("").valid).toBe(false);
    expect(validateTitle(null as any).valid).toBe(false);
  });

  test("validateTitle 拒绝超长标题", () => {
    const longTitle = "a".repeat(300);
    const result = validateTitle(longTitle);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("超过最大长度");
  });

  test("validateTitle 移除 HTML 字符", () => {
    const result = validateTitle("<script>alert('XSS')</script>");
    expect(result.valid).toBe(true);
    expect(result.sanitized).not.toContain("<");
    expect(result.sanitized).not.toContain(">");
  });

  test("validateTitle 移除换行符", () => {
    const result = validateTitle("Line 1\nLine 2\rLine 3");
    expect(result.valid).toBe(true);
    expect(result.sanitized).not.toContain("\n");
    expect(result.sanitized).not.toContain("\r");
    expect(result.sanitized).toContain(" ");
  });
});

describe("安全测试 - 安全搜索过滤", () => {
  test("applySafeSearch 为 Google 添加 safe=active", () => {
    const url = "https://www.google.com/search?q=test";
    const result = applySafeSearch(url, true);
    expect(result).toContain("safe=active");
  });

  test("applySafeSearch 为 Bing 添加 adlt=strict", () => {
    const url = "https://www.bing.com/search?q=test";
    const result = applySafeSearch(url, true);
    expect(result).toContain("adlt=strict");
  });

  test("applySafeSearch 为 DuckDuckGo 添加 kp=1", () => {
    const url = "https://duckduckgo.com/?q=test";
    const result = applySafeSearch(url, true);
    expect(result).toContain("kp=1");
  });

  test("applySafeSearch 禁用时不添加参数", () => {
    const url = "https://www.google.com/search?q=test";
    const result = applySafeSearch(url, false);
    expect(result).toBe(url);
  });

  test("applySafeSearch 处理无效 URL", () => {
    const result = applySafeSearch("not-a-url", true);
    expect(result).toBe("not-a-url");
  });

  // ── REQ-A1314：覆盖范围必须**可读**，缺口必须**被记录** ────────────────────────

  test("表里没有的引擎宿主（百度）原样返回 —— 这是一个**被记录的缺口**，不是静默的 bug", () => {
    const url = "https://www.baidu.com/s?wd=test";
    expect(applySafeSearch(url, true)).toBe(url);
  });

  test("缺口清单与安全搜索表**一起**回答「谁能开安全搜索」（少改一处 ⇒ 这条红）", () => {
    // 这条断言的用意：任何人往 `SAFE_SEARCH_PARAMS` 里补上百度那一行，就必须同时把
    // `SAFE_SEARCH_UNMAPPED_HOSTS` 去掉百度 —— 否则下方 `以 unmapped 身份仍不生效` 会红。
    expect([...SAFE_SEARCH_UNMAPPED_HOSTS]).toEqual(["baidu.com"]);
    for (const host of SAFE_SEARCH_UNMAPPED_HOSTS) {
      const url = `https://www.${host}/s?wd=test`;
      expect(applySafeSearch(url, true), `${host} 被声明为未覆盖，却加上了参数`).toBe(url);
    }
  });

  test("两个 host 后缀匹配走点分边界（`evil-google.com` 不该被当成 google.com）", () => {
    const url = "https://evil-google.com/search?q=test";
    expect(applySafeSearch(url, true)).toBe(url);
    // 子域名才算
    expect(applySafeSearch("https://images.google.com/search?q=t", true)).toContain("safe=active");
  });

  // ── REQ-A1333：缺口必须对**用户**说出来，不只是写在注释里 ─────────────────────

  test("safeSearchGapForEngine：选中的引擎有没有安全搜索，逐个回答", () => {
    expect(safeSearchGapForEngine("google")).toBeNull();
    expect(safeSearchGapForEngine("bing")).toBeNull();
    expect(safeSearchGapForEngine("duckduckgo")).toBeNull();
    // 百度那一行不在表里 ⇒ 返回它的宿主，界面据此把缺口画出来（此前用户一个字都看不到）。
    expect(safeSearchGapForEngine("baidu")).toBe("baidu.com");
  });

  test("每个可选引擎的宿主**恰好**被两张表之一认领（加一个引擎就必须归类，少改一处 ⇒ 这条红）", () => {
    for (const [engine, host] of Object.entries(SEARCH_ENGINE_HOSTS)) {
      const inParams = applySafeSearch(`https://www.${host}/s?wd=t`, true) !== `https://www.${host}/s?wd=t`;
      const inGap = (SAFE_SEARCH_UNMAPPED_HOSTS as readonly string[]).includes(host);
      expect(
        inParams !== inGap,
        `${engine} → ${host} 必须恰好属于「有参数」或「缺口」之一（表里都没有 ⇒ 界面会谎称它有效）`,
      ).toBe(true);
      // 判据与 `safeSearchGapForEngine` 的答案一致：缺口清单就是它的唯一来源。
      expect(safeSearchGapForEngine(engine as keyof typeof SEARCH_ENGINE_HOSTS)).toBe(inGap ? host : null);
    }
  });
});

describe("并发安全测试 - 书签管理", () => {
  test("addBookmark 添加有效书签", () => {
    const bookmark = addBookmark("https://test-bookmark-1.com", "Test 1");
    expect(bookmark).not.toBeNull();
    expect(bookmark?.url).toBe("https://test-bookmark-1.com/");
    expect(bookmark?.title).toBe("Test 1");
    expect(bookmark?.id).toBeTruthy();
    expect(bookmark?.createdAt).toBeGreaterThan(0);
  });

  test("addBookmark 拒绝无效 URL", () => {
    const bookmark = addBookmark("javascript:alert(1)");
    expect(bookmark).toBeNull();
  });

  // 这里原来有一条 `expect(true).toBe(true)` 的“占位”用例，注释写着“因为存储不可用，
  // 跳过”。**那句注释是假的**：本文件已注册 happy-dom，存储一直是可用的，而它测的
  // 只是自己写下的 `true`。重复检测（以及下面整片历史/下载/设置的落盘契约）现在由
  // `webman-persistence.test.ts` 用真断言覆盖（书签去重、上限、坏档过滤、写入被拒、
  // 隐私模式、去重与最近在前、设置合并、标签页兜底）。
  test("addBookmark 拒绝重复 URL", () => {
    const url = `https://dup-${generateId()}.example/`;
    expect(addBookmark(url)).not.toBeNull();
    expect(addBookmark(url)).toBeNull();
  });

  test("addBookmark 自动生成标题", () => {
    const bookmark = addBookmark("https://github.com/user/repo");
    expect(bookmark).not.toBeNull();
    expect(bookmark?.title).toContain("github.com");
  });

  test("addBookmark 生成 favicon URL", () => {
    const bookmark = addBookmark("https://test-favicon.com");
    expect(bookmark?.favicon).toContain("favicons");
    expect(bookmark?.favicon).toContain("test-favicon.com");
  });

  test("removeBookmark 拒绝无效 ID", () => {
    expect(removeBookmark("")).toBe(false);
    expect(removeBookmark(null as any)).toBe(false);
  });

  test("isBookmarked 处理无效 URL", () => {
    expect(isBookmarked("javascript:alert(1)")).toBe(false);
  });

  test("loadBookmarks 返回数组", () => {
    const bookmarks = loadBookmarks();
    expect(Array.isArray(bookmarks)).toBe(true);
  });
});

describe("并发安全测试 - 历史记录管理", () => {
  // 这一片原来是 5 条 `expect(true).toBe(true)`（“存储不可用”）。存储是可用的，
  // 所以它们既没测到行为、又给出了错误的解释。真实契约见 `webman-persistence.test.ts`；
  // 这里只留一条与持久化无关的“不抛异常”烟雾 + 三条纯函数边界（它们不依赖存储）。
  test("addToHistory 对任意输入都不抛异常（含非法 URL 与隐私模式）", () => {
    expect(() => addToHistory("https://smoke.example/", "smoke")).not.toThrow();
    expect(() => addToHistory("javascript:alert(1)")).not.toThrow();
    expect(() => addToHistory("https://private.example/", "Private", true)).not.toThrow();
  });

  test("searchHistory 空查询返回整段历史、null 返回空、正常查询有结果", () => {
    // 不再截到 20 条（REQ-A1292）：列表长度由数据源自己决定。
    expect(searchHistory("")).toEqual(loadHistory());
    expect(searchHistory(null as any)).toEqual([]);
    expect(Array.isArray(searchHistory("test"))).toBe(true);
  });

  test("loadHistory 返回数组", () => {
    expect(Array.isArray(loadHistory())).toBe(true);
  });

  test("clearHistory 清空历史", () => {
    addToHistory(`https://clear-${generateId()}.example/`);
    expect(loadHistory().length).toBeGreaterThan(0);
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});

describe("并发安全测试 - 下载管理", () => {
  test("addDownload 添加有效下载", () => {
    const download = addDownload("https://test-download.com/file.pdf");
    expect(download).not.toBeNull();
    expect(download?.url).toBe("https://test-download.com/file.pdf");
    expect(download?.status).toBe("pending");
    expect(download?.progress).toBe(0);
  });

  test("addDownload 拒绝无效 URL", () => {
    const download = addDownload("javascript:alert(1)");
    expect(download).toBeNull();
  });

  test("addDownload 自动提取文件名", () => {
    const download = addDownload("https://example.com/path/to/file.pdf");
    expect(download?.filename).toContain("file.pdf");
  });

  test("addDownload 使用自定义文件名", () => {
    const download = addDownload("https://example.com/file", "custom.pdf");
    expect(download?.filename).toBe("custom.pdf");
  });

  test("addDownload 清理非法文件名字符", () => {
    const download = addDownload("https://example.com/file", "bad<>file:.pdf");
    expect(download?.filename).not.toContain("<");
    expect(download?.filename).not.toContain(">");
    expect(download?.filename).not.toContain(":");
  });

  test("addDownload 限制文件名长度", () => {
    const longName = "a".repeat(300) + ".pdf";
    const download = addDownload("https://example.com/file", longName);
    expect(download?.filename.length).toBeLessThanOrEqual(LIMITS.FILENAME_MAX_LENGTH);
  });

  test("updateDownload 拒绝无效进度", () => {
    expect(updateDownload("any-id", -10)).toBe(false);
    expect(updateDownload("any-id", 150)).toBe(false);
    expect(updateDownload("any-id", NaN)).toBe(false);
  });

  test("updateDownload 拒绝无效 ID", () => {
    expect(updateDownload("", 50)).toBe(false);
    expect(updateDownload(null as any, 50)).toBe(false);
  });

  test("removeDownload 拒绝无效 ID", () => {
    expect(removeDownload("")).toBe(false);
    expect(removeDownload(null as any)).toBe(false);
  });

  test("clearCompletedDownloads 只清已完成的", () => {
    const done = addDownload(`https://example.com/done-${generateId()}`)!;
    const pending = addDownload(`https://example.com/pending-${generateId()}`)!;
    updateDownload(done.id, 100, "completed");
    clearCompletedDownloads();
    const ids = loadDownloads().map((d) => d.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(done.id);
  });

  test("loadDownloads 返回数组", () => {
    const downloads = loadDownloads();
    expect(Array.isArray(downloads)).toBe(true);
  });
});

describe("边界测试 - 数量限制", () => {
  test("LIMITS 常量定义正确", () => {
    expect(LIMITS.URL_MAX_LENGTH).toBe(2048);
    expect(LIMITS.TITLE_MAX_LENGTH).toBe(200);
    expect(LIMITS.FILENAME_MAX_LENGTH).toBe(255);
    expect(LIMITS.BOOKMARK_MAX_COUNT).toBe(1000);
    expect(LIMITS.HISTORY_MAX_COUNT).toBe(500);
    expect(LIMITS.TAB_MAX_COUNT).toBe(50);
    expect(LIMITS.DOWNLOAD_MAX_COUNT).toBe(100);
  });

  /**
   * 上面那条用例把 `LIMITS` 钉在**自身字面量**上（`toBe(2048)` / `toBe(255)`），那对本文件
   * 是自洽的，却对**跨语言契约**零保护：Rust 下载管线在 `webman_download.rs` 里把两个常量
   * **声明**为镜像本模块 —— `MAX_FILENAME_BYTES` 文档「(`LIMITS.FILENAME_MAX_LENGTH` in the
   * UI)」、`MAX_URL_BYTES` 文档「mirroring the UI's `LIMITS.URL_MAX_LENGTH`」。任一侧改一个
   * 数字，UI 与宿主就按**两个不同的上限**判定同一次下载：UI 放行的 3000 字符 URL 被宿主
   * 具名拒绝（用户点了下载却没有反应），或 UI 截到 255 的文件名被宿主截到另一个长度（存储行
   * 与磁盘文件名对不上）。本用例 `readFileSync` 读权威，令这一漂移变成一条红测试（REQ-A662）。
   */
  describe("LIMITS 的两个下载上限 == Rust webman_download.rs 的权威常量（REQ-A662）", () => {
    function rustConst(name: string): number {
      const src = readFileSync(
        new URL("../../../../src/webman_download.rs", import.meta.url),
        "utf8",
      );
      const m = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(src);
      expect(m, `${name} not found in amos-tauri/src/webman_download.rs`).not.toBeNull();
      return Number(m?.[1]);
    }

    test("URL_MAX_LENGTH 等于 Rust MAX_URL_BYTES", () => {
      const cap = rustConst("MAX_URL_BYTES");
      expect(cap).toBeGreaterThan(0); // 漏读守卫：正则失配时不是默默比 0
      expect(LIMITS.URL_MAX_LENGTH).toBe(cap);
    });

    test("FILENAME_MAX_LENGTH 等于 Rust MAX_FILENAME_BYTES", () => {
      const cap = rustConst("MAX_FILENAME_BYTES");
      expect(cap).toBeGreaterThan(0);
      expect(LIMITS.FILENAME_MAX_LENGTH).toBe(cap);
    });
  });

  test("标签页数量限制", () => {
    const limit = LIMITS.TAB_MAX_COUNT;
    const tabs = [];
    
    for (let i = 0; i < limit + 10; i++) {
      tabs.push(createTab(`https://example${i}.com`));
    }
    
    saveTabs(tabs);
    const loaded = loadTabs();
    expect(loaded.length).toBeLessThanOrEqual(limit);
  });
});

describe("边界测试 - 工具函数", () => {
  test("debounce 延迟执行", async () => {
    let counter = 0;
    const increment = debounce(() => { counter++; }, 50);
    
    increment();
    increment();
    increment();
    
    expect(counter).toBe(0);
    
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(counter).toBe(1);
  });

  test("throttle 限流执行", async () => {
    let counter = 0;
    const increment = throttle(() => { counter++; }, 50);
    
    increment();
    increment();
    increment();
    
    expect(counter).toBe(1);
    
    await new Promise((resolve) => setTimeout(resolve, 60));
    increment();
    expect(counter).toBe(2);
  });
});

describe("边界测试 - 设置管理", () => {
  test("loadSettings 返回默认设置", () => {
    const settings = loadSettings();
    expect(settings.searchEngine).toBe("google");
    expect(settings.blockPopups).toBe(true);
  });

  test("saveSettings 部分更新且保留未指定字段", () => {
    saveSettings({ searchEngine: "bing" });
    saveSettings({ privateMode: true });
    expect(loadSettings()).toMatchObject({ searchEngine: "bing", privateMode: true });
  });
});

describe("边界测试 - 标签页管理", () => {
  test("loadTabs 至少返回一个标签", () => {
    const tabs = loadTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(1);
  });

  test("saveTabs 空数组自动创建标签", () => {
    saveTabs([]);
    const tabs = loadTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(1);
  });

  test("createTab 创建固定标签", () => {
    const tab = createTab("https://example.com", true);
    expect(tab.pinned).toBe(true);
  });

  test("closeTab 删除非固定标签", () => {
    const tabs = [
      createTab("https://a.com", false),
      createTab("https://b.com", false),
    ];
    
    const result = closeTab(tabs, tabs[0]!.id);
    expect(result.length).toBe(1);
  });
});

describe("可靠性测试 - 错误处理", () => {
  test("extractDomain 处理无效 URL", () => {
    const domain = extractDomain("not-a-url");
    expect(domain).toBeTruthy();
    expect(domain.length).toBeLessThanOrEqual(50);
  });

  test("extractTitle 处理无效 URL", () => {
    const title = extractTitle("not-a-url");
    expect(title).toBeTruthy();
    expect(title.length).toBeLessThanOrEqual(LIMITS.TITLE_MAX_LENGTH);
  });

  test("getFaviconUrl 处理无效 URL", () => {
    const favicon = getFaviconUrl("not-a-url");
    expect(favicon).toBe("");
  });

  test("timeLabel 处理无效时间戳", () => {
    expect(timeLabel(-1).kind).toBe("unknown");
    expect(timeLabel(NaN).kind).toBe("unknown");
  });

  test("formatFileSize 处理无效大小", () => {
    expect(formatFileSize(-1)).toBe("0 B");
    expect(formatFileSize(NaN)).toBe("0 B");
  });
});

describe("性能测试 - ID 生成", () => {
  test("generateId 生成唯一 ID (1000 次)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(1000);
  });

  test("generateId 性能基准", () => {
    // REQ-A850 / F-DEV-106：`Date.now()` 的差值 = 干活 + 被抢占的时间；取 K 次最小值。
    const elapsed = fastest(PERF_ATTEMPTS, () => {
      for (let i = 0; i < 10000; i++) {
        generateId();
      }
    });
    expect(elapsed).toBeLessThan(1000); // 10000 次应该在 1 秒内完成
  });
});
