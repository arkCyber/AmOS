/**
 * screenRecord.test.ts — the pure reading of the system-screen-recording seam (REQ-A1580).
 *
 * The wrappers are thin `invoke` passthroughs; what can actually be wrong is (a) the
 * classifier folding "the host did not answer" into "idle" and (b) `start` sending an
 * option the caller never set (or dropping a legal `0`). Both are pinned here, the first
 * with a negative control.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  recordingClock,
  recordingLabelKey,
  recordingPhase,
  screenRecordCapability,
  screenRecordStart,
  screenRecordStatus,
  type ScreenRecordStatus,
} from "../lib/screenRecord";

const status = (over: Partial<ScreenRecordStatus>): ScreenRecordStatus => ({
  recording: false,
  stopping: false,
  started_ms: 0,
  elapsed_secs: 0,
  max_secs: 0,
  out: null,
  ...over,
});

const realWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

/** Install a fake Tauri bridge whose `invoke` records every call and answers `answer`. */
function installBridge(invoke: (cmd: string, args?: Record<string, unknown>) => unknown): {
  calls: { cmd: string; args?: Record<string, unknown> }[];
} {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return Promise.resolve(invoke(cmd, args));
      },
    },
  };
  return { calls };
}

describe("recordingPhase", () => {
  test("a null read is 'unknown', never 'idle'", () => {
    // Negative control: the defect this seam exists to prevent is folding "no answer" into
    // "not recording", which would draw a stopped recorder over a live session.
    expect(recordingPhase(null)).toBe("unknown");
    expect(recordingPhase(null)).not.toBe("idle");
  });

  test("the live / sealing / idle reads are each their own phase", () => {
    expect(recordingPhase(status({ recording: true }))).toBe("recording");
    expect(recordingPhase(status({ stopping: true }))).toBe("stopping");
    expect(recordingPhase(status({}))).toBe("idle");
  });

  test("recording wins over stopping if the host ever reported both", () => {
    expect(recordingPhase(status({ recording: true, stopping: true }))).toBe("recording");
  });
});

describe("recordingClock", () => {
  test("only a live or sealing session has a clock; a missing/idle read has none", () => {
    expect(recordingClock(null)).toBe("");
    expect(recordingClock(status({}))).toBe("");
    expect(recordingClock(status({ recording: true, elapsed_secs: 65 }))).toBe("1:05");
    expect(recordingClock(status({ stopping: true, elapsed_secs: 3600 }))).toBe("1:00:00");
  });
});

describe("recordingLabelKey", () => {
  test("every phase maps to a distinct key", () => {
    const keys = (["unknown", "idle", "recording", "stopping"] as const).map(recordingLabelKey);
    expect(new Set(keys).size).toBe(4);
    for (const k of keys) expect(k.startsWith("cc.record.")).toBe(true);
  });
});

describe("screenRecordStart", () => {
  test("an unset bound is omitted, and a set one travels even when the host will refuse it", async () => {
    const { calls } = installBridge(() => status({ recording: true }));

    await screenRecordStart();
    expect(calls[0]?.cmd).toBe("screen_record_start");
    expect(calls[0]?.args).toEqual({});

    await screenRecordStart({ maxSecs: 30 });
    expect(calls[1]?.args).toEqual({ maxSecs: 30 });

    // `0` is *refused* by the host (`amos.screenrecord.duration_out_of_range`), and it
    // must still reach it: the frontend is not the place that decides a bound is legal, so
    // folding a caller's out-of-range number into a default would replace the host's named
    // refusal with a recording the caller did not ask for. Omitting the option is the only
    // way to request the host's own ceiling.
    await screenRecordStart({ maxSecs: 0 });
    expect(calls[2]?.args).toEqual({ maxSecs: 0 });

    await screenRecordStart({ display: 1 });
    expect(calls[3]?.args).toEqual({ display: 1 });
  });
});

describe("the wrappers pass the host's answer straight through", () => {
  test("capability and status return the host object", async () => {
    installBridge((cmd) =>
      cmd === "screen_record_capability"
        ? { available: false, reason: "nope" }
        : status({ recording: true, elapsed_secs: 3 }),
    );
    expect(await screenRecordCapability()).toEqual({ available: false, reason: "nope" });
    expect(await screenRecordStatus()).toEqual(status({ recording: true, elapsed_secs: 3 }));
  });

  test("no bridge resolves null, which recordingPhase reads as 'unknown'", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: undefined };
    expect(await screenRecordStatus()).toBeNull();
    expect(recordingPhase(await screenRecordStatus())).toBe("unknown");
  });
});
