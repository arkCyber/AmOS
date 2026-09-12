<script lang="ts">
  // PlayerApp.svelte — Svelte 5 (runes) **local media player**: plays real local
  // audio + video through one playlist. All classification / queue / transport
  // math is pure and lives in lib/player.ts (unit-tested once); this screen owns
  // the DOM: it resolves the active track to an object URL (bridge `media_load`,
  // voice-memo WAV synthesis / media store, or a camera-capture blob) and drives
  // a single <audio>/<video> element. No bridge / empty library → an honest
  // empty state (and a synthesized demo playlist so the screen stays usable).
  import { untrack } from "svelte";
  import { readStoreValue } from "../lib/amosStore";
  import { defaultMediaStore } from "../lib/mediaStore";
  import { VMEMOS_KEY, buildWavBytes, normalizeVoiceMemos } from "../lib/voiceMemos";
  import { captureBlob, listCaptures } from "../lib/cameraCapture";
  import { hasMediaBridge, mediaList, mediaLoad } from "../lib/media";
  import type { MediaItem, StandardDir } from "../lib/media";
  import {
    buildOrder,
    currentTrackIndex,
    cyclePlaybackRate,
    demoTracks,
    fmtSeconds,
    formatRate,
    indexOfTrackId,
    isTooLarge,
    mergeTracks,
    mimeForPlayable,
    pctProgress,
    posOfTrack,
    resumePosition,
    seekSeconds,
    skipMode,
    stepOrderPos,
    trackFromCapture,
    trackFromItem,
    trackFromMemo,
  } from "../lib/player";
  import type { PlayerTrack, RepeatMode } from "../lib/player";
  import { applyMediaSession, clearMediaSession, defaultMediaSession } from "../lib/mediaSession";
  import { assertHold, releaseHold, videoHoldActive } from "../lib/keepAwakeCore";
  import { loadPlayerPrefs, savePlayerPrefs, shouldSavePosition } from "../lib/playerPrefs";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";

  // Local collections that can hold playable media. `camera` is included so
  // DCIM/Camera videos (the default device camera roll) are found — photos there
  // are filtered out by extension/MIME, never queued. `root` is intentionally
  // excluded (a full-device walk would be unbounded); `download` is included
  // because users routinely drop music/video there.
  const COLLECTIONS: readonly StandardDir[] = ["music", "movies", "camera", "recordings", "download"];

  let tracks = $state<PlayerTrack[]>([]);
  let scanning = $state(true);
  let loading = $state(false);
  let mediaErr = $state("");
  let scanErr = $state("");

  let order = $state<number[]>([]);
  let pos = $state(0);
  let playing = $state(false);
  let shuffle = $state(false);
  let repeat = $state<RepeatMode>("all");

  let posSec = $state(0);
  let durSec = $state(0);
  let url = $state("");
  let mediaEl = $state<HTMLMediaElement | null>(null);
  let volume = $state(1);
  let muted = $state(false);
  let rate = $state(1);
  /** A saved playhead to apply once the MATCHING track's duration is known. */
  let pendingResume = $state<{ id: string; sec: number } | null>(null);
  /** Bumped to force a re-resolve after a failed load (retry). */
  let retryNonce = $state(0);
  /** False until the first scan has restored the persisted session. */
  let ready = $state(false);
  /** Non-reactive: epoch ms of the last playhead persist (throttle). */
  let lastSaveAt = 0;

  const idx = $derived(currentTrackIndex(order, pos));
  const track = $derived(tracks[idx] ?? null);
  // A rescan replaces the `track` object (same id) — the resolver keys on this
  // derived id so keeping the same track does NOT reload/restart it. Svelte 5
  // derived only propagates when the value actually changes (string `===`).
  const trackId = $derived(track?.id ?? null);
  const pct = $derived(pctProgress(posSec, durSec));

  const originKey = (o: string) => `player.origin.${o}`;

  /** Synthesize a demo/seed WAV clip as a playable object URL. */
  function wavUrl(seconds: number, toneHz: number): string {
    const bytes = buildWavBytes({ seconds, sampleRate: 8000, toneHz, amplitude: 0.3 });
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  }

  /** Resolve one track to a playable object URL (or an honest error message). */
  async function resolve(tr: PlayerTrack): Promise<{ url: string; error: string }> {
    const fail = (error: string) => ({ url: "", error });
    try {
      const src = tr.source;
      if (src.kind === "file") {
        if (isTooLarge(src.item.size_bytes)) return fail(t("player.tooLarge"));
        const bytes = await mediaLoad(src.item);
        if (!bytes) return fail(t("player.unavailable"));
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        // Tag the blob with the FULL file name (the display title drops the
        // extension, so using it here would lose the type for files whose
        // backend reports no specific MIME → a useless octet-stream blob).
        return { url: URL.createObjectURL(new Blob([buf], { type: mimeForPlayable(src.item.name, src.item.mime) })), error: "" };
      }
      if (src.kind === "memo") {
        if (src.memo.audio.kind === "seed") return { url: wavUrl(src.memo.audio.seconds, src.memo.audio.toneHz), error: "" };
        const blob = await defaultMediaStore().get(src.memo.id);
        return blob ? { url: URL.createObjectURL(blob), error: "" } : fail(t("player.unavailable"));
      }
      if (src.kind === "capture") {
        const blob = await captureBlob(src.capture.id);
        return blob ? { url: URL.createObjectURL(blob), error: "" } : fail(t("player.unavailable"));
      }
      return { url: wavUrl(src.seconds, src.toneHz), error: "" };
    } catch {
      // Any bridge / store / blob failure is surfaced honestly as "unavailable"
      // rather than silently rendering an unplayable element.
      return fail(t("player.unavailable"));
    }
  }

  /** Play, ignoring the (already surfaced via onerror) autoplay refusal. */
  function playEl(el: HTMLMediaElement | null): void {
    if (!el) return;
    try {
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          /* refusal is surfaced by the element's error event / UI, not swallowed silently */
        });
      }
    } catch {
      // A headless/locked-down DOM may reject play() synchronously; the UI state
      // still reflects the user's intent and any real failure arrives via onerror.
    }
  }

  /** Pause without letting a headless-DOM throw escape the render effect. */
  function pauseEl(el: HTMLMediaElement | null): void {
    if (!el) return;
    try {
      el.pause();
    } catch {
      /* nothing to pause / unsupported in this DOM */
    }
  }

  /** Seek, tolerating a DOM that refuses/defers currentTime writes. */
  function setTime(el: HTMLMediaElement | null, sec: number): void {
    if (!el) return;
    try {
      el.currentTime = sec;
    } catch {
      /* not seekable yet (no metadata) — duration/seek UI stays guarded */
    }
  }

  // ---- scan the local library (once at mount, again on refresh) ----
  // A generation token makes a superseded scan harmless: if the user hits
  // refresh twice, the earlier (slower) scan can never overwrite the newer one.
  let scanSeq = 0;
  async function scan(keepId: string | null, keepSec = 0): Promise<void> {
    const seq = ++scanSeq;
    scanning = true;
    scanErr = "";
    const groups: PlayerTrack[][] = [];
    let unavailable = false;
    if (hasMediaBridge()) {
      const settled = await Promise.allSettled(COLLECTIONS.map((c) => mediaList(c)));
      const items: MediaItem[] = [];
      for (const r of settled) {
        // A fulfilled array is a real listing; a rejection OR a null (bridge
        // vanished mid-scan) means the collection could not be read — never
        // mistake "could not read" for "empty".
        if (r.status === "fulfilled" && Array.isArray(r.value)) items.push(...r.value);
        else unavailable = true;
      }
      groups.push(items.map(trackFromItem).filter((x): x is PlayerTrack => x !== null));
    }
    groups.push(normalizeVoiceMemos(readStoreValue<unknown>(VMEMOS_KEY, [])).map(trackFromMemo));
    groups.push(listCaptures().map(trackFromCapture));
    if (seq !== scanSeq) return; // superseded by a newer scan
    const merged = mergeTracks(...groups);
    // An unreadable bridge must NOT be masked by the demo fallback — only a
    // truly empty library (or no bridge at all) falls back to demo clips.
    tracks = merged.length > 0 ? merged : unavailable ? [] : demoTracks();
    if (merged.length === 0 && unavailable) scanErr = t("player.unavailable");
    order = buildOrder(tracks.length, shuffle);
    // Keep the same track playing across a refresh when it still exists.
    const keep = indexOfTrackId(tracks, keepId);
    pos = keep >= 0 ? Math.max(0, posOfTrack(order, keep)) : 0;
    // Resume the saved playhead, but ONLY for the track it was saved for — a
    // later skip to a different track must start at 0, not at this timestamp.
    const keptId = keep >= 0 ? tracks[keep]?.id ?? null : null;
    pendingResume = keptId !== null && keepSec > 0 ? { id: keptId, sec: keepSec } : null;
    scanning = false;
    ready = true;
  }

  /** Persist the session; `force` bypasses the playhead throttle. */
  function persist(nowMs: number, force: boolean): void {
    if (!force && !shouldSavePosition(lastSaveAt, nowMs)) return;
    lastSaveAt = nowMs;
    savePlayerPrefs({ trackId, positionSec: posSec, volume, muted, repeat, shuffle });
  }

  // Restore the persisted session, then scan (resuming the last track).
  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    const prefs = loadPlayerPrefs();
    volume = prefs.volume;
    muted = prefs.muted;
    repeat = prefs.repeat;
    shuffle = prefs.shuffle;
    void scan(prefs.trackId, prefs.positionSec);
    return () => persist(Date.now(), true);
  });

  // Persist discrete preference changes (volume/mute/repeat/shuffle/track) at
  // once; the playhead is persisted coarsely from `onTimeUpdate` instead.
  $effect(() => {
    void trackId;
    void volume;
    void muted;
    void repeat;
    void shuffle;
    if (!ready) return;
    persist(Date.now(), true);
  });

  /** Manual rescan (picks up media added while the player is open). */
  function refresh(): void {
    void scan(track?.id ?? null);
  }

  // ---- resolve the active track to a URL (revokes the previous one) ----
  $effect(() => {
    // Key on the track ID, not the object: a rescan replaces the track objects
    // (new array) while keeping the same id, and that must NOT reload/restart
    // the active track. `untrack` reads the current object without tracking it.
    const id = trackId;
    void retryNonce; // explicit dependency: a retry forces a fresh resolve
    const tr = untrack(() => track);
    let cancelled = false;
    let made: string | null = null;
    url = "";
    mediaErr = "";
    posSec = 0;
    durSec = 0;
    if (!tr || id === null) {
      loading = false;
      return () => {};
    }
    loading = true;
    void (async () => {
      const r = await resolve(tr);
      if (cancelled) {
        if (r.url) URL.revokeObjectURL(r.url);
        return;
      }
      if (!r.url) {
        mediaErr = r.error;
        loading = false;
        return;
      }
      made = r.url;
      url = r.url;
      loading = false;
    })();
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  });

  // ---- keep the element in sync with play/volume state ----
  $effect(() => {
    const el = mediaEl;
    const u = url;
    if (!el) return;
    if (playing && u) playEl(el);
    else pauseEl(el);
  });
  $effect(() => {
    const el = mediaEl;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
    el.playbackRate = rate;
  });

  // ---- keep-awake: a playing VIDEO holds the screen on (music must not) ----
  // Video must not blank mid-scene; audio deliberately lets the display sleep
  // (docs/display-idle.md §6). The hold is released on pause, track change, or
  // unmount via the effect cleanup.
  $effect(() => {
    if (!videoHoldActive(playing, track?.kind)) {
      releaseHold("video");
      return;
    }
    assertHold("video");
    return () => releaseHold("video");
  });

  // ---- OS media session (lock screen / notification / headset controls) ----
  $effect(() => {
    const session = defaultMediaSession();
    if (!session) return;
    void trackId; // re-publish metadata when the active track changes
    const meta = untrack(() => track);
    applyMediaSession(
      session,
      meta ? { title: meta.title, artist: meta.subtitle } : null,
      playing && url !== "",
      {
        play: () => {
          if (track) playing = true;
        },
        pause: () => {
          playing = false;
        },
        previoustrack: () => skip(-1),
        nexttrack: () => skip(1),
        seekto: (details) => {
          if (typeof details.seekTime === "number") setTime(mediaEl, details.seekTime);
        },
      },
    );
    return () => clearMediaSession(session);
  });

  // ---- media element callbacks ----
  function onLoadedMetadata() {
    const el = mediaEl;
    durSec = el && Number.isFinite(el.duration) ? el.duration : 0;
    // Apply a restored playhead, but only for the track it was saved for.
    const pr = pendingResume;
    if (el && pr && pr.id === trackId) {
      pendingResume = null; // consume once
      const at = resumePosition(pr.sec, durSec);
      if (at > 0) {
        setTime(el, at);
        posSec = at;
      }
    }
  }
  function onTimeUpdate() {
    if (mediaEl) posSec = mediaEl.currentTime;
    persist(Date.now(), false); // coarse, throttled
  }
  function onEnded() {
    if (repeat === "one") {
      setTime(mediaEl, 0);
      posSec = 0;
      playEl(mediaEl);
      return;
    }
    const r = stepOrderPos(pos, order.length, 1, repeat);
    if (r.stop) {
      // End of the playlist with repeat off: stop AND rewind, otherwise the next
      // "play" would immediately re-fire `ended` again and appear stuck.
      playing = false;
      posSec = 0;
      setTime(mediaEl, 0);
      return;
    }
    pos = r.pos;
  }
  function onMediaError() {
    mediaErr = t("player.playbackError");
    loading = false;
  }

  // ---- transport ----
  function togglePlay(): void {
    if (!track) return;
    if (mediaErr !== "" && url === "") {
      // A previously failed load: retry it rather than toggling a silent no-op.
      retryNonce += 1;
      playing = true;
      return;
    }
    playing = !playing;
  }
  /** Force a fresh resolve of the active track (after an error). */
  function retry(): void {
    retryNonce += 1;
    playing = true;
  }
  /** Advance the playback speed through the preset list. */
  function cycleRate(): void {
    rate = cyclePlaybackRate(rate, 1);
  }
  function skip(delta: number) {
    const r = stepOrderPos(pos, order.length, delta, skipMode(repeat));
    if (r.stop) return;
    pos = r.pos;
  }
  function selectTrack(i: number) {
    const p = posOfTrack(order, i);
    if (p < 0) return;
    if (p === pos) {
      // Clicking the ACTIVE row again restarts the same track from the top.
      // (A silent no-op read as a dead row. Only meaningful once the bytes
      // resolved — an unresolved/failed row keeps its explicit 重试 path.)
      if (url !== "") {
        posSec = 0;
        setTime(mediaEl, 0);
        playing = true;
      }
      return;
    }
    pos = p;
  }
  function cycleRepeat() {
    repeat = repeat === "all" ? "one" : repeat === "one" ? "off" : "all";
  }
  function toggleShuffle() {
    shuffle = !shuffle;
    order = buildOrder(tracks.length, shuffle);
    pos = Math.max(0, posOfTrack(order, idx));
  }
  function seekClick(e: MouseEvent) {
    const el = mediaEl;
    if (!el || durSec <= 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    const sec = seekSeconds(frac, durSec);
    setTime(el, sec);
    posSec = sec;
  }
  function seekKey(e: KeyboardEvent) {
    const el = mediaEl;
    if (!el || durSec <= 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      setTime(el, Math.min(durSec, el.currentTime + 5));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setTime(el, Math.max(0, el.currentTime - 5));
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      togglePlay();
    }
  }
  function toggleMute() {
    muted = !muted;
  }
  function fullscreen() {
    const el = mediaEl;
    if (el && typeof el.requestFullscreen === "function") {
      const p = el.requestFullscreen();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          /* fullscreen can be denied by policy; the UI stays inline */
        });
      }
    }
  }
</script>

{#if scanning && tracks.length === 0}
  <div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
    <span class="text-accent">{@html iconSvg("musicNote", "h-8 w-8")}</span>
    <p class="text-sm text-neutral-500 dark:text-neutral-400">{t("player.scanning")}</p>
  </div>
{:else if !track}
  <div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
    <span class="opacity-70">{@html iconSvg("musicNote", "h-8 w-8")}</span>
    <p class="text-sm font-medium">{scanErr ? scanErr : t("player.empty")}</p>
    {#if !scanErr}<p class="max-w-[240px] text-xs opacity-60">{t("player.emptyHint")}</p>{/if}
  </div>
{:else}
  <div class="flex h-full flex-col overflow-y-auto p-3">
    <div class="relative">
      {#if track.kind === "video"}
        <video
          bind:this={mediaEl}
          src={url || undefined}
          playsinline
          preload="metadata"
          class="h-48 w-full rounded-2xl bg-black object-contain"
          onloadedmetadata={onLoadedMetadata}
          ontimeupdate={onTimeUpdate}
          onended={onEnded}
          onerror={onMediaError}
        ><track kind="captions" /></video>
        <button
          onclick={fullscreen}
          aria-label={t("player.fullscreen")}
          data-icon="maximize"
          class="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/50 text-white transition active:scale-90"
        >{@html iconSvg("maximize", "h-4 w-4")}</button>
      {:else}
        <audio
          bind:this={mediaEl}
          src={url || undefined}
          preload="metadata"
          onloadedmetadata={onLoadedMetadata}
          ontimeupdate={onTimeUpdate}
          onended={onEnded}
          onerror={onMediaError}
        ></audio>
        <div class="grid h-40 place-items-center rounded-2xl bg-gradient-to-br from-accent/25 to-accent/5 text-accent">
          {@html iconSvg("musicNote", "h-14 w-14")}
        </div>
      {/if}
      {#if loading}
        <div class="absolute inset-0 grid place-items-center rounded-2xl bg-black/20 text-xs text-white">…</div>
      {/if}
    </div>

    <div class="mt-3 text-center">
      <p class="truncate text-lg font-semibold">{track.title}</p>
      <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
        <span class="rounded-full bg-neutral-200/70 px-2 py-0.5 dark:bg-white/10">{track.kind === "video" ? t("player.video") : t("player.audio")}</span>
        <span class="ml-1 rounded-full bg-accent/15 px-2 py-0.5 text-accent">{t(originKey(track.origin))}</span>
        {#if track.subtitle}<span class="ml-1.5">{track.subtitle}</span>{/if}
      </p>
    </div>

    {#if mediaErr}
      <div class="mt-2 flex flex-col items-center gap-1.5">
        <p class="text-center text-xs text-danger">{mediaErr}</p>
        <button
          onclick={retry}
          aria-label={t("player.retry")}
          class="rounded-full bg-neutral-200/80 px-3 py-1 text-xs font-medium transition active:scale-95 dark:bg-white/10"
        >{t("player.retry")}</button>
      </div>
    {/if}

    <div class="mt-3 flex items-center justify-between px-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
      <span>{fmtSeconds(posSec)}</span>
      <span>{fmtSeconds(durSec)}</span>
    </div>
    <div
      role="slider"
      aria-label={t("player.seek")}
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabindex={0}
      onclick={seekClick}
      onkeydown={seekKey}
      class="group relative mt-1 h-1.5 cursor-pointer rounded-full bg-neutral-300 dark:bg-white/15"
    >
      <div class="absolute inset-y-0 left-0 rounded-full bg-accent" style:width={`${pct * 100}%`}></div>
      <div
        class="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow ring-1 ring-black/5 transition group-hover:scale-110"
        style:left={`calc(${pct * 100}% - 7px)`}
      ></div>
    </div>

    <div class="mt-4 flex items-center justify-center gap-6">
      <button
        onclick={() => skip(-1)}
        aria-label={t("player.prev")}
        data-icon="skipBack"
        class="grid h-12 w-12 place-items-center rounded-full bg-neutral-300 text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-white"
      >{@html iconSvg("skipBack", "h-6 w-6")}</button>
      <button
        onclick={togglePlay}
        aria-label={playing ? t("player.pause") : t("player.play")}
        data-icon={playing ? "pause" : "play"}
        class="grid h-16 w-16 place-items-center rounded-full bg-accent text-white shadow-[0_8px_20px_rgba(0,122,255,0.35)] transition active:scale-95"
      >{@html iconSvg(playing ? "pause" : "play", "h-8 w-8")}</button>
      <button
        onclick={() => skip(1)}
        aria-label={t("player.next")}
        data-icon="skipForward"
        class="grid h-12 w-12 place-items-center rounded-full bg-neutral-300 text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-white"
      >{@html iconSvg("skipForward", "h-6 w-6")}</button>
    </div>

    <div class="mt-3 flex items-center justify-center gap-7">
      <button
        onclick={toggleShuffle}
        aria-label={t("player.shuffle")}
        data-icon="shuffle"
        class={"grid h-9 w-9 place-items-center rounded-full transition active:scale-90 " + (shuffle ? "text-accent opacity-90" : "opacity-40")}
      >{@html iconSvg("shuffle", "h-5 w-5")}</button>
      <button
        onclick={cycleRepeat}
        aria-label={t("player.repeat")}
        data-icon="repeat"
        class={"grid h-9 w-9 place-items-center rounded-full transition active:scale-90 " + (repeat === "off" ? "opacity-35" : repeat === "one" ? "text-accent opacity-90" : "opacity-80")}
      >{@html iconSvg("repeat", "h-5 w-5")}</button>
      <button
        onclick={toggleMute}
        aria-label={muted ? t("player.unmute") : t("player.mute")}
        data-icon={muted ? "volumeX" : "volume"}
        class="grid h-9 w-9 place-items-center rounded-full opacity-80 transition active:scale-90"
      >{@html iconSvg(muted ? "volumeX" : "volume", "h-5 w-5")}</button>
      <button
        onclick={cycleRate}
        aria-label={t("player.rate")}
        data-icon="rate"
        class="grid h-9 min-w-9 place-items-center rounded-full px-2 text-xs font-semibold opacity-80 transition active:scale-90"
      >{formatRate(rate)}</button>
      <input type="range" min="0" max="1" step="0.01" bind:value={volume} aria-label={t("player.volume")} class="h-1 w-20 cursor-pointer accent-accent" />
    </div>

    <div class="mt-4 flex items-center justify-between px-1 text-xs text-neutral-500 dark:text-neutral-400">
      <span>{t("player.count", { n: tracks.length })}</span>
      <button
        onclick={refresh}
        aria-label={t("player.refresh")}
        data-icon="rotateCcw"
        class="grid h-7 w-7 place-items-center rounded-full transition active:scale-90 hover:bg-neutral-200/60 dark:hover:bg-white/10"
      >{@html iconSvg("rotateCcw", "h-4 w-4")}</button>
    </div>

    <div class="mt-4 space-y-1">
      {#each tracks as tr, i (tr.id)}
        <div class="flex items-center gap-1 rounded-xl px-2 py-1.5 {i === idx ? 'bg-accent/20' : 'hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50'}">
          <button onclick={() => selectTrack(i)} class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left text-sm outline-none">
            <span data-icon={i === idx ? "play" : tr.kind === "video" ? "film" : "musicNote"} class="grid w-5 shrink-0 place-items-center">
              {@html iconSvg(i === idx ? "play" : tr.kind === "video" ? "film" : "musicNote", "h-4 w-4")}
            </span>
            <span class="flex-1 truncate">{tr.title}</span>
            {#if tr.origin === "file" && isTooLarge(tr.sizeBytes)}
              <!-- Honest-boundary badge UP FRONT: a >MAX_PLAY_BYTES file is visibly
                   unplayable in the row, not only after clicking it. -->
              <span class="shrink-0 rounded-full bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger">{t("player.tooLargeShort")}</span>
            {/if}
            <span class="shrink-0 text-[10px] opacity-60">{t(originKey(tr.origin))}</span>
          </button>
        </div>
      {/each}
    </div>
  </div>
{/if}

