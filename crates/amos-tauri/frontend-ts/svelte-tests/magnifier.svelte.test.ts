/**
 * DOM tests for the Svelte 5 magnifier (MagnifierApp.svelte) — CONTROL surface.
 *
 * Camera grant → the viewer controls appear; even without a working Canvas 2D /
 * camera (happy-dom) the UI still renders a demo badge + the zoom/brightness/
 * contrast sliders. We verify: the permission gate, moving the zoom slider
 * persists to amos.magnifier, and Reset restores the defaults. (The real
 * magnified lens view needs Canvas 2D + camera → device acceptance.)
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import MagnifierApp from "../src/svelte/MagnifierApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { MAGNIFIER_SETTINGS_KEY } from "../src/lib/magnifier";

afterEach(cleanup);

const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === aria) as
    HTMLInputElement | undefined;
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

async function grantCamera(h: { container: HTMLElement }) {
  await fireEvent.click(buttonContaining(h, "允许") as HTMLButtonElement);
}

describe("MagnifierApp.svelte (control surface)", () => {
  test("shows the camera permission gate before allowing", () => {
    const host = render(MagnifierApp);
    expect(buttonContaining(host, "允许")).toBeTruthy();
    expect(inputByAria(host, "放大倍数")).toBeUndefined();
  });

  test("after allowing, the demo viewer + sliders render", async () => {
    const host = render(MagnifierApp);
    await grantCamera(host);
    expect(txt(host)).toContain("演示画面"); // demo badge (no camera here)
    expect(inputByAria(host, "放大倍数")).toBeTruthy();
    expect(inputByAria(host, "亮度")).toBeTruthy();
    expect(inputByAria(host, "对比度")).toBeTruthy();
  });

  test("moving the zoom slider persists to amos.magnifier", async () => {
    const host = render(MagnifierApp);
    await grantCamera(host);
    const zoom = inputByAria(host, "放大倍数");
    await fireEvent.input(zoom as HTMLInputElement, { target: { value: "4" } });
    expect(txt(host)).toContain("4.0×");
    const stored = readStoreValue<{ zoom?: number }>(MAGNIFIER_SETTINGS_KEY, {});
    expect(stored.zoom).toBe(4);
  });

  test("reset restores the default zoom", async () => {
    const host = render(MagnifierApp);
    await grantCamera(host);
    const zoom = inputByAria(host, "放大倍数");
    await fireEvent.input(zoom as HTMLInputElement, { target: { value: "6" } });
    expect(txt(host)).toContain("6.0×");
    await fireEvent.click(buttonContaining(host, "复位") as HTMLButtonElement);
    expect(txt(host)).toContain("2.0×");
    const stored = readStoreValue<{ zoom?: number }>(MAGNIFIER_SETTINGS_KEY, {});
    expect(stored.zoom).toBe(2);
  });
});
