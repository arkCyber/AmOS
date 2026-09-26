/**
 * window-page-split-candidates.svelte.test.ts — 「可分屏窗口」的三态诚实性。
 *
 * The split card's candidate list is a **read of the window host**, and that read has
 * three different answers that the page must not fold into one:
 *
 *   1. **no bridge at all** — the page already says so (`wm-no-host`);
 *   2. **bridged, but the host did not answer** — `lib/wm.ts::wmSplitCandidates`
 *      resolves to `null` (`invoke` folds a thrown command into `null`), so this is
 *      the *silence*, and the page must say the host did not answer;
 *   3. **the host answered** — a list, possibly *empty*: "I have fewer than two of my
 *      own windows to place". That is a fact about the device, and it has its own
 *      sentence.
 *
 * The defect this pins (REQ-A1660 ∕ F-SH-845): `refreshCandidates` used to write
 * `candidates = (await wmSplitCandidates()) ?? [];`, so state (2) was folded into the
 * value of state (3)'s empty answer — and the render then drew the same dash for both
 * (`t("wm.unavailable")`, the page's own word for *no answer*). A user whose host went
 * quiet mid-session saw 「可分屏窗口：—」 with an inert 「进入分屏」 button and no line
 * saying the host had not answered — while the **three sibling reads on the same page**
 * (`winSnap` ∕ `displays` ∕ `stage`) each keep their `null` and each have a dedicated
 * `*-no-answer` line plus an answered-empty sentence. The signature is the carrier: a
 * `string[]` cannot hold "the host said none" and "the host said nothing" apart.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WindowPage from "../src/svelte/settings/WindowPage.svelte";
import { LAYOUT_CHANGED_EVENT, type LayoutSnapshot } from "../src/lib/wm";
import { clearDiag } from "../src/lib/debugLog";
import { zh } from "../src/i18n/locales/zh";

type Listener = (e: { payload: unknown }) => void;
let listeners: Map<string, Listener>;
/** Every bridge call the page made, in order (command + args). */
let calls: Array<{ cmd: string; args?: Record<string, unknown> }>;

/** A bridged host that can answer a split. `multi_window` is what renders the card. */
const snap = (over: Partial<LayoutSnapshot> = {}): LayoutSnapshot => ({
  screen_w: 1280,
  screen_h: 800,
  split: null,
  candidates: [],
  form: "tablet",
  columns: 2,
  multi_window: true,
  free_resize: false,
  divider_gap: 12,
  ...over,
});

/**
 * What `wm_split_candidates` does on the next read: a list (the host's answer, possibly
 * empty) or a **refusal**, which the bridge sees as a throw and `invoke` folds into
 * `null`. Mutable so a test can make the host go quiet mid-view.
 */
let candidateAnswer: () => unknown;

function installHost() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "wm_layout_snapshot") return snap();
      if (cmd === "wm_split_candidates") return candidateAnswer();
      return null;
    },
    listen: async (channel: string, handler: Listener) => {
      listeners.set(channel, handler);
      return () => listeners.delete(channel);
    },
  };
}

/** A host refusal, exactly as a foreground-gated command reports it. */
const refuse = (): never => {
  throw { code: "amos.wm.foreground_required" };
};

const settle = () => new Promise((r) => setTimeout(r, 40));
const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);
const textOf = (c: HTMLElement, id: string) => byTest(c, id)?.textContent?.trim() ?? "";
const push = (s: LayoutSnapshot) => listeners.get(LAYOUT_CHANGED_EVENT)?.({ payload: s });

/** Render the page against the current `candidateAnswer`. */
async function open() {
  installHost();
  const { container } = render(WindowPage);
  await tick();
  await settle();
  return container as HTMLElement;
}

beforeEach(() => {
  listeners = new Map();
  calls = [];
  candidateAnswer = () => [];
  clearDiag();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("WindowPage split candidates", () => {
  test("a refused candidate read is the host's silence, and draws no list at all", async () => {
    candidateAnswer = refuse;
    const container = await open();

    // The card is live (the snapshot answered, `multi_window` is on) …
    const enter = byTest(container, "wm-enter-split") as HTMLButtonElement | null;
    expect(enter, "the split card is rendered").not.toBeNull();
    // … and says the host did not answer — never a drawn list, and never 「—」.
    expect(byTest(container, "wm-candidates")).toBeNull();
    expect(textOf(container, "wm-candidates-no-answer")).toBe(zh["wm.noAnswer"]);
    expect(enter?.disabled, "a list we cannot vouch for never invites a request").toBe(true);

    const before = calls.filter((c) => c.cmd === "wm_split").length;
    await fireEvent.click(enter as Element);
    await tick();
    await settle();
    expect(
      calls.filter((c) => c.cmd === "wm_split").length,
      "a disabled control sends nothing",
    ).toBe(before);
  });

  test("the host's own empty list gets its own sentence, not the silence", async () => {
    candidateAnswer = () => [];
    const container = await open();

    expect(
      byTest(container, "wm-candidates-no-answer"),
      "an answered-empty list is not the host being silent",
    ).toBeNull();
    expect(textOf(container, "wm-candidates")).toBe(
      zh["wm.candidates"].replace("{list}", zh["wm.candidatesEmpty"]),
    );

    const enter = byTest(container, "wm-enter-split") as HTMLButtonElement | null;
    expect(enter?.disabled, "no candidates is below the host's own minimum").toBe(true);
    const before = calls.filter((c) => c.cmd === "wm_split").length;
    await fireEvent.click(enter as Element);
    await tick();
    await settle();
    expect(calls.filter((c) => c.cmd === "wm_split").length).toBe(before);
  });

  test("the host's two candidates are drawn, and the button asks for them", async () => {
    candidateAnswer = () => ["notes", "maps"];
    const container = await open();

    expect(textOf(container, "wm-candidates")).toBe(
      zh["wm.candidates"].replace("{list}", "notes · maps"),
    );
    expect(byTest(container, "wm-candidates-no-answer")).toBeNull();

    const enter = byTest(container, "wm-enter-split") as HTMLButtonElement | null;
    expect(enter?.disabled, "two candidates are the host's own minimum").toBe(false);
    await fireEvent.click(enter as Element);
    await tick();
    await settle();

    const split = calls.filter((c) => c.cmd === "wm_split");
    expect(split.length, "the press asked the host for the split").toBe(1);
    expect(split[0]?.args).toMatchObject({ primary: "notes", secondary: "maps", axis: "auto" });
  });

  test("one candidate is below the minimum: the list is shown, the button stays inert", async () => {
    candidateAnswer = () => ["notes"];
    const container = await open();

    expect(textOf(container, "wm-candidates")).toBe(
      zh["wm.candidates"].replace("{list}", "notes"),
    );
    const enter = byTest(container, "wm-enter-split") as HTMLButtonElement | null;
    expect(enter?.disabled).toBe(true);
  });

  test("a host that goes quiet mid-view flips the line to its silence — the list is not kept", async () => {
    candidateAnswer = () => ["notes", "maps"];
    const container = await open();
    expect(textOf(container, "wm-candidates")).toContain("notes · maps");

    // The host stops answering (a real refusal, or a command that now throws).
    candidateAnswer = refuse;
    push(snap());
    await tick();
    await settle();

    expect(byTest(container, "wm-candidates")).toBeNull();
    expect(textOf(container, "wm-candidates-no-answer")).toBe(zh["wm.noAnswer"]);
  });

  test("…and a host that answers again brings the list back", async () => {
    candidateAnswer = refuse;
    const container = await open();
    expect(byTest(container, "wm-candidates-no-answer")).not.toBeNull();

    candidateAnswer = () => ["notes", "maps"];
    push(snap());
    await tick();
    await settle();

    expect(byTest(container, "wm-candidates-no-answer")).toBeNull();
    expect(textOf(container, "wm-candidates")).toBe(
      zh["wm.candidates"].replace("{list}", "notes · maps"),
    );
  });
});
