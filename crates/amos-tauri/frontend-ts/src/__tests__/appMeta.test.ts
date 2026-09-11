import { describe, expect, test } from "bun:test";
import {
  APP_META,
  appIcon,
  appIds,
  appMetaById,
  appTitleKey,
  isKnownApp,
} from "../lib/appMeta";

/**
 * Pure contract tests for the React-free built-in app metadata
 * (src/lib/appMeta.ts) — the single source that apps.tsx re-exports as APPS.
 */
describe("appMeta (React-free built-in app metadata)", () => {
  test("covers 27 built-in apps with unique ids", () => {
    expect(APP_META.length).toBe(27);
    const ids = APP_META.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(appIds().length).toBe(27);
  });

  test("lookup helpers resolve titleKey / icon / presence", () => {
    expect(appTitleKey("phone")).toBe("app.phone");
    expect(appIcon("notes")).toBe("📝");
    expect(appIcon("calendar")).toBe("📅");
    expect(appTitleKey("calendar")).toBe("app.calendar");
    expect(isKnownApp("phone")).toBe(true);
    expect(appMetaById("mail")?.titleKey).toBe("app.mail");
    // Unknown ids are handled without throwing.
    expect(appTitleKey("nope")).toBeNull();
    expect(appIcon("nope")).toBe("🧩");
    expect(isKnownApp("nope")).toBe(false);
  });

  test("every meta entry uses a plausible titleKey namespace", () => {
    for (const a of APP_META) {
      expect(a.titleKey.startsWith("app.")).toBe(true);
      expect(a.icon.length).toBeGreaterThan(0);
    }
  });
});
