/**
 * InterpApp.svelte — the **daemon's** session state reaches the screen (REQ-A470).
 *
 * The offline suite (`interp.svelte.test.ts`) runs with no bridge at all, so it cannot see the
 * `interpret-output` subscription. This file mocks `lib/backend` to say the daemon *is* there and
 * to capture that subscription. Before this change the header showed only what the screen itself
 * did (start / stop / pause), so while the daemon was translating it still showed the language
 * pair — even though the daemon emits `state_changed` on every transition.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

const captured = vi.hoisted(() => ({
  seen: [] as string[],
  handler: null as null | ((payload: unknown) => void),
}));

vi.mock("../src/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backend")>();
  return {
    ...actual,
    bridged: () => true,
    subscribe: async (channel: string, cb: (payload: unknown) => void) => {
      captured.seen.push(channel);
      captured.handler = cb;
      return () => {};
    },
    interpretStart: async () => 1,
    interpretStop: async () => true,
    interpretPause: async () => true,
    interpretResume: async () => true,
    interpretAudio: async () => true,
    interpretText: async () => true,
  };
});

afterEach(() => {
  cleanup();
  captured.seen.length = 0;
  captured.handler = null;
});

/** The localized sentence, in whichever locale the screen is running (zh by default). */
const label = (key: string) => new Set([zh[key], en[key]]);
const chip = (host: { container: HTMLElement }) =>
  host.container.querySelector('[data-testid="interp-state"]') as HTMLElement | null;
const chipText = (host: { container: HTMLElement }) => chip(host)?.textContent?.trim() ?? "";

describe("InterpApp.svelte — the daemon's own session state", () => {
  test("every state the daemon reports is rendered, and ended is left to the status line", async () => {
    const host = render(InterpApp);

    // The screen opens the stream subscription on mount (it is `online` now).
    await waitFor(() => expect(captured.handler).toBeTruthy());
    expect(captured.seen).toContain("interpret-output");
    // Nothing is claimed before the daemon says anything.
    expect(chip(host)).toBeNull();

    const states: [string, string][] = [
      ["starting", "interp.state.starting"],
      ["collecting", "interp.state.collecting"],
      ["interpreting", "interp.state.interpreting"],
      ["speaking", "interp.state.speaking"],
      ["paused", "interp.state.paused"],
    ];
    for (const [token, key] of states) {
      captured.handler!({ kind: "state_changed", state: token });
      await waitFor(() =>
        expect(label(key).has(chipText(host)), `${token} must render its label`).toBe(true),
      );
    }

    // `ended` is carried by the status line (with the daemon's own words); the chip must not repeat
    // the same fact — one fact, one place.
    captured.handler!({ kind: "state_changed", state: "ended" });
    await waitFor(() => expect(chip(host)).toBeNull());

    // A state this screen has no label for is **surfaced as-is**, never hidden: `t()` falls back to
    // the key, so the gap is visible instead of silent (the same posture `aiEngine` takes for an
    // unknown value).
    captured.handler!({ kind: "state_changed", state: "recalibrating" });
    await waitFor(() =>
      expect(chipText(host)).toBe("interp.state.recalibrating"),
    );
  });
});
