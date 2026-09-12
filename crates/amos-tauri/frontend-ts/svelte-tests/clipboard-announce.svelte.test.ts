/**
 * ClipboardAnnounce.svelte — the metadata-only "clipboard updated" toast.
 *
 * The Rust side broadcasts `clipboard-changed` on every write (Webview copy or a
 * container-originated ingest) with metadata only. This island must surface that
 * notice, never the content, and dismiss cleanly.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ClipboardAnnounce from "../src/svelte/ClipboardAnnounce.svelte";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const waitUntil = async (cond: () => boolean, timeoutMs = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
};

function installBridge() {
  const handlers: Record<string, (e: { payload: unknown }) => void> = {};
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    listen: async (ch: string, h: (e: { payload: unknown }) => void) => {
      handlers[ch] = h;
      return () => {};
    },
  };
  return handlers;
}

describe("ClipboardAnnounce.svelte", () => {
  test("no bridge → renders nothing (no crash)", async () => {
    const host = render(ClipboardAnnounce);
    await tick();
    expect(host.container.querySelector('[data-testid="clipboard-announce"]')).toBeNull();
  });

  test("a clipboard-changed notice shows a metadata-only banner; dismiss hides it", async () => {
    const handlers = installBridge();
    const host = render(ClipboardAnnounce);
    await waitUntil(() => typeof handlers["clipboard-changed"] === "function");
    expect(host.container.querySelector('[data-testid="clipboard-announce"]')).toBeNull();

    // A container-originated copy lands: metadata only (there is no content field).
    handlers["clipboard-changed"]({
      payload: { seq: 7, timestamp_ms: 1, source: "container" },
    });
    await tick();

    const banner = host.container.querySelector('[data-testid="clipboard-announce"]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent ?? "").toContain(zh["clipboard.announce"].split("{")[0].trim());
    expect(banner?.textContent ?? "").toContain("container");

    await fireEvent.click(
      host.container.querySelector(
        `button[aria-label="${zh["clipboard.announceDismiss"]}"]`,
      ) as HTMLButtonElement,
    );
    await tick();
    expect(host.container.querySelector('[data-testid="clipboard-announce"]')).toBeNull();
  });
});
