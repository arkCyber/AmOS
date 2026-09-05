import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import MagnifierApp from "../components/MagnifierApp";
import { MAGNIFIER_SETTINGS_KEY } from "../lib/magnifier";

// Bring up a real DOM for this file (globals are per-process in bun).
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Restore anything this file mutates so it can't leak into sibling test files
// that share the process (locale, navigator.mediaDevices, mounted DOM).
const mounted: { root: Root; host: HTMLElement }[] = [];
let savedLocale: string | null | undefined;
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  try {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  } catch {
    /* ignore */
  }
  window.localStorage.removeItem(MAGNIFIER_SETTINGS_KEY);
  if (savedLocale === undefined) return;
  if (savedLocale === null) window.localStorage.removeItem("amos-ui.locale");
  else window.localStorage.setItem("amos-ui.locale", savedLocale);
  savedLocale = undefined;
});

const APP_NAME = "Magnifier";

function mount(granted: boolean) {
  if (savedLocale === undefined) savedLocale = window.localStorage.getItem("amos-ui.locale");
  window.localStorage.setItem("amos-ui.locale", "en");
  // Clear any pre-seeded OS permission ledger, then (optionally) grant camera.
  window.localStorage.removeItem("amos.permissions");
  if (granted) window.localStorage.setItem("amos.permissions", JSON.stringify({ magnifier: ["camera"] }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <MagnifierApp />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return { root, host };
}

const setupMedia = (getUserMedia: () => Promise<unknown>) => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
};

const rangeByLabel = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll<HTMLInputElement>('input[type="range"]')).find(
    (i) => i.getAttribute("aria-label") === label,
  );
const findButton = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;

describe("MagnifierApp (iPhone-style)", () => {
  test("shows the OS camera-permission gate until granted", async () => {
    const { host } = mount(false);
    await act(async () => {});
    // Pre-grant nothing → CapabilityGate overlay names the app.
    expect(host.textContent).toContain(APP_NAME);
    expect(host.querySelector('[data-testid="magnifier-lens"]')).toBeNull();
    expect(host.querySelector('input[type="range"]')).toBeNull();
  });

  test("after granting, renders the draggable lens + tone controls + reset", async () => {
    const { host } = mount(true);
    await act(async () => {});
    expect(host.querySelector('[data-testid="magnifier-base"]')).not.toBeNull();
    const lens = host.querySelector('[data-testid="magnifier-lens"]');
    expect(lens).not.toBeNull();
    // No camera in this environment → demo scene hint is shown.
    expect(host.textContent).toContain("Demo scene");
    expect(rangeByLabel(host, "Brightness")).not.toBeUndefined();
    expect(rangeByLabel(host, "Contrast")).not.toBeUndefined();
    const zoom = rangeByLabel(host, "Magnification");
    expect(zoom).not.toBeUndefined();
    expect(host.textContent).toContain("Reset");
    expect(host.textContent).toContain("2.0×");
  });

  test("sensible defaults + reset control are exposed", async () => {
    const { host } = mount(true);
    await act(async () => {});
    // Tone controls start neutral (100%) and zoom at a readable 2×.
    expect(host.textContent).toContain("100%");
    expect(host.textContent).toContain("2.0×");
    // Reset control is present and keeps the UI in a consistent state.
    const reset = Array.from(host.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Reset",
    ) as HTMLButtonElement | undefined;
    expect(reset).not.toBeUndefined();
    await act(async () => {
      reset!.click();
    });
    expect(host.textContent).toContain("2.0×");
    expect(host.querySelector('[data-testid="magnifier-lens"]')).not.toBeNull();
  });

  test("goes live only once camera frames are actually ready", async () => {
    // getUserMedia resolves immediately, but frames aren't decodable yet.
    const fakeStream = { getTracks: () => [] };
    setupMedia(() => Promise.resolve(fakeStream));
    const { host } = mount(true);
    await act(async () => {});
    // videoWidth is still 0 → must not crash and stays on the demo scene.
    expect(host.textContent).toContain("Demo scene");

    // Now the first frame becomes decodable on the <video>.
    const video = host.querySelector("video") as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    Object.defineProperty(video!, "videoWidth", { configurable: true, value: 640 });
    await act(async () => {
      video!.dispatchEvent(new Event("loadeddata", { bubbles: true }));
    });
    // The app should switch to the live view.
    expect(host.textContent).toContain("Live view");
  });

  test("Deny keeps the gate closed and surfaces the refused hint", async () => {
    const { host } = mount(false);
    await act(async () => {});
    // Gate overlay is up with Allow/Deny actions.
    const deny = findButton(host, "Deny");
    expect(deny).not.toBeUndefined();
    await act(async () => {
      deny!.click();
    });
    // Still gated (no lens), and the OS-level refused hint is shown.
    expect(host.querySelector('[data-testid="magnifier-lens"]')).toBeNull();
    expect(host.textContent).toContain("Denied");
    expect(findButton(host, "Allow")).not.toBeUndefined();
  });

  test("Allow grants the OS camera cap and mounts the magnifier UI", async () => {
    const { host } = mount(false);
    await act(async () => {});
    const allow = findButton(host, "Allow");
    expect(allow).not.toBeUndefined();
    await act(async () => {
      allow!.click();
    });
    // The ledger grant flips the gate open → viewer (lens + base) mounts.
    expect(host.querySelector('[data-testid="magnifier-lens"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="magnifier-base"]')).not.toBeNull();
    // No camera in this environment → demo hint.
    expect(host.textContent).toContain("Demo scene");
  });

  test("restores persisted adjustments from the shared store on open", async () => {
    // A prior session left zoom=5, brightness=150, contrast=80 in the store.
    window.localStorage.setItem(
      MAGNIFIER_SETTINGS_KEY,
      JSON.stringify({ zoom: 5, brightness: 150, contrast: 80 }),
    );
    const { host } = mount(true);
    await act(async () => {});
    expect(host.textContent).toContain("5.0×");
    expect(host.textContent).toContain("150%");
    expect(host.textContent).toContain("80%");
  });
});