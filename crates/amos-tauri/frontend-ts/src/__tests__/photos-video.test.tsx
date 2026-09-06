import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { AppComponent } from "../apps";
import { PHOTOS_KEY } from "../lib/photos";
import { persistVideoCapture } from "../lib/cameraCapture";
import { defaultMediaStore } from "../lib/mediaStore";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const mounted: { root: Root; host: HTMLElement }[] = [];
let savedLocale: string | null | undefined;

afterEach(async () => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  // best-effort tidy of media the test may have written
  try {
    await defaultMediaStore().del("video-vx");
  } catch {
    /* ignore */
  }
  if (savedLocale !== undefined) {
    if (savedLocale === null) window.localStorage.removeItem("amos-ui.locale");
    else window.localStorage.setItem("amos-ui.locale", savedLocale);
    savedLocale = undefined;
  }
  window.localStorage.removeItem(PHOTOS_KEY);
  window.localStorage.removeItem("amos.captures");
});

async function mountPhotos() {
  if (savedLocale === undefined) savedLocale = window.localStorage.getItem("amos-ui.locale");
  window.localStorage.setItem("amos-ui.locale", "en");
  window.localStorage.setItem(
    PHOTOS_KEY,
    JSON.stringify([{ id: "pic", data: "data:image/jpeg;base64,AAAA", ts: Date.now() }]),
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AppComponent id="photos" />
      </I18nProvider>,
    );
  });
  await act(async () => {});
  mounted.push({ root, host });
  return host;
}

describe("Photos gallery shows camera videos", () => {
  test("a recorded capture appears as a tile, opens a player overlay, and can be deleted", async () => {
    // Simulate a previously recorded video already in the capture library.
    const store = defaultMediaStore();
    await persistVideoCapture(
      { id: "vx", ts: Date.now(), mime: "video/webm", durationMs: 4200, w: 1280, h: 720 },
      new Blob(["v"], { type: "video/webm" }),
      store,
    );

    const host = await mountPhotos();
    // Video tile present in the grid, showing its duration and resolution tier.
    const tile = host.querySelector('button[aria-label="video"]') as HTMLButtonElement | null;
    expect(tile).toBeTruthy();
    expect(tile?.textContent).toContain("00:04");
    expect(tile?.textContent).toContain("HD");

    // Favourite it from the grid.
    const fav = host.querySelector('button[aria-label="favourite video"]') as HTMLButtonElement | null;
    expect(fav).toBeTruthy();
    await act(async () => fav!.click());
    await act(async () => {});
    expect(JSON.parse(window.localStorage.getItem("amos.captures") ?? "[]")[0].fav).toBe(true);

    // Open it → player overlay appears with a Share affordance.
    await act(async () => {
      tile!.click();
    });
    await act(async () => {});
    expect(
      Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Share"),
    ).toBe(true);
    // Delete via the overlay removes it from the gallery.
    const del = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Delete");
    expect(del).toBeTruthy();
    await act(async () => {
      del!.click();
    });
    await act(async () => {});
    expect(host.querySelector('button[aria-label="video"]')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("amos.captures") ?? "[]").length).toBe(0);
  });
});
