/**
 * recordings.test.ts — the pure helpers of the call-recording seam (REQ-A1334).
 *
 * The wire wrappers themselves are thin `invoke` passthroughs; what can actually be wrong here is
 * the formatting and ordering, so that is what is pinned. Two honesty properties the UI depends on:
 * a bogus numeric field (NaN / negative) must render as a benign placeholder rather than a wrong
 * time or size, and the display order must be newest-first regardless of the ledger's write order.
 */
import { describe, expect, test } from "vitest";
import { formatBytes, formatDuration, sortRecordings, type RecordingMeta } from "../lib/recordings";

const rec = (call_id: string, started_at: number): RecordingMeta => ({
  call_id,
  peer: "x",
  started_at,
  duration_sec: 10,
  file_size_bytes: 1000,
});

describe("formatDuration", () => {
  test("mm:ss under an hour, h:mm:ss past it", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(600)).toBe("10:00");
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  test("a non-finite or negative value is a placeholder, never a bogus time", () => {
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatDuration(-30)).toBe("0:00");
  });
});

describe("formatBytes", () => {
  test("scales through B / KB / MB / GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });

  test("a non-finite or negative value is a placeholder", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("sortRecordings", () => {
  test("newest first, and the input is not mutated", () => {
    const input = [rec("a", 100), rec("c", 300), rec("b", 200)];
    const out = sortRecordings(input);
    expect(out.map((r) => r.call_id)).toEqual(["c", "b", "a"]);
    // The caller's array keeps its own order — a sort helper that reorders its argument is a
    // side effect the page never asked for.
    expect(input.map((r) => r.call_id)).toEqual(["a", "c", "b"]);
  });

  test("ties break by call_id so the order is deterministic", () => {
    const out = sortRecordings([rec("z", 100), rec("a", 100)]);
    expect(out.map((r) => r.call_id)).toEqual(["a", "z"]);
  });
});
