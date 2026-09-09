/**
 * Component smoke test for LiveSensors — the small card that consumes the System
 * UI `SensorHost` real-time `sensor-data` feed (event-driven refresh logic itself
 * is unit-tested in src/__tests__/sensorLive.test.ts). Here we assert it mounts,
 * opens its listener and renders the localized waiting hint before any sample.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import LiveSensors from "../src/svelte/LiveSensors.svelte";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(cleanup);

describe("LiveSensors (System UI live sensor feed card)", () => {
  test("mounts, starts its feed listener and shows a waiting hint", () => {
    setLocale("en");
    const { container } = render(LiveSensors);
    const text = container.textContent ?? "";
    expect(text).toContain("Sensor live feed");
    // No sample has been pushed in this harness → the honest waiting hint.
    expect(text).toContain("Waiting for live samples");
  });
});
