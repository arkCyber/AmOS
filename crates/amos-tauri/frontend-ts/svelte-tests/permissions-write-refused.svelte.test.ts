/**
 * permissions-write-refused.svelte.test.ts — 隐私页与权限仪表盘把 `amos.permissions`
 * 的**本地**写入判决丢在地上（REQ-A1402 / FMEA F-SH-660）。
 *
 * `saveLedger` 曾经签 `void`（`writeStoreValue` 的返回值被丢），于是 `revokeCapability` /
 * `grantCapability` 把**尝试写入**的那份账本交回调用方，而两个显示面（`PermissionsApp`、
 * `settings/PrivacyPage`）**照单收下**：磁盘拒写时撤销仍然画成已撤销、绿芯片消失、开关翻
 * 面。可 `amos.permissions` 正是 OS 每道闸门回读的那一份（`loadLedger`）——下一次开机它
 * 还在，能力依旧被授着，屏幕上却已经说过「撤销了」。本文件钉的就是这一句：**拒写要说出口，
 * 而且显示的那份账本必须是存储真正持有的那份**（`CapabilityWrite.ledger`）。
 *
 * 这里刻意**离线**（无 `__TAURI_INTERNALS__`）：daemon 镜像那一半的判决与本地写入判决是
 * **两件事**（前者由 `mirrorRefused` 记录、由 ⛔ 呈现，另有测试）。本文件只问本地那一半。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PermissionsApp from "../src/svelte/PermissionsApp.svelte";
import PrivacyPage from "../src/svelte/settings/PrivacyPage.svelte";
import { writeStoreValueChecked } from "../src/lib/amosStore";
import { PERMISSIONS_KEY, capSet, loadLedger } from "../src/lib/permissions";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const REFUSED = zh["common.storeWriteFailed"];

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/**
 * 只让 `amos.permissions` 上的写入抛错 —— 存储拒写的真身（同 `notif-center-store-refusal`）。
 * `readStoreValue` 仍然走真存储，所以 `loadLedger` 读到的就是盘上真正持有的那份。
 */
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

/** `StoreErrorBar` 那条唯一的拒写陈述（`storeErr` 非空时才渲染）。 */
const errorBar = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="store-write-error"]');
const errorText = (h: { container: HTMLElement }) => errorBar(h)?.textContent ?? "";

/** PermissionsApp 里能力行的「可开启」按钮（`aria-pressed` 就是那个灯的判决）。 */
const candidates = (h: { container: HTMLElement }): HTMLButtonElement[] =>
  [...h.container.querySelectorAll("button[aria-pressed]")] as HTMLButtonElement[];
const cameraCandidate = (h: { container: HTMLElement }) =>
  candidates(h).find((b) => (b.textContent ?? "").startsWith("相机 ·"));

/** 绿持有者芯片（带 ✕ 的那颗），点击即撤销。 */
const holderChip = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").includes("相机") && !!b.querySelector('[data-icon="x"]'),
  ) as HTMLButtonElement | undefined;

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
  refuseLedgerWrites = false;
  installRefusingStorage();
});

afterEach(() => {
  cleanup();
  refuseLedgerWrites = false;
  restoreStorage?.();
  restoreStorage = null;
  window.localStorage.clear();
});

describe("PermissionsApp.svelte（拒写的本地账本判决）", () => {
  test("被拒的授权：灯不翻面，说出拒写，盘上仍然没有这项能力", async () => {
    refuseLedgerWrites = true;
    const host = render(PermissionsApp);
    const cam = cameraCandidate(host)!;
    expect(cam.getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(cam);
    await settle();

    // 屏幕把「尝试写入」的那份收下了吗？`aria-pressed` 必须仍是 false，因为
    // `loadLedger()` 下一次开机读到的就是 false。
    expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("false");
    expect(errorText(host)).toBe(REFUSED);
    expect(capSet(loadLedger(), "camera", "camera")).toBe(false);
  });

  test("被拒的撤销：持有者芯片不消失，说出拒写，盘上仍然授着", async () => {
    // 先在**没有**拒写的情况下种下一次落地的授权，再让存储开始拒写。
    expect(writeStoreValueChecked(PERMISSIONS_KEY, { camera: ["camera"] })).toBe(true);
    refuseLedgerWrites = true;
    const host = render(PermissionsApp);
    expect(holderChip(host)).toBeTruthy();

    await fireEvent.click(holderChip(host)!);
    await settle();

    // 撤销没落地 ⇒ 能力还授着 ⇒ 芯片必须还在（画成撤销会是下一次开机被静默推翻的谎）。
    expect(holderChip(host)).toBeTruthy();
    expect(errorText(host)).toBe(REFUSED);
    expect(capSet(loadLedger(), "camera", "camera")).toBe(true);
  });

  test("落地的授权照旧：灯翻面，且没有拒写陈述（对照）", async () => {
    const host = render(PermissionsApp);
    await fireEvent.click(cameraCandidate(host)!);
    await settle();

    expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("true");
    expect(errorBar(host)).toBeNull();
    expect(capSet(loadLedger(), "camera", "camera")).toBe(true);
  });
});

describe("PrivacyPage.svelte（拒写的本地账本判决）", () => {
  test("被拒的撤销：持有者仍在列，说出拒写，盘上仍然授着", async () => {
    expect(writeStoreValueChecked(PERMISSIONS_KEY, { camera: ["camera"] })).toBe(true);
    refuseLedgerWrites = true;
    const host = render(PrivacyPage);
    await settle();

    const chip = holderChip(host);
    expect(chip, "隐私页应当列出被授的能力持有者").toBeTruthy();

    await fireEvent.click(chip!);
    await settle();

    // 该文件的孪生规则写在自己的 `revokeMedia` 上——「行会被下一次轮询写回」对本地这一半
    // **不成立**：拒写的撤销不会被写回，它会一直授着。所以芯片必须还在。
    expect(holderChip(host)).toBeTruthy();
    expect(errorText(host)).toBe(REFUSED);
    expect(capSet(loadLedger(), "camera", "camera")).toBe(true);
  });

  test("落地的撤销照旧：持有者消失，且没有拒写陈述（对照）", async () => {
    expect(writeStoreValueChecked(PERMISSIONS_KEY, { camera: ["camera"] })).toBe(true);
    const host = render(PrivacyPage);
    await settle();
    expect(holderChip(host)).toBeTruthy();

    await fireEvent.click(holderChip(host)!);
    await settle();

    expect(holderChip(host), "落地的撤销应当让持有者离开列表").toBeUndefined();
    expect(errorBar(host)).toBeNull();
    expect(capSet(loadLedger(), "camera", "camera")).toBe(false);
  });
});
