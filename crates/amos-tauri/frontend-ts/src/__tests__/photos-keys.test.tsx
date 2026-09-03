import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { AppComponent } from "../apps";
import { PHOTOS_KEY } from "../lib/photos";

// Bring up a real DOM for this file (globals are per-process in bun).
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
  window.localStorage.removeItem(PHOTOS_KEY);
});

function mountPhotos() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <AppComponent id="photos" />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

describe("photos viewer keyboard navigation", () => {
  test("Arrow keys move to the next/previous photo in the viewer", async () => {
    const host = mountPhotos();
    await act(async () => {});
    // deterministic seed: first tile emoji is 🌅, second 🏔️
    const tile = host.querySelector('button[aria-label="🌅"]') as HTMLButtonElement;
    expect(tile, "seeded first photo tile").toBeTruthy();

    await act(async () => {
      tile.click(); // open viewer on seed-0
    });
    expect(host.textContent).toContain("🌅");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(host.textContent).toContain("🏔️"); // moved to seed-1
    expect(host.textContent).not.toContain("🌅"); // viewer now shows the next photo only

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    });
    expect(host.textContent).toContain("🌅"); // back to seed-0
  });

  test("viewer slideshow button toggles on/off", async () => {
    const host = mountPhotos();
    await act(async () => {});
    const tile = host.querySelector('button[aria-label="🌅"]') as HTMLButtonElement;
    expect(tile).toBeTruthy();
    await act(async () => {
      tile.click(); // open viewer on seed-0
    });

    // Slideshow is off initially → press "Play".
    const buttons = () =>
      Array.from(host.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons().some((t) => t.includes("幻灯片"))).toBe(true);
    const play = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("幻灯片"),
    ) as HTMLButtonElement;
    await act(async () => {
      play.click();
    });
    // Now shows "Stop"; "Play" is gone.
    expect(buttons().some((t) => t.includes("停止"))).toBe(true);
    expect(buttons().some((t) => t.includes("幻灯片"))).toBe(false);

    // Pressing again stops the slideshow.
    const stop = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("停止"),
    ) as HTMLButtonElement;
    await act(async () => {
      stop.click();
    });
    expect(buttons().some((t) => t.includes("幻灯片"))).toBe(true);
  });

  test("favouring a photo then filtering by ♥ shows only favourites", async () => {
    const host = mountPhotos();
    await act(async () => {});
    const tile = host.querySelector('button[aria-label="🌅"]') as HTMLButtonElement;
    await act(async () => {
      tile.click(); // viewer on seed-0
    });
    const heart = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.getAttribute("aria-label") ?? "").includes("收藏"),
    ) as HTMLButtonElement;
    expect(heart).toBeTruthy();
    await act(async () => {
      heart.click(); // favourite seed-0
    });
    await act(async () => {
      (Array.from(host.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").includes("返回"),
      ) as HTMLButtonElement).click(); // back to grid
    });

    const chip = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("♥ (1)"),
    ) as HTMLButtonElement;
    expect(chip).toBeTruthy();
    await act(async () => {
      chip.click(); // filter to favourites
    });
    expect(host.querySelector('button[aria-label="🌅"]')).toBeTruthy(); // favoured kept
    expect(host.querySelector('button[aria-label="🏔️"]')).toBeNull(); // others hidden
  });
});
