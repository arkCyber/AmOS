/**
 * recordings-page.svelte.test.ts — the 通话录音 page must keep two facts apart (REQ-A1334):
 *
 *   1. **the ledger** — which recordings exist (`recordings_list`), where an empty list is the
 *      *normal* first state, not an error; and
 *   2. **the capture capability** — whether this build can record at all
 *      (`recordings_capture_status`), which is the **only** thing allowed to say "you cannot
 *      record here".
 *
 * The defect this guards against is not hypothetical for this repo: a listing that shows an empty
 * state implies "there is nothing *yet*", i.e. "recording works, you just have none". On a build
 * where nothing can mint a recording file, that is a lie about a capability — so an empty list with
 * capture unavailable must draw the capture notice, never the plain empty message.
 *
 * Also pinned: a **refused** delete must not remove the row from the drawn list. `recording_delete`
 * answers the surviving ledger, and `invoke` resolves `null` on failure — if the page optimistically
 * dropped the row it would paint a refusal as a deletion.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import RecordingsPage from "../src/svelte/settings/RecordingsPage.svelte";

type Internals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

/** Point the page's `invoke` at a per-test handler before it mounts. */
function stubInvoke(fn: Internals["invoke"]) {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: fn,
    listen: async () => () => {},
  };
}

const REC_A = {
  call_id: "tel_a",
  peer: "13800138000",
  started_at: 1726560000,
  duration_sec: 65,
  file_size_bytes: 1_500_000,
};
const REC_B = {
  call_id: "tel_b",
  peer: "10086",
  started_at: 1726563600,
  duration_sec: 3725,
  file_size_bytes: 300,
};

/** Let the page's `onMount` promise chain settle. */
async function settle() {
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RecordingsPage", () => {
  test("an empty ledger with capture unavailable draws the capture notice, not a bare 'no recordings'", async () => {
    const HOST_REASON =
      "call recording needs AmOS to be the device's default phone app (ROLE_DIALER), so an in-call service is bound";
    stubInvoke(async (cmd) => {
      if (cmd === "recordings_list") return [];
      if (cmd === "recordings_capture_status")
        return { available: false, reason: HOST_REASON };
      return null;
    });
    const { container } = render(RecordingsPage);
    await settle();

    expect(container.querySelector('[data-testid="recordings-capture-unavailable"]')).not.toBeNull();
    // The host's own words are shown verbatim, not paraphrased or translated away.
    expect(container.querySelector('[data-testid="recordings-capture-reason"]')?.textContent).toBe(
      HOST_REASON,
    );
    // The mic-only boundary must NOT be drawn here — it is about capture that *works*.
    expect(container.querySelector('[data-testid="recordings-mic-only-note"]')).toBeNull();
    // It is a *different* sentence from the empty-list one — an empty list alone must not be
    // presented as "you have no recordings" when recording is impossible here.
    expect(container.querySelector('[data-testid="recordings-empty"]')?.textContent ?? "").not.toBe(
      container.querySelector('[data-testid="recordings-capture-unavailable"]')?.textContent ?? "x",
    );
  });

  test("an empty ledger with capture available draws the plain empty message and the mic-only boundary", async () => {
    stubInvoke(async (cmd) => {
      if (cmd === "recordings_list") return [];
      if (cmd === "recordings_capture_status") return { available: true, reason: "" };
      return null;
    });
    const { container } = render(RecordingsPage);
    await settle();

    expect(container.querySelector('[data-testid="recordings-empty"]')).not.toBeNull();
    // The two "off" sentences are mutually exclusive: a build that *can* record draws the
    // boundary about what it captures, never the "unavailable" notice (REQ-A1579).
    expect(container.querySelector('[data-testid="recordings-capture-unavailable"]')).toBeNull();
    expect(container.querySelector('[data-testid="recordings-mic-only-note"]')?.textContent?.trim())
      .not.toBe("");
  });

  test("a row names the audio source the recorder actually used", async () => {
    stubInvoke(async (cmd) => {
      if (cmd === "recordings_list")
        return [
          { ...REC_A, source: "voice_call" },
          { ...REC_B, source: "voice_communication" },
        ];
      if (cmd === "recordings_capture_status") return { available: true, reason: "" };
      return null;
    });
    const { container } = render(RecordingsPage);
    await settle();

    const rows = [...container.querySelectorAll('[data-testid="recording-row"]')];
    expect(rows).toHaveLength(2);
    // Newest first: REC_B (10086) carries the near-end source, REC_A the two-sided one. Asserted
    // on the *source word* (a locale-independent attribute), while the visible label is
    // localized — the test env's locale must not decide whether this passes.
    const sourceOf = (row: Element) =>
      row.querySelector('[data-testid="recording-source"]')?.getAttribute("data-source");
    expect(sourceOf(rows[0])).toBe("voice_communication");
    expect(sourceOf(rows[1])).toBe("voice_call");
    // Each row shows a non-empty localized label for that source.
    for (const row of rows) {
      expect(
        row.querySelector('[data-testid="recording-source"]')?.textContent?.trim(),
      ).not.toBe("");
    }
  });

  test("a row written before the source existed draws no source claim", async () => {
    stubInvoke(async (cmd) => {
      if (cmd === "recordings_list") return [REC_A]; // no `source` field
      if (cmd === "recordings_capture_status") return { available: true, reason: "" };
      return null;
    });
    const { container } = render(RecordingsPage);
    await settle();

    const row = container.querySelector('[data-testid="recording-row"]')!;
    // Absent must stay absent — never rounded up to a source the row never recorded.
    expect(row.querySelector('[data-testid="recording-source"]')).toBeNull();
  });

  test("the ledger rows render newest-first", async () => {
    stubInvoke(async (cmd) => {
      if (cmd === "recordings_list") return [REC_A, REC_B]; // A is older
      if (cmd === "recordings_capture_status") return { available: false, reason: "wired later" };
      return null;
    });
    const { container } = render(RecordingsPage);
    await settle();

    const rows = [...container.querySelectorAll('[data-testid="recording-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("10086"); // the newer one
    expect(rows[1].textContent).toContain("13800138000");
  });

  test("a refused delete keeps the row and shows the refusal", async () => {
    stubInvoke(async (cmd) => {
      if (cmd === "recordings_list") return [REC_A];
      if (cmd === "recordings_capture_status") return { available: false, reason: "x" };
      if (cmd === "recording_delete") return null; // refused / host did not answer
      return null;
    });
    const { container } = render(RecordingsPage);
    await settle();

    const del = container.querySelector<HTMLElement>('[data-testid="recording-delete"]')!;
    await fireEvent.click(del);
    await settle();

    // The row is still drawn — a refusal must not be painted as a deletion.
    expect(container.querySelectorAll('[data-testid="recording-row"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="recording-delete-refused"]')).not.toBeNull();
  });

  test("a successful delete repaints from the host's surviving ledger", async () => {
    stubInvoke(async (cmd) => {
      if (cmd === "recordings_list") return [REC_A, REC_B];
      if (cmd === "recordings_capture_status") return { available: false, reason: "x" };
      if (cmd === "recording_delete") return [REC_B]; // the surviving ledger
      return null;
    });
    const { container } = render(RecordingsPage);
    await settle();

    const rows = [...container.querySelectorAll('[data-testid="recording-row"]')];
    const target = rows.find((r) => r.textContent?.includes("13800138000"))!;
    await fireEvent.click(target.querySelector<HTMLElement>('[data-testid="recording-delete"]')!);
    await settle();

    expect(container.querySelectorAll('[data-testid="recording-row"]')).toHaveLength(1);
    expect(container.textContent).toContain("10086");
    expect(container.textContent).not.toContain("13800138000");
  });

  test("an unreadable ledger is not drawn as an empty one", async () => {
    stubInvoke(async (cmd) => {
      if (cmd === "recordings_list") return null; // the read failed
      if (cmd === "recordings_capture_status") return { available: true, reason: "" };
      return null;
    });
    const { container } = render(RecordingsPage);
    await settle();

    expect(container.querySelector('[data-testid="recordings-unreadable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recordings-empty"]')).toBeNull();
  });
});
