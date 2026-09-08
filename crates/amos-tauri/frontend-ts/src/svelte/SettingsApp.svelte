<script lang="ts">
  // SettingsApp.svelte — Svelte 5 (runes) Settings, restructured as an iOS-style
  // "grouped list + drill-down pages" screen (mirrors iPhone「设置」: a search field,
  // an account card, grouped rows, and a pushed sub page per row with a back header).
  //
  // Layout of pages (route is a discriminated string union):
  //   index — search field + account card + grouped rows (switch / chevron rows)
  //   account — iCloud / account (real sync)        wifi, bluetooth — radio pages
  //   display / wallpaper / language / lock / ai — real feature pages
  //   notifications / sound / privacy / about — real pages (dnd, sound prefs,
  //       permission revoke, device/about telemetry)
  //   diagnostics — sensor/system/task/lmk live panels
  //   cellular / focus — real preference pages (cellular data/roaming, focus scenarios)
  //
  // The index rows are data-driven (SECTIONS) so the search box can filter the same
  // canonical rows that the grouped view renders — no duplicated label lists.
  // All persistence reuses the framework-free pure libs; the Wi‑Fi/蓝牙/飞行 rows
  // drive the SAME quick-settings store + airplane-cascade policy as the control
  // center (lib/settings.ts flipRadio), so toggling here is reflected there.
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import {
    SETTINGS_KEY,
    flipRadio,
    normalizeQuick,
    type QuickSettings,
    type RadioKey,
  } from "../lib/settings";
  import { LOCK_KEY, type LockCfg } from "../lib/lock";
  import { CELLULAR_KEY, normalizeCellular } from "../lib/cellular";
  import { FOCUS_KEY, FOCUS_SCENARIOS, normalizeFocus, type FocusPrefs } from "../lib/focusPrefs";
  import { readCloud } from "../lib/cloud";
  import { AMOS_UI_VERSION } from "../lib/version";
  import { bridged, radioSet, radioStatus } from "../lib/backend";
  import { t, locale } from "./locale.svelte";
  import { GROUP, ROW, LABEL, VALUE, SUB, CHEVRON, H1, ROW_ACTIVE } from "./settings/kit";
  import Switch from "./settings/Switch.svelte";
  import DisplayPage from "./settings/DisplayPage.svelte";
  import WallpaperPage from "./settings/WallpaperPage.svelte";
  import LanguagePage from "./settings/LanguagePage.svelte";
  import LockPage from "./settings/LockPage.svelte";
  import AiPage from "./settings/AiPage.svelte";
  import AccountPage from "./settings/AccountPage.svelte";
  import DiagnosticsPage from "./settings/DiagnosticsPage.svelte";
  import RadioPage from "./settings/RadioPage.svelte";
  import PrivacyPage from "./settings/PrivacyPage.svelte";
  import NotificationsPage from "./settings/NotificationsPage.svelte";
  import SoundPage from "./settings/SoundPage.svelte";
  import AboutPage from "./settings/AboutPage.svelte";
  import CellularPage from "./settings/CellularPage.svelte";
  import FocusPage from "./settings/FocusPage.svelte";

  type Sub =
    | "account"
    | "wifi"
    | "bluetooth"
    | "cellular"
    | "notifications"
    | "sound"
    | "focus"
    | "display"
    | "wallpaper"
    | "language"
    | "lock"
    | "ai"
    | "privacy"
    | "about"
    | "diagnostics";
  type Page = "index" | Sub;

  const PAGE_KEY: Record<Sub, string> = {
    account: "settings.accountHeader",
    wifi: "settings.wifi",
    bluetooth: "settings.bluetooth",
    cellular: "settings.cellular",
    notifications: "settings.notifications",
    sound: "settings.soundHaptics",
    focus: "settings.focus",
    display: "settings.displayBrightness",
    wallpaper: "settings.wallpaper",
    language: "settings.language",
    lock: "settings.passcode",
    ai: "settings.ai",
    privacy: "settings.privacy",
    about: "settings.about",
    diagnostics: "settings.diagnostics",
  };

  /**
   * Extra searchable keywords per page (bilingual, both zh + en). They let the
   * index search hit pages by their *sub-page* content / common synonyms — e.g.
   * "brightness", "勿扰", "权限", "battery" — even when the index row title or its
   * live value text doesn't contain the typed term (mimics iOS search aliasing).
   */
  const EXTRA: Partial<Record<Sub, string[]>> = {
    wifi: ["Wi-Fi", "WiFi", "wireless", "无线", "网络"],
    bluetooth: ["BLE", "wireless", "无线", "连接"],
    cellular: ["mobile data", "data", "sim", "网络", "流量", "数据"],
    notifications: ["alert", "badge", "提醒", "角标", "横幅", "勿扰", "banner"],
    sound: ["ringtone", "volume", "铃声", "音量", "静音", "mute"],
    focus: ["勿扰", "dnd", "sleep", "driving", "睡眠", "驾驶", "专注"],
    display: ["brightness", "dark", "亮度", "深色", "浅色"],
    wallpaper: ["background", "背景", "图片"],
    language: ["简体", "中文", "english", "语言"],
    lock: ["password", "passcode", "pin", "密码", "面容"],
    ai: ["model", "deepseek", "推理", "inference", "模型"],
    account: ["sync", "backup", "同步", "备份", "iCloud"],
    privacy: ["permission", "grant", "授权", "权限", "敏感"],
    about: ["version", "battery", "device", "版本", "电量", "设备", "storage"],
    diagnostics: ["monitor", "debug", "lmk", "监控", "进程", "开发者", "developer"],
  };

  let page = $state<Page>("index");
  let q = $state("");
  const nav = (p: Page) => {
    q = ""; // leaving the index clears the search
    page = p;
    try {
      window.scrollTo({ top: 0 });
    } catch {
      /* ignore */
    }
  };
  const goHome = () => {
    syncLock();
    syncCell();
    syncAux();
    nav("index");
  };

  /* ---- Shared quick-settings radio state (flight-mode / wifi / bluetooth) ---- */
  const readQuick = (): QuickSettings => normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {}));
  let qs = $state<QuickSettings>(readQuick());
  const airplaneOn = $derived(qs.airplane === true);
  const mergeRadio = (s: QuickSettings, r: { wifi: boolean; bluetooth: boolean; airplane: boolean }) => ({
    ...s,
    wifi: r.wifi,
    bluetooth: r.bluetooth,
    airplane: r.airplane,
  });
  const persistQuick = (next: QuickSettings) => {
    qs = next;
    writeStoreValue(SETTINGS_KEY, next);
  };
  const toggleRadio = async (key: RadioKey) => {
    if (key !== "airplane" && qs.airplane) return; // gated no-op under airplane mode
    const on = !!qs[key];
    if (bridged()) {
      const snap = await radioSet(key, !on);
      if (snap) {
        persistQuick(mergeRadio(qs, snap));
        return;
      }
      const live = await radioStatus();
      if (live) persistQuick(mergeRadio(qs, live));
      return;
    }
    persistQuick(flipRadio(qs, key));
  };

  /* ---- Live subtitles for index rows (driven by stores + locale) ---- */
  let lockEnabled = $state<boolean>(!!readStoreValue<LockCfg>(LOCK_KEY, { enabled: false }).enabled);
  const lockSub = $derived(lockEnabled ? t("settings.passcodeOn") : t("settings.passcodeOff"));
  const syncLock = () => {
    lockEnabled = !!readStoreValue<LockCfg>(LOCK_KEY, { enabled: false }).enabled;
  };
  const wifiVal = $derived(qs.airplane ? t("settings.off") : qs.wifi ? t("settings.notConnected") : t("settings.off"));
  const btVal = $derived(qs.airplane ? t("settings.off") : qs.bluetooth ? t("settings.on") : t("settings.off"));
  const langVal = $derived(locale() === "zh" ? t("settings.languageZh") : t("settings.languageEn"));
  // Cellular row reflects the persisted 蜂窝数据 preference (default on), resynced
  // when returning from the 蜂窝网络 page (same pattern as the lock-row subtitle).
  let cellularData = $state<boolean>(normalizeCellular(readStoreValue<unknown>(CELLULAR_KEY, {})).data);
  const cellularSub = $derived(cellularData ? t("settings.on") : t("settings.off"));
  const syncCell = () => {
    cellularData = normalizeCellular(readStoreValue<unknown>(CELLULAR_KEY, {})).data;
  };
  // iCloud row reflects the persisted sync toggle; focus row lists the enabled
  // scenarios; about row shows the UI version. All resynced on return via goHome.
  let cloudOn = $state<boolean>(readCloud(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {})).enabled);
  let focusOn = $state<FocusPrefs>(normalizeFocus(readStoreValue<unknown>(FOCUS_KEY, {})));
  const FOCUS_LABEL: Record<keyof FocusPrefs, string> = {
    dnd: "settings.focusDnd",
    work: "settings.focusWork",
    sleep: "settings.focusSleep",
  };
  const icloudSub = $derived(cloudOn ? t("settings.on") : t("settings.off"));
  const aboutSub = $derived(`v${AMOS_UI_VERSION}`);
  const focusSub = $derived.by(() => {
    const on = FOCUS_SCENARIOS.filter((id) => focusOn[id]).map((id) => t(FOCUS_LABEL[id]));
    return on.length > 0 ? on.join("、") : t("settings.off");
  });
  const syncAux = () => {
    cloudOn = readCloud(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {})).enabled;
    focusOn = normalizeFocus(readStoreValue<unknown>(FOCUS_KEY, {}));
  };
  /* ---- Data-driven index rows (single source for grouped view + search) ---- */
  type Row =
    | { kind: "nav"; page: Sub; key: string; sub?: () => string }
    | { kind: "switch"; key: string; on: () => boolean; toggle: () => void };

  /** iPhone-style grouped index (visual grouping = whitespace, like iOS Settings). */
  const SECTIONS: Row[][] = [
    // 网络：飞行模式(开关) / Wi‑Fi / 蓝牙 / 蜂窝网络
    [
      { kind: "switch", key: "settings.airplane", on: () => airplaneOn, toggle: () => toggleRadio("airplane") },
      { kind: "nav", page: "wifi", key: "settings.wifi", sub: () => wifiVal },
      { kind: "nav", page: "bluetooth", key: "settings.bluetooth", sub: () => btVal },
      { kind: "nav", page: "cellular", key: "settings.cellular", sub: () => cellularSub },
    ],
    // 通用：通知 / 声音与触感 / 专注模式
    [
      { kind: "nav", page: "notifications", key: "settings.notifications" },
      { kind: "nav", page: "sound", key: "settings.soundHaptics" },
      { kind: "nav", page: "focus", key: "settings.focus", sub: () => focusSub },
    ],
    // 显示：显示与亮度 / 壁纸 / 锁屏密码
    [
      { kind: "nav", page: "display", key: "settings.displayBrightness" },
      { kind: "nav", page: "wallpaper", key: "settings.wallpaper" },
      { kind: "nav", page: "lock", key: "settings.passcode", sub: () => lockSub },
    ],
    // 账户与功能：语言 / iCloud / AI 与智能 / 隐私与安全性
    [
      { kind: "nav", page: "language", key: "settings.language", sub: () => langVal },
      { kind: "nav", page: "account", key: "settings.icloudRow", sub: () => icloudSub },
      { kind: "nav", page: "ai", key: "settings.ai" },
      { kind: "nav", page: "privacy", key: "settings.privacy" },
    ],
    // 系统：关于本机 / 系统监控与开发者
    [
      { kind: "nav", page: "about", key: "settings.about", sub: () => aboutSub },
      { kind: "nav", page: "diagnostics", key: "settings.diagnostics" },
    ],
  ];

  const allRows = SECTIONS.flat();
  const rowLabel = (r: Row): string => t(r.key);
  const rowSub = (r: Row): string => (r.kind === "nav" && r.sub ? r.sub() : "");
  const rowId = (r: Row): string => (r.kind === "nav" ? r.page : r.key);
  const extraOf = (r: Row): string[] => (r.kind === "nav" ? EXTRA[r.page] ?? [] : []);
  /** Live search over the same rows the grouped view renders (locale-aware). */
  type Hit = { id: string; row: Row; label: string; sub: string; terms: string[] };
  const hits = $derived.by<Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return allRows
      .map((row) => ({
        id: rowId(row),
        row,
        label: rowLabel(row),
        sub: rowSub(row),
        terms: extraOf(row),
      }))
      .filter((h) =>
        `${h.label} ${h.sub} ${h.terms.join(" ")}`.toLowerCase().includes(needle),
      );
  });
  const searching = $derived(q.trim().length > 0);
</script>

{#snippet rowView(row: Row)}
  {#if row.kind === "switch"}
    <div class={ROW}>
      <span class={LABEL}>{t(row.key)}</span>
      <Switch on={row.on()} aria={t(row.key)} ontoggle={row.toggle} />
    </div>
  {:else}
    <button onclick={() => nav(row.page)} class={ROW_ACTIVE} aria-label={t(row.key)}>
      <span class={LABEL}>{t(row.key)}</span>
      <span class="flex items-center gap-1.5">
        {#if row.sub}
          <span class={VALUE}>{row.sub()}</span>
        {/if}
        <span class={CHEVRON}>›</span>
      </span>
    </button>
  {/if}
{/snippet}

<div class="px-4 pb-10">
  {#if page === "index"}
    <h1 class={H1}>{t("settings.indexTitle")}</h1>

    <!-- Search field (iOS: sits under the big title, live-filters the rows) -->
    <div class="relative mt-3">
      <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm opacity-40">🔍</span>
      <input
        bind:value={q}
        type="search"
        placeholder={t("settings.searchPlaceholder")}
        aria-label={t("settings.searchPlaceholder")}
        class="w-full rounded-[10px] bg-black/5 py-2 pl-9 pr-8 text-sm outline-none dark:bg-white/10"
      />
      {#if searching}
        <button
          onclick={() => (q = "")}
          aria-label={t("settings.searchClear")}
          class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1 text-sm opacity-50 active:scale-90"
        >
          ✕
        </button>
      {/if}
    </div>

    {#if searching}
      <!-- Live search results (same canonical rows, flat) -->
      <div class="mt-3">
        {#if hits.length === 0}
          <p class="px-1 py-4 text-center text-sm opacity-50">{t("settings.noResults")}</p>
        {:else}
          <section class={GROUP}>
            {#each hits as hit, i (hit.id)}
              {@render rowView(hit.row)}
              {#if i < hits.length - 1}<div class={SUB}></div>{/if}
            {/each}
          </section>
        {/if}
      </div>
    {:else}
      <!-- Account card → account/iCloud page -->
      <button
        onclick={() => nav("account")}
        class={"mt-4 flex w-full items-center gap-3 text-left " + GROUP}
        aria-label={t("settings.accountHeader")}
      >
        <div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-indigo-500 text-2xl font-semibold text-white shadow-inner">
          A
        </div>
        <div class="min-w-0 flex-1 py-3">
          <p class="text-[16px] font-semibold text-neutral-900 dark:text-neutral-50">{t("settings.accountName")}</p>
          <p class="truncate text-xs opacity-60">{t("settings.accountHint")}</p>
        </div>
        <span class={CHEVRON}>›</span>
      </button>

      <!-- Grouped rows (whitespace-separated cards, like iOS) -->
      <div class="mt-4 space-y-4">
        {#each SECTIONS as group (group.map(rowId).join("|"))}
          <section class={GROUP}>
            {#each group as row, i (rowId(row))}
              {@render rowView(row)}
              {#if i < group.length - 1}<div class={SUB}></div>{/if}
            {/each}
          </section>
        {/each}
      </div>
    {/if}
  {:else}
    <!-- Sub page: back to index + large title -->
    <div class="pt-3">
      <button
        onclick={goHome}
        class="flex items-center gap-0.5 rounded-full px-1 py-0.5 text-accent active:scale-95"
        aria-label={t("settings.back")}
      >
        <span class="text-xl leading-none">‹</span>
        <span class="text-[15px]">{t("settings.back")}</span>
      </button>
      <h1 class={"mt-1 " + H1}>{t(PAGE_KEY[page as Sub])}</h1>
    </div>
    <div class="space-y-5 pt-3">
      {#if page === "wifi" || page === "bluetooth"}
        <RadioPage which={page} qs={qs} onToggle={toggleRadio} />
      {:else if page === "cellular"}
        <CellularPage />
      {:else if page === "focus"}
        <FocusPage />
      {:else if page === "display"}
        <DisplayPage />
      {:else if page === "wallpaper"}
        <WallpaperPage />
      {:else if page === "language"}
        <LanguagePage />
      {:else if page === "lock"}
        <LockPage />
      {:else if page === "ai"}
        <AiPage />
      {:else if page === "account"}
        <AccountPage />
      {:else if page === "diagnostics"}
        <DiagnosticsPage />
      {:else if page === "privacy"}
        <PrivacyPage />
      {:else if page === "notifications"}
        <NotificationsPage />
      {:else if page === "sound"}
        <SoundPage />
      {:else if page === "about"}
        <AboutPage />
      {/if}
    </div>
  {/if}
</div>



