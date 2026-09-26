<script lang="ts">
  // InterpApp.svelte — Svelte 5 (runes) single-source implementation of the
  // interpreter screen. All pure logic reuses lib/interp.ts
  // (language catalog + remembered prefs + persisted transcript in the shared
  // store) and lib/backend.ts RPC. Outside Tauri (no bridge) every call degrades
  // to null so the offline shell renders a localized banner and never crashes;
  // live mic capture + daemon streaming need a real device + amos-interp daemon.
  import { bridged, bridgeDiag, subscribe, interpretStart, interpretStop, interpretPause, interpretResume, interpretAudio, interpretText, interpretEndOfSpeech } from "../lib/backend";
  import { frameToInterpChunk } from "../lib/audio";
  import { speakText, resetPlayCtx } from "../lib/realtimeTts";
  import { capTail } from "../lib/bounded";
  import { copyTextToClipboard } from "../lib/clipboard";
  import StoreErrorBar from "./StoreErrorBar.svelte";
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
  import { loadLedger, capSet, type Capability } from "../lib/permissions";
  import { grantCapability } from "./osPermissions";
  import { t } from "./locale.svelte";
  import { amosWarn } from "../lib/debugLog";
  import { onDestroy } from "svelte";

  const APP_ID = "interpreter";
  const MIC_CAP: Capability = "microphone";
  const SEG_CAP = 200; // interpreter transcript segments kept in memory

  // Read-aloud plays through one shared AudioContext (lib/realtimeTts). Leaving
  // the screen must release it: a stopped-but-open context keeps the audio session
  // held, so the next spoken segment would inherit a session from a screen the
  // user had left. `playPcm` recreates it lazily on the next final segment.
  onDestroy(() => resetPlayCtx());

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
  // The store refused a write (full/unavailable): the history must not claim it was saved.
  let storeErr = $state("");
  /**
   * …and the same for the remembered prefs, in its **own** slot: the prefs effect runs on mount and
   * on every language/auto-speak change, so sharing `storeErr` would let a landed prefs write blank
   * a transcript refusal that is still true (the transcript is still unsaved). Rendered as
   * `storeErr || prefsErr` — one sentence, never two lines. REQ-A1420.
   */
  let prefsErr = $state("");
  let partial = $state("");
  let text = $state("");
  let status = $state("");
  /**
   * The **daemon's** own session state (`amos_int::SessionState`, delivered as `state_changed`).
   *
   * The screen used to track only its own actions (start / stop / pause), so while the daemon was
   * translating it could still be showing the language pair, and nothing said what the engine was
   * actually doing — even though the daemon emits this on every transition (REQ-A470). It is the
   * daemon's word, not a guess: the label is looked up from the token it sends.
   *
   * `ended` / `error` clear it instead of rendering a chip, because the status line already carries
   * those two (with the daemon's own error text) — one fact, one place.
   */
  let daemonState = $state("");
  /**
   * The two states the status line already carries: the daemon sends them as `state_changed`
   * **and** as the `session_ended` / `error` events, and the second pair has the daemon's own words
   * (`⚠ …`). Rendering them here too would put one fact in two places (REQ-A470).
   */
  const STATUS_OWNED_STATES = new Set(["ended", "error"]);
  let copiedAll = $state(false);
  let bilingual = $state(false);

  // Live-capture plumbing (kept in plain refs so callbacks stay stable).
  /** The live session id — a **number** (the daemon answers `u64`); see
   *  `lib/backend.ts` / scripts/tauri-reply-scan.mjs. */
  let sid: number | null = null;
  let ctxRef: AudioContext | null = null;
  let srcRef: MediaStreamAudioSourceNode | null = null;
  let procRef: ScriptProcessorNode | null = null;
  let streamRef: MediaStream | null = null;

  const langLabel = (code: string): string =>
    code === "auto" ? t("interp.auto") : langNative(code) || code;

  // Map a `bridgeDiag(cmd).code` (`amos.interpret.*`) onto a localized sentence.
  // REQ-A461: the typed codes are the wire contract; the i18n mirror is the user
  // contract. Falling back to `fallback` keeps the older "did not reach the daemon"
  // wording when the host never produced a code (e.g. `not-bridged`, a non-Tauri
  // run), so a screen that has always read that sentence doesn't lose it on
  // refactors of the i18n table.
  const statusForInterpError = (cmd: string, fallback: string): string => {
    const diag = bridgeDiag(cmd);
    if (diag.ok || diag.kind !== "command-failed") return fallback;
    switch (diag.code) {
      case "amos.interpret.no_active":
        return t("interp.err.noActive");
      case "amos.interpret.session_id_mismatch":
        return t("interp.err.sessionIdMismatch");
      case "amos.interpret.text_too_long":
        return t("interp.err.textTooLong");
      case "amos.interpret.audio_too_large":
        return t("interp.err.audioTooLarge");
      case "amos.interpret.session_failed":
        return t("interp.err.sessionFailed");
      case "amos.interpret.channel_failed":
        return t("interp.err.channelFailed");
      default:
        return fallback;
    }
  };

  // Remember the language pair + auto-speak so reopening feels continuous.
  // (Read each field so nested `bind:` mutations retrigger persistence.)
  //
  // The prefs are the user's own choice (picked from the selects / toggled), so the write's verdict
  // is read exactly as the transcript's is: the controls must not show a choice the store refused —
  // a reload would then reopen on the defaults. REQ-A1420.
  $effect(() => {
    prefsErr = writePrefs({ source: prefs.source, target: prefs.target, autospeak: prefs.autospeak })
      ? ""
      : t("common.storeWriteFailed");
  });

  const resetRunning = () => {
    running = false;
    paused = false;
  };

  // `micGranted` is seeded from the persisted ledger (`capSet(loadLedger(), …)`), so it is a
  // *display of* `amos.permissions` — the ledger every OS capability gate reads back. The
  // two-tap answer must adopt the write's own verdict, not the intent: on a refused write
  // `grantCapability` answers the ledger the store still holds, and the adopted value decides
  // whether the session may open. Returns whether the mic is now granted, so the caller neither
  // records a session it may not open nor clears the prompt for a request that was not satisfied.
  const allowMic = (): boolean => {
    const res = grantCapability(APP_ID, MIC_CAP);
    micGranted = capSet(res.ledger, APP_ID, MIC_CAP);
    if (!micGranted) {
      status = t("common.storeWriteFailed");
      return false;
    }
    return true;
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

  /**
   * Open the microphone and start streaming frames to the daemon.
   *
   * `getUserMedia` **rejects** when the platform refuses (permission denied, no capture device),
   * and this call site is `onclick={() => void toggleMic()}` — the promise is discarded, so before
   * this the rejection reached nobody: the session `beginSession` had already opened stayed live,
   * `rec` stayed false, and the screen said nothing. A session that can never transcribe read
   * exactly like a quiet one. The repo's other `getUserMedia` (`CameraApp.acquire`) catches,
   * discriminates `NotAllowedError`, sets a hint and logs; `toggleMic` above already answers
   * `camera.noCamera` for a missing capture API — the same rule applies here (REQ-A1702 / F-SH-872).
   */
  async function startCapture(): Promise<void> {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({ audio: { channelCount: 1 } });
    } catch (err) {
      // Permission denial is the one cause the platform names; anything else (no device, a
      // backend the WebView has none of) gets the cause-neutral sentence — the same split
      // `CameraApp.acquire` makes for `camera.denied` vs `camera.noCamera`.
      const name = (err as { name?: unknown } | null)?.name;
      status =
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? t("interp.micDenied")
          : t("interp.micFailed");
      amosWarn("interp", "getUserMedia failed", { name: String(name ?? "") });
      return;
    }
    streamRef = stream;
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) {
      stream.getTracks().forEach((tr) => tr.stop());
      status = t("interp.micFailed");
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
    // `interpret_start` answers `Result<u64>`, so `null` here is a **refusal** (the `u64` is a
    // real session id, never null) — the host declined to open a session. This used to `return`
    // bare: the tap moved nothing (`running` stayed false, so `startCapture` never ran) and said
    // nothing, with `status` cleared one line up. Its three siblings below (`interpret_pause` /
    // `interpret_resume` / `interpret_stop`) each name their refusal through the same helper, and
    // `interpret_text` does too — this was the one command whose silence was left in (REQ-A1651 /
    // F-SH-841). The typed-text path (`send`) reaches this same branch, so one sentence covers both.
    if (id == null) {
      status = statusForInterpError("interpret_start", t("interp.startFailed"));
      return;
    }
    sid = id;
    running = true;
    paused = false;
    status = `${langLabel(prefs.source)} → ${langLabel(prefs.target)}`;
  }

  async function endSession(): Promise<void> {
    const id = sid;
    // End on the host first. `interpret_stop` returns `()`, so the host's `Ok(())` reaches the
    // bridge as the same `null` a refusal does (REQ-A297) and only the ledger can tell them
    // apart. Clearing `sid`/`running` on a refusal would claim an end that never happened — and
    // leave the daemon session running with no handle left to stop it.
    if (id && online) {
      await interpretStop(id);
      if (!bridgeDiag("interpret_stop").ok) {
        status = statusForInterpError(
          "interpret_stop",
          t("interp.stopFailed"),
        );
        return;
      }
    }
    sid = null;
    await stopMic();
    resetRunning();
    status = "";
  }

  async function togglePause(): Promise<void> {
    const id = sid;
    if (!id) return;
    const resuming = paused;
    // Same unit-return: only the ledger says whether the host took the pause/resume. Flipping
    // `paused` on a refusal relabels the button (it would read "Resume" while the daemon keeps
    // translating) — a state the screen never actually entered.
    await (resuming ? interpretResume(id) : interpretPause(id));
    if (online && !bridgeDiag(resuming ? "interpret_resume" : "interpret_pause").ok) {
      status = statusForInterpError(
        resuming ? "interpret_resume" : "interpret_pause",
        t(resuming ? "interp.resumeFailed" : "interp.pauseFailed"),
      );
      return;
    }
    paused = !resuming;
  }

  /**
   * Force the in-flight utterance to translate now (`interpret_end_of_speech`), rather than
   * waiting for the VAD's silence. `partial` is the screen's only honest signal that a sentence
   * is in flight: the daemon sets it on a `partial` event and clears it on `segment_final`, so
   * an empty `partial` means the daemon would be told to end nothing. In that case we say so
   * (`interp.endNone`) instead of firing a command whose only effect is a no-op.
   *
   * The command returns `()`, so `invoke` gives `null` for both success and failure — the
   * outcome is read from `bridgeDiag`, which distinguishes them (same as `PhoneApp`).
   */
  async function endUtterance(): Promise<void> {
    const id = sid;
    if (!id) return;
    if (!partial) {
      status = t("interp.endNone");
      return;
    }
    await interpretEndOfSpeech(id);
    if (online && !bridgeDiag("interpret_end_of_speech").ok) {
      status = statusForInterpError(
        "interpret_end_of_speech",
        t("interp.endFailed"),
      );
      return;
    }
    status = "";
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
      // A refused ledger write must not open a capture session: keep the two-tap prompt up
      // (`allowMic` set the refusal sentence in `status`), so the next tap retries.
      if (!allowMic()) return;
      askMic = false;
      status = "";
    } else {
      askMic = false;
    }
    if (!running) await beginSession();
    if (running) await startCapture();
  }

  // Stream live interpret-output events → partials + final transcript + auto-speak.
  //
  // REQ-A838 made `subscribe` answer `null` when the host did **not** establish the channel,
  // so a caller can tell a live channel from a dead one. For this screen that verdict is
  // load-bearing in both directions, and the subscription below reads neither half on its own:
  //
  //  * a **refused** listen is not "one answer missing" — no `interpret-output` event will
  //    ever arrive, so a session that starts still looks live (mic on, language pair, state
  //    chip) while the transcript can never fill. That is byte-identical to a quiet channel,
  //    which is exactly what REQ-A838 set out to end. `streamErr` is the sentence that
  //    separates them (the sibling `RobotApp` renders its refused stream as `beatStream =
  //    "refused"`).
  //  * a handle that lands **after** teardown would be pushed onto an already-drained list and
  //    never called, leaving the subscription alive for the window's life — `RobotApp` releases
  //    it with `if (destroyed) { un(); return; }`.
  //
  // REQ-A1614 ∕ F-SH-823.
  let subscribed = false;
  let streamErr = $state("");
  $effect(() => {
    if (subscribed) return;
    subscribed = true;
    if (!online) return;
    let alive = true;
    const unsubs: ((() => void) | null)[] = [];
    void (async () => {
      const unsub = await subscribe("interpret-output", (payload) => {
        if (!alive) return;
        const kind = (payload as { kind?: string } | null)?.kind;
        if (kind === "partial") {
          partial = partialTextOf(payload);
        } else if (kind === "segment_final") {
          const seg = segOf(payload);
          if (seg) {
            segs = capTail([...segs, seg], SEG_CAP);
            // The transcript is an auto-captured log: the *session* view may keep
            // showing what was interpreted, but the history must not pretend it was
            // stored when the write was rejected.
            if (!saveSegs(segs)) storeErr = t("common.storeWriteFailed");
            else storeErr = "";
            if (prefs.autospeak && seg.target) {
              // The user turned auto-read-aloud on; a synthesis that produced no audio must
              // not leave them waiting for a voice that never comes (REQ-A1444).
              void speakText(seg.target, seg.targetLang || "zh").then(reportSpeak);
            }
          }
          partial = "";
        } else if (kind === "utterance_recognized") {
          const u = payload as { text?: unknown };
          if (u && typeof u.text === "string") partial = u.text;
        } else if (kind === "state_changed") {
          // The daemon's own lifecycle. `state` is `format!("{s:?}").to_lowercase()` of
          // `amos_int::SessionState`, so the token is the state's name (REQ-A470). The two states
          // the status line owns are dropped here rather than shown twice.
          const s = (payload as { state?: unknown }).state;
          daemonState =
            typeof s === "string" && !STATUS_OWNED_STATES.has(s) ? s : "";
        } else if (kind === "session_ended") {
          resetRunning();
          void stopMic();
          partial = "";
          daemonState = "";
          status = t("interp.ended");
        } else if (kind === "error") {
          daemonState = "";
          status = "⚠ " + errorOf(payload);
        }
      });
      if (!alive) {
        // Teardown ran while the listen was in flight: nothing will read this handle again, so
        // release it here instead of leaking the subscription (`RobotApp` does the same).
        unsub?.();
        return;
      }
      unsubs.push(unsub);
      // `null` = the host refused the registration (`online` already excluded "no bridge at
      // all"), so no event will ever arrive — say it, don't let a deaf session read as a quiet one.
      streamErr = unsub === null ? t("interp.outputRefused") : "";
    })();
    return () => {
      alive = false;
      unsubs.forEach((f) => f?.());
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
    if (!id) return;
    // `interpret_text` returns `()`, so success and refusal both arrive as `null`; read the
    // ledger. Clearing the box before the host accepted would silently drop what the user typed
    // — the very "silent no-op" the offline branch above exists to avoid.
    await interpretText(id, v);
    if (online && !bridgeDiag("interpret_text").ok) {
      status = statusForInterpError("interpret_text", t("interp.sendFailed"));
      return;
    }
    text = "";
  }

  // REQ-A1444 — the read-aloud reports whether audio was actually produced. Both sites below
  // used to drop `speakText`'s answer (`void speakText(…)`), so pressing 朗读 and hearing
  // nothing — the engine refused, or this machine cannot play what it returned — was a wholly
  // silent no-op: no sound, no sentence, no state change. The 复制 button on the *same row*
  // (`copyTarget`) reads its verdict and says so, which is what makes the silence a defect
  // rather than a style. Its own slot, not folded into `copyErr`: the two buttons are
  // independent gestures, and a successful copy must not blank the read-aloud's refusal.
  let speakErr = $state("");
  const reportSpeak = (produced: boolean) => {
    speakErr = produced ? "" : t("common.speakFailed");
  };
  const speak = (seg: InterpSeg) => {
    if (!seg.target) return;
    void speakText(seg.target, seg.targetLang || "zh").then(reportSpeak);
  };

  // REQ-A1271 — the copy reports whether it landed. Both sites here used the optional call
  // directly (`await navigator.clipboard?.writeText(x)`), which short-circuits to `undefined`
  // when the API is absent: no throw, so the `try/catch` never fired and `copyAll` set 「✓」
  // over an empty clipboard. `copyTextToClipboard` asks the API's presence first (the guard
  // `PhotosApp::copyText` installs), and a `false` gets the shared failure line.
  let copyErr = $state("");
  const copyTarget = (seg: InterpSeg) => {
    void copyTextToClipboard(seg.target).then((copied) => {
      copyErr = copied ? "" : t("common.copyFailed");
    });
  };

  const clearHistory = () => {
    // A rejected clear keeps the list: the stored transcript would come back on reload.
    if (!clearSegs()) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    segs = [];
  };

  async function copyAll(): Promise<void> {
    const t2 = transcriptText(segs, bilingual);
    if (!t2) return;
    if (!(await copyTextToClipboard(t2))) {
      copyErr = t("common.copyFailed");
      return;
    }
    copyErr = "";
    copiedAll = true;
    window.setTimeout(() => {
      copiedAll = false;
    }, 1500);
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
  <StoreErrorBar message={storeErr || prefsErr} />
  {#if copyErr}
    <p
      role="status"
      data-testid="interp-copy-error"
      class="mb-2 shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-danger dark:bg-white/10"
    >{copyErr}</p>
  {/if}
  {#if speakErr}
    <!-- The sentence states only what is established (nothing was played). *Why* is a
         disjunction — the engine did not answer, or this machine cannot play audio — so it
         goes in `title` rather than being asserted as one cause (F-SH-677 的形状). -->
    <p
      role="status"
      data-testid="interp-speak-error"
      title={t("common.speakFailedWhy")}
      class="mb-2 shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-danger dark:bg-white/10"
    >{speakErr}</p>
  {/if}
  {#if streamErr}
    <!-- The result channel was never opened: a running session on this screen cannot produce
         a single line, and without this sentence that is indistinguishable from silence. -->
    <p
      role="status"
      data-testid="interp-stream-error"
      class="mb-2 shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-danger dark:bg-white/10"
    >{streamErr}</p>
  {/if}
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
      <button onclick={() => void toggleMic()} title={t("a11y.mic")} class={chipCls(rec)}>
        {rec ? "●" : "🎤"}
      </button>
      <button
        onclick={() => void endUtterance()}
        title={t("interp.endHint")}
        data-testid="interp-end-sentence"
        class={btnCls("neutral", "sm")}
      >
        {t("interp.endSentence")}
      </button>
    {:else}
      <button onclick={() => void beginSession()} class={btnCls("accent", "sm")}>
        {t("interp.start")}
      </button>
    {/if}
    {#if status}<span class="truncate text-xs opacity-60">{status}</span>{/if}
    {#if daemonState}
      <span
        data-testid="interp-state"
        class="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-600 dark:text-sky-300"
      >
        {t(`interp.state.${daemonState}`)}
      </span>
    {/if}
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
      <!-- The empty-transcript hint is the *not-running* advice ("start a session to speak or
           type"), so it belongs to the idle state — showing it while `running` told the user to
           start a session the screen had already started (it was rendering its own key's
           negation). While a session is live the interval before the first segment is simply
           "nothing yet": the state chip carries 正在识别, so the pane stays neutral. REQ-A1812. -->
      <p class="py-8 text-center text-xs opacity-40">{!running ? t("interp.notRunning") : "—"}</p>
    {:else}
      {#each segs as seg, i (i)}
        <div class="rounded-xl bg-neutral-200/60 p-2 dark:bg-neutral-800/60">
          <div class="flex items-center gap-1 text-[10px] opacity-50">
            <span>{seg.srcLang ? langLabel(seg.srcLang) : t("interp.srcUnknown")}</span>
            <span class="truncate">{seg.src}</span>
          </div>
          <div class="text-sm font-medium text-accent">{seg.target}</div>
          <div class="mt-1 flex gap-1">
            <button
              onclick={() => speak(seg)}
              class="rounded-full bg-neutral-300 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
            >
              {t("interp.read")}
            </button>
            <button
              onclick={() => copyTarget(seg)}
              title={t("interp.copy")}
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

