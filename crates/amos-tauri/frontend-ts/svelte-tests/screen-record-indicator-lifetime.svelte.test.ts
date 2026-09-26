/**
 * screen-record-indicator-lifetime.svelte.test.ts — the top bar's recording marker must
 * not keep polling the host after the widget it belongs to is gone (REQ-A1611 ∕ F-SH-813).
 *
 * `ScreenRecordIndicator.svelte` polls, rather than listening for an event, because the
 * host pushes nothing when a session starts in another window. It is a **self-rescheduling
 * `setTimeout`**: `poll()` awaits `screen_record_status`, and only *then* arms the next
 * tick. That ordering is the defect. The `onMount` teardown clears whatever `timer` holds
 * at that instant — and at that instant, if the read is still in flight, `timer` is `null`,
 * so nothing is cleared; when the answer lands the continuation arms a fresh timer on a
 * destroyed widget and the loop runs forever (one host call per second or two, for the rest
 * of the process).
 *
 * The sibling `ScreenRecordingTile.svelte` uses a **`setInterval`** whose callback is
 * synchronous and which the teardown `clearInterval`s — no window in which a next tick can
 * be armed after teardown. The repo's `lifetime-scan` R1 finds exactly that shape, and
 * **deliberately excludes `setTimeout`** ("a one-shot timer needs no clear"): a
 * self-rescheduling `setTimeout` is a repeating timer wearing a one-shot's clothes, and no
 * gate sees it. This is the `files-host-watch-lifetime.svelte.test.ts` shape — "an answer
 * that lands after unmount must not leave something running on a dead screen" — for a poll
 * instead of a subscription.
 *
 * Both directions are pinned: the read that lands after unmount must not restart the loop,
 * **and** a mounted widget must keep polling (so a fix of "never arm another tick" fails).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import ScreenRecordIndicator from "../src/svelte/modules/ScreenRecordIndicator.svelte";
import * as screenRecord from "../src/lib/screenRecord";

vi.mock("../src/lib/screenRecord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/screenRecord")>();
  return {
    ...actual,
    screenRecordStatus: vi.fn(),
    screenRecordStop: vi.fn(),
  };
});

const liveStatus: screenRecord.ScreenRecordStatus = {
  recording: true,
  stopping: false,
  started_ms: 1,
  elapsed_secs: 3,
  max_secs: 0,
  out: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(screenRecord.screenRecordStatus).mockResolvedValue(liveStatus);
  vi.mocked(screenRecord.screenRecordStop).mockResolvedValue(liveStatus);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ScreenRecordIndicator.svelte — the poll loop's lifetime", () => {
  test("a status read that lands after unmount does not restart the poll loop", async () => {
    vi.useFakeTimers();

    // Hold the very first read open: the widget is torn down while the host has not answered.
    let release: ((s: screenRecord.ScreenRecordStatus | null) => void) | null = null;
    const first = new Promise<screenRecord.ScreenRecordStatus | null>((r) => (release = r));
    const statusMock = vi.mocked(screenRecord.screenRecordStatus);
    statusMock.mockReturnValueOnce(first);

    const host = render(ScreenRecordIndicator);
    // The mount poll issues its read synchronously; its answer is still in flight.
    expect(statusMock, "the mount poll reads once").toHaveBeenCalledTimes(1);

    // The widget goes away while the answer is outstanding.
    host.unmount();
    expect(statusMock, "unmount cancels nothing that has not been armed yet").toHaveBeenCalledTimes(1);

    // Now the answer arrives — on a component that no longer exists.
    release?.(liveStatus);
    await vi.advanceTimersByTimeAsync(0);

    // A resurrected loop re-reads on its next cadence (1 s live ∕ 2 s idle); a dead one never does.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      statusMock.mock.calls.length,
      "a poll in flight at unmount must not re-arm itself on a dead widget",
    ).toBe(1);
  });

  test("a still-mounted widget keeps polling (the guard is not 'never poll')", async () => {
    vi.useFakeTimers();

    const statusMock = vi.mocked(screenRecord.screenRecordStatus);
    render(ScreenRecordIndicator);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusMock, "the mount poll reads once").toHaveBeenCalledTimes(1);

    // A live session's cadence is one second; step well past it.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(
      statusMock.mock.calls.length,
      "a mounted widget must keep asking the host whether a session is running",
    ).toBeGreaterThanOrEqual(2);
  });
});
