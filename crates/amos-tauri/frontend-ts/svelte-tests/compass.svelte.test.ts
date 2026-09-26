/**
 * DOM tests for the Svelte 5 compass screen (CompassApp.svelte).
 *
 * Pure heading/level math is unit-tested once against lib/compass.ts. Here we
 * verify the screen wiring that has no pure seam: the compass/level tab bar
 * announces which view is active to assistive tech (REQ-A970).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import CompassApp from "../src/svelte/CompassApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  setLocale("zh");
  delete (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent;
});

const tabByText = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((b) =>
    (b.textContent ?? "").includes(s),
  );

/**
 * Make `isOrientationSupported()` true and `requestOrientationPermission()` grant.
 * A plain function (no `requestPermission` property) is exactly the non-iOS shape:
 * the permission call resolves `true` without any prompt.
 */
function stubOrientationSupport() {
  (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent =
    function () {};
}

/**
 * The API **exists** but the platform answers the permission prompt with `answer`
 * (the iOS 13+ shape: a `requestPermission` static that resolves a string). Use
 * `"denied"` to reach the permission panel without granting.
 */
function stubOrientationWithPermission(answer: string) {
  const ctor = function () {} as unknown as { requestPermission: () => Promise<string> };
  ctor.requestPermission = () => Promise.resolve(answer);
  (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = ctor;
}

/** Flush the `onMount` microtask chain that ends in `addEventListener`. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * A `deviceorientation` frame. `alpha` is the heading (magnetometer), `beta`/`gamma`
 * the tilt (accelerometer) — a device without a magnetometer reports `alpha: null`
 * while still delivering the other two.
 */
function fireOrientation(alpha: number | null, beta: number | null, gamma: number | null) {
  window.dispatchEvent(Object.assign(new Event("deviceorientation"), { alpha, beta, gamma }));
}

async function mountWithSensor() {
  stubOrientationSupport();
  const host = render(CompassApp);
  await settle();
  return host;
}

// REQ-A970: the compass/level switch is a tab bar, but it was the ONE tab bar in the
// tree without `role="tablist"` / `role="tab"` / `aria-selected` — ClockApp,
// CalendarApp, PhoneApp and CameraApp all use that idiom. The active tab was drawn
// only by `tabCls` (a border/text colour), so AT read an unchanging name in both states.
describe("CompassApp.svelte tab bar", () => {
  test("the tab list and its tabs expose the selected view to AT", async () => {
    const host = render(CompassApp);
    expect(host.container.querySelector('[role="tablist"]')).toBeTruthy();
    const compass = tabByText(host, zh["compass.compass"]);
    const level = tabByText(host, zh["compass.level"]);
    expect(compass).toBeTruthy();
    expect(level).toBeTruthy();
    expect(compass!.getAttribute("aria-selected")).toBe("true");
    expect(level!.getAttribute("aria-selected")).toBe("false");
    await fireEvent.click(level as HTMLElement);
    expect(level!.getAttribute("aria-selected")).toBe("true");
    expect(compass!.getAttribute("aria-selected")).toBe("false");
  });
});

// REQ-A1275 / F-SH-550: `alpha` (the heading) needs a magnetometer; `beta`/`gamma`
// (the tilt) come from the accelerometer and keep arriving without one. The screen
// folded both into a single `reading.available`, so the moment `alpha` was null it
// threw away the tilt in that very event AND put "设备方向传感器不可用" on both
// tabs — the bubble level was unreachable on a device that can plainly measure tilt.
describe("CompassApp.svelte orientation availability (REQ-A1275)", () => {
  test("a device with no magnetometer says the heading is missing, not the sensor", async () => {
    const host = await mountWithSensor();
    fireOrientation(null, 30, 5);
    await settle();

    // The compass tab names the *heading* as the missing thing — not the sensor.
    expect(host.container.querySelector('[data-testid="compass-no-heading"]')).toBeTruthy();
    expect(host.container.textContent).toContain(zh["compass.noHeading"]);
    expect(host.container.textContent).not.toContain(zh["compass.unavailable"]);
  });

  test("a device with no magnetometer (alpha null) still gets a working level", async () => {
    const host = await mountWithSensor();
    fireOrientation(null, 30, 5);
    await settle();

    await fireEvent.click(tabByText(host, zh["compass.level"]) as HTMLElement);
    const levelText = host.container.textContent ?? "";
    expect(levelText).not.toContain(zh["compass.unavailable"]);
    expect(levelText).toContain(zh["compass.levelAdjust"]);
    // The tilt from the very event whose heading was absent is on screen.
    expect(levelText).toContain("30.0");
    expect(levelText).toContain("5.0");
  });

  test("a device with a magnetometer shows the heading and keeps its level", async () => {
    const host = await mountWithSensor();
    fireOrientation(90, 0, 0);
    await settle();

    expect(host.container.querySelector('[data-testid="compass-no-heading"]')).toBeNull();
    expect(host.container.textContent).not.toContain(zh["compass.noHeading"]);
    // 360 - 90 = 270° → 西 (the rose's own "270" label is not the cardinal word).
    expect(host.container.textContent).toContain("西");

    await fireEvent.click(tabByText(host, zh["compass.level"]) as HTMLElement);
    expect(host.container.textContent).not.toContain(zh["compass.unavailable"]);
  });

  test("with no orientation frames at all the sensor is reported unavailable", async () => {
    const host = await mountWithSensor();
    expect(host.container.querySelector('[data-testid="compass-no-heading"]')).toBeNull();
    expect(host.container.textContent).toContain(zh["compass.unavailable"]);
  });
});

// REQ-A1510 / F-SH-755: a frame may report only one of the two tilt axes — they are
// two independent sensor fields. The screen folded the absent one to `0`, so an
// unmeasured axis drew the bubble on the centre line and printed `0.0°`, and (with
// the measured axis inside the 2° band) let the level tab claim 「已水平」 over a
// frame that never measured it. An unmeasured axis must read 「—」 and withhold the
// verdict — never a plausible-looking zero.
describe("CompassApp.svelte partial tilt (REQ-A1510)", () => {
  test("a frame with one tilt axis missing refuses the level verdict", async () => {
    const host = await mountWithSensor();
    // beta = 1 (measured, inside the 2° band), gamma = null (not measured this frame).
    fireOrientation(null, 1, null);
    await settle();

    await fireEvent.click(tabByText(host, zh["compass.level"]) as HTMLElement);
    const levelText = host.container.textContent ?? "";

    // The unmeasured axis must not be drawn as level: no 「已水平」 claim…
    expect(levelText).not.toContain(zh["compass.levelAchieved"]);
    // …and the screen names the reason instead.
    expect(host.container.querySelector('[data-testid="compass-partial-tilt"]')).toBeTruthy();
    expect(levelText).toContain(zh["compass.tiltIncomplete"]);

    // The unmeasured axis reads 「—」; the measured one keeps its real value.
    const x = host.container.querySelector('[data-testid="compass-tilt-x"]');
    const y = host.container.querySelector('[data-testid="compass-tilt-y"]');
    expect(x?.textContent?.trim()).toBe("—");
    expect(y?.textContent?.trim()).toBe("1.0°");
  });

  test("a frame with both tilt axes measured still gives the verdict", async () => {
    const host = await mountWithSensor();
    fireOrientation(null, 1, 1);
    await settle();

    await fireEvent.click(tabByText(host, zh["compass.level"]) as HTMLElement);
    const levelText = host.container.textContent ?? "";

    expect(levelText).toContain(zh["compass.levelAchieved"]);
    expect(host.container.querySelector('[data-testid="compass-partial-tilt"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="compass-tilt-x"]')?.textContent?.trim()).toBe(
      "1.0°",
    );
  });
});

// REQ-A1519 / F-SH-761: a platform with no `DeviceOrientationEvent` **at all** has no
// permission to grant. `requestOrientationPermission()` answers `false` forever there,
// so the screen fell into its `!permissionGranted` arm and offered 「需要权限」 plus an
// 「启用传感器」 button whose only effect was `requestOrientationPermission()` (again
// `false`) followed by `window.location.reload()` — straight back into the same panel.
// The capability fact (`isOrientationSupported()`) and the permission fact are two
// facts; the render must read the first rather than fold it into "not yet granted".
describe("CompassApp.svelte without the orientation API (REQ-A1519)", () => {
  test("a platform with no orientation API says the sensor is unavailable, not 'needs permission'", async () => {
    // No stub: `DeviceOrientationEvent` stays undefined, exactly a desktop WebView.
    const host = render(CompassApp);
    await settle();

    expect(host.container.querySelector('[data-testid="compass-unsupported"]')).toBeTruthy();
    expect(host.container.textContent).toContain(zh["compass.unavailable"]);
    // The remedy that cannot work must be gone: no permission prompt, no button.
    expect(host.container.textContent).not.toContain(zh["compass.permissionRequired"]);
    expect(host.container.textContent).not.toContain(zh["compass.enableSensor"]);
  });

  test("positive control: the API present but permission denied still shows the permission panel", async () => {
    // The capability is present; the *permission* is what is missing. This must NOT
    // be collapsed into the unsupported message — otherwise "always say unsupported"
    // would pass the test above.
    stubOrientationWithPermission("denied");
    const host = render(CompassApp);
    await settle();

    expect(host.container.textContent).toContain(zh["compass.permissionRequired"]);
    expect(host.container.textContent).toContain(zh["compass.enableSensor"]);
    expect(host.container.querySelector('[data-testid="compass-unsupported"]')).toBeNull();
  });
});
