/**
 * webman-persistence.test.ts — `lib/webman.ts` 的**持久化路径**行为测试（P2-1 覆盖）。
 *
 * 为什么单独一个文件：`webman.ts` 长期是 `make cov` 里最大的一块空白（实测 300 行未覆盖、
 * 65.8%——全仓第一）。原来的 `webman.test.ts` 有一整片 `expect(true).toBe(true)` 占位用例，
 * 注释写着"由于存储不可用，跳过"——**那句话是假的**：该文件已经注册 happy-dom，
 * `writeStoreValueChecked` 一直返回 true。占位的"绿"掩盖了"书签/历史/下载/设置/标签页
 * 的落盘、去重、上限、坏档过滤、写入被拒"这些**能在无头环境里验的真契约**一条都没测。
 *
 * 这个文件**故意不注册 happy-dom**：`scripts/bun-iso-test.mjs` 把导入 happy-dom 的文件判为
 * DOM 文件、只为"正确性"跑，**不计入 P2-1 覆盖率**（`coverage:gate` 只跑 pure 批次）。
 * `amosStore` 只用到一个 DOM 面——`window.localStorage`——所以给它一个内存实现即可；
 * 同一个文件里再给一次**写失败**开关，用来验"被拒的写入必须回报、不得假装已保存"
 * （书签与下载是 `cloud.ts` 的 `SYNC_STORES`，写丢就是用户数据丢）。
 *
 * **pure 批次是一个进程跑所有文件**，所以桩只能在**本文件**生命周期内存在：`beforeAll`
 * 装、`afterAll` 还原，否则同批次后面的文件会凭空多出一个可用的 `window`（与
 * `enterprise-webhooks.test.ts` 同一教训）。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  BOOKMARKS_KEY,
  HISTORY_KEY,
  DOWNLOADS_KEY,
  SETTINGS_KEY,
  TABS_KEY,
  LIMITS,
  DEFAULT_SETTINGS,
  loadBookmarks,
  addBookmark,
  removeBookmark,
  isBookmarked,
  loadHistory,
  addToHistory,
  clearHistory,
  searchHistory,
  loadDownloads,
  addDownload,
  updateDownload,
  removeDownload,
  clearCompletedDownloads,
  loadSettings,
  saveSettings,
  loadTabs,
  saveTabs,
  createTab,
  applySafeSearch,
  type Bookmark,
  type HistoryEntry,
  type Download,
  type Tab,
} from "../webman";
import { readQuarantine } from "../amosStore";

// ── 内存 localStorage（+ 可切换的写失败）──────────────────────────────────────
const memory = new Map<string, string>();
let failWrites = false;

const stub = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error("QuotaExceededError");
      memory.set(key, String(value));
    },
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: (i: number) => [...memory.keys()][i] ?? null,
    get length() {
      return memory.size;
    },
  },
  dispatchEvent: () => true,
};

const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;

beforeAll(() => {
  globals.window = stub;
});

afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
});

beforeEach(() => {
  memory.clear();
  failWrites = false;
});

/** 直接按模块自己的读法看落盘内容（`writeJson` 写一串 JSON，`readJson` 解析一次）。 */
function read(key: string): any {
  const raw = memory.get(key);
  return raw == null ? null : JSON.parse(raw);
}

/** 播种一份版本化存储，供"读侧过滤 / 上限"用例使用。 */
function seed(key: string, data: unknown[]): void {
  memory.set(key, JSON.stringify({ version: 0, data }));
}

const OK_URL = "https://example.com/page";

// ── 书签 ──────────────────────────────────────────────────────────────────────
describe("书签持久化", () => {
  test("addBookmark 落盘并递增存储版本，读回来是同一条", () => {
    const added = addBookmark(OK_URL, "示例")!;
    expect(read(BOOKMARKS_KEY)).toEqual({ version: 1, data: [added] });
    expect(loadBookmarks()).toEqual([added]);
    expect(isBookmarked(OK_URL)).toBe(true);
  });

  test("同一 URL 只收藏一次（重复返回 null，存储不动）", () => {
    expect(addBookmark(OK_URL)).not.toBeNull();
    expect(addBookmark(OK_URL)).toBeNull();
    expect(loadBookmarks()).toHaveLength(1);
    expect(read(BOOKMARKS_KEY).version).toBe(1);
  });

  test("无效 URL 不落盘", () => {
    expect(addBookmark("javascript:alert(1)")).toBeNull();
    expect(loadBookmarks()).toEqual([]);
  });

  test("removeBookmark 按 id 删除；未知 id 回 false", () => {
    const added = addBookmark(OK_URL)!;
    expect(removeBookmark(added.id)).toBe(true);
    expect(loadBookmarks()).toEqual([]);
    expect(removeBookmark(added.id)).toBe(false);
  });

  test("读侧丢掉坏条目（缺字段 / 非法 URL），保留好的", () => {
    seed(BOOKMARKS_KEY, [
      { id: "good", url: OK_URL, title: "ok", createdAt: 1 },
      { id: "bad-url", url: "javascript:alert(1)", title: "x", createdAt: 2 },
      { id: 7, url: OK_URL, title: "no-id", createdAt: 3 },
      { id: "no-time", url: OK_URL, title: "x" },
    ]);
    expect(loadBookmarks().map((b) => b.id)).toEqual(["good"]);
  });

  test("坏 JSON 回空并留下可恢复的 quarantine 副本", () => {
    memory.set(BOOKMARKS_KEY, "{ not json");
    expect(loadBookmarks()).toEqual([]);
    expect(readQuarantine(BOOKMARKS_KEY)).toBe("{ not json");
  });

  test("达到上限后拒绝新增", () => {
    const full: Bookmark[] = Array.from({ length: LIMITS.BOOKMARK_MAX_COUNT }, (_, i) => ({
      id: `b${i}`,
      url: `https://example.com/${i}`,
      title: `t${i}`,
      createdAt: i,
    }));
    seed(BOOKMARKS_KEY, full);
    expect(addBookmark("https://example.com/one-more")).toBeNull();
    expect(loadBookmarks()).toHaveLength(LIMITS.BOOKMARK_MAX_COUNT);
  });

  test("写入被存储拒绝时 addBookmark 回 null 且不留半条记录", () => {
    failWrites = true;
    expect(addBookmark(OK_URL)).toBeNull();
    expect(read(BOOKMARKS_KEY)).toBeNull();
  });

  test("isBookmarked 对非法 URL 回 false（不抛）", () => {
    expect(isBookmarked("not a url")).toBe(false);
  });
});

// ── 历史 ──────────────────────────────────────────────────────────────────────
describe("历史持久化", () => {
  test("addToHistory 落盘（标题 + favicon），最新在前", () => {
    seed(HISTORY_KEY, [
      { url: "https://old.example/", title: "old", visitedAt: 1 },
    ] as HistoryEntry[]);
    addToHistory(OK_URL, "新页面");
    const history = loadHistory();
    expect(history[0]?.url).toBe(OK_URL);
    expect(history[0]?.title).toBe("新页面");
    expect(history[0]?.favicon).toContain("example.com");
    expect(history).toHaveLength(2);
  });

  test("隐私模式不记录", () => {
    addToHistory(OK_URL, "私密", true);
    expect(loadHistory()).toEqual([]);
  });

  test("无效 URL 被忽略", () => {
    addToHistory("javascript:alert(1)");
    expect(loadHistory()).toEqual([]);
  });

  test("重复访问同一 URL 去重（不新增第二条）", () => {
    seed(HISTORY_KEY, [
      { url: "https://a.example/", title: "a", visitedAt: 1 },
      { url: "https://b.example/", title: "b", visitedAt: 2 },
    ] as HistoryEntry[]);
    addToHistory("https://a.example/", "a 再来");
    const history = loadHistory();
    expect(history).toHaveLength(2);
    expect(history.filter((h) => h.url === "https://a.example/")).toHaveLength(1);
    expect(history[0]?.title).toBe("a 再来");
  });

  test("clearHistory 清空并重置版本", () => {
    addToHistory(OK_URL);
    clearHistory();
    expect(loadHistory()).toEqual([]);
    expect(read(HISTORY_KEY)).toEqual({ version: 0, data: [] });
  });

  test("searchHistory：空查询给最近 20 条、命中 url 或 title、大小写不敏感、null 回空", () => {
    seed(
      HISTORY_KEY,
      Array.from({ length: 25 }, (_, i) => ({
        url: `https://site${i}.example/`,
        title: i === 3 ? "Needle" : `page ${i}`,
        visitedAt: 100 - i,
      })) as HistoryEntry[],
    );
    expect(searchHistory("")).toHaveLength(20);
    expect(searchHistory("   ")).toHaveLength(20); // 纯空白与空串同义（本轮修的矛盾）
    expect(searchHistory(null as any)).toEqual([]);
    expect(searchHistory("needle").map((h) => h.title)).toEqual(["Needle"]);
    expect(searchHistory("SITE7").map((h) => h.url)).toEqual(["https://site7.example/"]);
    expect(searchHistory("no-such-thing")).toEqual([]);
  });

  test("历史条数封顶 HISTORY_MAX_COUNT", () => {
    seed(
      HISTORY_KEY,
      Array.from({ length: LIMITS.HISTORY_MAX_COUNT }, (_, i) => ({
        url: `https://h${i}.example/`,
        title: `h${i}`,
        visitedAt: i,
      })) as HistoryEntry[],
    );
    addToHistory("https://brand-new.example/");
    const history = loadHistory();
    expect(history).toHaveLength(LIMITS.HISTORY_MAX_COUNT);
    expect(history[0]?.url).toBe("https://brand-new.example/");
  });

  test("读侧丢掉非法 URL 的历史条目", () => {
    seed(HISTORY_KEY, [
      { url: "https://ok.example/", title: "ok", visitedAt: 1 },
      { url: "javascript:alert(1)", title: "xss", visitedAt: 2 },
    ] as HistoryEntry[]);
    expect(loadHistory().map((h) => h.title)).toEqual(["ok"]);
  });
});


// ── 下载 ──────────────────────────────────────────────────────────────────────
describe("下载持久化", () => {
  test("addDownload 从 URL 取文件名并落盘（pending / 0%）", () => {
    const added = addDownload("https://example.com/path/to/file.pdf")!;
    expect(added.filename).toBe("file.pdf");
    expect(added.status).toBe("pending");
    expect(added.progress).toBe(0);
    expect(loadDownloads()).toEqual([added]);
  });

  test("自定义文件名：清理非法字符并封顶长度", () => {
    const cleaned = addDownload("https://example.com/f", 'bad<>:"/\\|?*.pdf');
    expect(cleaned?.filename).toBe("bad_________.pdf");
    const long = addDownload("https://example.com/g", "a".repeat(400) + ".pdf");
    expect(long?.filename.length).toBe(LIMITS.FILENAME_MAX_LENGTH);
  });

  test("无效 URL 不落盘", () => {
    expect(addDownload("javascript:alert(1)")).toBeNull();
    expect(loadDownloads()).toEqual([]);
  });

  test("updateDownload 拒绝越界进度、可同时改状态；未知 id / 非法入参回 false", () => {
    const added = addDownload("https://example.com/f")!;
    expect(updateDownload(added.id, 150)).toBe(false);
    expect(updateDownload(added.id, 42, "downloading")).toBe(true);
    expect(loadDownloads()[0]).toMatchObject({ progress: 42, status: "downloading" });
    expect(updateDownload("nope", 10)).toBe(false);
    expect(updateDownload("", 10)).toBe(false);
  });

  test("removeDownload 删除；未知 id 回 false", () => {
    const added = addDownload("https://example.com/f")!;
    expect(removeDownload(added.id)).toBe(true);
    expect(loadDownloads()).toEqual([]);
    expect(removeDownload(added.id)).toBe(false);
  });

  test("clearCompletedDownloads 只清已完成的", () => {
    const done = addDownload("https://example.com/done")!;
    const pending = addDownload("https://example.com/pending")!;
    updateDownload(done.id, 100, "completed");
    clearCompletedDownloads();
    expect(loadDownloads().map((d) => d.id)).toEqual([pending.id]);
  });

  test("读侧丢掉坏条目（非法状态 / 进度越界）", () => {
    seed(DOWNLOADS_KEY, [
      { id: "ok", url: OK_URL, filename: "f", progress: 50, status: "downloading", createdAt: 1 },
      { id: "bad-status", url: OK_URL, filename: "f", progress: 1, status: "weird", createdAt: 2 },
      { id: "bad-progress", url: OK_URL, filename: "f", progress: 200, status: "pending", createdAt: 3 },
    ] as Download[]);
    expect(loadDownloads().map((d) => d.id)).toEqual(["ok"]);
  });

  test("达到上限后拒绝新增", () => {
    seed(
      DOWNLOADS_KEY,
      Array.from({ length: LIMITS.DOWNLOAD_MAX_COUNT }, (_, i) => ({
        id: `d${i}`,
        url: `https://example.com/${i}`,
        filename: `f${i}`,
        progress: 0,
        status: "pending",
        createdAt: i,
      })) as Download[],
    );
    expect(addDownload("https://example.com/one-more")).toBeNull();
  });

  test("写入被存储拒绝时 addDownload 回 null（不假装已保存）", () => {
    failWrites = true;
    expect(addDownload("https://example.com/f")).toBeNull();
    expect(read(DOWNLOADS_KEY)).toBeNull();
  });
});


// ── 设置 ──────────────────────────────────────────────────────────────────────
describe("设置持久化", () => {
  test("无存储时给出默认值", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test("部分存储与默认值合并；非法搜索引擎回落到默认", () => {
    memory.set(SETTINGS_KEY, JSON.stringify({ searchEngine: "nope", safeSearch: false }));
    const settings = loadSettings();
    expect(settings.searchEngine).toBe(DEFAULT_SETTINGS.searchEngine);
    expect(settings.safeSearch).toBe(false);
    expect(settings.blockPopups).toBe(DEFAULT_SETTINGS.blockPopups);
  });

  test("saveSettings 是部分更新，未指定的字段保留", () => {
    saveSettings({ searchEngine: "bing" });
    saveSettings({ privateMode: true });
    expect(loadSettings()).toMatchObject({ searchEngine: "bing", privateMode: true });
  });

  test("存储在非对象值时不返回共享的 DEFAULT_SETTINGS（改它不影响常量，也不影响下一次读）", () => {
    memory.set(SETTINGS_KEY, JSON.stringify(null));
    const first = loadSettings();
    first.safeSearch = false; // 调用方改了手里那份
    expect(DEFAULT_SETTINGS.safeSearch).toBe(true); // 模块常量没被带坏
    expect(loadSettings().safeSearch).toBe(true); // 下一次读仍是真默认值
  });
});

// ── 标签页 ────────────────────────────────────────────────────────────────────
describe("标签页持久化", () => {
  test("空存储时至少有一个标签", () => {
    expect(loadTabs().length).toBeGreaterThanOrEqual(1);
  });

  test("saveTabs 落盘并可读回", () => {
    const tab = createTab("https://example.com", true);
    saveTabs([tab]);
    const tabs = loadTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ url: "https://example.com/", pinned: true });
  });

  test("saveTabs 收到空数组时补一个标签（浏览器不能没有标签）", () => {
    saveTabs([]);
    expect(loadTabs()).toHaveLength(1);
  });

  test("标签数封顶 TAB_MAX_COUNT", () => {
    const many = Array.from({ length: LIMITS.TAB_MAX_COUNT + 10 }, (_, i) =>
      createTab(`https://example${i}.com`),
    );
    saveTabs(many);
    expect(loadTabs().length).toBeLessThanOrEqual(LIMITS.TAB_MAX_COUNT);
  });

  test("读侧丢掉坏标签（非法 URL / 缺字段），坏到一条不剩时补一个", () => {
    seed(TABS_KEY, [
      { id: "ok", url: "https://ok.example/", title: "ok", loading: false, scrollY: 0, pinned: false },
      { id: "bad", url: "javascript:alert(1)", title: "x", loading: false, scrollY: 0, pinned: false },
    ] as Tab[]);
    expect(loadTabs().map((t) => t.id)).toEqual(["ok"]);

    seed(TABS_KEY, [{ id: "bad", url: "javascript:alert(1)" }]);
    expect(loadTabs()).toHaveLength(1);
  });
});

// ── 安全搜索的域名边界（本轮修复的缺陷回归）───────────────────────────────────
describe("applySafeSearch 只认真正的搜索域名（点分边界，不是子串）", () => {
  test("正例：站点本身与其子域都加参数", () => {
    expect(applySafeSearch("https://google.com/search?q=a", true)).toContain("safe=active");
    expect(applySafeSearch("https://www.google.com/search?q=a", true)).toContain("safe=active");
    expect(applySafeSearch("https://bing.com/search?q=a", true)).toContain("adlt=strict");
    expect(applySafeSearch("https://duckduckgo.com/?q=a", true)).toContain("kp=1");
  });

  test("负控：只是包含子串的域名不得被当作搜索引擎", () => {
    expect(applySafeSearch("https://notgoogle.com/search?q=a", true)).not.toContain("safe=");
    expect(applySafeSearch("https://google.com.evil.example/", true)).not.toContain("safe=");
    expect(applySafeSearch("https://mybing.com/search?q=a", true)).not.toContain("adlt=");
  });

  test("关闭时不改 URL；非法 URL 原样返回", () => {
    const url = "https://google.com/search?q=a";
    expect(applySafeSearch(url, false)).toBe(url);
    expect(applySafeSearch("not a url", true)).toBe("not a url");
  });
});

