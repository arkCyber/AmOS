import { describe, expect, test } from "bun:test";
import {
  VMEMO_CAP,
  buildWavBytes,
  defaultRecordingTitle,
  fmtClock,
  fmtDuration,
  makeVoiceId,
  normalizeVoiceMemos,
  prependMemo,
  removeMemo,
  renameMemo,
  seedVoiceMemos,
  wavBytesToDataUrl,
  type VoiceMemo,
} from "../lib/voiceMemos";

const T = new Date(2026, 8, 4, 14, 3, 7).getTime();
const memo = (over: Partial<VoiceMemo> = {}): VoiceMemo => ({
  id: makeVoiceId(T),
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
    const url = wavBytesToDataUrl(bytes);
    expect(url.startsWith("data:audio/wav;base64,")).toBe(true);
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

