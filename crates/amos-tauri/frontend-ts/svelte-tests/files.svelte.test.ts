/**
 * DOM tests for the Svelte 5 files screen (FilesApp.svelte).
 *
 * Pure filesystem logic is unit-tested once against lib/files.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: the seeded root,
 * creating a folder in the current directory, and navigating into a folder.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;

describe("FilesApp.svelte", () => {
  test("seeded root shows the 文档 folder and a text file", () => {
    const host = render(FilesApp);
    expect(txt(host)).toContain("文档");
    expect(txt(host)).toContain("说明.txt");
  });

  test("creating a folder adds it to the current directory", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "文件夹")!);
    const input = host.container.querySelector('input[aria-label="file-new-name"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await fireEvent.input(input, { target: { value: "工作" } });
    await fireEvent.click(btnContaining(host, "保存")!);
    expect(txt(host)).toContain("工作");
  });

  test("entering the 文档 folder shows the empty state", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "文档")!);
    expect(txt(host)).toContain("空文件夹");
  });
});

describe("FilesApp.svelte — multi-select batch delete (folded from the retired React files-select tests)", () => {
  test("selecting rows and pressing delete removes them all at once", async () => {
    const host = render(FilesApp);
    // seed = folder 文档 + file 说明.txt
    expect(btnContaining(host, "文档")).toBeTruthy();
    expect(btnContaining(host, "说明.txt")).toBeTruthy();

    await fireEvent.click(btnContaining(host, "选择")!); // enter select mode
    await fireEvent.click(btnContaining(host, "文档")!);
    await fireEvent.click(btnContaining(host, "说明.txt")!);
    const del = btnContaining(host, "删除所选");
    expect(del).toBeTruthy();
    await fireEvent.click(del!);
    expect(btnContaining(host, "文档")).toBeUndefined();
    expect(btnContaining(host, "说明.txt")).toBeUndefined();
    expect(txt(host)).toContain("空文件夹");
  });

  test("select-all selects every visible row, then a single delete clears them", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "选择")!);
    const allBtn = btnContaining(host, "全选");
    expect(allBtn?.textContent).toContain("2");
    await fireEvent.click(allBtn!);
    const del = btnContaining(host, "删除所选");
    expect(del?.textContent).toContain("2");
    await fireEvent.click(del!);
    expect(btnContaining(host, "文档")).toBeUndefined();
    expect(btnContaining(host, "说明.txt")).toBeUndefined();
    expect(txt(host)).toContain("空文件夹");
  });
});

