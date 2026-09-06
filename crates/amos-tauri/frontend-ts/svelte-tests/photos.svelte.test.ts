/**
 * DOM tests for the Svelte 5 photos screen (PhotosApp.svelte).
 *
 * Pure photo logic is unit-tested once against lib/photos.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: the seeded grid,
 * opening the single-photo viewer, and multi-select batch delete.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import PhotosApp from "../src/svelte/PhotosApp.svelte";

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === aria) as
    HTMLButtonElement | undefined;
const firstTile = (h: { container: HTMLElement }) =>
  h.container.querySelector(".grid button") as HTMLButtonElement | null;

describe("PhotosApp.svelte", () => {
  test("seeded gallery is non-empty", () => {
    const host = render(PhotosApp);
    expect(txt(host)).not.toContain("暂无照片");
    expect(firstTile(host)).toBeTruthy();
  });

  test("opening a photo shows the viewer; deleting returns to the gallery", async () => {
    const host = render(PhotosApp);
    await fireEvent.click(firstTile(host)!);
    expect(btnAria(host, "上一张")).toBeTruthy(); // viewer open
    const del = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "删除",
    );
    expect(del).toBeTruthy();
    await fireEvent.click(del as HTMLButtonElement);
    expect(btnAria(host, "上一张")).toBeFalsy(); // back to gallery
    expect(txt(host)).toContain("＋ 拍照");
  });

  test("multi-select can batch-delete", async () => {
    const host = render(PhotosApp);
    const selBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim() === "选择",
    );
    expect(selBtn).toBeTruthy();
    await fireEvent.click(selBtn as HTMLButtonElement); // enter select mode
    await fireEvent.click(firstTile(host)!); // select one tile
    const delSel = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("删除所选 (1)"),
    );
    expect(delSel).toBeTruthy();
    await fireEvent.click(delSel as HTMLButtonElement);
    // still a gallery (list shrunk by one); select mode exited
    expect(txt(host)).not.toContain("删除所选");
    expect(firstTile(host)).toBeTruthy();
  });
});
