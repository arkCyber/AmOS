/**
 * AirPlayPanel.svelte — **the refusal has to reach the user** (REQ-A467).
 *
 * The host refuses operations it has no implementation for (`not_implemented`) and reports the
 * platform's own failures (`failed` / `device_not_found` / `permission_denied`). The panel used to
 * log those to the console and render nothing at all, so tapping a device looked like a no-op; and
 * because the backend also *faked* success, it used to draw "已连接" for a receiver nothing had
 * contacted. These tests pin the visible sentence (read out of the dictionaries, so the assertion
 * does not freeze the language) and that a refused discovery does not leave the spinner pinned.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import AirPlayPanel from "../src/svelte/AirPlayPanel.svelte";
import * as airplay from "../src/lib/airplay";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

vi.mock("../src/lib/airplay");

/** The sentence the user should read, in whichever locale the panel is running (zh by default). */
const controlUnavailable = new Set([
  zh["airplay.controlUnavailable"],
  en["airplay.controlUnavailable"],
]);
const failed = new Set([zh["airplay.failed"], en["airplay.failed"]]);

const device: airplay.AirPlayDevice = {
  id: "demo-appletv",
  name: "Living Room Apple TV",
  kind: "appletv",
  supports_video: true,
  supports_audio: true,
  supports_mirroring: true,
  signal_strength: 85,
  connected: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(airplay.isAirPlayAvailable).mockResolvedValue(true);
  vi.mocked(airplay.getDevices).mockResolvedValue([device]);
  vi.mocked(airplay.getStatus).mockResolvedValue({
    active: false,
    device: null,
    stream_kind: null,
    playing: false,
    volume: 0.7,
  });
  vi.mocked(airplay.discoverDevices).mockResolvedValue({ kind: "ok" });
  vi.mocked(airplay.disconnect).mockResolvedValue({ kind: "ok" });
  vi.mocked(airplay.stopDiscovery).mockResolvedValue(undefined);
});

describe("AirPlayPanel.svelte", () => {
  test("a refused connect is shown to the user, and nothing is drawn as connected", async () => {
    vi.mocked(airplay.connect).mockResolvedValue({
      kind: "not_implemented",
      reason: "AirPlay receiver control is not implemented",
    });

    render(AirPlayPanel);
    const name = await screen.findByText("Living Room Apple TV");
    const tile = name.closest("button");
    expect(tile).toBeTruthy();
    await fireEvent.click(tile as HTMLButtonElement);

    const banner = await screen.findByTestId("airplay-error");
    await waitFor(() =>
      expect(controlUnavailable.has(banner.textContent?.trim() ?? "")).toBe(true),
    );
    // The old pair (fake-success backend + console-only panel) rendered “已连接” here.
    expect(screen.queryByText(zh["airplay.connected"])).toBeNull();
    expect(screen.queryByText(en["airplay.connected"])).toBeNull();
  });

  test("a refused discovery explains itself and does not pin the searching spinner", async () => {
    vi.mocked(airplay.discoverDevices).mockResolvedValue({
      kind: "failed",
      reason: "AVRouteDetector requires main thread",
    });
    vi.mocked(airplay.getDevices).mockResolvedValue([]);

    render(AirPlayPanel);
    const banner = await screen.findByTestId("airplay-error");
    await waitFor(() => expect(failed.has(banner.textContent?.trim() ?? "")).toBe(true));

    expect(screen.queryByText(zh["airplay.searching"])).toBeNull();
    expect(screen.queryByText(en["airplay.searching"])).toBeNull();
    expect(airplay.stopDiscovery).not.toHaveBeenCalled();
  });
});
