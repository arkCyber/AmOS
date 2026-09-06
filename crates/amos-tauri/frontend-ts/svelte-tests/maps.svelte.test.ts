/**
 * DOM tests for the Svelte 5 maps screen (MapsApp.svelte) — offline path.
 *
 * The map is fully pure over lib/maps.ts: slippy OSM tiles, city chips + search,
 * pan/zoom. "定位" honours the system location master switch (offline-testable)
 * while the real device fix needs navigator.geolocation (device acceptance).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import MapsApp from "../src/svelte/MapsApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_KEY } from "../src/lib/settings";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByPlaceholder = (h: { container: HTMLElement }, ph: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === ph) as
    HTMLInputElement | undefined;

describe("MapsApp.svelte (offline path)", () => {
  test("renders city chips + a Beijing header and 9 map tiles when online", () => {
    const host = render(MapsApp);
    expect(txt(host)).toContain("北京");
    expect(buttonContaining(host, "上海")).toBeTruthy();
    const imgs = host.container.querySelectorAll("img");
    expect(imgs.length).toBe(9); // SPAN x SPAN = 9 OSM tiles
  });

  test("searching a city recenters the header label", async () => {
    const host = render(MapsApp);
    const input = inputByPlaceholder(host, "搜索城市：北京/上海/广州/深圳/成都/杭州");
    await fireEvent.input(input as HTMLInputElement, { target: { value: "上海" } });
    await fireEvent.keyDown(input as HTMLInputElement, { key: "Enter" });
    // Header shows the newly selected city label.
    const header = host.container.querySelector(".opacity-70 > span");
    expect(header?.textContent).toContain("上海");
  });

  test("going offline shows the offline placeholder instead of tiles", async () => {
    const host = render(MapsApp);
    expect(host.container.querySelectorAll("img").length).toBe(9);
    window.dispatchEvent(new Event("offline"));
    await new Promise((r) => setTimeout(r, 20));
    expect(txt(host)).toContain("离线地图");
    expect(host.container.querySelectorAll("img").length).toBe(0);
  });

  test("定位 respects the system location master switch (off → locOff)", async () => {
    writeStoreValue(SETTINGS_KEY, { location: false });
    const host = render(MapsApp);
    await fireEvent.click(buttonContaining(host, "定位") as HTMLButtonElement);
    expect(txt(host)).toContain("位置服务已关闭");
  });

  test("zoom in raises the rendered tile zoom level", async () => {
    const host = render(MapsApp);
    const before = [...host.container.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
    expect(before[0]).toContain("/12/");
    const zoomIn = host.container.querySelector('button[aria-label="zoom in"]') as HTMLButtonElement;
    await fireEvent.click(zoomIn);
    const after = [...host.container.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
    expect(after[0]).toContain("/13/");
  });
});
