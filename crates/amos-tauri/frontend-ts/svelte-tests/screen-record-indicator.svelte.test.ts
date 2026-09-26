/**
 * ScreenRecordIndicator.svelte — the top bar's live screen-recording marker (REQ-A1581).
 *
 * What these pin, in the user's language (read out of the dictionaries, so the assertion
 * does not freeze a wording):
 *
 *   * **A live session is visible from the bar**, with the elapsed clock — the whole point
 *     of the widget, since the Control Center tile is behind a popover and the host's
 *     ungated `screen_record_status` rests on there being a marker on screen.
 *   * **Idle and "the host did not answer" both draw nothing.** The negative controls: a
 *     widget that always drew a marker would pass a "live is visible" test alone, and a
 *     missing answer must not be folded into either direction.
 *   * **A refused stop is rendered**, not swallowed — the button must not be a silent
 *     no-op.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import ScreenRecordIndicator from "../src/svelte/modules/ScreenRecordIndicator.svelte";
import * as screenRecord from "../src/lib/screenRecord";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

vi.mock("../src/lib/screenRecord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/screenRecord")>();
  return {
    ...actual,
    screenRecordStatus: vi.fn(),
    screenRecordStop: vi.fn(),
  };
});

const both = (key: keyof typeof zh) => new Set([zh[key], en[key]]);
const refused = both("cc.record.refused");
const stopping = both("cc.record.stopping");

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
  vi.mocked(screenRecord.screenRecordStatus).mockResolvedValue(idleStatus);
  vi.mocked(screenRecord.screenRecordStop).mockResolvedValue(idleStatus);
});

describe("ScreenRecordIndicator.svelte", () => {
  test("a live session puts a marker and its clock in the bar", async () => {
    vi.mocked(screenRecord.screenRecordStatus).mockResolvedValue({
      ...idleStatus,
      recording: true,
      elapsed_secs: 65,
    });

    render(ScreenRecordIndicator);
    const clock = await screen.findByTestId("chrome-record-clock");
    expect(clock.textContent ?? "").toContain("1:05");
    expect(screen.getByTestId("chrome-record-dot")).toBeTruthy();
  });

  test("an idle session draws no marker content", async () => {
    // Negative control: the content is drawn *from* a live read, not unconditionally. The
    // root stays (the bar's container contract — one node per registered module), but it
    // must be empty.
    render(ScreenRecordIndicator);
    // Give the mount poll a turn to resolve before asserting the absence.
    await vi.waitFor(() => expect(screenRecord.screenRecordStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("chrome-record-dot")).toBeNull();
    expect(screen.queryByTestId("chrome-record-stop")).toBeNull();
    expect(screen.getByTestId("chrome-record").textContent?.trim() ?? "").toBe("");
  });

  test("a missing status read draws no marker content either direction", async () => {
    // The host did not answer: neither "recording" nor "not recording" is established, so
    // the bar draws nothing rather than inventing either.
    vi.mocked(screenRecord.screenRecordStatus).mockResolvedValue(null);

    render(ScreenRecordIndicator);
    await vi.waitFor(() => expect(screenRecord.screenRecordStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("chrome-record-dot")).toBeNull();
    expect(screen.queryByTestId("chrome-record-clock")).toBeNull();
  });

  test("a sealing session says so instead of showing a stopped clock", async () => {
    vi.mocked(screenRecord.screenRecordStatus).mockResolvedValue({
      ...idleStatus,
      stopping: true,
      started_ms: 1,
      elapsed_secs: 12,
    });

    render(ScreenRecordIndicator);
    const clock = await screen.findByTestId("chrome-record-clock");
    expect(stopping.has(clock.textContent?.trim() ?? "")).toBe(true);
  });

  test("a refused stop is shown to the user, not swallowed", async () => {
    vi.mocked(screenRecord.screenRecordStatus).mockResolvedValue({
      ...idleStatus,
      recording: true,
      elapsed_secs: 5,
    });
    vi.mocked(screenRecord.screenRecordStop).mockResolvedValue(null);

    render(ScreenRecordIndicator);
    const stop = await screen.findByTestId("chrome-record-stop");
    await fireEvent.click(stop);

    const banner = await screen.findByTestId("chrome-record-refused");
    expect(refused.has(banner.textContent?.trim() ?? "")).toBe(true);
  });
});
