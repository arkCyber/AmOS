/**
 * settings-untested-screens.svelte.test.ts — DOM tests for settings surfaces that no
 * other suite renders directly (found by auditing `src/svelte/**` against the test
 * corpus: `QuarantinePanel` and `NetGuardPage` had **zero** direct coverage).
 *
 * Both are honesty-critical, so what is asserted here is the *claim*, not the pixels:
 *   • QuarantinePanel renders **nothing** when nothing was preserved, and lists the
 *     preserved bytes when something was (it must never imply a problem that is not
 *     recorded, nor hide one that is);
 *   • NetGuardPage never reports a real firewall when only intent was recorded — the
 *     mock backend must read as "intent", and an unreachable daemon as offline.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import QuarantinePanel from "../src/svelte/settings/QuarantinePanel.svelte";
import NetGuardPage from "../src/svelte/settings/NetGuardPage.svelte";
import { CORRUPT_SUFFIX } from "../src/lib/amosStore";

beforeEach(() => {
  window.localStorage.clear();
});
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

describe("QuarantinePanel (the read side of the corrupt-value quarantine)", () => {
  test("renders nothing when nothing was preserved", async () => {
    const host = render(QuarantinePanel);
    await settle();
    // Not an empty list, not "0 items": the panel is simply absent.
    expect(host.container.querySelector('[data-testid="store-quarantine"]')).toBeNull();
  });

  test("lists preserved keys with their real byte counts, sorted", async () => {
    window.localStorage.setItem(`amos.notes${CORRUPT_SUFFIX}`, "{ this is not json");
    window.localStorage.setItem(`amos.contacts${CORRUPT_SUFFIX}`, "[]");
    const host = render(QuarantinePanel);
    await settle();
    const panel = host.container.querySelector('[data-testid="store-quarantine"]');
    expect(panel).toBeTruthy();
    const text = panel?.textContent ?? "";
    expect(text).toContain("amos.notes");
    expect(text).toContain("amos.contacts");
    // Bytes are the preserved raw length, not a guess.
    expect(text).toContain(String("{ this is not json".length));
    // Sorted by key so the list does not reshuffle between renders.
    expect(text.indexOf("amos.contacts")).toBeLessThan(text.indexOf("amos.notes"));
    // A refresh button exists for the case where a value was quarantined after mount.
    expect(
      host.container.querySelector('button[aria-label]'),
    ).toBeTruthy();
  });

  test("copy reports success only when the bridge actually stored it", async () => {
    window.localStorage.setItem(`amos.notes${CORRUPT_SUFFIX}`, "broken");
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return cmd === "clipboard_write" ? { seq: 1 } : null;
      },
      listen: async () => () => {},
    };
    const host = render(QuarantinePanel);
    await settle();
    await fireEvent.click(
      host.container.querySelector('button[aria-label="quarantine-copy"]') as HTMLButtonElement,
    );
    await settle();
    // The raw preserved bytes go to the clipboard verbatim (no "repair" attempt).
    const write = calls.find((c) => c.cmd === "clipboard_write");
    expect(write?.args).toEqual({ payload: { kind: "text", text: "broken" } });
    expect(host.container.textContent ?? "").toContain("已复制");
  });

  test("a failed copy never claims it copied", async () => {
    window.localStorage.setItem(`amos.notes${CORRUPT_SUFFIX}`, "broken");
    // Bridge present but the write fails (returns null) ⇒ the button must keep saying
    // "复制", because telling the user it was copied would be a lie.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async () => null,
      listen: async () => () => {},
    };
    const host = render(QuarantinePanel);
    await settle();
    const btn = host.container.querySelector(
      'button[aria-label="quarantine-copy"]',
    ) as HTMLButtonElement;
    await fireEvent.click(btn);
    await settle();
    expect(host.container.textContent ?? "").not.toContain("已复制");
    expect(btn.textContent ?? "").toContain("复制");
  });
});

describe("NetGuardPage (never claims enforcement it does not have)", () => {
  test("an unreachable daemon reads as offline, and the switch cannot be used", async () => {
    // No `__TAURI_INTERNALS__` ⇒ bridged() is false ⇒ netguardStatus() is null.
    const host = render(NetGuardPage);
    await settle();
    expect(host.container.textContent ?? "").toContain("守护进程未连接");
    const sw = host.container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw).toBeTruthy();
    expect(sw.disabled).toBe(true, "no status ⇒ no toggle (nothing to arm)");
  });

  test("the mock backend reads as intent, never as a real firewall", async () => {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "netguard_status")
          return {
            enabled: true,
            backend: "mock",
            // The daemon's own honest flag: mock never enforces.
            enforced: false,
            policy_rules: 0,
            top_egress: [],
          };
        // A *successful* toggle, so the component re-reads the daemon's snapshot.
        return { enabled: false, message: "disarmed" };
      },
      listen: async () => () => {},
    };
    const host = render(NetGuardPage);
    // Wait for a string that can ONLY come from the status block. ("仅记录意图" also
    // appears in the page's static boundary copy, so waiting on it resolved instantly
    // while the status was still null — the switch was disabled and the click vanished.)
    await vi.waitFor(() =>
      expect(host.container.textContent ?? "").toContain("后端: mock"),
    );
    const text = host.container.textContent ?? "";
    expect(text).toContain("仅记录意图");
    expect(text).not.toContain("正在执行（真实后端）");
    // Toggling asks the daemon (`netguard_toggle`) and then re-reads *its* snapshot —
    // the UI never flips itself locally.
    await fireEvent.click(host.container.querySelector('[role="switch"]') as HTMLButtonElement);
    await vi.waitFor(() => expect(calls).toContain("netguard_toggle"));
    expect(calls.filter((c) => c === "netguard_status").length).toBeGreaterThan(1);
  });

  test("a rejected toggle is not shown as a new state", async () => {
    // The daemon refuses (returns null): no re-read happens, so the page keeps showing
    // the state it actually has instead of pretending the switch moved.
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "netguard_status")
          return { enabled: true, backend: "mock", enforced: false, policy_rules: 0, top_egress: [] };
        return null; // netguard_toggle rejected
      },
      listen: async () => () => {},
    };
    const host = render(NetGuardPage);
    await vi.waitFor(() => expect(host.container.textContent ?? "").toContain("后端: mock"));
    await fireEvent.click(host.container.querySelector('[role="switch"]') as HTMLButtonElement);
    await vi.waitFor(() => expect(calls).toContain("netguard_toggle"));
    await settle();
    // Still "intent, armed" — unchanged, because nothing changed at the daemon.
    expect(host.container.textContent ?? "").toContain("仅记录意图");
    expect(calls.filter((c) => c === "netguard_status").length).toBe(1);
  });

  test("an enforced backend is reported as enforced (the label is not always 'intent')", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "netguard_status"
          ? { enabled: true, backend: "nftables", enforced: true, policy_rules: 3, top_egress: [] }
          : null,
      listen: async () => () => {},
    };
    const host = render(NetGuardPage);
    await vi.waitFor(() => expect(host.container.textContent ?? "").toContain("nftables"));
    expect(host.container.textContent ?? "").toContain("正在执行（真实后端）");
  });
});
