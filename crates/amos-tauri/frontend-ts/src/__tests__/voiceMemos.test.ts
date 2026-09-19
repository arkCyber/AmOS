import { describe, expect, test } from "bun:test";
import {
  VMEMO_CAP,
  attachTranscript,
  buildWavBytes,
  clampSeekSeconds,
  clampTrimRange,
  classifyTranscribe,
  classifyTranscribeError,
  defaultRecordingTitle,
  fmtClock,
  fmtDuration,
  isFullRange,
  makeVoiceId,
  normalizeVoiceMemos,
  prependMemo,
  progressPercent,
  removeMemo,
  renameMemo,
  seedVoiceMemos,
  trimMemo,
  trimmedDurationMs,
  type MemoRange,
  type VoiceMemo,
} from "../lib/voiceMemos";

const T = new Date(2026, 8, 4, 14, 3, 7).getTime();
const memo = (over: Partial<VoiceMemo> = {}): VoiceMemo => ({
  id: makeVoiceId(),
  title: "备忘",
  createdAt: T,
  durationMs: 3000,
  audio: { kind: "recorded" },
  sizeBytes: 100,
  mime: "audio/webm",
  ...over,
});

describe("voice memos domain", () => {
  test("WAV generator produces a valid, playable byte stream", () => {
    const bytes = buildWavBytes({ seconds: 1, sampleRate: 8000 });
    expect(bytes.length).toBe(44 + 8000 * 2); // header + mono 16-bit samples
    expect(bytes[0]).toBe(0x52); // R
    expect(String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)).toBe("WAVE");
  });

  test("duration/clock/date formatting", () => {
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(307_000)).toBe("5:07");
    expect(fmtDuration(3_725_000)).toBe("1:02:05");
    expect(fmtClock(0)).toBe("00:00");
    expect(fmtClock(65_000)).toBe("01:05");
    const d = new Date(T);
    expect(defaultRecordingTitle(T)).toBe(`${String(d.getHours()).padStart(2, "0")}:03:07`);
  });

  test("prepend keeps newest-first and is capped", () => {
    let list: VoiceMemo[] = [];
    for (let i = 0; i < VMEMO_CAP + 5; i++) list = prependMemo(list, memo({ id: `m${i}` }));
    expect(list).toHaveLength(VMEMO_CAP);
    expect(list[0]!.id).toBe(`m${VMEMO_CAP + 4}`);
  });

  test("rename/remove are immutable & guarded", () => {
    const list = [memo({ id: "a", title: "旧" }), memo({ id: "b" })];
    const renamed = renameMemo(list, "a", "  新名字  ");
    expect(renamed[0]!.title).toBe("新名字");
    expect(list[0]!.title).toBe("旧"); // untouched
    expect(renameMemo(list, "a", "   ")).toBe(list); // blank refuses
    expect(renameMemo(list, "zzz", "x")).toEqual(list); // missing id is a no-op
    expect(removeMemo(list, "a")).toHaveLength(1);
  });

  test("normalization keeps recorded+seed memos, drops audio-less/garbage, dedups, caps", () => {
    const rec = memo({ id: "a" });
    const seed = { ...memo({ id: "b" }), audio: { kind: "seed", seconds: 2, toneHz: 440 } };
    const noAudio = { ...memo({ id: "c" }), audio: null };
    const badAudio = { ...memo({ id: "d" }), audio: { kind: "bad" } };
    const raw = [rec, seed, noAudio, badAudio, { id: "a" }, null, 42];
    const out = normalizeVoiceMemos(raw);
    expect(out.map((m) => m.id).sort()).toEqual(["a", "b"]);
    expect(out.find((m) => m.id === "b")?.audio.kind).toBe("seed");
    // cap respected
    const many = Array.from({ length: VMEMO_CAP + 3 }, (_, i) => memo({ id: `x${i}` }));
    expect(normalizeVoiceMemos(many)).toHaveLength(VMEMO_CAP);
    expect(normalizeVoiceMemos(null)).toEqual([]);
  });

  test("seeds are regenerable WAV clips — no audio bytes stored", () => {
    const s = seedVoiceMemos(T);
    expect(s).toHaveLength(2);
    expect(s.every((m) => m.audio.kind === "seed")).toBe(true); // nothing persisted
    expect(s.every((m) => m.audio.kind === "seed" && m.audio.seconds > 0)).toBe(true);
    expect(s.every((m) => m.mime === "audio/wav" && m.sizeBytes > 44)).toBe(true);
    expect(s[0]!.createdAt).toBeGreaterThan(s[1]!.createdAt); // newest first
  });
});

/* ---- playback progress ---- */
describe("progressPercent", () => {
  test.each([
    [0, 3000, 0],
    [1500, 3000, 50],
    [3000, 3000, 100],
    [0, 0, 0],         // zero duration → 0
    [-100, 3000, 0],    // negative clamps to 0
    [9999, 3000, 100],  // past end caps at 100
    [NaN, 3000, 0],
    [1500, NaN, 0],
    [1500, -1, 0],
  ])("currentMs=%p, dur=%p → %p%%", (cur, dur, want) => {
    expect(progressPercent(cur as number, dur as number)).toBeCloseTo(want as number, 5);
  });
});

describe("clampSeekSeconds", () => {
  test.each([
    [0, 30, 0],
    [15, 30, 15],
    [30, 30, 30],
    [99, 30, 30],    // past end
    [-5, 30, 0],    // negative
    [NaN, 30, 0],
    [15, 0, 0],     // zero duration
    [15, -1, 0],
  ])("sec=%p, dur=%p → %p", (sec, dur, want) => {
    expect(clampSeekSeconds(sec as number, dur as number)).toBeCloseTo(want as number, 5);
  });
});

/* ---- trim region ---- */
describe("clampTrimRange", () => {
  test("normal [s, e] within bounds", () => {
    const r = clampTrimRange(500, 2000, 3000);
    expect(r).toEqual({ startMs: 500, endMs: 2000 });
  });

  test("start > end swaps", () => {
    const r = clampTrimRange(2000, 500, 3000);
    expect(r).toEqual({ startMs: 500, endMs: 2000 });
  });

  test("negative bounds collapse to 0", () => {
    const r = clampTrimRange(-100, -50, 3000);
    expect(r).toEqual({ startMs: 0, endMs: 0 });
  });

  test("NaN bounds collapse to 0 / duration", () => {
    const r = clampTrimRange(NaN, NaN, 3000);
    expect(r).toEqual({ startMs: 0, endMs: 0 });
  });

  test("end > duration clamps to duration", () => {
    const r = clampTrimRange(2000, 9999, 3000);
    expect(r).toEqual({ startMs: 2000, endMs: 3000 });
  });

  test("both > duration → both clamped to duration (empty range)", () => {
    // When both handles are past the end, clamp individually to [dur, dur].
    // The caller (saveTrim) refuses an empty range separately, so this is OK.
    const r = clampTrimRange(5000, 9999, 3000);
    expect(r).toEqual({ startMs: 3000, endMs: 3000 });
  });

  test("zero duration → [0, 0]", () => {
    const r = clampTrimRange(0, 1000, 0);
    expect(r).toEqual({ startMs: 0, endMs: 0 });
  });
});

describe("isFullRange", () => {
  test("full range is detected", () => {
    expect(isFullRange({ startMs: 0, endMs: 3000 }, 3000)).toBe(true);
  });
  test("trimmed range is not full", () => {
    expect(isFullRange({ startMs: 500, endMs: 2500 }, 3000)).toBe(false);
  });
  test("empty range is full by the [0,dur] definition", () => {
    expect(isFullRange({ startMs: 0, endMs: 0 }, 0)).toBe(true);
  });
});

describe("trimmedDurationMs", () => {
  test.each([
    [{ startMs: 500, endMs: 2000 }, 1500],
    [{ startMs: 0, endMs: 3000 }, 3000],
    [{ startMs: 1000, endMs: 1000 }, 0],
    [{ startMs: -100, endMs: 500 }, 600],
  ])("range=%p → %p ms", (r, want) => {
    expect(trimmedDurationMs(r as MemoRange)).toBe(want as number);
  });
});

describe("trimMemo", () => {
  const src = memo({ id: "src-1", durationMs: 6000, sizeBytes: 12000 });

  test("recorded memo → sibling with fresh id + trimOf", () => {
    const res = trimMemo(src, { startMs: 1000, endMs: 4000 }, T + 1);
    expect(res.ok).toBe(true);
    const { memo: m } = res as { ok: true; memo: VoiceMemo };
    expect(m.id).not.toBe("src-1");
    expect(m.trimOf).toBe("src-1");
    expect(m.durationMs).toBe(3000);
    expect(m.createdAt).toBeGreaterThanOrEqual(T + 1);
    expect(m.audio).toEqual({ kind: "recorded" });
  });

  test("seed memo → refused (no bytes to cut)", () => {
    const seed = { ...memo({ id: "seed-1" }), audio: { kind: "seed" as const, seconds: 3, toneHz: 440 } };
    const res = trimMemo(seed, { startMs: 0, endMs: 3000 }, T + 1);
    expect(res).toEqual({ ok: false, reason: "seed" });
  });

  test("zero-length range → refused", () => {
    const res = trimMemo(src, { startMs: 1000, endMs: 1000 }, T + 1);
    expect(res).toEqual({ ok: false, reason: "empty" });
  });

  test("sizeBytes is proportional to duration ratio", () => {
    const res = trimMemo(src, { startMs: 0, endMs: 3000 }, T + 1) as { ok: true; memo: VoiceMemo };
    expect(res.memo.sizeBytes).toBe(6000); // half
  });

  test("clamps out-of-bounds range before building memo", () => {
    const res = trimMemo(src, { startMs: -999, endMs: 9999 }, T + 1) as { ok: true; memo: VoiceMemo };
    expect(res.memo.durationMs).toBe(6000); // full
  });
});

/* ---- transcript ---- */
describe("attachTranscript", () => {
  const m = memo({ id: "t1" });
  const tx = { text: "hello world", recognized: true, lang: "en", at: T + 1 };

  test("attaches a transcript", () => {
    const got = attachTranscript(m, tx);
    expect(got.transcript).toEqual(tx);
    expect(got.id).toBe("t1");
  });

  test("null → strips it", () => {
    const withTx = { ...m, transcript: tx };
    const got = attachTranscript(withTx, null);
    expect("transcript" in got).toBe(false);
  });

  test("null on memo without transcript → unchanged", () => {
    const got = attachTranscript(m, null);
    expect(got).toBe(m);
  });
});

describe("classifyTranscribe", () => {
  test('recognized=true → "done"', () => {
    const s = classifyTranscribe({ text: "hello", recognized: true, lang: "zh" }, T + 1);
    expect(s.kind).toBe("done");
    const done = s as { kind: "done"; transcript: { text: string } };
    expect(done.transcript.text).toBe("hello");
  });

  test('recognized=false + empty text → "empty"', () => {
    const s = classifyTranscribe({ text: "", recognized: false }, T + 1);
    expect(s.kind).toBe("empty");
  });

  test('recognized=false + non-empty text → "done" (daemon surface "no speech")', () => {
    const s = classifyTranscribe({ text: "……", recognized: false }, T + 1);
    expect(s.kind).toBe("done");
  });

  test("non-object payload → error(shape)", () => {
    expect(classifyTranscribe(null, T + 1).kind).toBe("error");
    expect(classifyTranscribe("not an object", T + 1).kind).toBe("error");
    expect(classifyTranscribe({ noText: true }, T + 1).kind).toBe("error");
  });

  test("at=NaN → 0", () => {
    const s = classifyTranscribe({ text: "hi", recognized: true }, NaN) as { kind: "done"; transcript: { at: number } };
    expect(s.kind).toBe("done");
    expect(s.transcript.at).toBe(0);
  });
});

describe("classifyTranscribeError", () => {
  test('no-bridge → "offline"', () => {
    const s = classifyTranscribeError(new Error("no bridge"));
    expect(s).toEqual({ kind: "error", message: "offline" });
  });

  test('host reject → "host"', () => {
    const s = classifyTranscribeError(new Error("permission denied"));
    expect(s).toEqual({ kind: "error", message: "host" });
  });

  test("string error → host", () => {
    const s = classifyTranscribeError("some string error");
    expect(s.kind).toBe("error");
  });

  test("unknown → unknown", () => {
    const s = classifyTranscribeError({});
    expect(s.kind).toBe("error");
    expect((s as { kind: "error"; message: string }).message).toBe("unknown");
  });
});

/* ---- normalizeVoiceMemos with transcript / trimOf ---- */
describe("normalizeVoiceMemos — transcript & trimOf", () => {
  test("valid transcript is preserved", () => {
    const raw = [{ id: "t1", title: "t", createdAt: T, durationMs: 1000, audio: { kind: "recorded" }, sizeBytes: 10, mime: "audio/webm", transcript: { text: "hi", recognized: true, lang: "en", at: T + 1 } }];
    const out = normalizeVoiceMemos(raw);
    expect(out[0]?.transcript).toEqual({ text: "hi", recognized: true, lang: "en", at: T + 1 });
  });

  test("invalid transcript is dropped (not null-sentinelled)", () => {
    const raw = [{ id: "t1", title: "t", createdAt: T, durationMs: 1000, audio: { kind: "recorded" }, sizeBytes: 10, mime: "audio/webm", transcript: { notText: true } }];
    const out = normalizeVoiceMemos(raw);
    expect("transcript" in (out[0] ?? {})).toBe(false);
  });

  test("valid trimOf is preserved", () => {
    const raw = [{ id: "child", title: "c", createdAt: T, durationMs: 500, audio: { kind: "recorded" }, sizeBytes: 5, mime: "audio/webm", trimOf: "parent" }];
    const out = normalizeVoiceMemos(raw);
    expect(out[0]?.trimOf).toBe("parent");
  });

  test("trimOf === self is dropped (prevent self-reference)", () => {
    const raw = [{ id: "same", title: "s", createdAt: T, durationMs: 500, audio: { kind: "recorded" }, sizeBytes: 5, mime: "audio/webm", trimOf: "same" }];
    const out = normalizeVoiceMemos(raw);
    expect("trimOf" in (out[0] ?? {})).toBe(false);
  });

  test("non-string trimOf is dropped", () => {
    const raw = [{ id: "bad", title: "b", createdAt: T, durationMs: 500, audio: { kind: "recorded" }, sizeBytes: 5, mime: "audio/webm", trimOf: 123 }];
    const out = normalizeVoiceMemos(raw);
    expect("trimOf" in (out[0] ?? {})).toBe(false);
  });
});

