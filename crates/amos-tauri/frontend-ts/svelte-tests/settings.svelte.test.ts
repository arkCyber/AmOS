/**
 * DOM tests for the Svelte 5 Settings screen (SettingsApp.svelte) — stage-1
 * groups (外观/语言/自动息屏/唤醒 + iCloud 同步 + AI 后端 + 锁屏密码).
 *
 * The component is not yet wired to apps.tsx (wholesale migration in progress),
 * but its implemented groups run against the same shared pure libs + stores as
 * the React Settings, so we verify those interactions directly: rendering the
 * general rows, picking an auto-screen-off timeout (persists), and enabling the
 * lock only with a valid 4–6 digit passcode.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { setLocale } from "../src/svelte/locale.svelte";
import { AMOS_LOCALE_CHANGED_EVENT } from "../src/svelte/ui-events";
import { AUTOOFF_STORE_KEY } from "../src/lib/display";
import { LOCK_KEY, type LockCfg } from "../src/lib/lock";

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
/** Last matching button — the lock group renders below the AI group. */
const lastButtonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(s))
    .pop() as HTMLButtonElement | undefined;
const inputByPlaceholder = (h: { container: HTMLElement }, ph: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === ph) as
    HTMLInputElement | undefined;

describe("SettingsApp.svelte (stage 1)", () => {
  test("renders the general + cloud + AI + lock groups", () => {
    const host = render(SettingsApp);
    expect(txt(host)).toContain("外观");
    expect(txt(host)).toContain("语言");
    expect(txt(host)).toContain("自动息屏");
    expect(txt(host)).toContain("iCloud 同步");
    expect(txt(host)).toContain("AI 推理后端");
    expect(txt(host)).toContain("启用锁屏密码");
  });

  test("picking an auto-screen-off timeout persists it to the display store", async () => {
    const host = render(SettingsApp);
    await fireEvent.click(buttonContaining(host, "15 秒") as HTMLButtonElement);
    expect(readStoreValue<number>(AUTOOFF_STORE_KEY, 0)).toBe(15);
  });

  test("lock refuses a too-short passcode", async () => {
    const host = render(SettingsApp);
    const enable = [...host.container.querySelectorAll('[role="switch"][aria-label="启用锁屏密码"]')][0] as
      | HTMLButtonElement
      | undefined;
    await fireEvent.click(enable as HTMLButtonElement);
    const pin = inputByPlaceholder(host, "4-6 位数字密码");
    expect(pin).toBeTruthy();
    await fireEvent.input(pin as HTMLInputElement, { target: { value: "12" } });
    await fireEvent.click(lastButtonContaining(host, "保存") as HTMLButtonElement);
    expect(readStoreValue<LockCfg>(LOCK_KEY, { enabled: false }).enabled).toBe(false);
  });

  test("lock enables and persists a valid 6-digit passcode", async () => {
    const host = render(SettingsApp);
    const enable = [...host.container.querySelectorAll('[role="switch"][aria-label="启用锁屏密码"]')][0] as
      | HTMLButtonElement
      | undefined;
    await fireEvent.click(enable as HTMLButtonElement);
    const pin = inputByPlaceholder(host, "4-6 位数字密码");
    expect(pin).toBeTruthy();
    await fireEvent.input(pin as HTMLInputElement, { target: { value: "123456" } });
    await fireEvent.click(lastButtonContaining(host, "保存") as HTMLButtonElement);
    const saved = readStoreValue<LockCfg>(LOCK_KEY, { enabled: false });
    expect(saved.enabled).toBe(true);
    expect(saved.pin).toBe("123456");
  });

  test("switching the language broadcasts the Svelte→React sync event", async () => {
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(AMOS_LOCALE_CHANGED_EVENT, on);
    try {
      const host = render(SettingsApp);
      await fireEvent.click(buttonContaining(host, "English") as HTMLButtonElement);
      expect(seen).toContain("en");
    } finally {
      window.removeEventListener(AMOS_LOCALE_CHANGED_EVENT, on);
      setLocale("zh"); // restore the shared locale so later tests stay deterministic
    }
  });
});
