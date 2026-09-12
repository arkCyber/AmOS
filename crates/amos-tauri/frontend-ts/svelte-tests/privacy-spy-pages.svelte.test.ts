/**
 * privacy-spy-pages.svelte.test.ts — DOM tests for the two settings pages the coverage
 * audit found effectively unasserted (`PrivacyPage` 2/8 own strings asserted,
 * `TelemetrySpyPage` 0/8).
 *
 * Both are honesty-critical, so the assertions target the *claims*:
 *   • PrivacyPage must keep "could not read the media state" (`null`) apart from
 *     "nothing is granted" (`[]`), must show no media section when the bridge did not
 *     answer at all, and must reflect a revoke by re-reading the daemon;
 *   • TelemetrySpyPage is informational: it describes the audit and its boundaries and
 *     must NOT grow a toggle it does not have.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PrivacyPage from "../src/svelte/settings/PrivacyPage.svelte";
import TelemetrySpyPage from "../src/svelte/settings/TelemetrySpyPage.svelte";
import { PERMISSIONS_KEY } from "../src/lib/permissions";
import { readStoreValue } from "../src/lib/amosStore";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const installBridge = (handler: (cmd: string) => unknown) => {
  const calls: string[] = [];
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      return handler(cmd);
    },
    listen: async () => () => {},
  };
  return calls;
};

describe("PrivacyPage (permission ledger + system media access)", () => {
  test("no grants ⇒ the empty state, and no media section when the bridge is silent", async () => {
    const host = render(PrivacyPage);
    await settle();
    expect(host.container.textContent ?? "").toContain("暂无授权");
    // `mediaKnown` is false (all three media reads returned null) ⇒ no section at all:
    // the page must not claim anything about media it could not read.
    expect(host.container.querySelector('[aria-label="系统媒体访问"]')).toBeNull();
  });

  test("a granted capability is listed and revoking it really drops it", async () => {
    // Two apps each holding `camera` ⇒ the capability group lists both (the chips are
    // *apps*, not capabilities).
    window.localStorage.setItem(
      PERMISSIONS_KEY,
      JSON.stringify({ camera: ["camera"], magnifier: ["camera"] }),
    );
    const host = render(PrivacyPage);
    await settle();
    const text = host.container.textContent ?? "";
    expect(text).toContain("相机"); // capability label
    expect(text).toContain("已授权: 2");
    const chips = [...host.container.querySelectorAll("button[title]")].filter((b) =>
      (b.getAttribute("title") ?? "").includes("撤销"),
    );
    expect(chips).toHaveLength(2);
    await fireEvent.click(chips[0] as HTMLButtonElement);
    await settle();
    // The durable ledger really lost the grant (exactly one app still holds it), and
    // the UI followed.
    const left = readStoreValue<Record<string, string[]>>(PERMISSIONS_KEY, {});
    const holders = Object.entries(left).filter(([, caps]) => caps.includes("camera"));
    expect(holders).toHaveLength(1);
    expect(host.container.textContent ?? "").toContain("已授权: 1");
  });

  test("an answered 'nothing granted' is not the same as 'could not read'", async () => {
    installBridge((cmd) => {
      if (cmd === "media_provider_name") return "mock";
      if (cmd === "media_grants") return [];
      if (cmd === "media_collections") return [];
      return null;
    });
    const host = render(PrivacyPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[aria-label="系统媒体访问"]')).toBeTruthy(),
    );
    const text = host.container.textContent ?? "";
    expect(text).toContain("尚未授予任何媒体访问");
    expect(text).not.toContain("无法读取媒体访问状态");
  });

describe("PrivacyPage — system media access (null ≠ empty)", () => {
  test("an unreadable list is reported as unreadable, with no fabricated chips", async () => {
    installBridge((cmd) => {
      if (cmd === "media_provider_name") return "mock";
      if (cmd === "media_grants") return null; // the bridge cannot answer
      if (cmd === "media_collections") return ["camera"];
      return null;
    });
    const host = render(PrivacyPage);
    // "Could not read" is its own message — never rendered as "nothing granted".
    await vi.waitFor(() =>
      expect(host.container.textContent ?? "").toContain("无法读取媒体访问状态"),
    );
    expect(host.container.textContent ?? "").not.toContain("尚未授予任何媒体访问");
    expect(host.container.querySelector('button[aria-label="DCIM/Camera read"]')).toBeNull();
  });

  test("a revoke asks the daemon and re-reads instead of assuming it took", async () => {
    // `collection` must be a real StandardDir (`dcim` is not one — the normalizer drops it).
    let grants: unknown = [{ access: "read", collection: "camera" }];
    const calls = installBridge((cmd) => {
      if (cmd === "media_provider_name") return "mock";
      if (cmd === "media_grants") return grants;
      if (cmd === "media_collections") return ["camera"];
      if (cmd === "media_revoke") {
        grants = []; // the daemon really applied it
        return null;
      }
      return null;
    });
    const host = render(PrivacyPage);
    const chip = await vi.waitFor(() => {
      const el = host.container.querySelector('button[aria-label="DCIM/Camera read"]');
      if (!el) throw new Error("grant chip not rendered yet");
      return el;
    });
    await fireEvent.click(chip as HTMLButtonElement);
    await vi.waitFor(() => expect(calls).toContain("media_revoke"));
    // The page re-read the daemon (`media_grants` twice) and now reflects the truth.
    expect(calls.filter((c) => c === "media_grants").length).toBeGreaterThan(1);
    await vi.waitFor(() =>
      expect(host.container.textContent ?? "").toContain("尚未授予任何媒体访问"),
    );
  });
});

describe("TelemetrySpyPage (informational, read-only)", () => {
  test("describes the audit and its boundaries without inventing a control", async () => {
    const host = render(TelemetrySpyPage);
    await settle();
    const text = host.container.textContent ?? "";
    // Offline host ⇒ the honest "quiet" state, not "watching".
    expect(text).toContain("静默 · 未接入监听");
    expect(text).not.toContain("已接入外发监听");
    // The boundaries are present (they are the page's reason to exist).
    expect(text.length).toBeGreaterThan(120);
    // No switch, no button: the audit is read-only and always on (docs/telemetry-spy.md).
    expect(host.container.querySelector('[role="switch"]')).toBeNull();
    expect(host.container.querySelectorAll("button")).toHaveLength(0);
  });

  test("a bridged host reports 'watching' but never claims capture is running", async () => {
    installBridge(() => null);
    const host = render(TelemetrySpyPage);
    await settle();
    const text = host.container.textContent ?? "";
    expect(text).toContain("已接入外发监听");
    // "Watching" is about the listener, not about captured traffic — the page must not
    // imply packets are being collected (the capture producer is a separate bring-up).
    expect(text).not.toContain("已捕获");
  });
});

});
