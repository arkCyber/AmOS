import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import HomeDock from "../components/HomeDock";
import type { HomeLayout } from "../lib/amosStore";

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
  window.localStorage.clear();
});

function mount(layout: HomeLayout) {
  window.localStorage.setItem("amos-ui.locale", "zh");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider>
        <HomeDock layout={layout} onOpen={() => {}} onMove={() => {}} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, host });
  return host;
}

// 15 page apps → 2 home pages (GRID_PER_PAGE=12); a 2-app fixed dock row.
const paged: HomeLayout = {
  page: [
    "settings", "clock", "calculator", "weather", "notes", "reminders", "photos",
    "files", "music", "maps", "camera", "store", "privacy", "contacts", "voice-notes",
  ],
  dock: ["phone", "messages"],
  hidden: [],
};

function gridText(host: HTMLElement) {
  return (host.querySelector('[data-testid="home-grid"]')?.textContent ?? "").replace(/\s+/g, " ");
}
function dockText(host: HTMLElement) {
  return (host.querySelector(".dock-mag")?.textContent ?? "").replace(/\s+/g, " ");
}
function dots(host: HTMLElement) {
  return Array.from(host.querySelectorAll('[data-testid="home-dot"]')) as HTMLButtonElement[];
}

describe("HomeDock home-grid pagination", () => {
  test("multi-page grid shows dots + dock stays a single row", () => {
    const h = mount(paged);
    expect(dots(h).length).toBe(2); // 15 icons / 12 per page
    // bottom dock is a single, full row (both docked apps together)
    expect(dockText(h)).toContain("电话");
    expect(dockText(h)).toContain("信息");
    h.remove();
  });

  test("grid pages left/right only show the current page's icons; a dot click jumps", async () => {
    const h = mount(paged);
    const p0 = gridText(h);
    expect(p0).toContain("设置");
    expect(p0).toContain("天气");
    expect(p0).not.toContain("通讯录"); // on the next page

    await act(async () => {
      dots(h)[1]!.click(); // jump to page 2
    });
    const p1 = gridText(h);
    expect(p1).toContain("通讯录");
    expect(p1).not.toContain("设置");

    await act(async () => {
      dots(h)[0]!.click(); // back to page 1
    });
    expect(gridText(h)).toContain("设置");
  });
});
