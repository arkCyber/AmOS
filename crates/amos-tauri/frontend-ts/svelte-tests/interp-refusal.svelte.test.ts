/**
 * InterpApp.svelte — a unit-returning command the host REFUSED must not be read as success.
 *
 * `interpret_pause` / `interpret_resume` / `interpret_stop` / `interpret_text` are all
 * `Result<(), String>` on the Rust side, so the host's `Ok(())` reaches `lib/backend.invoke`
 * as the very same `null` a refusal does (REQ-A297). Reading the return value therefore cannot
 * tell them apart — the screen must read the per-command ledger (`bridgeDiag`), the same way
 * `endUtterance` already does for `interpret_end_of_speech`.
 *
 * Before this file the three sites above wrote their local state unconditionally: a refused
 * pause relabelled the button "Resume" while the daemon kept translating, a refused stop
 * cleared `sid`/`running` (claiming an end that never happened, with no handle left to stop the
 * still-running session), and a refused `interpret_text` dropped the user's typed line. The
 * offline suite cannot see any of it (no bridge) and the existing mocks resolve a truthy value
 * rather than `null`, so nothing exercised the refusal direction.
 *
 * Here `lib/backend` is mocked and the ledger is driven per command, so both directions are
 * observable.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

const mock = vi.hoisted(() => ({
  /** command → ok. A command absent from the map is "the host accepted it". */
  diag: new Map<string, boolean>(),
  calls: [] as string[],
  handler: null as null | ((payload: unknown) => void),
  /** `false` = the host refused `interpret_start` (a real `Result<u64>`, so `null` is a refusal). */
  startOk: true,
}));

vi.mock("../src/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backend")>();
  return {
    ...actual,
    bridged: () => true,
    bridgeDiag: (command?: string) => ({ ok: command ? (mock.diag.get(command) ?? true) : true }),
    subscribe: async (_channel: string, cb: (payload: unknown) => void) => {
      mock.handler = cb;
      return () => {};
    },
    interpretStart: async () => (mock.calls.push("interpret_start"), mock.startOk ? 7 : null),
    // The real wrappers are `Promise<unknown>`: the host's `()` arrives as `null`, exactly like a
    // refusal, so the mock resolves `null` in both cases too.
    interpretStop: async () => (mock.calls.push("interpret_stop"), null),
    interpretPause: async () => (mock.calls.push("interpret_pause"), null),
    interpretResume: async () => (mock.calls.push("interpret_resume"), null),
    interpretAudio: async () => null,
    interpretText: async () => (mock.calls.push("interpret_text"), null),
    interpretEndOfSpeech: async () => null,
  };
});

afterEach(() => {
  cleanup();
  mock.diag.clear();
  mock.calls.length = 0;
  mock.handler = null;
  mock.startOk = true;
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
const inputByPlaceholder = (h: { container: HTMLElement }, p: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === p) as
    HTMLInputElement | undefined;

/** Start a session so the control group (pause / stop) is on screen. */
async function start(h: { container: HTMLElement }) {
  await waitFor(() => expect(mock.handler).toBeTruthy());
  fireEvent.click(btn(h, label("interp.start"))!);
  await waitFor(() => expect(endBtn(h)).toBeTruthy());
}

describe("InterpApp.svelte — a refused unit command is not success", () => {
  test("a refused pause is reported and the control still reads 'pause'", async () => {
    const h = render(InterpApp);
    await start(h);

    mock.diag.set("interpret_pause", false);
    fireEvent.click(btn(h, label("interp.pause"))!);

    await waitFor(() => expect(shows(h, "interp.pauseFailed")).toBe(true));
    // The lie this pins: flipping `paused` on a refusal relabelled the button "Resume" while the
    // daemon kept translating.
    expect(btn(h, label("interp.pause"))).toBeTruthy();
    expect(btn(h, label("interp.resume"))).toBeFalsy();
    expect(mock.calls).toContain("interpret_pause");
  });

  test("an accepted pause still flips the control (regression)", async () => {
    const h = render(InterpApp);
    await start(h);

    fireEvent.click(btn(h, label("interp.pause"))!);

    await waitFor(() => expect(btn(h, label("interp.resume"))).toBeTruthy());
    expect(shows(h, "interp.pauseFailed")).toBe(false);
  });

  test("a refused stop is reported and does not claim the session ended", async () => {
    const h = render(InterpApp);
    await start(h);

    mock.diag.set("interpret_stop", false);
    fireEvent.click(btn(h, label("interp.stop"))!);

    await waitFor(() => expect(shows(h, "interp.stopFailed")).toBe(true));
    // The session is still live on the host, so the screen must keep showing it (retryable) —
    // clearing `sid`/`running` left it running with no handle to stop it.
    expect(endBtn(h)).toBeTruthy();
    expect(shows(h, "interp.ended")).toBe(false);
    expect(mock.calls).toContain("interpret_stop");
  });

  test("a refused send keeps the typed text and reports it", async () => {
    const h = render(InterpApp);
    await start(h);
    const input = inputByPlaceholder(h, zh["interp.placeholder"])!;
    await fireEvent.input(input, { target: { value: "你好世界" } });

    mock.diag.set("interpret_text", false);
    fireEvent.click(btn(h, label("interp.send"))!);

    await waitFor(() => expect(shows(h, "interp.sendFailed")).toBe(true));
    // The exact "silent no-op" the offline branch exists to avoid: the line must survive.
    expect(input.value).toBe("你好世界");
    expect(mock.calls).toContain("interpret_text");
  });

  test("an accepted send clears the box (regression)", async () => {
    const h = render(InterpApp);
    await start(h);
    const input = inputByPlaceholder(h, zh["interp.placeholder"])!;
    await fireEvent.input(input, { target: { value: "hello" } });

    fireEvent.click(btn(h, label("interp.send"))!);

    await waitFor(() => expect(input.value).toBe(""));
    expect(shows(h, "interp.sendFailed")).toBe(false);
  });

  test("a refused start is reported instead of a silent no-op", async () => {
    const h = render(InterpApp);
    await waitFor(() => expect(mock.handler).toBeTruthy());

    mock.startOk = false;
    fireEvent.click(btn(h, label("interp.start"))!);

    await waitFor(() => expect(mock.calls).toContain("interpret_start"));
    // A real `Result<u64>`: the host refusing the session arrives as `null`, and the screen used
    // to `return` on it with `status` cleared one line up — a tap that moved nothing and said
    // nothing. The sentence is what the three siblings (pause / resume / stop) already carry.
    await waitFor(() => expect(shows(h, "interp.startFailed")).toBe(true));
    // And no live session may be claimed: `running` never became true, so the mic controls that
    // only exist for a live session must not be there.
    expect(endBtn(h)).toBeFalsy();
  });

  test("an accepted start still opens the session (regression)", async () => {
    const h = render(InterpApp);
    await waitFor(() => expect(mock.handler).toBeTruthy());

    fireEvent.click(btn(h, label("interp.start"))!);

    await waitFor(() => expect(endBtn(h)).toBeTruthy());
    expect(shows(h, "interp.startFailed")).toBe(false);
  });
});
