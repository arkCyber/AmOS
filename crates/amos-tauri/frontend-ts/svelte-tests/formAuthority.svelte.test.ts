/**
 * formAuthority — the **one** runtime device-class reader.
 *
 * Lives in `svelte-tests/` (not `src/__tests__`) because it covers a rune module
 * (`formAuthority.svelte.ts`): the bun batch has no `.svelte.ts`/rune loader, so the
 * file would fail to even *parse* there (`Can't find variable: $state`). Vitest compiles
 * it with vite-plugin-svelte, which is exactly the environment the module ships in.
 *
 * `desktopFormActive()` is the single answer the app registry reads;
 * `currentFormFactor()` is the broader reader used by form-aware app screens
 * (PhotosApp, PwaHubApp, SettingsApp, …) so they can lay themselves out per class
 * without prop-drilling through Shell.svelte's dynamic `<AppComp />` mount. Both read
 * the same module-level rune and tests assert both follow `setFormFactor()`
 * deterministically and that no host means the conservative default (phone apps
 * available / `null` form).
 */
import { afterEach, describe, expect, test } from "vitest";
import { currentFormFactor, desktopFormActive, setFormFactor } from "../src/lib/formAuthority.svelte";

afterEach(() => setFormFactor(null));

describe("lib/formAuthority.svelte.ts", () => {
  test("no host → not desktop (phone apps remain available)", () => {
    setFormFactor(null);
    expect(desktopFormActive()).toBe(false);
  });

  test("phone form → not desktop", () => {
    setFormFactor("phone");
    expect(desktopFormActive()).toBe(false);
  });

  test("tablet form → not desktop", () => {
    setFormFactor("tablet");
    expect(desktopFormActive()).toBe(false);
  });

  test("robot form → not desktop", () => {
    setFormFactor("robot");
    expect(desktopFormActive()).toBe(false);
  });

  test("desktop form → desktopFormActive() === true", () => {
    setFormFactor("desktop");
    expect(desktopFormActive()).toBe(true);
  });

  test("currentFormFactor() returns null when no host has answered (REQ-A292)", () => {
    // The conservative default — every reader MUST treat null as the phone's plan
    // (mirrors `formLayout`'s "unmeasured screen degrades to the phone" rule).
    setFormFactor(null);
    expect(currentFormFactor()).toBeNull();
  });

  test("currentFormFactor() returns whatever setFormFactor() wrote, per class", () => {
    for (const f of ["phone", "tablet", "desktop", "robot"] as const) {
      setFormFactor(f);
      expect(currentFormFactor()).toBe(f);
    }
  });
});
