/**
 * webman-open-external.test.ts —— `openInExternalBrowser` 的诚实契约（REQ-A1168）。
 *
 * 这条出口把 URL 交给**宿主的系统浏览器**（机制复用 `lib/shortcuts.ts::openExternal` 的
 * `globalThis.open(url, "_blank", "noopener,noreferrer")`）。它签成**布尔**而非 `void`：
 * 宿主没提供 opener 时 `globalThis.open` 静默丢弃，`void` 会让"没打开"和"打开了"长得一样，
 * 调用方就只能撒谎。这里把两种情形钉住（有 opener 转发 / 无 opener 拒绝）。
 *
 * 本文件不注册 happy-dom：考的全是不碰 DOM 的纯逻辑，`globalThis.open` 直接换掉即可
 * （`bun:test` 的 `vi` 没有 `stubGlobal`）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { openInExternalBrowser } from "../webman";

type OpenFn = (url: string, target?: string, features?: string) => unknown;
const g = globalThis as { open?: OpenFn };
const originalOpen = g.open;

afterEach(() => {
  g.open = originalOpen;
});

describe("openInExternalBrowser", () => {
  test("有 opener ⇒ 以 _blank + noopener,noreferrer 转发，并答 true", () => {
    const calls: Array<[string, string?, string?]> = [];
    g.open = (url, target, features) => {
      calls.push([url, target, features]);
    };

    expect(openInExternalBrowser("https://example.com")).toBe(true);
    expect(calls).toEqual([["https://example.com", "_blank", "noopener,noreferrer"]]);
  });

  test("宿主没提供 opener ⇒ 答 false（不假装打开过）", () => {
    g.open = undefined;
    expect(openInExternalBrowser("https://example.com")).toBe(false);
  });
});
