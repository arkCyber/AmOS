/**
 * webman-iframe-posture.svelte.test.ts — 浏览器 iframe 的**真实**安全姿态（REQ-A501）。
 *
 * 背景（本轮实测）：`WebManApp` 里曾有一个自称「Iframe 通信安全 (P1)」的 `message` 监听器，
 * 而它**在任何模式下都收不到一条消息**：iframe 的 `sandbox` 没有 `allow-same-origin` ⇒ 它运行在
 * 不透明来源上，`postMessage` 的 `event.origin` 恒为 `"null"`，而白名单（dev 的 localhost /
 * 生产的占位域名 `https://trusted-domain.com`）里没有 `"null"`。它既没保护什么、也没被谁使用，
 * 于是删掉；本文件钉住**删掉之后仍然成立的那几条真保护**，以及"那个假监听器不许回来"。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  setFormFactor(null);
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 一个已打开真实页面的标签：只有这种状态才渲染 iframe。
 *
 *  URL 故意用**回环**地址：`happy-dom` 会真的去加载 iframe 的 `src`，指向公网就等于让测试触网
 *  （本仓的 `net-sentinel.mjs` 明文禁止："the suite proves, at RUNTIME, that it never reaches
 *  the network"）。`127.0.0.1:1` 立刻连接被拒，全程离线 —— 与仓内用回环 socket 做联机的既有做法一致。
 */
function seedTab() {
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        {
          id: "tab-1",
          url: "http://127.0.0.1:1/",
          title: "127.0.0.1",
          favicon: "",
          loading: false,
          scrollY: 0,
          pinned: false,
        },
      ],
    }),
  );
}

function iframeOf(host: { container: HTMLElement }): HTMLIFrameElement | null {
  return host.container.querySelector("iframe");
}

describe("REQ-A501: iframe 的安全属性（真保护）", () => {
  test("sandbox 里**没有** `allow-same-origin`（不透明来源 = 拿不到本窗口的任何东西）", async () => {
    seedTab();
    // 大屏类别（桌面 / 平板）才走内联分支（iframe）；手机类别是另一条路径。
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    const frame = iframeOf(host);
    expect(frame).not.toBeNull();
    const sandbox = frame!.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  test("权限策略里相机/麦克风/定位都是 `'none'`，且不转发 referrer", async () => {
    seedTab();
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    const frame = iframeOf(host)!;
    const allow = frame.getAttribute("allow") ?? "";
    for (const feature of ["camera", "microphone", "geolocation"]) {
      expect(allow).toContain(`${feature} 'none'`);
    }
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  test("REQ-A1560/F4: 跨源帧显式授予 `fullscreen`（默认允许列表是 `self`，不写就等于静默拒绝）", async () => {
    seedTab();
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    const frame = iframeOf(host)!;
    const allow = frame.getAttribute("allow") ?? "";
    // `frame` 里的 `fullscreen` 不带 `'none'` —— 这一条是**授权**，与前三个**拒绝**并列。
    expect(allow).toContain("fullscreen");
    expect(allow).not.toContain("fullscreen 'none'");
    // 旧式属性，兼容不支持 `allow="fullscreen"` 的引擎。
    expect(frame.hasAttribute("allowfullscreen")).toBe(true);
    // 反面：授权 fullscreen 不能顺手把三个隐私项放开。
    for (const feature of ["camera", "microphone", "geolocation"]) {
      expect(allow).toContain(`${feature} 'none'`);
    }
  });

  test("这个组件**不再**注册 `message` 监听器（那台「永远返回 false 的机器」不许回来）", async () => {
    seedTab();
    setFormFactor("desktop");
    const addSpy = vi.spyOn(window, "addEventListener");
    const host = render(WebManApp);
    await settle();

    const registered = addSpy.mock.calls.map((c) => String(c[0]));
    expect(registered).not.toContain("message");
    // 键盘通道仍然在（那是真的在用的一条）。
    expect(registered).toContain("keydown");
    expect(host.container).toBeTruthy();
    addSpy.mockRestore();
  });
});

describe("REQ-A554: 内联与否由宿主的类别决定，**不是**视口宽度", () => {
  test("平板（无论视口多窄）走内联 iframe —— 视口宽窄不改变判定", async () => {
    seedTab();
    setFormFactor("tablet");
    // 一个远比旧阈值窄的视口：若还有 `innerWidth >= 768` 的残留，这里会掉进 punt 分支。
    vi.stubGlobal("innerWidth", 320);
    const host = render(WebManApp);
    await settle();

    expect(iframeOf(host)).not.toBeNull();
  });

  test("手机类别即使是宽视口也**不**内联（旧代码会被 1200 px 骗成桌面分支）", async () => {
    seedTab();
    setFormFactor("phone");
    vi.stubGlobal("innerWidth", 1200);
    const host = render(WebManApp);
    await settle();

    expect(iframeOf(host)).toBeNull();
  });

  test("宿主尚未作答（`null`）⇒ 保守按手机 ⇒ 不内联", async () => {
    seedTab();
    setFormFactor(null);
    vi.stubGlobal("innerWidth", 1200);
    const host = render(WebManApp);
    await settle();

    expect(iframeOf(host)).toBeNull();
  });
});
