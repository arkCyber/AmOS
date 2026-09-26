/**
 * REQ-A1942 / F-SH-939 — 切换失败的后端不得被报成「已保存」。
 *
 * `AiPage.saveAi` 在 `bridged()` 分支里 `switchAiBackend(...).then((report) => …)`，把
 * `report` 为假一律当成成功：`aiMsg = report ? 「已应用」+report : 「已保存。重启 amos-ai
 * 后生效」`（成功色）。但 `lib/backend.ts::invoke` 是**自己 catch 再答 `null`**——它把 Tauri
 * 抛来的 `AmosError` 信封交给 `noteDiag` 后返回 `null`，所以 `switchAiBackend` 的 `null` 有
 * **两个**成因：①「不在 Tauri 里」（本分支已由 `bridged()` 排除）②「命令答了 `Err`」——
 * 脚本起不来守护进程（缺 key、缺 endpoint、二进制没编）。第二种下这一页会打出一句**成功**
 * 话术，而那句「openai requires an API key」的原由被丢掉，只剩诊断台账里。
 *
 * 这一页自己在**拒写**那一侧已经立过同一条规矩（见上方 `saveAi` 的注释与
 * `ai-save-refused.svelte.test.ts`）：「A success sentence on a write that never landed is the
 * one thing this page must not say」。本文件补的是它的**下一层**：那一次写**落地**了、而
 * 后面的 `ai_backend_switch` 失败时，同样不许报成功。
 *
 * 判据不是「`null` 就是失败」（那会把 `bridged()` 为假的那条路——配置只存本机、无宿主——
 * 也误报），而是问台账：`bridgeDiag("ai_backend_switch").ok`。这是本仓既有的读法
 *（`StreamVoiceButton` ∕ `MessagesApp` ∕ `ScreenRecordingTile` 等十处都这么读）。
 *
 * 如实边界：本轮只动 `AiPage.saveAi` 的报告分支与 `switchAiBackend` 的 doc。`invoke` 的
 * `T | null` 契约、`getAiStatus` 的刷新、以及其它把 `null` 当成功的调用点本轮**不看**。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AiPage from "../src/svelte/settings/AiPage.svelte";
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

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
const save = (container: HTMLElement) => button(container, t("settings.aiSave"))!;

/** Pick a cloud provider so `saveAi` reaches `switchAiBackend` (local has no fields). */
const pickCloud = async (container: HTMLElement) => {
  await fireEvent.click(button(container, t("settings.aiDeepseek"))!);
  await settle();
};

/**
 * A host whose `ai_backend_switch` answers `Err`, i.e. what `invoke` turns into `null`.
 *
 * The thrown value is the shape Tauri hands back for a `Result<T, AmosError>`: the
 * `code`/`message`/`cause` envelope. `invoke` consumes it (records the diagnostic) and
 * returns `null` — exactly the production path, so the test never has to mock `invoke`
 * itself.
 */
const switchFails = () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "ai_backend_switch") {
        throw {
          code: "amos.ai.backend_switch_failed",
          message: "ai-backend.sh failed (see cause)",
          cause: ["openai requires an API key (arg or AMOS_API_KEY)"],
        };
      }
      return null;
    },
  };
};

describe("REQ-A1942 — 切换失败的后端不得报成功", () => {
  test("命令答 Err 时：说失败、不说已保存/已应用", async () => {
    switchFails();
    const host = render(AiPage);
    await settle();
    await pickCloud(host.container);

    await fireEvent.click(save(host.container));
    await settle();

    // The store write DID land (that is why the switch was attempted at all)…
    expect(window.localStorage.getItem("amos.settings")).not.toBeNull();
    // …but the backend did not switch, so no success sentence.
    expect(host.container.textContent).not.toContain(t("settings.aiSaved"));
    expect(host.container.textContent).not.toContain(t("settings.aiApplied"));
    // And the failure has to be visible on the page, not only on the diagnostic ledger.
    expect(host.container.querySelector('[data-testid="ai-switch-error"]')?.textContent).toContain(
      t("settings.aiSwitchFailed"),
    );
  });

  test("切换成功时照常报「已应用」+ 报告，且失败行不出现（正控）", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "ai_backend_switch" ? "ready: /tmp/amos-ai.sock" : null,
    };
    const host = render(AiPage);
    await settle();
    await pickCloud(host.container);

    await fireEvent.click(save(host.container));
    await settle();

    expect(host.container.textContent).toContain(t("settings.aiApplied"));
    expect(host.container.textContent).toContain("ready: /tmp/amos-ai.sock");
    expect(host.container.querySelector('[data-testid="ai-switch-error"]')).toBeNull();
  });

  test("无宿主（不在 Tauri 里）仍报「已保存」——那一次切换根本没发生，不是失败（对照）", async () => {
    // No `__TAURI_INTERNALS__`: `bridged()` is false, so `saveAi` takes the else branch.
    const host = render(AiPage);
    await settle();
    await pickCloud(host.container);

    await fireEvent.click(save(host.container));
    await settle();

    expect(host.container.textContent).toContain(t("settings.aiSaved"));
    expect(host.container.querySelector('[data-testid="ai-switch-error"]')).toBeNull();
  });
});
