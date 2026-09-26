<script lang="ts">
  // SettingsApp.svelte — Svelte 5 (runes) Settings, restructured as an iOS-style
  // "grouped list + drill-down pages" screen (mirrors iPhone「设置」: a search field,
  // an account card, grouped rows, and a pushed sub page per row with a back header).
  //
  // Layout of pages (route is a discriminated string union):
  //   index — search field + account card + grouped rows (switch / chevron rows)
  //   account — iCloud / account (real sync)        wifi, bluetooth — radio pages
  //   display / wallpaper / language / lock / ai — real feature pages
  //   ime — the on-screen input method (pinyin keyboard switch + fuzzy prefs)
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
  import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import {
    SETTINGS_KEY,
    dndActive,
    normalizeQuick,
    saveQuick,
    type QuickSettings,
    type RadioKey,
  } from "../lib/settings";
  import { LOCK_KEY, type LockCfg } from "../lib/lock";
  import { CELLULAR_KEY, normalizeCellular } from "../lib/cellular";
  import { WIFI_KEY, normalizeWifi, wifiLink } from "../lib/wifi";
  import { FOCUS_KEY, FOCUS_SCENARIOS, normalizeFocus, type FocusPrefs } from "../lib/focusPrefs";
  import { readCloud } from "../lib/cloud";
  import { AMOS_UI_VERSION } from "../lib/version";
  import { readImeEnabled } from "../lib/ime";
  import { bridged } from "../lib/backend";
  import { type RadioRefusalView } from "../lib/radioControl";
  import { radioDisplayOn, syncQuickRadios, tapRadio } from "../lib/quickRadio";
  import { t, locale } from "./locale.svelte";
  import { GROUP, LABEL, VALUE, SUB, CHEVRON, H1, ROW_ACTIVE } from "./settings/kit";
  import { masterDetail } from "../lib/formLayout";
  import { layoutSnap } from "./shellState.svelte";
  import { settingsChannel } from "./appLinks";
  import { createStoreValue } from "./store";
  import { SETTINGS_PAGE_KEY, normalizePageIntent, type SettingsPageId } from "../lib/settingsPages";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import ToggleRow from "./settings/ToggleRow.svelte";
  import DisplayPage from "./settings/DisplayPage.svelte";
  import WallpaperPage from "./settings/WallpaperPage.svelte";
  import LanguagePage from "./settings/LanguagePage.svelte";
  import ImePage from "./settings/ImePage.svelte";
  import LockPage from "./settings/LockPage.svelte";
  import AiPage from "./settings/AiPage.svelte";
  import AccountPage from "./settings/AccountPage.svelte";
  import DiagnosticsPage from "./settings/DiagnosticsPage.svelte";
  import EnterprisePage from "./settings/EnterprisePage.svelte";
  import RadioPage from "./settings/RadioPage.svelte";
  import PrivacyPage from "./settings/PrivacyPage.svelte";
  import TelemetrySpyPage from "./settings/TelemetrySpyPage.svelte";
  import NetGuardPage from "./settings/NetGuardPage.svelte";
  import NotificationsPage from "./settings/NotificationsPage.svelte";
  // `modules/PushNotificationSettings.svelte` used to be imported here behind a TODO — that
  // component never existed (the push panel is `settings/PushSettings.svelte`, shared with the
  // 通知 page). REQ-A499 removed both the TODO and the page's "Coming Soon" placeholder.
  import PushManagementPage from "./settings/PushManagementPage.svelte";
  import SoundPage from "./settings/SoundPage.svelte";
  import RingtonePage from "./settings/RingtonePage.svelte";
  import RecordingsPage from "./settings/RecordingsPage.svelte";
  import AboutPage from "./settings/AboutPage.svelte";
  import CellularPage from "./settings/CellularPage.svelte";
  import HotspotPage from "./settings/HotspotPage.svelte";
  import FocusPage from "./settings/FocusPage.svelte";
  import WindowPage from "./settings/WindowPage.svelte";
  import LinkPage from "./settings/LinkPage.svelte";
  import KeyboardPage from "./settings/KeyboardPage.svelte";
  import DockPage from "./settings/DockPage.svelte";
  import HotCornersPage from "./settings/HotCornersPage.svelte";

  /**
   * The page vocabulary lives in `lib/settingsPages.ts` now, not here (REQ-A790).
   *
   * A union is enough while every writer is in this file. It stopped being enough when the Dock
   * needed to name a page from **another window**: a value that crossed the gap has to be checked
   * against a list that exists at runtime. `SETTINGS_PAGES` is that list, and `SettingsPageId` is
   * derived from it — so there is one declaration of the vocabulary, not two that can drift.
   */
  type Sub = SettingsPageId;
  type Page = "index" | Sub;

  const PAGE_KEY: Record<Sub, string> = {
    account: "settings.accountHeader",
    wifi: "settings.wifi",
    bluetooth: "settings.bluetooth",
    cellular: "settings.cellular",
    hotspot: "settings.hotspot",
    notifications: "settings.notifications",
    push_management: "settings.push_management",
    sound: "settings.soundHaptics",
    ringtone: "settings.ringtone",
    recordings: "settings.recordings",
    focus: "settings.focus",
    display: "settings.displayBrightness",
    wallpaper: "settings.wallpaper",
    dock: "settings.dock.title",
    hotcorners: "settings.hotCorners",
    language: "settings.language",
    ime: "settings.ime",
    keyboard: "settings.keyboard",
    lock: "settings.passcode",
    ai: "settings.ai",
    privacy: "settings.privacy",
    spy: "settings.spy",
    guard: "settings.guard",
    about: "settings.about",
    diagnostics: "settings.diagnostics",
    window: "settings.window",
    link: "settings.link",
    enterprise: "settings.enterprise",
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
    hotspot: ["hotspot", "tether", "tethering", "share", "ap", "个人热点", "热点", "网络共享", "共享"],
    notifications: ["alert", "badge", "提醒", "角标", "横幅", "勿扰", "banner"],
    push_management: ["push", "remote", "apns", "token", "device", "推送", "远程", "令牌", "历史", "测试", "设备", "统计"],
    sound: ["ringtone", "volume", "铃声", "音量", "静音", "mute"],
    ringtone: ["ringtone", "来电铃声", "铃声", "振动", "ring", "vibrate"],
    recordings: ["recording", "call recording", "录音", "通话录音", "voice memo"],
    focus: ["勿扰", "dnd", "sleep", "睡眠", "专注"],
    display: ["brightness", "dark", "亮度", "深色", "浅色"],
    wallpaper: ["background", "背景", "图片"],
    dock: ["程序坞", "底部", "左侧", "右侧", "放大", "自动隐藏", "magnification", "auto-hide", "position"],
    hotcorners: ["hot corners", "热角", "角落", "触发", "trigger", "mission control", "launchpad", "desktop"],
    language: ["简体", "中文", "english", "语言"],
    ime: ["pinyin", "keyboard", "input method", "输入法", "拼音", "键盘", "模糊音"],
    // REQ-A488: this page was in neither the index rows nor this alias map — the *only* surface that
    // can rebind or **disable** a desktop shortcut had no way in (only the `#keyboard` deep link).
    // Its aliases carry 键盘 as well, so a search for that word returns both rows instead of the IME
    // page alone (which is where "keyboard" used to land).
    keyboard: ["shortcut", "shortcuts", "hotkey", "keybinding", "binding", "绑定", "快捷键", "键位", "键盘"],
    lock: ["password", "passcode", "pin", "密码", "面容", "生物识别", "指纹", "biometric", "face id"],
    ai: ["model", "deepseek", "推理", "inference", "模型"],
    account: ["sync", "backup", "同步", "备份", "iCloud"],
    privacy: ["permission", "grant", "授权", "权限", "敏感"],
    spy: ["egress", "leak", "audit", "telemetry", "serial", "imei", "cell", "回传", "外发", "泄漏", "审计", "序列号"],
    guard: ["firewall", "netfilter", "block", "网闸", "防火墙", "阻断", "回传"],
    about: ["version", "battery", "device", "版本", "电量", "设备", "storage"],
    // REQ-A584: the three enterprise panels are searched by what they *do* (MDM / audit / API /
    // webhook), not only by the section title — the section is new, so nobody knows its wording yet.
    enterprise: [
      "enterprise",
      "mdm",
      "organization",
      "policy",
      "audit",
      "log",
      "api",
      "token",
      "webhook",
      "企业",
      "组织",
      "策略",
      "审计",
      "日志",
      "接口",
      "令牌",
      "回调",
    ],
    diagnostics: ["monitor", "debug", "lmk", "监控", "进程", "开发者", "developer"],
    window: ["form factor", "tablet", "desktop", "split", "columns", "形态", "平板", "桌面", "分屏", "列", "分栏", "窗口"],
    link: ["robot", "ros", "middleware", "topic", "qos", "peer", "heartbeat", "机器人", "中间件", "链路", "话题", "对端", "心跳"],
  };

  let page = $state<Page>("index");
  let q = $state("");
  /** Jump the (shell-provided) scroll container back to the top on navigation,
   *  so a tall sub page doesn't open mid-list. Falls back to window scrolling. */
  const resetTop = () => {
    const host =
      typeof document !== "undefined"
        ? (document.querySelector('[data-testid="app-surface"] .overflow-y-auto') as HTMLElement | null)
        : null;
    if (host) host.scrollTop = 0;
    else {
      try {
        window.scrollTo({ top: 0 });
      } catch {
        /* ignore */
      }
    }
  };
  const nav = (p: Page) => {
    q = ""; // leaving the index clears the search
    radioRefusal = null; // a stale refusal must not haunt a page it is not about
    page = p;
    resetTop();
    // In the tablet master-detail the detail column is its own scroller (the shell's
    // scroll host is not the one moving), so a chosen row must reset *it*.
    if (detailEl) detailEl.scrollTop = 0;
  };
  const goHome = () => {
    syncLock();
    syncCell();
    syncWifi();
    syncAux();
    nav("index");
  };

  // Settings search deep link (Spotlight's "search in Settings" action): prefill only.
  // We take the text and go back to the index — **we do not pick a page**: the index
  // search below already matches pages, their synonyms and their live values, so it
  // decides. The link is a request and is consumed once (a later remount starts clean).
  let linkNonce = 0;
  $effect(() => {
    return settingsChannel().subscribe((v) => {
      if (!v || v.query.trim() === "" || v.nonce === linkNonce) return;
      linkNonce = v.nonce;
      // Every query is a **search**, whatever it starts with (REQ-A1092).
      //
      // A `#page` convention used to steer navigation here ("#dock" jumped to the Dock
      // pane). Its only writer was `appLinks.openApp`, which REQ-A415 replaced at every
      // call site with the checked store route (`openSettingsAt`, REQ-A790) and which is
      // now deleted — so nothing legitimate ever spells a `#page` query, while the *live*
      // writer (Spotlight's 「在设置中搜索」) hands over the raw query a user typed. A
      // search for "#dock" therefore navigated the screen, and "#1 号" — which names no
      // page — was swallowed into an empty box: the two ways one leftover branch turned
      // real search text into (in)action, with nothing on screen explaining either.
      page = "index";
      q = v.query.trim();
      resetTop();
      settingsChannel().set({ query: "", nonce: linkNonce });
    });
  });

  /**
   * The **cross-window** page intent (REQ-A790) — the Dock's 「打开偏好设置」 row's route onto the
   * Dock pane.
   *
   * Why a second channel instead of the one above: `settingsChannel()` is a `propsChannel`, which
   * is an **in-window** bus. The Dock lives in the launcher's webview and this screen lives in its
   * own, so nothing on that bus can cross between them. The shared store can, and it is the same
   * route the Files window already uses for the Dock's trash tile (`amos.files.reveal` REQ-A458,
   * `amos.files.view` REQ-A783) — a destination *inside* the target window, not a window label.
   *
   * Subscribed exactly like those: a request written **before** this window existed is picked up
   * from the store's initial value, one that arrives while it is open lands immediately, and the
   * intent is cleared once served because it is a one-shot **command**, not state — a stale
   * destination must never re-fire on a later mount and drag the user back to a page they left.
   * A replay of the same nonce is ignored for the same reason.
   */
  const pageStore = createStoreValue<unknown>(SETTINGS_PAGE_KEY, null);
  /** Highest page nonce this window has served (asking for the same page twice still fires). */
  let pageNonce = 0;
  /**
   * The last store write this screen was told the host refused (REQ-A790). Only the page intent
   * above can raise one — see the note at the `<StoreErrorBar>` in the template for why a refused
   * *clear* is worth showing the user rather than swallowing.
   */
  let storeErr = $state("");
  $effect(() => {
    const un = pageStore.subscribe((raw) => {
      const v = normalizePageIntent(raw);
      if (!v || v.nonce === pageNonce) return;
      pageNonce = v.nonce;
      nav(v.page);
      // Reported, not discarded: a write that did not land leaves the request pending, so the
      // next mount would serve a destination this window has already moved past. (`write:scan`
      // makes answering the boolean a gate rather than a matter of taste.)
      storeErr = writeStoreValueChecked(SETTINGS_PAGE_KEY, null) ? "" : t("common.storeWriteFailed");
    });
    return un;
  });

  /* ---- Shared quick-settings radio state (flight-mode / wifi / bluetooth / hotspot) ---- */
  const readQuick = (): QuickSettings => normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {}));
  let qs = $state<QuickSettings>(readQuick());
  // 这一页的飞行模式开关与专注模式行的副标题都读 `qs` —— 而这个键会被**别的界面**改写（控制中心
  // 的电台开关、`osFocusWatcher` 的勿扰位），且设置窗口可以在控制中心浮层打开时留在后面。所以
  // 这里订阅它（与九个读者同一条原语）；`syncAux()` 的「返回时重读」只覆盖导航回来的那一半。
  const quickStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  $effect(() => {
    const un = quickStore.subscribe((v) => (qs = normalizeQuick(v)));
    return un;
  });
  const airplaneOn = $derived(qs.airplane === true);
  /**
   * The store's refusal for a quick-radio write, in the shared bar's words. It is **not**
   * `storeErr` (that one explains a page-intent write): two different facts, two slots.
   */
  let quickErr = $state("");
  /**
   * Adopt a radio state onto this screen **without** claiming the store took it.
   *
   * The two halves were one function (`qs = next; writeStoreValue(…)`), and that made "the
   * store took it" and "the store refused it" byte-identical on this screen: a refused write
   * left the switch lit while `amos.settings` held the old state, and — since a refused write
   * dispatches no `STORE_CHANGED_EVENT` — nothing corrected it until the next launch. Split
   * because the mount-time **device truth** (`syncQuickRadios`, REQ-A185) must be shown
   * whether or not the store would accept it; only the persisted copy is best-effort.
   */
  const adoptQuick = (next: QuickSettings) => {
    qs = next;
  };
  /** Persist the quick settings and hand back the store's verdict (see `adoptQuick`).
   *
   * `next` is a narrowed flip (`flipRadio` ∕ `mergeRadioQuick` off `readQuick()`), so it
   * must be carried onto the raw blob rather than written over it — `amos.settings` also
   * holds the AI provider and the cloud prefs (REQ-A1397 ∕ F-SH-656). */
  const persistQuick = (next: QuickSettings): boolean => {
    return saveQuick(next);
  };
  /**
   * The last **refused write** (REQ-A203): `radio_set` answers `applied: false` plus
   * machine tokens instead of failing into `null`, so the sub pages can say "the device
   * did not accept this" instead of a toggle that silently does nothing.
   */
  let radioRefusal = $state<RadioRefusalView | null>(null);
  // Mount-time **device truth** (REQ-A185): the tiles show the persisted quick
  // settings, which is the user's *intent* — until this existed, nothing ever asked
  // the device, so with the Mock in place (and no Android provider installed) "Wi-Fi
  // off" could sit on screen while the phone's Wi-Fi was on. One read per mount; a
  // failure keeps the stored values (honest offline behaviour).
  let radioRead = false;
  $effect(() => {
    if (radioRead || !bridged()) return;
    radioRead = true;
    void (async () => {
      const next = await syncQuickRadios(readQuick());
      if (!next) return;
      // Device truth is drawn **regardless** of the store's verdict — a refused write must not
      // put the user's stale intent back over what the radio is really doing. Only the stored
      // copy is best-effort, and a store that refused it is a fact the user is owed.
      adoptQuick(next);
      if (!persistQuick(next)) quickErr = t("common.storeWriteFailed");
    })();
  });
  /**
   * One tap, one implementation: the rules (airplane gate, refusal, re-read) live in
   * `lib/quickRadio.ts` and are shared with the notification centre and the desktop's
   * Control Center — this screen only decides how to *say* what happened.
   */
  const toggleRadio = async (key: RadioKey) => {
    quickErr = ""; // a new tap never inherits the last refusal's words
    const out = await tapRadio({ key, settings: qs, host: bridged() });
    if (out.kind === "applied") radioRefusal = null;
    if (out.kind === "refused") radioRefusal = out.refusal;
    // Only a confirmed write is persisted; otherwise the screen shows the device's state
    // while the store keeps the user's intent (see `RadioTapOutcome`).
    if (!out.persist) {
      adoptQuick(out.next);
      return;
    }
    // The switch **is** this tap's success report, so it moves only once the store says the
    // intent landed. The one exception is a device that really moved (`applied`): its snapshot
    // is the fact the screen owes the user, and what failed was durability, not the radio.
    if (!persistQuick(out.next)) {
      quickErr = t("common.storeWriteFailed");
      if (out.kind === "applied") adoptQuick(out.next);
      return;
    }
    adoptQuick(out.next);
  };

  /* ---- Live subtitles for index rows (driven by stores + locale) ---- */
  let lockEnabled = $state<boolean>(!!readStoreValue<LockCfg>(LOCK_KEY, { enabled: false }).enabled);
  const lockSub = $derived(lockEnabled ? t("settings.passcodeOn") : t("settings.passcodeOff"));
  const syncLock = () => {
    lockEnabled = !!readStoreValue<LockCfg>(LOCK_KEY, { enabled: false }).enabled;
  };
  // The Wi‑Fi index row answers "what are we connected to?", a three-state fact
  // (off / on-but-not-joined / joined to <SSID>). It used to answer with two states
  // and never read `amos.wifi` at all, so it said 「未连接」 while the status bar and
  // the Wi‑Fi page both named the joined network (REQ-A1123). The joined SSID is
  // re-read on return like the lock/cellular rows, because `readStoreValue` is not
  // reactive — and the one rule for the three states lives in `lib/wifi.ts` so this
  // row and the Wi‑Fi page cannot drift apart again.
  let wifiSsid = $state<string | null>(normalizeWifi(readStoreValue<unknown>(WIFI_KEY, {})).current);
  const syncWifi = () => {
    wifiSsid = normalizeWifi(readStoreValue<unknown>(WIFI_KEY, {})).current;
  };
  const wifiVal = $derived.by(() => {
    const link = wifiLink(radioDisplayOn(qs, "wifi"), wifiSsid);
    if (link.kind === "joined") return link.ssid;
    return link.kind === "unjoined" ? t("settings.notConnected") : t("settings.off");
  });
  const btVal = $derived(radioDisplayOn(qs, "bluetooth") ? t("settings.on") : t("settings.off"));
  const langVal = $derived(locale() === "zh" ? t("settings.languageZh") : t("settings.languageEn"));
  // Cellular row reflects the persisted 蜂窝数据 preference (default on), resynced
  // when returning from the 蜂窝网络 page (same pattern as the lock-row subtitle).
  let cellularData = $state<boolean>(normalizeCellular(readStoreValue<unknown>(CELLULAR_KEY, {})).data);
  const cellularSub = $derived(cellularData ? t("settings.on") : t("settings.off"));
  // Hotspot row: a radio bit (off by default), gated off while airplane mode is on.
  const hotspotSub = $derived(radioDisplayOn(qs, "hotspot") ? t("settings.on") : t("settings.off"));
  const syncCell = () => {
    cellularData = normalizeCellular(readStoreValue<unknown>(CELLULAR_KEY, {})).data;
  };
  // iCloud row reflects the persisted sync toggle; focus row lists the enabled
  // scenarios; about row shows the UI version. All resynced on return via goHome.
  let cloudOn = $state<boolean>(readCloud(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {})).enabled);
  let focusOn = $state<FocusPrefs>(normalizeFocus(readStoreValue<unknown>(FOCUS_KEY, {})));
  const FOCUS_LABEL: Record<keyof FocusPrefs, string> = {
    work: "settings.focusWork",
    sleep: "settings.focusSleep",
  };
  const icloudSub = $derived(cloudOn ? t("settings.on") : t("settings.off"));
  const aboutSub = $derived(`v${AMOS_UI_VERSION}`);
  /** Live subtitle for the 输入法 row (on/off, re-read on返回 via `syncAux`). */
  let imeOn = $state(readImeEnabled());
  const imeSub = $derived(imeOn ? t("settings.imeOn") : t("settings.imeOff"));
  // REQ-A206: the subtitle lists the REAL DND bit (qs.dnd — what the shell honours)
  // first, then the saved intent scenarios. The old subtitle read the decorative
  // amos.focus.dnd field, so it could claim 勿扰 was on while nothing was muted.
  const focusSub = $derived.by(() => {
    const parts: string[] = [];
    if (dndActive(qs)) parts.push(t("settings.focusDnd"));
    for (const id of FOCUS_SCENARIOS) if (focusOn[id]) parts.push(t(FOCUS_LABEL[id]));
    return parts.length > 0 ? parts.join("、") : t("settings.off");
  });
  const syncAux = () => {
    cloudOn = readCloud(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {})).enabled;
    focusOn = normalizeFocus(readStoreValue<unknown>(FOCUS_KEY, {}));
    // The 专注模式 page now writes the quick-settings DND bit (REQ-A206): re-read
    // quick settings too, so the focus subtitle reflects what was just chosen.
    qs = readQuick();
    // The IME's switch lives on its own sub page: re-read it when coming back so
    // the row's subtitle shows what the user just chose.
    imeOn = readImeEnabled();
  };
  /* ---- Data-driven index rows (single source for grouped view + search) ---- */
  type Row =
    | { kind: "nav"; page: Sub; key: string; sub?: () => string }
    | { kind: "switch"; key: string; on: () => boolean; toggle: () => void };

  /** iPhone-style grouped index (visual grouping = whitespace, like iOS Settings). */
  const SECTIONS: Row[][] = [
    // 网络：飞行模式(开关) / Wi‑Fi / 蓝牙 / 蜂窝网络 / 个人热点
    [
      { kind: "switch", key: "settings.airplane", on: () => airplaneOn, toggle: () => toggleRadio("airplane") },
      { kind: "nav", page: "wifi", key: "settings.wifi", sub: () => wifiVal },
      { kind: "nav", page: "bluetooth", key: "settings.bluetooth", sub: () => btVal },
      { kind: "nav", page: "cellular", key: "settings.cellular", sub: () => cellularSub },
      { kind: "nav", page: "hotspot", key: "settings.hotspot", sub: () => hotspotSub },
    ],
    // 通用：通知 / 推送通知管理 / 声音与触感 / 来电铃声 / 专注模式
    [
      { kind: "nav", page: "notifications", key: "settings.notifications" },
      { kind: "nav", page: "push_management", key: "settings.push_management" },
      { kind: "nav", page: "sound", key: "settings.soundHaptics" },
      { kind: "nav", page: "ringtone", key: "settings.ringtone" },
      { kind: "nav", page: "recordings", key: "settings.recordings" },
      { kind: "nav", page: "focus", key: "settings.focus", sub: () => focusSub },
    ],
    // 显示：显示与亮度 / 壁纸 / 桌面与程序坞 / 锁屏密码
    [
      { kind: "nav", page: "display", key: "settings.displayBrightness" },
      { kind: "nav", page: "wallpaper", key: "settings.wallpaper" },
      { kind: "nav", page: "dock", key: "settings.dock.title" },
      { kind: "nav", page: "hotcorners", key: "settings.hotCorners" },
      { kind: "nav", page: "lock", key: "settings.passcode", sub: () => lockSub },
    ],
    // 账户与功能：语言 / iCloud / AI 与智能 / 隐私与安全性
    [
      { kind: "nav", page: "language", key: "settings.language", sub: () => langVal },
      { kind: "nav", page: "ime", key: "settings.ime", sub: () => imeSub },
      // REQ-A488: 「键盘快捷键」. The page, its title (`PAGE_KEY.keyboard`), its search aliases and its
      // render branch all existed — the index row did not, and the search only walks the index rows,
      // so **nothing in the UI could reach the one page that rebinds or disables a shortcut**. It sits
      // next to 输入法 for the same reason macOS keeps 「键盘」 and 「键盘快捷键」 side by side.
      { kind: "nav", page: "keyboard", key: "settings.keyboard" },
      { kind: "nav", page: "account", key: "settings.icloudRow", sub: () => icloudSub },
      { kind: "nav", page: "ai", key: "settings.ai" },
      { kind: "nav", page: "privacy", key: "settings.privacy" },
      { kind: "nav", page: "spy", key: "settings.spy" },
      { kind: "nav", page: "guard", key: "settings.guard" },
    ],
    // 系统：关于本机 / 窗口与形态 / 系统监控与开发者
    //
    // 企业功能 sits **above** 系统 (REQ-A584): it is an administrative surface, and iOS keeps the
    // device/organisation material at the bottom of Settings where the user does not trip over it.
    [
      { kind: "nav", page: "enterprise", key: "settings.enterprise" },
    ],
    [
      { kind: "nav", page: "about", key: "settings.about", sub: () => aboutSub },
      { kind: "nav", page: "window", key: "settings.window" },
      { kind: "nav", page: "link", key: "settings.link" },
      { kind: "nav", page: "diagnostics", key: "settings.diagnostics" },
    ],
  ];

  const allRows = SECTIONS.flat();
  const rowLabel = (r: Row): string => t(r.key);
  const rowSub = (r: Row): string => (r.kind === "nav" && r.sub ? r.sub() : "");
  const rowId = (r: Row): string => (r.kind === "nav" ? r.page : r.key);
  const extraOf = (r: Row): string[] => (r.kind === "nav" ? EXTRA[r.page] ?? [] : []);
  /** The searchable text of one row (label + live subtitle + synonyms). One helper,
   * so the grouped index search and the tablet sidebar filter cannot drift apart. */
  const rowSearchText = (r: Row): string =>
    `${rowLabel(r)} ${rowSub(r)} ${extraOf(r).join(" ")}`.toLowerCase();
  const matches = (r: Row, needle: string): boolean => rowSearchText(r).includes(needle);
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

  /* ---- Tablet master-detail (iPadOS Settings) ----------------------------------
   *
   * The decision belongs to `lib/formLayout::masterDetail`, which consumes the host's
   * **class** and its measured **columns + screen** from the shell's one layout
   * snapshot (`shellState.layoutSnap`, the same authority `Shell.svelte` renders
   * against) — never the WebView's own width. `columns` gains its second behavioral
   * consumer here (it previously only gated the split surface). When the surface is
   * too narrow (phone, a narrow tablet window, or a not-yet-measured screen) the
   * sidebar is not shown and the screen is exactly the grouped list + push page it
   * has always been — a byte-for-byte unchanged phone path. */
  const snap = $derived(layoutSnap());
  const md = $derived(masterDetail(snap?.form ?? "phone", snap?.columns ?? 0, snap?.screen_w ?? 0));
  const wide = $derived(md.sidebar);
  /** Sidebar rows: the navigable pages (a switch row has no page to show). */
  const navRows = SECTIONS.flat().filter((r): r is Extract<Row, { kind: "nav" }> => r.kind === "nav");
  const sidebarRows = $derived.by(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return navRows;
    return navRows.filter((r) => matches(r, needle));
  });
  /** The detail column, scrolled back to the top when a sidebar row is chosen. */
  let detailEl = $state<HTMLElement | null>(null);
</script>

{#snippet rowView(row: Row)}
  {#if row.kind === "switch"}
    <ToggleRow label={t(row.key)} on={row.on()} ontoggle={row.toggle} />
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

<!-- Search field (iOS: sits under the big title, live-filters the rows). Shared by
     the phone index and the tablet sidebar so the two cannot drift. -->
{#snippet searchField()}
  <div class="relative mt-3">
    <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ios-body opacity-40">🔍</span>
    <input
      bind:value={q}
      type="search"
      placeholder={t("settings.searchPlaceholder")}
      aria-label={t("settings.searchPlaceholder")}
      class="w-full rounded-ios-input bg-black/5 px-4 py-2.5 pl-10 text-ios-body outline-none placeholder:text-neutral-400 dark:bg-white/10 dark:placeholder:text-neutral-500"
    />
    {#if searching}
      <button
        onclick={() => (q = "")}
        aria-label={t("settings.searchClear")}
        class="absolute right-2 top-1/2 -translate-y-1/2 grid h-6 w-6 place-items-center rounded-full text-ios-footnote opacity-50 active:scale-90"
      >
        ✕
      </button>
    {/if}
  </div>
{/snippet}

<!-- The sub-page body, rendered in the phone push page AND the tablet detail column.
     Deriving the branch from `page` in ONE place is what keeps the two carryings
     from offering different pages (the old shell held a single `AppComp` for the
     same reason). -->
{#snippet pageBody()}
  <div class="space-y-5 pt-3">
    {#if page === "wifi" || page === "bluetooth"}
      <RadioPage which={page} qs={qs} onToggle={toggleRadio} refusal={radioRefusal} storeError={quickErr} />
    {:else if page === "cellular"}
      <CellularPage />
    {:else if page === "hotspot"}
      <HotspotPage qs={qs} onToggle={toggleRadio} refusal={radioRefusal} storeError={quickErr} />
    {:else if page === "focus"}
      <FocusPage />
    {:else if page === "display"}
      <DisplayPage />
    {:else if page === "wallpaper"}
      <WallpaperPage />
    {:else if page === "dock"}
      <DockPage />
    {:else if page === "hotcorners"}
      <HotCornersPage />
    {:else if page === "language"}
      <LanguagePage />
    {:else if page === "ime"}
      <ImePage />
    {:else if page === "lock"}
      <LockPage />
    {:else if page === "ai"}
      <AiPage />
    {:else if page === "account"}
      <AccountPage />
    {:else if page === "diagnostics"}
      <DiagnosticsPage />
    {:else if page === "enterprise"}
      <EnterprisePage />
    {:else if page === "privacy"}
      <PrivacyPage />
    {:else if page === "spy"}
      <TelemetrySpyPage />
    {:else if page === "guard"}
      <NetGuardPage />
    {:else if page === "notifications"}
      <NotificationsPage />
    {:else if page === "push_management"}
      <PushManagementPage />
    {:else if page === "sound"}
      <SoundPage />
    {:else if page === "ringtone"}
      <RingtonePage />
    {:else if page === "recordings"}
      <RecordingsPage />
    {:else if page === "about"}
      <AboutPage />
    {:else if page === "window"}
      <WindowPage />
    {:else if page === "link"}
      <LinkPage />
    {:else if page === "keyboard"}
      <KeyboardPage />
    {/if}
  </div>
{/snippet}

{#if wide}
  <!-- Tablet master-detail (iPadOS Settings): categories beside the detail instead
       of a push page. The width is the host's measured screen; a narrow surface
       never reaches this branch (`lib/formLayout::masterDetail`). -->
  <div class="flex h-full min-h-0" data-testid="settings-split">
    <aside
      class="flex h-full min-h-0 shrink-0 flex-col border-r border-neutral-200/70 pr-1 dark:border-neutral-800"
      style={`width:${md.sidebarWidth}px`}
      aria-label={t("settings.indexTitle")}
      data-testid="settings-sidebar"
    >
      <div class="px-4 pb-2 pt-3">
        <h1 class={H1}>{t("settings.indexTitle")}</h1>
        {@render searchField()}
      </div>
      <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        {#each sidebarRows as row (rowId(row))}
          <button
            onclick={() => nav(row.page)}
            class={"flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left " +
              (page === row.page
                ? "bg-accent/15 font-semibold text-accent"
                : "active:bg-black/5 dark:active:bg-white/5")}
            aria-label={t(row.key)}
            aria-current={page === row.page ? "page" : undefined}
            data-testid={`settings-side-${row.page}`}
          >
            <span class={LABEL}>{t(row.key)}</span>
            {#if row.sub}
              <span class={VALUE}>{row.sub()}</span>
            {/if}
          </button>
        {/each}
        {#if sidebarRows.length === 0}
          <p class="px-1 py-4 text-center text-ios-body text-neutral-500 dark:text-neutral-400">{t("settings.noResults")}</p>
        {/if}
      </nav>
    </aside>
    <section
      bind:this={detailEl}
      class="min-h-0 flex-1 overflow-y-auto px-6 pb-10"
      data-testid="settings-detail"
    >
      <!-- Same surface as the narrow branch below: the split layout is a *different* template root,
           so a bar placed only in the narrow one would never appear on a tablet. (REQ-A790) -->
      <StoreErrorBar message={storeErr} />
      {#if page === "index"}
        <div class="flex h-full items-center justify-center px-8 text-center" data-testid="settings-detail-placeholder">
          <p class="text-ios-body text-neutral-500 dark:text-neutral-400">{t("settings.sidebarPlaceholder")}</p>
        </div>
      {:else}
        <h1 class={"pt-4 " + H1}>{t(PAGE_KEY[page as Sub])}</h1>
        {@render pageBody()}
      {/if}
    </section>
  </div>
{:else}
<div class="px-4 pb-10">
  <!-- A store write the host refused (REQ-A790). Only the cross-window page intent raises one:
       a request that could not be cleared would be served again on the next mount, so the user
       is told rather than left with a destination that silently re-fires. -->
  <StoreErrorBar message={storeErr} />
  {#if page === "index"}
    <h1 class={H1}>{t("settings.indexTitle")}</h1>

    {@render searchField()}

    {#if searching}
      <!-- Live search results (same canonical rows, flat) -->
      <div class="mt-3">
        {#if hits.length === 0}
          <p class="px-1 py-4 text-center text-ios-body text-neutral-500 dark:text-neutral-400">{t("settings.noResults")}</p>
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
          <p class="text-ios-body font-semibold text-neutral-900 dark:text-neutral-50">{t("settings.accountName")}</p>
          <p class="truncate text-ios-footnote text-neutral-600 dark:text-neutral-400">{t("settings.accountHint")}</p>
        </div>
        <span class={CHEVRON}>›</span>
      </button>

      <!-- Grouped rows (whitespace-separated cards, like iOS) -->
      <div class="mt-4 space-y-4">
        {#each SECTIONS as group, gi (group.map(rowId).join("|"))}
          <section class={GROUP}>
            {#each group as row, i (rowId(row))}
              {@render rowView(row)}
              {#if i < group.length - 1}<div class={SUB}></div>{/if}
            {/each}
            {#if gi === 0 && quickErr}
              <!-- The airplane switch (this group's one radio control) is the only part of the
                   index that writes `amos.settings`, so its refusal belongs in this card. -->
              <div class="px-4 pb-3"><StoreErrorBar message={quickErr} /></div>
            {/if}
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
    {@render pageBody()}
  {/if}
</div>
{/if}



