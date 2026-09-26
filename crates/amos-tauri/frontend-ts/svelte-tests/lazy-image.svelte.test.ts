/**
 * DOM tests for LazyImage.svelte (REQ-A587).
 *
 * The component was never adopted, so these are its first tests — and the reason they exist is
 * that adopting it into the photo grid exposed three defects (see the component header): an
 * `<img src="">` that requests the *page* URL, a double decode through `new Image()`, and a
 * `<style>` that forced the caller's layout. Each one is pinned here, plus the fallback that
 * matters when there is no `IntersectionObserver` at all.
 *
 * happy-dom ships an `IntersectionObserver`, but it can never fire (no layout, no scroll), so
 * every test installs a **controllable** one: the test decides which elements are "visible".
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import LazyImage from "../src/svelte/components/LazyImage.svelte";
import { installFakeObserver } from "./lazy-observer";

const REAL = "data:image/png;base64,REALBYTES";
const PLACEHOLDER = "data:image/gif;base64,PLACEHOLDER";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LazyImage — 未看见之前不打请求、看见之后才给真 src", () => {
  test("未被观察者看见：根本没有 src 属性（不是 src=\"\"，那会去打页面自己的 URL）", async () => {
    installFakeObserver();
    const { container } = render(LazyImage, { props: { src: REAL, alt: "" } });
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.className).toContain("hidden-until-loaded");
  });

  test("被看见：src 变成真实图片，并且观察者被断开（不再白看）", async () => {
    const Fake = installFakeObserver();
    const { container } = render(LazyImage, { props: { src: REAL, alt: "" } });
    await tick();
    Fake.instances[0]!.reveal();
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(REAL);
    expect(Fake.instances[0]!.disconnected).toBe(true);
  });

  test("给了占位图：看见之前显示占位图（blur-up 的契约没被拿走）", async () => {
    installFakeObserver();
    const { container } = render(LazyImage, { props: { src: REAL, alt: "", placeholder: PLACEHOLDER } });
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(PLACEHOLDER);
    expect(img.className).not.toContain("hidden-until-loaded");
  });

  test("观察者把 threshold/rootMargin 传给浏览器，而不是写死", async () => {
    const Fake = installFakeObserver();
    render(LazyImage, { props: { src: REAL, alt: "", threshold: 0.5, rootMargin: "120px" } });
    await tick();
    expect(Fake.instances[0]!.options).toMatchObject({ threshold: 0.5, rootMargin: "120px" });
  });

  test("元素自己的 load/error 事件驱动状态与回调（一次取、一次解码）", async () => {
    installFakeObserver();
    const onload = vi.fn();
    const onerror = vi.fn();
    const { container } = render(LazyImage, { props: { src: REAL, alt: "", onload, onerror } });
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    await img.dispatchEvent(new Event("load"));
    expect(onload).toHaveBeenCalledTimes(1);
    expect(img.className).toContain("loaded");
    await img.dispatchEvent(new Event("error"));
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(img.className).toContain("error");
  });

  test("没有 IntersectionObserver（非浏览器构建）：立即显示真图，绝不永远藏着", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(LazyImage, { props: { src: REAL, alt: "" } });
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(REAL);
  });

  test("组件自己不带布局：调用方的定位类说了算", async () => {
    installFakeObserver();
    const { container } = render(LazyImage, {
      props: { src: REAL, alt: "", class: "absolute inset-0 h-full w-full object-cover" },
    });
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.className).toContain("h-full");
    // 旧的 `width:100%; height:auto` 会跟这套定位打架；现在样式里只剩 `display:block`。
    const css = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    expect(css).not.toContain("height: auto");
  });
});
