/**
 * InterpApp.svelte — "end this sentence" (`interpret_end_of_speech`, REQ-A741).
 *
 * The Rust command and its four i18n strings existed for a while, but nothing ever called it:
 * `scripts/tauri-command-allowlist.json` recorded the reason verbatim — "a 'finish this sentence'
 * affordance does not exist yet" — and the strings sat in `scripts/i18n-allowlist.json` under the
 * same excuse. Both allow-list entries are gone with this screen wiring, so this file is what keeps
 * the declaration honest: the button must actually reach the command, and a session with nothing in
 * flight must say so rather than fire a no-op.
 *
 * The offline suite cannot see this (no bridge); here `lib/backend` is mocked so the daemon "is
 * there" and the command call is observable.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

const mock = vi.hoisted(() => ({
  endOfSpeech: vi.fn(async () => null),
  // The command returns `()` (both success and failure look like `null` through `invoke`), so the
  // screen reads the outcome from `bridgeDiag`. This drives that ledger for the test.
  diagOk: true,
  handler: null as null | ((payload: unknown) => void),
}));

vi.mock("../src/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backend")>();
  return {
    ...actual,
    bridged: () => true,
    bridgeDiag: (command?: string) =>
      command === "interpret_end_of_speech" ? { ok: mock.diagOk } : { ok: true },
    subscribe: async (_channel: string, cb: (payload: unknown) => void) => {
      mock.handler = cb;
      return () => {};
    },
    interpretStart: async () => 7,
    interpretStop: async () => true,
    interpretPause: async () => true,
    interpretResume: async () => true,
    interpretAudio: async () => true,
    interpretText: async () => true,
    interpretEndOfSpeech: mock.endOfSpeech,
  };
});

afterEach(() => {
  cleanup();
  mock.endOfSpeech.mockClear();
  mock.diagOk = true;
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

/** Start a session so the control group (and with it the end-sentence button) is on screen. */
async function start(h: { container: HTMLElement }) {
  await waitFor(() => expect(mock.handler).toBeTruthy());
  fireEvent.click(btn(h, label("interp.start"))!);
  await waitFor(() => expect(endBtn(h)).toBeTruthy());
}

describe("InterpApp.svelte — end this sentence", () => {
  test("a sentence in flight is force-ended: the button reaches the command with the session id", async () => {
    const h = render(InterpApp);
    await start(h);

    // The daemon reports an in-flight partial — the screen's only honest signal that there is a
    // sentence to end.
    mock.handler!({ kind: "partial", text: "hello wor" });
    await waitFor(() => expect(text(h)).toContain("hello wor"));

    fireEvent.click(endBtn(h)!);
    await waitFor(() => expect(mock.endOfSpeech).toHaveBeenCalledWith(7));
  });

  test("nothing in flight: the button explains instead of firing a no-op command", async () => {
    const h = render(InterpApp);
    await start(h);

    fireEvent.click(endBtn(h)!);
    await waitFor(() => expect(shows(h, "interp.endNone")).toBe(true));
    expect(mock.endOfSpeech).not.toHaveBeenCalled();
  });

  test("a rejected command surfaces the failure, not silence", async () => {
    const h = render(InterpApp);
    await start(h);
    mock.handler!({ kind: "partial", text: "half a thought" });
    await waitFor(() => expect(text(h)).toContain("half a thought"));

    mock.diagOk = false;
    fireEvent.click(endBtn(h)!);
    await waitFor(() => expect(shows(h, "interp.endFailed")).toBe(true));
  });
});
