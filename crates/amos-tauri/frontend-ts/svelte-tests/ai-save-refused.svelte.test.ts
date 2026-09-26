/**
 * REQ-A1379 / F-SH-642 — 拒写的 AI 保存不得宣称「已保存」，也不得切换在跑的引擎。
 *
 * `AiPage.saveAi` was `readStoreValue(...) → writeStoreValue(...) → if (bridged())
 * switchAiBackend(...) else aiMsg = 「已保存」`. `writeStoreValue` is `void`: a refused
 * `setItem` dispatches no `STORE_CHANGED_EVENT` and hands its `false` to nobody. So on a
 * full/unavailable store the page printed 「已保存。重启 amos-ai 后生效」 in the success
 * colour *and*, with a host, went on to switch the live AI backend — while the blob that
 * `readAiConfig` reads back at mount was never written (the provider reverts on the next
 * open) and the daemon's restart env still names the old backend.
 *
 * 这个形状与 `store-refusal-sweep.svelte.test.ts` 的六个叶子**不同**：那六个是
 * 「local = next; void write」——把本地副本先挪了；这里是**写字没落地就先报成功**，而且
 * 成功报告后面还跟着一个真实的副作用（`ai_backend_switch`）。所以负控也分开打：
 * 一控「报告」（把拒绝分支去掉），二控「副作用」（把 `return` 去掉、只改报告）。
 *
 * 如实边界：本轮只动 `AiPage.saveAi`。同族的其它 void 写（`WeatherApp` ∕ `CompassApp`
 * 的 `$effect` 镜像写、`NotificationCenter` 的通知增删、以及各 apply 的**首启种子**写）
 * 本轮**不看**——前两者的键除本页外**没有第二个读者**，第三种的显示本就由 store 驱动
 * （拒写 = 静默 no-op，不是假成功），种子写失败只是没有演示数据。都不属于「宣称已保存」
 * 这一条。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AiPage from "../src/svelte/settings/AiPage.svelte";
import { SETTINGS_KEY } from "../src/lib/settings";
import { readAiConfig } from "../src/lib/providers";
import { t } from "../src/svelte/locale.svelte";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** Every `localStorage.setItem` throws — a full or unavailable store, the real refusal path. */
const refuseWrites = () =>
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
const save = (container: HTMLElement) => button(container, t("settings.aiSave"))!;
const refusal = (container: HTMLElement) =>
  container.querySelector('[data-testid="store-write-error"]');

/** Pick a cloud provider so `saveAi` reaches the store write (local has no fields). */
const pickCloud = async (container: HTMLElement) => {
  await fireEvent.click(button(container, t("settings.aiDeepseek"))!);
  await settle();
};

describe("REQ-A1379 — 拒写的 AI 保存不得报成功", () => {
  test("被拒的保存：说拒写、不说已保存、键未写", async () => {
    const host = render(AiPage);
    await settle();
    await pickCloud(host.container);

    refuseWrites();
    await fireEvent.click(save(host.container));
    await settle();

    // The store holds nothing…
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
    // …so the page must not claim the save landed…
    expect(host.container.textContent).not.toContain(t("settings.aiSaved"));
    expect(host.container.textContent).not.toContain(t("settings.aiApplied"));
    // …and it must say why (the shared refusal line every other surface uses).
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("被拒的保存不得切换在跑的引擎（副作用与它依赖的那次写在同一道闸里）", async () => {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
    };
    const host = render(AiPage);
    await settle();
    await pickCloud(host.container);

    refuseWrites();
    await fireEvent.click(save(host.container));
    await settle();

    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
    // The daemon still runs the provider it ran before: the config that would describe the
    // new one was never persisted, so switching would leave the two disagreeing.
    expect(calls).not.toContain("ai_backend_switch");
    expect(refusal(host.container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("写落地的保存照常报成功，且拒写那一行随之消失（正控）", async () => {
    const host = render(AiPage);
    await settle();
    await pickCloud(host.container);

    // One refusal only: the spy calls through to the real `setItem` afterwards.
    vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("QuotaExceededError");
    });
    await fireEvent.click(save(host.container));
    await settle();
    expect(refusal(host.container)).not.toBeNull();

    await fireEvent.click(save(host.container));
    await settle();

    expect(refusal(host.container)).toBeNull();
    expect(host.container.textContent).toContain(t("settings.aiSaved"));
    // The blob now carries the choice the form showed — the round trip proves the write
    // this page reports on is the one its own mount read consumes.
    expect(readAiConfig(JSON.parse(window.localStorage.getItem(SETTINGS_KEY)!)).provider).toBe(
      "deepseek",
    );
  });
});
