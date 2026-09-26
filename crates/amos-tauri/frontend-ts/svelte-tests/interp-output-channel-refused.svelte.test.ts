/**
 * InterpApp.svelte — the one event subscription must read BOTH halves of its verdict.
 *
 * REQ-A838 made `subscribe()` answer `null` when the host did **not** establish the channel
 * (a refused `plugin:event|listen`), so a screen can tell a live channel from a dead one. The
 * backend's own doc states the stakes for this screen verbatim: a refused listen "means **no
 * event will ever arrive** — the surface stays up and simply never updates, which is
 * indistinguishable from a quiet channel".
 *
 * InterpApp read neither half. It pushed `await subscribe(...)` straight into `unsubs`, so:
 *
 *  * a **refused** listen produced no sentence at all — a session that starts still shows the
 *    mic on, the language pair and the state chip, while the transcript can never fill. The
 *    sibling `RobotApp.svelte` (same REQ-A838 change) renders its refused stream rather than
 *    leaving it looking quiet;
 *  * a handle that resolved **after** teardown was pushed onto a list the cleanup had already
 *    drained, so the subscription stayed alive for the window's life — `RobotApp` releases it
 *    with `if (destroyed) { un(); return; }`.
 *
 * `lib/backend` is mocked so both directions are observable: what `subscribe` resolves to, and
 * when. The offline suite cannot reach this (no bridge at all ⇒ `online` is false).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

const mock = vi.hoisted(() => ({
  /** What `subscribe` resolves to: a live unsubscribe, or `null` for a refused listen. */
  result: null as (() => void) | null,
  /** When set, `subscribe` awaits this before resolving (to land after teardown). */
  gate: null as null | Promise<void>,
  handler: null as null | ((payload: unknown) => void),
}));

vi.mock("../src/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backend")>();
  return {
    ...actual,
    bridged: () => true,
    bridgeDiag: () => ({ ok: true }),
    subscribe: async (_channel: string, cb: (payload: unknown) => void) => {
      mock.handler = cb;
      if (mock.gate) await mock.gate;
      return mock.result;
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
  mock.result = null;
  mock.gate = null;
  mock.handler = null;
});

const text = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/** Whether the screen shows any of the locale's renderings of `key`. */
const shows = (h: { container: HTMLElement }, key: string) =>
  [zh[key], en[key]].some((v) => v !== undefined && text(h).includes(v));

describe("InterpApp.svelte — the result channel's verdict is read", () => {
  test("a refused result channel is reported, not left looking like a quiet one", async () => {
    mock.result = null;
    const h = render(InterpApp);
    await waitFor(() => expect(shows(h, "interp.outputRefused")).toBe(true));
  });

  test("an established channel shows no sentence and still feeds the transcript", async () => {
    mock.result = () => {};
    const h = render(InterpApp);
    await waitFor(() => expect(mock.handler).toBeTruthy());

    // Positive control: the fix must not be "always say refused". A live channel is silent
    // about itself, and an event it carries still reaches the screen.
    expect(shows(h, "interp.outputRefused")).toBe(false);
    mock.handler!({ kind: "partial", text: "你好世界" });
    await waitFor(() => expect(text(h)).toContain("你好世界"));
  });

  test("an unsubscribe that lands after unmount is released, not dropped", async () => {
    let released = 0;
    mock.result = () => {
      released += 1;
    };
    let releaseSubscribe!: () => void;
    mock.gate = new Promise<void>((r) => {
      releaseSubscribe = r;
    });

    const h = render(InterpApp);
    await waitFor(() => expect(mock.handler).toBeTruthy());

    // The widget is gone before the listen resolves: the cleanup has already drained `unsubs`,
    // so the continuation has to release the handle itself.
    h.unmount();
    releaseSubscribe();
    await waitFor(() => expect(released).toBe(1));
  });
});
