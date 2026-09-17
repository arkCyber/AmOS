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
  import { t } from "./locale.svelte";
  import {
    type Tab,
    type HistoryEntry,
    type WebManSettings,
    loadBookmarks,
    loadHistory,
    loadDownloads,
    loadSettings,
    saveSettings,
    loadTabs,
    saveTabs,
    createTab,
    closeTab,
    addBookmark,
    removeBookmark,
    isBookmarked,
    addToHistory,
    clearHistory,
    searchHistory,
    parseInput,
    extractDomain,
    extractTitle,
    getFaviconUrl,
    formatTime,
    sanitizeUrl,
    applySafeSearch,
    debounce,
    logger,
  } from "../lib/webman";

  // 状态
  let tabs = $state<Tab[]>(loadTabs());
  let activeTabId = $state<string>("");
  let inputValue = $state("");
  let showBookmarks = $state(false);
  let showHistory = $state(false);
  let showDownloads = $state(false);
  let showSettings = $state(false);
  let showMenu = $state(false);
  let isDesktop = $state(false);

  // 设置
  let settings = $state<WebManSettings>(loadSettings());

  // 派生状态
  const activeTab = $derived(tabs.find((t) => t.id === activeTabId) ?? tabs[0]);
  const bookmarks = $derived(loadBookmarks());
  const history = $derived(loadHistory());
  const downloads = $derived(loadDownloads());

  // iframe 引用
  let iframeRef = $state<HTMLIFrameElement | null>(null);

  // Toast 消息
  let toastMessage = $state("");
  let toastVisible = $state(false);
  
  function showToast(message: string) {
    toastMessage = message;
    toastVisible = true;
    setTimeout(() => {
      toastVisible = false;
    }, 3000);
  }

  // 检测桌面模式
  $effect(() => {
    if (typeof window !== "undefined") {
      isDesktop = window.innerWidth >= 768;
      const handler = () => {
        isDesktop = window.innerWidth >= 768;
      };
      window.addEventListener("resize", handler);
      return () => window.removeEventListener("resize", handler);
    }
  });

  // 初始化 activeTabId
  $effect(() => {
    if (!activeTabId && tabs.length > 0) {
      activeTabId = tabs[0]!.id;
    }
  });

  // 导航 - 增强安全版
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

    inputValue = finalUrl;

    // 更新标签
    tabs = tabs.map((tab) =>
      tab.id === activeTabId
        ? { ...tab, url: finalUrl, title: extractTitle(finalUrl), favicon: getFaviconUrl(finalUrl), loading: true }
        : tab
    );
    saveTabs(tabs);

    // 添加历史记录
    addToHistory(finalUrl, extractTitle(finalUrl), settings.privateMode);

    // 模拟加载完成
    setTimeout(() => {
      tabs = tabs.map((tab) =>
        tab.id === activeTabId ? { ...tab, loading: false } : tab
      );
      saveTabs(tabs);
    }, 800);
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

  // Iframe 通信安全 (P1)
  function handlePostMessage(event: MessageEvent) {
    // 严格验证来源
    const allowedOrigins = import.meta.env.DEV 
      ? ['http://localhost:5173', 'http://localhost:1420']
      : ['https://trusted-domain.com']; // 生产环境只允许可信域名
    
    if (!allowedOrigins.includes(event.origin)) {
      logger.warn(`Blocked postMessage from untrusted origin: ${event.origin}`);
      return;
    }

    // 验证数据类型
    if (typeof event.data !== 'object' || !event.data.type) {
      logger.warn('Invalid postMessage data format');
      return;
    }

    // 处理合法消息
    logger.info(`Received message from ${event.origin}:`, event.data);
    // TODO: 根据 event.data.type 处理不同的消息类型
  }

  // 键盘导航 (P1 - 可访问性)
  function handleGlobalKeydown(e: KeyboardEvent) {
    // Cmd/Ctrl + T: 新建标签
    if ((e.metaKey || e.ctrlKey) && e.key === 't') {
      e.preventDefault();
      addTab();
    }
    // Cmd/Ctrl + W: 关闭当前标签
    else if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
      e.preventDefault();
      if (activeTabId) removeTab(activeTabId);
    }
    // Cmd/Ctrl + Shift + T: 恢复已关闭标签 (TODO)
    else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 't') {
      e.preventDefault();
      logger.info('Restore closed tab (not implemented yet)');
    }
    // Cmd/Ctrl + L: 聚焦地址栏
    else if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
      e.preventDefault();
      const input = document.querySelector('input[type="text"]') as HTMLInputElement;
      input?.focus();
      input?.select();
    }
    // Cmd/Ctrl + R: 刷新页面
    else if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
      e.preventDefault();
      if (activeTab) {
        const iframe = iframeRef;
        if (iframe) {
          iframe.src = iframe.src; // 强制刷新
          logger.info('Reloading page:', activeTab.url);
        }
      }
    }
    // Escape: 关闭弹窗
    else if (e.key === 'Escape') {
      if (showBookmarks) showBookmarks = false;
      if (showHistory) showHistory = false;
      if (showDownloads) showDownloads = false;
      if (showSettings) showSettings = false;
    }
  }

  // 标签操作
  function addTab(pinned = false) {
    const newTab = createTab("", pinned);
    tabs = [...tabs, newTab];
    activeTabId = newTab.id;
    saveTabs(tabs);
    inputValue = "";
  }

  function removeTab(tabId: string) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // 如果是固定标签，不允许关闭
    if (tab.pinned) return;

    const newTabs = closeTab(tabs, tabId);
    tabs = newTabs;
    if (activeTabId === tabId) {
      activeTabId = newTabs[newTabs.length - 1]?.id ?? "";
    }
    saveTabs(tabs);
  }

  function selectTab(tabId: string) {
    activeTabId = tabId;
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      inputValue = tab.url;
    }
  }

  // 书签操作 - 增强反馈
  function toggleBookmark() {
    if (!activeTab?.url) return;

    if (isBookmarked(activeTab.url)) {
      const bookmark = bookmarks.find((b) => b.url === activeTab.url);
      if (bookmark) {
        removeBookmark(bookmark.id);
        showToast(t("webman.toast.bookmarkRemoved"));
      }
    } else {
      const result = addBookmark(activeTab.url, activeTab.title);
      if (result) {
        showToast(t("webman.toast.bookmarkAdded"));
      } else {
        showToast(t("webman.toast.bookmarkFailed"));
      }
    }
  }

  // 设置操作
  function togglePrivateMode() {
    settings = { ...settings, privateMode: !settings.privateMode };
    saveSettings(settings);
  }

  function setSearchEngine(engine: WebManSettings["searchEngine"]) {
    settings = { ...settings, searchEngine: engine };
    saveSettings(settings);
  }

  function toggleSafeSearch() {
    settings = { ...settings, safeSearch: !settings.safeSearch };
    saveSettings(settings);
  }

  // 前进/后退
  let canGoBack = $state(false);
  let canGoForward = $state(false);

  // 搜索过滤 - 使用防抖
  let historyQuery = $state("");
  let filteredHistory = $state<HistoryEntry[]>([]);
  
  const debouncedHistorySearch = debounce((query: string) => {
    filteredHistory = query ? searchHistory(query) : history.slice(0, 20);
  }, 300);
  
  $effect(() => {
    debouncedHistorySearch(historyQuery);
  });

  // 生命周期：注册全局事件监听器 (P1 - 安全 & 可访问性)
  onMount(() => {
    window.addEventListener('message', handlePostMessage);
    window.addEventListener('keydown', handleGlobalKeydown);
    logger.info('WebManApp mounted, event listeners registered');
  });

  onDestroy(() => {
    window.removeEventListener('message', handlePostMessage);
    window.removeEventListener('keydown', handleGlobalKeydown);
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
              class="opacity-0 transition-opacity group-hover:opacity-100"
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
        class="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-300 text-lg hover:bg-neutral-200 dark:bg-neutral-700 dark:hover:bg-neutral-600"
      >
        +
      </button>
    </div>

    <!-- 菜单按钮 -->
    <div class="flex items-center gap-1">
      <button
        onclick={() => (showMenu = !showMenu)}
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
        onclick={() => (canGoBack = !canGoBack)}
        disabled={!canGoBack}
        class="flex h-9 w-9 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-800"
      >
        ←
      </button>
      <button
        onclick={() => (canGoForward = !canGoForward)}
        disabled={!canGoForward}
        class="flex h-9 w-9 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-800"
      >
        →
      </button>
      <button
        onclick={() => navigate()}
        class="flex h-9 w-9 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 dark:hover:bg-neutral-800"
      >
        ↻
      </button>
    </div>

    <!-- 地址栏 -->
    <div class="flex flex-1 items-center gap-2">
      <div class="relative flex flex-1 items-center">
        {#if activeTab?.loading}
          <span class="absolute left-3 h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent"></span>
        {:else if settings.privateMode}
          <span class="absolute left-3 text-lg">🔒</span>
        {:else}
          <span class="absolute left-3 text-lg">🔒</span>
        {/if}
        <input
          type="text"
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
      <button
        onclick={toggleBookmark}
        class="flex h-9 w-9 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 dark:hover:bg-neutral-800"
      >
        {activeTab && isBookmarked(activeTab.url ?? "") ? "★" : "☆"}
      </button>

      <!-- 菜单 -->
      <button
        onclick={() => (showMenu = !showMenu)}
        class="flex h-9 w-9 items-center justify-center rounded-lg text-lg transition-colors hover:bg-neutral-200 dark:hover:bg-neutral-800"
      >
        ⋮
      </button>
    </div>
  </div>

  <!-- 主内容区 -->
  <div class="flex flex-1 overflow-hidden">
    <!-- 侧边栏 -->
    {#if showBookmarks || showHistory || showDownloads || showSettings}
      <div class="w-72 border-r border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-800">
        <!-- 侧边栏头部 -->
        <div class="flex border-b border-neutral-300 p-3 dark:border-neutral-700">
          {#if showBookmarks}
            <h2 class="flex-1 text-sm font-semibold">{t("webman.bookmarks")}</h2>
          {:else if showHistory}
            <h2 class="flex-1 text-sm font-semibold">{t("webman.history")}</h2>
            <input
              type="text"
              bind:value={historyQuery}
              placeholder={t("webman.searchHistory")}
              class="h-8 rounded-full bg-neutral-200 px-3 text-xs outline-none dark:bg-neutral-700"
            />
          {:else if showDownloads}
            <h2 class="flex-1 text-sm font-semibold">{t("webman.downloads")}</h2>
          {:else if showSettings}
            <h2 class="flex-1 text-sm font-semibold">{t("webman.settings")}</h2>
          {/if}
          <button
            onclick={() => {
              showBookmarks = false;
              showHistory = false;
              showDownloads = false;
              showSettings = false;
            }}
            class="ml-2 text-neutral-500"
            aria-label={t("webman.closeMenu")}
          >
            ✕
          </button>
        </div>

        <!-- 书签列表 -->
        {#if showBookmarks}
          <div class="p-2">
            {#if bookmarks.length === 0}
              <p class="p-4 text-center text-sm text-neutral-500">{t("webman.noBookmarks")}</p>
            {:else}
              {#each bookmarks as bookmark (bookmark.id)}
                <div class="flex w-full items-center gap-2 rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                  <button
                    onclick={() => {
                      navigate(bookmark.url);
                      showBookmarks = false;
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
                      removeBookmark(bookmark.id);
                    }}
                    class="shrink-0 text-neutral-400 hover:text-red-500"
                  >
                    ✕
                  </button>
                </div>
              {/each}
            {/if}
          </div>
        {/if}

        <!-- 历史记录 -->
        {#if showHistory}
          <div class="p-2">
            <button
              onclick={() => clearHistory()}
              class="mb-2 w-full rounded-lg bg-neutral-200 px-3 py-2 text-xs hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600"
            >
              {t("webman.clearHistory")}
            </button>
            {#if filteredHistory.length === 0}
              <p class="p-4 text-center text-sm text-neutral-500">{t("webman.noHistory")}</p>
            {:else}
              {#each filteredHistory as entry (entry.visitedAt)}
                <button
                  onclick={() => {
                    navigate(entry.url);
                    showHistory = false;
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
                      <span>{formatTime(entry.visitedAt)}</span>
                    </p>
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        {/if}

        <!-- 下载 -->
        {#if showDownloads}
          <div class="p-2">
            {#if downloads.length === 0}
              <p class="p-4 text-center text-sm text-neutral-500">{t("webman.noDownloads")}</p>
            {:else}
              {#each downloads as download (download.id)}
                <div class="mb-2 rounded-lg border border-neutral-200 p-2 dark:border-neutral-700">
                  <p class="truncate text-sm">{download.filename}</p>
                  <div class="mt-1 flex items-center gap-2">
                    {#if download.status === "downloading"}
                      <div class="h-1.5 flex-1 rounded-full bg-neutral-200">
                        <div
                          class="h-full rounded-full bg-accent transition-all"
                          style="width: {download.progress}%"
                        ></div>
                      </div>
                      <span class="text-xs text-neutral-500">{download.progress}%</span>
                    {:else if download.status === "completed"}
                      <span class="text-xs text-green-500">{t("webman.downloadStatus.completed")}</span>
                    {:else if download.status === "failed"}
                      <span class="text-xs text-red-500">{t("webman.downloadStatus.failed")}</span>
                    {:else}
                      <span class="text-xs text-neutral-500">{t("webman.downloadStatus.waiting")}</span>
                    {/if}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        {/if}

        <!-- 设置 -->
        {#if showSettings}
          <div class="p-2">
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
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- 内容区 -->
    <div class="flex flex-1 flex-col overflow-hidden">
      {#if activeTab?.url}
        <!-- 桌面模式: 使用 iframe (增强安全) -->
        {#if isDesktop}
          <iframe
            bind:this={iframeRef}
            src={activeTab.url}
            onload={handleIframeLoad}
            onerror={handleIframeError}
            class="h-full w-full flex-1 border-0"
            title={activeTab.title}
            sandbox="allow-scripts allow-popups allow-forms"
            referrerpolicy="no-referrer"
            allow="geolocation 'none'; camera 'none'; microphone 'none';"
          ></iframe>
        {:else}
          <!-- 移动模式: WebView (需要原生支持) -->
          <div class="flex flex-1 flex-col items-center justify-center bg-white p-8 text-center">
            <div class="mb-6 text-6xl">🌐</div>
            <h2 class="mb-2 text-xl font-semibold">{activeTab.title || t("webman.newTab")}</h2>
            <p class="mb-4 text-sm text-neutral-500">{activeTab.url}</p>
            <a
              href={activeTab.url}
              target="_blank"
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
              onclick={() => (showBookmarks = true)}
              class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <span>⭐</span> {t("webman.bookmarks")}
            </button>
            <button
              onclick={() => (showHistory = true)}
              class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <span>📜</span> {t("webman.history")}
            </button>
            <button
              onclick={() => (showDownloads = true)}
              class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <span>⬇️</span> {t("webman.downloads")}
            </button>
            <button
              onclick={() => (showSettings = true)}
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
        <div class="border-t border-neutral-200 dark:border-neutral-700">
          <button
            onclick={() => {
              showBookmarks = true;
              showMenu = false;
            }}
            class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <span class="text-lg">⭐</span>
            <span class="text-sm">{t("webman.bookmarks")}</span>
          </button>
          <button
            onclick={() => {
              showHistory = true;
              showMenu = false;
            }}
            class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <span class="text-lg">📜</span>
            <span class="text-sm">{t("webman.history")}</span>
          </button>
          <button
            onclick={() => {
              showDownloads = true;
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
              showSettings = true;
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
    <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 animate-[fadeIn_0.3s_ease-in-out]">
      <div class="rounded-full bg-neutral-800 px-6 py-3 text-sm text-white shadow-lg dark:bg-neutral-700">
        {toastMessage}
      </div>
    </div>
  {/if}
</div>
</ErrorBoundary>
