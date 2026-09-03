import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import CameraApp from "../components/CameraApp";

// Bring up a real DOM for this file (globals are per-process in bun).
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RETRY = "Retry camera";

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
  tearDownMedia();
  if (savedLocale === undefined) return;
  if (savedLocale === null) window.localStorage.removeItem("amos-ui.locale");
  else window.localStorage.setItem("amos-ui.locale", savedLocale);
  savedLocale = undefined;
});

function setupMedia(getUserMedia: () => Promise<unknown>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}
function tearDownMedia() {
  try {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  } catch {
    /* ignore */
  }
}

function mount() {
  if (savedLocale === undefined) savedLocale = window.localStorage.getItem("amos-ui.locale");
  window.localStorage.setItem("amos-ui.locale", "en");
  // These tests exercise the camera flow itself, so pre-grant the camera cap.
  window.localStorage.setItem("amos.permissions", JSON.stringify({ camera: ["camera"] }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <CameraApp />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return { root, host };
}

const buttons = (host: HTMLElement) =>
  Array.from(host.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim());
const findButton = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement;

describe("CameraApp degradation + retry", () => {
  test("unsupported environment shows the demo viewfinder with no retry control", async () => {
    tearDownMedia();
    const { host } = mount();
    await act(async () => {});
    expect(host.textContent).toContain("🏔️");
    expect(host.textContent).toContain("No camera in this environment");
    expect(buttons(host)).not.toContain(RETRY);
  });

  test("permission denied shows a message + retry; retrying re-acquires the camera", async () => {
    let calls = 0;
    const fakeStream = { getTracks: () => [{ stop: () => {} }] };
    setupMedia(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }))
        : Promise.resolve(fakeStream);
    });
    const { host } = mount();
    await act(async () => {});
    expect(host.textContent).toContain("Camera permission denied");
    expect(buttons(host)).toContain(RETRY);

    // Retry → getUserMedia resolves → live feed, hint and retry disappear.
    await act(async () => {
      findButton(host, RETRY).click();
    });
    await act(async () => {});
    expect(calls).toBe(2);
    expect(host.textContent).not.toContain("Camera permission denied");
    expect(buttons(host)).not.toContain(RETRY);
    const video = host.querySelector("video") as HTMLVideoElement;
    expect(video?.className).not.toContain("hidden");
  });

  test("a non-permission error (no device) still surfaces the demo viewfinder", async () => {
    setupMedia(() => Promise.reject(Object.assign(new Error("no device"), { name: "NotFoundError" })));
    const { host } = mount();
    await act(async () => {});
    expect(host.textContent).toContain("🏔️");
    expect(host.textContent).toContain("No camera in this environment");
  });
});

