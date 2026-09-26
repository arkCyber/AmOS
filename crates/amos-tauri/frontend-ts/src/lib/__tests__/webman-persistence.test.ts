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
  timeLabel,
  formatFileSize,
  applySafeSearch,
  type Bookmark,
  type HistoryEntry,
  type Download,
  type Tab,
} from "../webman";
import { readQuarantine } from "../amosStore";
import { STATUSES } from "../webmanDownloads";

// ── 内存 localStorage（+ 可切换的写失败 + 一次性"另一个窗口先写了一步"）──────────
const memory = new Map<string, string>();
let failWrites = false;

/**
 * 只拒**若干次**，之后恢复。用来验「调用方的重试循环真的还在跑」——
 * 一个把写盘裁决丢掉的写者会把自己的重试循环在第 1 次之后就短路掉（REQ-A1329）。
 */
let failWritesTimes = 0;

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
      if (failWritesTimes > 0) {
        failWritesTimes--;
        throw new Error("QuotaExceededError");
      }
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
  failWritesTimes = 0;
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

  test("searchHistory：空查询给整段历史、命中 url 或 title、大小写不敏感、null 回空", () => {
    seed(
      HISTORY_KEY,
      Array.from({ length: 25 }, (_, i) => ({
        url: `https://site${i}.example/`,
        title: i === 3 ? "Needle" : `page ${i}`,
        visitedAt: 100 - i,
      })) as HistoryEntry[],
    );
    // 不再截到 20 条（REQ-A1292）：历史面板把它当作「历史记录」画出来，上方就是清空
    // **全部**的那颗按钮 —— 一个看不见边界的窗口会让用户以为 20 条就是全部。
    expect(loadHistory()).toHaveLength(25);
    expect(searchHistory("")).toEqual(loadHistory());
    expect(searchHistory("   ")).toEqual(loadHistory()); // 纯空白与空串同义（本轮修的矛盾）
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

  test("未知总量存成 null 而不是 0，且读回来仍在（REQ-A1613 / F-SH-822）", () => {
    const added = addDownload("https://example.com/stream")!;
    // 分块响应（无 Content-Length）：宿主报 `total: null` ⇒ 百分比**说不出来** ⇒ 存 `null`，
    // 而不是把行里那个 `0` 当成进度。把未知折成 `0` 会让进度条与标签印「0%」（见
    // `WebManApp.svelte`），而同一张卡的字节行此刻正不印总数。
    expect(updateDownload(added.id, null, "downloading")).toBe(true);
    const row = loadDownloads()[0]!;
    expect(row.progress).toBeNull();
    expect(row.status).toBe("downloading");
    // 读侧的验证器必须**放行** `null` —— 否则这条正在下载的行会在下次加载时整行消失
    // （正是 `updateDownload` 里那条 `NaN` 注释警告的形状）。
    expect(loadDownloads()).toHaveLength(1);
    // 反向半边：`null` 合法不等于"什么都收" —— `NaN` 仍被拒（REQ-A405 不被削弱）。
    expect(updateDownload(added.id, Number.NaN)).toBe(false);
    expect(updateDownload(added.id, 150)).toBe(false);
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

  test("store 认得的下载状态恰好是桥声明的那些（REQ-A659）", () => {
    // The bridge's `STATUSES` is the single declaration, bound to the Rust `DownloadStatus`
    // enum by `vocabMirror.test.ts`. Before REQ-A659 the store re-typed its own list next to
    // it, so a status Rust/bridge added could be accepted on one side and silently dropped by
    // `loadDownloadStore` on the other — the exact data loss REQ-A405 fixed, one file over.
    expect(STATUSES.length).toBeGreaterThan(0);
    seed(
      DOWNLOADS_KEY,
      STATUSES.map((status, i) => ({
        id: `s${i}`,
        url: OK_URL,
        filename: "f",
        progress: 0,
        status,
        createdAt: i,
      })) as Download[],
    );
    // Read side: every status the bridge declares survives a reload (none is filtered out).
    expect(loadDownloads().map((d) => d.status)).toEqual([...STATUSES]);
    // Write side: every one is accepted, so no row the UI keeps is un-persistable.
    for (const status of STATUSES) {
      const row = addDownload(OK_URL)!;
      expect(updateDownload(row.id, 10, status), status).toBe(true);
    }
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

// ── 「正在加载」不是会话状态（REQ-A1376 / FMEA F-SH-640）────────────────────────
describe("盘上带着 `loading: true` 回来的标签页，读侧必须把它归零", () => {
  // 「加载完」是由 `WebManApp::markLoading` 排的一枚 800ms 定时器宣布的，而那枚定时器挂在
  // 组件的生命周期上。一次在那 800ms 窗口里结束的会话（关窗 ∕ 崩溃 ∕ 断电）会在盘上留下
  // `loading: true`，而下一个组件里**没有任何东西**能熄掉它 —— 标签条永远转圈，地址栏左端
  // 那个字形（隐私模式的唯一那一面）被永久盖住。这里钉住读侧的那一次归零。
  test("读侧把 `loading: true` 归一化成 `false`", () => {
    seed(TABS_KEY, [
      { id: "tab-1", url: OK_URL, title: "t", loading: true, scrollY: 0, pinned: false },
    ] as Tab[]);
    expect(loadTabs().map((t) => t.loading)).toEqual([false]);
  });

  test("对照组：本来就 `false` 的照旧是 `false`，往返一次也不变", () => {
    seed(TABS_KEY, [
      { id: "tab-1", url: OK_URL, title: "t", loading: false, scrollY: 0, pinned: false },
    ] as Tab[]);
    expect(loadTabs().map((t) => t.loading)).toEqual([false]);
    saveTabs(loadTabs());
    expect(loadTabs().map((t) => t.loading)).toEqual([false]);
  });

  test("落盘的那一行仍**带着** `loading` 这个布尔字段（读侧的必填过滤看得见它）", () => {
    // 负控方向：顺手把字段从写侧删掉会让 `typeof t.loading === 'boolean'` 失败 ⇒
    // **整行标签页**被读侧的过滤丢掉。字段必须在，只是值只能是 `false`。
    saveTabs([createTab(OK_URL)]);
    const row = read(TABS_KEY).data[0];
    expect(typeof row.loading).toBe("boolean");
    expect(row.loading).toBe(false);
  });
});

// ── 安全搜索的域名边界（本轮修复的缺陷回归）───────────────────────────────────
describe("version 不是数字的 store 仍然可写（REQ-A404）", () => {
  // 读侧把非数字 version 归一化为 0（`loadXStore`），写侧却拿**原值**比对
  // （`current.version !== expectedVersion`）⇒ `undefined !== 0`，于是每一次写都失败、
  // 重试 3 次后放弃：**这份 store 永远写不进去**，而当时 `addToHistory` 签 void
  // ⇒ 用户看不到任何提示（REQ-A1357 已让它回报裁决）。一个"有行、没 version"的 store
  // （旧版本/导入器/手工编辑）一次加载即可复现，不需要任何并发。
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
  test("历史：拒写 ⇒ addToHistory 回报 false，且**一条都没落盘**（失败不得被读成成功）", () => {
    expect(addToHistory(OK_URL, "写得进去")).toBe(true);
    expect(loadHistory()).toHaveLength(1); // 先证明这条路径平时是通的
    failWrites = true;
    expect(addToHistory("https://example.com/second", "写不进去")).toBe(false);
    expect(loadHistory().map((h) => h.url)).toEqual([OK_URL]); // 没有半条记录
  });

  test("历史：隐私模式**有意不记** ⇒ 也回 false，但盘上没有半条（与拒写区分在调用方）", () => {
    expect(addToHistory(OK_URL, "隐私", true)).toBe(false);
    expect(loadHistory()).toHaveLength(0);
    // 存储是好的：一个非隐私的写立刻进得去 —— 证明上面那个 false 不是拒写。
    expect(addToHistory(OK_URL, "公开")).toBe(true);
    expect(loadHistory().map((h) => h.url)).toEqual([OK_URL]);
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
    expect(clearCompletedDownloads()).toBe(false); // 拒写 ⇒ 判定为 false，而不是无从知道
    expect(loadDownloads().map((x) => x.id)).toEqual([d.id]);
    expect(loadDownloads()[0]?.progress).toBe(0);
    failWrites = false;
    expect(updateDownload(d.id, 42, "downloading")).toBe(true);
    expect(loadDownloads()[0]).toMatchObject({ progress: 42, status: "downloading" });
    expect(clearCompletedDownloads()).toBe(true); // 没有可清的 ⇒ 写入仍落盘，判定成功
    expect(loadDownloads()).toHaveLength(1); // 未完成的还在
    expect(updateDownload(d.id, 100, "completed")).toBe(true);
    expect(clearCompletedDownloads()).toBe(true);
    expect(loadDownloads()).toEqual([]);
  });

  test("标签页：saveTabs 如实回报裁决（拒写 ⇒ false 且读回来还是旧内容；能写 ⇒ true）", () => {
    // 修前这一条叫「saveTabs 是 void，但失败时读回来还是旧内容」—— 它把「调用方收不到
    // 裁决」当成背景条件钉了下来。REQ-A1350 / FMEA F-SH-613 之后这句话不再是事实
    // （`saveTabs` 问过存储才作答），标题与断言一起改。
    expect(saveTabs([createTab("https://example.com")])).toBe(true);
    const before = loadTabs();
    failWrites = true;
    expect(saveTabs(before.map((t) => ({ ...t, scrollY: 99 })))).toBe(false);
    expect(loadTabs().map((t) => t.scrollY)).toEqual(before.map((t) => t.scrollY));
    failWrites = false;
    expect(saveTabs(before.map((t) => ({ ...t, scrollY: 99 })))).toBe(true);
    expect(loadTabs().map((t) => t.scrollY)).toEqual([99]);
  });

  test("历史：addToHistory 的**第一次**写被拒 ⇒ 那条记录（重试后）仍然落盘", () => {
    addToHistory(OK_URL, "第一");
    expect(loadHistory()).toHaveLength(1); // 先证明这条路径平时是通的
    failWritesTimes = 1; // 只拒一次：配额瞬满 / 桥抖一下，下一次就能写
    addToHistory("https://example.com/second", "第二");
    // 两条都在（顺序不钉：同一毫秒内 `visitedAt` 相等，排序是并列的）。
    expect(loadHistory().map((h) => h.url).sort()).toEqual([
      "https://example.com/page",
      "https://example.com/second",
    ]);
  });

  test("标签页：saveTabs 的**第一次**写被拒 ⇒ 新的滚动位置（重试后）仍然落盘", () => {
    saveTabs([createTab("https://example.com")]);
    const before = loadTabs();
    failWritesTimes = 1;
    saveTabs(before.map((t) => ({ ...t, scrollY: 99 })));
    expect(loadTabs().map((t) => t.scrollY)).toEqual([99]);
  });

  test("历史：clearHistory 问过存储才作答（拒写 ⇒ false 且记录还在；能写 ⇒ true）", () => {
    addToHistory(OK_URL, "还在");
    failWrites = true;
    expect(clearHistory()).toBe(false); // 不再是 void：调用方知道这次没清掉
    expect(loadHistory()).toHaveLength(1);
    failWrites = false;
    expect(clearHistory()).toBe(true);
    expect(loadHistory()).toEqual([]);
  });

  test("设置：saveSettings 问过存储才作答（拒写 ⇒ false 且读回来还是旧值）", () => {
    saveSettings({ homepage: "https://example.com/home" });
    expect(loadSettings().homepage).toBe("https://example.com/home");
    failWrites = true;
    expect(saveSettings({ homepage: "https://example.com/other" })).toBe(false);
    expect(loadSettings().homepage).toBe("https://example.com/home");
    failWrites = false;
    expect(saveSettings({ homepage: "https://example.com/other" })).toBe(true);
    expect(loadSettings().homepage).toBe("https://example.com/other");
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

describe("closeTab / timeLabel / formatFileSize 的边界（REQ-A405）", () => {
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

  test("timeLabel：非法 / 越界时间戳回 unknown，而不是 Invalid Date", () => {
    expect(timeLabel(-1).kind).toBe("unknown");
    expect(timeLabel(NaN).kind).toBe("unknown");
    expect(timeLabel(Infinity).kind).toBe("unknown");
    expect(timeLabel(1e20).kind).toBe("unknown"); // Number.isFinite 通过，但 Date 已越界
    expect(timeLabel("123" as unknown as number).kind).toBe("unknown");
  });

  test("timeLabel：今天给时刻、昨天给 yesterday、一周内给星期、更早给月日", () => {
    const now = Date.now();
    const today = timeLabel(now);
    expect(today.kind).toBe("clock");
    expect(today.kind === "clock" && today.text).toMatch(/\d/);
    expect(timeLabel(now - 86400000).kind).toBe("yesterday");
    expect(timeLabel(now - 3 * 86400000).kind).toBe("weekday");
    // 更早：给日期，不是 yesterday/unknown
    expect(timeLabel(now - 30 * 86400000).kind).toBe("date");
  });

  test("timeLabel：clock/weekday/date 的文本跟随 locale（英文界面不出现中文）", () => {
    const now = Date.now();
    const d = timeLabel(now - 3 * 86400000, "en");
    expect(d.kind).toBe("weekday");
    expect(d.kind === "weekday" && /[一-鿿]/.test(d.text)).toBe(false);
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

// ── `canceled` 是一个新的终态：真实下载管线（lib/webmanDownloads.ts）会写它。
//    这里钉住存储契约的读侧——写进去的行必须能读回来（REQ-A405 那一类"写了读不回"）。
describe("canceled 状态可落盘且可读回", () => {
  test("canceled 行不会被读侧当成协议外状态丢掉", () => {
    const d = addDownload(OK_URL, "a.bin")!;
    updateDownload(d.id, 30, "downloading");
    expect(updateDownload(d.id, 0, "canceled")).toBe(true);
    expect(loadDownloads()[0]).toMatchObject({ progress: 0, status: "canceled" });
  });
});

