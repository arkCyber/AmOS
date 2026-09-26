/**
 * InterpApp.svelte — the 朗读 (read-aloud) action must report whether audio was produced.
 *
 * `lib/realtimeTts.speakText` answers a boolean ("resolves true when audio was produced"), and
 * both of this screen's call sites dropped it (`void speakText(…)`): the per-row 朗读 button and
 * the auto-read-aloud path. `lib/backend.invoke` never rejects — it answers `null` for a refusal —
 * so a synthesis the host did not answer, or a machine that cannot play what it returned, ended as
 * a wholly silent no-op: no sound, no sentence, no state change, on a button the user pressed.
 *
 * The 复制 button on the **same row** reads its own verdict and says so (`interp-copy-error`), which
 * is what makes the silence a defect rather than a style — and the two are independent gestures, so
 * a successful copy must not blank the read-aloud's refusal (the two-slot rule).
 *
 * The playback half lives in `src/__tests__/tts.test.ts` / `realtimeTts.test.ts`; here `speakText`
 * is mocked so each direction is driveable from the screen.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

const mock = vi.hoisted(() => ({
  calls: [] as string[],
  handler: null as null | ((payload: unknown) => void),
  /** What the next `speakText` answers — "was audio produced?". */
  spoken: true,
}));

vi.mock("../src/lib/realtimeTts", () => ({
  resetPlayCtx: () => {},
  speakText: async (text: string, lang: string) => {
    mock.calls.push(`speak:${lang}:${text}`);
    return mock.spoken;
  },
}));

vi.mock("../src/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backend")>();
  return {
    ...actual,
    bridged: () => true,
    bridgeDiag: () => ({ ok: true }),
    subscribe: async (_channel: string, cb: (payload: unknown) => void) => {
      mock.handler = cb;
      return () => {};
    },
    interpretStart: async () => 7,
    interpretStop: async () => null,
    interpretPause: async () => null,
    interpretResume: async () => null,
    interpretAudio: async () => null,
    interpretText: async () => null,
    interpretEndOfSpeech: async () => null,
  };
});

afterEach(() => {
  cleanup();
  mock.calls.length = 0;
  mock.handler = null;
  mock.spoken = true;
});

const label = (key: string) => new Set([zh[key], en[key]]);
const text = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/** Whether the screen shows any of the locale's renderings of `key`. */
const shows = (h: { container: HTMLElement }, key: string) =>
  [zh[key], en[key]].some((v) => v !== undefined && text(h).includes(v));
const btn = (h: { container: HTMLElement }, needle: Set<string | undefined>) =>
  [...h.container.querySelectorAll("button")].find((b) =>
    needle.has((b.textContent ?? "").trim()),
  ) as HTMLButtonElement | undefined;
const byTestId = (h: { container: HTMLElement }, id: string) =>
  h.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const copyBtn = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find((b) => b.textContent?.includes("⧉"))!;

/** Swap `navigator.clipboard` for `value`; the captured descriptor restores it exactly. */
function withClipboard(value: unknown): () => void {
  const before = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  Object.defineProperty(window.navigator, "clipboard", {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    if (before) Object.defineProperty(window.navigator, "clipboard", before);
    else delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
  };
}

/** Start a session and push one final segment so the row's 朗读 / 复制 buttons exist. */
async function withSegment(h: { container: HTMLElement }) {
  await waitFor(() => expect(mock.handler).toBeTruthy());
  fireEvent.click(btn(h, label("interp.start"))!);
  await waitFor(() =>
    expect(h.container.querySelector('[data-testid="interp-end-sentence"]')).toBeTruthy(),
  );
  mock.handler!({ kind: "segment_final", source_text: "你好", target_text: "Hola", target_lang: "es" });
  await waitFor(() => expect(btn(h, label("interp.read"))).toBeTruthy());
}

describe("InterpApp.svelte — the read-aloud reports whether audio was produced (REQ-A1444)", () => {
  test("a read-aloud that produced no audio says so", async () => {
    const h = render(InterpApp);
    await withSegment(h);

    mock.spoken = false;
    fireEvent.click(btn(h, label("interp.read"))!);

    await waitFor(() => expect(shows(h, "common.speakFailed")).toBe(true));
    expect(byTestId(h, "interp-speak-error")).toBeTruthy();
    expect(mock.calls).toContain("speak:es:Hola");
  });

  test("an accepted read-aloud clears the sentence (regression)", async () => {
    const h = render(InterpApp);
    await withSegment(h);

    mock.spoken = false;
    fireEvent.click(btn(h, label("interp.read"))!);
    await waitFor(() => expect(byTestId(h, "interp-speak-error")).toBeTruthy());

    mock.spoken = true;
    fireEvent.click(btn(h, label("interp.read"))!);
    await waitFor(() => expect(byTestId(h, "interp-speak-error")).toBeNull());
    expect(shows(h, "common.speakFailed")).toBe(false);
  });

  test("the 朗读 refusal and the 复制 refusal are separate slots", async () => {
    const restore = withClipboard(undefined); // the copy is refused — its own sentence
    try {
      const h = render(InterpApp);
      await withSegment(h);

      mock.spoken = false;
      fireEvent.click(copyBtn(h));
      fireEvent.click(btn(h, label("interp.read"))!);

      await waitFor(() => expect(byTestId(h, "interp-copy-error")).toBeTruthy());
      expect(byTestId(h, "interp-speak-error")).toBeTruthy();

      // A successful read-aloud clears its own refusal and must leave the copy's alone.
      mock.spoken = true;
      fireEvent.click(btn(h, label("interp.read"))!);
      await waitFor(() => expect(byTestId(h, "interp-speak-error")).toBeNull());
      expect(byTestId(h, "interp-copy-error")).toBeTruthy();
      expect(shows(h, "common.copyFailed")).toBe(true);
    } finally {
      restore();
    }
  });

  test("auto-read-aloud that produced no audio also says so", async () => {
    const h = render(InterpApp);
    await waitFor(() => expect(mock.handler).toBeTruthy());
    fireEvent.click(btn(h, label("interp.start"))!);
    await waitFor(() =>
      expect(h.container.querySelector('[data-testid="interp-end-sentence"]')).toBeTruthy(),
    );

    const auto = [...h.container.querySelectorAll("input[type=checkbox]")][0] as HTMLInputElement;
    fireEvent.click(auto); // the user turned auto-read-aloud on
    mock.spoken = false;
    mock.handler!({ kind: "segment_final", source_text: "你好", target_text: "Hola", target_lang: "es" });

    await waitFor(() => expect(shows(h, "common.speakFailed")).toBe(true));
    expect(mock.calls).toContain("speak:es:Hola");
  });
});
