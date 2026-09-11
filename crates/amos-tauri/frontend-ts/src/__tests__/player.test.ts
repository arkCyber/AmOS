import { describe, expect, it } from "bun:test";
import {
  MAX_PLAY_BYTES,
  PLAYBACK_RATES,
  buildOrder,
  currentTrackIndex,
  cyclePlaybackRate,
  demoTracks,
  extOf,
  fmtSeconds,
  formatRate,
  indexOfTrackId,
  isTooLarge,
  kindFromName,
  mergeTracks,
  mimeForPlayable,
  posOfTrack,
  resumePosition,
  skipMode,
  stepOrderPos,
  stripExt,
  trackFromCapture,
  trackFromItem,
  trackFromMemo,
} from "../lib/player";
import type { MediaItem } from "../lib/media";
import type { PlayableKind } from "../lib/player";
import type { VoiceMemo } from "../lib/voiceMemos";
import type { VideoCapture } from "../lib/cameraCapture";

function item(p: Partial<MediaItem> & { name: string }): MediaItem {
  return {
    id: p.id ?? p.name,
    kind: p.kind ?? "file",
    collection: p.collection ?? "music",
    name: p.name,
    uri: p.uri ?? `mock://Music/${p.name}`,
    mime: p.mime ?? null,
    size_bytes: p.size_bytes ?? null,
    ts: p.ts ?? 0,
  };
}

const memo = (id: string, title: string): VoiceMemo => ({
  id,
  title,
  createdAt: 1000,
  durationMs: 3000,
  audio: { kind: "seed", seconds: 3, toneHz: 330 },
  sizeBytes: 100,
  mime: "audio/wav",
});

const capture = (id: string): VideoCapture => ({
  id,
  ts: 2000,
  mime: "video/webm",
  durationMs: 4000,
  w: 1280,
  h: 720,
});

/** Deterministic LCG so shuffle tests are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("player: file classification (kindFromName / extOf / stripExt)", () => {
  it("extOf/stripExt handle paths, case, and extensionless names", () => {
    expect(extOf("a/b/c.MP3")).toBe("mp3");
    expect(extOf("noext")).toBe("");
    expect(extOf(".hidden")).toBe("");
    expect(stripExt("a/b/c.MP3")).toBe("c");
    expect(stripExt("noext")).toBe("noext");
    expect(stripExt("/dir/.hidden")).toBe(".hidden");
  });

  it("classifies by extension, case-insensitively", () => {
    expect(kindFromName("song.mp3")).toBe("audio");
    expect(kindFromName("clip.MP4")).toBe("video");
    expect(kindFromName("a.mkv")).toBe("video");
    expect(kindFromName("a.flac")).toBe("audio");
  });

  it("rejects non-media files (never queued)", () => {
    expect(kindFromName("x.jpg")).toBeNull();
    expect(kindFromName("x.pdf")).toBeNull();
    expect(kindFromName("noext")).toBeNull();
    expect(kindFromName(".mp3")).toBeNull();
  });

  it("a specific MIME outranks a misleading extension", () => {
    expect(kindFromName("x.bin", "audio/mpeg")).toBe("audio");
    expect(kindFromName("a.mp3", "video/mp4")).toBe("video");
    expect(kindFromName("a.mp3", "application/octet-stream")).toBe("audio");
  });

  it("picks a usable blob MIME, keeping specific types", () => {
    expect(mimeForPlayable("s.mp3")).toBe("audio/mpeg");
    expect(mimeForPlayable("v.mkv", "application/octet-stream")).toBe("video/x-matroska");
    expect(mimeForPlayable("f.mp4", "video/mp4")).toBe("video/mp4");
    expect(mimeForPlayable("weird.zzz")).toBe("application/octet-stream");
  });
});

describe("player: bounded buffering (isTooLarge)", () => {
  it("rejects only sizes above the ceiling", () => {
    expect(isTooLarge(null)).toBe(false);
    expect(isTooLarge(undefined)).toBe(false);
    expect(isTooLarge(Number.NaN)).toBe(false);
    expect(isTooLarge(MAX_PLAY_BYTES)).toBe(false);
    expect(isTooLarge(MAX_PLAY_BYTES + 1)).toBe(true);
  });
});

describe("player: source promotion into the unified queue", () => {
  it("trackFromItem keeps only playable audio/video and labels the folder", () => {
    const audio = trackFromItem(item({ name: "sonata.mp3", collection: "music", size_bytes: 10 }));
    expect(audio).not.toBeNull();
    expect(audio?.origin).toBe("file");
    expect(audio?.kind).toBe("audio");
    expect(audio?.title).toBe("sonata");
    expect(audio?.subtitle).toBe("Music");
    expect(audio?.id).toBe("file:mock://Music/sonata.mp3");

    const video = trackFromItem(item({ name: "trip.mp4", collection: "movies" }));
    expect(video?.kind).toBe("video");
    expect(video?.subtitle).toBe("Movies");

    expect(trackFromItem(item({ name: "photo.jpg", collection: "pictures" }))).toBeNull();
    expect(trackFromItem(item({ name: "doc.pdf", collection: "download" }))).toBeNull();
  });

  it("trackFromMemo / trackFromCapture carry stable ids + detail", () => {
    const m = trackFromMemo(memo("m1", "晨间"));
    expect(m.id).toBe("memo:m1");
    expect(m.kind).toBe("audio");
    expect(m.title).toBe("晨间");
    expect(m.subtitle).toBe("audio/wav");

    const c = trackFromCapture(capture("c1"));
    expect(c.id).toBe("capture:c1");
    expect(c.kind).toBe("video");
    expect(c.subtitle).toContain("HD");
  });

  it("mergeTracks concatenates in order and drops later duplicates", () => {
    const a = trackFromItem(item({ name: "a.mp3" }));
    const b = trackFromItem(item({ name: "b.mp3" }));
    const aDup = trackFromItem(item({ name: "a.mp3" }));
    const merged = mergeTracks(
      [a as never, b as never],
      [aDup as never, trackFromMemo(memo("m1", "m")) ],
    );
    expect(merged.map((t) => t.id)).toEqual(["file:mock://Music/a.mp3", "file:mock://Music/b.mp3", "memo:m1"]);
  });

  it("demoTracks is deterministic, audio-only, and uniquely keyed", () => {
    const d1 = demoTracks();
    const d2 = demoTracks();
    expect(d1.length).toBe(3);
    expect(d1.map((t) => t.id)).toEqual(d2.map((t) => t.id));
    expect(new Set(d1.map((t) => t.id)).size).toBe(3);
    expect(d1.every((t) => t.kind === "audio" && t.origin === "demo")).toBe(true);
  });
});

describe("player: play order (buildOrder / posOfTrack / currentTrackIndex)", () => {
  it("identity order when not shuffling, and for empty/singleton lists", () => {
    expect(buildOrder(4, false)).toEqual([0, 1, 2, 3]);
    expect(buildOrder(0, true)).toEqual([]);
    expect(buildOrder(1, true)).toEqual([0]);
  });

  it("shuffle yields a deterministic permutation (valid for any rng)", () => {
    const o = buildOrder(6, true, lcg(42));
    expect([...o].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(o).toEqual(buildOrder(6, true, lcg(42))); // same seed → same order
    // An rng pinned to 1 must not index out of range.
    expect([...buildOrder(5, true, () => 1)].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
    // A misbehaving rng (NaN) is clamped, not fatal.
    expect([...buildOrder(3, true, () => Number.NaN)].sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });

  it("posOfTrack / currentTrackIndex are total", () => {
    expect(posOfTrack([2, 0, 1], 0)).toBe(1);
    expect(posOfTrack([2, 0, 1], 9)).toBe(-1);
    expect(currentTrackIndex([], 3)).toBe(0);
    expect(currentTrackIndex([2, 0, 1], 1)).toBe(0);
    expect(currentTrackIndex([2, 0, 1], 99)).toBe(1); // clamped
  });
});

describe("player: transport stepping (stepOrderPos / skipMode)", () => {
  it("returns stop with no order", () => {
    expect(stepOrderPos(0, 0, 1, "all")).toEqual({ pos: 0, stop: true });
  });

  it("repeat-one stays put (caller restarts the track)", () => {
    expect(stepOrderPos(2, 5, 1, "one")).toEqual({ pos: 2, stop: false });
  });

  it("repeat-all wraps in both directions", () => {
    expect(stepOrderPos(4, 5, 1, "all")).toEqual({ pos: 0, stop: false });
    expect(stepOrderPos(0, 5, -1, "all")).toEqual({ pos: 4, stop: false });
  });

  it("repeat-off advances and stops exactly at the ends", () => {
    expect(stepOrderPos(1, 5, 1, "off")).toEqual({ pos: 2, stop: false });
    expect(stepOrderPos(4, 5, 1, "off")).toEqual({ pos: 4, stop: true });
    expect(stepOrderPos(0, 5, -1, "off")).toEqual({ pos: 0, stop: true });
  });

  it("skipMode turns repeat-one into a real skip", () => {
    expect(skipMode("one")).toBe("all");
    expect(skipMode("all")).toBe("all");
    expect(skipMode("off")).toBe("off");
  });
});

describe("player: labels (fmtSeconds)", () => {
  it("formats clock labels and never emits NaN/negatives", () => {
    expect(fmtSeconds(0)).toBe("0:00");
    expect(fmtSeconds(67)).toBe("1:07");
    expect(fmtSeconds(3725)).toBe("1:02:05");
    expect(fmtSeconds(-5)).toBe("0:00");
    expect(fmtSeconds(Number.NaN)).toBe("0:00");
  });
});

describe("player: rescan preservation (indexOfTrackId)", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("finds a surviving track by id and reports absence", () => {
    expect(indexOfTrackId(list, "b")).toBe(1);
    expect(indexOfTrackId(list, "gone")).toBe(-1);
  });

  it("is total for a null/empty id and an empty library", () => {
    expect(indexOfTrackId(list, null)).toBe(-1);
    expect(indexOfTrackId(list, "")).toBe(-1);
    expect(indexOfTrackId([], "a")).toBe(-1);
  });
});

describe("player: playback speed (PLAYBACK_RATES / cyclePlaybackRate / formatRate)", () => {
  it("the preset list is ascending, unique, and includes 1x", () => {
    expect(PLAYBACK_RATES).toContain(1);
    expect([...PLAYBACK_RATES].sort((a, b) => a - b)).toEqual([...PLAYBACK_RATES]);
    expect(new Set(PLAYBACK_RATES).size).toBe(PLAYBACK_RATES.length);
  });

  it("cycles forward and backward with wraparound", () => {
    expect(cyclePlaybackRate(1, 1)).toBe(1.25);
    expect(cyclePlaybackRate(2, 1)).toBe(0.5); // wrap forward to slowest
    expect(cyclePlaybackRate(0.5, -1)).toBe(2); // wrap backward to fastest
  });

  it("an unknown/absent rate restarts from 1x (never NaN)", () => {
    expect(cyclePlaybackRate(99, 1)).toBe(1.25);
    expect(cyclePlaybackRate(Number.NaN, 1)).toBe(1.25);
    expect(PLAYBACK_RATES).toContain(cyclePlaybackRate(7, -1));
  });

  it("formats a compact, total label", () => {
    expect(formatRate(1)).toBe("1×");
    expect(formatRate(1.25)).toBe("1.25×");
    expect(formatRate(0.5)).toBe("0.5×");
    expect(formatRate(Number.NaN)).toBe("1×");
    expect(formatRate(-2)).toBe("1×");
  });
});

describe("player: resume position (resumePosition)", () => {
  it("resumes mid-track but snaps a finished track back to 0", () => {
    expect(resumePosition(0, 100)).toBe(0);
    expect(resumePosition(10, 100)).toBe(10);
    expect(resumePosition(97, 100)).toBe(0); // within the last 3s
    expect(resumePosition(100, 100)).toBe(0);
    expect(resumePosition(30, 5)).toBe(0); // saved beyond a short clip
  });

  it("is total when the duration is not known yet", () => {
    expect(resumePosition(12, 0)).toBe(12);
    expect(resumePosition(12, Number.NaN)).toBe(12);
    expect(resumePosition(Number.NaN, 100)).toBe(0);
    expect(resumePosition(-4, 100)).toBe(0);
  });
});

describe("player: real-world files (names/metadata from the acceptance probe)", () => {
  // These are the exact files `cargo run -p amos-media --example probe_media`
  // generates: real LAME mp3, H.264/AAC mp4, and AAC m4a — and the bridge now
  // reports each one's real kind + MIME (see amos-media `mapping`).
  const real: Array<[string, string, PlayableKind]> = [
    ["晨光.mp3", "audio/mpeg", "audio"],
    ["星河.mp4", "video/mp4", "video"],
    ["IMG_0001.mp4", "video/mp4", "video"],
    ["Voice_001.m4a", "audio/mp4", "audio"],
  ];

  for (const [name, mime, kind] of real) {
    it(`queues a real ${name} as ${kind}`, () => {
      const track = trackFromItem(item({ name, mime, kind }));
      expect(track?.kind).toBe(kind);
      expect(track?.title).toBe(name.replace(/\.[^.]+$/, ""));
      // The blob the player builds is tagged with the real container MIME.
      expect(mimeForPlayable(name, mime)).toBe(mime);
    });
  }

  it("never queues a real non-media file the bridge now types", () => {
    expect(trackFromItem(item({ name: "readme.txt", mime: "text/plain", kind: "file" }))).toBeNull();
    expect(
      trackFromItem(item({ name: "ReleaseNotes.pdf", mime: "application/pdf", kind: "file" })),
    ).toBeNull();
  });
});

