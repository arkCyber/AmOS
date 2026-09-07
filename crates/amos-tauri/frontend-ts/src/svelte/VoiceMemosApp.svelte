<script lang="ts">
  // VoiceMemosApp.svelte — Svelte 5 (runes) single-source implementation of the
  // voice-memos screen. iOS-style recorder persisted to the shared
  // amos.vmemos store; demo clips (synthesized WAV) make the list playable without
  // a mic. Recording/playback reuse lib/voiceRecorder + lib/mediaStore;
  // real capture needs a microphone (device acceptance), while the
  // list CRUD / seed rows are fully browser-testable.
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { defaultMediaStore } from "../lib/mediaStore";
  import { capSet, grantCap, loadLedger, saveLedger } from "../lib/permissions";
  import {
    VMEMOS_KEY,
    makeVoiceId,
    prependMemo,
    renameMemo,
    removeMemo,
    normalizeVoiceMemos,
    seedVoiceMemos,
    memoForRecording,
    buildWavBytes,
    fmtDuration,
    fmtStamp,
    fmtClock,
    defaultRecordingTitle,
    type VoiceMemo,
  } from "../lib/voiceMemos";
  import { startVoiceRecording, type ActiveRecording } from "../lib/voiceRecorder";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";

  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const ROW = "flex items-center justify-between gap-3 px-4 py-3";
  const SUB = "h-px bg-black/5 dark:bg-white/10";

  // Mic capability ("microphone") via the OS permission ledger.
  let micGranted = $state(capSet(loadLedger(), "vmemos", "microphone"));

  const seeded = normalizeVoiceMemos(readStoreValue<unknown>(VMEMOS_KEY, []));
  const initMemos = seeded.length
    ? seeded
    : (() => {
        const s = seedVoiceMemos(Date.now());
        writeStoreValue(VMEMOS_KEY, s);
        return s;
      })();
  let memos = $state<VoiceMemo[]>(initMemos);
  const persist = (next: VoiceMemo[]) => {
    const c = normalizeVoiceMemos(next);
    writeStoreValue(VMEMOS_KEY, c);
    memos = c;
  };

  /* ---- recording ---- */
  let recording = $state(false);
  let startAt = $state(0);
  let beat = $state(0);
  let error = $state<string | null>(null);
  let recRef: ActiveRecording | null = null;
  $effect(() => {
    if (!recording) return;
    const id = window.setInterval(() => (beat = Date.now()), 250);
    return () => window.clearInterval(id);
  });
  const elapsed = $derived(recording ? beat - startAt : 0);

  const start = async () => {
    error = null;
    if (!micGranted) {
      saveLedger(grantCap(loadLedger(), "vmemos", "microphone"));
      micGranted = true;
    }
    try {
      const r = await startVoiceRecording();
      recRef = r;
      startAt = Date.now();
      recording = true;
    } catch {
      error = t("vm.errUnavailable");
    }
  };
  const stop = async () => {
    const r = recRef;
    recRef = null;
    recording = false;
    if (!r) return;
    try {
      const res = await r.stop();
      const now = Date.now();
      const id = makeVoiceId(now);
      try {
        await defaultMediaStore().put(id, res.blob);
      } catch {
        error = t("vm.errNoSpace");
        return;
      }
      persist(
        prependMemo(
          memos,
          memoForRecording({
            id,
            title: defaultRecordingTitle(now),
            createdAt: now,
            durationMs: Math.max(0, now - startAt),
            sizeBytes: res.blob.size,
            mime: res.mime,
          }),
        ),
      );
    } catch {
      error = t("vm.errMic");
    }
  };
  const deleteMemo = (m: VoiceMemo) => {
    persist(removeMemo(memos, m.id));
    if (m.audio.kind === "recorded") void defaultMediaStore().del(m.id);
  };

  /* ---- rename ---- */
  let editingId = $state<string | null>(null);
  let draftTitle = $state("");
  const beginRename = (m: VoiceMemo) => {
    editingId = m.id;
    draftTitle = m.title;
  };
  const endRename = (save: boolean) => {
    if (save && editingId) persist(renameMemo(memos, editingId, draftTitle));
    editingId = null;
  };

  /* ---- playback (one shared <audio>, object-URL fed) ---- */
  let playingId = $state<string | null>(null);
  let audioEl: HTMLAudioElement | null = null;
  let urlRef: string | null = null;
  const audioUrlFor = async (m: VoiceMemo): Promise<string> => {
    if (m.audio.kind === "seed") {
      const bytes = buildWavBytes({
        seconds: m.audio.seconds,
        sampleRate: 8000,
        toneHz: m.audio.toneHz,
        amplitude: 0.3,
      });
      const audio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return URL.createObjectURL(new Blob([audio], { type: "audio/wav" }));
    }
    const blob = await defaultMediaStore().get(m.id);
    return blob ? URL.createObjectURL(blob) : "";
  };
  const togglePlay = (m: VoiceMemo) => {
    if (playingId === m.id) {
      audioEl?.pause();
      playingId = null;
      return;
    }
    const a = audioEl ?? (audioEl = document.createElement("audio"));
    a.onended = () => (playingId = null);
    if (urlRef) URL.revokeObjectURL(urlRef);
    urlRef = null;
    void audioUrlFor(m).then((url) => {
      if (!url) return;
      urlRef = url;
      a.src = url;
      void a
        .play()
        .then(() => (playingId = m.id))
        .catch(() => (playingId = null));
    });
  };
  $effect(() => {
    return () => {
      const r = recRef;
      recRef = null;
      if (r) void r.stop().catch(() => undefined);
      audioEl?.pause();
      if (urlRef) URL.revokeObjectURL(urlRef);
      urlRef = null;
      audioEl = null;
    };
  });
</script>

<div class="flex h-full flex-col px-3 py-3">
  <!-- recorder -->
  <div class="flex shrink-0 flex-col items-center gap-1.5 pb-2">
    {#if !recording}
      <button
        onclick={() => void start()}
        aria-label={t("vm.record")}
        data-icon="record"
        class="grid h-20 w-20 place-items-center rounded-full bg-danger text-4xl text-white shadow-lg ring-4 ring-danger/25 active:scale-95"
      >
        {@html iconSvg("record", "h-10 w-10")}
      </button>
    {:else}
      <button
        onclick={() => void stop()}
        aria-label={t("vm.stop")}
        class="grid h-20 w-20 place-items-center rounded-full border-4 border-danger bg-danger/10 active:scale-95"
      >
        <span class="block h-9 w-9 rounded-md bg-white"></span>
      </button>
    {/if}
    <p class="text-xs text-neutral-500 dark:text-neutral-400">
      {recording ? `${t("vm.recording")} · ${fmtClock(elapsed)}` : t("vm.startHint")}
    </p>
    {#if error}
      <p class="text-xs text-danger">{error}</p>
    {/if}
  </div>

  <!-- memos -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class={GROUP}>
      {#if memos.length === 0}
        <p class="px-4 py-10 text-center text-sm opacity-50">{t("vm.empty")}</p>
      {:else}
        {#each memos as m, i (m.id)}
          <div>
            {#if i > 0}<div class={SUB}></div>{/if}
            <div class={ROW}>
              <button
                onclick={() => togglePlay(m)}
                aria-label={playingId === m.id ? t("vm.pause") : t("vm.play")}
                data-icon={playingId === m.id ? "pause" : "play"}
                class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-white active:scale-90"
              >
                {@html iconSvg(playingId === m.id ? "pause" : "play", "h-[18px] w-[18px]")}
              </button>
              <div class="min-w-0 flex-1">
                {#if editingId === m.id}
                  <input
                    bind:value={draftTitle}
                    onkeydown={(e) => {
                      if (e.key === "Enter") endRename(true);
                    }}
                    onblur={() => endRename(true)}
                    aria-label={t("vm.titlePlaceholder")}
                    class="w-full rounded-md bg-black/5 px-1.5 py-0.5 text-sm outline-none ring-1 ring-accent dark:bg-white/10"
                  />
                {:else}
                  <p class={"truncate text-[15px] " + (playingId === m.id ? "text-accent" : "text-neutral-800 dark:text-neutral-100")}>
                    {m.title}
                  </p>
                {/if}
                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                  {fmtDuration(m.durationMs)} · {fmtStamp(m.createdAt)}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                <button onclick={() => beginRename(m)} aria-label={t("vm.rename")} data-icon="pencil" class="grid h-6 w-6 place-items-center text-accent active:scale-90">
                  {@html iconSvg("pencil", "h-4 w-4")}
                </button>
                <button onclick={() => deleteMemo(m)} aria-label={t("vm.delete")} data-icon="trash" class="grid h-6 w-6 place-items-center text-danger active:scale-90">
                  {@html iconSvg("trash", "h-4 w-4")}
                </button>
              </div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

