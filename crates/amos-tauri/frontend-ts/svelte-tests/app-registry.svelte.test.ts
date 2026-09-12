/**
 * app-registry.svelte.test.ts — React-free Svelte app registry (Phase-3 foundation).
 *
 * Every built-in app id must map to a Svelte screen loader, and each loader must
 * resolve to a real component. This is what a future Svelte top-level shell will
 * use to mount a screen by id (the React-free counterpart of apps.tsx COMPONENTS).
 */
import { describe, expect, test } from "vitest";
import { SVELTE_APP_LOADERS, svelteAppLoader } from "../src/svelte/appRegistry";

const EXPECTED: string[] = [
  "clock", "settings", "calculator", "weather", "notes", "reminders", "calendar",
  "vmemos", "photos", "files", "android", "messages", "phone",
  "music", "player", "maps", "camera", "ai", "interpreter", "mail",
  "store", "privacy", "contacts", "magnifier", "monitor", "devocare", "terminal",
];

describe("svelte/appRegistry.ts", () => {
  test("covers exactly the 27 built-in app ids", () => {
    expect(Object.keys(SVELTE_APP_LOADERS).sort()).toEqual([...EXPECTED].sort());
  });

  test("every id resolves to a Svelte component module", async () => {
    for (const id of EXPECTED) {
      const load = svelteAppLoader(id);
      expect(load, `missing loader for ${id}`).toBeTruthy();
      const mod = await load!();
      expect(mod.default, `${id} resolved without a default component`).toBeTruthy();
    }
  });
});
