<script lang="ts">
  // WebManApp.svelte — Chrome 风格浏览器应用 (航空航天级)
  // 
  // 功能:
  // - 标签页管理 (多标签、创建、关闭、固定)
  // - 地址栏 + 搜索引擎
  // - 书签管理
  // - 历史记录
  // - 下载管理
  // - 隐私模式
  // - 移动/桌面自适应布局
  // 
  // 安全特性:
  // - XSS 防护 (URL 协议过滤)
  // - 错误边界 (优雅降级)
  // - 输入验证 (长度/格式检查)
  // - CSP 兼容 (iframe sandbox)
  import { onMount, onDestroy } from "svelte";
  import ErrorBoundary from "./modules/ErrorBoundary.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { t, locale } from "./locale.svelte";
  import { currentFormFactor } from "../lib/formAuthority.svelte";
  import { webManInline } from "../lib/formLayout";
  import {
    type BrowserIntent,
    type ClosedTab,
    type NavStack,
    type Tab,
    type HistoryEntry,
    type WebManSettings,
    BROWSER_SHORTCUT_HINTS,
    browserIntent,
    closedTabFrom,
    emptyNavStack,
    goBackNav,
    goForwardNav,
    canGoBackNav,
    canGoForwardNav,
    pushNavEntry,
    pushClosedTab,
    reopenClosedTab,
    loadBookmarks,
    loadDownloads,
    loadSettings,
    saveSettings,
    loadTabs,
    saveTabs,
    createTab,
    closeTab,
    setTabPinned,
    tabIndexForOrdinal,
    cycleTabIndex,
    addBookmark,
    removeBookmark,
    bookmarkMatches,
    isBookmarked,
    addToHistory,
    clearHistory,
    searchHistory,
    parseInput,
    extractDomain,
    extractTitle,
    getFaviconUrl,
    timeLabel,
    formatFileSize,
    sanitizeUrl,
    applySafeSearch,
    safeSearchGapForEngine,
    iframeSandbox,
    openInExternalBrowser,
    addDownload,
    removeDownload,
    updateDownload,
    clearCompletedDownloads,
    pruneDownloadBytes,
    pruneById,
    debounce,
    logger,
  } from "../lib/webman";
  import {
    type CookieRecord,
    type DownloadProgressEvent,
    startDownload,
    cancelDownload,
    listCookies,
    clearCookies,
    onDownloadProgress,
  } from "../lib/webmanDownloads";

  // 状态
  let tabs = $state<Tab[]>(loadTabs());
  let activeTabId = $state<string>("");
  let inputValue = $state("");
  /**
   * 侧边栏一次只显示**一**个面板，所以它是**一**个值 —— 不是四个布尔量。
   *
   * 原来是四个（`showBookmarks` / `showHistory` / `showDownloads` / `showSettings`），侧边栏用一条
   * `{#if}{:else if}` 链在它们之间挑选，链序是 书签 → 历史记录 → 下载内容 → 设置；而**每个入口只置自己那一个**。
   * 于是某个靠前的面板已经开着时再去开一个靠后的：屏幕上仍是原来那个 —— 书签开着时点「菜单 ▸ 历史记录」
   * 置了 `showHistory = true`，侧边栏照旧画 ⭐ 书签，**用户按下的那一行什么也没发生**。
   * 只有 ✕ 与 Escape 会把四个一起清掉，这是它与「设计」的分野：**关闭者知道四个是一个选择器，打开者不知道**。
   *
   * 一个值让这条不变量变成结构性的：面板**就是**被点名的那个，开另一个就替换掉它（同 `FilesApp` 的单一所有者规则）。
   * （REQ-A1087 / FMEA F-SH-400）
   */
  type Panel = "bookmarks" | "history" | "downloads" | "settings";
  let panel = $state<Panel | null>(null);
  let showMenu = $state(false);

  // 设置
  let settings = $state<WebManSettings>(loadSettings());

  /**
   * 「最近关闭的标签页」栈（`⌘⇧T`）。
   *
   * **会话内存**，不落盘 —— 理由写在 `lib/webman.ts` 的 `ClosedTab` 上（新增一个
   * `amos.webman.*` 存储键要连带过 `store-scan` 的分类与 `cloud.ts` 的同步决定，
   * 那是另一块面；浏览器语义本来就是会话级）。
   */
  let closedTabs = $state<ClosedTab[]>([]);

  /**
   * 每个标签页的**导航历史**（地址栏 ← / → 的真源）。
   *
   * 同样是**会话内存**、每个标签页一份：URL 栈进不了 `Tab`（那会改标签页的落盘 schema），
   * 也不该进 —— 浏览器自己的语义就是"标签页活着时能回退，关掉重开就没了"。
   * 键是标签页 id；标签关掉时随它一起丢掉。
   */
  let navStacks = $state<Record<string, NavStack>>({});

  // 派生状态
  const activeTab = $derived(tabs.find((t) => t.id === activeTabId) ?? tabs[0]);
  const activeNav = $derived(navStacks[activeTabId] ?? emptyNavStack());
  const canGoBack = $derived(canGoBackNav(activeNav));
  const canGoForward = $derived(canGoForwardNav(activeNav));

  /**
   * Bumped after every download-store mutation so the `$derived` list re-reads.
   * `loadDownloads()` touches only `localStorage` — not reactive state — so a
   * plain `$derived(loadDownloads())` would compute once and never notice a row
   * added by a background progress event.
   */
  let downloadsTick = $state(0);
  const downloads = $derived.by(() => {
    downloadsTick;
    return loadDownloads();
  });

  /**
   * 书签存储的失效信号 —— 与 `downloadsTick` 同一形状，同一理由：`loadBookmarks()` 只读
   * `localStorage`，Svelte 看不见它，所以「用户刚收藏了这一页」这件事必须先变成一个**响应式的**变化
   * 才谈得上重画（REQ-A1230）。
   */
  let bookmarksTick = $state(0);
  const bookmarks = $derived.by(() => {
    bookmarksTick;
    return loadBookmarks();
  });

  /**
   * 收藏星读的是**存储**，而它唯一的响应式依赖是 `activeTab` ⇒ 收藏成功之后字形不会变。
   * `isBookmarked` 本身没问题（它每次都真去读一遍存储），缺的是**叫它重读的那个信号**；
   * 挂上 `bookmarksTick` 就有了。
   */
  const activeBookmarked = $derived.by(() => {
    bookmarksTick;
    return activeTab?.url ? isBookmarked(activeTab.url) : false;
  });

  /**
   * 「安全搜索」在当前选中的引擎上**有没有效果**？无效 ⇒ 那个宿主名，有效 ⇒ `null`。
   *
   * 关掉开关就没什么可说的（`null`）：那时它在**任何**引擎上都不生效，提示反而成了噪音。
   * 这条提示是那句「覆盖缺口也是被说出来的」的**读者** —— 在此之前
   * `SAFE_SEARCH_UNMAPPED_HOSTS` 只被测试读，用户从没被告知（REQ-A1333）。
   */
  const safeSearchGap = $derived(
    settings.safeSearch ? safeSearchGapForEngine(settings.searchEngine) : null,
  );

  /** Live byte counts from progress events, keyed by download id (in-memory). */
  let downloadBytes = $state<Record<string, { received: number; total: number | null }>>({});

  /**
   * **Why** a transfer failed, keyed by download id (in-memory, like `downloadBytes`).
   *
   * The host fills this in and the bridge validates it (`DownloadProgressEvent.error`,
   * non-null only when `status === "failed"`) — but nothing read it, so a failed row said
   * only 「失败」 and the reason the host had gone to the trouble of producing (an HTTP
   * status, a disk error from the sink) never reached the user. It lives in memory rather
   * than on the stored row because the transfer is gone after a restart: a stale reason
   * attached to a `failed` row loaded from storage would be a claim about a run that is no
   * longer the one on screen. Cleared on retry / completion / cancellation.
   */
  let downloadErrors = $state<Record<string, string>>({});

  /**
   * The pipeline's cookie jar, shown in the site-data panel.
   *
   * `null` = **宿主没有作答**（REQ-A1318 / F-SH-591），与 `[]`（jar 真的是空的）是
   * 两个事实。把 `null` 画成 `[]` 会让界面替一个没被问到的 jar 说「没有站点数据」。
   */
  let cookies = $state<CookieRecord[] | null>(null);

  // iframe 引用
  let iframeRef = $state<HTMLIFrameElement | null>(null);

  /** 地址栏引用 —— `⌘L` 用它，不用 `document.querySelector`（见 `runBrowserIntent`）。 */
  let addressInputRef = $state<HTMLInputElement | null>(null);

  // Toast 消息
  let toastMessage = $state("");
  let toastVisible = $state(false);

  /** 一条 toast 自灭的时限 —— 也是它唯一的"结束"途径（见 `showToast`）。 */
  const TOAST_MS = 3000;
  /** 当前那条 toast 的自灭定时器。有句柄才取消得掉下一条、才清得掉卸载。 */
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 播一条 toast。**先取消上一条的定时器**：这个槽位一次只说一件事，而上一条那句
   * 「3 秒后自己消失」说的是**上一条**的 3 秒 —— 不取消，后一条就被前一条的闹钟提前熄掉
   * （相隔 1 秒的两条：后一条只亮 2 秒），屏幕上那句话的寿命与它自己的动作无关。
   * 新一次动作开始时清掉上一次的结果，与本仓其它"结果位"同一条纪律。
   */
  function showToast(message: string) {
    toastMessage = message;
    toastVisible = true;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toastVisible = false;
    }, TOAST_MS);
  }

  /**
   * 历史时间标签 → 可显示字符串。`timeLabel` 只给语言无关的描述符；`yesterday` /
   * `unknown` 是**词**，在这里走 `t()`（跟随当前 locale），其余是已按 locale 格式化好的量。
   */
  function formatHistoryTime(ts: number): string {
    const label = timeLabel(ts, locale());
    switch (label.kind) {
      case "clock":
      case "weekday":
      case "date":
        return label.text;
      case "yesterday":
        return t("webman.time.yesterday");
      case "unknown":
        return t("webman.time.unknown");
    }
  }

  // 内联渲染判断 —— **来自宿主的设备类别，不来自视口**（`lib/formLayout.ts` 规则 1：
  // "The class comes from the host, never from the viewport"）。`currentFormFactor()`
  // 返回 `null` 是"宿主尚未作答"的诚实态 ⇒ 按手机（保守）⇒ 显示"用浏览器打开"卡片。
  const inline = $derived(webManInline(currentFormFactor() ?? "phone"));

  /**
   * 地址栏说的是**现在活动的那一页** —— 只在"活动标签页被别的东西换掉了"时调用。
   *
   * 内容区画的是 `src={activeTab.url}`，地址栏从这里取同一个 `activeTab` ⇒ 两个面**不可能**
   * 对"当前是哪一页"给出两个答案（那正是 REQ-A1209／F-SH-496 那类缺陷）。两处"换页"此前漏了
   * 这一句：恢复会话（`loadTabs()` 带着 URL 回来，地址栏却停在初值 `""`）与关掉活动标签页
   * （`removeTab` 把 `activeTabId` 交给接管的那一个，地址栏继续写着刚被关掉的那一页 —— 而它
   * 是 Enter 的输入，用户按回车会把接管页导航到上一个页面的地址）。见 REQ-A1276。
   *
   * 不写成挂在 `activeTab` 上的 `$effect`：那个派生值每次 `tabs` 被重写（`markLoading` 的
   * 800ms 收尾、`saveTabs`…）都会换一个对象身份，effect 于是反复触发，把用户**正在地址栏里
   * 打的半截字**冲掉 —— 而那些时候 `activeTab.url` 一个字都没变。
   */
  function mirrorAddressToActiveTab() {
    // 接管页可能是一张空白页（关掉最后一个标签时 `closeTab` 会补一张），`?? ""` 让地址栏
    // 如实空着，而不是留着上一页的地址。
    inputValue = activeTab?.url ?? "";
  }

  // 初始化 activeTabId
  $effect(() => {
    if (!activeTabId && tabs.length > 0) {
      activeTabId = tabs[0]!.id;
      // 落盘的标签页带着 URL 回来 ⇒ 地址栏也要跟着（否则一个有内容的页面配一个空地址栏）。
      mirrorAddressToActiveTab();
    }
  });

  // 导航 - 增强安全版
  /**
   * Chrome 风格的「主页」按钮：导航到 `settings.homepage`（REQ-A600）。
   *
   * 这条入口是 `homepage` 设置**唯一**的消费者 —— 修前它被声明、被默认、被反序列化，
   * 却没有任何代码路径读它（一个"可设置的主页"却没有去主页的方法）。
   * 复用 `navigate` ⇒ 走同一套 URL 清洗与安全搜索，不会为"主页"开一条旁路。
   */
  function goHome() {
    navigate(settings.homepage);
  }

  /**
   * 「在外部浏览器中打开」—— 当站点用 `X-Frame-Options` / `frame-ancestors` 拒绝被嵌入时，
   * 壳内 iframe 只能显示一片空白（且 `onerror` **通常不会触发**），用户没有任何出路。
   * 这条出口把当前 URL 交给宿主的系统浏览器。`openInExternalBrowser` 返回布尔而非 `void`：
   * 宿主没提供 opener 时如实说失败，不假装打开过（无 opener 时 `globalThis.open` 静默丢弃）。
   */
  function openExternally() {
    const url = activeTab?.url;
    if (!url) return;
    if (!openInExternalBrowser(url)) {
      showToast(t("webman.toast.openExternalFailed"));
    }
  }

  function navigate(url?: string) {
    const targetUrl = url ?? parseInput(inputValue, settings.searchEngine);
    if (!targetUrl) {
      showToast(t("webman.toast.invalidUrl"));
      return;
    }

    // 验证 URL 安全性
    const validation = sanitizeUrl(targetUrl);
    if (!validation.valid) {
      showToast(validation.error || t("webman.toast.urlValidationFailed"));
      logger.error('Navigation blocked:', validation.error);
      return;
    }

    const safeUrl = validation.sanitized || targetUrl;

    // 应用安全搜索
    const finalUrl = applySafeSearch(safeUrl, settings.safeSearch);

    loadUrl(finalUrl, true);
  }

  /**
   * 把当前标签会话落盘，拒写时**说出口**；答这份会话有没有存下。
   *
   * `saveTabs` 现在如实回报裁决（REQ-A1350 / FMEA F-SH-613）。用户意图的落点（导航 ∕ 开 ∕
   * 关 ∕ 固定 ∕ 恢复）都经这里 —— 拒写时屏幕必须有一句话，否则用户看到的是一次「成功」的
   * 固定，重启之后标签页却回到上次保存的样子，中间一个字都没有。
   *
   * 拒写**不回退**内存里的会话：标签页是**活的**浏览状态（用户正在看、正在用），回退等于让
   * 一台存储写不进去的机器连关标签页都做不到 —— 那是比「重启后不在了」更大的伤害，而且
   * 不可恢复。偏好类（主页 ∕ Launchpad 布局）才回退内存，因为那些值的**唯一**用途就是持久化；
   * 会话不是（它此刻正被使用）。拒写只让「重启后还在不在」这一件事为假，并如实说出来。
   *
   * `markLoading` 的两处落盘**刻意不**经这里：那两笔写的是 `loading` 这个瞬时指示位，不是
   * 用户意图；同一个手势里那次真正的 URL 落盘（`loadUrl`）已经在说话了，在这里再播一句只会
   * 让一次点击说两遍同一件事（`guard scope == its reason`）。
   */
  function persistSession(): boolean {
    const saved = saveTabs(tabs);
    if (!saved) {
      showToast(t("webman.toast.sessionNotSaved"));
    }
    return saved;
  }

  /** 加载指示亮多久 —— 宿主没有可订阅的加载信号，这个时限是一句承诺（见 `markLoading`）。 */
  const LOADING_MS = 800;

  /** 每个标签页最多一个未决的「加载结束」定时器，键是标签页 id。 */
  const loadingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 点亮一个标签页的「正在加载」—— 本组件**唯一**一处写 `loading` 的地方。
   *
   * 两件事让它成立：①同一个标签页上新的一次加载**取消**上一次的结束定时器 —— 否则两次
   * 相隔不到 800ms 的导航里，前一次排的闹钟会把**后一页**的指示提前熄掉（屏幕上写着
   * "加载完了"，而那一页才刚开始）；②定时器有句柄，卸载时一次清掉（见 `onDestroy`），
   * 不留一个到期后去改一张已经不在的标签页的时钟。
   *
   * 这段是**有主的模拟**：iframe 的 `onload` 在跨源下本来就不可靠（`handleIframeLoad` 只记
   * 一行日志），"什么时候算加载完"只能由本组件定一个时限 —— 它是一句承诺，不是一个读数。
   */
  function markLoading(id: string) {
    tabs = tabs.map((tab) => (tab.id === id ? { ...tab, loading: true } : tab));
    saveTabs(tabs);

    const pending = loadingTimers.get(id);
    if (pending !== undefined) clearTimeout(pending);
    loadingTimers.set(
      id,
      setTimeout(() => {
        loadingTimers.delete(id);
        tabs = tabs.map((tab) => (tab.id === id ? { ...tab, loading: false } : tab));
        saveTabs(tabs);
      }, LOADING_MS),
    );
  }

  /**
   * 把活动标签页切到 `finalUrl`。
   *
   * `push` 区分两条来路：**地址栏来的**新导航要记进这个标签页的导航历史（并截断前进支路），
   * 而 ← / → 自己引起的加载**不记** —— 否则回退一次就多一条历史、两个按钮同步往一个方向长。
   */
  function loadUrl(finalUrl: string, push: boolean) {
    const id = activeTabId;
    if (!id) return;

    if (push) {
      navStacks = { ...navStacks, [id]: pushNavEntry(navStacks[id] ?? emptyNavStack(), finalUrl) };
    }

    inputValue = finalUrl;

    // 更新标签
    tabs = tabs.map((tab) =>
      tab.id === id
        ? { ...tab, url: finalUrl, title: extractTitle(finalUrl), favicon: getFaviconUrl(finalUrl) }
        : tab
    );
    persistSession();

    // 添加历史记录，并把裁决**读回来**（REQ-A1357 / FMEA F-SH-621）。存储拒写时这条访问
    // 真的不在历史里，而历史面板顶部那句会一直挂着，直到下一次记成功 —— 沉默会让用户以为
    // 记下了（同族的 `clearHistory` ∕ `saveTabs` ∕ `addBookmark` 都早已读裁决）。
    const recorded = addToHistory(finalUrl, extractTitle(finalUrl), settings.privateMode);
    if (recorded) {
      // 这一条进了历史 ⇒ 上一次那句「没记下」已经过期，撤掉。
      historyStoreErr = "";
    } else if (!settings.privateMode) {
      // 隐私模式**有意不记**，那不是拒写（`addToHistory` 对两者都回 `false`，分得开是因为
      // 这里手里就有 `settings.privateMode`）；其余情况就是存储拒绝了这次写入。
      //
      // 说在**历史面板顶部**而不是 toast：`showToast` 是**单槽**（见 `showToast`），同一次
      // 导航里 `persistSession()` 刚可能说过「这次会话没能存下」，再播一句会把它立刻盖掉 ——
      // 那样两次失败只剩一条消息，比不播更糟。StoreErrorBar 是持久的一行，不抢槽。
      historyStoreErr = t("webman.history.saveFailed");
    }
    // 存储刚动过 ⇒ 叫历史面板重读（隐私模式下这一下只是白重读一次，不会把没发生的事画出来）。
    historyTick++;

    markLoading(id);
  }

  /** 后退一步（地址栏 ←）。栈已在最旧端时按钮本来就是 disabled，这里再守一道。 */
  function goBack() {
    const id = activeTabId;
    if (!id) return;
    const result = goBackNav(navStacks[id] ?? emptyNavStack());
    if (!result.url) return;
    navStacks = { ...navStacks, [id]: result.stack };
    loadUrl(result.url, false);
  }

  /** 前进一步（地址栏 →）。 */
  function goForward() {
    const id = activeTabId;
    if (!id) return;
    const result = goForwardNav(navStacks[id] ?? emptyNavStack());
    if (!result.url) return;
    navStacks = { ...navStacks, [id]: result.stack };
    loadUrl(result.url, false);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      navigate();
    }
  }

  // iframe 事件处理
  function handleIframeLoad() {
    logger.info('Iframe loaded successfully');
  }

  function handleIframeError() {
    logger.error('Iframe failed to load');
    showToast(t("webman.toast.pageLoadFailed"));
  }

  // ── 这里此前有一个 `message` 监听器（REQ-A501 删掉） ─────────────────────────
  //
  // 它自称「Iframe 通信安全 (P1)」：白名单校验来源 → 校验 `data.type` → `logger.info` 一句
  // 「待处理」，最后一行是 `// TODO: 根据 event.data.type 处理不同的消息类型`。
  // 两条独立读数说明它在**任何模式下都收不到一条消息**：
  //   • 这个 iframe 的 `sandbox` **没有** `allow-same-origin` ⇒ 按 HTML 规范它运行在
  //     **不透明来源**上，`postMessage` 投递过来的 `event.origin` 恒为字符串 `"null"`；
  //   • 白名单是 dev 的 `http://localhost:5173` / `1420` 与生产的
  //     `https://trusted-domain.com`（一个**不存在的占位域名**）—— 两者都不含 `"null"`。
  // ⇒ 那整段「严格验证来源」是一台**永远返回 false 的机器**，而它唯一的可观察行为是：任何页面
  // 往本窗口 `postMessage` 都会在我们的日志里留下 `Blocked postMessage…`（未受信任的内容可以
  // 无限刷我们的日志）。它既没保护什么，也没有被谁使用 —— 与本仓删掉 `openExternal` 那个
  // 「定义了、从没接线」的 seam 同一条理由：**需要时再接上，而不是先留一个假的**。
  //
  // 真正的归宿（不是这个帧）：AmOS 自有 web-bundle 的能力请求桥 ——
  // `lib/sandboxBridge.ts`（纯决策、**默认拒绝**）+ `svelte/ExtAppHost.svelte`（真 origin 宿主）。
  // `docs/permissions-sandbox-audit-plan.md` P3.2 写明它的接线是设备/生态侧工作，**不假装**；
  // 目前没有任何东西持有"可以被授予的能力"，所以每一帧都停在默认拒绝上。

  // 键盘导航 (P1 - 可访问性)
  //
  // 「按下的是哪个键」这件事**不在这里**判断：`browserIntent`（`lib/webman.ts`）是
  // 这些键的唯一解释器，本函数只做派发。原因是原来写在这里的判断里，`⌘⇧T` 那一支比的是
  // `e.key === 't'` —— 而物理键盘上 `Shift+T` 的 `e.key` 是 `"T"`，所以**它从来没有
  // 成立过**（REQ-A496）。这类"按键映射"缺陷只有把映射抽成纯函数才测得到。
  function handleGlobalKeydown(e: KeyboardEvent) {
    const intent = browserIntent(e);
    if (intent) {
      e.preventDefault();
      runBrowserIntent(intent);
      return;
    }

    // Escape: 关闭弹窗（这是**本屏自己的**状态，不是浏览器意图）
    if (e.key === 'Escape') {
      if (panel !== null) panel = null;
    }
  }

  /** 浏览器意图的落点（快捷键与菜单行共用这一处 —— 两条入口不可能给出不同行为）。 */
  function runBrowserIntent(intent: BrowserIntent) {
    switch (intent) {
      case "new-tab":
        addTab();
        return;
      case "close-tab":
        if (activeTabId) removeTab(activeTabId);
        return;
      case "restore-tab":
        restoreLastClosedTab();
        return;
      case "focus-address": {
        // 原来这里用 `document.querySelector('input[type="text"]')` 取"第一个文本框"——
        // 侧栏（历史搜索框）一开，取到的就不是地址栏了。
        addressInputRef?.focus();
        addressInputRef?.select();
        return;
      }
      case "reload":
        reloadActiveTab();
        return;
      case "next-tab":
        cycleTab(1);
        return;
      case "prev-tab":
        cycleTab(-1);
        return;
      default: {
        // `tab-1`…`tab-9`：意图里带着**序号**，落点是"第 N 个标签的下标"。
        // 越界/空标签条时 `tabIndexForOrdinal` 给 `null` ⇒ 这里什么都不做，而不是
        // 假装选中了一个不存在的标签（`activeTabId` 会被赋值成 `undefined` 那一类）。
        const ordinal = TAB_ORDINAL_BY_INTENT[intent];
        if (ordinal === undefined) return;
        const index = tabIndexForOrdinal(ordinal, tabs.length);
        const target = index === null ? undefined : tabs[index];
        if (target) selectTab(target.id);
        return;
      }
    }
  }

  /**
   * 意图 → 序号。**表**，与 `lib/webman.ts` 的 `TAB_ORDINAL_INTENTS` 同一条纪律：
   * `switch` 里 `parseInt(intent.slice(4))` 会在将来新增的非 `tab-*` 意图上静默出错。
   */
  const TAB_ORDINAL_BY_INTENT: Readonly<Partial<Record<BrowserIntent, number>>> = {
    "tab-1": 1,
    "tab-2": 2,
    "tab-3": 3,
    "tab-4": 4,
    "tab-5": 5,
    "tab-6": 6,
    "tab-7": 7,
    "tab-8": 8,
    "tab-9": 9,
  };

  /**
   * 「上一个 / 下一个标签」—— `⇧⌘[` / `⇧⌘]`（环绕）。
   *
   * 走 `selectTab` 而不是直接改 `activeTabId`：`selectTab` 会把地址栏一起搬到新页
   * （REQ-A1276 —— 两处"换页"此前都漏了这一句）。
   */
  function cycleTab(delta: number) {
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const next = cycleTabIndex(index, tabs.length, delta);
    const target = next === null ? undefined : tabs[next];
    if (target) selectTab(target.id);
  }

  /**
   * 刷新当前这一页 —— ⌘R 与工具栏那颗 ↻ **共用**这一处（两条入口不可能给出不同行为）。
   *
   * 刷新只能靠**直接写 frame 的 `src`**：内容帧写的是 `src={activeTab.url}`，值没变时
   * Svelte 不会去碰 DOM，把同一个 URL 再交给它是一次**什么都不做的赋值**。所以这里既
   * 不能走 `navigate()`（那读的是地址栏里的输入 —— 会把用户没按回车的半截文字提交成一次
   * 导航，屏幕上跳到了另一个地址；地址栏空着时还会播报「无效的 URL」），也不能只重新
   * 赋值属性（那什么都不发生）。
   *
   * 手机形态没有引擎帧（`inline` 为 false 时内容区是一张卡片，没有可重取的文档）：
   * 这里什么都不做，也不点亮加载指示 —— 那会替一次不存在的加载背书。
   */
  function reloadActiveTab() {
    const id = activeTabId;
    const tab = tabs.find((t) => t.id === id);
    if (!id || !tab?.url || !iframeRef) return;

    iframeRef.src = iframeRef.src;
    markLoading(id);
    logger.info('Reloading page:', tab.url);
  }

  /**
   * 恢复最近关闭的一个标签（`⌘⇧T` / ⋮ 菜单行）。
   *
   * 三种结果**分得开**地报出来：栈空 =「没有可恢复的标签页」、标签数到顶 =「已达上限」
   * （两者都不消耗历史），成功则把焦点与地址栏一起搬到恢复出来的那一页。
   */
  function restoreLastClosedTab() {
    const result = reopenClosedTab(tabs, closedTabs);

    if (!result.tab) {
      showToast(
        result.outcome === "at-capacity"
          ? t("webman.toast.tabLimitReached")
          : t("webman.toast.noClosedTabs"),
      );
      return;
    }

    tabs = result.tabs;
    closedTabs = result.stack;
    activeTabId = result.tab.id;
    inputValue = result.tab.url;
    // 恢复出来的这一页同样作为它自己导航历史的起点（与 onMount 的落盘标签同一条理由）。
    if (result.tab.url) {
      navStacks = {
        ...navStacks,
        [result.tab.id]: pushNavEntry(emptyNavStack(), result.tab.url),
      };
    }
    // 恢复**成没成**由写盘裁决来答（REQ-A1350 / FMEA F-SH-613）：拒写时 `persistSession`
    // 已经说了「没能存下」，这里不能再叠一句「已恢复」把它盖掉 —— 那正是修前的形状。
    if (persistSession()) {
      showToast(t("webman.toast.tabRestored"));
    }
  }

  // 标签操作
  function addTab(pinned = false) {
    const newTab = createTab("", pinned);
    tabs = [...tabs, newTab];
    activeTabId = newTab.id;
    persistSession();
    inputValue = "";
  }

  function removeTab(tabId: string) {
    const index = tabs.findIndex((t) => t.id === tabId);
    const tab = index === -1 ? undefined : tabs[index];
    if (!tab) return;

    // 固定标签不允许关闭 —— 但**拒绝要说出来**。
    //
    // 原来这一句是光秃秃的 `return`：⋮ 菜单里的「关闭标签页」照旧可点，用户按下之后
    // 屏幕上什么都没有发生、也没有一句话 —— 一个**静默的拒绝**与一个坏掉的按钮在观感上
    // 没有分别（REQ-A1315 / F-SH-588）。给出「怎么才能关」的出路（取消固定）才算完整回答。
    if (tab.pinned) {
      showToast(t("webman.toast.pinnedTabCloseRefused"));
      return;
    }

    // 记在**关闭之前**：`closeTab` 在关掉最后一个标签时会补一张空白页，那时标签条已经
    // 不是用户看到的那个了；位置也取关闭前的下标（恢复时放回原处）。
    closedTabs = pushClosedTab(closedTabs, closedTabFrom(tab, index));

    // 导航历史随标签页一起消失（它是会话内存里"这一页的来路"，标签没了就没有归宿）。
    const restNav = { ...navStacks };
    delete restNav[tabId];
    navStacks = restNav;

    const newTabs = closeTab(tabs, tabId);
    tabs = newTabs;
    if (activeTabId === tabId) {
      activeTabId = newTabs[newTabs.length - 1]?.id ?? "";
      // 关掉的是**活动**那一页 ⇒ 内容区换到接管的那一个，地址栏必须一起换（REQ-A1276）。
      // 只在活动标签页真的换了时才照镜子：关别人的标签页不该动正在地址栏里打的字。
      mirrorAddressToActiveTab();
    }
    persistSession();
  }

  function selectTab(tabId: string) {
    activeTabId = tabId;
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      inputValue = tab.url;
    }
  }

  /**
   * 固定 / 取消固定**当前**标签页（⋮ 菜单一行；键帽无 —— 固定是低频动作，且
   * `⇧⌘P` 之类的组合在别处已被占用）。
   *
   * 这一行是 `Tab.pinned` **唯一**能往回写的地方：修前 `pinned` 只在 `createTab(url, true)`
   * 时被写一次，于是"固定"是一道单向门（REQ-A1315 / F-SH-588）。`setTabPinned` 是纯函数，
   * 返回原数组引用表示"没变化"（找不到 id）—— 那种情况下不播报，因为屏幕上确实什么都没变。
   */
  function toggleActiveTabPinned() {
    const tab = activeTab;
    if (!tab) return;

    const pinned = !tab.pinned;
    const next = setTabPinned(tabs, tab.id, pinned);
    if (next === tabs) return;

    tabs = next;
    // 同上：固定**成没成**（能不能熬过一次重启）由写盘裁决来答，不许无条件播报。
    if (persistSession()) {
      showToast(t(pinned ? "webman.toast.tabPinned" : "webman.toast.tabUnpinned"));
    }
  }

  // 书签操作 - 增强反馈
  function toggleBookmark() {
    if (!activeTab?.url) return;

    if (isBookmarked(activeTab.url)) {
      // REQ-A1347 / FMEA F-SH-612：「判在不在」与「找那一条」必须是**同一个**谓词。
      // `isBookmarked` 比的是**规范化后**的 URL（`sanitizeUrl(url).sanitized` ——
      // `new URL(...).toString()` 会给无路径的地址补上结尾 `/`、把主机名折成小写），
      // 而这里原先是 `b.url === activeTab.url`（**原始**串）⇒ 星是实心的、点下去却找不到那
      // 一条，`if (bookmark)` 直接落空、连一句提示都没有（一个「点得动、没反应」的控件）。
      // 存储里的 `b.url` 本来就是 `addBookmark` 写下的规范化形态，两边用同一个 `bookmarkKey`
      // 才对得上。
      const bookmark = bookmarks.find((b) => bookmarkMatches(b, activeTab.url));
      if (bookmark) {
        // `removeBookmark` returns whether the store took the write (`saveBookmarkStore`
        // can refuse on a version clash, a full/unavailable store, or a rejection) — the
        // sibling add branch below already reads its verdict. Discarding it here announced
        // "已取消收藏" while the star stayed ★, because the glyph re-reads the store.
        const removed = removeBookmark(bookmark.id);
        // 字形与面板都读存储 ⇒ 存储真的动了才叫它们重读（一次被拒的删除不该动画面）。
        if (removed) bookmarksTick++;
        showToast(t(removed ? "webman.toast.bookmarkRemoved" : "webman.toast.bookmarkRemoveFailed"));
      }
    } else {
      const result = addBookmark(activeTab.url, activeTab.title);
      if (result) {
        bookmarksTick++;
        showToast(t("webman.toast.bookmarkAdded"));
      } else {
        showToast(t("webman.toast.bookmarkFailed"));
      }
    }
  }

  /**
   * 设置面板里「主页」那一格的**草稿** —— 编辑它，提交才生效（与已生效的 `settings.homepage`
   * 是两个值）。
   *
   * `null` 意思是「还没被编辑过」，这时格子显示的是**已生效的那个主页**（而不是组件初始化那一刻
   * 的旧值 —— 把 `settings.homepage` 抄进 `$state(...)` 只会捕获初始值，之后再也跟不上，正是
   * REQ-A1179 那一类「长命组件把持久化的键冻在挂载时」的坑；这里让 `null` 代表「跟随」）。
   */
  let homepageDraft = $state<string | null>(null);

  /**
   * 把草稿提交成主页（REQ-A1215）。
   *
   * 这个设置此前**只有读者、没有写者**：🏠 消费 `settings.homepage`（REQ-A600），而全仓没有
   * 一个地方写得进去 —— 唯一的生产者是测试里直接戳 localStorage 的夹具，也就是说「主页」
   * 永远只能是编译期那个默认值，用户无从改。
   *
   * 校验走 `sanitizeUrl`（与 `navigate` 同一条路），失败就**如实说**，并把已生效的值原样留着 ——
   * 一次被拒绝的提交不能顺手把主页换成别的东西。没打 scheme 的输入按 `https` 处理：逼用户在
   * 这一格手打 `https://` 只是惩罚他；这也不放过危险协议（`javascript:` 自带 scheme，原样交给
   * `sanitizeUrl` 去拒）。
   */
  function saveHomepage() {
    const raw = (homepageDraft ?? settings.homepage).trim();
    if (!raw) {
      showToast(t("webman.toast.invalidUrl"));
      return;
    }
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    const check = sanitizeUrl(candidate);
    if (!check.valid) {
      showToast(check.error || t("webman.toast.urlValidationFailed"));
      return;
    }
    const next = check.sanitized || candidate;
    const previous = settings;
    settings = { ...settings, homepage: next };
    // 「已保存」是一句关于**落盘**的断言，所以它必须由写盘裁决来答 —— 不是由"输入通过了
    // `sanitizeUrl`"来答（那是**入参**，即意图，不是结果）。存储拒了就如实说，并把内存里的
    // 主页退回原值：**没存下的东西不许在屏幕上生效**，而草稿留着，用户打的字不丢（REQ-A1331）。
    if (!saveSettings(settings)) {
      settings = previous;
      showToast(t("webman.toast.homepageSaveFailed"));
      return;
    }
    // 回到「跟随已生效的值」：`sanitized` 与用户打的字可能不同（补了 scheme、加了尾斜杠…），
    // 格子里该显示**真正生效**的那个，而不是他打的那串。
    homepageDraft = null;
    showToast(t("webman.toast.homepageSaved"));
  }

  /**
   * 落盘一次设置改动，并**把裁决读回来**：存不下就退回原值、如实说。
   *
   * `saveSettings` 早就问过存储才作答（返回 `boolean`；REQ-A1331 ∕ F-SH-597 正是为此把它从
   * `void` 改过来的），可它下面这五个开关一直写作 `settings = {…}; saveSettings(settings);`
   * —— 裁决写出来就扔了。于是存储拒写时：面板里的开关**翻了**、引擎的选中标记**移了**、
   * 地址栏的 🔒 ∕ 🔓 也换了，而盘上还是旧值 —— 重启（或任何一次重读）之后它们一起弹回去，
   * 中间一个字都没有。用户看到的是一次**成功**的切换，实际上什么都没存下（REQ-A1353 /
   * FMEA F-SH-617；与同面板的兄弟 `saveHomepage` 同一条纪律，也是 F-SH-611 的 Launchpad
   * 布局 ∕ F-SH-596 的同族）。
   *
   * `saveSettings` 的注释里写着这五个不分叉的理由是「它们的 UI 不作出**肯定性声明** ——
   * 它们只改本会话的 `settings`，而那是真的改了」。那条理由是**可查的**，而它不成立：它捍卫
   * 的那一行调的正是 `saveSettings(settings)` —— 一次**存储写入**；而 `settings` 又在挂载时由
   * `loadSettings()` 从这同一口存储读回。屏幕上的开关**就是**那句肯定性声明（一枚拨到 ON 的
   * 开关断言「这项设置是开的」），存储拒写后它说的是一件只存活到下一次挂载的事 —— 那正是
   * 「重启后它自己变了」的形状（memory：`project_prior_round_declared_non_change_carries_a_reason`）。
   *
   * 退回原值而不是只播一句话：这几个值（隐私 ∕ 引擎 ∕ 安全搜索 ∕ 阻止弹窗 ∕ 禁用脚本）都是
   * **偏好**，用户改它就是为了让它**一直**这样；一次没存下的改动留在屏幕上，下一次挂载就会自己
   * 翻回去。写不进去就「不动内存」，与兄弟 `saveHomepage` ∕ Launchpad 的 `commitLayout` 一字不差。
   * （与 F-SH-613 的会话落盘相反：那里**不**回退，因为标签页是**活的**浏览状态，回退会让一台存储
   * 写不进去的机器连关标签页都做不到 —— 偏好才回退，见 F-SH-611。）
   *
   * 签 `void` 而**不**返回 `boolean`：本轮没有读者需要这个裁决（上一轮 F-SH-613 的教训正是
   * 「一个没有读者的裁决不必造出来」）；说话的是屏幕与 toast，它们直接读 `saveSettings` 的答复。
   */
  function commitSettings(next: WebManSettings): void {
    const previous = settings;
    settings = next;
    if (!saveSettings(next)) {
      settings = previous;
      showToast(t("webman.toast.settingsSaveFailed"));
    }
  }

  // 设置操作
  function togglePrivateMode() {
    commitSettings({ ...settings, privateMode: !settings.privateMode });
  }

  function setSearchEngine(engine: WebManSettings["searchEngine"]) {
    commitSettings({ ...settings, searchEngine: engine });
  }

  function toggleSafeSearch() {
    commitSettings({ ...settings, safeSearch: !settings.safeSearch });
  }

  /** 阻止弹窗开关（REQ-A600）—— 真值由 `iframeSandbox` 译进 iframe 的 `sandbox`。 */
  function toggleBlockPopups() {
    commitSettings({ ...settings, blockPopups: !settings.blockPopups });
  }

  /** JavaScript 开关（REQ-A600）—— 同上，关掉即从 `sandbox` 撤掉 `allow-scripts`。 */
  function toggleJavaScript() {
    commitSettings({ ...settings, javaScriptEnabled: !settings.javaScriptEnabled });
  }

  // 下载操作 —— **真实管线**（`lib/webmanDownloads.ts` → `src/webman_download.rs`）。
  //
  // 存储行（`addDownload` / `updateDownload` / …）仍由本模块落盘，但字节搬动由宿主的
  // `webman_download_start` 完成：真的 HTTP GET、真的写盘、进度经事件回来。这里做的
  // 只是把事件折进那条行。事件携带的 id 就是这里 `addDownload` 生成的 id，两边同一把钥匙。
  async function downloadCurrentPage() {
    const url = activeTab?.url;
    if (!url) {
      showToast(t("webman.toast.invalidUrl"));
      return;
    }
    const filename = activeTab.title || url;
    const row = addDownload(url, filename);
    if (!row) {
      showToast(t("webman.download.downloadAddedFailed"));
      return;
    }
    downloadsTick++;

    const started = await startDownload(url, row.filename, row.id);
    if (!started) {
      // 这一行的收尾写入要**读**（REQ-A1344）：存储若拒了它，刚加的那条行仍停在
      // `pending` —— 面板会永远显示「等待中」和一颗「取消」，而这次传输宿主根本没开始
      // （失败的那句话 3 秒后就没了）。兄弟 `onCancelDownload` 读的正是这个判定。
      const noted = updateDownload(row.id, 0, "failed");
      if (noted) downloadsTick++;
      showToast(t(noted ? "webman.download.downloadAddedFailed" : "webman.download.failureNotRecorded"));
      return;
    }
    showToast(t("webman.download.downloadAdded"));
  }

  /**
   * 已交给宿主、但那条行还没随存储重画出来的下载 id（一次按键 = 一次传输）。
   *
   * 行是从存储重读画出来的（`downloadsTick` 触发 `$derived`），而状态要等 Svelte 冲一次
   * 才会落到 DOM —— 于是从「点下重试」到「重试按钮消失」之间有一个窗口，第二次点会落到
   * **同一行**上。宿主对**已在传输中的 id** 并不照用，而是**另铸一个新 id**
   * （`crates/amos-tauri/src/webman_download.rs::begin`：只有 `!cancel.contains_key(candidate)`
   * 才照用调用方给的 id）；而进度事件是按 `event.id` 折进存储行的
   * （`applyProgress` → `updateDownload(event.id, …)`），新 id 落不到任何一行
   * （"Download not found"，判定被丢弃）⇒ 那次传输**没有行**：网络上多跑一趟、盘上多一个
   * 文件、完成事件被无声丢掉。
   */
  const starting = new Set<string>();

  /**
   * 重试一条失败的下载：用同一把 id 重新交给宿主，而不是在本地假装又开始跑。
   *
   * 两件事让「一行 = 一次传输」成立：①`starting` 挡住同一行的重入（见上）；②**读**
   * `updateDownload(id, 0, "pending")` 的判定 —— 存储若拒了这次写入，行就仍停在 "failed"
   * （重试按钮还在屏幕上），此时**不得**开始：那会一边真传输、一边让用户以为它没在跑，
   * 下一次点按就撞上同一把 id、被宿主另铸新 id，成为一次**没有行**的传输。
   */
  async function retryDownload(id: string) {
    if (starting.has(id)) return;
    const row = downloads.find((d) => d.id === id);
    if (!row) return;
    starting.add(id);
    try {
      if (!updateDownload(id, 0, "pending")) {
        showToast(t("webman.download.retryNotRecorded"));
        return;
      }
      // 上一次失败的理由说的是**上一次**那次传输，不是这一次。
      downloadErrors = pruneById(downloadErrors, [id]);
      downloadsTick++;
      const started = await startDownload(row.url, row.filename, id);
      if (!started) {
        // 与 `downloadCurrentPage` 同一处漏读（REQ-A1344）：拒写时行停在 `pending`，
        // 「重试」消失而「取消」留着，替一次宿主没开始的传输背书。
        const noted = updateDownload(id, 0, "failed");
        if (noted) downloadsTick++;
        showToast(t(noted ? "webman.download.downloadAddedFailed" : "webman.download.failureNotRecorded"));
      }
    } finally {
      starting.delete(id);
    }
  }

  /**
   * 取消一条在跑的下载，并**读**宿主的答复。
   *
   * `cancelDownload` → `webman_download_cancel`：宿主对**它没有的 id** 回 `false`
   * （`crates/amos-tauri/src/webman_download.rs::webman_download_cancel`；取消标志只在
   * 传输存续期内存在 —— `begin` 里 insert、作业结束时 `take_cancel`）。所以 `false` 是一句
   * **事实**：这次传输不在跑。最常见的情形是**重启**：行是从存储重画出来的（`loadDownloads`），
   * 而传输只活在宿主的**内存**里（`WebmanDownloads`），进程一重启就没了 —— 屏幕于是永远显示一条
   * 「下载中」和一颗按下去毫无反应的「取消」。丢弃这句话就等于让界面一直替一次不存在的传输背书。
   *
   * 所以：宿主收下了取消 ⇒ 什么都不用说（终态事件会把行改成 canceled）；宿主没有这次传输 ⇒
   * 它不可能在跑，如实收尾成 `failed`（可恢复状态，于是长出「重试」）。收尾写入若也被存储拒了，
   * 就照实说，别假装标好了。
   *
   * 上面整段读法都依附在「`false` 是一句事实」上，而那个事实**只有宿主真的答了才成立**
   * （REQ-A1343）：`invoke` 对「命令失败」与「没有桥」都解析 `null`，适配器此前用
   * `?? false` 把「没能问」折成了同一句话 —— 于是桥抖一下，一条**在跑**的传输会被画成
   * `failed`（还长出「重试」），屏幕说「取消已中断」，而宿主的字节还在流。第三种答复
   * 现在是 `null`，它有自己的处理：行**不动**，如实说没得到答复。
   */
  async function onCancelDownload(id: string) {
    const answer = await cancelDownload(id);
    if (answer === null) {
      showToast(t("webman.download.cancelNotAsked"));
      return;
    }
    if (answer) return;
    const noted = updateDownload(id, 0, "failed");
    if (noted) downloadsTick++;
    showToast(t(noted ? "webman.download.cancelInterrupted" : "webman.download.cancelFailed"));
  }

  /**
   * 把一条进度事件折进存储行。
   *
   * 终态（completed / failed / canceled）各自写死进度；`downloading` 时若服务器没给
   * `Content-Length`，进度条停在原处而不是跳一个编出来的数字 —— 不确定就如实不确定。
   */
  function applyProgress(event: DownloadProgressEvent) {
    downloadBytes = {
      ...downloadBytes,
      [event.id]: { received: event.received, total: event.total },
    };

    // 这一行**还在不在**本地列表里 —— 决定 `updateDownload` 的 `false` 是哪一件事。
    //
    // 不在 ⇒ 用户已经删掉了它（`removeDownloadEntry` 会先请宿主停，REQ-A1317），此刻仍在飞的
    // 进度事件本来就该被丢掉，`false` 是**"没这行"**；在 ⇒ `false` 只能是**存储拒写**。
    // 两件事在 `updateDownload` 里是同一个 `false`（它是本仓"一个值两个事实"的老形状），
    // 只能由知道列表的调用方分开 —— 否则一次正常的删除会被报成一次存储故障（REQ-A1358）。
    const known = downloads.some((d) => d.id === event.id);

    let recorded: boolean;
    if (event.status === "canceled") {
      recorded = updateDownload(event.id, 0, "canceled");
      downloadErrors = pruneById(downloadErrors, [event.id]);
    } else if (event.status === "failed") {
      recorded = updateDownload(event.id, 0, "failed");
      // 宿主给的理由如实带出来；它没给（`null`）就照实不编一个。
      downloadErrors = event.error
        ? { ...downloadErrors, [event.id]: event.error }
        : pruneById(downloadErrors, [event.id]);
    } else if (event.status === "completed") {
      // 宿主完成事件里的 `location` 是"文件**真的**落到了哪里" —— 而且这是这一次事件里
      // **唯一**指着一个还在那儿的文件的位置（`webman_download.rs::run_job`：其余各支报的是
      // `.part` 暂存路径，失败 ∕ 取消两支在 emit 之前就 `remove_file` 了，下载中那一支名字
      // 还会被 `place` 改）。字段一直是**必填**的 —— `asProgressEvent` 见它非字符串就丢掉
      // **整条**事件 —— 而界面从来没读过它，于是桌面上下载完的文件，用户在列表里找不到
      // （REQ-A1367 / FMEA F-SH-631；同族 REQ-A1171 ∕ F-SH-466）。随行落盘：文件是**留在**
      // 盘上的，重启后这条说的仍是真话。
      //
      // `event.filename` 是**它采用的那个名字** —— 名字在写盘路上被改过两次
      // （`sanitize_filename`，以及重名时目的地追加 ` (1)`），而这一行一直画的是 `addDownload`
      // 存下的**提议名**（`activeTab.title || url`）。只有完成这一支的 `adopted` 非 `None`
      // （`run_job::emit`），所以也**只有这一支**动行里的名字：下载中的文件还在 `.part` 上、
      // 名字这一刻还不是它有的（REQ-A1370 / FMEA F-SH-634）。
      recorded = updateDownload(event.id, 100, "completed", event.location, event.filename);
      downloadErrors = pruneById(downloadErrors, [event.id]);
    } else {
      // 99% 是「下载中」的上限：100% 只在完成的终态里出现。
      //
      // 响应没有总长（分块传输 ⇒ 宿主报 `total: null`）时，百分比**说不出来**：折成 `null`
      // 而不是保留行里那个 `0` —— 后者会在进度条与标签上印「0%」，而同一张卡下面的字节行
      // 正**不**印总数，同一个事件两个面各说各话（REQ-A1613 / F-SH-822）。`total` 在一次
      // 传输里是常量（`run_job` 在进读循环之前算一次），所以这里不存在"上一拍已知、这一拍
      // 未知"的中间态，无需回退到旧值。
      const fromTotal =
        event.total && event.total > 0
          ? Math.min(99, Math.round((event.received / event.total) * 100))
          : null;
      recorded = updateDownload(event.id, fromTotal, "downloading");
    }

    // 存储拒了这次写入 ⇒ 那一行**仍停在旧状态**：面板从存储行画徽章 ∕ 进度条，于是条不动、
    // 徽章不翻，而 `downloadBytes`（内存读数，照实照涨）在它下面一直涨 —— 传输其实在盘上跑完
    // 了，界面永远不会说「已完成」，刷新之后那行还是旧的，而这是一个**纯背景写入**，没有任何
    // toast 会替它说话（REQ-A1358 / FMEA F-SH-622；同族 REQ-A1343 ∕ REQ-A1344 修的是重试
    // ∕ 收尾那两处，`applyProgress` 是这条路上最后一个把裁决丢掉的写者）。说的位置与前一轮
    // REQ-A1357 的历史写盘同一条纪律：**StoreErrorBar**（持久的一行），不用 `showToast`
    // —— 那是单槽，进度事件又密，抢一句就把别的消息盖掉。
    if (recorded) downloadStoreErr = "";
    else if (known) downloadStoreErr = t("common.storeWriteFailed");

    downloadsTick++;
  }

  /**
   * 从列表里删掉一条下载。
   *
   * REQ-A1317 / F-SH-590：修前这只是 `removeDownload(id)` —— **在跑的传输照跑**。
   * 后果不是"多下载了一个文件"，而是三个面同时说谎：宿主继续写盘、进度事件继续到达，
   * 而 `applyProgress` 折进的那一行**已经不在了**（`updateDownload` 判定 "Download not
   * found"、被丢弃）—— 屏幕上彻底看不见这次传输，用户以为点 ✕ 就停了，实际字节还在流。
   * 所以对 `pending` / `downloading` 的行，**先请宿主停**，再删行。
   *
   * 顺序是 load-bearing 的，但方向与本仓 `F-SH-541` 那条相反：那里是"先写索引再删字节"会
   * 让失败留下不可播的记录；这里删行**不会失败**（`removeDownload` 只是内存 + 存储的删除），
   * 而"请宿主停"**会**（宿主可能没有这次传输）。所以先停、后删：停不掉的那一次已经不在跑
   * （见 `onCancelDownload` 对 `false` 的解释），删掉一行不再跑的传输是诚实的。
   *
   * 「先停、后删」这条顺序的**前提**是"停"给出了答复（REQ-A1343）。`null`＝没能问，
   * 此时既不知道传输在不在跑、也不知道它停没停 —— 删行就是又一次 F-SH-590 那个形状
   * （行没了、字节还在流、进度事件折进一行不存在的记录）。所以这一向**不删**，如实说。
   */
  async function removeDownloadEntry(id: string) {
    const row = downloads.find((d) => d.id === id);
    const inFlight = row?.status === "pending" || row?.status === "downloading";

    if (inFlight) {
      // 收下了 ⇒ 不必在这里播报取消成功（终态事件会把行改成 canceled，行随即被删掉）；
      // 宿主没有这次传输 ⇒ 它不在跑，删掉是诚实的（下面的 toast 说的就是这件事）。
      if ((await cancelDownload(id)) === null) {
        showToast(t("webman.download.removeNotAsked"));
        return;
      }
    }

    if (removeDownload(id)) {
      downloadBytes = pruneDownloadBytes(downloadBytes, [id]);
      downloadErrors = pruneById(downloadErrors, [id]);
      // 存储刚收下一次写入 ⇒ 那句「进度没能落进存储」说的行已经不在了（REQ-A1358）。
      downloadStoreErr = "";
      downloadsTick++;
      showToast(t("webman.download.remove"));
    } else {
      // REQ-A1383：`removeDownload` 的**另一半**答复。以前这里只写了 `if` 那一支，
      // 于是存储三次重试都没落盘时 —— 行留在屏幕上、`downloadsTick` 不升、**一个字也没有**；
      // 一次没生效的删除与一颗坏掉的按钮在屏幕上一模一样。同文件里另外四处同类动作
      // （书签行的 ✕ REQ-A1258、`clearHistory` REQ-A1330、下面的 `onClearCompleted`、
      // 以及本函数自己的 `removeNotAsked` 那一支）都是**两向都说话**，这一支不是例外。
      //
      // 不升 `downloadsTick`：盘上没有变化，重算一遍 `loadDownloads()` 只会重画同一行，
      // 而那句话说的「仍在」正是屏幕此刻的样子 —— 播报与画面不许互相打脸（REQ-A1358 的教训）。
      //
      // 为什么门禁没看见：`write-scan` 审的是**被丢弃的**裁决，而这里裁决**被读了** ——
      // 缺的是那个 `else` 分支，不是一次丢掉的答复。
      showToast(t("webman.download.removeFailed"));
    }
  }

  function onClearCompleted() {
    // 被清掉的行集合必须在**清除之前**取：清完 `downloads` 里已查不到它们，
    // 而 `downloadBytes` 正是按这些 id 建的条目（兄弟 `removeDownloadEntry` 逐个剪，
    // 这里一次性剪同一份账 —— 否则每清一次都在内存里留一批死字节计数）。
    const cleared = downloads.filter((d) => d.status === "completed").map((d) => d.id);
    // `clearCompletedDownloads` 问过存储才作答（同上面 `removeDownloadEntry` 的兄弟写法）。
    // 丢掉判定就会在存储拒写时播报「已清除」，而列表一行没少。
    if (clearCompletedDownloads()) {
      downloadBytes = pruneDownloadBytes(downloadBytes, cleared);
      downloadErrors = pruneById(downloadErrors, cleared);
      // 同上：存储刚收下一次写入 ⇒ 那句失败的通知已过期（REQ-A1358）。
      downloadStoreErr = "";
      downloadsTick++;
      showToast(t("webman.download.clearCompleted"));
    } else {
      showToast(t("webman.download.clearFailed"));
    }
  }

  // 站点数据（cookie jar）—— 宿主那口真实 jar 的只读视图 + 一键清空。
  async function refreshCookies() {
    cookies = await listCookies();
  }

  /**
   * 清空 jar：**三句话分得开**。
   *
   * ① 宿主没作答（`null`）⇒ 说「没能清除」。原来这里根本不看答复，`clearCookies()` 的
   * `?? 0` 把"没桥"折成"清了 0 条"，屏幕上照旧播报「已清除站点数据」—— 一次**没发生**
   * 的清除被说成了事实（REQ-A1318 / F-SH-591）。② 清了 N 条 ⇒ 说它清掉了。③ 重读列表：
   * 重读自己也可能没作答，那时面板画的是「无法读取」而不是「没有站点数据」。
   */
  async function clearSiteData() {
    const dropped = await clearCookies();
    await refreshCookies();
    showToast(t(dropped === null ? "webman.cookies.clearFailed" : "webman.cookies.cleared"));
  }

  // 搜索过滤 - 使用防抖
  let historyQuery = $state("");

  /**
   * 历史存储的失效信号（同 `downloadsTick` / `bookmarksTick`）。
   *
   * 此前这里的两半都停在旧值上：`filteredHistory` 只由挂在 `historyQuery` 上的防抖写，
   * 而空查询那一支读的是 `history = $derived(loadHistory())` —— 一个**在挂载后第一次被读到时
   * 就冻住**的快照（`$derived` 没有响应式依赖就永不重算）。于是「本次会话访问过的页面」
   * 在历史面板里看不见，`clearHistory()` 之后行也留在屏幕上（REQ-A1230）。
   *
   * 现在两条路都走 `searchHistory`（它每次真读存储），并由这个 tick 负责喊「重读」：防抖只挂在
   * 「用户打字」上这件事保持不变，存储被动过时也只是多等一个防抖窗口。
   */
  let historyTick = $state(0);
  let filteredHistory = $state<HistoryEntry[]>([]);

  /**
   * 「这一次访问没能记进历史」那一句（`StoreErrorBar` 唯一的内容源）。
   *
   * 由 `loadUrl` 依 `addToHistory` 的裁决写入，下一次记成功时清掉。持久 —— 它说的是一件
   * 仍然成立的事（盘上确实少一条），不是一个转瞬即逝的提示（REQ-A1357 / FMEA F-SH-621）。
   */
  let historyStoreErr = $state("");

  /**
   * 「这一次进度写入没能落进存储」那一句（下载面板顶部的 `StoreErrorBar`）。
   *
   * 与 `historyStoreErr` 同一形状、同一理由：进度事件是**背景写入**，没有 toast 会替它说话，
   * 而拒写之后面板会一直画着一根不动的条（行停在旧状态）。持久 —— 它说的是一件**仍然成立**
   * 的事；下一次成功写入时清掉（REQ-A1358 / FMEA F-SH-622）。
   */
  let downloadStoreErr = $state("");

  const debouncedHistorySearch = debounce((query: string) => {
    filteredHistory = searchHistory(query);
  }, 300);

  $effect(() => {
    historyTick;
    debouncedHistorySearch(historyQuery);
  });

  // 生命周期：注册全局事件监听器 (P1 - 安全 & 可访问性)
  /** 下载进度事件的退订句柄（异步拿到，故先存着；见 onDestroy）。 */
  let unlistenProgress: (() => void) | null = null;
  let destroyed = false;

  onMount(() => {
    // 落盘的标签页带着 URL 回来 ⇒ 把那一页作为该标签页导航历史的**起点**。否则"恢复会话
    // 后从这一页导航到别处"就没有来路可退（真实浏览器不会这样）——`loadUrl` 只在导航时入栈，
    // 而恢复出来的这一页没有经过 `loadUrl`。
    const seeded = { ...navStacks };
    for (const tab of tabs) {
      if (tab.url) seeded[tab.id] = pushNavEntry(emptyNavStack(), tab.url);
    }
    navStacks = seeded;

    // 真实下载管线的进度从这里进来（宿主在传输开始后持续 emit）。
    onDownloadProgress(applyProgress).then((un) => {
      // REQ-A838: `null` = 订阅未建立（离线 / 宿主未提供该事件）。此时没有句柄可存或可退，
      // 进度条会停在起始值 —— 那是"我们没在听"，不是"传输没有进展"，
      // 二者由 `bridgeDiag(DOWNLOAD_PROGRESS_EVENT)` 区分。
      if (un === null) return;
      // 组件可能在订阅落定前就被卸载；那时直接退订，别把句柄留在已死的组件上。
      if (destroyed) un();
      else unlistenProgress = un;
    });
    void refreshCookies();

    window.addEventListener('keydown', handleGlobalKeydown);
    logger.info('WebManApp mounted, event listeners registered');
  });

  onDestroy(() => {
    destroyed = true;
    unlistenProgress?.();
    window.removeEventListener('keydown', handleGlobalKeydown);
    // 本组件自己排的两个时钟一起收掉（toast 的自灭、各标签页的加载结束）：留着它们，
    // 到期时会去写一个已经不在屏幕上的组件的状态 —— "加载完了"说的是一张不存在的标签页。
    if (toastTimer !== null) clearTimeout(toastTimer);
    for (const pending of loadingTimers.values()) clearTimeout(pending);
    loadingTimers.clear();
    logger.info('WebManApp destroyed, event listeners cleaned up');
  });
</script>

<!-- 错误边界包装 -->
<ErrorBoundary>
<div class="flex h-full flex-col bg-neutral-100 dark:bg-neutral-900">
  <!-- 标签栏 -->
  <div class="flex items-center gap-1 bg-neutral-200 px-2 py-1.5 dark:bg-neutral-800">
    <!-- 标签列表 -->
    <div class="flex flex-1 items-center gap-1 overflow-x-auto">
      {#each tabs as tab (tab.id)}
        <div
          class="group flex max-w-[160px] min-w-[100px] items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-sm transition-colors {tab.id === activeTabId
            ? 'bg-white dark:bg-neutral-700'
            : 'bg-neutral-300 hover:bg-neutral-200 dark:bg-neutral-700 dark:hover:bg-neutral-600'}"
        >
          <button
            onclick={() => selectTab(tab.id)}
            class="flex min-w-0 flex-1 items-center gap-1.5"
          >
            {#if tab.favicon}
              <img src={tab.favicon} alt="" class="h-4 w-4 shrink-0" />
            {:else}
              <span class="text-base">🌐</span>
            {/if}
            <span class="truncate flex-1 text-xs">{tab.title || t("webman.newTab")}</span>
            <!--
              固定态必须**看得见**：修前 `pinned` 在标签条上没有任何字形，用户点下「新固定标签页」
              之后屏幕上唯一的差别是 ✕ 不见了 —— 既不知道它为什么没有关闭按钮，也不知道它能被取消固定
              （REQ-A1315 / F-SH-588）。
              `aria-hidden` 挂在字形上、真话放在 `sr-only` 里：一个没有 role 的元素上的 `aria-label`
              不命名任何东西（本仓已记过这一类缺陷），而 📌 本身对读屏器只是一个表情。
            -->
            {#if tab.pinned}
              <span aria-hidden="true" class="shrink-0 text-xs">📌</span>
              <span class="sr-only">{t("webman.tabPinned")}</span>
            {/if}
            {#if tab.loading}
              <span class="h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent"></span>
            {/if}
          </button>
          {#if !tab.pinned}
            <button
              onclick={(e) => {
                e.stopPropagation();
                removeTab(tab.id);
              }}
              class="tab-close"
              aria-label={t("webman.closeTab")}
            >
              <span class="text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">✕</span>
            </button>
          {/if}
        </div>
      {/each}
      
      <!-- 新建标签按钮 -->
      <button
        onclick={() => addTab()}
        aria-label={t("webman.newTabButton")}
        class="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-300 text-lg hover:bg-neutral-200 dark:bg-neutral-700 dark:hover:bg-neutral-600"
      >
        +
      </button>
    </div>

    <!-- 菜单按钮 -->
    <div class="flex items-center gap-1">
      <button
        onclick={() => (showMenu = !showMenu)}
        aria-label={t("webman.a11y.menu")}
        aria-expanded={showMenu}
        class="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-neutral-300 dark:hover:bg-neutral-700"
      >
        <span class="text-lg">⋮</span>
      </button>
    </div>
  </div>

  <!-- 工具栏 -->
  <div class="flex items-center gap-2 border-b border-neutral-300 bg-neutral-100 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900">
    <!-- 前进/后退 -->
    <div class="flex items-center gap-1">
      <button
        onclick={goBack}
        disabled={!canGoBack}
        aria-label={t("webman.a11y.back")}
        class="flex h-11 w-11 -my-1 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-800"
      >
        ←
      </button>
      <button
        onclick={goForward}
        disabled={!canGoForward}
        aria-label={t("webman.a11y.forward")}
        class="flex h-11 w-11 -my-1 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-800"
      >
        →
      </button>
      <!-- 刷新（仅桌面/平板：手机形态的内容区是一张卡片，没有引擎帧可重取，见 `reloadActiveTab`） -->
      {#if inline}
        <button
          onclick={reloadActiveTab}
          disabled={!activeTab?.url}
          aria-label={t("webman.a11y.reload")}
          class="flex h-11 w-11 -my-1 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-800"
        >
          ↻
        </button>
      {/if}
      <button
        onclick={goHome}
        aria-label={t("webman.a11y.home")}
        class="flex h-11 w-11 -my-1 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 dark:hover:bg-neutral-800"
      >
        🏠
      </button>
    </div>

    <!-- 地址栏 -->
    <div class="flex flex-1 items-center gap-2">
      <div class="relative flex flex-1 items-center">
        {#if activeTab?.loading}
          <span class="absolute left-3 h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent"></span>
        {:else}
          <!-- 这一格说的是**现在是不是隐私模式**（与设置面板里那一行同一份措辞：🔒 开 / 🔓 关）。
               此前这里是一段两支逐字节相同的分支（`{:else if settings.privateMode}🔒{:else}🔒`），
               于是关着隐私模式时地址栏照样画着隐私模式那把锁 —— 同一块屏幕上两个面给出两个答案，
               而这一面还是冻住的（REQ-A1209 / FMEA F-SH-496）。 -->
          <span class="absolute left-3 text-lg">{settings.privateMode ? "🔒" : "🔓"}</span>
        {/if}
        <input
          type="text"
          bind:this={addressInputRef}
          bind:value={inputValue}
          onkeydown={handleKeydown}
          placeholder={settings.privateMode ? t("webman.privateMode") : t("webman.searchOrEnterUrl")}
          class="h-10 w-full rounded-full bg-neutral-200 pl-10 pr-4 text-sm outline-none focus:ring-2 focus:ring-accent/50 dark:bg-neutral-800 dark:text-white"
        />
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="flex items-center gap-1">
      <!-- 书签 -->
      <!--
        REQ-A1347 / FMEA F-SH-612：★ 是本行里**唯一**没有可访问名的控件（左右邻居都有），
        而它的字形（★ / ☆）不是一个名字 —— 读屏软件念出来只是一个符号。按它当下**会做
        什么**取名：实心 ⇒ 移除，空心 ⇒ 收藏。空标签页上没有 URL 可收藏，与 `⎋` 同一处理
        （`disabled` + 变暗），而不是按下去什么都不发生。
      -->
      <button
        onclick={toggleBookmark}
        disabled={!activeTab?.url}
        aria-label={t(activeBookmarked ? "webman.removeBookmark" : "webman.addBookmark")}
        title={t(activeBookmarked ? "webman.removeBookmark" : "webman.addBookmark")}
        class="flex h-11 w-11 -my-1 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-800"
      >
        {activeBookmarked ? "★" : "☆"}
      </button>

      <!-- 在外部浏览器中打开（仅桌面/平板：手机形态的内容区卡片自带同一出口） -->
      {#if inline}
        <button
          onclick={openExternally}
          disabled={!activeTab?.url}
          aria-label={t("webman.openInExternalBrowser")}
          title={t("webman.openInExternalBrowser")}
          class="flex h-11 w-11 -my-1 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-800"
        >
          ⎋
        </button>
      {/if}

      <!-- 菜单 -->
      <button
        onclick={() => (showMenu = !showMenu)}
        aria-label={t("webman.a11y.menu")}
        aria-expanded={showMenu}
        class="flex h-11 w-11 -my-1 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 dark:hover:bg-neutral-800"
      >
        ⋮
      </button>
    </div>
  </div>

  <!-- 主内容区 -->
  <div class="flex flex-1 overflow-hidden">
    <!-- 侧边栏 -->
    {#if panel !== null}
      <!-- 这一栏是**滚动的**：外面那圈是 `overflow-hidden`（主内容区），而 WebMan 的根是
           `h-full`（chrome 式外壳，自己不长大），所以长度全落在这块区域里 —— 没有滚动容器
           时，折叠线以下的行被裁掉且没有滚动条，**永远够不到**。同组件标签条自己就有
           `overflow-x-auto`，这里补上同形的一层：头部 `shrink-0` 钉住，面板体
           `min-h-0 flex-1 overflow-y-auto` 承担滚动（缺 `min-h-0` 时 flex 项默认
           `min-height:auto` 会被内容顶回原高，`overflow-y-auto` 就是死的）。见 REQ-A1291。 -->
      <div class="flex h-full w-72 flex-col overflow-hidden border-r border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-800">
        <!-- 侧边栏头部 -->
        <div class="flex shrink-0 border-b border-neutral-300 p-3 dark:border-neutral-700">
          {#if panel === "bookmarks"}
            <h2 class="flex-1 text-sm font-semibold">{t("webman.bookmarks")}</h2>
          {:else if panel === "history"}
            <h2 class="flex-1 text-sm font-semibold">{t("webman.history")}</h2>
            <input
              type="text"
              bind:value={historyQuery}
              placeholder={t("webman.searchHistory")}
              class="h-8 rounded-full bg-neutral-200 px-3 text-xs outline-none dark:bg-neutral-700"
            />
          {:else if panel === "downloads"}
            <h2 class="flex-1 text-sm font-semibold">{t("webman.downloadContent")}</h2>
          {:else if panel === "settings"}
            <h2 class="flex-1 text-sm font-semibold">{t("webman.settings")}</h2>
          {/if}
          <button
            onclick={() => {
              panel = null;
            }}
            class="ml-2 text-neutral-500"
            aria-label={t("webman.closeMenu")}
          >
            ✕
          </button>
        </div>

        <!-- 书签列表 -->
        {#if panel === "bookmarks"}
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            {#if bookmarks.length === 0}
              <p class="p-4 text-center text-sm text-neutral-500">{t("webman.noBookmarks")}</p>
            {:else}
              {#each bookmarks as bookmark (bookmark.id)}
                <div class="flex w-full items-center gap-2 rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                  <button
                    onclick={() => {
                      navigate(bookmark.url);
                      panel = null;
                    }}
                    class="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {#if bookmark.favicon}
                      <img src={bookmark.favicon} alt="" class="h-5 w-5" />
                    {:else}
                      <span class="text-base">🌐</span>
                    {/if}
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm">{bookmark.title}</p>
                      <p class="truncate text-xs text-neutral-500">{extractDomain(bookmark.url)}</p>
                    </div>
                  </button>
                  <button
                    onclick={(e) => {
                      e.stopPropagation();
                      // Same verdict as the ★ toggle, and the same invalidation as it too: a
                      // refused removal must be said (the row legitimately stays), a landed one
                      // must take the row away. Without the tick both outcomes looked identical
                      // on screen — no message and the row still there — so a *successful*
                      // delete read as a dead button, and the second click (the id is gone now,
                      // so `removeBookmark` answers false) was the first thing that spoke, with
                      // a failure message about a removal that had already worked (REQ-A1258).
                      if (removeBookmark(bookmark.id)) {
                        bookmarksTick++;
                      } else {
                        showToast(t("webman.toast.bookmarkRemoveFailed"));
                      }
                    }}
                    class="shrink-0 text-neutral-400 hover:text-red-500"
                    aria-label={t("webman.removeBookmark")}
                    title={t("webman.removeBookmark")}
                  >
                    ✕
                  </button>
                </div>
              {/each}
            {/if}
          </div>
        {/if}

        <!-- 历史记录 -->
        {#if panel === "history"}
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <!-- 「这一次访问没能记进历史」—— 存储拒写时那一条**缺席**在列表里（REQ-A1357）。 -->
            <StoreErrorBar message={historyStoreErr} />
            <button
              onclick={() => {
                // 两向都说话：清掉了 ⇒ 行该消失（`historyTick` 让面板重读）；被存储拒了 ⇒
                // 一行不少地留着，那就**必须说出来**，否则一次没生效的清除看起来像按了个空的
                // 按钮（兄弟 `onClearCompleted` 两向都说话，这里原先两个方向都沉默）（REQ-A1330）。
                if (clearHistory()) {
                  historyTick++;
                  // 存储刚收下了一次写入 ⇒ 那句「没记下」已不成立（REQ-A1357）。
                  historyStoreErr = "";
                  showToast(t("webman.toast.historyCleared"));
                } else {
                  showToast(t("webman.toast.historyClearFailed"));
                }
              }}
              class="mb-2 w-full rounded-lg bg-neutral-200 px-3 py-2 text-xs hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600"
            >
              {t("webman.clearHistory")}
            </button>
            {#if filteredHistory.length === 0}
              <p class="p-4 text-center text-sm text-neutral-500">{t("webman.noHistory")}</p>
            {:else}
              {#each filteredHistory as entry (entry.url)}
                <button
                  onclick={() => {
                    navigate(entry.url);
                    panel = null;
                  }}
                  class="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
                >
                  {#if entry.favicon}
                    <img src={entry.favicon} alt="" class="h-5 w-5" />
                  {:else}
                    <span class="text-base">🌐</span>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm">{entry.title}</p>
                    <p class="flex items-center gap-2 text-xs text-neutral-500">
                      <span>{extractDomain(entry.url)}</span>
                      <span>·</span>
                      <span>{formatHistoryTime(entry.visitedAt)}</span>
                    </p>
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        {/if}

        <!-- 下载 -->
        {#if panel === "downloads"}
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <!-- 「这一次进度写入没能落进存储」—— 拒写时那一行**停在旧状态**（REQ-A1358）。 -->
            <StoreErrorBar message={downloadStoreErr} />
            <!-- 顶部两个操作：把活动标签登记成下载 / 清掉已完成 -->
            <div class="mb-2 flex items-center gap-1">
              <button
                onclick={downloadCurrentPage}
                disabled={!activeTab?.url}
                class="flex flex-1 items-center justify-center gap-1 rounded-lg bg-accent/10 px-2 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-40 dark:bg-accent/20 dark:hover:bg-accent/30"
              >
                <span aria-hidden="true">⬇️</span>
                {t("webman.download.downloadCurrent")}
              </button>
              <button
                onclick={onClearCompleted}
                disabled={!downloads.some((d) => d.status === "completed")}
                class="shrink-0 rounded-lg bg-neutral-200 px-2 py-1.5 text-xs hover:bg-neutral-300 disabled:opacity-40 dark:bg-neutral-700 dark:hover:bg-neutral-600"
                aria-label={t("webman.download.clearCompleted")}
              >
                🧹
              </button>
            </div>

            {#if downloads.length === 0}
              <p class="p-4 text-center text-sm text-neutral-500">
                {t("webman.noDownloads")}
                <br />
                <span class="text-xs text-neutral-400">{t("webman.download.noDownloadsHelp")}</span>
              </p>
            {:else}
              {#each downloads as download (download.id)}
                {@const bytes = downloadBytes[download.id]}
                <div class="mb-2 rounded-lg border border-neutral-200 p-2 dark:border-neutral-700">
                  <div class="flex items-start gap-2">
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm">{download.filename}</p>
                      <p class="truncate text-xs text-neutral-500">{extractDomain(download.url)}</p>
                      <div class="mt-1 flex items-center gap-2">
                        {#if download.status === "downloading"}
                          <div class="h-1.5 flex-1 rounded-full bg-neutral-200">
                            {#if download.progress === null}
                              <!-- 总量未知（分块响应）⇒ 不画一根自称 0% 的条，改画一根脉动的
                                   满宽条：它说「在跑」而**不**说「跑了多少」（REQ-A1613）。 -->
                              <div class="h-full w-full animate-pulse rounded-full bg-accent/40"></div>
                            {:else}
                              <div
                                class="h-full rounded-full bg-accent transition-all"
                                style="width: {download.progress}%"
                              ></div>
                            {/if}
                          </div>
                          <span class="text-xs text-neutral-500">
                            {download.progress === null
                              ? t("webman.download.sizeUnknown")
                              : `${download.progress}%`}
                          </span>
                        {:else if download.status === "completed"}
                          <span class="text-xs text-green-500">{t("webman.downloadStatus.completed")}</span>
                        {:else if download.status === "failed"}
                          <span class="text-xs text-red-500">{t("webman.downloadStatus.failed")}</span>
                        {:else if download.status === "canceled"}
                          <span class="text-xs text-amber-500">{t("webman.downloadStatus.canceled")}</span>
                        {:else}
                          <span class="text-xs text-neutral-500">{t("webman.downloadStatus.waiting")}</span>
                        {/if}
                      </div>
                      <!-- 真实字节数（宿主事件回报），例如 "1.2 MB / 3.4 MB" -->
                      {#if bytes && bytes.received > 0}
                        <p class="mt-0.5 truncate text-xs text-neutral-400">
                          {formatFileSize(bytes.received)}{bytes.total
                            ? ` / ${formatFileSize(bytes.total)}`
                            : ""}
                        </p>
                      {/if}
                      <!-- 文件落在哪里（宿主完成事件回报的真实位置）。只有**已完成**的行才有：
                           `Download.location` 也只在那一支写进来（REQ-A1367）。 -->
                      {#if download.status === "completed" && download.location}
                        <p class="mt-0.5 truncate text-xs text-neutral-400" title={download.location}>
                          {t("webman.download.savedTo", { path: download.location })}
                        </p>
                      {/if}
                      <!-- 宿主给的失败原因（HTTP 状态 / 写盘错误），例如 "HTTP 404"。只有失败的行才有。 -->
                      {#if download.status === "failed" && downloadErrors[download.id]}
                        {@const reason = downloadErrors[download.id]!}
                        <p class="mt-0.5 truncate text-xs text-red-400" title={reason}>
                          {t("webman.download.failedReason", { reason })}
                        </p>
                      {/if}
                    </div>
                    <!-- 行内操作：取消（真停传输）、重试（用同一 id 重新交给宿主）、删除 -->
                    <div class="flex shrink-0 items-center gap-1">
                      {#if download.status === "pending" || download.status === "downloading"}
                        <button
                          onclick={() => void onCancelDownload(download.id)}
                          class="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/30"
                          aria-label={t("webman.download.cancel")}
                          title={t("webman.download.cancel")}
                        >
                          {t("webman.download.cancel")}
                        </button>
                      {:else if download.status === "failed" || download.status === "canceled"}
                        <button
                          onclick={() => void retryDownload(download.id)}
                          class="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-blue-100 hover:text-blue-600 dark:hover:bg-blue-900/30"
                          aria-label={t("webman.download.retry")}
                          title={t("webman.download.retry")}
                        >
                          {t("webman.download.retry")}
                        </button>
                      {/if}
                      <button
                        onclick={() => void removeDownloadEntry(download.id)}
                        class="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700"
                        aria-label={t("webman.download.remove")}
                        title={t("webman.download.remove")}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        {/if}

        <!-- 设置 -->
        {#if panel === "settings"}
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <!-- 搜索引擎 -->
            <div class="mb-4">
              <p class="mb-2 px-2 text-xs text-neutral-500">{t("webman.searchEngine")}</p>
              <div class="space-y-1">
                {#each (["google", "bing", "baidu", "duckduckgo"] as const) as engine}
                  <button
                    onclick={() => setSearchEngine(engine)}
                    class="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  >
                    <span class="text-lg">
                      {engine === "google" ? "🔍" : engine === "bing" ? "🔎" : engine === "baidu" ? "🌐" : "🦆"}
                    </span>
                    <span class="text-sm capitalize">{engine}</span>
                    {#if settings.searchEngine === engine}
                      <span class="ml-auto text-accent">✓</span>
                    {/if}
                  </button>
                {/each}
              </div>
            </div>

            <!-- 主页 —— 这一格此前**不存在**：`settings.homepage` 只有读者（🏠，REQ-A600）、
                 没有写者，于是「主页」永远是编译期那个默认值（REQ-A1215）。 -->
            <div class="mb-4">
              <p class="mb-2 px-2 text-xs text-neutral-500">{t("webman.homepage")}</p>
              <div class="flex items-center gap-1 px-2">
                <input
                  type="text"
                  value={homepageDraft ?? settings.homepage}
                  oninput={(e) => (homepageDraft = e.currentTarget.value)}
                  onkeydown={(e) => e.key === "Enter" && saveHomepage()}
                  aria-label={t("webman.homepage")}
                  placeholder={t("webman.homepagePlaceholder")}
                  class="h-8 min-w-0 flex-1 rounded-lg bg-neutral-200 px-3 text-xs outline-none dark:bg-neutral-700 dark:text-white"
                />
                <button
                  onclick={saveHomepage}
                  aria-label={t("webman.homepageSave")}
                  class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                >
                  {t("webman.homepageSave")}
                </button>
              </div>
            </div>

            <!-- 安全设置 -->
            <div class="mb-4">
              <p class="mb-2 px-2 text-xs text-neutral-500">{t("webman.privacySecurity")}</p>
              <div class="space-y-1">
                <button
                  onclick={togglePrivateMode}
                  class="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
                >
                  <span class="text-lg">{settings.privateMode ? "🔒" : "🔓"}</span>
                  <span class="flex-1 text-sm">{t("webman.privateMode")}</span>
                  <div class="h-5 w-9 rounded-full bg-accent p-0.5">
                    <div class="h-full w-full rounded-full bg-white transition-transform {settings.privateMode ? 'translate-x-4' : ''}"></div>
                  </div>
                </button>
                <button
                  onclick={toggleSafeSearch}
                  class="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
                >
                  <span class="text-lg">🛡️</span>
                  <span class="flex-1 text-sm">{t("webman.safeSearch")}</span>
                  <div class="h-5 w-9 rounded-full bg-accent p-0.5">
                    <div class="h-full w-full rounded-full bg-white transition-transform {settings.safeSearch ? 'translate-x-4' : ''}"></div>
                  </div>
                </button>
                {#if safeSearchGap}
                  <!-- 开关亮着、而在选中的引擎上它什么都不做 —— 这句话必须存在，
                       否则用户只会以为「安全搜索」在保护他（REQ-A1333）。 -->
                  <p class="px-2 pb-1 text-xs text-neutral-500">
                    {t("webman.safeSearchGap", { host: safeSearchGap })}
                  </p>
                {/if}
                <button
                  onclick={toggleBlockPopups}
                  class="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
                >
                  <span class="text-lg">🚫</span>
                  <span class="flex-1 text-sm">{t("webman.blockPopups")}</span>
                  <div class="h-5 w-9 rounded-full bg-accent p-0.5">
                    <div class="h-full w-full rounded-full bg-white transition-transform {settings.blockPopups ? 'translate-x-4' : ''}"></div>
                  </div>
                </button>
                <button
                  onclick={toggleJavaScript}
                  class="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
                >
                  <span class="text-lg">📜</span>
                  <span class="flex-1 text-sm">{t("webman.javaScript")}</span>
                  <div class="h-5 w-9 rounded-full bg-accent p-0.5">
                    <div class="h-full w-full rounded-full bg-white transition-transform {settings.javaScriptEnabled ? 'translate-x-4' : ''}"></div>
                  </div>
                </button>
                <!-- 内容承载的诚实边界（REQ-A1560/F3）：站点拒嵌（X-Frame-Options /
                     frame-ancestors）时帧里是一片**空白且不报错**（`onerror` 不触发），
                     用户没有任何解释，也不知道那颗 ⎋ 就是出路 —— 那句话此前只活在代码注释里。
                     只在 `inline`（大屏）显示：手机类别的内容区是一张卡片 + 外部链接，
                     根本没有这个帧，在这里它是一句**不成立**的话。 -->
                {#if inline}
                  <p class="px-2 pt-1 text-xs text-neutral-500">{t("webman.contentBoundary")}</p>
                {/if}
              </div>
            </div>

            <!-- 站点数据（cookie jar）—— 宿主那口真实 jar 的只读视图 + 清空。
                 它是**下载管线**的 jar；iframe 里的页面 cookie 归 WebView 自己，
                 所以这里如实只列本 jar 的内容（空态文案也说明这一点）。 -->
            <div class="mb-4">
              <p class="mb-2 flex items-center justify-between px-2 text-xs text-neutral-500">
                <span>{t("webman.siteData")}</span>
                <button
                  onclick={() => void refreshCookies()}
                  class="rounded px-1.5 py-0.5 text-xs hover:bg-neutral-200 dark:hover:bg-neutral-700"
                  aria-label={t("webman.siteData.refresh")}
                  title={t("webman.siteData.refresh")}
                >
                  ↻
                </button>
              </p>
              <div class="space-y-1">
                <!-- 这一节列的是**下载管线**的 jar（REQ-A1560/F2）：这句话必须**始终**在，
                     不能只活在空态里 —— 列表一旦非空，下面那颗「清除站点数据」看上去就是在清
                     用户的浏览 cookie，而它清不到那些（那份住在宿主 WebView 里）。 -->
                <p class="px-2 pb-1 text-xs text-neutral-400">{t("webman.siteData.scope")}</p>
                {#if cookies === null}
                  <!-- 「没能问」不是「没有」。宿主没作答时画的是这一句，而不是把 `null`
                       折成 `[]` 再告诉用户「没有站点数据」（REQ-A1318 / F-SH-591）。 -->
                  <p class="px-2 py-1 text-xs text-neutral-400">{t("webman.siteData.unavailable")}</p>
                {:else if cookies.length === 0}
                  <p class="px-2 py-1 text-xs text-neutral-400">{t("webman.siteData.empty")}</p>
                {:else}
                  <!-- 不设"只画前 N 条"的上限：这一格回答的是「我的 jar 里有什么」，而外层
                       容器本来就 `max-h-40 overflow-y-auto`（它自己会滚）—— 一个悄悄截断的
                       窗口会让用户数到 20 条就以为那是全部，紧接着那颗「清除站点数据」把
                       **看不见的那些**一起删掉（REQ-A1290）。列表长度由 jar 自己决定。 -->
                  <ul class="max-h-40 overflow-y-auto px-2">
                    {#each cookies as cookie (cookie.domain + '|' + cookie.path + '|' + cookie.name)}
                      <li class="flex items-center gap-2 text-xs text-neutral-500">
                        <span class="truncate">{cookie.domain || "—"}</span>
                        <span class="truncate text-neutral-400">{cookie.name}</span>
                      </li>
                    {/each}
                  </ul>
                  <button
                    onclick={() => void clearSiteData()}
                    class="w-full rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-500/20 dark:text-red-400"
                  >
                    {t("webman.siteData.clear")}
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- 内容区 -->
    <div class="flex flex-1 flex-col overflow-hidden">
      {#if activeTab?.url}
        <!-- 大屏类别（桌面 / 平板）: 内联 iframe (增强安全) -->
        {#if inline}
          <!--
            权限策略（REQ-A1560/F4）：`fullscreen` **显式授予**，因为跨源 iframe 的
            `fullscreen` 默认允许列表是 `self`（只含顶层来源）—— 不写这一条，帧里任何
            `requestFullscreen()` 都会被静默拒绝（快速链接里的 YouTube 就是第一个撞上的）。
            `allowfullscreen` 是同一件事的旧式属性，一起给上以兼容旧引擎。
            其余三项仍显式 `'none'`：相机 / 麦克风 / 定位在这个帧里**没有**真权限对话框
            （内容承载是 iframe，不是浏览器引擎），给了也只会是一句无 UI 的拒绝 —— 所以是关的，
            而不是"开着但问不出来"。
          -->
          <iframe
            bind:this={iframeRef}
            src={activeTab.url}
            onload={handleIframeLoad}
            onerror={handleIframeError}
            class="h-full w-full flex-1 border-0"
            title={activeTab.title}
            sandbox={iframeSandbox(settings)}
            referrerpolicy="no-referrer"
            allowfullscreen
            allow="fullscreen; geolocation 'none'; camera 'none'; microphone 'none';"
          ></iframe>
        {:else}
          <!-- 移动模式: WebView (需要原生支持) -->
          <div class="flex flex-1 flex-col items-center justify-center bg-white p-8 text-center">
            <div class="mb-6 text-6xl">🌐</div>
            <h2 class="mb-2 text-xl font-semibold">{activeTab.title || t("webman.newTab")}</h2>
            <p class="mb-4 text-sm text-neutral-500">{activeTab.url}</p>
            <!--
              这条出口与工具栏那颗 ⎋ 是**同一个**动作（REQ-A1560/F1）：工具栏走
              `openInExternalBrowser`（`webman.ts` 里**显式**传 `noopener,noreferrer`），
              而这里是一个裸的 `<a target="_blank">` —— 缺 `rel` 时被打开的页面拿到
              `window.opener`，可以把它**导航回**一个钓鱼页（reverse tabnabbing）。
              同一个 feature 的兄弟显式关掉了 opener，这一支不能默认开着；补上同样的两个令牌。
            -->
            <a
              href={activeTab.url}
              target="_blank"
              rel="noopener noreferrer"
              class="rounded-full bg-accent px-6 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              {t("webman.openInBrowser")}
            </a>
          </div>
        {/if}
      {:else}
        <!-- 新标签页内容 -->
        <div class="flex flex-1 flex-col items-center justify-center bg-white p-8 dark:bg-neutral-800">
          <!-- Logo -->
          <div class="mb-8 flex items-center gap-3">
            <span class="text-5xl">🌐</span>
            <h1 class="text-4xl font-bold">{t("webman.appName")}</h1>
          </div>

          <!-- 快速链接 -->
          <div class="mb-8 grid grid-cols-4 gap-4">
            {#each [
              { icon: "📧", name: t("webman.quickLinks.gmail"), url: "https://mail.google.com" },
              { icon: "📺", name: t("webman.quickLinks.youtube"), url: "https://youtube.com" },
              { icon: "💬", name: t("webman.quickLinks.wechat"), url: "https://wx.qq.com" },
              { icon: "🛒", name: t("webman.quickLinks.taobao"), url: "https://taobao.com" },
            ] as site}
              <button
                onclick={() => navigate(site.url)}
                class="flex flex-col items-center gap-2 rounded-xl p-4 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700"
              >
                <span class="text-3xl">{site.icon}</span>
                <span class="text-xs">{site.name}</span>
              </button>
            {/each}
          </div>

          <!-- 搜索框 -->
          <div class="relative w-full max-w-xl">
            <span class="absolute left-4 top-1/2 -translate-y-1/2 text-xl">🔍</span>
            <input
              type="text"
              bind:value={inputValue}
              onkeydown={handleKeydown}
              placeholder={t("webman.searchPlaceholder")}
              class="h-14 w-full rounded-full border border-neutral-300 bg-neutral-100 pl-14 pr-4 text-lg outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>

          <!-- 快捷操作 -->
          <div class="mt-6 flex gap-4">
            <button
              onclick={() => (panel = "bookmarks")}
              class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <span>⭐</span> {t("webman.bookmarks")}
            </button>
            <button
              onclick={() => (panel = "history")}
              class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <span>📜</span> {t("webman.history")}
            </button>
            <button
              onclick={() => (panel = "downloads")}
              class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <span>⬇️</span> {t("webman.downloads")}
            </button>
            <button
              onclick={() => (panel = "settings")}
              class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <span>⚙️</span> {t("webman.settings")}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- 菜单弹窗 -->
  {#if showMenu}
    <div 
      class="fixed inset-0 z-50" 
      role="button" 
      tabindex="0"
      onclick={() => (showMenu = false)}
      onkeydown={(e) => e.key === 'Escape' && (showMenu = false)}
      aria-label={t("webman.closeMenu")}
    >
      <div class="absolute bottom-12 right-3 w-56 rounded-xl bg-white shadow-xl dark:bg-neutral-800">
        <button
          onclick={() => {
            addTab();
            showMenu = false;
          }}
          class="flex w-full items-center gap-3 rounded-t-xl px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
        >
          <span class="text-lg">➕</span>
          <span class="text-sm">{t("webman.newTab")}</span>
          <span class="ml-auto text-xs text-neutral-500">{BROWSER_SHORTCUT_HINTS["new-tab"]}</span>
        </button>
        <button
          onclick={() => {
            restoreLastClosedTab();
            showMenu = false;
          }}
          disabled={closedTabs.length === 0}
          class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-700"
        >
          <span class="text-lg">↩️</span>
          <span class="text-sm">{t("webman.reopenClosedTab")}</span>
          <span class="ml-auto text-xs text-neutral-500">{BROWSER_SHORTCUT_HINTS["restore-tab"]}</span>
        </button>
        <button
          onclick={() => {
            addTab(true);
            showMenu = false;
          }}
          class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
        >
          <span class="text-lg">📌</span>
          <span class="text-sm">{t("webman.newPinnedTab")}</span>
        </button>
        <!-- 取消固定 / 固定**当前**这一页。上面那一行只能"固定一个新的"，谁也解不开 ——
             这一行才是那道单向门的回程（REQ-A1315 / F-SH-588）。 -->
        {#if activeTab}
          <button
            onclick={() => {
              toggleActiveTabPinned();
              showMenu = false;
            }}
            class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <span class="text-lg">{activeTab.pinned ? "📍" : "📌"}</span>
            <span class="text-sm">{t(activeTab.pinned ? "webman.unpinTab" : "webman.pinTab")}</span>
          </button>
        {/if}
        <div class="border-t border-neutral-200 dark:border-neutral-700">
          <button
            onclick={() => {
              panel = "bookmarks";
              showMenu = false;
            }}
            class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <span class="text-lg">⭐</span>
            <span class="text-sm">{t("webman.bookmarks")}</span>
          </button>
          <button
            onclick={() => {
              panel = "history";
              showMenu = false;
            }}
            class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <span class="text-lg">📜</span>
            <span class="text-sm">{t("webman.history")}</span>
          </button>
          <button
            onclick={() => {
              panel = "downloads";
              showMenu = false;
            }}
            class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <span class="text-lg">⬇️</span>
            <span class="text-sm">{t("webman.downloads")}</span>
          </button>
        </div>
        <div class="border-t border-neutral-200 dark:border-neutral-700">
          <button
            onclick={() => {
              panel = "settings";
              showMenu = false;
            }}
            class="flex w-full items-center gap-3 rounded-b-xl px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <span class="text-lg">⚙️</span>
            <span class="text-sm">{t("webman.settings")}</span>
          </button>
        </div>
      </div>
    </div>
  {/if}
  
  <!-- Toast 通知 -->
  {#if toastVisible}
    <!-- Toast 是**用户动作之后**才出现的反馈（加书签、加载失败…），而焦点还在原处 ⇒
         必须播报，否则屏幕阅读器用户不知道刚才那一下成没成（REQ-A387）。 -->
    <div
      class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 animate-[fadeIn_0.3s_ease-in-out]"
      role="status"
    >
      <div class="rounded-full bg-neutral-800 px-6 py-3 text-sm text-white shadow-lg dark:bg-neutral-700">
        {toastMessage}
      </div>
    </div>
  {/if}
</div>
</ErrorBoundary>

<style>
  /* 指针契约（REQ-A385）：关标签按钮原来只在 hover 时出现，而 opacity-0
     **不挡命中** ⇒ 触屏上它既看不见又留着可点区域，而且没有 hover 能唤出它；
     顺带一提，误触一个看不见的"关闭"正是最该避免的那种误触。

     现在的规则：指针设备上隐到 hover / 键盘聚焦才出现，且隐藏时**不可命中**
     （`visibility: hidden` 脱离命中测试）；触屏设备一直显示 —— 它没有 hover。 */
  .tab-close {
    transition: opacity 150ms ease, visibility 150ms ease;
  }
  @media (hover: hover) {
    .tab-close {
      opacity: 0;
      visibility: hidden;
    }
    .group:hover .tab-close,
    .group:focus-within .tab-close {
      opacity: 1;
      visibility: visible;
    }
  }
</style>
