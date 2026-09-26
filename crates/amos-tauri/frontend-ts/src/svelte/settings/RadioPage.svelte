<script lang="ts">
  // RadioPage.svelte — Wi‑Fi / 蓝牙 sub page of the iOS-style Settings. Renders a
  // master switch row bound to the shared quick-settings radio bits (same store +
  // policy as the control center, see lib/settings.ts flipRadio / airplane gating).
  import { t } from "../locale.svelte";
  import type { QuickSettings, RadioKey } from "../../lib/settings";
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import { radioDisplayOn } from "../../lib/quickRadio";
  import {
    WIFI_KEY,
    NEIGHBORHOOD,
    autoRejoin,
    connectOpenOrSaved,
    connectWithPassword,
    forgetNetwork,
    hasPassword,
    isSaved,
    normalizeWifi,
    signalBars,
    sortNetworks,
    wifiLink,
    type WifiCfg,
  } from "../../lib/wifi";
  import {
    BT_KEY,
    DEMO_DEVICES,
    btGlyph,
    isPaired,
    mergeScanRows,
    normalizeBt,
    pairDevice,
    pairingProgress,
    peerToDevice,
    renameDevice,
    rowIsBonded,
    rowIsBonding,
    scanRow,
    setDiscoverable,
    unpairDevice,
    type BtCfg,
    type BtDevice,
    type BtPeer,
    type BtScanRow,
  } from "../../lib/bluetooth";
  import {
    bluetoothAdapterName,
    bluetoothPairedDevices,
    bluetoothPair,
    bluetoothRenameAdapter,
    bluetoothScanState,
    bluetoothStartScan,
    bluetoothStopScan,
    bridged,
    radioControl,
    radioOpenSettings,
    type RadioControlReply,
  } from "../../lib/backend";
  import { radioManagedState, type RadioRefusalView } from "../../lib/radioControl";
  import { GROUP, LABEL, SUB, HINT } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";
  import StoreErrorBar from "../StoreErrorBar.svelte";

  let {
    which,
    qs,
    onToggle,
    refusal,
    storeError = "",
  }: {
    which: "wifi" | "bluetooth";
    qs: QuickSettings;
    onToggle: (k: RadioKey) => void;
    /** The last refused write (REQ-A203), or `null` when nothing was refused. */
    refusal?: RadioRefusalView | null;
    /**
     * The **store's** refusal for this page's switch, if any (REQ-A1381). It is not
     * `radioErr` (that one is this page's own config write) and not `refusal` (the device's
     * answer) — the switch is the tap's success report, so the write's verdict is said here.
     */
    storeError?: string;
  } = $props();

  const title = $derived(which === "wifi" ? t("settings.wifi") : t("settings.bluetooth"));
  // "Is this radio on?" — the shared predicate, not the stored bit. Airplane mode owns the
  // other radios, so a gated one is off; the page's own sentence (`settings.airplaneBlocks`,
  // below) says exactly that, and the switch above it must not say the opposite (REQ-A1082).
  // The page had answered this two ways at once: its effects and its section guards each
  // spelled the gate out by hand, while the switch drew the raw bit.
  const on = $derived(radioDisplayOn(qs, which));

  // ---- Platform-managed switch (REQ-A202) ----
  // On modern Android the platform owns the Wi-Fi (API 29+) and Bluetooth (API 33+)
  // switches: `radio_set` refuses, and before this the master switch would simply appear
  // to do nothing. The page now asks who owns the switch and, when it is not this app,
  // says so and offers the system settings screen instead of a switch that cannot move.
  let ctl = $state<RadioControlReply | null>(null);
  let ctlOpenFailed = $state(false);
  const ctlState = $derived(radioManagedState(ctl, which));
  $effect(() => {
    if (!bridged()) return;
    // Ask about **the radio on screen**, and re-ask when it changes. The platform's
    // answer is per radio (`radioControl(key)`), while one instance serves both: the
    // page is not remounted when the user moves between Wi‑Fi and Bluetooth, because
    // `SettingsApp` renders both from a single `page === "wifi" || page === "bluetooth"`
    // branch. Latching the read to the instance therefore described the Bluetooth
    // switch with the Wi‑Fi radio's answer (REQ-A1211). The previous answer — and the
    // open-failure verdict of a tap made on the other page — is dropped first, so
    // neither haunts the radio now on screen.
    const key = which;
    ctl = null;
    ctlOpenFailed = false;
    void (async () => {
      const reply = (await radioControl(key)) ?? null;
      // The reply belongs to `key`; the screen may have moved on to another radio while it
      // was in flight. Writing it back here would re-create exactly the defect this effect
      // was changed to fix — a Bluetooth page wearing the Wi‑Fi answer (its `noteKey` is
      // re-worded for the *current* `which`, and `surface` is the other radio's panel) —
      // so it is dropped unless the answer's own radio is still the one on screen. Same
      // rule as `MessagesApp`'s `smsFolderSnapshot` guard (REQ-A1216 / F-SH-502).
      if (key !== which) return;
      ctl = reply;
    })();
  });
  const openRadioSettings = async () => {
    // `which` is the page's own radio key, and `hotspot` never reaches this page.
    const key = which;
    const opened = await radioOpenSettings(key);
    // The verdict belongs to the page the tap was made on: starting a system Activity is
    // a platform round trip, and the user can move to the other radio while it is in
    // flight. Writing it back here would put a Wi-Fi tap's failure under the Bluetooth
    // switch — the same landing `radioControl`'s reply is already guarded against, two
    // lines up (REQ-A1218).
    if (key !== which) return;
    ctlOpenFailed = !opened;
  };

  // Wi‑Fi neighbourhood view (iOS-style). Honest: there is no real radio yet, so
  // this is a deterministic demo list; a device scan bridge would feed the same
  // shape. Only open / already-current networks can be "joined" (never a faked
  // passworded join).
  let cfg = $state<WifiCfg>(normalizeWifi(readStoreValue<unknown>(WIFI_KEY, undefined)));
  let scanNote = $state(false);
  // A rejected config write must be visible: the "已保存" label describes the store.
  let radioErr = $state("");
  const saveCfg = (next: WifiCfg): boolean => {
    // The "已保存" label is a claim about the store, so the in-memory config only
    // moves when the write landed. The verdict is also *returned*: a caller whose own
    // gesture says "done" (the password sheet closing) must not report a write the
    // store refused (REQ-A1241).
    if (!writeStoreValueChecked(WIFI_KEY, next)) {
      radioErr = t("settings.radioSaveFailed");
      return false;
    }
    radioErr = "";
    cfg = next;
    return true;
  };
  // There is no Wi-Fi scan to run. The list above is `sortNetworks(NEIGHBORHOOD, …)` — a
  // `$derived` over a static constant — and no scan command exists on the host (the
  // Bluetooth half of this same page has `bluetooth_scan_state`). This used to be a 700 ms
  // `…` busy state that scanned nothing and could change nothing: a tap claimed work had
  // happened, and the user could not tell "found nothing new" from "did nothing". The
  // button stays (it is the affordance the user looks for, as the Bluetooth half keeps its
  // own `搜索` under `btScanDenied`) and now answers the tap with what is missing
  // (REQ-A1195 / F-SH-484).
  const runScan = () => {
    scanNote = true;
  };
  const sorted = $derived.by(() =>
    sortNetworks(NEIGHBORHOOD, cfg.current, cfg.saved),
  );

  // The 「当前网络」 row asks *which network*, so its value is the link state — not the
  // radio's own bit. It used to answer 「开」 (the radio is on) under that label, which
  // is a different question; the same three-state rule the Settings index uses lives
  // in `lib/wifi.ts` so the two screens word the same fact the same way (REQ-A1123).
  const link = $derived(wifiLink(on, cfg.current));
  const linkText = $derived(
    link.kind === "joined"
      ? link.ssid
      : link.kind === "unjoined"
        ? t("settings.notConnected")
        : t("settings.off"),
  );

  // ---- remembered-password / auto-rejoin ----
  // Auto-reconnect the strongest remembered (open or passworded) network when the
  // page opens with Wi‑Fi on and nothing connected yet — iOS behaviour.
  $effect(() => {
    if (which === "wifi" && on) {
      const next = autoRejoin(cfg, NEIGHBORHOOD);
      if (next.current !== cfg.current) saveCfg(next);
    }
  });

  // Password entry for a secure network we haven't joined before.
  let pwFor = $state<string | null>(null);
  let pwVal = $state("");
  const joinNet = (net: { ssid: string; secure: boolean }) => {
    if (net.ssid === cfg.current) return;
    // A tap on a network is a new question, and the password sheet answers exactly one:
    // once it moves to another network, the sheet that was asking about the previous one
    // is no longer what the user is looking at. Left standing, it kept asking for the
    // network just walked away from — and 连接, the only control it has, moved the
    // connection back there on one press. The Bluetooth half of this page states the
    // same rule for its own pending question (`btPairTarget = ""` at the top of
    // `startBtScan`, before the attempt is even made); the Wi-Fi half had no reset.
    const asks = net.secure && !hasPassword(cfg, net.ssid) ? net.ssid : null;
    if (pwFor !== asks) {
      pwFor = asks;
      pwVal = "";
    }
    if (asks === null) saveCfg(connectOpenOrSaved(cfg, NEIGHBORHOOD, net.ssid));
  };
  const submitPassword = () => {
    // Nothing to try with an empty (or whitespace-only) field: `connectWithPassword`
    // returns the config unchanged, so closing the sheet here would read as "the join
    // happened" while nothing did (REQ-A1127). Keep the sheet open — the disabled 连接
    // below is the verdict, and Enter must honour the same gate the button does.
    const pw = pwVal.trim();
    if (pw === "" || !pwFor) return;
    // The same rule for the *other* way this can end without joining: a refused store
    // write. Closing the sheet is this screen's "the join worked" gesture, so it may
    // only happen when the write landed — otherwise the user's typed password is
    // discarded and the screen reports a join that never happened, while the banner
    // `saveCfg` raised is left explaining a sheet that is no longer up (REQ-A1241).
    if (!saveCfg(connectWithPassword(cfg, NEIGHBORHOOD, pwFor, pw))) return;
    pwFor = null;
    pwVal = "";
  };

  // ---- Bluetooth (REQ-A199): device facts vs the offline preference ----
  // `btCfg` (store `amos.bluetooth`) is the *offline preference*: the name this device
  // should use, discoverability, and the demo list's pairings. The adapter's own name
  // and its real paired devices arrive from the device and are held separately, so the
  // screen can say which of the two it is showing instead of passing a remembered value
  // off as device state.
  let btCfg = $state<BtCfg>(normalizeBt(readStoreValue<unknown>(BT_KEY, undefined)));
  const saveBt = (next: BtCfg) => {
    if (!writeStoreValueChecked(BT_KEY, next)) {
      radioErr = t("settings.radioSaveFailed");
      return;
    }
    radioErr = "";
    btCfg = next;
  };

  // Device answers: `null` means **nobody could ask** (desktop, or an Android build
  // whose glue never attached — `invoke` resolves `null` when unbridged or refused), not
  // "no devices". The two are different facts and the UI renders them differently.
  let btRealName = $state<string | null>(null);
  let btPeers = $state<BtPeer[] | null>(null);
  let btErr = $state("");
  const btShownName = $derived(btRealName ?? btCfg.name);

  const loadBtDevice = async () => {
    const [name, peers] = await Promise.all([
      bluetoothAdapterName(),
      bluetoothPairedDevices(),
    ]);
    btRealName = name;
    btPeers = peers;
  };
  // Ask the device when the Bluetooth page is actually on screen (and re-ask if the
  // radio or airplane mode changes, since the adapter may have moved).
  $effect(() => {
    if (which === "bluetooth" && on) {
      void loadBtDevice();
      // Read the scan state up front as well: "this app may not scan" (no
      // BLUETOOTH_SCAN) and "the last list was capped" must be visible before the user
      // presses Search — not only after a scan that cannot start anyway.
      void refreshScan();
    }
  });

  // Rename. With a device answer the adapter is the authority: the request goes to the
  // device and the store mirrors **what the adapter reports back**, so a truncated or
  // refused rename can never end up remembered as the name. Offline there is no device
  // to ask, so the preference is all this can edit.
  const renameBt = async (raw: string) => {
    if (btRealName === null) {
      saveBt(renameDevice(btCfg, raw));
      return;
    }
    btErr = "";
    const authoritative = await bluetoothRenameAdapter(raw);
    if (authoritative === null) {
      btErr = t("settings.btRenameFailed");
      return;
    }
    btRealName = authoritative;
    saveBt(renameDevice(btCfg, authoritative));
  };

  // Offline pairing: this edits the local demo model only — a device's real paired list
  // cannot be edited from a normal install (no public unpair API), which is why the
  // adapter-reported rows carry no unpair button.
  const togglePair = (dev: BtDevice) =>
    saveBt(isPaired(btCfg, dev.id) ? unpairDevice(btCfg, dev.id) : pairDevice(btCfg, dev));

  // ---- Bluetooth discovery (REQ-A200, LE + pairing progress REQ-A201) ----
  // The scan itself runs in the device glue (a BroadcastReceiver and an LE
  // ScanCallback cannot live in Rust); the screen starts it, polls it, and **stops it on
  // the way out** — a scan left running costs battery.
  let btRows = $state<BtScanRow[]>([]);
  /** Whether *this screen* has started a scan — distinct from "we read the state", so
   *  the empty-list wording ("no devices found") never appears before a search. */
  let btSearched = $state(false);
  let btScanning = $state(false);
  let btScanAllowed = $state(true);
  let btCapped = $state(false);
  /** Which transports the device actually searched: classic discovery and/or LE. */
  let btClassic = $state(false);
  let btLe = $state(false);
  /** Bond transitions the glue saw this session — how pairing progress is read. */
  let btBonds = $state<{ address: string; state: number }[]>([]);
  let btScanErr = $state("");
  let btPairing = $state("");
  /** The address the user asked to pair with; its progress comes from the device. */
  let btPairTarget = $state("");

  const refreshScan = async (opts: { trustDiscovering?: boolean } = {}) => {
    const s = await bluetoothScanState();
    if (!s) return null;
    // `trustDiscovering: false` is used for the read taken immediately after a start:
    // starting discovery is asynchronous, so the platform can still answer
    // `isDiscovering == false` for a moment — and believing that one reading stops the
    // poll, leaving the devices the scan *did* find unrendered (observed on the S5,
    // REQ-A200). The next tick trusts the platform again.
    if (opts.trustDiscovering !== false) btScanning = s.discovering;
    btScanAllowed = s.scan_allowed;
    btCapped = s.capped;
    btClassic = s.classic;
    btLe = s.le;
    btBonds = s.bonds;
    btRows = mergeScanRows(btRows, s.devices.map(scanRow));
    return s;
  };

  /**
   * Which transports the **current** search is using, or `""` when none is running.
   *
   * Derived from both flags rather than from `le` alone: "classic only" is a claim about
   * the classic radio, and if *neither* scan is running (the search was stopped, or it
   * ended) there is nothing to state — the rows stay, the wording goes away (REQ-A201).
   */
  const btTransportNote = $derived.by(() => {
    if (btClassic && btLe) return t("settings.btScanBothTransports");
    if (btLe) return t("settings.btScanLeOnly");
    if (btClassic) return t("settings.btScanClassicOnly");
    return "";
  });

  const startBtScan = async () => {
    btScanErr = "";
    // A new search is a new question: whatever the previous request did is no longer
    // what the user is watching.
    btPairTarget = "";
    const accepted = await bluetoothStartScan();
    if (!accepted) {
      // The platform refused (no adapter, or BLUETOOTH_SCAN not granted). Say so — an
      // empty list here would read as "nothing is nearby".
      btScanErr = t("settings.btScanRefused");
      await refreshScan();
      return;
    }
    btSearched = true;
    // The platform accepted the scan, so the screen is searching from here on; the
    // polling effect below starts on this state and the next read corrects it.
    btScanning = true;
    await refreshScan({ trustDiscovering: false });
  };

  const stopBtScan = async () => {
    await bluetoothStopScan();
    await refreshScan();
  };

  const pairScanned = async (address: string) => {
    btScanErr = "";
    btPairing = address;
    const accepted = await bluetoothPair(address);
    btPairing = "";
    if (!accepted) {
      btScanErr = t("settings.btPairRefused");
      return;
    }
    // Accepted = the system's pairing flow has started. Watch that **address** and let
    // the device say what happened: the progress text below is derived from the bond
    // state the glue reports, never from "we sent a request".
    btPairTarget = address;
    await Promise.all([refreshScan(), loadBtDevice()]);
  };

  /**
   * What the device says about the request we watched. Derived (not stored) so the text
   * always matches the latest poll: `bonding` → the peer must confirm, `bonded` → done,
   * `none` → no transition seen yet (or the flow fell back).
   */
  const btPairProgress = $derived(
    btPairTarget === "" ? "none" : pairingProgress(btBonds, btPairTarget, btRows),
  );
  const btPairTargetName = $derived(btRows.find((r) => r.id === btPairTarget)?.name ?? btPairTarget);
  const btPairNote = $derived.by(() => {
    if (btPairTarget === "") return "";
    if (btPairProgress === "bonding") return t("settings.btPairBonding");
    if (btPairProgress === "bonded") return t("settings.btPairBonded");
    return t("settings.btPairPending");
  });

  // Poll while a scan is running **or** while a pairing request is being watched (a
  // request made after the scan ended still has progress to report). The effect's
  // cleanup also runs on unmount, so no interval outlives the page.
  $effect(() => {
    const watching = btPairTarget !== "" && btPairProgress !== "bonded";
    if (!btScanning && !watching) return;
    const id = window.setInterval(() => void refreshScan(), 1500);
    return () => window.clearInterval(id);
  });

  // A pairing that completed while the screen is open must appear in the **paired list**
  // too (that list is the authority), so refresh it the moment the device reports a new
  // bonded address.
  let btSeenBonded = new Set<string>();
  $effect(() => {
    const bonded = new Set(
      btBonds.filter((b) => b.state === 12).map((b) => b.address),
    );
    const fresh = [...bonded].some((a) => !btSeenBonded.has(a));
    btSeenBonded = bonded;
    if (fresh) void loadBtDevice();
  });

  // Leaving the Bluetooth page (or turning the radio/airplane state over) cancels a
  // running scan: the platform would end it silently after ~12 s anyway, and until then
  // it keeps the radio busy.
  $effect(() => {
    if (!(which === "bluetooth" && on)) return;
    return () => {
      void bluetoothStopScan();
    };
  });
</script>

<div class="space-y-5">
  {#if radioErr}
    <p
      role="status"
      data-testid="radio-store-error"
      class="rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-danger dark:bg-white/10"
    >
      {radioErr}
    </p>
  {/if}
  <section class={GROUP}>
    <!-- A switch the platform owns: the control still shows the device's real state,
         but tapping it hands the user to the system surface instead of pretending to
         flip something no app may flip (REQ-A202). -->
    <ToggleRow
      label={title}
      on={on}
      disabled={qs.airplane || ctlState.managed}
      ontoggle={() => (ctlState.managed ? void openRadioSettings() : onToggle(which))}
    />
    {#if storeError}
      <div class={SUB}></div>
      <div class="px-4 pb-2"><StoreErrorBar message={storeError} /></div>
    {/if}
    {#if ctlState.managed}
      <div class={SUB}></div>
      <div class="flex items-center justify-between gap-3 px-4 py-2">
        <p data-testid="radio-managed-note" class={HINT}>{t(ctlState.noteKey)}</p>
        <button
          onclick={() => void openRadioSettings()}
          data-testid="radio-open-settings"
          class="shrink-0 rounded-full px-2 py-0.5 text-xs text-accent"
        >{t("radio.openSettings")}</button>
      </div>
      {#if ctlOpenFailed}
        <div class="px-4 py-2">
          <p role="status" data-testid="radio-open-failed" class={HINT}>{t("radio.openSettingsFailed")}</p>
        </div>
      {/if}
    {/if}
    {#if refusal}
      <div class={SUB}></div>
      <div class="px-4 py-2">
        <!-- A refused write (REQ-A203): the device said no *this time* — the sentence
             sits next to the switch that did not move, with the system surface when the
             refusal names one (an unknown kind still says that *something* was refused;
             it never invents a reason). -->
        <p role="status" data-testid="radio-refused" class={HINT}>
          {refusal.noteKey === "" ? t("radio.refused.unknown") : t(refusal.noteKey)}
        </p>
        {#if refusal.surface}
          <button
            onclick={() => void openRadioSettings()}
            data-testid="radio-refused-open-settings"
            class="mt-1 text-xs text-accent"
          >{t("radio.openSettings")}</button>
          <!-- The same verdict `ctlOpenFailed` carries, rendered where *this* button can
               raise it. It used to be drawn only inside `{#if ctlState.managed}` — and a
               refusal is only ever raised when the radio is NOT managed (a platform-owned
               switch never reaches `radio_set`), so on this path the tap's failure was
               recorded and then shown nowhere. The desktop Control Center reports the
               identical verdict outside any managed block (REQ-A1196 / F-SH-485). -->
          {#if ctlOpenFailed}
            <p role="status" data-testid="radio-refused-open-failed" class={HINT}>
              {t("radio.openSettingsFailed")}
            </p>
          {/if}
        {/if}
      </div>
    {/if}
    {#if qs.airplane}
      <div class={SUB}></div>
      <div class="px-4 py-3">
        <p class={HINT}>{t("settings.airplaneBlocks")}</p>
      </div>
    {:else}
      {#if which === "wifi"}
        <div class={SUB}></div>
        <div class="flex items-center justify-between gap-3 px-4 py-3">
          <span class={LABEL}>{t("settings.currentNetwork")}</span>
          <span data-testid="wifi-current-network" class="truncate text-[15px] opacity-60">{linkText}</span>
        </div>
      {/if}
    {/if}
  </section>

  {#if which === "wifi" && on}
    <section class={GROUP}>
      <div class="flex items-center justify-between gap-2 px-4 py-2">
        <span class="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{t("settings.wifiNearby")}</span>
        <button
          onclick={runScan}
          aria-label={t("settings.wifiScan")}
          class="rounded-full px-2 py-0.5 text-xs text-accent"
        >{t("settings.wifiScan")}</button>
      </div>
      <div class={SUB}></div>
      {#if scanNote}
        <!-- The tap's answer, in the same shape the Bluetooth half gives a refused
             scan: a sentence naming what is absent, never a busy state (REQ-A1195). -->
        <div class="px-4 py-2">
          <p role="status" data-testid="wifi-scan-note" class={HINT}>
            {t("settings.wifiScanDenied")}
          </p>
        </div>
        <div class={SUB}></div>
      {/if}
      {#if cfg.current}
        <div class="flex items-center justify-between gap-3 px-4 py-3">
          <span class="flex items-center gap-2">
            <span class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{cfg.current}</span>
            <span class="shrink-0 text-xs opacity-50">{t("settings.wifiConnected")}</span>
          </span>
          <span aria-hidden="true" class="shrink-0 text-accent">✓</span>
        </div>
        <div class={SUB}></div>
        <button
          onclick={() => cfg.current && saveCfg(forgetNetwork(cfg, cfg.current))}
          aria-label={t("settings.wifiForget")}
          class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[15px] text-danger"
        >{t("settings.wifiForget")}</button>
      {/if}
      {#each sorted as net (net.ssid)}
        {#if net.ssid !== cfg.current}
          <div class={SUB}></div>
          <button
            onclick={() => joinNet(net)}
            aria-label={net.ssid}
            class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left disabled:opacity-40"
          >
            <span class="flex min-w-0 items-center gap-2">
              <span class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{net.ssid}</span>
              {#if net.secure}
                <span class="shrink-0 text-xs" aria-hidden="true">🔒</span>
              {/if}
              {#if net.secure && !hasPassword(cfg, net.ssid)}
                <span class="shrink-0 text-[11px] opacity-50">{t("settings.wifiNeedsPw")}</span>
              {/if}
              {#if isSaved(cfg, net.ssid)}
                <span class="shrink-0 text-[11px] opacity-50">{t("settings.wifiSaved")}</span>
              {/if}
            </span>
            <span class="flex shrink-0 items-end gap-0.5" aria-hidden="true">
              {#each [1, 2, 3] as i (i)}
                <span
                  class="w-0.5 rounded-sm {i <= signalBars(net.signal) ? 'bg-accent' : 'bg-black/20 dark:bg-white/20'}"
                  style:height={`${5 + i * 3}px`}
                ></span>
              {/each}
            </span>
          </button>
        {/if}
      {/each}
      {#if pwFor}
        <div class={SUB}></div>
        <div class="space-y-2 px-4 py-3">
          <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {t("settings.wifiPwFor", { net: pwFor })}
          </p>
          <input
            type="password"
            bind:value={pwVal}
            onkeydown={(e) => {
              if (e.key === "Enter") submitPassword();
            }}
            placeholder={t("settings.wifiPassword")}
            aria-label={t("settings.wifiPassword")}
            class="w-full rounded-lg bg-black/5 px-2.5 py-1.5 text-sm outline-none dark:bg-white/10"
          />
          <div class="flex gap-2">
            <button onclick={() => { pwFor = null; pwVal = ""; }} aria-label={t("settings.wifiCancel")} class="flex-1 rounded-lg bg-black/5 px-3 py-1.5 text-sm text-neutral-700 dark:bg-white/10 dark:text-neutral-200">{t("settings.wifiCancel")}</button>
            <button onclick={submitPassword} disabled={pwVal.trim() === ""} aria-label={t("settings.wifiConnect")} class="flex-1 rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40">{t("settings.wifiConnect")}</button>
          </div>
        </div>
      {/if}
      <div class={SUB}></div>
      <div class="px-4 py-2">
        <p class={HINT}>{t("settings.wifiSimNote")}</p>
      </div>
    </section>
  {/if}

  {#if which === "bluetooth" && on}
    <section class={GROUP}>
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span class={LABEL}>{t("settings.btDeviceName")}</span>
        <input
          value={btShownName}
          data-testid="bt-name"
          aria-label={t("settings.btRename")}
          placeholder={t("settings.btDeviceName")}
          onchange={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            // After the attempt the field shows the **authority** again: the adapter's
            // answer when one came back, otherwise the remembered preference. A refused
            // rename therefore cannot look applied in the input either.
            void renameBt(el.value).then(() => {
              el.value = btShownName;
            });
          }}
          class="min-w-0 flex-1 rounded-lg bg-black/5 px-2.5 py-1.5 text-right text-[15px] outline-none dark:bg-white/10"
        />
      </div>
      {#if btErr}
        <div class={SUB}></div>
        <div class="px-4 py-2">
          <p role="status" data-testid="bt-rename-error" class={HINT}>{btErr}</p>
        </div>
      {/if}
      <div class={SUB}></div>
      <ToggleRow
        label={t("settings.btDiscoverable")}
        on={btCfg.discoverable}
        ontoggle={() => saveBt(setDiscoverable(btCfg, !btCfg.discoverable))}
      />
      <div class={SUB}></div>
      <div class="px-4 py-2">
        <p class={HINT}>
          {btRealName === null ? t("settings.btSimNote") : t("settings.btDiscoverableNote")}
        </p>
      </div>
    </section>

    <section class={GROUP}>
      <div class="px-4 py-2">
        <span class="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{t("settings.btPaired")}</span>
      </div>
      <div class={SUB}></div>
      {#if btPeers !== null}
        {#if btPeers.length === 0}
          <div class="px-4 py-3">
            <p class={HINT}>{t("settings.btNoPaired")}</p>
          </div>
        {:else}
          {#each btPeers as peer (peer.address)}
            {@const dev = peerToDevice(peer)}
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <span class="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" class="text-base">{btGlyph(dev.kind)}</span>
                <span data-testid="bt-peer-name" class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{dev.name}</span>
              </span>
              <span class="shrink-0 text-xs opacity-50">{peer.address}</span>
            </div>
            {#if peer.address !== btPeers[btPeers.length - 1]?.address}
              <div class={SUB}></div>
            {/if}
          {/each}
          <div class={SUB}></div>
        {/if}
        <!-- Why these rows have no unpair button: the platform (not this build) has no
             public API for it. Saying so beats a button that would always fail. -->
        <div class="px-4 py-2">
          <p data-testid="bt-device-note" class={HINT}>{t("settings.btDeviceNote")}</p>
        </div>
      {:else}
        {#if btCfg.paired.length === 0}
          <div class="px-4 py-3">
            <p class={HINT}>{t("settings.btNoPaired")}</p>
          </div>
        {:else}
          {#each btCfg.paired as dev (dev.id)}
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <span class="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" class="text-base">{btGlyph(dev.kind)}</span>
                <span class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{dev.name}</span>
              </span>
              <button
                onclick={() => togglePair(dev)}
                aria-label={`${t("settings.btUnpair")} ${dev.name}`}
                class="shrink-0 text-xs text-danger"
              >{t("settings.btUnpair")}</button>
            </div>
            {#if dev.id !== btCfg.paired[btCfg.paired.length - 1]?.id}
              <div class={SUB}></div>
            {/if}
          {/each}
        {/if}
      {/if}
    </section>

    {#if btPeers === null}
      <section class={GROUP}>
        <div class="px-4 py-2">
          <span class="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{t("settings.btNearby")}</span>
        </div>
        <div class={SUB}></div>
        {#each DEMO_DEVICES as dev (dev.id)}
          <div class="flex items-center justify-between gap-3 px-4 py-3">
            <span class="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" class="text-base">{btGlyph(dev.kind)}</span>
              <span class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{dev.name}</span>
            </span>
            {#if isPaired(btCfg, dev.id)}
              <button
                onclick={() => togglePair(dev)}
                aria-label={`${t("settings.btUnpair")} ${dev.name}`}
                class="shrink-0 text-xs text-danger"
              >{t("settings.btUnpair")}</button>
            {:else}
              <button
                onclick={() => togglePair(dev)}
                aria-label={`${t("settings.btPair")} ${dev.name}`}
                class="shrink-0 text-xs text-accent"
              >{t("settings.btPair")}</button>
            {/if}
          </div>
          {#if dev.id !== DEMO_DEVICES[DEMO_DEVICES.length - 1]?.id}
            <div class={SUB}></div>
          {/if}
        {/each}
        <div class={SUB}></div>
        <div class="px-4 py-2">
          <p class={HINT}>{t("settings.btSimNote")}</p>
        </div>
      </section>
    {:else}
      <section class={GROUP}>
        <div class="flex items-center justify-between gap-2 px-4 py-2">
          <span class="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{t("settings.btNearby")}</span>
          {#if btScanning}
            <button
              onclick={stopBtScan}
              aria-label={t("settings.btScanStop")}
              class="rounded-full px-2 py-0.5 text-xs text-danger"
            >{t("settings.btScanStop")}</button>
          {:else}
            <button
              onclick={startBtScan}
              aria-label={t("settings.btScan")}
              class="rounded-full px-2 py-0.5 text-xs text-accent"
            >{t("settings.btScan")}</button>
          {/if}
        </div>
        <div class={SUB}></div>
        {#if btSearched && btTransportNote}
          <!-- Which transports the search really uses. "No devices" on a channel that was
               never scanned is a different answer, so the screen states it instead of
               implying both radios were used (REQ-A201). -->
          <div class="px-4 py-2">
            <p data-testid="bt-scan-transports" class={HINT}>{btTransportNote}</p>
          </div>
          <div class={SUB}></div>
        {/if}
        {#if btScanErr}
          <div class="px-4 py-2">
            <p role="status" data-testid="bt-scan-error" class={HINT}>{btScanErr}</p>
          </div>
          <div class={SUB}></div>
        {:else if btPairNote}
          <div class="px-4 py-2">
            <p role="status" data-testid="bt-pair-note" class={HINT}>
              {btPairTargetName} {btPairNote}
            </p>
          </div>
          <div class={SUB}></div>
        {/if}
        {#if btRows.length === 0}
          <div class="px-4 py-3">
            <!-- Three distinct states, never collapsed into one empty list: still
                 looking, looked and found nothing, or not looked yet. -->
            <p data-testid="bt-scan-empty" class={HINT}>
              {btScanning
                ? t("settings.btScanning")
                : btSearched
                  ? t("settings.btNoDevices")
                  : t("settings.btScanHint")}
            </p>
          </div>
        {:else}
          {#each btRows as row (row.id)}
            <div class="flex items-center justify-between gap-3 px-4 py-3">
              <span class="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" class="text-base">{btGlyph(row.kind)}</span>
                <span data-testid="bt-scan-name" class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{row.name}</span>
                {#if row.le}
                  <span data-testid="bt-le-tag" class="shrink-0 text-[11px] opacity-50">{t("settings.btLeTag")}</span>
                {/if}
                {#if rowIsBonded(row)}
                  <span class="shrink-0 text-[11px] opacity-50">{t("settings.btBondedTag")}</span>
                {:else if rowIsBonding(row)}
                  <span data-testid="bt-bonding-tag" class="shrink-0 text-[11px] opacity-50">{t("settings.btBondingTag")}</span>
                {/if}
              </span>
              <!-- No "pair" button while a pairing flow is running or the device is
                   already paired: the row offers the action the device state allows. -->
              {#if !rowIsBonded(row) && !rowIsBonding(row)}
                <button
                  onclick={() => pairScanned(row.id)}
                  disabled={btPairing === row.id}
                  aria-label={`${t("settings.btPair")} ${row.name}`}
                  class="shrink-0 text-xs text-accent disabled:opacity-40"
                >{t("settings.btPair")}</button>
              {/if}
            </div>
            {#if row.id !== btRows[btRows.length - 1]?.id}
              <div class={SUB}></div>
            {/if}
          {/each}
        {/if}
        {#if btCapped}
          <div class={SUB}></div>
          <div class="px-4 py-2">
            <p data-testid="bt-scan-capped" class={HINT}>{t("settings.btScanCapped")}</p>
          </div>
        {/if}
        {#if !btScanAllowed}
          <div class={SUB}></div>
          <div class="px-4 py-2">
            <p data-testid="bt-scan-denied" class={HINT}>{t("settings.btScanDenied")}</p>
          </div>
        {/if}
        <div class={SUB}></div>
        <div class="px-4 py-2">
          <p class={HINT}>{t("settings.btScanNote")}</p>
        </div>
      </section>
    {/if}
  {/if}

  <section class={GROUP}>
    <div class="px-4 py-3">
      <p class={HINT}>{on ? t("settings.radioOnDesc") : t("settings.radioOffDesc")}</p>
    </div>
  </section>
</div>
