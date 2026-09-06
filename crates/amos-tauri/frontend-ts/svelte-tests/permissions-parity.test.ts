/**
 * React ↔ Svelte dual-implementation parity tests for the PRIVACY/PERMISSIONS
 * screen.
 *
 * Both the React `PermissionsApp` (src/components/PermissionsApp.tsx, registered
 * as "privacy") and the Svelte `PermissionsApp` (src/svelte/PermissionsApp.svelte)
 * drive the same pure lib/permissions.ts ledger. Both run OFFLINE here (no bridge),
 * so parity is about the local grant/revoke toggle wiring: an identical click must
 * flip the candidate's aria-pressed the same way in both.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import PermissionsApp from "../src/svelte/PermissionsApp.svelte";
import { I18nProvider } from "../src/i18n";
import { AppComponent } from "../src/apps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedReact: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mountedReact.length) {
    const m = mountedReact.pop()!;
    m.root.unmount();
    m.host.remove();
  }
});

function mountReactPrivacy() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "privacy" }),
    ),
  );
  return host;
}
const clearStore = () => window.localStorage.clear();
const cameraCandidate = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((b) =>
    (b.textContent ?? "").startsWith("相机 ·"),
  );

describe("React ↔ Svelte privacy/permissions parity", () => {
  test("granting camera to the camera app flips aria-pressed in both", async () => {
    clearStore();
    const react = mountReactPrivacy();
    await act(async () => {});
    expect(cameraCandidate(react)?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      cameraCandidate(react)!.click();
    });
    expect(cameraCandidate(react)?.getAttribute("aria-pressed")).toBe("true");

    clearStore();
    const svelte = render(PermissionsApp);
    expect(cameraCandidate(svelte.container)?.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(cameraCandidate(svelte.container)!);
    expect(cameraCandidate(svelte.container)?.getAttribute("aria-pressed")).toBe("true");
  });

  test("revoking via the holder chip clears it in both", async () => {
    clearStore();
    const react = mountReactPrivacy();
    await act(async () => {});
    await act(async () => {
      cameraCandidate(react)!.click(); // grant
    });
    expect(cameraCandidate(react)?.getAttribute("aria-pressed")).toBe("true");
    // click the green holder chip "相机 ✕"
    const holderReact = [...react.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("相机") && (b.textContent ?? "").includes("✕"),
    )!;
    await act(async () => {
      holderReact.click();
    });
    expect(cameraCandidate(react)?.getAttribute("aria-pressed")).toBe("false");

    clearStore();
    const svelte = render(PermissionsApp);
    await fireEvent.click(cameraCandidate(svelte.container)!); // grant
    const holderSvelte = [...svelte.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("相机") && (b.textContent ?? "").includes("✕"),
    )!;
    expect(holderSvelte).toBeTruthy();
    await fireEvent.click(holderSvelte);
    expect(cameraCandidate(svelte.container)?.getAttribute("aria-pressed")).toBe("false");
  });
});
