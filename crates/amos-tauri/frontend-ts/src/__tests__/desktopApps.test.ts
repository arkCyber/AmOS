/**
 * desktopApps.test.ts — runtime form-factor reader used by the Svelte app registry.
 *
 * `desktopFormActive()` is the single answer the registry reads; tests assert it
 * follows `setFormFactor()` deterministically and that no host means `false` (the
 * conservative answer that keeps phone apps available — same rule `formLayout`
 * uses for the home grid).
 */
import { afterEach, describe, expect, test } from "vitest";
import { desktopFormActive, setFormFactor } from "../lib/desktopApps";

afterEach(() => setFormFactor(null));

describe("lib/desktopApps.ts", () => {
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
});
