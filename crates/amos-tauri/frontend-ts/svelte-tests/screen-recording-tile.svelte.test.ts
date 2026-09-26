/**
 * ScreenRecordingTile.svelte — the front door the host's `screen_record_*` commands never
 * had (REQ-A1580).
 *
 * What these pin, in the user's language (read out of the dictionaries, so the assertion
 * does not freeze a wording): a refused start says so instead of doing nothing; an
 * unavailable build shows the host's own reason and will not offer Start; the one this seam
 * exists for — a **missing** status read is drawn as "unknown", never as "not recording"
 * over a session that may be live; and that the tile **keeps asking** while it shows
 * nothing, so a session that begins after (or without) its own start is still observed
 * (REQ-A1653 ∕ F-SH-843).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import ScreenRecordingTile from "../src/svelte/ScreenRecordingTile.svelte";
import * as screenRecord from "../src/lib/screenRecord";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

// Partial mock: stub only the four host wrappers. The pure readers (`recordingPhase`,
// `recordingClock`, `recordingLabelKey`) are the *subject* of two of these cases, so they
// must stay real — an auto-mock would stub them to `undefined` and silently test nothing.
vi.mock("../src/lib/screenRecord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/screenRecord")>();
  return {
    ...actual,
    screenRecordCapability: vi.fn(),
    screenRecordStatus: vi.fn(),
    screenRecordStart: vi.fn(),
    screenRecordStop: vi.fn(),
  };
});

const both = (key: keyof typeof zh) => new Set([zh[key], en[key]]);
const refused = both("cc.record.refused");
const unknown = both("cc.record.unknown");
const idle = both("cc.record.idle");

const idleStatus: screenRecord.ScreenRecordStatus = {
  recording: false,
  stopping: false,
  started_ms: 0,
  elapsed_secs: 0,
  max_secs: 0,
  out: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(screenRecord.screenRecordCapability).mockResolvedValue({ available: true, reason: "" });
  vi.mocked(screenRecord.screenRecordStatus).mockResolvedValue(idleStatus);
  vi.mocked(screenRecord.screenRecordStart).mockResolvedValue(idleStatus);
  vi.mocked(screenRecord.screenRecordStop).mockResolvedValue(idleStatus);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ScreenRecordingTile.svelte", () => {
  test("a refused start is shown to the user, not swallowed", async () => {
    vi.mocked(screenRecord.screenRecordStart).mockResolvedValue(null);

    render(ScreenRecordingTile);
    const start = await screen.findByTestId("cc-record-start");
    await fireEvent.click(start);

    const banner = await screen.findByTestId("cc-record-refused");
    expect(refused.has(banner.textContent?.trim() ?? "")).toBe(true);
  });

  test("a missing status read draws 'unknown', never 'not recording'", async () => {
    // Negative control for the fold this seam prevents.
    vi.mocked(screenRecord.screenRecordStatus).mockResolvedValue(null);

    render(ScreenRecordingTile);
    const state = await screen.findByTestId("cc-record-state");
    expect(unknown.has(state.textContent?.trim() ?? "")).toBe(true);
    expect(idle.has(state.textContent?.trim() ?? "")).toBe(false);
  });

  test("a live session offers Stop and shows the clock", async () => {
    vi.mocked(screenRecord.screenRecordStatus).mockResolvedValue({
      ...idleStatus,
      recording: true,
      elapsed_secs: 65,
    });

    render(ScreenRecordingTile);
    const stop = await screen.findByTestId("cc-record-stop");
    expect(stop).toBeTruthy();
    const state = await screen.findByTestId("cc-record-state");
    expect(state.textContent ?? "").toContain("1:05");
  });

  test("an unavailable build shows the host's reason and will not offer Start", async () => {
    vi.mocked(screenRecord.screenRecordCapability).mockResolvedValue({
      available: false,
      reason: "screen recording is not available on linux",
    });

    render(ScreenRecordingTile);
    const reason = await screen.findByTestId("cc-record-unavailable");
    expect(reason.textContent).toContain("not available on linux");
    const start = (await screen.findByTestId("cc-record-start")) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  test("a session that begins while the panel shows nothing is still observed", async () => {
    // The panel must keep asking the host, not gate its poll on the phase.
    //
    // A start is a **request**, not a recording: on Android `screen_record_start` posts a
    // system consent dialog and answers before the user approves, so the status it returns
    // is legitimately idle (`ScreenRecordGlue.statusJson` reads `recording:false` until
    // `onConsentResult` → `begin`). The same holds for a session another window began. A
    // tile that only polls while it is already drawing a live session therefore never
    // observes the capture its own Start button requested, and keeps saying "not recording"
    // while the top bar's indicator (which polls on an always-on cadence for exactly this
    // reason) is already marking it — two faces of one fact contradicting each other.
    vi.useFakeTimers();
    vi.mocked(screenRecord.screenRecordStatus)
      .mockResolvedValueOnce(idleStatus) // the mount read: nothing is running yet
      .mockResolvedValue({ ...idleStatus, recording: true, started_ms: 1, elapsed_secs: 2 });

    render(ScreenRecordingTile);
    await vi.advanceTimersByTimeAsync(0);
    // The panel draws the idle state and has nothing to show …
    expect(screen.queryByTestId("cc-record-stop")).toBeNull();

    // … but the consent is approved and the capture begins, with nobody telling this panel.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      screen.queryByTestId("cc-record-stop"),
      "the tile must keep polling, or it misses the very session it asked for",
    ).not.toBeNull();
  });
});
