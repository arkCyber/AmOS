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
 * DOM 文件，`test` 模式下它们各自独占一个进程（共享的 happy-dom window 会被互相污染）。
 * 覆盖率**两种文件都算** —— coverage 模式下每个测试文件都单独跑一遍并留下自己的 lcov 分片，
 * 门再把它们合并（`bun-iso-test.mjs` 的 coverage 分支 + REQ-A390/A396）。这里不注册只是因为
 * **不需要**：`amosStore` 只用到一个 DOM 面 —— `window.localStorage` —— 给它一个内存实现即可；
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
  closeTab,
  formatTime,
  formatFileSize,
  applySafeSearch,
  type Bookmark,
  type HistoryEntry,
  type Download,
  type Tab,
} from "../webman";
import { readQuarantine } from "../amosStore";

// ── 内存 localStorage（+ 可切换的写失败 + 一次性"另一个窗口先写了一步"）──────────
const memory = new Map<string, string>();
let failWrites = false;

/**
 * 纯批次是**单进程**，所以"读 → 校验版本 → 写"之间没有真正的并发。乐观锁的**冲突**
 * 分支（版本不匹配 ⇒ 本次写被拒、重试）只能由这个钩子做出来：第 `after+1` 次读 `key`
 * 之前先把内容换成"别的窗口刚写下的"值 —— 这正是真实两窗口时序。
 *
 * `after` 的意义就是那两步：第 1 次读是 `loadXStore`（调用方拿到旧版本），第 2 次读是
 * `saveXStore` 的版本校验 ⇒ 要撞冲突必须 `after: 1`（第一版写的是"下一次读就注入"，
 * 于是注入发生在**加载**那一步、版本根本没变，测试绿得没有碰到那条分支）。
 */
let interleave: { key: string; value: unknown; after: number } | null = null;

/** 安排一次"在 `key` 的第 `after + 1` 次读之前，另一个窗口先写一步"。 */
function interleaveOnce(key: string, value: unknown, after = 0): void {
  interleave = { key, value, after };
}

const stub = {
  localStorage: {
    getItem: (key: string) => {
      if (interleave !== null && interleave.key === key) {
        if (interleave.after > 0) {
          interleave.after--;
        } else {
          const pending = interleave;
          interleave = null;
          memory.set(key, JSON.stringify(pending.value));
        }
      }
      return memory.has(key) ? memory.get(key)! : null;
    },
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
  interleave = null; // 一个用例没消费掉的钩子不许漏给下一个用例
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

  test("超长/带尖括号的标题被截断并清洗后落盘（REQ-A404）", () => {
    // `validateTitle` 对超长输入回 `valid:false`，而 `addToHistory` 只在 valid 分支取
    // `sanitized` ⇒ 超长标题**原样落盘**（带着 `<>` 与超限长度）。同一份输入在
    // `addBookmark` 里是**被拒绝**的 —— 两条相反的处理，且都没说明理由。
    const long = "<img src=x onerror=alert(1)>" + "a".repeat(LIMITS.TITLE_MAX_LENGTH + 20);
    addToHistory(OK_URL, long);
    const row = loadHistory()[0];
    expect(row?.title.length).toBeLessThanOrEqual(LIMITS.TITLE_MAX_LENGTH);
    expect(row?.title).not.toContain("<");
    expect(row?.title).not.toContain(">");
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
describe("version 不是数字的 store 仍然可写（REQ-A404）", () => {
  // 读侧把非数字 version 归一化为 0（`loadXStore`），写侧却拿**原值**比对
  // （`current.version !== expectedVersion`）⇒ `undefined !== 0`，于是每一次写都失败、
  // 重试 3 次后放弃：**这份 store 永远写不进去**，而 `addToHistory` 的返回值是 void
  // ⇒ 用户看不到任何提示。一个"有行、没 version"的 store（旧版本/导入器/手工编辑）
  // 一次加载即可复现，不需要任何并发。
  test("播种 `{ data: [] }`（无 version）后 addToHistory 仍能落盘", () => {
    memory.set(HISTORY_KEY, JSON.stringify({ data: [] }));
    addToHistory(OK_URL, "标题");
    expect(loadHistory().map((h) => h.url)).toEqual([OK_URL]);
  });

  test("书签 / 下载 / 标签同样可写（并落成 version 1）", () => {
    memory.set(BOOKMARKS_KEY, JSON.stringify({ data: [] }));
    memory.set(DOWNLOADS_KEY, JSON.stringify({ data: [] }));
    memory.set(TABS_KEY, JSON.stringify({ data: [] }));
    expect(addBookmark(OK_URL, "书签")).not.toBeNull();
    expect(addDownload(OK_URL)).not.toBeNull();
    saveTabs(loadTabs().map((t) => ({ ...t, scrollY: 42 })));
    expect(read(BOOKMARKS_KEY)).toMatchObject({ version: 1 });
    expect(read(DOWNLOADS_KEY)).toMatchObject({ version: 1 });
    expect(read(TABS_KEY)).toMatchObject({ version: 1 });
  });
});

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


// ── 错误路径 / 边界分支（REQ-A405：webman.ts 是名单上最大的一块）───────────────
//
// 这一节的判定标准：**只测能从外部观察的契约**（返回值 / 落盘内容 / 是否留下半条记录），
// 不测日志文本。webman 的缺失行里最集中的就是这些"只有出错时才走到"的分支。
//
// 诚实边界：`loadXStore` / `saveXStore` 的 `catch`，以及 `clearHistory` / `loadSettings`
// / `saveSettings` 的 `catch`，在**当前** `amosStore` 实现下不可达 —— `readJson` /
// `writeJson` 自己接住了 `localStorage` 抛错与坏 JSON（`JSON.stringify` 失败只是回
// `false`）。它们是纵深防御，不是能被覆盖的分支；不为它们编造触发方式（要触发就得让
// `amosStore` 的 catch 不再接住，那测的是另一个模块）。
describe("store 形状不对 ⇒ 读侧重置，不崩（REQ-A405）", () => {
  test("非对象（数字 / 字符串 / null / 数组）一律回空 store", () => {
    for (const garbage of ["5", '"hello"', "null", "[]"]) {
      memory.set(BOOKMARKS_KEY, garbage);
      memory.set(HISTORY_KEY, garbage);
      memory.set(DOWNLOADS_KEY, garbage);
      expect([garbage, loadBookmarks()]).toEqual([garbage, []]);
      expect([garbage, loadHistory()]).toEqual([garbage, []]);
      expect([garbage, loadDownloads()]).toEqual([garbage, []]);
      memory.set(TABS_KEY, garbage);
      expect(loadTabs()).toHaveLength(1); // 标签页有自己的兜底：不能一个标签都没有
    }
  });

  test("对象但 data 不是数组（旧格式 / 手改过）⇒ 同样重置", () => {
    for (const key of [BOOKMARKS_KEY, HISTORY_KEY, DOWNLOADS_KEY]) {
      memory.set(key, JSON.stringify({ version: 3 }));
      expect([key, loadBookmarks()]).toEqual([key, []]);
      expect([key, loadHistory()]).toEqual([key, []]);
      expect([key, loadDownloads()]).toEqual([key, []]);
    }
    memory.set(TABS_KEY, JSON.stringify({ version: 3 }));
    expect(loadTabs()).toHaveLength(1); // 补一个空标签
  });

  test("重置不会把坏内容当成空内容写回去（用户的字节仍在 quarantine 里）", () => {
    memory.set(BOOKMARKS_KEY, "{ not json");
    expect(loadBookmarks()).toEqual([]);
    expect(readQuarantine(BOOKMARKS_KEY)).toBe("{ not json");
  });
});


describe("写入被存储拒绝 ⇒ 重试 3 次后如实放弃（REQ-A405）", () => {
  test("历史：addToHistory 是 void，但**一条都没落盘**（失败不得被读成成功）", () => {
    addToHistory(OK_URL, "写不进去");
    expect(loadHistory()).toHaveLength(1); // 先证明这条路径平时是通的
    failWrites = true;
    addToHistory("https://example.com/second", "写不进去");
    expect(loadHistory().map((h) => h.url)).toEqual([OK_URL]); // 没有半条记录
  });

  test("书签 removeBookmark：删除被拒 ⇒ false，条目还在；好起来之后能删掉", () => {
    const added = addBookmark(OK_URL, "书签")!;
    failWrites = true;
    expect(removeBookmark(added.id)).toBe(false);
    expect(loadBookmarks()).toHaveLength(1);
    failWrites = false;
    expect(removeBookmark(added.id)).toBe(true);
    expect(loadBookmarks()).toEqual([]);
  });

  test("下载：updateDownload / removeDownload / clearCompletedDownloads 都如实回报", () => {
    const d = addDownload(OK_URL, "a.bin")!;
    failWrites = true;
    expect(updateDownload(d.id, 42)).toBe(false);
    expect(removeDownload(d.id)).toBe(false);
    clearCompletedDownloads(); // void：只能验"没落盘"
    expect(loadDownloads().map((x) => x.id)).toEqual([d.id]);
    expect(loadDownloads()[0]?.progress).toBe(0);
    failWrites = false;
    expect(updateDownload(d.id, 42, "downloading")).toBe(true);
    expect(loadDownloads()[0]).toMatchObject({ progress: 42, status: "downloading" });
    clearCompletedDownloads();
    expect(loadDownloads()).toHaveLength(1); // 未完成的还在
    expect(updateDownload(d.id, 100, "completed")).toBe(true);
    clearCompletedDownloads();
    expect(loadDownloads()).toEqual([]);
  });

  test("标签页：saveTabs 是 void，但失败时读回来还是旧内容", () => {
    saveTabs([createTab("https://example.com")]);
    const before = loadTabs();
    failWrites = true;
    saveTabs(before.map((t) => ({ ...t, scrollY: 99 })));
    expect(loadTabs().map((t) => t.scrollY)).toEqual(before.map((t) => t.scrollY));
  });
});

describe("并发：读与写之间另一个窗口先写了一步 ⇒ 本次写被拒、重试后成功（REQ-A405）", () => {
  test("书签：不覆盖别人的写入", () => {
    const mine = addBookmark(OK_URL, "我的")!;
    const theirs: Bookmark = { id: "other", url: "https://other.example/", title: "别人的", createdAt: 1 };
    // 另一个窗口在我"读 → 写"之间把 store 换掉：版本 +1，且**多了它的一条**。
    // `after: 1` = 让加载那一次读通过，注入发生在 `saveBookmarkStore` 的版本校验那一次读。
    interleaveOnce(BOOKMARKS_KEY, { version: 2, data: [theirs, mine] }, 1);
    expect(removeBookmark(mine.id)).toBe(true); // 重试后按**新**版本写，别人的条目留下
    expect(loadBookmarks().map((b) => b.id)).toEqual(["other"]);
  });

  test("历史 / 下载 / 标签页：同一个乐观锁在四处一致", () => {
    addToHistory(OK_URL, "我");
    interleaveOnce(HISTORY_KEY, { version: 7, data: [] }, 1);
    addToHistory("https://example.com/second", "第二条");
    expect(loadHistory().map((h) => h.url)).toContain("https://example.com/second");

    addDownload(OK_URL, "a.bin");
    interleaveOnce(DOWNLOADS_KEY, { version: 9, data: [] }, 1);
    expect(addDownload("https://example.com/d", "b.bin")).not.toBeNull();

    saveTabs([createTab("https://example.com")]);
    interleaveOnce(TABS_KEY, { version: 4, data: [] }, 1);
    saveTabs([createTab("https://example.com/again")]);
    expect(loadTabs()).toHaveLength(1);
    expect(loadTabs()[0]?.url).toBe("https://example.com/again");
  });
});


describe("输入校验：标题 / ID / 进度（REQ-A405）", () => {
  test("addBookmark 拒绝超长标题（与历史侧共用 validateTitle，但这一侧是拒绝）", () => {
    const tooLong = "a".repeat(LIMITS.TITLE_MAX_LENGTH + 1);
    expect(addBookmark(OK_URL, tooLong)).toBeNull();
    expect(loadBookmarks()).toEqual([]);
  });

  test("removeBookmark 拒绝空 id", () => {
    expect(removeBookmark("")).toBe(false);
    expect(removeBookmark(null as unknown as string)).toBe(false);
  });

  test("updateDownload 拒绝空 id 与越界进度（不写任何东西）", () => {
    const d = addDownload(OK_URL, "a.bin")!;
    expect(updateDownload("", 10)).toBe(false);
    expect(updateDownload(null as unknown as string, 10)).toBe(false);
    expect(updateDownload(d.id, -1)).toBe(false);
    expect(updateDownload(d.id, 101)).toBe(false);
    expect(updateDownload(d.id, NaN)).toBe(false);
    expect(loadDownloads()[0]?.progress).toBe(0);
  });

  test("updateDownload 拒绝协议外的 status：不写一条读回来就消失的行", () => {
    // 读侧按契约丢掉 status 不在四值里的行。若这里允许写进去，用户会看到进度更新
    // "成功"，而下一次加载这条记录**整行消失** —— 静默的数据丢失。
    const d = addDownload(OK_URL, "a.bin")!;
    expect(updateDownload(d.id, 50, "bogus" as Download["status"])).toBe(false);
    expect(loadDownloads().map((x) => x.id)).toEqual([d.id]);
  });
});

describe("closeTab / formatTime / formatFileSize 的边界（REQ-A405）", () => {
  test("closeTab：空 id 原样返回；id 不存在原样返回（不得丢掉用户的标签）", () => {
    const tabs = [createTab("https://a.com"), createTab("https://b.com")];
    expect(closeTab(tabs, "")).toBe(tabs);
    expect(closeTab(tabs, null as unknown as string)).toBe(tabs);
    expect(closeTab(tabs, "no-such-tab")).toBe(tabs);
  });

  test("closeTab：关掉最后一个标签会补一个空白标签（浏览器不能没有标签）", () => {
    const only = [createTab("https://a.com")];
    const after = closeTab(only, only[0]!.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(only[0]!.id);
    expect(after[0]!.url).toBe("");
  });

  test("formatTime：非法 / 越界时间戳回「未知时间」而不是 Invalid Date", () => {
    expect(formatTime(-1)).toBe("未知时间");
    expect(formatTime(NaN)).toBe("未知时间");
    expect(formatTime(Infinity)).toBe("未知时间");
    expect(formatTime(1e20)).toBe("未知时间"); // Number.isFinite 通过，但 Date 已越界
    expect(formatTime("123" as unknown as number)).toBe("未知时间");
  });

  test("formatTime：今天给时刻、昨天给「昨天」、一周内给星期、更早给月日", () => {
    const now = Date.now();
    expect(formatTime(now)).toMatch(/\d/);
    expect(formatTime(now - 86400000)).toBe("昨天");
    expect(["周日", "周一", "周二", "周三", "周四", "周五", "周六"]).toContain(
      formatTime(now - 3 * 86400000),
    );
    const old = formatTime(now - 30 * 86400000);
    expect(old).not.toBe("未知时间");
    expect(old).not.toBe("昨天");
  });

  test("formatFileSize：单位台阶与非法值", () => {
    expect(formatFileSize(999)).toBe("999 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatFileSize(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
    expect(formatFileSize(-1)).toBe("0 B");
    expect(formatFileSize(Infinity)).toBe("0 B");
    expect(formatFileSize("x" as unknown as number)).toBe("0 B");
  });
});


describe("logger.debug 只在 DEV 打开（生产构建里不进日志）（REQ-A405）", () => {
  test("DEV=true 时记录访问；DEV 未设（生产语义）时一句 debug 都不写", () => {
    const env = (import.meta as unknown as { env: Record<string, unknown> }).env;
    const previous = env.DEV;
    const realDebug = console.debug;
    const lines: string[] = [];
    console.debug = (...args: unknown[]) => void lines.push(String(args[0]));
    try {
      env.DEV = true;
      addToHistory(OK_URL, "dev");
      expect(lines.length).toBeGreaterThan(0);

      lines.length = 0;
      delete env.DEV; // bun 的 import.meta.env 是 process.env 的活视图；未设 = 生产语义
      addToHistory("https://example.com/quiet", "prod");
      expect(lines).toEqual([]);
    } finally {
      console.debug = realDebug;
      if (previous === undefined) delete env.DEV;
      else env.DEV = previous;
    }
  });
});

