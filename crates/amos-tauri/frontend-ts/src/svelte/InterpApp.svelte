<script lang="ts">
  // InterpApp.svelte — Svelte 5 (runes) single-source implementation of the
  // interpreter screen. All pure logic reuses lib/interp.ts
  // (language catalog + remembered prefs + persisted transcript in the shared
  // store) and lib/backend.ts RPC. Outside Tauri (no bridge) every call degrades
  // to null so the offline shell renders a localized banner and never crashes;
  // live mic capture + daemon streaming need a real device + amos-interp daemon.
  import { bridged, subscribe, interpretStart, interpretStop, interpretPause, interpretResume, interpretAudio, interpretText } from "../lib/backend";
  import { frameToInterpChunk } from "../lib/audio";
  import { speakText } from "../lib/realtimeTts";
  import { capTail } from "../lib/bounded";
  import {
    LANGS,
    langNative,
    readPrefs,
    writePrefs,
    loadSegs,
    saveSegs,
    clearSegs,
    segOf,
    partialTextOf,
    errorOf,
    transcriptText,
    type InterpPrefs,
    type InterpSeg,
  } from "../lib/interp";
  import { loadLedger, saveLedger, grantCap, capSet, type Capability } from "../lib/permissions";
  import { t } from "./locale.svelte";

  const APP_ID = "interpreter";
  const MIC_CAP: Capability = "microphone";
  const SEG_CAP = 200; // interpreter transcript segments kept in memory

  // Bridge presence is fixed per mount (matches the React `bridged()` read).
  const online = $state(bridged());
  // OS microphone permission gate (persisted ledger; interpreter is 2-tap in-app).
  let micGranted = $state(capSet(loadLedger(), APP_ID, MIC_CAP));

  let prefs = $state<InterpPrefs>(readPrefs());
  let running = $state(false);
  let paused = $state(false);
  let rec = $state(false);
  let askMic = $state(false);
  let segs = $state<InterpSeg[]>(loadSegs());
  let partial = $state("");
  let text = $state("");
  let status = $state("");
  let copiedAll = $state(false);
  let bilingual = $state(false);

  // Live-capture plumbing (kept in plain refs so callbacks stay stable).
  let sid: string | null = null;
  let ctxRef: AudioContext | null = null;
  let srcRef: MediaStreamAudioSourceNode | null = null;
  let procRef: ScriptProcessorNode | null = null;
  let streamRef: MediaStream | null = null;

  const langLabel = (code: string): string =>
    code === "auto" ? t("interp.auto") : langNative(code) || code;

  // Remember the language pair + auto-speak so reopening feels continuous.
  // (Read each field so nested `bind:` mutations retrigger persistence.)
  $effect(() => {
    writePrefs({ source: prefs.source, target: prefs.target, autospeak: prefs.autospeak });
  });

  const resetRunning = () => {
    running = false;
    paused = false;
  };

  const allowMic = () => {
    saveLedger(grantCap(loadLedger(), APP_ID, MIC_CAP));
    micGranted = true;
  };

  async function stopMic(): Promise<void> {
    try {
      procRef?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      srcRef?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await ctxRef?.close();
    } catch {
      /* ignore */
    }
    streamRef?.getTracks().forEach((tr) => tr.stop());
    streamRef = null;
    procRef = null;
    srcRef = null;
    ctxRef = null;
    rec = false;
  }

  async function startCapture(): Promise<void> {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    const stream = await media.getUserMedia({ audio: { channelCount: 1 } });
    streamRef = stream;
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    const ctx = new Ctx();
    ctxRef = ctx;
    const src = ctx.createMediaStreamSource(stream);
    srcRef = src;
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    procRef = proc;
    proc.onaudioprocess = (e) => {
      const chunk = e.inputBuffer.getChannelData(0);
      const id = sid;
      if (id) void interpretAudio(id, frameToInterpChunk(chunk, ctx.sampleRate));
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    rec = true;
  }
  async function beginSession(): Promise<void> {
    if (!online) {
      // Daemon isn't reachable — tell the user instead of a silent no-op.
      status = t("backend.offline");
      return;
    }
    const id = await interpretStart({ source: prefs.source, target: prefs.target });
    if (id == null) return;
    sid = id;
    running = true;
    paused = false;
    status = `${langLabel(prefs.source)} → ${langLabel(prefs.target)}`;
  }

  async function endSession(): Promise<void> {
    const id = sid;
    sid = null;
    if (id && online) await interpretStop(id);
    await stopMic();
    resetRunning();
    status = "";
  }

  async function togglePause(): Promise<void> {
    const id = sid;
    if (!id) return;
    if (paused) {
      await interpretResume(id);
      paused = false;
    } else {
      await interpretPause(id);
      paused = true;
    }
  }

  async function toggleMic(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      status = t("camera.noCamera");
      return;
    }
    if (rec) {
      await stopMic();
      return;
    }
    if (!micGranted) {
      // Two-tap consent: first tap explains, second grants (and records).
      if (!askMic) {
        askMic = true;
        status = t("interp.permNeed");
        return;
      }
      allowMic();
      askMic = false;
      status = "";
    } else {
      askMic = false;
    }
    if (!running) await beginSession();
    if (running) await startCapture();
  }

  // Stream live interpret-output events → partials + final transcript + auto-speak.
  let subscribed = false;
  $effect(() => {
    if (subscribed) return;
    subscribed = true;
    if (!online) return;
    let alive = true;
    const unsubs: (() => void)[] = [];
    void (async () => {
      unsubs.push(
        await subscribe("interpret-output", (payload) => {
          if (!alive) return;
          const kind = (payload as { kind?: string } | null)?.kind;
          if (kind === "partial") {
            partial = partialTextOf(payload);
          } else if (kind === "segment_final") {
            const seg = segOf(payload);
            if (seg) {
              segs = capTail([...segs, seg], SEG_CAP);
              saveSegs(segs);
              if (prefs.autospeak && seg.target) {
                void speakText(seg.target, seg.targetLang || "zh");
              }
            }
            partial = "";
          } else if (kind === "utterance_recognized") {
            const u = payload as { text?: unknown };
            if (u && typeof u.text === "string") partial = u.text;
          } else if (kind === "session_ended") {
            resetRunning();
            void stopMic();
            partial = "";
            status = t("interp.ended");
          } else if (kind === "error") {
            status = "⚠ " + errorOf(payload);
          }
        }),
      );
    })();
    return () => {
      alive = false;
      unsubs.forEach((f) => f());
    };
  });

  async function send(): Promise<void> {
    const v = text.trim();
    if (!v) return;
    if (!online) {
      // Daemon isn't reachable — keep the typed text and explain instead of
      // clearing it into a silent no-op.
      status = t("backend.offline");
      return;
    }
    if (!running) await beginSession();
    const id = sid;
    if (id) {
      text = "";
      await interpretText(id, v);
    }
  }

  const speakLast = (seg: InterpSeg) => {
    if (seg.target) void speakText(seg.target, seg.targetLang || "zh");
  };

  const copyTarget = (seg: InterpSeg) => {
    try {
      void navigator.clipboard?.writeText(seg.target);
    } catch {
      /* ignore */
    }
  };

  const clearHistory = () => {
    segs = [];
    clearSegs();
  };

  async function copyAll(): Promise<void> {
    const t2 = transcriptText(segs, bilingual);
    if (!t2) return;
    try {
      await navigator.clipboard?.writeText(t2);
      copiedAll = true;
      window.setTimeout(() => {
        copiedAll = false;
      }, 1500);
    } catch {
      /* clipboard unavailable: no-op */
    }
  }

  // Reusable pill/button class helpers.
  const chipCls = (active: boolean) =>
    "px-3 py-1 text-xs rounded-full transition " +
    (active ? "bg-accent text-white" : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200");
  const btnCls = (kind: "neutral" | "accent" | "danger", size: "sm" | "md" = "sm") => {
    const pad = size === "sm" ? "px-3 py-1 text-xs" : "px-3 py-1 text-sm";
    const tone =
      kind === "accent"
        ? "bg-accent text-white"
        : kind === "danger"
          ? "bg-danger text-white"
          : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100";
    return `${pad} rounded-full ${tone} transition active:scale-95 disabled:opacity-40`;
  };
</script>

<div class="flex h-full flex-col p-3">
  {#if !online}
    <p class="mb-2 text-sm opacity-70">{t("backend.inBrowser")}</p>
  {/if}

  <!-- language pair (remembered) -->
  <div class="flex items-center gap-2 text-sm">
    <span class="opacity-60">{t("interp.source")}</span>
    <select
      aria-label={t("interp.source")}
      value={prefs.source}
      onchange={(e) => {
        prefs = { ...prefs, source: (e.currentTarget as HTMLSelectElement).value };
      }}
      class="flex-1 rounded-full bg-neutral-200 px-2 py-1 text-sm outline-none dark:bg-neutral-800"
    >
      {#each LANGS as l (l.code)}
        <option value={l.code}>{l.code === "auto" ? t("interp.auto") : l.native}</option>
      {/each}
    </select>
    <span class="opacity-50">→</span>
    <select
      aria-label={t("interp.target")}
      value={prefs.target}
      onchange={(e) => {
        prefs = { ...prefs, target: (e.currentTarget as HTMLSelectElement).value };
      }}
      class="flex-1 rounded-full bg-neutral-200 px-2 py-1 text-sm outline-none dark:bg-neutral-800"
    >
      {#each LANGS.filter((l) => l.code !== "auto") as l (l.code)}
        <option value={l.code}>{l.native}</option>
      {/each}
    </select>
  </div>

  <!-- session controls -->
  <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
    <span class="text-3xl">🌐</span>
    {#if running}
      <button onclick={() => void endSession()} class={btnCls("danger", "sm")}>
        {t("interp.stop")}
      </button>
      <button onclick={() => void togglePause()} class={btnCls("neutral", "sm")}>
        {paused ? t("interp.resume") : t("interp.pause")}
      </button>
      <button onclick={() => void toggleMic()} title="mic" class={chipCls(rec)}>
        {rec ? "●" : "🎤"}
      </button>
    {:else}
      <button onclick={() => void beginSession()} class={btnCls("accent", "sm")}>
        {t("interp.start")}
      </button>
    {/if}
    {#if status}<span class="truncate text-xs opacity-60">{status}</span>{/if}
  </div>

  <!-- auto-speak read-aloud toggle -->
  <label class="mt-1 flex items-center gap-2 text-xs opacity-80">
    <input type="checkbox" bind:checked={prefs.autospeak} />
    {t("interp.autospeak")}
  </label>

  <!-- transcript header + clear -->
  <div class="mt-2 flex items-center justify-between text-xs opacity-60">
    <span>{t("interp.transcript")}</span>
    <div class="flex items-center gap-1">
      <button
        onclick={() => (bilingual = !bilingual)}
        aria-pressed={bilingual}
        class={"rounded-full px-2 py-0.5 text-[11px] " +
          (bilingual ? "bg-accent text-white" : "bg-neutral-200 dark:bg-neutral-700")}
      >
        {t("interp.bilingual")}
      </button>
      <button
        onclick={() => void copyAll()}
        disabled={segs.length === 0}
        class="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700 disabled:opacity-40"
      >
        {copiedAll ? "✓" : t("interp.copyAll")}
      </button>
      <button
        onclick={clearHistory}
        class="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
      >
        {t("interp.clear")}
      </button>
    </div>
  </div>
  <div
    role="log"
    aria-live="polite"
    class="mt-1 min-h-[80px] flex-1 space-y-2 overflow-auto rounded-2xl bg-neutral-200/40 p-2 text-sm dark:bg-neutral-800/40"
  >
    {#if segs.length === 0 && !partial}
      <p class="py-8 text-center text-xs opacity-40">{running ? t("interp.notRunning") : "—"}</p>
    {:else}
      {#each segs as seg, i (i)}
        <div class="rounded-xl bg-neutral-200/60 p-2 dark:bg-neutral-800/60">
          <div class="flex items-center gap-1 text-[10px] opacity-50">
            <span>{seg.srcLang ? langLabel(seg.srcLang) : "源"}</span>
            <span class="truncate">{seg.src}</span>
          </div>
          <div class="text-sm font-medium text-accent">{seg.target}</div>
          <div class="mt-1 flex gap-1">
            <button
              onclick={() => speakLast(seg)}
              class="rounded-full bg-neutral-300 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
            >
              {t("interp.read")}
            </button>
            <button
              onclick={() => copyTarget(seg)}
              title={t("interp.copied")}
              class="rounded-full bg-neutral-300 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
            >
              ⧉
            </button>
          </div>
        </div>
      {/each}
      {#if partial}
        <div class="rounded-xl bg-accent/10 p-2 text-sm italic opacity-80">… {partial}</div>
      {/if}
    {/if}
  </div>

  <!-- text-input translate -->
  <div class="mt-2 flex gap-2">
    <input
      bind:value={text}
      onkeydown={(e) => {
        if ((e as KeyboardEvent).key === "Enter") void send();
      }}
      placeholder={t("interp.placeholder")}
      class="flex-1 rounded-full bg-neutral-200 px-3 py-2 text-sm outline-none dark:bg-neutral-800"
    />
    <button
      onclick={() => void send()}
      class="rounded-full bg-accent px-4 text-sm text-white"
    >
      {t("interp.send")}
    </button>
  </div>
</div>

