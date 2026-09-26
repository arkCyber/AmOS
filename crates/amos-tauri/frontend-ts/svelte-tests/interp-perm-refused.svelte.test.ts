/**
 * interp-perm-refused.svelte.test.ts — 口译 App 的两段式麦克风授权把本地账本写入的判决丢在地上
 * （REQ-A1406 / FMEA F-SH-664 的另一半）。
 *
 * `micGranted` 用持久账本播种（`capSet(loadLedger(), …)`——OS 每道能力闸门回读的那份），
 * 而第二下点按的 `allowMic()` 把 `grantCapability` 的判决丢掉、照**意图**置真。存储拒写时，
 * 屏幕上就此打开了一段并没有被授予的采集会话，而 `loadLedger()` 说没有。本文件钉的是：采纳
 * 写入自己的判决，未被授予就把说明写进状态行、且**不**开始采集。
 *
 * 后端按文件 mock：「桥在、会话开得起来」，这样麦克风按钮才会出现。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { PERMISSIONS_KEY, capSet, loadLedger } from "../src/lib/permissions";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const REFUSED = zh["common.storeWriteFailed"];

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

vi.mock("../src/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backend")>();
  return {
    ...actual,
    bridged: () => true,
    subscribe: async () => () => {},
    interpretStart: async () => 1,
    interpretStop: async () => true,
    interpretPause: async () => true,
    interpretResume: async () => true,
    interpretEndOfSpeech: async () => true,
    interpretAudio: async () => true,
    interpretText: async () => true,
  };
});

/** 只让 `amos.permissions` 上的写入抛错（同 `permissions-write-refused`）。 */
let refuseLedgerWrites = false;
let restoreStorage: (() => void) | null = null;

function installRefusingStorage(): void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (refuseLedgerWrites && k === PERMISSIONS_KEY) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  restoreStorage = () => {
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
  };
}

/** 口译屏的麦克风按钮只有 `title`（`t("a11y.mic")`），没有 aria-label。 */
const micButton = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("title") === zh["a11y.mic"],
  ) as HTMLButtonElement | undefined;
const buttonByText = (h: { container: HTMLElement }, text: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
  refuseLedgerWrites = false;
  installRefusingStorage();
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  refuseLedgerWrites = false;
  restoreStorage?.();
  restoreStorage = null;
  window.localStorage.clear();
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
});

/** 开会话，等麦克风按钮出现（它只在 `running` 时渲染）。 */
const startSession = async (host: { container: HTMLElement }) => {
  await waitFor(() => expect(buttonByText(host, zh["interp.start"])).toBeTruthy());
  await fireEvent.click(buttonByText(host, zh["interp.start"])!);
  await waitFor(() => expect(micButton(host)).toBeTruthy());
};

describe("InterpApp.svelte（两段式授权采纳写入的判决）", () => {
  test("被拒的授权：状态行说出拒写、账本仍未授予", async () => {
    refuseLedgerWrites = true;
    const host = render(InterpApp);
    await startSession(host);

    // 第一下：解释；第二下：授予（应被拒）。
    await fireEvent.click(micButton(host)!);
    await settle();
    await fireEvent.click(micButton(host)!);
    await settle();

    expect(host.container.textContent).toContain(REFUSED);
    expect(capSet(loadLedger(), "interpreter", "microphone")).toBe(false);
  });

  test("落地的授权：状态行不说拒写、账本已授予（对照）", async () => {
    const host = render(InterpApp);
    await startSession(host);

    await fireEvent.click(micButton(host)!);
    await settle();
    await fireEvent.click(micButton(host)!);
    await settle();

    expect(host.container.textContent).not.toContain(REFUSED);
    expect(capSet(loadLedger(), "interpreter", "microphone")).toBe(true);
  });
});
