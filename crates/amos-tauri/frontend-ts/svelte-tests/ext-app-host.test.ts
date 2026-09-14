/**
 * DOM tests for the **web-bundle runtime host** (`ExtAppHost.svelte`) and its
 * client (`src/lib/bundleHost.ts`).
 *
 * This is the half of the PWA path that used to say "运行时宿主未建成": what is
 * pinned here is that an installed bundle is framed at **its own origin** on the
 * `amos-app://` protocol, with a sandbox that keeps its own origin but not the
 * shell's, and that every way of failing is *said* rather than shown as a blank
 * frame.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import ExtAppHost from "../src/svelte/ExtAppHost.svelte";
import { fetchBundleEntry } from "../src/lib/bundleHost";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

/** Install a host bridge that answers `appstore_bundle_entry` with `reply`. */
function installBridge(reply: unknown | (() => unknown)) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd !== "appstore_bundle_entry") return null;
      return typeof reply === "function" ? (reply as () => unknown)() : reply;
    },
  };
}

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 40));
const frame = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="ext-app-frame"]') as HTMLIFrameElement | null;

describe("fetchBundleEntry — the URL is the host's, and its refusals keep its words", () => {
  test("no bridge at all is 'offline'", async () => {
    expect(await fetchBundleEntry("org.amos.demo")).toEqual({
      kind: "failed",
      reason: "offline",
      detail: "no Tauri bridge",
    });
  });

  test("a rejected command keeps the host's own reason text", async () => {
    installBridge(() => {
      throw new Error("no web install dir (set AMOS_APPSTORE_INSTALL_DIR)");
    });
    const result = await fetchBundleEntry("org.amos.demo");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("unavailable");
      expect(result.detail).toContain("AMOS_APPSTORE_INSTALL_DIR");
    }
  });

  test("a reply we would not frame is refused, not used", async () => {
    installBridge({ url: "javascript:alert(1)", start: "index.html" });
    const result = await fetchBundleEntry("org.amos.demo");
    expect(result.kind === "failed" && result.reason === "blocked").toBe(true);
  });

  test("an empty id never reaches the host", async () => {
    installBridge(null);
    const result = await fetchBundleEntry("   ");
    expect(result.kind === "failed" && result.reason === "blocked").toBe(true);
  });

  test("a real reply is 'ok'", async () => {
    installBridge({ url: "http://amos-app.org.amos.demo/index.html", start: "index.html" });
    const result = await fetchBundleEntry("org.amos.demo");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.entry.start).toBe("index.html");
  });
});

describe("ExtAppHost.svelte", () => {
  test("frames the bundle at the app's own origin, sandboxed", async () => {
    installBridge({ url: "amos-app://org.amos.demo/home.html", start: "home.html" });
    const host = render(ExtAppHost, { mid: "org.amos.demo", name: "Demo" });
    await settle();
    await settle();
    const f = frame(host);
    expect(f).not.toBeNull();
    // The app's own origin (and its declared `start`, not an assumed index.html).
    expect(f!.getAttribute("src")).toBe("amos-app://org.amos.demo/home.html");
    expect(f!.getAttribute("title")).toBe("Demo");
    // A bundle should not drag the shell's URL along as a referrer.
    expect(f!.getAttribute("referrerpolicy")).toBe("no-referrer");
    const sandbox = f!.getAttribute("sandbox") ?? "";
    expect(sandbox.split(" ").sort()).toEqual([
      "allow-forms",
      "allow-same-origin",
      "allow-scripts",
    ]);
  });

  test("a bundle the host cannot serve says why, with a retry", async () => {
    installBridge(() => {
      throw new Error("bundle entry index.html not found");
    });
    const host = render(ExtAppHost, { mid: "org.amos.demo", name: "Demo" });
    await settle();
    await settle();
    expect(frame(host)).toBeNull();
    expect(txt(host)).toContain("无法运行");
    expect(txt(host)).toContain("bundle entry index.html not found");
    expect(host.container.querySelector('[data-testid="ext-app-reload"]')).not.toBeNull();
  });

  test("outside AmOS it says so instead of blaming the app", async () => {
    const host = render(ExtAppHost, { mid: "org.amos.demo", name: "Demo" });
    await settle();
    await settle();
    expect(frame(host)).toBeNull();
    expect(txt(host)).toContain("未在 AmOS 内运行");
  });
});
