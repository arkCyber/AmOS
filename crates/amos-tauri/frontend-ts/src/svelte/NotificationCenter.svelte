<script lang="ts">
  // NotificationCenter.svelte — Svelte 5 (runes) port of the React control-center
  // sheet. CONTROLLED: the shell owns `open` (over propsBus "nc") and receives
  // shell actions (search/recents/edit/lock). Radio + torch tiles go through the
  // real `radio_*`/`flashlight_*` backend when bridged (authoritative), else fall
  // back to the SAME local policy so offline behaviour matches React. Notifications
  // list is reactive over the shared amos.notifications store.
  import { t } from "./locale.svelte";
  import { themeDark, toggleTheme } from "./theme.svelte";
  import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import {
    bridged,
    flashlightSet,
    flashlightStatus,
    rotationGet,
    rotationSet,
    type FlashlightPayload,
    type RadioControlReply,
  } from "../lib/backend";
  import {
    DEFAULT_ROTATION_MODE,
    ROTATION_KEY,
    ROTATION_MODES,
    classifyRotationOutcome,
    normalizeRotation,
    rotationFreezes,
    rotationLabelKey,
    type RotationMode,
  } from "../lib/rotation";
  import { radioManagedState, type RadioRefusalView } from "../lib/radioControl";
  import {
    BRIGHTNESS_KEY,
    MAX_BRIGHTNESS_PCT,
    MIN_BRIGHTNESS_PCT,
    normalizeBrightness,
  } from "../lib/brightness";
  import { RADIO_KEYS, radioDisplayOn, radioGated, readManagedSwitches, openRadioSettings, syncQuickRadios, tapRadio } from "../lib/quickRadio";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { iconSvg, quickIcon } from "../lib/sysIcons";
  import { propsChannel } from "./propsBus";
  import {
    clearNotificationHistory,
    deleteNotification,
    markNotificationRead,
  } from "../lib/pushNotifications";
  import { createStoreValue } from "./store";
  // REQ-A1375：拒绝用**共用**的那一行说出来（与 `ControlCenter` ∕ 设置页各叶子同一条纪律、
  // 同一枚 `data-testid`）—— 同一个事实不该有第二种说法，测试也不该去猜第二个靶子。
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { cellularRadio } from "./cellularRadio";
  import { installCellularSignal } from "../lib/cellularHost";
  import { CELLULAR_KEY, defaultCellular, normalizeCellular, type CellularPrefs } from "../lib/cellular";
  import {
    cellularService,
    cellularStateKey,
    type RadioSignal,
  } from "../lib/cellularService";
  import {
    FLASHLIGHT_KEY,
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    flipFlashlight,
    flipLocation,
    flipQuick,
    locationEnabled,
    markNotifRead,
    normalizeFlashlight,
    normalizeNotifs,
    normalizeQuick,
    removeNotif,
    saveQuick,
    unreadCount,
    type FlashlightStore,
    type Notif,
    type QuickKey,
    type QuickSettings,
    type RadioKey,
  } from "../lib/settings";

  const QUICK: { key: QuickKey; label: string }[] = [
    { key: "wifi", label: "q.wifi" },
    { key: "bluetooth", label: "q.bluetooth" },
    { key: "airplane", label: "q.airplane" },
    { key: "darkmode", label: "q.dark" },
    { key: "dnd", label: "q.dnd" },
    { key: "location", label: "q.location" },
  ];

  interface NcProps {
    open: boolean;
  }
  const bus = propsChannel<NcProps>("nc");
  let incoming = $state<NcProps | null>(null);
  $effect(() => {
    const un = bus.subscribe((v) => {
      if (v !== undefined) incoming = v;
    });
    return un;
  });
  const open = $derived(incoming?.open ?? false);

  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  const flashStore = createStoreValue<unknown>(FLASHLIGHT_KEY, {});
  const rotationStore = createStoreValue<unknown>(ROTATION_KEY, {});
  let rotation = $state<RotationMode>(DEFAULT_ROTATION_MODE);
  /**
   * Whether this platform can turn the display — **three-valued on purpose**. `null` is
   * "the host never answered" (the mount read failed: `rotation_get` resolves `null`
   * exactly as a *failed* command does, see `lib/backend.ts`), and that is NOT the same
   * fact as `false` ("the host answered that it cannot"). Folding the two into one
   * boolean made a failed read print 「此宿主无法旋转」 — a claim about the user's own
   * device that nothing had established. Same three-way split `DeviceMicButton`'s
   * `osMic` keeps for `RECORD_AUDIO` (REQ-A787 / F-AND-010).
   */
  let rotationAvailable = $state<boolean | null>(null);
  /** The honest line after a `rotation_set` that did not reach the platform. */
  let rotationNote = $state("");
  // G-β-1 · 屏幕降亮（本机内容）。与桌面共用 `lib/brightness.ts` 的**唯一**真源：
  // slider 写 `amos.brightness`，Shell 的**非桌面**分支订阅同一个 key 渲染黑色遮罩
  // （`data-testid="brightness-overlay"`）。手机上整个设备 UI 就是这一个 WebView，
  // 所以这是「本机显示」而不是桌面的「仅桌面内容」—— 文案走 `nc.brightnessHint`，
  // 不照搬桌面的 `cc.brightnessScope`（那一句在手机上会是错的）。
  const brightnessStore = createStoreValue<unknown>(BRIGHTNESS_KEY, {});
  let brightnessPct = $state<number>(MAX_BRIGHTNESS_PCT);
  $effect(() => {
    const un = brightnessStore.subscribe((v) => {
      brightnessPct = normalizeBrightness(v).pct;
    });
    return un;
  });
  /** 这一枚滑杆被存储拒写时的句子 —— 渲染在滑杆自己那一块里（见下面的亮度块）。 */
  let brightnessErr = $state("");
  const setBrightnessPct = (next: number) => {
    const clamped = Math.max(MIN_BRIGHTNESS_PCT, Math.min(MAX_BRIGHTNESS_PCT, Math.round(next)));
    if (clamped === brightnessPct) return; // 减少没必要的写盘
    // 这一枚键的**权威读者是壳里那层降亮遮罩**（上面注释逐字点名的
    // `data-testid="brightness-overlay"`，与桌面共用同一枚键）—— 所以拒写时本地
    // `brightnessPct` 必须原样不动，否则滑杆与读数都移到了新值、屏幕根本没有降亮：同屏两处
    // 说同一件事，只有一处是真的（F-SH-632 那一族的**同键第二个写入者**；桌面那一位
    // `ControlCenter.setBrightnessPct` 已在 REQ-A1368 修好，本处是它的孪生）。
    if (!writeStoreValueChecked(BRIGHTNESS_KEY, { pct: clamped })) {
      brightnessErr = t("common.storeWriteFailed");
      return;
    }
    brightnessErr = "";
    brightnessPct = clamped;
  };
  let settings = $state<QuickSettings>({});
  let notifs = $state<Notif[]>([]);
  let flash = $state<FlashlightStore>({ on: false, torch_present: true });
  let cellPrefs = $state<CellularPrefs>(defaultCellular());
  // `null` = the host has not answered (see `svelte/cellularRadio.ts`). This tile
  // *hides* on that value, so the third state changes nothing here visually — which
  // is exactly why the two Settings pages that *print* it needed it too (REQ-A1539).
  let radio = $state<RadioSignal | null>(null);
  const cellularStore = createStoreValue<unknown>(CELLULAR_KEY, {});
  $effect(() => {
    const un = settingsStore.subscribe((v) => (settings = normalizeQuick(v)));
    return un;
  });
  // Mount-time **device truth** (REQ-A185): ask the radios once so these tiles show
  // what the device holds instead of only the persisted intent (the Mock made the two
  // identical; the real provider makes the difference visible). A failure keeps the
  // stored values.
  let radioRead = false;
  $effect(() => {
    if (radioRead || !bridged()) return;
    radioRead = true;
    void (async () => {
      const next = await syncQuickRadios(settings);
      if (next) persistSettings(next);
    })();
  });

  // Which switches the **platform** owns (REQ-A202). Asked once, on mount, exactly like
  // the status read above: a tile that cannot work must say so *before* the user taps it
  // (and must offer the system surface), instead of swallowing a refusal that `invoke`
  // reports as `null`.
  let ctlRead = false;
  let radioCtl = $state<Record<RadioKey, RadioControlReply | null>>({
    wifi: null,
    bluetooth: null,
    airplane: null,
    hotspot: null,
  });
  $effect(() => {
    if (ctlRead || !bridged()) return;
    ctlRead = true;
    void (async () => {
      radioCtl = await readManagedSwitches();
    })();
  });

  const managed = (key: RadioKey) => radioManagedState(radioCtl[key], key);
  /** The radios whose switch this platform owns — each gets its own honest line. */
  const managedRadios = $derived(
    (["wifi", "bluetooth", "airplane"] as RadioKey[]).filter((k) => managed(k).managed),
  );
  /** `true` when the last managed tap could not open the system surface. */
  let managedFailed = $state(false);
  /**
   * The last **refused write** (REQ-A203): `radio_set` now answers `applied: false`
   * with machine tokens instead of failing into `null`, so "the device refused this
   * time" is a visible line with an optional way out — not just a ledger entry.
   */
  let refused = $state<RadioRefusalView | null>(null);
  let refusedKey = $state<RadioKey | null>(null);
  $effect(() => {
    const un = notifStore.subscribe((v) => (notifs = normalizeNotifs(v)));
    return un;
  });
  $effect(() => {
    const un = flashStore.subscribe((v) => (flash = normalizeFlashlight(v)));
    return un;
  });
  $effect(() => {
    const un = rotationStore.subscribe((v) => (rotation = normalizeRotation(v)));
    return un;
  });
  // Mount-time **device truth** (REQ-A185 idiom): ask the host once whether this
  // platform can actually turn the display. Desktop / CI answer `available: false`,
  // so the tile says "this host cannot rotate" instead of looking like a switch
  // that silently does nothing. A failure keeps the persisted intent.
  let rotationRead = false;
  $effect(() => {
    if (rotationRead || !bridged()) return;
    rotationRead = true;
    void (async () => {
      const snap = await rotationGet();
      if (snap) rotationAvailable = snap.available;
    })();
  });
  $effect(() => {
    const un = cellularStore.subscribe((v) => (cellPrefs = normalizeCellular(v)));
    return un;
  });
  $effect(() => {
    const un = cellularRadio.subscribe((v) => (radio = v));
    return un;
  });
  // Mount-time **device truth** (the REQ-A185 idiom, same as the rotation read above):
  // the tile's `radio` store started at "no modem" and, until this round, *nothing*
  // in production ever wrote it — so a real phone with a SIM still showed no bars.
  // Ask the host once; `installCellularSignal` installs a reading only when the host
  // actually gave one. The store's third state (`null`, "nothing has read this
  // device") is what keeps a failed call from becoming a "no modem" verdict — on the
  // surfaces that *print* it, this tile merely stays hidden either way (REQ-A1539).
  let cellularRead = false;
  $effect(() => {
    if (cellularRead || !bridged()) return;
    cellularRead = true;
    void installCellularSignal();
  });

  // 通知中心**不**播种演示通知（REQ-A1249）：一条通知陈述的是一次**事件**，不是内容 ——
  // 凭空写几条进 `amos.notifications`，等于向用户报告若干次从未发生的投递，而
  // `NotificationBanner` 就在同一个壳里、又排在本组件**之前**（`Shell.svelte:936` 对 :940），
  // 于是种子里的最新一条被当成刚到达播报：toast + 提示音 + 震动。这个键还是**共享**的，
  // 伪造的行因此也出现在桌面通知面板、「通知」设置页与「推送通知管理」页上 —— 而桌面面板
  // 那句注释的原话正是「a panel that invents entries reports arrivals that never
  // happened」，它的测试也钉着「no demo seeding」。空表就说自己是空的。

  const dark = $derived(themeDark());
  const quiet = $derived(dndActive(settings));
  // Controlled cellular: only meaningful once a REAL radio is present (on-device).
  // No reading (`null`) → the module below is not drawn at all; no modem → also not
  // drawn. The two states differ only for the surfaces that print a sentence, and
  // this `null` arm is what keeps the derived total rather than a guess (REQ-A1539).
  const cellStatusKey = $derived(
    radio === null
      ? "settings.cellularUnknown"
      : cellularStateKey(cellularService(cellPrefs, radio)),
  );
  let rootEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!open || !rootEl) return;
    return attachFocusTrap(rootEl, close);
  });

  const mergeFlash = (p: FlashlightPayload): FlashlightStore => ({
    on: p.on,
    torch_present: p.torch_present,
  });

  /**
   * 快速开关那一栏的显示由 store 决定（`on` 读的是 `settings`），拒写时它**不动** ——
   * 于是不会出现假读数，但一次被拒的点击就成了「什么也没发生、也没有一句话」。同一张面板
   * 里的单选框会说拒绝原因（`nc-radio-refused`）、亮度滑杆会说 `common.storeWriteFailed`
   * （`brightnessErr` + `StoreErrorBar`，第 142 行），只有这几枚开关把裁决丢进
   * `writeStoreValue` 的 `void`。这里接回来，报法与滑杆逐字一致。
   *
   * 深色那一枚同样走这里：主题真值是另一枚键，而拒写多半来自整块 localStorage 不可用
   * —— 那时 `THEME_KEY` 也写不进去，屏幕会真的变暗、重启后却不保持；所以它照旧立即
   * 切换，只是如实报账。
   */
  let quickErr = $state("");
  const persistSettings = (next: QuickSettings) => {
    // `next` is a narrowed flip; `saveQuick` carries it onto the raw blob, which also
    // holds the AI provider and the cloud prefs (REQ-A1397 ∕ F-SH-656).
    if (!saveQuick(next)) {
      quickErr = t("common.storeWriteFailed");
      return;
    }
    quickErr = "";
  };

  const toggle = async (key: QuickKey) => {
    if (key === "darkmode") {
      const nextDark = !dark;
      persistSettings({ ...settings, darkmode: nextDark });
      toggleTheme();
      return;
    }
    if (key === "wifi" || key === "bluetooth" || key === "airplane") {
      await toggleRadio(key);
      return;
    }
    if (key === "location") {
      persistSettings(flipLocation(settings)); // defaults ON; tap flips OFF/ON
      return;
    }
    persistSettings(flipQuick(settings, key));
  };

  /**
   * Radio tiles: the rules (airplane gate, platform-owned switches, refusals, the re-read
   * after a failed write) live in `lib/quickRadio.ts` — one implementation shared with the
   * Settings screen and the desktop's Control Center. This screen only says what happened.
   */
  const toggleRadio = async (key: RadioKey) => {
    const out = await tapRadio({ key, settings, host: bridged(), managed: managed(key) });
    if (out.kind === "managed") {
      // A failed open must be visible: the alternative is a tile that silently does
      // nothing, which is exactly what REQ-A202 removed.
      managedFailed = !out.opened;
    } else if (out.kind === "applied") {
      managedFailed = false;
      refused = null;
      refusedKey = null;
    } else if (out.kind === "refused") {
      refused = out.refusal;
      refusedKey = out.refusal.noteKey ? key : null;
    }
    // Only a confirmed write is persisted; otherwise the store keeps the user's intent
    // while the tiles show the device's state (see `RadioTapOutcome`).
    if (out.persist) persistSettings(out.next);
    else settings = out.next;
  };

  /** Offer the real switch for the refused radio (only when a surface is known). */
  const openRefusedSettings = async () => {
    if (!refusedKey) return;
    managedFailed = !(await openRadioSettings(refusedKey));
  };

  /**
   * 手电筒那三处写入的裁决（REQ-A1385）。这一枚 tile 的显示**由 store 驱动**
   * （`flashStore.subscribe`，第 210 行），所以拒写时读数不动 —— 没有假读数，但也正
   * 因为不动，一次被拒的点击就成了「按下去什么也没发生、也没有一句话」。同一张面板里
   * 的快速开关与亮度滑杆都说话了，只有这一枚（和下面的旋转锁）把裁决丢进 `void`。
   */
  let flashErr = $state("");
  const commitFlash = (next: FlashlightStore) => {
    if (!writeStoreValueChecked(FLASHLIGHT_KEY, next)) {
      flashErr = t("common.storeWriteFailed");
      return;
    }
    flashErr = "";
  };

  const toggleFlash = async () => {
    if (bridged()) {
      const snap = await flashlightSet(!flash.on);
      if (snap) {
        commitFlash(mergeFlash(snap));
        return;
      }
      const live = await flashlightStatus();
      if (live) {
        commitFlash(mergeFlash(live));
        return;
      }
      // REQ-A1463：两条命令都答了 `null`（宿主拒绝，或根本没应答 —— REQ-A296）。`flash`
      // 由 store 驱动，读数因此不动；但这一下不许是无声的空操作。这句话只说这条路径
      // **确立**的事实（问了、没有回答、状态未能确认），不借 `common.storeWriteFailed`
      // 去陈述一条本路径从未建立的原因。
      flashErr = t("nc.torchUnanswered");
      return;
    }
    commitFlash(flipFlashlight(flash));
  };

  /**
   * Commit one rotation mode. The host stores the intent and (on a device) applies
   * it; the reply's `outcome.state` is the fact we show. A non-applied outcome is
   * **not** hidden — desktop/CI reads `hostOnly` ("stored, this host has no
   * orientation to turn"), a device refusal reads its own state — because a tile
   * that silently pretends is exactly what this repo treats as a defect.
   */
  const tapRotation = async (mode: RotationMode) => {
    rotationNote = ""; // a new tap never inherits the last refusal's words
    if (!bridged()) {
      // 这条路径上 store 是**唯一**真源（没有宿主可问），所以先写、落了地才许动本地读数。
      // 旧的 `rotation = mode; writeStoreValue(…)` 把裁决丢进 `void`：拒写时
      // `writeJson` 不派发 `STORE_CHANGED_EVENT`，镜像订阅因此不会再把它拉回来，于是
      // Pill 已亮、`data-frozen` 已变 true、标题已换成新模式，而 `amos.rotation` 里什么
      // 也没有 —— 整块面板在陈述一个从未存下来的偏好，而且一声不吭（REQ-A1385）。
      if (!writeStoreValueChecked(ROTATION_KEY, { mode })) {
        rotationNote = "common.storeWriteFailed";
        return;
      }
      rotation = mode;
      return;
    }
    const reply = await rotationSet(mode);
    if (!reply) {
      // A `null` reply is a **failed command**, not a refusal with words to show (the
      // host never answered; `invoke` resolves `null` on failure and never rejects). The
      // old `return` made this a tap that silently did nothing — the exact "switch that
      // silently does nothing" this tile's own comment refuses to be. REQ-A1274 / F-SH-548.
      rotationNote = "rotation.setFailed";
      return;
    }
    const next = normalizeRotation(reply.mode);
    // `next` 是**设备自己报的状态**，不是用户的意图 —— 所以这一条路径上本地照旧跟设备走
    // （把读数按在原地才是假读数）。拒写说明的是另一件事：这次偏好没能记下来
    // （`rotation.ts` 把 `amos.rotation` 定为「用户设的偏好」，Rust 启动时靠它
    // `apply_persisted`）。两句话都可能成立，一个槽只放一句 —— 设备那句优先，因为
    // 「这台宿主没转过去」比「没存下来」更贴近用户刚做的那一下（REQ-A1385）。
    const saved = writeStoreValueChecked(ROTATION_KEY, { mode: next });
    rotation = next;
    rotationAvailable = reply.available;
    const out = classifyRotationOutcome(reply);
    const outcomeNote =
      out.kind === "applied" || out.kind === "host_only" ? "" : "rotation.notApplied";
    if (outcomeNote !== "") rotationNote = outcomeNote;
    else if (!saved) rotationNote = "common.storeWriteFailed";
  };

  /**
   * A push row in this list is a **projection** of the device's history: `osPushWatcher`
   * asks `push_get_history` again every few seconds and writes back any record the store no
   * longer holds. So the two removal controls must reach the device too, or the delivery is
   * on screen again a few seconds later — `markRead` below has always done this; these two,
   * written before the push projection existed, did not.
   *
   * The device's refusal therefore has to be **said out loud**: the rows are already gone
   * by the time the next poll writes them back, which is exactly why they cannot be the
   * disclosure. One note slot carries both verbs' refusals — the panel explains the tap the
   * user just made, so a second one replaces the first rather than stacking.
   */
  let pushNote = $state("");
  /**
   * 这三枚通知动词对 `NOTIF_KEY` 的写入判决（REQ-A1391 ∕ FMEA F-SH-650）。
   *
   * 与桌面那块面板逐字同一条纪律、同一个组件（`DesktopNotificationCenter.svelte::persist` +
   * `StoreErrorBar`）：存储拒写时本地列表**不动**（`writeJson` 拒写不派发
   * `STORE_CHANGED_EVENT`，镜像订阅因此不会把它拉回来），屏幕与盘仍然一致 —— 但那一下点击
   * 成了「什么也没发生、也没有一句话」。这里比别处更重：`clear` ∕ `dismiss` 的**设备那一半
   * 已经做完了**，而 `osPushWatcher` 的 `mergePushHistory(held, records, …)` 只会把设备仍然
   * 持有的记录**补进**存储、从不删除设备已经没有的行 —— 于是一次「设备删了、盘上没删」的移除
   * 会**永久**留在屏幕上（上一轮 REQ-A1385 的如实边界把它留给单独一轮，理由是「行会被下一次
   * 轮询写回」；那只对**反方向**成立：本地删了、设备没删才会被写回）。
   *
   * 与 `pushNote` 分开放：那一槽说的是**设备**没照做，这一处说的是**存储**没写下去 —— 一次
   * 写失败不该抹掉另一件事的说法（桌面那块面板的 `storeError` ∕ `pushErr` 是同一条划分）。
   */
  let notifErr = $state("");
  const persistNotifs = (next: Notif[]): void => {
    notifErr = writeStoreValueChecked(NOTIF_KEY, next) ? "" : t("common.storeWriteFailed");
  };
  const clear = async () => {
    pushNote = "";
    const hadDeliveries = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])).some(
      (n) => n.source === "push",
    );
    // The device half is the destructive one and it can be refused, so it goes **first** and
    // its answer decides the local half — the rule `settings/NotificationsPage.svelte`'s
    // `clearAll` (REQ-A1238) and `PushSettings.clearPushHistory` already state. `bridged()`
    // bounds the gate to its reason: without a host there is no history to clear and no poll
    // to write one back, so that tap is purely local and no unanswerable verdict blocks it.
    if (hadDeliveries && bridged() && !(await clearNotificationHistory())) {
      pushNote = t("pushSettings.clearFailed");
      return;
    }
    persistNotifs([]);
  };
  /**
   * The same projection rule as `clear` above, one row at a time. The verdict here is **not**
   * the command's boolean: `delete_notification` answers whether the device held the id, and a
   * well-formed `false` ("it never had this one") is a **success** — removing locally is right.
   * What can strand the row is a call that never reached the device, and that is exactly the
   * `null` (REQ-A1352). It used to be recovered from the *per-command* `bridgeDiag` slot,
   * which is one entry shared by every call of `push_delete_notification`: two dismissals in
   * flight at once each read whichever outcome landed last, so a refusal could be hidden by
   * another row's success and the row removed while the device still held it. The returned
   * value is now the answer.
   *
   * `bridged()` still bounds the *no-host* case: without a host there is nothing to delete and
   * no poll to write it back, so that tap stays purely local rather than showing a notice
   * about a device that does not exist.
   */
  const dismiss = async (id: string) => {
    pushNote = "";
    if (notifs.find((n) => n.id === id)?.source === "push") {
      const verdict = await deleteNotification(id);
      if (verdict === null && bridged()) {
        pushNote = t("pushSettings.deleteFailed");
        return;
      }
    }
    persistNotifs(removeNotif(notifs, id));
  };

  /** Unread **push** deliveries. Shell-made notifications carry no read flag (they
   * are removed when opened), so this counts only what the device told us is unread. */
  const unread = $derived(unreadCount(notifs));

  /**
   * Mark one delivery read: write locally — a screen must show the change the user
   * just made, and the write's verdict decides whether it does — then on the device,
   * best-effort. `markNotificationRead` is a no-op without a host bridge, and a device
   * that refuses cannot un-read the list (so that half stays `void` by design, and it
   * has no slot of its own: the returned value is documented at its definition).
   */
  const markRead = (id: string) => {
    persistNotifs(markNotifRead(notifs, id));
    void markNotificationRead(id);
  };

  const close = () => bus.emit("close");
  const act = (name: string) => {
    bus.emit(name); // search / recents / edit / lock
    bus.emit("close");
  };

</script>

{#if open}
  <div
    bind:this={rootEl}
    role="dialog"
    aria-modal="true"
    aria-label={t("nc.title")}
    class="drop-in absolute inset-0 z-40 flex flex-col bg-white/45 p-4 backdrop-blur-2xl backdrop-saturate-150 dark:bg-neutral-950/60"
  >
    <div class="flex items-center justify-between px-1">
      <h2 class="text-xl font-semibold tracking-tight">{t("nc.title")}</h2>
      <button
        onclick={close}
        class="rounded-full bg-neutral-200/80 px-4 py-1.5 text-sm font-medium text-accent transition active:scale-95 dark:bg-white/10"
      >{t("common.done")}</button>
    </div>

    <!-- Control-center system actions (formerly the home top bar). -->
    <div class="mt-2 flex items-center justify-end gap-2">
      <button aria-label={t("shell.search")} title={t("shell.search")} onclick={() => act("search")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"><span data-icon="search">{@html iconSvg("search", "h-[17px] w-[17px]")}</span></button>
      <button aria-label={t("shell.recents")} title={t("shell.recents")} onclick={() => act("recents")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"><span data-icon="recents">{@html iconSvg("recents", "h-[17px] w-[17px]")}</span></button>
      <button aria-label={t("a11y.editHome")} title={t("a11y.editHome")} onclick={() => act("edit")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"><span data-icon="pencil">{@html iconSvg("pencil", "h-[17px] w-[17px]")}</span></button>
      <!-- 系统级手写（REQ-A1590）：控制中心从任意应用的上边缘都能拉下来，所以这是手写笔
           「系统级」的那扇门。动作经 "nc" 通道交给壳（`openSysInk`），本面板自己不必知道
           它把哪个浮层换掉了。 -->
      <button aria-label={t("sysInk.title")} title={t("sysInk.title")} data-testid="nc-ink" onclick={() => act("ink")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"><span data-icon="ink">{@html iconSvg("ink", "h-[17px] w-[17px]")}</span></button>
      <button aria-label={t("a11y.lock")} title={t("a11y.lock")} onclick={() => act("lock")} class="grid h-9 w-9 place-items-center rounded-full bg-white/55 text-sm ring-1 ring-white/50 shadow-sm transition active:scale-90 dark:bg-white/10 dark:ring-white/10"><span data-icon="lock">{@html iconSvg("lock", "h-[17px] w-[17px]")}</span></button>
    </div>

    <!-- G-β-1 · 屏幕亮度滑杆（本机内容降亮；与桌面共用 lib/brightness.ts）。 -->
    <div
      class="mt-3 rounded-3xl bg-white/55 px-4 py-3 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:ring-white/10"
      data-testid="nc-brightness-block"
    >
      <div class="flex items-center justify-between">
        <span class="flex items-center gap-2.5 text-sm font-semibold text-neutral-800 dark:text-neutral-200">
          <span data-icon="brightness" class="text-xl leading-none">{@html iconSvg(quickIcon("brightness"), "h-[22px] w-[22px]")}</span>
          {t("cc.brightness")}
        </span>
        <span class="text-xs font-medium tabular-nums opacity-70" data-testid="nc-brightness-readout">
          {brightnessPct}%
        </span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={brightnessPct}
        aria-label={t("cc.brightness")}
        title={`${t("cc.brightness")} — ${t("nc.brightnessHint")}`}
        data-testid="nc-brightness"
        oninput={(e) => setBrightnessPct(Number((e.target as HTMLInputElement).value))}
        class="mt-2 h-1 w-full appearance-none rounded-full bg-black/10 accent-accent dark:bg-white/20"
      />
      <!-- 渲染在**它自己的控件那一块**里（滑杆的正下方），不是表单别处：一条用户接不到刚拖动
           那枚滑杆上的拒绝，读起来就是「什么也没发生」（F-SH-270 的形状）。 -->
      <StoreErrorBar message={brightnessErr} />
      <p class="mt-1.5 text-[11px] leading-snug opacity-60">{t("nc.brightnessHint")}</p>
    </div>

    <!-- Torch / flashlight tile. -->
    <button
      onclick={() => void toggleFlash()}
      aria-pressed={flash.on}
      disabled={!flash.torch_present}
      class={
        "mt-3 flex items-center justify-between rounded-3xl px-4 py-3 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-40 " +
        (flash.on
          ? "bg-amber-400 text-neutral-900 shadow-[0_6px_16px_rgba(245,158,11,0.45)]"
          : "bg-white/55 text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10")
      }
    >
      <span class="flex items-center gap-2.5">
        <span data-icon="flashlight" class="text-xl leading-none">{@html iconSvg("flashlight", "h-[22px] w-[22px]")}</span>
        {t("q.flashlight")}
      </span>
      {#if !flash.torch_present}
        <span class="text-xs font-medium opacity-50">{t("nc.torchNone")}</span>
      {:else}
        <span class={"text-xs font-medium " + (flash.on ? "opacity-80" : "opacity-50")}>
          {flash.on ? t("nc.torchOn") : t("nc.torchOff")}
        </span>
      {/if}
    </button>
    <!-- 手电筒被存储拒写时的那一句（渲染在它自己那一枚的正下方，不与别处共用槽位）。 -->
    <StoreErrorBar message={flashErr} />

    <!-- Rotation lock / forced orientation (REQ-A677). Four modes, one committed
         intent: the host `rotation_set` stores it and (on a device) turns the
         display. `auto` = follow gravity; the rest freeze the display. When this
         host cannot apply it (desktop / CI, `available: false`) the tile says so
         rather than looking like a switch that silently does nothing. -->
    <div
      class="mt-3 rounded-3xl bg-white/55 px-4 py-3 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:ring-white/10"
      data-testid="nc-rotation"
      data-frozen={rotationFreezes(rotation)}
    >
      <div class="flex items-center justify-between text-sm font-semibold text-neutral-800 dark:text-neutral-200">
        <span class="flex items-center gap-2.5">
          <span data-icon="rotation" class="text-xl leading-none">{@html iconSvg("rotateCcw", "h-[22px] w-[22px]")}</span>
          {t("rotation.lock")}
        </span>
        {#if rotationAvailable === false && bridged()}
          <span class="text-xs font-medium opacity-50">{t("rotation.unavailable")}</span>
        {:else if rotationAvailable === null && bridged()}
          <!-- The host never answered: say we could not check, never claim the device
               cannot rotate (see `rotationAvailable`). -->
          <span
            class="text-xs font-medium opacity-50"
            data-testid="nc-rotation-read-failed"
          >{t("rotation.readFailed")}</span>
        {:else}
          <span class="text-xs font-medium opacity-70">{t(rotationLabelKey(rotation))}</span>
        {/if}
      </div>
      <div class="mt-2 grid grid-cols-4 gap-1.5">
        {#each ROTATION_MODES as m (m)}
          <button
            onclick={() => void tapRotation(m)}
            aria-pressed={rotation === m}
            data-testid={`nc-rotation-${m}`}
            class={
              "rounded-2xl py-2 text-[11px] font-medium transition active:scale-95 " +
              (rotation === m
                ? "bg-accent text-white shadow-[0_4px_12px_rgba(10,132,255,0.35)]"
                : "bg-white/60 text-neutral-700 ring-1 ring-white/50 dark:bg-white/10 dark:text-neutral-300 dark:ring-white/10")
            }
          >
            {t(rotationLabelKey(m))}
          </button>
        {/each}
      </div>
      {#if rotationNote}
        <p role="status" data-testid="nc-rotation-note" class="mt-2 text-[11px] leading-snug text-danger">
          {t(rotationNote)}
        </p>
      {/if}
    </div>

    <!-- Cellular module — only when a REAL modem source answered with a radio. A
         device that answered "no modem" (`present:false`) and a device that never
         answered (`null`) both stay hidden: honest, never a fake phone affordance. -->
    {#if radio?.present}
      <div
        class="mt-3 flex items-center justify-between rounded-3xl bg-white/55 px-4 py-3 text-sm font-semibold text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10"
        data-testid="nc-cellular"
      >
        <span class="flex items-center gap-2.5">{t("settings.cellular")}</span>
        <span class="text-xs font-medium opacity-70">{t(cellStatusKey)}</span>
      </div>
    {/if}

    <!-- Quick settings tiles. -->
    <div class="mt-4 grid grid-cols-3 gap-2.5">
      {#each QUICK as q (q.key)}
        {@const ctl = q.key === "wifi" || q.key === "bluetooth" || q.key === "airplane" ? managed(q.key) : { managed: false, noteKey: "", surface: null }}
        <!-- Airplane mode owns the other radios and `tapRadio` refuses to even attempt
             them, so the tile must say so *before* the tap — the same rule the desktop
             Control Center and the settings page follow. `radioGated` is the predicate
             tapRadio itself reads; the `RADIO_KEYS` guard keeps a non-radio tile
             (darkmode / location) out of a predicate that is about radios. -->
        {@const isRadio = (RADIO_KEYS as readonly string[]).includes(q.key)}
        {@const gated = isRadio && radioGated(settings, q.key as RadioKey)}
        <!-- And what a gated tile *reads*: off — the same `radioDisplayOn` every other
             radio surface asks, so the Wi-Fi tile cannot sit lit above the very sentence
             that says Wi-Fi is closed. -->
        {@const on = q.key === "darkmode" ? dark : q.key === "location" ? locationEnabled(settings) : isRadio ? radioDisplayOn(settings, q.key as RadioKey) : !!settings[q.key]}
        <button
          onclick={() => void toggle(q.key)}
          disabled={gated}
          aria-pressed={on}
          aria-label={ctl.managed ? `${t(q.label)} · ${t("radio.openSettings")}` : undefined}
          data-managed={ctl.managed ? "system" : undefined}
          class={
            "flex flex-col items-center justify-center gap-1.5 rounded-3xl py-4 text-[11px] font-medium backdrop-blur transition enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 " +
            (on
              ? "bg-accent text-white shadow-[0_6px_16px_rgba(10,132,255,0.35)]"
              : "bg-white/55 text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10")
          }
        >
          <span data-icon={q.key} class="text-xl leading-none">{@html iconSvg(quickIcon(q.key), "h-[22px] w-[22px]")}</span>
          {t(q.label)}
          <!-- A switch the platform owns is not this app's to move: the tile says so
               instead of looking like a button that silently does nothing (REQ-A202). -->
          {#if ctl.managed}
            <span aria-hidden="true" class="text-[10px] leading-none opacity-70">⚙</span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- 快速开关被存储拒写时的那一句（渲染在它自己那一栏的正下方）。 -->
    <StoreErrorBar message={quickErr} />

    <!-- The explanation for each switch the platform owns, and whether the last managed
         tap could actually open the system surface (REQ-A202). -->
    {#if managedFailed}
      <div class="mt-2 px-1">
        <p role="status" data-testid="nc-radio-managed-failed" class="text-[11px] leading-snug text-danger">
          {t("radio.openSettingsFailed")}
        </p>
      </div>
    {/if}
    <!-- A refused write (REQ-A203): the device said no *this time* — say so, mirror the
         real state, and offer the system switch when there is one to offer. -->
    {#if refused}
      <div class="mt-2 px-1">
        <p role="status" data-testid="nc-radio-refused" class="text-[11px] leading-snug text-danger">
          {refused.noteKey === "" ? t("radio.refused.unknown") : t(refused.noteKey)}
        </p>
        {#if refused.surface !== null && refusedKey}
          <button
            onclick={() => void openRefusedSettings()}
            data-testid="nc-radio-refused-open-settings"
            class="mt-1 text-[11px] font-semibold text-accent underline underline-offset-2"
          >
            {t("radio.openSettings")}
          </button>
        {/if}
      </div>
    {/if}
    {#if managedRadios.length > 0}
      <div class="mt-2 space-y-0.5 px-1">
        {#each managedRadios as key (key)}
          <p data-testid="nc-radio-managed" class="text-[11px] leading-snug opacity-70">
            {t(managed(key).noteKey)}
          </p>
        {/each}
      </div>
    {/if}
    <!-- The reason the gated tiles above are inert (REQ-A1082): the same sentence the
         settings page shows for the same state, so both screens describe one fact once. -->
    {#if RADIO_KEYS.some((k) => radioGated(settings, k))}
      <div class="mt-2 px-1">
        <p data-testid="nc-airplane-blocks" class="text-[11px] leading-snug opacity-70">
          {t("settings.airplaneBlocks")}
        </p>
      </div>
    {/if}

    <div class="mt-3 flex items-center justify-between px-1">
      <span class="text-xs font-semibold uppercase tracking-widest opacity-50">
        {#if quiet}
          <span class="inline-flex items-center gap-1 normal-case tracking-normal text-accent">
            <span data-icon="moon" class="grid h-4 w-4 place-items-center">{@html iconSvg("moon", "h-4 w-4")}</span>
            {t("nc.dnd")}
          </span>
        {:else}
          {notifs.length} ·{#if unread > 0} {t("nc.unread", { count: unread })}{/if}
        {/if}
      </span>
      <button onclick={clear} aria-label={t("nc.clear")} class="text-xs font-medium text-accent hover:underline">{t("nc.clear")}</button>
    </div>

    {#if pushNote}
      <p role="status" data-testid="nc-push-refused" class="mt-2 px-1 text-[11px] leading-snug text-danger">
        {pushNote}
      </p>
    {/if}
    <!-- 存储拒写时的那一句（REQ-A1391）——与 `pushNote` 分开：那说的是设备没照做，
         这一处说的是盘没写下去。共用组件、与亮度 ∕ 手电筒 ∕ 快速开关逐字同一条纪律。 -->
    <StoreErrorBar message={notifErr} />

    <div class="mt-2 flex-1 space-y-2.5 overflow-auto pr-0.5">
      {#if notifs.length === 0}
        <p class="py-12 text-center text-sm opacity-50">{t("nc.empty")}</p>
      {:else}
        {#each notifs as n (n.id)}
          {@const unreadPush = n.source === "push" && n.read === false}
          <div
            data-testid={`nc-notif-${n.id}`}
            class={
              "rounded-3xl p-3.5 shadow-sm ring-1 ring-black/5 dark:ring-white/10 " +
              (quiet || (n.source === "push" && n.read === true)
                ? "bg-white/30 opacity-60 saturate-50 dark:bg-white/5"
                : "bg-white/60 dark:bg-white/10")
            }
          >
            <div class="flex items-center justify-between text-xs">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate font-semibold">{n.icon} {n.app ?? n.title}</span>
                <!-- A delivery from the push backend says so, instead of blending into the
                     shell's own notifications (REQ-A383). -->
                {#if n.source === "push"}
                  <span
                    data-testid="nc-push-badge"
                    class="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent"
                  >{t("nc.pushBadge")}</span>
                {/if}
              </span>
              <span class="flex shrink-0 items-center gap-0.5">
                {#if unreadPush}
                  <button
                    onclick={() => markRead(n.id)}
                    aria-label={t("nc.markRead")}
                    data-icon="check"
                    class="grid h-6 w-6 place-items-center rounded-full opacity-60 transition hover:opacity-100"
                  >{@html iconSvg("check", "h-3 w-3")}</button>
                {/if}
                <button
                  onclick={() => dismiss(n.id)}
                  aria-label={t("a11y.dismiss")}
                  data-icon="x"
                  class="grid h-6 w-6 place-items-center rounded-full opacity-60 transition hover:opacity-100"
                >{@html iconSvg("x", "h-3 w-3")}</button>
              </span>
            </div>
            {#if n.title}<div class="mt-1 text-sm font-medium">{n.title}</div>{/if}
            {#if n.body}<div class="text-xs opacity-70">{n.body}</div>{/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

