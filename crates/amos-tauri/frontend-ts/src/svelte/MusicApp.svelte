<script lang="ts">
  // MusicApp.svelte — Svelte 5 (runes) single-source implementation of the music
  // screen. All playback/navigation/lyric logic reuses pure
  // lib/music.ts. One 1 s interval advances the playhead only while playing (the
  // $effect restarts on playing/tracks.length/repeat; sec/idx are updated inside
  // the callback so the interval is not re-created every tick).
  import {
    DEMO_LYRICS,
    MUSIC_KEY,
    lyricIndex,
    nextIndex,
    nextIndexAfterRemoval,
    normalizeTracks,
    pctProgress,
    removeTrack,
    seekSeconds,
    seedTracks,
    stepIndex,
  } from "../lib/music";
  import type { RepeatMode, Track } from "../lib/music";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";

  const DURATION = 24; // demo seconds per track

  const seeded = ((): Track[] => {
    const l = normalizeTracks(readStoreValue<unknown>(MUSIC_KEY, []));
    if (l.length) return l;
    const s = seedTracks();
    writeStoreValue(MUSIC_KEY, s);
    return s;
  })();
  let tracks = $state<Track[]>(seeded);
  let idx = $state(0);
  let playing = $state(false);
  let sec = $state(0);
  let repeat = $state<RepeatMode>("all");
  let showLyrics = $state(false);

  $effect(() => {
    if (!playing) return;
    const n = Math.max(tracks.length, 1);
    const id = setInterval(() => {
      if (sec >= DURATION) {
        if (repeat === "one") {
          // keep same track, restart playhead
        } else if (repeat === "off" && idx >= n - 1) {
          playing = false; // end of playlist
        } else {
          idx = stepIndex(idx, n, 1);
        }
        sec = 0;
      } else {
        sec = sec + 1;
      }
    }, 1000);
    return () => clearInterval(id);
  });

  // Guard: current index may drift out of range if the playlist ever shrinks.
  const safeIdx = $derived(tracks.length ? (idx < tracks.length ? idx : 0) : 0);
  const track = $derived(tracks[safeIdx] ?? null);
  const select = (i: number) => {
    idx = stepIndex(i, Math.max(tracks.length, 1), 0);
    sec = 0;
  };
  const step = (d: number) => {
    idx = nextIndex(idx, Math.max(tracks.length, 1), d, repeat);
    sec = 0;
  };
  const remove = (id: string) => {
    const removedIndex = tracks.findIndex((tr) => tr.id === id);
    if (removedIndex < 0) return;
    const list = removeTrack(tracks, id);
    writeStoreValue(MUSIC_KEY, list);
    tracks = list;
    idx = nextIndexAfterRemoval(idx, removedIndex, list.length);
    sec = 0;
  };
  const cycleRepeat = () => {
    repeat = repeat === "all" ? "one" : repeat === "one" ? "off" : "all";
  };
  const cycleLyrics = () => (showLyrics = !showLyrics);

  const fmtM = (s: number) => {
    const n = Math.max(0, Math.floor(s));
    const p = (x: number) => String(x).padStart(2, "0");
    return `${p(Math.floor(n / 60))}:${p(n % 60)}`;
  };
  const seekClick = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const frac = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
    sec = seekSeconds(frac, DURATION);
    playing = true;
  };
  const seekKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      sec = Math.min(DURATION, sec + 5);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      sec = Math.max(0, sec - 5);
    }
  };
</script>

{#if !track}
  <div class="grid h-full place-items-center p-6 text-center">
    <div>
      <div class="grid h-16 w-16 place-items-center text-4xl text-neutral-400 dark:text-neutral-500">{@html iconSvg("headphones", "h-12 w-12")}</div>
      <p class="mt-3 text-sm opacity-60">{t("music.empty")}</p>
    </div>
  </div>
{:else}
  <div class="p-4">
    <p class="text-center text-xs uppercase tracking-widest opacity-50">{playing ? t("music.playing") : "—"}</p>
    <div class="my-2 grid place-items-center rounded-3xl bg-gradient-to-br from-orange-400 to-pink-500 py-10 text-white/90">{@html iconSvg("headphones", "h-16 w-16")}</div>

    {#if showLyrics}
      <div class="mx-auto mb-1 w-64 space-y-0.5">
        {#each DEMO_LYRICS as l, i (i)}
          <p class="truncate text-center text-sm transition {i === lyricIndex(sec, DURATION, DEMO_LYRICS.length)
            ? 'font-semibold text-accent'
            : 'opacity-40'}">{l}</p>
        {/each}
      </div>
    {/if}

    <p class="text-center text-lg font-semibold">{track.title}</p>
    <p class="text-center text-xs opacity-60">{track.artist}</p>
    <div class="mt-1 flex items-baseline justify-between px-0.5 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
      <span>{fmtM(sec)}</span>
      <span>{fmtM(DURATION)}</span>
    </div>

    <div
      role="slider"
      aria-label={t("music.seek")}
      aria-valuenow={Math.round(pctProgress(sec, DURATION) * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabindex={0}
      onclick={seekClick}
      onkeydown={seekKey}
      class="group relative mt-1.5 h-1.5 cursor-pointer rounded-full bg-neutral-300 dark:bg-white/15"
    >
      <div class="absolute inset-y-0 left-0 rounded-full bg-accent" style:width={`${pctProgress(sec, DURATION) * 100}%`}></div>
      <div class="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow ring-1 ring-black/5 transition group-hover:scale-110"
        style:left={`calc(${pctProgress(sec, DURATION) * 100}% - 7px)`}></div>
    </div>

    <div class="mt-5 flex items-center justify-center gap-7">
      <button onclick={() => step(-1)} aria-label="previous" data-icon="skipBack"
        class="grid h-14 w-14 place-items-center rounded-full bg-neutral-300 text-xl text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-white">{@html iconSvg("skipBack", "h-7 w-7")}</button>
      <button onclick={() => (playing = !playing)} aria-label={playing ? "pause" : "play"}
        class="grid h-[72px] w-[72px] place-items-center rounded-full bg-accent text-3xl text-white shadow-[0_8px_20px_rgba(0,122,255,0.35)] transition active:scale-95">
        {@html iconSvg(playing ? "pause" : "play", "h-9 w-9")}
      </button>
      <button onclick={() => step(1)} aria-label="next" data-icon="skipForward"
        class="grid h-14 w-14 place-items-center rounded-full bg-neutral-300 text-xl text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-white">{@html iconSvg("skipForward", "h-7 w-7")}</button>
    </div>

    <div class="mt-4 flex items-center justify-center gap-12 text-sm">
      <button onclick={cycleRepeat} title={t("music.repeat")} aria-label={t("music.repeat")} data-icon="repeat"
        class={"grid h-10 w-10 place-items-center rounded-full text-base transition active:scale-90 " + (repeat === "off" ? "opacity-35" : repeat === "one" ? "text-accent opacity-90" : "opacity-80")}>
        {@html iconSvg("repeat", "h-6 w-6")}
      </button>
      <button onclick={cycleLyrics} title={t("music.lyrics")} aria-label={t("music.lyrics")} data-icon="lyrics"
        class="grid h-10 w-10 place-items-center rounded-full text-base transition active:scale-90 {showLyrics ? 'text-accent opacity-90' : 'opacity-35'}">{@html iconSvg("messageCircle", "h-6 w-6")}</button>
    </div>

    <div class="mt-4 space-y-1">
      {#each tracks as tr, i (tr.id)}
        <div class="flex items-center gap-1 rounded-xl px-2 py-1.5 {i === idx ? 'bg-accent/20' : 'hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50'}">
          <button onclick={() => select(i)} class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left text-sm outline-none">
            <span data-icon={i === idx ? "play" : "musicNote"} class="grid w-5 shrink-0 place-items-center">{@html iconSvg(i === idx ? "play" : "musicNote", "h-4 w-4")}</span>
            <span class="flex-1 truncate">{tr.title}</span>
            <span class="text-xs opacity-60">{tr.artist}</span>
          </button>
          <button onclick={() => remove(tr.id)} disabled={tracks.length <= 1} aria-label={t("music.remove")} data-icon="x"
            class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs leading-none text-danger disabled:opacity-30 dark:bg-neutral-700/70">{@html iconSvg("x", "h-3 w-3")}</button>
        </div>
      {/each}
    </div>
  </div>
{/if}

