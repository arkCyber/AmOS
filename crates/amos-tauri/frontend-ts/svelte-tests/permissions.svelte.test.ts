/**
 * DOM tests for the Svelte 5 privacy/permissions screen (PermissionsApp.svelte).
 *
 * Pure ledger logic is unit-tested once against lib/permissions.ts (shared by
 * the React + Svelte UIs). Here we verify the Svelte UI wiring works fully
 * OFFLINE: the daemon "recent access" audit section must stay hidden (no bridge),
 * while local grant/revoke toggles update the persisted ledger immediately.
 */
import { describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import PermissionsApp from "../src/svelte/PermissionsApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { PERMISSIONS_KEY } from "../src/lib/permissions";

function candidates(h: { container: HTMLElement }): HTMLButtonElement[] {
  return [...h.container.querySelectorAll("button[aria-pressed]")];
}
const cameraCandidate = (h: { container: HTMLElement }) =>
  candidates(h).find((b) => (b.textContent ?? "").startsWith("相机 ·"));

describe("PermissionsApp.svelte (offline ledger)", () => {
  test("no daemon audit section when offline; camera capability is listed", () => {
    const host = render(PermissionsApp);
    // auditOnline stays false → the audit section header is absent
    expect(host.container.textContent ?? "").not.toContain("最近访问");
    expect(cameraCandidate(host)).toBeTruthy();
  });

  test("granting the camera capability to the camera app persists to the ledger", async () => {
    const host = render(PermissionsApp);
    const cam = cameraCandidate(host)!;
    expect(cam.getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(cam);
    expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("true");

    const ledger = readStoreValue<Record<string, string[]>>(PERMISSIONS_KEY, {});
    expect((ledger.camera ?? []).includes("camera")).toBe(true);
  });

  test("revoking via the green holder chip clears the grant", async () => {
    const host = render(PermissionsApp);
    await fireEvent.click(cameraCandidate(host)!);
    expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("true");

    // The granted holder appears as a green chip "相机 ✕"; click to revoke.
    const holder = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("相机") && (b.textContent ?? "").includes("✕"),
    );
    expect(holder).toBeTruthy();
    await fireEvent.click(holder as HTMLButtonElement);

    expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("false");
    const ledger = readStoreValue<Record<string, string[]>>(PERMISSIONS_KEY, {});
    expect(ledger.camera ?? []).not.toContain("camera");
  });
});
