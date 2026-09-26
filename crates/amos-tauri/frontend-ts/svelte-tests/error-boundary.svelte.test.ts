/**
 * error-boundary.svelte.test.ts — 错误边界兜底界面的 DOM 契约（REQ-A504）。
 *
 * 此前这个组件**一条测试都没有**，而它是整个应用**最后一道可见的防线**（`WebManApp` 用它包住全部
 * UI，它还装着 window 级的 `error`/`unhandledrejection` 监听）。本轮把它默认兜底界面从
 * **HTML 模板字符串 + `{@html}`** 改成真 markup 之后，这里钉住三件事：
 *   1. 文案走 `t()` —— 跟随当前语言，而不是写死中文；
 *   2. 错误文本被**转义**渲染（旧实现用 `{@html}` 把它当原始 HTML 插进去）；
 *   3. 「重试」真的把界面恢复成子内容。
 *
 * 驱动方式是**平台真的会派发的那个事件**（`error`），与 `uiFailures.test.ts` 同一套做法：
 * 组件捕获子组件错误靠的正是这个 window 监听。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ErrorBoundary from "../src/svelte/modules/ErrorBoundary.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

afterEach(() => {
  cleanup();
  setLocale("zh");
  vi.restoreAllMocks();
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

/** The event the platform emits when a child throws (see `uiFailures.test.ts`). */
function errorEvent(message: string, error?: Error): Event {
  const ev = new Event("error", { cancelable: true });
  const e = ev as unknown as { message?: string; error?: unknown };
  e.message = message;
  e.error = error;
  return ev;
}

async function crash(host: { container: HTMLElement }, error?: Error) {
  window.dispatchEvent(errorEvent(error?.message ?? "boom", error));
  await tick();
  return host;
}

describe("REQ-A504: 错误边界兜底界面", () => {
  test("抛错后按当前语言渲染兜底文案（中文）", async () => {
    const host = render(ErrorBoundary);
    await crash(host, new Error("boom"));

    expect(txt(host)).toContain(zh["errorBoundary.title"]);
    expect(txt(host)).toContain(zh["errorBoundary.details"]);
    expect(txt(host)).toContain(zh["errorBoundary.retry"]);
    expect(host.container.querySelector('[data-testid="error-boundary-details"]')).not.toBeNull();
  });

  test("同一份界面在英文下显示英文（旧实现把中文写死在 HTML 里）", async () => {
    setLocale("en");
    const host = render(ErrorBoundary);
    await crash(host, new Error("boom"));

    expect(txt(host)).toContain(en["errorBoundary.title"]);
    expect(txt(host)).toContain(en["errorBoundary.retry"]);
    expect(txt(host)).not.toContain(zh["errorBoundary.title"]);
  });

  test("错误文本被**转义**渲染：`<img onerror=…>` 不会变成真的元素", async () => {
    const host = render(ErrorBoundary);
    const payload = '<img src=x onerror="alert(1)">';
    await crash(host, new Error(payload));

    const details = host.container.querySelector('[data-testid="error-boundary-details"]');
    // 文本**原样可见**（用户/开发要看到它）……
    expect(details?.textContent ?? "").toContain(payload);
    // ……但它是文本，不是被解析出来的节点（这正是丢掉 `{@html}` 的原因）。
    expect(host.container.querySelector("img")).toBeNull();
  });

  test("「重试」清掉错误状态：兜底界面消失，恢复渲染子内容", async () => {
    const host = render(ErrorBoundary);
    await crash(host, new Error("boom"));
    expect(host.container.querySelector('[data-testid="error-boundary-details"]')).not.toBeNull();

    const retry = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["errorBoundary.retry"]),
    ) as HTMLButtonElement;
    await fireEvent.click(retry);
    await tick();

    expect(host.container.querySelector('[data-testid="error-boundary-details"]')).toBeNull();
    expect(txt(host)).not.toContain(zh["errorBoundary.title"]);
  });

  test("兜底界面里没有裸的 `{@html}` 产物：整块由真实元素组成", async () => {
    const host = render(ErrorBoundary);
    await crash(host, new Error("boom"));

    // 旧实现是 `{@html DefaultFallback(error)}` —— 一个 div 包着一整张卡片，只此一层。
    const fallback = host.container.querySelector('[data-testid="error-boundary-details"]');
    expect(fallback?.closest("details")).not.toBeNull();
    expect(fallback?.closest("div")?.parentElement?.tagName).toBe("DIV");
  });
});
