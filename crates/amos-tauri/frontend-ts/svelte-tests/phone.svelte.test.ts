/**
 * DOM tests for the Svelte 5 phone screen (PhoneApp.svelte) — offline UI parts.
 * Pure dial logic is in lib/phone (shared); dialing/record paths need the OS
 * telephony daemon and are verified on-device (ON_DEVICE_ACCEPTANCE.md). Here we
 * test keypad entry/backspace/clear, tab switching, the emergency page, and that
 * dialing WITHOUT a daemon shows a localized error (never a phantom "calling").
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import PhoneApp from "../src/svelte/PhoneApp.svelte";

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const key = (h: { container: HTMLElement }, aria: string) =>
  h.container.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;

describe("PhoneApp.svelte (offline UI)", () => {
  test("keypad digits append; backspace and clear work", async () => {
    const host = render(PhoneApp);
    await fireEvent.click(key(host, "1")!);
    await fireEvent.click(key(host, "2")!);
    await fireEvent.click(key(host, "3")!);
    expect(txt(host)).toContain("123");
    await fireEvent.click(key(host, "backspace")!);
    expect(txt(host)).toContain("12");
    await fireEvent.click(key(host, "clear")!);
    expect(txt(host)).not.toContain("12");
  });

  test("tabs switch between pages", async () => {
    const host = render(PhoneApp);
    const tab = (label: string) =>
      [...host.container.querySelectorAll('button[role="tab"]')].find((b) =>
        (b.textContent ?? "").trim() === label,
      ) as HTMLButtonElement | undefined;
    // emergency page lists the quick numbers
    await fireEvent.click(tab("紧急")!);
    expect(txt(host)).toContain("110");
    expect(txt(host)).toContain("119");
    // recent page (empty offline → localized empty text is non-whitespace)
    await fireEvent.click(tab("最近")!);
    expect(txt(host)).toContain("最近");
  });

  test("dialing without a daemon shows a localized error, not a fake calling screen", async () => {
    const host = render(PhoneApp);
    await fireEvent.click(key(host, "1")!);
    await fireEvent.click(key(host, "3")!);
    await fireEvent.click(key(host, "8")!);
    const callBtn = host.container.querySelector('button[aria-label="call"]');
    expect(callBtn).toBeTruthy();
    await fireEvent.click(callBtn as HTMLButtonElement);
    await new Promise((r) => setTimeout(r, 10)); // let realDial/telephonyDial settle
    // offline: no in-call UI, but a role=alert with the localized dial error
    expect(host.container.querySelector('button[aria-label="end"]')).toBeFalsy();
    expect(host.container.querySelector('[role="alert"]')).toBeTruthy();
  });

  test("blocklist tab adds, lists and removes rules through the bridge", async () => {
    const calls: Record<string, unknown>[] = [];
    let rules: Record<string, unknown>[] = [];
    let unknown = false;
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ?? {}) });
        if (cmd === "blocklist_snapshot") return { block_unknown: unknown, rules };
        if (cmd === "blocklist_add") {
          const r = {
            id: `${String(args?.pattern)}|exact|both`,
            pattern: String(args?.pattern),
            kind: String(args?.kind),
            channel: String(args?.channel),
            label: String(args?.label ?? ""),
            created_ms: 1,
          };
          rules = [...rules, r];
          return r;
        }
        if (cmd === "blocklist_remove") {
          rules = rules.filter((r) => r.id !== args?.id);
          return true;
        }
        if (cmd === "blocklist_set_unknown") {
          unknown = args?.on === true;
          return null;
        }
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(PhoneApp);
    const blockTab = [...host.container.querySelectorAll('button[role="tab"]')].find((b) =>
      (b.textContent ?? "").includes("拦截"),
    ) as HTMLButtonElement;
    await fireEvent.click(blockTab);
    await new Promise<void>((r) => setTimeout(r, 0));
    await fireEvent.input(host.container.querySelector('input[aria-label="block-number"]') as HTMLInputElement, {
      target: { value: "1069" },
    });
    await fireEvent.click(host.container.querySelector('button[aria-label="block-add"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    const added = calls.find((c) => c.cmd === "blocklist_add");
    expect(added?.pattern).toBe("1069");
    expect(added?.kind).toBe("exact");
    expect(added?.channel).toBe("both");
    expect(txt(host)).toContain("1069");
    // The unknown-number switch reaches the same rule store.
    await fireEvent.click(host.container.querySelector('button[aria-label="block-unknown"]') as HTMLButtonElement);
    expect(calls.find((c) => c.cmd === "blocklist_set_unknown")?.on).toBe(true);
    // Removing the rule drops it from the list.
    await fireEvent.click(host.container.querySelector('button[aria-label="block-remove-1069"]') as HTMLButtonElement);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(rules.length).toBe(0);
  });
});
