/**
 * DOM tests for what 「API 集成」 claims when the store **refuses** a write (REQ-A806).
 *
 * **The defect these pin.** `saveAPIConfig` read `apiClient.configure(apiConfig)` as "done" and
 * showed 「配置已保存」 for every outcome — but `configure` returned `void`, and the refusal the
 * store really produced stopped at `enterprise/logger.ts`, a `console.*` wrapper that **nothing
 * in the app read** (grep: imported by four modules, consumed by none). The user was told the
 * config was saved, and it was gone at the next launch. (That wrapper *is* the rendered ledger
 * now — REQ-A807 made it an adapter onto `lib/debugLog`, so the same line no longer needs this
 * screen's hand-added channel to be seen.)
 *
 * The repo's `write-scan` gate does not catch this: it requires a write's boolean be answered by
 * *some* caller, not that the answer reach a user-visible surface — and `logger.error` counts as
 * an answer. `KeyboardPage.svelte::reportWrite` names exactly this loophole in its own doc
 * comment ("the config-key exemption … is exactly what this page broke: it does make a claim").
 *
 * The webhook half is the same defect with a different verb: the modal **closing** is that
 * screen's "saved" claim, and it closed for refused writes too.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import APISettings from "../src/svelte/modules/APISettings.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { apiClient } from "../src/lib/enterprise/api";
import { webhookManager } from "../src/lib/enterprise";

/**
 * The two sentences the screen can show after a save attempt. Matched as **regexes**, not exact
 * strings: the banner renders `{status === "success" ? "✓" : "✗"} {message}`, so the element's
 * text is `"✓ Configuration saved"` and an exact-match lookup would never find it.
 */
const SAVED = /Configuration saved/;
const REFUSED = /in effect now, but this machine's store refused them/;

/** Run `fn` with `localStorage.setItem` refusing, the way a full or unavailable store does. */
function withRefusingStore<T>(fn: () => T): T {
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  try {
    return fn();
  } finally {
    localStorage.setItem = realSet;
  }
}

function mountEnabled() {
  apiClient.configure({
    enabled: true,
    baseUrl: "https://api.example.test",
    authType: "api_key",
    apiKey: "k-1",
  });
  return render(APISettings);
}

/** Open the webhook modal and fill the two required fields plus one subscribed event. */
async function fillWebhookModal(container: HTMLElement, getByText: (t: string) => HTMLElement) {
  await fireEvent.click(getByText("+ Add webhook"));
  await fireEvent.input(container.querySelector("#webhookName")!, { target: { value: "ops" } });
  await fireEvent.input(container.querySelector("#webhookUrl")!, {
    target: { value: "https://hooks.example.test/x" },
  });
  await fireEvent.click(container.querySelector(".events-checkboxes input")!);
}

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  for (const w of webhookManager.getWebhooks()) webhookManager.deleteWebhook(w.id!);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setLocale("en");
});

describe("存储拒绝写入时，屏幕不能说「已保存」（REQ-A806）", () => {
  test("对照组：存储正常时确实说「配置已保存」——否则下面那条「不出现」就没意义", async () => {
    const { getByText, queryByText, getByTestId } = mountEnabled();
    await fireEvent.click(getByTestId("api-config-save"));

    expect(getByText(SAVED)).toBeTruthy();
    expect(queryByText(/store refused/)).toBeNull();
  });

  test("存储拒绝时说的是**确实发生的那件事**：「已生效但没存进去」，不是「已保存」", async () => {
    const { getByTestId, queryByText } = mountEnabled();

    await withRefusingStore(async () => {
      await fireEvent.click(getByTestId("api-config-save"));
    });

    // The config IS in effect — the sentence must not pretend otherwise, or the user would
    // re-enter settings that are already working.
    expect(queryByText(SAVED)).toBeNull();
    expect(queryByText(REFUSED)).toBeTruthy();
    // …and the running client really is using it, so "in effect" is not a euphemism.
    expect(apiClient.getConfig().enabled).toBe(true);
  });

  test("Webhook 那半：存储拒绝时模态**不关**，并说明列表只是本会话有效", async () => {
    const { getByText, queryByText, container } = mountEnabled();
    await fillWebhookModal(container as unknown as HTMLElement, getByText as never);

    await withRefusingStore(async () => {
      await fireEvent.click(container.querySelector('[data-testid="api-webhook-save"]')!);
    });

    // Closing the modal is this screen's "saved" claim — so it must stay open, keeping the
    // user's input, and the note must say what the list below really is.
    expect(container.querySelector("#webhookName")).not.toBeNull();
    expect(container.querySelector('[data-testid="webhook-write-refused"]')).not.toBeNull();
    expect(queryByText(/refused the webhook list/)).toBeTruthy();
  });

  test("Webhook 对照组：存储正常时模态关掉，也没有那条说明", async () => {
    const { getByText, queryByText, container } = mountEnabled();
    await fillWebhookModal(container as unknown as HTMLElement, getByText as never);

    await fireEvent.click(container.querySelector('[data-testid="api-webhook-save"]')!);

    expect(container.querySelector("#webhookName")).toBeNull();
    expect(queryByText(/refused the webhook list/)).toBeNull();
    expect(webhookManager.getWebhooks()).toHaveLength(1);
  });
});
