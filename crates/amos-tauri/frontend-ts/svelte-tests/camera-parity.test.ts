/**
 * React ↔ Svelte dual-implementation parity tests for the CAMERA screen (offline).
 *
 * The React CameraApp (src/components/CameraApp.tsx → COMPONENTS.camera, via
 * apps.tsx) and the Svelte CameraApp (src/svelte/CameraApp.svelte) share
 * lib/camera + lib/cameraCapture + lib/photos. With NO navigator.mediaDevices
 * (happy-dom) BOTH must degrade to the same demo viewfinder: a localized
 * "no camera" hint, the 🏔️ placeholder and a disabled shutter/flip. Real
 * viewfinder pixels/torch/recording need a device → device acceptance.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import CameraApp from "../src/svelte/CameraApp.svelte";
import { I18nProvider } from "../src/i18n";
import { AppComponent } from "../src/apps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.clear();
});
const settle = () => new Promise((r) => setTimeout(r, 30));

function mountReactCamera() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "camera" }),
    ),
  );
  return host;
}
const buttonByAria = (root: HTMLElement, aria: string) =>
  [...root.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === aria) as
    HTMLButtonElement | undefined;
const txt = (root: HTMLElement) => root.textContent ?? "";

describe("React ↔ Svelte camera parity (offline, no camera)", () => {
  test("no-camera demo viewfinder + disabled shutter/flip match in both", async () => {
    // --- React (offline) ---
    const react = mountReactCamera();
    await act(async () => {});
    await settle();
    expect(txt(react)).toContain("当前环境无摄像头"); // camera.noCamera
    expect(txt(react)).toContain("🏔️"); // demo viewfinder
    expect(buttonByAria(react, "shutter")?.disabled).toBe(true);
    expect(buttonByAria(react, "翻转摄像头")?.disabled).toBe(true);

    // --- Svelte (offline) ---
    const svelte = render(CameraApp);
    await settle();
    expect(txt(svelte.container)).toContain("当前环境无摄像头");
    expect(txt(svelte.container)).toContain("🏔️");
    expect(buttonByAria(svelte.container, "shutter")?.disabled).toBe(true);
    expect(buttonByAria(svelte.container, "翻转摄像头")?.disabled).toBe(true);
  });
});
