/**
 * InterpApp.svelte — the empty-transcript hint must agree with the session state.
 *
 * The transcript pane's placeholder is `t("interp.notRunning")` — "开启会话后即可说话或输入文字"
 * ∕ "Start a session to speak or type" — advice that is only true *before* a session exists.
 * It was rendered on the `running` branch, so the screen told the user to start a session it had
 * already started (its own key's negation), and withheld that advice in the one state it applies
 * to (idle, where the pane showed a bare "—"). REQ-A1812.
 *
 * The offline suite (`interp.svelte.test.ts`) cannot see this: with no bridge `running` is never
 * true, so only the idle half is reachable there. Here `lib/backend` is mocked so a session can
 * actually be opened, and the `interpret-output` handler is captured to drive the transcript.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

const mock = vi.hoisted(() => ({
  handler: null as null | ((payload: unknown) => void),
}));

vi.mock("../src/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backend")>();
  return {
    ...actual,
    bridged: () => true,
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
  mock.handler = null;
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
const endBtn = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="interp-end-sentence"]') as HTMLButtonElement | null;

/** Open a live session so the control group (pause / stop) is on screen and `running` is true. */
async function start(h: { container: HTMLElement }) {
  await waitFor(() => expect(mock.handler).toBeTruthy());
  fireEvent.click(btn(h, label("interp.start"))!);
  await waitFor(() => expect(endBtn(h)).toBeTruthy());
}

describe("InterpApp.svelte — the empty-transcript hint follows the session state", () => {
  test("a live session with no transcript yet does not tell the user to start one", async () => {
    const h = render(InterpApp);
    await start(h);
    // The transcript is empty and nothing is in flight, so the placeholder branch is live.
    expect(text(h)).not.toContain(zh["interp.notRunning"]);
    // The control group proves the session really is running: the placeholder must not name the
    // state the buttons beside it contradict.
    expect(endBtn(h)).toBeTruthy();
  });

  test("the idle pane shows the start-a-session advice (positive control)", async () => {
    const h = render(InterpApp);
    await waitFor(() => expect(mock.handler).toBeTruthy());
    // No session opened: this is the state the sentence is written for.
    expect(shows(h, "interp.notRunning")).toBe(true);
    expect(endBtn(h)).toBeFalsy();
  });

  test("a produced segment replaces the placeholder entirely (control)", async () => {
    const h = render(InterpApp);
    await start(h);
    mock.handler!({
      kind: "segment_final",
      source_text: "hello",
      target_text: "你好",
      source_lang: "en",
      target_lang: "zh",
    });
    // The placeholder branch is guarded by `segs.length === 0`, so a real segment clears it in
    // both states — this control holds before and after the fix, proving the harness drives the
    // transcript (and that the fix did not simply hide the hint everywhere).
    await waitFor(() => expect(text(h)).toContain("你好"));
    expect(shows(h, "interp.notRunning")).toBe(false);
  });
});
