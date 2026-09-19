/**
 * VoiceMemosApp.svelte — Svelte 5 (runes) single-source implementation of the
 * voice-memos screen. iOS-style recorder persisted to the shared amos.vmemos
 * store; demo clips (synthesized WAV) make the list playable without a mic.
 *
 * Three feature groups added in this cycle:
 *   ① Playback progress — a detail panel shows a seek slider + duration while
 *     a memo plays, so the user can scrub to any position.
 *   ② Trim — the panel offers [start, end] handles clamped to the duration.
 *     Saving a trim writes a NEW sibling memo (the original stays untouched);
 *     a seed memo has no bytes to cut and the trim affordance is absent.
 *   ③ ASR transcript — a "转写" button calls `transcribe_audio` (via the
 *     translate daemon); the plain text is stored on the memo row and rendered
 *     below the title, with "转写中…" while the request is in-flight.
 */
<script lang="ts">
import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
import { amosWarn } from "../lib/debugLog";
import StoreErrorBar from "./StoreErrorBar.svelte";
import { defaultMediaStore } from "../lib/mediaStore";
import { grantCapability } from "./osPermissions";
import type { VoiceMemo } from "../lib/voiceMemos";
import type { MemoRange } from "../lib/voiceMemos";
import type { AsrState } from "../lib/voiceMemos";
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
  clampSeekSeconds,
  progressPercent,
  clampTrimRange,
  isFullRange,
  trimmedDurationMs,
  trimMemo,
  attachTranscript,
  classifyTranscribe,
  classifyTranscribeError,
} from "../lib/voiceMemos";
import type { ActiveRecording } from "../lib/voiceRecorder";
import { startVoiceRecording } from "../lib/voiceRecorder";
import { blobBytes, exportNameFor, exportToSharedCollection, RECORDING_EXPORT_DIR } from "../lib/mediaExport";
import { transcribeAudio } from "../lib/backend";
import { iconSvg } from "../lib/sysIcons";
import { t } from "./locale.svelte";

const GROUP =
  "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
const ROW =
  "flex items-center justify-between gap-3 px-4 py-3";
const SUB = "h-px bg-black/5 dark:bg-white/10";

// Mic capability ("microphone") via the OS permission ledger. REQ-A380: Voice
// Memos is one of the built-in apps in the boot-time default-on set — opening
// the screen must NOT ask the user to tap an allow chip first. The boot-time
// seed (`svelte/osCapabilities.ts`) writes the ledger once and mirrors to the
// daemon. Per-session, `start()` re-asserts the cap through the same seam so
// every first-record session produces one audit-trail entry (a "use"), not just
// the initial boot seed. The ledger remains the authoritative read: an explicit
// Privacy revoke still flips the cap off and is re-asserted on the next call.

// Demo seed — **only when the key is absent**: deleting every memo must not
// bring the demo list back on the next mount.
const initialMemos: VoiceMemo[] = normalizeVoiceMemos(
  readStoreValue(VMEMOS_KEY, undefined) ?? [],
);
let memos: VoiceMemo[] = $state(initialMemos);
$effect(() => {
  if (
    memos.length === 0 &&
    readStoreValue(VMEMOS_KEY, undefined) === undefined
  ) {
    const s = seedVoiceMemos(Date.now());
    writeStoreValue(VMEMOS_KEY, s);
    memos = s;
  }
});

// The store refused a write (full/unavailable): say so and keep showing the truth.
let storeErr = $state("");
const persist = (next: VoiceMemo[]): boolean => {
  const c = normalizeVoiceMemos(next);
  if (!writeStoreValueChecked(VMEMOS_KEY, c)) {
    storeErr = t("common.storeWriteFailed");
    return false;
  }
  storeErr = "";
  memos = c;
  return true;
};

/* ---- recording ---- */
let recording = $state(false);
let startAt = $state(0);
let beat = $state(0);
let error: string | null = $state(null);
let recRef: ActiveRecording | null = null;
$effect(() => {
  if (!recording) return;
  const id = window.setInterval(() => (beat = Date.now()), 250);
  return () => window.clearInterval(id);
});
const elapsed = $derived(recording ? beat - startAt : 0);

const start = async (): Promise<void> => {
    error = null;
    // REQ-A380: vmemos is in the boot-time default-on set, so the ledger holds
    // the microphone grant on every fresh boot. `startVoiceRecording` is the
    // single point that touches the OS mic; we re-assert the capability
    // through the daemon seam so every "use" lands in the audit log without
    // an in-app prompt. An explicit Privacy revoke is the only path that
    // flips the ledger off — and it is re-asserted on the next call.
    grantCapability("vmemos", "microphone");
    try {
      const r = await startVoiceRecording();
      recRef = r;
      startAt = Date.now();
      recording = true;
    } catch {
      error = t("vm.errUnavailable");
    }
  };

const stop = async (): Promise<void> => {
  const r = recRef;
  recRef = null;
  recording = false;
  if (!r) return;
  try {
    const res = await r.stop();
    const now = Date.now();
    const id = makeVoiceId();
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

const deleteMemo = (m: VoiceMemo): void => {
  persist(removeMemo(memos, m.id));
  if (m.audio.kind === "recorded") void defaultMediaStore().del(m.id);
};

/* ---- playback (one shared <audio>, object-URL fed) ---- */
let playingId: string | null = $state(null);
let selectedId: string | null = $state(null); // detail panel target
let audioEl: HTMLAudioElement | null = null;
let urlRef: string | null = null;

// Live playback position (ms) and duration (ms) while audio is playing.
let curMs = $state(0);
let durMs = $state(0);

const selectedMemo = $derived(
  memos.find((m) => m.id === selectedId) ?? null,
);

const audioUrlFor = async (m: VoiceMemo): Promise<string> => {
  if (m.audio.kind === "seed") {
    const bytes = buildWavBytes({
      seconds: m.audio.seconds,
      sampleRate: 8000,
      toneHz: m.audio.toneHz,
      amplitude: 0.3,
    });
    const audio = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return URL.createObjectURL(new Blob([audio], { type: "audio/wav" }));
  }
  const blob = await defaultMediaStore().get(m.id);
  return blob ? URL.createObjectURL(blob) : "";
};

const initAudio = (): HTMLAudioElement => {
  if (audioEl) return audioEl;
  const a = document.createElement("audio");
  a.ontimeupdate = () => {
    curMs = Math.round((a.currentTime ?? 0) * 1000);
  };
  a.ondurationchange = () => {
    durMs = Math.round((a.duration ?? 0) * 1000);
  };
  a.onended = () => {
    playingId = null;
    curMs = 0;
  };
  audioEl = a;
  return a;
};

const togglePlay = (m: VoiceMemo): void => {
  if (playingId === m.id) {
    audioEl?.pause();
    playingId = null;
    curMs = 0;
    return;
  }
  selectedId = m.id;
  const a = initAudio();
  if (urlRef) URL.revokeObjectURL(urlRef);
  urlRef = null;
  void audioUrlFor(m).then((url) => {
    if (!url) return;
    urlRef = url;
    a.src = url;
    void a.play().then(
      () => {
        playingId = m.id;
        selectedId = m.id;
      },
      () => {
        playingId = null;
      },
    );
  });
};

const seekToMs = (ms: number): void => {
  if (!audioEl || !durMs) return;
  const sec = clampSeekSeconds(ms / 1000, durMs / 1000);
  try {
    audioEl.currentTime = sec;
    curMs = Math.round(sec * 1000);
  } catch {
    /* not seekable yet (no metadata) */
  }
};

const closeDetail = (): void => {
  audioEl?.pause();
  playingId = null;
  selectedId = null;
  curMs = 0;
  durMs = 0;
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

/* ---- export to the shared collection (REQ-A350) ---- */
let exportOutcome: { id: string; outcome: string } | null = $state(null);
let exporting: string | null = $state(null);

const exportBytesFor = async (m: VoiceMemo): Promise<Uint8Array | null> => {
  if (m.audio.kind === "seed") {
    return buildWavBytes({
      seconds: m.audio.seconds,
      sampleRate: 8000,
      toneHz: m.audio.toneHz,
      amplitude: 0.3,
    });
  }
  const blob = await defaultMediaStore().get(m.id);
  return blob ? await blobBytes(blob) : null;
};

const exportMemo = async (m: VoiceMemo): Promise<void> => {
  exporting = m.id;
  exportOutcome = null;
  try {
    const bytes = await exportBytesFor(m);
    if (!bytes || bytes.length === 0) {
      exportOutcome = { id: m.id, outcome: "offline" };
      return;
    }
    const outcome = await exportToSharedCollection(
      "audio",
      exportNameFor(m.createdAt, m.mime),
      bytes,
      RECORDING_EXPORT_DIR,
    );
    exportOutcome = { id: m.id, outcome };
  } catch (e) {
    amosWarn("vmemos", "export threw", { id: m.id, error: String(e) });
    exportOutcome = { id: m.id, outcome: "offline" };
  } finally {
    exporting = null;
  }
};

const exportLabel = (outcome: string): string => {
  if (outcome === "saved") return t("vm.exportSaved");
  if (outcome === "refused") return t("vm.exportRefused");
  if (outcome === "offline") return t("vm.exportOffline");
  if (outcome === "empty") return t("vm.exportEmpty");
  return outcome;
};

/* ---- rename ---- */
let editingId: string | null = $state(null);
let draftTitle = $state("");
const beginRename = (m: VoiceMemo): void => {
  editingId = m.id;
  draftTitle = m.title;
};
const endRename = (save: boolean): void => {
  if (save && editingId && !persist(renameMemo(memos, editingId, draftTitle))) return;
  editingId = null;
};

/* ---- trim ---- */
let trimRange = $state<MemoRange | null>(null);
let trimBusy = $state(false);
let trimMsg: string | null = $state(null);

const beginTrim = (m: VoiceMemo): void => {
  trimRange = { startMs: 0, endMs: m.durationMs };
  trimMsg = null;
};

const cancelTrim = (): void => {
  trimRange = null;
  trimMsg = null;
};

/** Encode a mono AudioBuffer as a 16-bit PCM WAV ArrayBuffer. */
function encodeWav(buf: AudioBuffer): ArrayBuffer {
  const numSamples = buf.length;
  const numChannels = buf.numberOfChannels;
  const sampleRate = buf.sampleRate;
  const bytesPerSample = 2;
  const dataBytes = numSamples * numChannels * bytesPerSample;
  const headerBytes = 44;
  const total = headerBytes + dataBytes;
  const ab = new ArrayBuffer(total);
  const dv = new DataView(ab);
  const bytes = new Uint8Array(ab);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  dv.setUint32(4, 36 + dataBytes, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  dv.setUint16(32, numChannels * bytesPerSample, true);
  dv.setUint16(34, 16, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  dv.setUint32(40, dataBytes, true);
  const ch = buf.getChannelData(0);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, ch[i] ?? 0));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return ab;
}

const saveTrim = async (): Promise<void> => {
  const m = selectedMemo;
  if (!m || !trimRange || trimBusy) return;
  const r = clampTrimRange(trimRange.startMs, trimRange.endMs, m.durationMs);
  const build = trimMemo(m, r, Date.now());
  if (!build.ok) {
    trimMsg = t(`vm.trimErr.${build.reason}` as never) ?? build.reason;
    return;
  }
  trimBusy = true;
  trimMsg = null;
  let blob: Blob | null = null;
  if (m.audio.kind === "recorded") blob = await defaultMediaStore().get(m.id);
  if (!blob) {
    trimMsg = t("vm.trimErr.offline");
    trimBusy = false;
    return;
  }
  try {
    const arrayBuf = await blob.arrayBuffer();
    const decCtx = new AudioContext();
    const fullBuf = await decCtx.decodeAudioData(arrayBuf.slice(0));
    const offsetSec = r.startMs / 1000;
    const trimDurSec = (r.endMs - r.startMs) / 1000;
    const outRate = fullBuf.sampleRate;
    const chunkLen = Math.max(
      1,
      Math.min(
        Math.ceil(trimDurSec * outRate),
        fullBuf.length - Math.floor(offsetSec * outRate),
      ),
    );
    const buf = decCtx.createBuffer(1, chunkLen, outRate);
    const data = buf.getChannelData(0);
    const srcData = fullBuf.getChannelData(0);
    const startSample = Math.floor(offsetSec * outRate);
    for (let i = 0; i < chunkLen; i++) data[i] = srcData[startSample + i] ?? 0;
    await decCtx.close();
    const wavBuf = encodeWav(buf);
    const wavBlob = new Blob([wavBuf], { type: "audio/wav" });
    await defaultMediaStore().put(build.memo.id, wavBlob);
    build.memo.sizeBytes = wavBlob.size;
    const next = prependMemo(memos, build.memo);
    if (!persist(next)) {
      await defaultMediaStore().del(build.memo.id);
      trimMsg = t("common.storeWriteFailed");
    } else {
      trimMsg = t("vm.trimSaved");
      trimRange = null;
      selectedId = build.memo.id;
    }
  } catch (e) {
    amosWarn("vmemos", "trim failed", { id: m.id, error: String(e) });
    trimMsg = t("vm.trimErr.process");
  } finally {
    trimBusy = false;
  }
};

/* ---- ASR transcript ---- */
let asrState: AsrState = $state({ kind: "idle" });

const hasAsrSupport = (m: VoiceMemo): boolean => m.audio.kind === "recorded";

const startTranscribe = async (): Promise<void> => {
  const m = selectedMemo;
  if (!m || asrState.kind === "transcribing") return;
  asrState = { kind: "transcribing" };
  try {
    let bytes: Uint8Array | null = null;
    if (m.audio.kind === "seed") {
      bytes = buildWavBytes({
        seconds: m.audio.seconds,
        sampleRate: 8000,
        toneHz: m.audio.toneHz,
        amplitude: 0.3,
      });
    } else {
      const blob = await defaultMediaStore().get(m.id);
      if (blob) bytes = await blobBytes(blob);
    }
    if (!bytes || bytes.length === 0) {
      asrState = { kind: "error", message: "offline" };
      return;
    }
    const raw = await transcribeAudio(bytes, { format: "wav" });
    const now = Date.now();
    asrState = classifyTranscribe(raw, now);
    if (asrState.kind === "done") {
      const updated = attachTranscript(m, asrState.transcript);
      persist(memos.map((x) => (x.id === m.id ? updated : x)));
    }
  } catch (e) {
    asrState = classifyTranscribeError(e);
  }
};

const clearTranscript = (): void => {
  const m = selectedMemo;
  if (!m) return;
  asrState = { kind: "idle" };
  persist(memos.map((x) => (x.id === m.id ? attachTranscript(x, null) : x)));
};

/* ---- detail panel ---- */
const detailMemo = $derived(memos.find((m) => m.id === selectedId) ?? null);

// Sync asrState when detailMemo changes (user selects a different memo).
$effect(() => {
  const m = detailMemo;
  if (!m) {
    asrState = { kind: "idle" };
    return;
  }
  if (m.transcript) {
    asrState = { kind: "done", transcript: m.transcript };
  } else {
    asrState = { kind: "idle" };
  }
  trimRange = null;
  trimMsg = null;
});

const progressPct = $derived(durMs > 0 ? progressPercent(curMs, durMs) : 0);
const trimDurMs = $derived(trimRange ? trimmedDurationMs(trimRange) : 0);
const trimDurDisplay = $derived(fmtDuration(trimDurMs));
const trimPct = $derived(
  detailMemo && detailMemo.durationMs > 0 && trimRange
    ? (trimDurMs / detailMemo.durationMs) * 100
    : 0,
);
const trimStartPct = $derived(
  detailMemo && detailMemo.durationMs > 0 && trimRange
    ? (trimRange.startMs / detailMemo.durationMs) * 100
    : 0,
);
</script>

<div class="flex h-full flex-col">
  <StoreErrorBar message={storeErr} />

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
              <button
                onclick={() => {
                  selectedId = m.id;
                  trimRange = null;
                  trimMsg = null;
                }}
                class="min-w-0 flex-1 text-left"
                aria-label={m.title}
              >
                <p class={"truncate text-[15px] " + (playingId === m.id ? "text-accent" : "text-neutral-800 dark:text-neutral-100")}>
                  {m.title}
                </p>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                  {fmtDuration(m.durationMs)} · {fmtStamp(m.createdAt)}
                  {#if m.transcript} · {t("vm.hasTranscript")}{/if}
                  {#if m.trimOf} · {t("vm.trimmed")}{/if}
                </p>
                {#if m.transcript && playingId !== m.id}
                  <p class="mt-0.5 truncate text-xs italic text-neutral-400 dark:text-neutral-500">
                    {m.transcript.text}
                  </p>
                {/if}
              </button>
              <div class="flex shrink-0 items-center gap-1.5">
                <span
                  class="text-[11px] text-neutral-500 dark:text-neutral-400"
                  aria-live="polite"
                >{exportOutcome?.id === m.id ? exportLabel(exportOutcome.outcome) : ""}</span>
                <button
                  onclick={() => void exportMemo(m)}
                  aria-label={t("vm.export")}
                  title={t("vm.exportHint")}
                  data-icon="download"
                  class="grid h-6 w-6 place-items-center text-accent active:scale-90"
                  disabled={exporting === m.id}
                >
                  {@html iconSvg("download", "h-4 w-4")}
                </button>
                <button
                  onclick={() => beginRename(m)}
                  aria-label={t("vm.rename")}
                  data-icon="pencil"
                  class="grid h-6 w-6 place-items-center text-accent active:scale-90"
                >
                  {@html iconSvg("pencil", "h-4 w-4")}
                </button>
                <button
                  onclick={() => deleteMemo(m)}
                  aria-label={t("vm.delete")}
                  data-icon="trash"
                  class="grid h-6 w-6 place-items-center text-danger active:scale-90"
                >
                  {@html iconSvg("trash", "h-4 w-4")}
                </button>
              </div>
            </div>
            {#if editingId === m.id}
              <div class="px-4 pb-2">
                <input
                  bind:value={draftTitle}
                  onkeydown={(e) => {
                    if (e.key === "Enter") endRename(true);
                  }}
                  onblur={() => endRename(true)}
                  aria-label={t("vm.titlePlaceholder")}
                  class="w-full rounded-md bg-black/5 px-1.5 py-0.5 text-sm outline-none ring-1 ring-accent dark:bg-white/10"
                />
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- Detail panel (slides in from bottom when a memo is selected)  -->
<!-- ═══════════════════════════════════════════════════════════════ -->
{#if detailMemo}
  <div
    class="fixed inset-0 z-40 bg-black/30"
    onclick={() => closeDetail()}
    aria-hidden="true"
  ></div>

  <div
    class="fixed bottom-0 left-0 right-0 z-50 flex flex-col rounded-t-2xl bg-white pt-3 shadow-2xl dark:bg-neutral-900"
    role="dialog"
    aria-label={detailMemo.title}
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 pb-2">
      <div class="min-w-0 flex-1">
        <p class="truncate text-base font-semibold text-neutral-800 dark:text-neutral-100">
          {detailMemo.title}
        </p>
        <p class="text-xs text-neutral-500 dark:text-neutral-400">
          {fmtDuration(detailMemo.durationMs)} · {fmtStamp(detailMemo.createdAt)}
        </p>
      </div>
      <button
        onclick={() => closeDetail()}
        aria-label={t("common.close")}
        class="ml-2 grid h-8 w-8 shrink-0 place-items-center rounded-full text-neutral-500 hover:bg-black/5 active:scale-90 dark:hover:bg-white/10"
      >
        {@html iconSvg("x", "h-5 w-5")}
      </button>
    </div>

    <!-- ── Playback progress ── -->
    <div class="px-4 pb-3">
      <div class="flex items-center gap-2">
        <span class="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {fmtDuration(curMs)}
        </span>
        <input
          type="range"
          min="0"
          max="100"
          value={progressPct}
          aria-label={t("vm.seek")}
          class="h-1.5 w-full grow cursor-pointer appearance-none rounded-full bg-neutral-200 accent-accent dark:bg-neutral-700"
          oninput={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            const pct = Number(el.value);
            const ms = Math.round((pct / 100) * durMs);
            seekToMs(ms);
          }}
        />
        <span class="w-10 shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {fmtDuration(durMs || detailMemo.durationMs)}
        </span>
      </div>
    </div>

    <!-- ── Trim ── -->
    {#if detailMemo.audio.kind === "recorded"}
      <div class="px-4 pb-3">
        {#if !trimRange}
          <button
            onclick={() => beginTrim(detailMemo)}
            class="flex w-full items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 active:scale-98 dark:bg-neutral-800 dark:text-neutral-200"
            aria-label={t("vm.trim")}
          >
            {@html iconSvg("scissors", "h-4 w-4 shrink-0")}
            <span>{t("vm.trim")}</span>
            <span class="ml-auto text-xs text-neutral-400">{t("vm.trimHint")}</span>
          </button>
        {:else}
          <div class="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
            <p class="mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("vm.trimRange")}: <span class="tabular-nums text-neutral-700 dark:text-neutral-200">{trimDurDisplay}</span>
            </p>
            <div class="mb-1 flex items-center gap-2">
              <label class="w-12 shrink-0 text-xs text-neutral-500">{t("vm.trimStart")}</label>
              <input
                type="range"
                min="0"
                max={detailMemo.durationMs}
                value={trimRange.startMs}
                aria-label={t("vm.trimStart")}
                class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-accent/40 accent-accent"
                oninput={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  trimRange = clampTrimRange(
                    v,
                    trimRange?.endMs ?? detailMemo.durationMs,
                    detailMemo.durationMs,
                  );
                }}
              />
              <span class="w-12 shrink-0 text-right text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                {fmtDuration(trimRange.startMs)}
              </span>
            </div>
            <div class="mb-2 flex items-center gap-2">
              <label class="w-12 shrink-0 text-xs text-neutral-500">{t("vm.trimEnd")}</label>
              <input
                type="range"
                min="0"
                max={detailMemo.durationMs}
                value={trimRange.endMs}
                aria-label={t("vm.trimEnd")}
                class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-accent/40 accent-accent"
                oninput={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  trimRange = clampTrimRange(
                    trimRange?.startMs ?? 0,
                    v,
                    detailMemo.durationMs,
                  );
                }}
              />
              <span class="w-12 shrink-0 text-right text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                {fmtDuration(trimRange.endMs)}
              </span>
            </div>
            <div class="relative mb-3 h-2 rounded-full bg-neutral-200 dark:bg-neutral-700">
              <div
                class="absolute inset-y-0 left-0 rounded-full bg-accent"
                style="left:{trimStartPct}%; width:{trimPct}%"
                aria-hidden="true"
              ></div>
            </div>
            {#if trimMsg}
              <p class="mb-2 text-xs text-danger">{trimMsg}</p>
            {/if}
            <div class="flex gap-2">
              <button
                onclick={() => cancelTrim()}
                disabled={trimBusy}
                class="flex-1 rounded-lg border border-neutral-300 py-1.5 text-sm text-neutral-600 active:scale-98 dark:border-neutral-600 dark:text-neutral-300"
              >
                {t("common.cancel")}
              </button>
              <button
                onclick={() => void saveTrim()}
                disabled={trimBusy || trimDurMs < 1 || isFullRange(trimRange, detailMemo.durationMs)}
                class="flex-1 rounded-lg bg-accent py-1.5 text-sm text-white active:scale-98 disabled:opacity-40"
              >
                {trimBusy ? t("vm.trimming") : t("vm.trimSave")}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ── ASR transcript ── -->
    <div class="px-4 pb-4">
      {#if asrState.kind === "idle"}
        <button
          onclick={() => void startTranscribe()}
          class="flex w-full items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 active:scale-98 dark:bg-neutral-800 dark:text-neutral-200"
          aria-label={t("vm.transcribe")}
          disabled={!hasAsrSupport(detailMemo)}
          title={!hasAsrSupport(detailMemo) ? t("vm.transcribeSeedHint") : ""}
        >
          {@html iconSvg("mic", "h-4 w-4 shrink-0")}
          <span>{t("vm.transcribe")}</span>
        </button>
      {:else if asrState.kind === "transcribing"}
        <div class="flex items-center gap-2 rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">
          <span class="h-4 w-4 animate-pulse rounded-full bg-accent"></span>
          <span>{t("vm.transcribing")}</span>
        </div>
      {:else if asrState.kind === "done"}
        <div class="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
          <div class="mb-1 flex items-center justify-between">
            <p class="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("vm.transcriptLabel")}
              {#if asrState.transcript.lang} · {asrState.transcript.lang}{/if}
            </p>
            <button
              onclick={() => clearTranscript()}
              aria-label={t("vm.clearTranscript")}
              class="text-xs text-neutral-400 hover:text-danger active:scale-90"
            >
              {t("vm.clearTranscript")}
            </button>
          </div>
          {#if asrState.transcript.text}
            <p class="whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-100">
              {asrState.transcript.text}
            </p>
          {:else}
            <p class="text-sm italic text-neutral-400">{t("vm.transcriptEmpty")}</p>
          {/if}
        </div>
      {:else if asrState.kind === "empty"}
        <div class="flex items-center gap-2 rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-600 dark:text-neutral-400">
          {@html iconSvg("mic", "h-4 w-4 shrink-0 opacity-40")}
          <span>{t("vm.transcribeEmpty")}</span>
        </div>
      {:else if asrState.kind === "error"}
        <div class="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {@html iconSvg("alertCircle", "h-4 w-4 shrink-0")}
          <span>{t(`vm.transcribeErr.${asrState.message}` as never) ?? t("vm.transcribeErr.host")}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}
