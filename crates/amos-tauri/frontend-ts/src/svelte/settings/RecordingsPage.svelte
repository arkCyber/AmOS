<script lang="ts">
  // RecordingsPage.svelte — 通话录音列表子页面 (REQ-A1334)
  //
  // 真相来自 Rust 侧 `recording.rs` 的账本（`<app_data>/recordings.json`）。本页有两条必须
  // 分开画的事实：
  //
  //   1. **账本**（有哪些录音）—— `recordingsList()`；空列表是「还没有录音」这一正常初始态，
  //      不是错误（Rust 侧对缺失的索引就返回空 `Vec`）。
  //   2. **采集能力**（这台机器能不能录音）—— `recordingsCaptureStatus()`，**只有它**能说
  //      「录制不可用」。本页绝不能从一个空列表推断「不能录音」：两件事不同。
  //
  // 空列表 + 可采集 ⇒「暂无录音」；空列表 + 不可采集 ⇒ 如实说明本轮尚未接通采集通路，并
  // 给出宿主自己的原因（绝不粉饰成「无录音」）。这样一台目前不可能产出录音的设备上，页面
  // 不会用一个空列表暗示「录音在这里」。
  import { onMount } from "svelte";
  import { t } from "../locale.svelte";
  import {
    formatBytes,
    formatDuration,
    recordingDelete,
    recordingsCaptureStatus,
    recordingsList,
    sortRecordings,
    type RecordingCaptureStatus,
    type RecordingMeta,
  } from "../../lib/recordings";
  import { bridgeDiag } from "../../lib/backend";
  import { GROUP, HINT, ROW } from "./kit";

  /** `null` = 还没问到 / 宿主没答。三个状态各自可分辨，不合并。 */
  let status = $state<RecordingCaptureStatus | null>(null);
  /** `null` = 读取失败（与空列表区分开）。 */
  let list = $state<RecordingMeta[] | null>(null);
  let loading = $state(true);
  /** 最近一次删除被拒的 id（成功即清空）。 */
  let refused = $state<string | null>(null);
  let deleting = $state<string | null>(null);
  /** 读被拒时画哪句话。`null` = 没有话要说（读成功了）。 */
  let listError = $state<string | null>(null);
  /**
   * 读取被拒（窗口不在前台）时就地记下：回到前台要补这一次读。这不是「读失败」——宿主已经
   * 明说了原因，而原因会过去，所以它欠着（`MessagesApp` 的 `readOwed`、`MailApp` 的
   * F-SH-655 是同一套规矩）。
   */
  let readOwed = $state(false);

  const rows = $derived(list == null ? null : sortRecordings(list));

  /** 宿主自己的错误码，说明「调用方不是用户正在看的那个窗口」。 */
  const FOREGROUND_REQUIRED = "amos.recordings.foreground_required";

  /**
   * 一次 `null` 读回来说的是哪一种事实——三种，不是一种：根本没有桥、窗口不在前台（宿主
   * 自己的码，F-SH-657）、账本真的读不出来。只有第二种值得重试（且回前台就会成），所以
   * 三者**按宿主发来的码**分开，绝不靠猜。
   */
  const refusalOf = (command: string): { text: string; owed: boolean } => {
    const diag = bridgeDiag(command);
    if (!diag.ok && diag.kind === "not-bridged") {
      return { text: t("recordings.unreadable"), owed: false };
    }
    const detail = diag.ok === false && diag.kind === "command-failed" ? diag.detail : undefined;
    const code = typeof detail === "object" && detail !== null
      ? (detail as { code?: unknown }).code
      : undefined;
    return code === FOREGROUND_REQUIRED
      ? { text: t("recordings.readRefused"), owed: true }
      : { text: t("recordings.unreadable"), owed: false };
  };

  /**
   * 台账里记的**实际**采集源 → 本地化短标签。两个词由 Rust 的 `parse_recording_report` 校验过
   * （`voice_call` / `voice_communication`）；遇到未知词就原样显示，不吞也不改写成已知源——
   * 「实际录到了哪一侧」正是这一行存在的理由（REQ-A1579）。
   */
  const sourceLabel = (source: string): string =>
    source === "voice_call"
      ? t("recordings.sourceCall")
      : source === "voice_communication"
        ? t("recordings.sourceMic")
        : source;

  const refresh = async () => {
    // 每次重读都先把上一次的话作废：谁要留话，读完这一份新的再说。
    listError = null;
    readOwed = false;
    const l = await recordingsList();
    list = l;
    if (l === null) {
      const refusal = refusalOf("recordings_list");
      listError = refusal.text;
      readOwed = refusal.owed;
    }
  };

  onMount(async () => {
    // 能力与账本分开问：能力答不上来只是 capability 画不出来，不该把账本一起画成读不出。
    status = await recordingsCaptureStatus();
    await refresh();
    loading = false;
  });

  /**
   * 回到前台时把这笔欠下的读还上（REQ-A1398 ∕ F-SH-657）。`window` 的 focus/blur 是**每个
   * WebView 各自**的——正是宿主拿来比较的那个单位，所以它就是这次拒绝所说的信号。
   */
  $effect(() => {
    const onFocus = () => {
      if (readOwed) {
        readOwed = false;
        void refresh();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  const remove = async (callId: string) => {
    deleting = callId;
    refused = null;
    const after = await recordingDelete(callId);
    deleting = null;
    if (after == null) {
      // 命令被拒（或宿主没答）——**不**从本地列表里划掉那一行，否则一次被拒的删除会被画成
      // 已删除（REQ-A1265 同族）。
      refused = callId;
      return;
    }
    // 成功：用宿主返回的**存活账本**重画，而不是自己在本地过滤一遍。
    list = after;
  };
</script>

<div class="flex flex-col gap-5 px-4 pb-6 pt-2">
  <section class={GROUP}>
    <div class="px-4 py-3">
      <h3 class="text-sm font-semibold">{t("recordings.title")}</h3>
    </div>

    {#if loading}
      <div class="px-4 pb-3">
        <p class={HINT} data-testid="recordings-loading">{t("recordings.loading")}</p>
      </div>
    {:else if rows == null}
      <div class="px-4 pb-3">
        <!-- 「没桥 / 不在前台 / 真读不出」是三件事，各说各的（REQ-A1398 ∕ F-SH-657）。 -->
        <p class={HINT} data-testid="recordings-unreadable">
          {listError ?? t("recordings.unreadable")}
        </p>
      </div>
    {:else if rows.length === 0}
      <div class="px-4 pb-3">
        <p class={HINT} data-testid="recordings-empty">{t("recordings.empty")}</p>
      </div>
    {:else}
      {#each rows as rec (rec.call_id)}
        <div class={ROW} data-testid="recording-row">
          <span class="flex-1 text-left">
            <span class="block truncate">{rec.peer || t("recordings.unknownPeer")}</span>
            <span class="block text-xs opacity-60">
              {formatDuration(rec.duration_sec)} · {formatBytes(rec.file_size_bytes)}{#if rec.source}<span
                  data-testid="recording-source"
                  data-source={rec.source}> · {sourceLabel(rec.source)}</span>{/if}
            </span>
          </span>
          <button
            type="button"
            class="rounded-full px-3 py-1 text-xs text-danger active:scale-95 disabled:opacity-40"
            disabled={deleting === rec.call_id}
            onclick={() => remove(rec.call_id)}
            data-testid="recording-delete"
          >
            {t("recordings.delete")}
          </button>
        </div>
      {/each}
    {/if}

    {#if refused != null}
      <div class="px-4 pb-3">
        <p class="text-xs text-danger" data-testid="recording-delete-refused">
          {t("recordings.deleteFailed")}
        </p>
      </div>
    {/if}
  </section>

  <!--
    采集能力单独一条。它说的是「这台机器现在能不能录」——与上面「有哪些录音」是两件事，所以两句
    文案也不同：

      * `!available` —— 如实说出运行期缺的是哪一项（构建 / 默认电话应用 / 麦克风权限），并把宿主
        自己的原话原样画出来，绝不转述成「无录音」。
      * `available` —— 能录，但普通安装只有本机一侧，这句边界必须说出来（REQ-A1579）。
  -->
  {#if status != null && !status.available}
    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class="text-sm font-semibold">{t("recordings.captureOffTitle")}</p>
        <p class={HINT} data-testid="recordings-capture-unavailable">
          {t("recordings.captureOffDesc")}
        </p>
        {#if status.reason}
          <!-- 宿主自己的原话，不翻译、不改写：让用户看到的是真实原因，而不是我们转述过的。 -->
          <p class="mt-2 text-xs opacity-60" data-testid="recordings-capture-reason">
            {status.reason}
          </p>
        {/if}
      </div>
    </section>
  {:else if status != null && status.available}
    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class={HINT} data-testid="recordings-mic-only-note">
          {t("recordings.micOnlyNote")}
        </p>
      </div>
    </section>
  {/if}
</div>
