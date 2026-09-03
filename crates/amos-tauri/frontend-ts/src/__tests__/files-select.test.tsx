import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { AppComponent } from "../apps";
import { FILES_KEY } from "../lib/files";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.removeItem(FILES_KEY);
});

function mountFiles() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <AppComponent id="files" />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

const row = (host: HTMLElement, name: string) =>
  Array.from(host.querySelectorAll('[role="button"]')).find(
    (el) => (el.textContent ?? "").includes(name),
  ) as HTMLElement | undefined;

const btn = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text)) as
    | HTMLButtonElement
    | undefined;

describe("files multi-select batch delete", () => {
  test("selecting rows and pressing delete removes them all at once", async () => {
    const host = mountFiles();
    await act(async () => {});
    // seed = folder 文档 + file 说明.txt
    expect(row(host, "文档")).toBeTruthy();
    expect(row(host, "说明.txt")).toBeTruthy();

    await act(async () => {
      btn(host, "选择")?.click(); // enter select mode
    });
    await act(async () => {
      row(host, "文档")?.click();
      row(host, "说明.txt")?.click();
    });
    await act(async () => {
      btn(host, "删除所选")?.click(); // delete both
    });
    expect(row(host, "文档")).toBeUndefined();
    expect(row(host, "说明.txt")).toBeUndefined();
    expect(host.textContent).toContain("空文件夹");
  });

  test("select-all selects every visible row, then a single delete clears them", async () => {
    const host = mountFiles();
    await act(async () => {});
    await act(async () => {
      btn(host, "选择")?.click();
    });
    expect(btn(host, "全选")?.textContent).toContain("2");
    await act(async () => {
      btn(host, "全选")?.click(); // select both visible rows
    });
    expect(btn(host, "删除所选")?.textContent).toContain("2");
    await act(async () => {
      btn(host, "删除所选")?.click();
    });
    expect(row(host, "文档")).toBeUndefined();
    expect(row(host, "说明.txt")).toBeUndefined();
    expect(host.textContent).toContain("空文件夹");
  });
});
