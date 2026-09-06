import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { LockScreen } from "../components/SystemPanels";

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

function mount() {
  window.localStorage.setItem("amos-ui.locale", "zh");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider>
        <LockScreen onUnlock={() => {}} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, host });
  return host;
}

function bgImageUsed(host: HTMLElement): string | null {
  let found: string | null = null;
  Array.from(host.querySelectorAll("*")).forEach((el) => {
    const e = el as HTMLElement;
    if (e.style?.backgroundImage && !found) found = e.style.backgroundImage;
  });
  return found;
}

describe("LockScreen lock-background", () => {
  test("uses the configured background image when set", () => {
    window.localStorage.setItem("amos.settings", JSON.stringify({ lockWallpaper: "dark" }));
    const h = mount();
    const bg = bgImageUsed(h);
    expect(bg).toContain("wallpaper-dark.png");
    expect(h.textContent).toContain("锁定"); // shell.lockTitle (zh)
    h.remove();
  });

  test("falls back to the default look (no image layer) when unset", () => {
    const h = mount();
    const bg = bgImageUsed(h);
    expect(bg).toBeNull();
    h.remove();
  });

  test("a custom data: image is applied as the background", () => {
    window.localStorage.setItem("amos.settings", JSON.stringify({ lockWallpaper: "data:image/png;base64,AAAA" }));
    const h = mount();
    const bg = bgImageUsed(h);
    expect(bg).toContain("data:image/png;base64,AAAA");
    h.remove();
  });
});
