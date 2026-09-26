/**
 * capability-prompt-refused.svelte.test.ts — 应用内的能力授权提示把本地账本写入的判决丢在地上
 * （REQ-A1406 / FMEA F-SH-664）。
 *
 * 这些提示的显示位（`micGranted` / `granted`）是用**持久账本**播种的
 * （`capSet(loadLedger(), …)`），所以它画的正是 `amos.permissions` —— OS 每道能力闸门回读的那
 * 一份。可它们的 `允许` / `拒绝` 处理函数把 `grantCapability` / `revokeCapability` 交回的判决
 * 丢掉，照**意图**改写显示位：存储拒写时，屏幕上刚说了「已授予」，下一次开机读到的却是没有；
 * 反过来「已撤销」则是用户以为自己收回了麦克风、而 `loadLedger()` 仍旧授着——REQ-A1402 修好了
 * 两个设置面（`PermissionsApp` / `PrivacyPage`），把应用层这几个调用者留成了边界，本轮补齐。
 *
 * 本文件钉的是：显示位必须**采纳写入自己的判决**（`CapabilityWrite.ledger`），而提示只在采纳
 * 后的值就是用户所求时关闭——拒写要说出口（`StoreErrorBar` / 状态行）。
 *
 * 刻意**离线**（无 `__TAURI_INTERNALS__`）：daemon 镜像那一半是另一件事（`mirrorRefused` / ⛔）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import VoiceMicButton from "../src/svelte/VoiceMicButton.svelte";
import DeviceMicButton from "../src/svelte/DeviceMicButton.svelte";
import StreamVoiceButton from "../src/svelte/StreamVoiceButton.svelte";
import MapsApp from "../src/svelte/MapsApp.svelte";
import MagnifierApp from "../src/svelte/MagnifierApp.svelte";
import { PERMISSIONS_KEY, capSet, loadLedger } from "../src/lib/permissions";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const REFUSED = zh["common.storeWriteFailed"];

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

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

const buttonByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === aria,
  ) as HTMLButtonElement | undefined;
const buttonByText = (h: { container: HTMLElement }, text: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;
const errorBar = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="store-write-error"]');
const errorText = (h: { container: HTMLElement }) => errorBar(h)?.textContent ?? "";

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

/** 打开提示：在未授予时按下麦克风按钮（`start()` 把 `ask` 置真）。 */
const openMicPrompt = async (h: { container: HTMLElement }, aria: string) => {
  await fireEvent.click(buttonByAria(h, aria)!);
  await settle();
  return buttonByText(h, zh["perm.allow"]);
};

describe("VoiceMicButton.svelte（提示采纳写入的判决）", () => {
  const props = { online: true, onTranscript: () => {} };

  test("被拒的授权：提示不关闭、说出拒写、账本仍未授予", async () => {
    refuseLedgerWrites = true;
    const host = render(VoiceMicButton, { props });
    const allow = await openMicPrompt(host, zh["a11y.voiceInput"]);
    expect(allow, "未授予时应出现同意提示").toBeTruthy();

    await fireEvent.click(allow!);
    await settle();

    // 请求未被满足 ⇒ 提示还在，且说出为什么。
    expect(buttonByText(host, zh["perm.allow"]), "被拒的授权不能关掉提示").toBeTruthy();
    expect(errorText(host)).toBe(REFUSED);
    // 而磁盘上确实没有这项能力 —— 这正是下一次开机所有闸门读到的那份。
    expect(capSet(loadLedger(), "ai", "microphone")).toBe(false);
  });

  test("在未授予时点「拒绝」：即使存储拒写也关闭提示（无需写就已成立）", async () => {
    // 「拒绝」面对的是一个**本就没被授予**的麦克风（提示只在未授予时开），所以不需要任何写入
    // 就已经是对的：一次被拒的空操作撤销不该把用户困在提示里。
    refuseLedgerWrites = true;
    const host = render(VoiceMicButton, { props });
    await openMicPrompt(host, zh["a11y.voiceInput"]);

    await fireEvent.click(buttonByText(host, zh["perm.deny"])!);
    await settle();

    expect(buttonByText(host, zh["perm.allow"])).toBeUndefined();
    expect(errorBar(host)).toBeNull();
    expect(capSet(loadLedger(), "ai", "microphone")).toBe(false);
  });

  test("落地的授权：提示关闭、无拒写陈述（对照）", async () => {
    const host = render(VoiceMicButton, { props });
    await openMicPrompt(host, zh["a11y.voiceInput"]);

    await fireEvent.click(buttonByText(host, zh["perm.allow"])!);
    await settle();

    expect(buttonByText(host, zh["perm.allow"])).toBeUndefined();
    expect(errorBar(host)).toBeNull();
    expect(capSet(loadLedger(), "ai", "microphone")).toBe(true);
  });
});

describe("DeviceMicButton.svelte（提示采纳写入的判决）", () => {
  const props = { online: true, session: () => "s" };

  test("被拒的授权：提示不关闭、说出拒写、账本仍未授予", async () => {
    refuseLedgerWrites = true;
    const host = render(DeviceMicButton, { props });
    const allow = await openMicPrompt(host, zh["a11y.deviceVoiceInput"]);
    expect(allow).toBeTruthy();

    await fireEvent.click(allow!);
    await settle();

    expect(buttonByText(host, zh["perm.allow"])).toBeTruthy();
    expect(errorText(host)).toBe(REFUSED);
    expect(capSet(loadLedger(), "ai", "microphone")).toBe(false);
  });

  test("落地的授权：提示关闭（对照）", async () => {
    const host = render(DeviceMicButton, { props });
    await openMicPrompt(host, zh["a11y.deviceVoiceInput"]);

    await fireEvent.click(buttonByText(host, zh["perm.allow"])!);
    await settle();

    expect(buttonByText(host, zh["perm.allow"])).toBeUndefined();
    expect(capSet(loadLedger(), "ai", "microphone")).toBe(true);
  });
});

describe("StreamVoiceButton.svelte（提示采纳写入的判决）", () => {
  const props = { online: true, session: () => "s" };

  test("被拒的授权：提示不关闭、说出拒写、账本仍未授予", async () => {
    refuseLedgerWrites = true;
    const host = render(StreamVoiceButton, { props });
    const allow = await openMicPrompt(host, zh["a11y.streamingVoiceInput"]);
    expect(allow).toBeTruthy();

    await fireEvent.click(allow!);
    await settle();

    expect(buttonByText(host, zh["perm.allow"])).toBeTruthy();
    expect(errorText(host)).toBe(REFUSED);
    expect(capSet(loadLedger(), "ai", "microphone")).toBe(false);
  });

  test("落地的授权：提示关闭（对照）", async () => {
    const host = render(StreamVoiceButton, { props });
    await openMicPrompt(host, zh["a11y.streamingVoiceInput"]);

    await fireEvent.click(buttonByText(host, zh["perm.allow"])!);
    await settle();

    expect(buttonByText(host, zh["perm.allow"])).toBeUndefined();
    expect(capSet(loadLedger(), "ai", "microphone")).toBe(true);
  });
});

describe("MapsApp.svelte（定位提示采纳写入的判决）", () => {
  /** 按下「定位」按钮开出提示。 */
  const openLocPrompt = async (h: { container: HTMLElement }) => {
    await fireEvent.click(buttonByText(h, zh["maps.locate"])!);
    await settle();
    return buttonByText(h, zh["perm.allow"]);
  };

  test("被拒的定位授权：提示不关闭、说出拒写、账本仍未授予", async () => {
    refuseLedgerWrites = true;
    const host = render(MapsApp);
    const allow = await openLocPrompt(host);
    expect(allow, "未授予时应出现定位提示").toBeTruthy();

    await fireEvent.click(allow!);
    await settle();

    expect(buttonByText(host, zh["perm.allow"])).toBeTruthy();
    expect(errorText(host)).toBe(REFUSED);
    expect(capSet(loadLedger(), "maps", "location")).toBe(false);
  });

  test("落地的定位授权：提示关闭、无拒写陈述（对照）", async () => {
    const host = render(MapsApp);
    await openLocPrompt(host);

    await fireEvent.click(buttonByText(host, zh["perm.allow"])!);
    await settle();

    expect(buttonByText(host, zh["perm.allow"])).toBeUndefined();
    expect(errorBar(host)).toBeNull();
    expect(capSet(loadLedger(), "maps", "location")).toBe(true);
  });
});

describe("MagnifierApp.svelte（相机闸门采纳写入的判决）", () => {
  test("被拒的相机授权：闸门不打开、说出拒写、账本仍未授予", async () => {
    refuseLedgerWrites = true;
    const host = render(MagnifierApp);
    const allow = buttonByText(host, zh["perm.allow"]);
    expect(allow, "未授予时应停在授权闸门").toBeTruthy();

    await fireEvent.click(allow!);
    await settle();

    // 闸门仍在（`granted` 采纳的是持久账本 —— 那份没有授予）。
    expect(buttonByText(host, zh["perm.allow"])).toBeTruthy();
    expect(errorText(host)).toBe(REFUSED);
    expect(capSet(loadLedger(), "magnifier", "camera")).toBe(false);
  });

  test("落地的相机授权：闸门打开、无拒写陈述（对照）", async () => {
    const host = render(MagnifierApp);
    await fireEvent.click(buttonByText(host, zh["perm.allow"])!);
    await settle();

    expect(buttonByText(host, zh["perm.allow"])).toBeUndefined();
    expect(errorBar(host)).toBeNull();
    expect(capSet(loadLedger(), "magnifier", "camera")).toBe(true);
  });
});

// InterpApp 的两段式授权在各自的文件里（它需要 mock 后端；`vi.mock` 是按文件生效的，
// 放这里会波及上面五个真后端的用例）。
