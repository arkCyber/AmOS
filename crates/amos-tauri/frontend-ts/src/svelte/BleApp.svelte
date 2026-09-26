<script lang="ts">
  // BleApp.svelte — Svelte 5 dock app「蓝牙 (BLE)」(Bluetooth LE GATT).
  //
  // Consumer half of the BLE chain that already shipped: `lib/ble.ts` (the unified
  // `BleClient`), `BluetoothGattGlue.kt` (the real Android path), `BluetoothGlue.kt`,
  // and 7 registered `ble_*` commands — all of them unreachable from any screen until
  // this file existed (`scripts/unwired-allowlist.json` + `tauri-command-allowlist.json`
  // recorded that absence rather than hiding it).
  //
  // Honest boundaries, mirrored from the bridge:
  //  • three genuinely different runtimes are named as such: the **Tauri/Kotlin**
  //    bridge (full GATT on device), **Web Bluetooth** (host/Chromium — needs a user
  //    gesture for `requestDevice`, and its `connect` takes an address *prefix*), and
  //    **none** (nothing is offered, and nothing is faked);
  //  • service discovery is device-only (`discoverServices()` answers `null` for the Web
  //    path), so when nothing can be enumerated the screen asks for the UUIDs by hand
  //    instead of pretending the device has no services; a device that *was* asked and did
  //    not answer is a third outcome, shown with the bridge's own reason — and so is a
  //    service list the platform sent that could not be read;
  //  • discovery carries the device's **characteristics**, each with the property bits the
  //    platform reported, so the screen offers what the device has and gates the three
  //    controls on what it said it permits — a characteristic nobody described (typed by
  //    hand) keeps the permissive behaviour, because silence is not a denial;
  //  • a read/write/subscribe that fails shows the bridge's own error string; a value
  //    that arrives on the event channel is labelled by the event it came on
  //    (`read` vs `notification`) — never merged;
  //  • a runtime whose value channel was refused is named as such: the device-side subscribe can
  //    still be acknowledged, so the screen says the frames cannot arrive rather than promising a
  //    log it can never fill;
  //  • the value log is bounded (MAX_LOG) and is the only thing that grows.
  import { onMount, onDestroy } from "svelte";
  import { t } from "./locale.svelte";
  import { amosWarn } from "../lib/debugLog";
  import { localId } from "../lib/localId";
  import {
    BLE_AVAILABLE,
    bleCanNotify,
    bleCanRead,
    bleCanWrite,
    bleOnValueChanged,
    blePropertyNames,
    bleSetNotifications,
    bytesToHex,
    createBleClient,
    hexToBytes,
    isPlausibleBleUuid,
    tauriBleAvailable,
    type BleClient,
    type BleService,
  } from "../lib/ble";

  const CARD =
    "overflow-hidden rounded-[14px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const BTN = "rounded-full bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40";
  const SOFT =
    "rounded-full bg-neutral-200 px-2.5 py-1 text-xs opacity-70 disabled:opacity-40 dark:bg-neutral-700";
  const FIELD =
    "w-full rounded-lg bg-black/5 px-3 py-2 text-sm outline-none ring-1 ring-transparent focus:ring-accent dark:bg-white/10";
  const LABEL = "text-[10px] uppercase tracking-wider opacity-50";

  /** Hard bound on the value log — the only thing on this screen that grows. */
  const MAX_LOG = 40;
  /** Hard bound on an outgoing write payload (a paste must not reach the device unbounded). */
  const MAX_WRITE_BYTES = 512;

  type Adapter = "tauri" | "web" | "none";

  let adapter = $state<Adapter>("none");
  let address = $state("");
  let client: BleClient | null = null;
  let connected = $state(false);
  let connecting = $state(false);
  let services = $state<BleService[]>([]);
  let serviceUuid = $state("");
  let characteristicUuid = $state("");
  // The last reading, **with the characteristic it came from**. One unlabelled `valueHex` slot
  // was overwritten by any frame — a read of the selected characteristic, or a notification from
  // any other subscribed one — so with `2a38` selected the header could be showing `2a37`'s
  // bytes under inputs that name `2a38` (REQ-A1191 / F-SH-480).
  let lastValue = $state<{ uuid: string; hex: string } | null>(null);
  let writeHex = $state("");
  let withResponse = $state(false);
  // Which characteristics the host has *acknowledged* a subscribe on, keyed by
  // `service/characteristic`. One flat `notifying` flag described the whole screen while the
  // characteristic it described was freely editable, so a selection change carried the
  // previous characteristic's subscription over to the new one (REQ-A1178 / F-SH-471).
  let subscribedKeys = $state<string[]>([]);
  let busy = $state<"" | "discover" | "read" | "write" | "notify">("");
  let log = $state<{ id: string; kind: string; text: string }[]>([]);
  let notice = $state<{ key: string; ok: boolean; params?: Record<string, string | number> } | null>(
    null,
  );
  let disposed = false;
  let unsubscribeValues: (() => void) | null = null;
  // Whether this screen has **no value sink at all**. `bleOnValueChanged` answers `null` when the
  // host refuses the `ble-value-changed` listen; the device-side subscribe can still be
  // acknowledged, so without this the screen would answer 「已订阅：特征值变化会出现在下方记录里。」
  // while no frame could ever reach the log — a promise the runtime cannot keep (REQ-A1206 /
  // F-SH-493).
  let valueSinkLost = $state(false);

  const hasAdapter = $derived(adapter !== "none");
  const serviceOk = $derived(isPlausibleBleUuid(serviceUuid));
  const charOk = $derived(isPlausibleBleUuid(characteristicUuid));
  const gattReady = $derived(connected && serviceOk && charOk);
  /**
   * A UUID is hex, so `2A37` and `2a37` name the same characteristic — `isPlausibleBleUuid`
   * admits `[0-9a-fA-F]`, and a device manual writes them upper-case while the wire does not.
   * One normaliser for both users of that fact: the subscription ledger's key and the value
   * label's source comparison. A case-*sensitive* key beside a case-*insensitive* comparison
   * is how they came to disagree — subscribing `2a37` and then spelling it `2A37` read as
   * 「订阅」 for a characteristic the device was still notifying on (REQ-A1199 / F-SH-489).
   */
  const normUuid = (s: string): string => s.trim().toLowerCase();
  /** Identity of the currently selected characteristic, or `null` if not yet valid. */
  const selKey = $derived(
    serviceOk && charOk ? `${normUuid(serviceUuid)}/${normUuid(characteristicUuid)}` : null,
  );
  const notifying = $derived(selKey !== null && subscribedKeys.includes(selKey));
  const sameUuid = (a: string, b: string): boolean => normUuid(a) === normUuid(b);
  /**
   * The **device's own** entry for the selected characteristic, or `null`.
   *
   * `null` is the honest "we were not told": the UUIDs were typed by hand, or discovery ran in a
   * runtime that cannot enumerate, or the device's list has no such characteristic. Every gate
   * below reads `null` as *unknown* and stays permissive, so a hand-typed UUID keeps the
   * behaviour it had — the device, not this screen, is the authority on a characteristic it never
   * described (REQ-A1198 / F-SH-487).
   */
  const selectedChar = $derived.by(() => {
    if (!serviceOk || !charOk) return null;
    const svc = services.find((s) => sameUuid(s.uuid, serviceUuid));
    if (svc === undefined) return null;
    return svc.characteristics.find((c) => sameUuid(c.uuid, characteristicUuid)) ?? null;
  });
  /**
   * The property bitmask the device reported for the selected characteristic, or `null` when
   * discovery did not describe it.
   *
   * The three gates below all fold `null` into "offer the action": what the device *said* it
   * permits is the only thing this screen may act on, and silence is not a denial.
   */
  const caps = $derived(selectedChar?.properties ?? null);
  const canRead = $derived(caps === null || bleCanRead(caps));
  const canSubscribe = $derived(caps === null || bleCanNotify(caps));
  const canWrite = $derived(caps === null || bleCanWrite(caps, withResponse));
  /**
   * The selected characteristic's capabilities, in the user's language, for the line below.
   *
   * When the mask carries no property this table knows, the **raw bitmask** is shown instead of
   * an empty string: that line is the only thing on screen explaining why the three buttons went
   * dead, and `ble.canRead(0)`/`ble.canWrite(0, …)`/`ble.canNotify(0)` are all false. An empty
   * 「能力：」 beside three disabled controls would be the screen refusing to say what it saw.
   */
  const capsText = $derived(
    caps === null
      ? ""
      : blePropertyNames(caps)
          .map((p) => t(`ble.prop.${p}`))
          .join(" · ") || `0x${caps.toString(16)}`,
  );
  /** The reading on screen, when it is *not* the selected characteristic's. */
  const valueFromOther = $derived(
    lastValue !== null && charOk && !sameUuid(lastValue.uuid, characteristicUuid),
  );
  const writeBytes = $derived(hexToBytes(writeHex));

  function push(kind: string, text: string) {
    log = [{ id: localId("ble"), kind, text }, ...log].slice(0, MAX_LOG);
  }

  async function connect() {
    if (client === null) return;
    const addr = address.trim();
    if (addr === "") {
      notice = { key: "ble.addressRequired", ok: false };
      return;
    }
    connecting = true;
    notice = null;
    const ok = await client.connect(addr);
    connecting = false;
    if (disposed) return;
    // `null` = the host did not answer (REQ-A1337 / F-SH-603). It is its own fact: `false`
    // means this runtime observed that no request could be made, and `ble.connectFailed` words
    // that as 「连接请求没有发出」 — the local side. A command the host refused establishes no
    // fact at all, so neither sentence may be used.
    if (ok === null) {
      notice = { key: "ble.connectUnanswered", ok: false };
      amosWarn("ble", "connect unanswered", { adapter });
      return;
    }
    connected = ok;
    if (!ok) {
      // Honest: a refused/failed connect is not "connected to nothing".
      notice = { key: "ble.connectFailed", ok: false };
      amosWarn("ble", "connect refused", { adapter });
      return;
    }
    push("connect", t("ble.logConnected", { address: addr }));
    notice = { key: "ble.connectOk", ok: true };
  }

  async function disconnect() {
    if (client === null) return;
    const ok = await client.disconnect();
    if (disposed) return;
    // `null` = the host did not answer (REQ-A1337): 「系统没有确认」 asserts the system spoke,
    // which is exactly what did not happen.
    if (ok === null) {
      notice = { key: "ble.disconnectUnanswered", ok: false };
      amosWarn("ble", "disconnect unanswered", { adapter });
      return;
    }
    // Only the host's confirmation tears the surface down. `ble.disconnectFailed` says
    // literally 「系统没有确认」 — a *refused* disconnect used to set `connected = false`,
    // clear the discovered services and write 「已断开连接」 into the log anyway, so the badge
    // and the log claimed a transition the one honest line on screen denied, while the GATT
    // client was still live and its notifications kept arriving. Same rule the sibling
    // `toggleSubscribe` applies to a refused unsubscribe.
    if (!ok) {
      notice = { key: "ble.disconnectFailed", ok: false };
      amosWarn("ble", "disconnect refused", { adapter });
      return;
    }
    connected = false;
    services = [];
    // The GATT client is gone: every acknowledged subscription went with it.
    subscribedKeys = [];
    lastValue = null;
    push("disconnect", t("ble.logDisconnected"));
    notice = { key: "ble.disconnectOk", ok: true };
  }

  async function discover() {
    if (client === null) return;
    busy = "discover";
    const found = await client.discoverServices();
    busy = "";
    if (disposed) return;
    if (found === null) {
      // This runtime cannot enumerate (Web Bluetooth path / no bridge): nothing was asked,
      // so nothing is claimed about the device.
      services = [];
      notice = { key: "ble.discoveryUnavailable", ok: false };
      return;
    }
    if (!found.ok) {
      // The device was asked and did not answer with a list. Not the same as an empty
      // list ("it advertises no services") — say which one it was.
      services = [];
      notice = { key: "ble.discoverFailed", ok: false, params: { error: found.error } };
      return;
    }
    // A successful discovery: an **empty** list here is a real answer.
    services = found.services;
    notice = { key: "ble.discovered", ok: true };
    push("services", t("ble.logServices", { n: found.services.length }));
  }

  async function read() {
    if (client === null || !gattReady) return;
    busy = "read";
    // The characteristic this read is addressed to, captured before the await — the same rule
    // `toggleSubscribe` follows a few functions down: the user may re-point the inputs while the
    // host is answering (both UUID fields stay editable during a read), and the bytes belong to
    // *this* characteristic, not to whatever is selected when the reply lands (REQ-A1207 / F-SH-494).
    const svc = serviceUuid;
    const chr = characteristicUuid;
    const out = await client.read(svc, chr);
    busy = "";
    if (disposed) return;
    // `null` = the host did not answer (REQ-A1337). 「读取失败：{error}」 would have been fed a
    // cause this side invented (`"not bridged"`) for a read that was never carried out.
    if (out === null) {
      lastValue = null;
      notice = { key: "ble.readUnanswered", ok: false };
      return;
    }
    if (out.ok) {
      lastValue = { uuid: chr.trim(), hex: bytesToHex(out.bytes) };
      notice = { key: "ble.readOk", ok: true };
    } else {
      lastValue = null;
      notice = { key: "ble.readFailed", ok: false, params: { error: out.error } };
    }
  }

  async function write() {
    if (client === null || !gattReady) return;
    const bytes = writeBytes;
    if (bytes === null) {
      // Local validation, stated as such — nothing was sent to the device.
      notice = { key: "ble.invalidHex", ok: false };
      return;
    }
    if (bytes.length > MAX_WRITE_BYTES) {
      notice = { key: "ble.writeTooLong", ok: false, params: { max: MAX_WRITE_BYTES } };
      return;
    }
    busy = "write";
    const out = await client.write(serviceUuid, characteristicUuid, bytes, withResponse);
    busy = "";
    if (disposed) return;
    // `null` = the host did not answer (REQ-A1337) — and nothing may be logged as written.
    if (out === null) {
      notice = { key: "ble.writeUnanswered", ok: false };
      return;
    }
    notice = out.ok
      ? { key: "ble.writeOk", ok: true, params: { n: bytes.length } }
      : { key: "ble.writeFailed", ok: false, params: { error: out.error } };
    if (out.ok) push("write", bytesToHex(bytes));
  }

  async function toggleSubscribe() {
    if (client === null || !gattReady) return;
    busy = "notify";
    const want = !notifying;
    // The characteristic this request is about, captured before the await: the user may
    // re-point the inputs while the host is deciding, and the acknowledgement belongs to
    // *this* key, not to whatever is selected when the reply lands (REQ-A1178 / F-SH-471).
    const key = selKey;
    const ok = await bleSetNotifications(client, serviceUuid, characteristicUuid, want);
    busy = "";
    if (disposed) return;
    // `null` = the host did not answer (REQ-A1337 / F-SH-603). It must not share a branch with
    // `false`: 「订阅没有成功：设备拒绝……」 and 「取消订阅没有成功：设备可能仍在推送」 both name the
    // **device**, and the second asserts it is still notifying — neither is something a command
    // the host declined can establish.
    if (ok === null) {
      notice = {
        key: want ? "ble.subscribeUnanswered" : "ble.unsubscribeUnanswered",
        ok: false,
      };
      return;
    }
    // Only the host's acknowledgement moves the toggle (REQ-A1161 / F-SH-460).
    // `notifying = ok && want` folded a *refused* unsubscribe into `false`: the device kept
    // notifying (its values kept arriving in the log) while the button read 「订阅」 and
    // `aria-pressed` said off — the screen contradicting a stream it was displaying.
    if (ok && key !== null) {
      subscribedKeys = want
        ? subscribedKeys.includes(key)
          ? subscribedKeys
          : [...subscribedKeys, key]
        : subscribedKeys.filter((k) => k !== key);
    }
    notice = {
      key: ok
        ? want
          ? // The device acknowledged the descriptor write — but with no value channel on this
            // runtime its frames can never reach the log, so the promise is replaced by what
            // actually holds (REQ-A1206 / F-SH-493).
            valueSinkLost
            ? "ble.subscribedNoSink"
            : "ble.subscribed"
          : "ble.unsubscribed"
        : want
          ? "ble.subscribeFailed"
          : "ble.unsubscribeFailed",
      ok,
    };
  }

  onMount(async () => {
    adapter = tauriBleAvailable() ? "tauri" : BLE_AVAILABLE ? "web" : "none";
    client = createBleClient();
    // Values arrive on one channel for both reads and notifications; the `event`
    // discriminator is what tells them apart (see `bleOnValueChanged`).
    unsubscribeValues = await bleOnValueChanged(({ event, characteristicUuid: uuid, value }) => {
      if (disposed) return;
      lastValue = { uuid, hex: bytesToHex(value) };
      push(event, `${uuid} → ${bytesToHex(value) || t("ble.emptyValue")}`);
    });
    if (disposed) {
      unsubscribeValues?.();
      return;
    }
    // A `null` here is a **verdict**, not an empty value: the host refused to hand this screen
    // the value channel. Remember it — every promise about the log below is conditional on it
    // (REQ-A1206 / F-SH-493).
    valueSinkLost = unsubscribeValues === null;
  });

  onDestroy(() => {
    disposed = true;
    unsubscribeValues?.();
    unsubscribeValues = null;
    // Release the GATT client: a background connection would keep the radio bound
    // for a screen nobody is looking at.
    if (connected) void client?.disconnect();
  });
</script>

{#if !hasAdapter}
  <div class="p-6 text-center text-sm opacity-70" data-testid="ble-unavailable">
    <div>{t("ble.unavailable")}</div>
    <div class="mt-1 text-[11px] opacity-60">{t("ble.unavailableHint")}</div>
  </div>
{:else}
  <div class="space-y-3 p-4">
    <!-- Adapter + connection -->
    <div class={CARD} data-testid="ble-status">
      <div class="flex items-center justify-between gap-3 p-3">
        <div>
          <div class={LABEL}>{t("ble.adapter")}</div>
          <div class="text-sm font-medium" data-testid="ble-adapter">
            {t(adapter === "tauri" ? "ble.adapterTauri" : "ble.adapterWeb")}
          </div>
        </div>
        <span
          class="rounded-full px-2 py-0.5 text-[11px] {connected
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
            : 'bg-black/5 opacity-60 dark:bg-white/10'}"
          data-testid="ble-connection"
        >
          {t(connected ? "ble.connected" : "ble.disconnected")}
        </span>
      </div>
      <div class="space-y-2 px-3 pb-3">
        <input
          class={FIELD}
          bind:value={address}
          placeholder={t(adapter === "web" ? "ble.addressPlaceholderWeb" : "ble.addressPlaceholder")}
          aria-label={t(adapter === "web" ? "ble.addressPlaceholderWeb" : "ble.addressPlaceholder")}
          data-testid="ble-address"
        />
        <div class="flex items-center justify-between">
          <span class="text-[11px] opacity-60">{t("ble.addressHint")}</span>
          {#if connected}
            <button class={SOFT} onclick={disconnect} data-testid="ble-disconnect">
              {t("ble.disconnect")}
            </button>
          {:else}
            <button
              class={BTN}
              disabled={connecting}
              onclick={connect}
              data-testid="ble-connect"
            >
              {t(connecting ? "ble.connecting" : "ble.connect")}
            </button>
          {/if}
        </div>
      </div>
    </div>

    {#if notice}
      <div
        class="rounded-lg px-3 py-2 text-xs {notice.ok
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}"
        data-testid="ble-notice"
      >
        {t(notice.key, notice.params)}
      </div>
    {/if}

    <!-- Services + characteristic -->
    <div class={CARD} data-testid="ble-gatt">
      <div class="flex items-center justify-between px-3 pt-3">
        <div class={LABEL}>{t("ble.services", { n: services.length })}</div>
        <button
          class={SOFT}
          disabled={!connected || busy !== ""}
          onclick={discover}
          data-testid="ble-discover"
        >
          {t("ble.discover")}
        </button>
      </div>
      {#if services.length > 0}
        <ul class="mt-2 divide-y divide-black/5 dark:divide-white/10">
          {#each services as svc (svc.uuid)}
            <li>
              <button
                class="w-full truncate px-3 py-2 text-left font-mono text-xs hover:bg-black/5 dark:hover:bg-white/5"
                onclick={() => (serviceUuid = svc.uuid)}
                data-testid="ble-service-{svc.uuid}"
                aria-current={sameUuid(svc.uuid, serviceUuid)}
              >
                {svc.uuid}
                <span class="ml-2 font-sans opacity-60">
                  {t("ble.characteristics", { n: svc.characteristics.length })}
                </span>
              </button>
              <!-- The characteristics the platform reported for the *selected* service, so the
                   screen can offer what the device actually has instead of asking the user to
                   copy a UUID out of a manual (REQ-A1198 / F-SH-487). -->
              {#if sameUuid(svc.uuid, serviceUuid)}
                <ul class="pb-1">
                  {#each svc.characteristics as chr (chr.uuid)}
                    <li>
                      <button
                        class="flex w-full flex-wrap items-baseline gap-x-2 px-6 py-1.5 text-left font-mono text-[11px] hover:bg-black/5 dark:hover:bg-white/5"
                        onclick={() => {
                          serviceUuid = svc.uuid;
                          characteristicUuid = chr.uuid;
                        }}
                        data-testid="ble-characteristic-{chr.uuid}"
                        aria-current={sameUuid(chr.uuid, characteristicUuid)}
                      >
                        <span class="truncate">{chr.uuid}</span>
                        <span class="font-sans opacity-60">
                          {blePropertyNames(chr.properties)
                            .map((p) => t(`ble.prop.${p}`))
                            .join(" · ")}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <div class="px-3 pt-2 text-[11px] opacity-60" data-testid="ble-no-services">
          {t(connected ? "ble.discoveryHint" : "ble.connectFirst")}
        </div>
      {/if}
      <div class="space-y-2 p-3">
        <input
          class={FIELD}
          bind:value={serviceUuid}
          placeholder={t("ble.serviceUuid")}
          aria-label={t("ble.serviceUuid")}
          data-testid="ble-service-uuid"
        />
        <input
          class={FIELD}
          bind:value={characteristicUuid}
          placeholder={t("ble.characteristicUuid")}
          aria-label={t("ble.characteristicUuid")}
          data-testid="ble-char-uuid"
        />
        <div class="text-[11px] opacity-60">{t("ble.uuidHint")}</div>
      </div>
    </div>

    <!-- Values: read / notify / write -->
    <div class={CARD} data-testid="ble-values">
      <div class="flex items-center justify-between px-3 pt-3">
        <div class={LABEL}>{t("ble.value")}</div>
        <div class="flex flex-col items-end gap-0.5">
          <span class="font-mono text-[11px] opacity-70" data-testid="ble-value">
            {#if lastValue === null}
              {t("ble.noValue")}
            {:else}
              {lastValue.uuid} → {lastValue.hex === "" ? t("ble.emptyValue") : lastValue.hex}
            {/if}
          </span>
          {#if valueFromOther}
            <span class="text-[11px] opacity-60" data-testid="ble-value-other">
              {t("ble.valueOther")}
            </span>
          {/if}
        </div>
      </div>
      <!-- This runtime has no value channel: the reads below still fill the line above, but the
           device's notifications have nowhere to arrive. Said here, once, rather than left for the
           user to infer from a log that stays empty (REQ-A1206 / F-SH-493). -->
      {#if valueSinkLost}
        <div class="px-3 pb-1 text-[11px] text-amber-700 dark:text-amber-300" data-testid="ble-sink-lost">
          {t("ble.sinkLost")}
        </div>
      {/if}
      <!-- What the device said this characteristic permits. It is also the only thing on screen
           explaining a disabled button: the three controls below are gated on these same bits
           (REQ-A1198 / F-SH-487). -->
      {#if capsText !== ""}
        <div class="px-3 pb-1 text-[11px] opacity-60" data-testid="ble-caps">
          {t("ble.capabilities", { caps: capsText })}
        </div>
      {/if}
      <div class="flex flex-wrap items-center gap-2 p-3">
        <button
          class={SOFT}
          disabled={!gattReady || busy !== "" || !canRead}
          onclick={read}
          data-testid="ble-read"
        >
          {t("ble.read")}
        </button>
        <!-- The capability gate is dropped once the host has *acknowledged* a subscription: a
             later discovery that no longer reports the characteristic as notifiable must not
             strand a live stream behind a disabled button. Stopping is always allowed; starting
             is what the device's own bits gate. -->
        <button
          class={SOFT}
          disabled={!gattReady || busy !== "" || (!notifying && !canSubscribe)}
          onclick={toggleSubscribe}
          data-testid="ble-subscribe"
          aria-pressed={notifying}
        >
          {t(notifying ? "ble.unsubscribe" : "ble.subscribe")}
        </button>
      </div>
      <div class="space-y-2 px-3 pb-3">
        <input
          class={FIELD}
          bind:value={writeHex}
          placeholder={t("ble.writePlaceholder")}
          aria-label={t("ble.writePlaceholder")}
          data-testid="ble-write-hex"
        />
        <div class="flex items-center justify-between">
          <label class="flex items-center gap-2 text-[11px] opacity-70">
            <input
              type="checkbox"
              bind:checked={withResponse}
              data-testid="ble-write-response"
            />
            {t("ble.writeWithResponse")}
          </label>
          <button
            class={BTN}
            disabled={!gattReady || busy !== "" || writeHex.trim() === "" || !canWrite}
            onclick={write}
            data-testid="ble-write"
          >
            {t("ble.write")}
          </button>
        </div>
        <div class="text-[11px] opacity-60">{t("ble.writeHint")}</div>
      </div>
    </div>

    <!-- Value log (bounded) -->
    <div class={CARD} data-testid="ble-log">
      <div class="flex items-center justify-between px-3 pt-3">
        <div class={LABEL}>{t("ble.log", { n: log.length })}</div>
        <button
          class={SOFT}
          disabled={log.length === 0}
          onclick={() => (log = [])}
          data-testid="ble-clear-log"
        >
          {t("ble.clearLog")}
        </button>
      </div>
      {#if log.length === 0}
        <div class="p-3 text-xs opacity-60" data-testid="ble-log-empty">{t("ble.logEmpty")}</div>
      {:else}
        <ul class="divide-y divide-black/5 dark:divide-white/10">
          {#each log as row (row.id)}
            <li class="flex items-baseline gap-2 px-3 py-1.5 text-[11px]">
              <span class="shrink-0 opacity-50">{row.kind}</span>
              <span class="truncate font-mono" data-testid="ble-log-row">{row.text}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}
