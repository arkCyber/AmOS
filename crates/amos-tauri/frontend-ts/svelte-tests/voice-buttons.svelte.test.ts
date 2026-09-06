/**
 * DOM tests for the Svelte 5 AI voice buttons (VoiceMicButton / StreamVoiceButton)
 * — OFFLINE state only. Offline (no bridge) both must be disabled with an
 * offline tooltip; real mic capture + ASR/streaming need a device + daemon.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import VoiceMicButton from "../src/svelte/VoiceMicButton.svelte";
import StreamVoiceButton from "../src/svelte/StreamVoiceButton.svelte";

afterEach(cleanup);

const buttonByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === aria,
  ) as HTMLButtonElement | undefined;

describe("Ai voice buttons (offline)", () => {
  test("ASR mic button is disabled + offline title when not bridged", () => {
    const host = render(VoiceMicButton, { props: { online: false, onTranscript: () => {} } });
    const b = buttonByAria(host, "voice input");
    expect(b?.disabled).toBe(true);
    expect(b?.title).toContain("离线"); // ai.streamVoiceOffline
  });

  test("streaming voice button is disabled + offline title when not bridged", () => {
    const host = render(StreamVoiceButton, {
      props: { online: false, session: () => "s", onReply: () => {} },
    });
    const b = buttonByAria(host, "streaming voice input");
    expect(b?.disabled).toBe(true);
    expect(b?.title).toContain("离线"); // ai.streamVoiceOffline
  });
});
