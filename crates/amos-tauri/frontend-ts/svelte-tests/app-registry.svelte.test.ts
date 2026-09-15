/**
 * app-registry.svelte.test.ts — React-free Svelte app registry (Phase-3 foundation).
 *
 * Every built-in app id must map to a Svelte screen loader, and each loader must
 * resolve to a real component. This is what a future Svelte top-level shell will
 * use to mount a screen by id (the React-free counterpart of apps.tsx COMPONENTS).
 *
 * Phone apps (e.g. `phone`) are filtered out on desktop form factor — see
 * `svelteAppLoader`. The test below asserts both shapes: every id has a loader
 * in the underlying `ALL_APP_LOADERS` table (for phone/tablet/robot), and the
 * desktop-aware `svelteAppLoader` hides `phone` when `setFormFactor("desktop")`
 * is in effect.
 */
import { afterEach, describe, expect, test } from "vitest";
import { svelteAppLoader } from "../src/svelte/appRegistry";
import { setFormFactor } from "../src/lib/desktopApps";
import { PHONE_APP_IDS } from "../src/lib/phoneApps";

const EXPECTED: string[] = [
  "clock", "settings", "calculator", "weather", "notes", "reminders", "calendar",
  "vmemos", "photos", "files", "android", "messages", "phone",
  "music", "player", "maps", "camera", "ai", "interpreter", "mail",
  "store", "privacy", "contacts", "magnifier", "monitor", "devocare", "terminal", "pwa", "nativeapps",
];

afterEach(() => {
  // Don't leak the form factor between tests.
  setFormFactor(null);
});

describe("svelte/appRegistry.ts", () => {
  test("every id resolves to a Svelte component module (non-desktop form factor)", async () => {
    // Default: not desktop, so all 28 apps must resolve.
    setFormFactor("phone");
    for (const id of EXPECTED) {
      const load = svelteAppLoader(id);
      expect(load, `missing loader for ${id}`).toBeTruthy();
      const mod = await load!();
      expect(mod.default, `${id} resolved without a default component`).toBeTruthy();
    }
  });

  test("phone-only apps are hidden on desktop (REQ-A251: desktop cannot dial)", () => {
    setFormFactor("desktop");
    for (const id of PHONE_APP_IDS) {
      expect(svelteAppLoader(id), `${id} must be hidden on desktop`).toBeUndefined();
    }
  });

  test("non-phone apps remain available on desktop", () => {
    setFormFactor("desktop");
    for (const id of EXPECTED.filter((x) => !(PHONE_APP_IDS as readonly string[]).includes(x))) {
      expect(svelteAppLoader(id), `${id} must remain available on desktop`).toBeTruthy();
    }
  });
});
