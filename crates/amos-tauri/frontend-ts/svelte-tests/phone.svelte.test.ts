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
});
