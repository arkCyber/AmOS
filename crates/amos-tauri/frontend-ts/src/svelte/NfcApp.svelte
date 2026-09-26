<script lang="ts">
  // NfcApp.svelte — Svelte 5 dock app「NFC 标签读写」(NFC).
  //
  // This screen is the consumer half of a feature whose other half already
  // shipped: `lib/nfc.ts` (NDEF encode/decode + the `nfc_*` commands),
  // `NfcGlue.kt` (NfcAdapter/TagTechnology), and 13 registered Rust commands.
  // Until this screen existed the whole chain was unreachable from any UI
  // (recorded in `scripts/unwired-allowlist.json` with a reason, and every
  // `nfc_*` command sat in `scripts/tauri-command-allowlist.json`).
  //
  // Honesty rules baked in (mirroring the Rust seam and `lib/nfc.ts`):
  //  • the bridge answering `null` is a *host* state ("not connected"), not
  //    "no hardware" — the two are never merged into one message;
  //  • `state` is shown as the platform reported it (enabled / disabled /
  //    no-hardware) and **every** action is gated on `enabled`, so a disabled
  //    adapter can never be presented as a working reader;
  //  • `unavailable` is the host's own "we could not ask" and is **never** worded as
  //    a hardware fact — only the platform's `no-hardware` may say that (REQ-A775 /
  //    F-AND-007: the two used to be one state, so a missing `android.permission.NFC`
  //    told the user their phone had no NFC radio);
  //  • a write/format/read that fails says so with the glue's own error string
  //    (never "done"); a successful write reports the byte count the host
  //    actually returned;
  //  • a read is four different answers, not one `null` (REQ-A781 / F-AND-009):
  //    "nothing is in the field", "this tag carries no NDEF payload" (a *successful*
  //    read), "the read threw" and "this host could not ask" each get their own
  //    sentence, and only the last is about this app rather than the tag;
  //  • a read is shown under the tag it came from — the glue reads whatever tag it
  //    last saw, so bytes that belong to another tag never appear inside the
  //    selected tag's card;
  //  • the tag list only ever contains tags the host pushed on the event
  //    channel — nothing is seeded, and it is bounded (MAX_TAGS) because the
  //    screen can stay mounted for days.
  import { onMount, onDestroy } from "svelte";
  import { t } from "./locale.svelte";
  import { bridged } from "../lib/backend";
  import { amosWarn } from "../lib/debugLog";
  import {
    decodeTextRecord,
    decodeUriRecord,
    nfcFormatTag,
    nfcReadBelongsTo,
    nfcReadBytes,
    nfcReadNoticeKey,
    nfcStartDispatch,
    nfcStatus,
    nfcStopDispatch,
    nfcWriteMessage,
    ndefTextRecord,
    ndefUriRecord,
    subscribeNfcTag,
    type NfcAvailableResult,
    type NdefRecord,
    type NfcReadOutcome,
    type NfcTag,
  } from "../lib/nfc";

  const CARD =
    "overflow-hidden rounded-[14px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const BTN = "rounded-full bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40";
  const SOFT =
    "rounded-full bg-neutral-200 px-2.5 py-1 text-xs opacity-70 disabled:opacity-40 dark:bg-neutral-700";
  const FIELD =
    "w-full rounded-lg bg-black/5 px-3 py-2 text-sm outline-none ring-1 ring-transparent focus:ring-accent dark:bg-white/10";
  const LABEL = "text-[10px] uppercase tracking-wider opacity-50";

  /** Hard bound on the tag list — the screen may stay mounted for days. */
  const MAX_TAGS = 50;
  /** Hard bound on the write payload, so a paste cannot be handed to the glue unbounded. */
  const MAX_WRITE_CHARS = 512;

  let bridgedNow = $state(bridged());
  /** `null` = the bridge did not answer (host/desktop), which is NOT "no hardware". */
  let status = $state<NfcAvailableResult | null>(null);
  /**
   * The **last adapter read** was refused, so `status`'s `null` is 「我没问到」 (REQ-A1518 /
   * F-SH-760). A separate flag because `null` is also the value before the first read lands
   * — that is 「还没问」, and the card is drawn from it on the very first paint. `stateKey`
   * already keeps the two apart for the *label* (`null` ⇒ `nfc.state.unknown`); this flag is
   * what the hint below needs, so a non-answer stops asserting a hardware fact.
   */
  let statusUnanswered = $state(false);
  let tags = $state<NfcTag[]>([]);
  let selectedId = $state<string | null>(null);
  let broadcasting = $state(false);
  let busy = $state<"" | "write" | "format" | "read">("");
  let notice = $state<{ key: string; ok: boolean; params?: Record<string, string | number> } | null>(
    null,
  );
  let writeMode = $state<"text" | "uri">("text");
  let writeValue = $state("");
  /**
   * Raw hex of the **selected** tag's bytes (`nfc_read_bytes`), once a read has confirmed they
   * belong to it. `null` until then — including when the read answered with another tag's
   * bytes, which go to {@link readOther} instead (REQ-A781 / F-AND-009).
   */
  let readHex = $state<string | null>(null);
  /**
   * Bytes of a tag the glue was holding that is **not** the one the user selected, kept with the
   * id that owns them so they are shown as that tag's rather than this one's.
   *
   * The glue reads `lastTag` and takes no argument, so this is the ordinary case whenever the
   * user works through a list of already-scanned tags with only one of them in the field.
   */
  let readOther = $state<{ id: string; hex: string } | null>(null);
  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  /** Every action is gated on the platform's own answer, not on a local guess. */
  const ready = $derived(status?.state === "enabled");
  const selected = $derived(tags.find((tag) => tag.id === selectedId) ?? null);
  const canWrite = $derived(
    ready && writeValue.trim().length > 0 && writeValue.length <= MAX_WRITE_CHARS,
  );

  /** The localized label for the platform-reported state.
   *
   *  Exhaustive on purpose (REQ-A775 / F-AND-007). `nfc.state.noHardware` is a claim
   *  about the user's *hardware*, so it is reachable from exactly one wire value —
   *  the platform's own `no-hardware`. Everything else falls to `unavailable`, whose
   *  sentence is about **this app's reach** ("the adapter state could not be read"),
   *  not about the phone. The old single `string` state let an unread adapter print
   *  "本机没有 NFC 硬件" on a phone with an NFC radio. */
  function stateKey(s: NfcAvailableResult | null): string {
    if (s === null) return "nfc.state.unknown";
    switch (s.state) {
      case "enabled":
        return "nfc.state.enabled";
      case "disabled":
        return "nfc.state.disabled";
      case "no-hardware":
        return "nfc.state.noHardware";
      case "unavailable":
        return "nfc.state.unavailable";
      default:
        return "nfc.state.unknown";
    }
  }

  /** What a record holds, for display: a decoded text/URI, or an honest "other". */
  function recordView(rec: NdefRecord): { key: string; text: string } {
    const text = decodeTextRecord(rec);
    if (text !== null) return { key: "nfc.recordText", text };
    const uri = decodeUriRecord(rec);
    if (uri !== null) return { key: "nfc.recordUri", text: uri };
    if (rec.payload === "") return { key: "nfc.recordEmpty", text: "" };
    return { key: "nfc.recordOther", text: rec.payload.slice(0, 64) };
  }

  async function refreshStatus() {
    const s = await nfcStatus();
    if (disposed) return;
    status = s;
    statusUnanswered = s === null;
  }

  /**
   * Start (or stop) foreground dispatch.
   *
   * `nfcStartDispatch` / `nfcStopDispatch` answer whether the platform accepted the
   * registration, so a refusal is shown as a failure rather than as "reading".
   *
   * Two rules the old body broke:
   *  * `null` (the host did not answer) is its own fact and is not a platform refusal
   *    (REQ-A1337) — `nfc.scanFailed` names the **system** as the refuser and asserts why.
   *  * A **refused stop** must not clear `broadcasting` (REQ-A1341): the adapter was
   *    still registered and the stop did not take, so forgetting it left the screen reading
   *    「尚未开始读取」 with the reader still live. Only an acknowledged answer moves the flag,
   *    the rule `toggleSubscribe` in BleApp.svelte already follows.
   */
  async function toggleScan() {
    if (!ready) return;
    const want = !broadcasting;
    const ok = want ? await nfcStartDispatch() : await nfcStopDispatch();
    if (disposed) return;
    if (ok === null) {
      notice = { key: "nfc.scanUnanswered", ok: false };
      amosWarn("nfc", "foreground dispatch unanswered", { want });
      return;
    }
    if (!ok) {
      // One sentence per direction: the stop direction used to print `nfc.scanFailed`
      // (「系统拒绝**启动**前台派发」) for a request that asked for the opposite.
      notice = { key: want ? "nfc.scanFailed" : "nfc.stopFailed", ok: false };
      amosWarn("nfc", "foreground dispatch refused", { want });
      return;
    }
    broadcasting = want;
    notice = { key: want ? "nfc.scanStarted" : "nfc.scanStopped", ok: true };
  }

  /**
   * Write the composed record to the tag the glue is holding.
   *
   * A `{ ok: false, error }` reply is surfaced with the glue's own string — the one
   * thing this screen must never do is report a write that did not happen.
   */
  async function write() {
    if (!canWrite) return;
    busy = "write";
    const record =
      writeMode === "uri" ? ndefUriRecord(writeValue.trim()) : ndefTextRecord(writeValue);
    const out = await nfcWriteMessage([record]);
    busy = "";
    if (disposed) return;
    if (out === null) {
      // `null` = the host did not answer (REQ-A1337). Nothing may be reported as written, and
      // the old fold fed `nfc.writeFailed` an English cause this module invented.
      notice = { key: "nfc.writeUnanswered", ok: false };
      return;
    }
    if (out.ok) {
      readHex = null;
      readOther = null;
      notice = { key: "nfc.writeOk", ok: true, params: { n: out.bytesWritten ?? 0 } };
    } else {
      notice = { key: "nfc.writeFailed", ok: false, params: { error: out.error } };
    }
  }

  async function format() {
    if (!ready) return;
    busy = "format";
    const ok = await nfcFormatTag();
    busy = "";
    if (disposed) return;
    if (ok === null) {
      // `null` = the host did not answer (REQ-A1337): `nfc.formatFailed` names the **card** as
      // the refuser and asserts why, which a command nobody carried out cannot establish.
      notice = { key: "nfc.formatUnanswered", ok: false };
      return;
    }
    notice = { key: ok ? "nfc.formatOk" : "nfc.formatFailed", ok };
  }

  /**
   * Read the bytes the glue is holding.
   *
   * The reply is a **state**, not a nullable string (REQ-A781 / F-AND-009): "no tag is in the
   * field", "this tag carries no NDEF payload", "the read threw" and "this host could not ask"
   * are four different sentences, and only the last one is about *this app*. It also names the
   * tag it read — the glue reads whatever tag it last saw, so bytes that belong to a different
   * tag are shown under that tag's id and never inside the selected tag's card.
   */
  async function readBytes() {
    if (!ready || selected === null) return;
    const asked = selected.id;
    busy = "read";
    const out: NfcReadOutcome | null = await nfcReadBytes(asked);
    busy = "";
    if (disposed) return;
    if (out === null) {
      // `null` = the host said nothing at all (REQ-A1337) — distinct from `unavailable`, which
      // is a host that spoke and gave its own reason. The old fold invented `"not bridged"` to
      // fill `unavailable`'s `detail`, and `nfc.readUnavailable` renders it verbatim.
      readHex = null;
      readOther = null;
      notice = { key: "nfc.readUnanswered", ok: false };
      return;
    }
    const mine = nfcReadBelongsTo(out, asked);
    // `Some("")` is a real answer (a zero-length payload) and renders as `nfc.readEmpty`.
    readHex = mine ? (out.hex ?? "") : null;
    readOther = !mine && out.tag_id !== undefined && out.hex !== undefined
      ? { id: out.tag_id, hex: out.hex }
      : null;
    notice = {
      key: nfcReadNoticeKey(out, asked),
      // Only a read that produced bytes is a success — `empty` read fine but produced nothing
      // to show, and every other state is a failure of some kind.
      ok: out.state === "bytes",
      params: {
        id: out.tag_id ?? "?",
        error: out.detail ?? "",
        detail: out.detail ?? "",
      },
    };
  }

  function pushTag(tag: NfcTag) {
    // Newest first, one entry per tag id (a tag held twice must not duplicate).
    tags = [tag, ...tags.filter((x) => x.id !== tag.id)].slice(0, MAX_TAGS);
    selectedId = tag.id;
    readHex = null;
    readOther = null;
  }

  onMount(async () => {
    bridgedNow = bridged();
    await refreshStatus();
    if (disposed) return;
    if (status?.state === "enabled") {
      const started = await nfcStartDispatch();
      if (disposed) return;
      // Only a confirmed acceptance means we are dispatching (REQ-A1337: `null` = no answer,
      // which is not an acceptance).
      broadcasting = started === true;
    }
    // The subscription is registered through the bridge helper, which is a no-op
    // outside Tauri — so a host run simply never receives tags (it does not fake any).
    // REQ-A838: `subscribeNfcTag` answers `null` when the listen was refused; `unsubscribe`
    // then stays `null` so the teardown has nothing to call, and the screen can tell "no tag
    // has been presented" (a reader that is listening, and has seen nothing) apart from "we
    // are not reading at all" via `bridgeDiag(NFC_TAG_EVENT)`.
    unsubscribe = await subscribeNfcTag(pushTag);
    if (disposed) unsubscribe?.();
  });

  onDestroy(() => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
    // Release the adapter; a screen that leaves it in foreground dispatch would keep
    // the NFC service bound for a surface nobody is looking at.
    if (broadcasting) void nfcStopDispatch();
  });
</script>

{#if !bridgedNow}
  <div class="p-6 text-center text-sm opacity-70" data-testid="nfc-offline">
    <div>{t("nfc.offline")}</div>
    <div class="mt-1 text-[11px] opacity-60">{t("nfc.offlineHint")}</div>
  </div>
{:else}
  <div class="space-y-3 p-4">
    <!-- Adapter state — the platform's own answer, never a local guess. -->
    <div class={CARD} data-testid="nfc-status">
      <div class="flex items-center justify-between gap-3 p-3">
        <div>
          <div class={LABEL}>{t("nfc.adapter")}</div>
          <div class="text-sm font-medium" data-testid="nfc-state">{t(stateKey(status))}</div>
        </div>
        <button
          class={BTN}
          disabled={!ready}
          onclick={toggleScan}
          data-testid="nfc-toggle-scan"
          aria-label={t(broadcasting ? "nfc.stopScan" : "nfc.startScan")}
        >
          {t(broadcasting ? "nfc.stopScan" : "nfc.startScan")}
        </button>
      </div>
      {#if status?.state === "disabled"}
        <div class="px-3 pb-3 text-[11px] opacity-70" data-testid="nfc-disabled-hint">
          {t("nfc.disabledHint")}
        </div>
      {:else if status?.state === "no-hardware"}
        <!-- The platform's own answer, and **only** it: `stateKey`'s doc records that this
             sentence must be unreachable from anything else, so a refused/unread adapter
             does not land here (REQ-A1518 / F-SH-760). -->
        <div class="px-3 pb-3 text-[11px] opacity-70" data-testid="nfc-nohw-hint">
          {t("nfc.noHardwareHint")}
        </div>
      {:else if statusUnanswered}
        <!-- The read was refused: `status` is `null`, which is 「我没问到」 and never a
             hardware fact. Reuses the 「读不到」 sentence, which already says explicitly that
             it is about this app's reach and not about the phone. -->
        <div class="px-3 pb-3 text-[11px] opacity-70" data-testid="nfc-status-unanswered">
          {t("nfc.unavailableHint")}
        </div>
      {:else if status?.state === "unavailable"}
        <!-- Separate from the line above on purpose: this one says the *app* could not
             read the adapter, never that the device has none. The host's own reason is
             shown when it gave one, so a user (or a bug report) can tell an unbound
             glue from a SecurityException instead of guessing. -->
        <div class="px-3 pb-3 text-[11px] opacity-70" data-testid="nfc-unavailable-hint">
          {t("nfc.unavailableHint")}
          {#if status.detail}
            <span class="opacity-70" data-testid="nfc-unavailable-detail">{status.detail}</span>
          {/if}
        </div>
      {/if}
    </div>

    {#if notice}
      <div
        class="rounded-lg px-3 py-2 text-xs {notice.ok
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}"
        data-testid="nfc-notice"
      >
        {t(notice.key, notice.params)}
      </div>
    {/if}

    <!-- Write panel -->
    <div class={CARD} data-testid="nfc-write">
      <div class="flex items-center justify-between px-3 pt-3">
        <div class={LABEL}>{t("nfc.writeTitle")}</div>
        <div class="flex gap-1">
          <button
            class={SOFT}
            class:bg-accent={writeMode === "text"}
            class:text-white={writeMode === "text"}
            onclick={() => (writeMode = "text")}
            data-testid="nfc-mode-text"
            aria-pressed={writeMode === "text"}
          >
            {t("nfc.modeText")}
          </button>
          <button
            class={SOFT}
            class:bg-accent={writeMode === "uri"}
            class:text-white={writeMode === "uri"}
            onclick={() => (writeMode = "uri")}
            data-testid="nfc-mode-uri"
            aria-pressed={writeMode === "uri"}
          >
            {t("nfc.modeUri")}
          </button>
        </div>
      </div>
      <div class="space-y-2 p-3">
        <input
          class={FIELD}
          bind:value={writeValue}
          maxlength={MAX_WRITE_CHARS}
          placeholder={t(writeMode === "uri" ? "nfc.placeholderUri" : "nfc.placeholderText")}
          aria-label={t(writeMode === "uri" ? "nfc.placeholderUri" : "nfc.placeholderText")}
          data-testid="nfc-write-value"
        />
        <div class="flex items-center justify-between">
          <span class="text-[11px] opacity-60" data-testid="nfc-write-len">
            {t("nfc.charCount", { n: writeValue.length, max: MAX_WRITE_CHARS })}
          </span>
          <div class="flex gap-2">
            <button
              class={SOFT}
              disabled={!ready || busy !== ""}
              onclick={format}
              data-testid="nfc-format"
            >
              {t("nfc.format")}
            </button>
            <button
              class={BTN}
              disabled={!canWrite || busy !== ""}
              onclick={write}
              data-testid="nfc-write-btn"
            >
              {t("nfc.write")}
            </button>
          </div>
        </div>
        <div class="text-[11px] opacity-60">{t("nfc.writeHint")}</div>
      </div>
    </div>

    <!-- Scanned tags -->
    <div class={CARD} data-testid="nfc-tags">
      <div class="flex items-center justify-between px-3 pt-3">
        <div class={LABEL}>{t("nfc.tags", { n: tags.length })}</div>
        <button
          class={SOFT}
          disabled={tags.length === 0}
          onclick={() => {
            tags = [];
            selectedId = null;
            readHex = null;
            readOther = null;
          }}
          data-testid="nfc-clear"
        >
          {t("nfc.clear")}
        </button>
      </div>
      {#if tags.length === 0}
        <div class="p-3 text-xs opacity-60" data-testid="nfc-empty">
          {t(broadcasting ? "nfc.waiting" : "nfc.notScanning")}
        </div>
      {:else}
        <ul class="divide-y divide-black/5 dark:divide-white/10">
          {#each tags as tag (tag.id)}
            <li>
              <button
                class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-black/5 dark:hover:bg-white/5"
                onclick={() => {
                  selectedId = tag.id;
                  readHex = null;
                  readOther = null;
                }}
                data-testid="nfc-tag-{tag.id}"
                aria-current={selectedId === tag.id}
              >
                <span class="truncate font-mono">{tag.id}</span>
                <span class="shrink-0 opacity-60">
                  {tag.technology}
                  {tag.ndef ? "· NDEF" : `· ${t("nfc.notNdef")}`}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- Selected tag detail -->
    {#if selected}
      <div class={CARD} data-testid="nfc-detail">
        <div class="px-3 pt-3">
          <div class={LABEL}>{t("nfc.detail")}</div>
          <div class="mt-1 font-mono text-xs" data-testid="nfc-detail-id">{selected.id}</div>
          <div class="mt-1 text-[11px] opacity-60">
            {t("nfc.technology")}: {selected.technology} · {t("nfc.ndef")}:
            {selected.ndef ? t("nfc.yes") : t("nfc.no")}
          </div>
        </div>
        {#if selected.ndef && selected.records && selected.records.length > 0}
          <ul class="mt-2 divide-y divide-black/5 dark:divide-white/10">
            {#each selected.records as rec, i (i)}
              {@const view = recordView(rec)}
              <li class="px-3 py-2 text-xs">
                <div class="opacity-60">{t("nfc.record", { n: i + 1 })} · TNF {rec.tnf}</div>
                <div class="mt-0.5 break-all" data-testid="nfc-record-{i}">
                  {t(view.key)}: {view.text}
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <div class="px-3 py-2 text-xs opacity-60" data-testid="nfc-no-records">
            {t("nfc.noRecords")}
          </div>
        {/if}
        <div class="flex items-center justify-between gap-2 p-3">
          <button
            class={SOFT}
            disabled={!ready || busy !== ""}
            onclick={readBytes}
            data-testid="nfc-read"
          >
            {t("nfc.readBytes")}
          </button>
          {#if readHex !== null}
            <span class="truncate font-mono text-[11px] opacity-70" data-testid="nfc-read-hex">
              {readHex === "" ? t("nfc.readEmpty") : readHex}
            </span>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Bytes the glue read from a *different* tag than the one selected.
         The glue reads `lastTag` and takes no argument, so this is the ordinary case when the
         user works through a list of already-scanned tags: shown here, under the id that owns
         them, rather than inside the selected tag's card where they would read as its contents
         (REQ-A781 / F-AND-009). -->
    {#if readOther}
      <div class={CARD} data-testid="nfc-read-other">
        <div class="px-3 pt-3">
          <div class={LABEL}>{t("nfc.readOtherTitle")}</div>
          <div class="mt-1 font-mono text-xs" data-testid="nfc-read-other-id">{readOther.id}</div>
        </div>
        <div
          class="break-all px-3 py-2 font-mono text-[11px] opacity-70"
          data-testid="nfc-read-other-hex"
        >
          {readOther.hex === "" ? t("nfc.readEmpty") : readOther.hex}
        </div>
      </div>
    {/if}
  </div>
{/if}
