import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { AppComponent } from "../apps";

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
  window.localStorage.removeItem("amos.weather.cities");
  window.localStorage.removeItem("amos.weather.city");
});

async function mountWeather() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AppComponent id="weather" />
      </I18nProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  mounted.push({ root, host });
  return host;
}

describe("Weather — editable city subset (DOM)", () => {
  test("default 4 cities; + adds 巴黎 which persists; edit exposes ✕", async () => {
    const host = await mountWeather();
    for (const c of ["北京", "东京", "伦敦", "纽约"]) expect(host.textContent).toContain(c);
    expect(host.textContent).not.toContain("巴黎");

    const addBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "+ 城市");
    expect(addBtn).toBeTruthy();
    await act(async () => {
      addBtn!.click();
    });
    expect(host.textContent).toContain("巴黎");

    const stored = JSON.parse(window.localStorage.getItem("amos.weather.cities") ?? "[]") as { id: string }[];
    expect(stored.map((c) => c.id)).toContain("paris");

    const edit = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "编辑")!;
    await act(async () => {
      edit.click();
    });
    expect(host.textContent).toContain("巴黎 ✕"); // removable chip appears in edit mode
    await act(async () => {
      edit.click();
    });
    expect(host.textContent).not.toContain("✕");
  });
});
