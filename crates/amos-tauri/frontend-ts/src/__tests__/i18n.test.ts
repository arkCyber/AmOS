import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { translate } from "../i18n";
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";
import { isLocale } from "../i18n/types";

describe("i18n", () => {
  test("translates known keys per locale", () => {
    expect(translate(zh, "app.phone")).toBe("电话");
    expect(translate(en, "app.phone")).toBe("Phone");
    expect(translate(zh, "home.greeting")).toBe("你好，Amos");
    expect(translate(en, "home.greeting")).toBe("Hello, Amos");
  });

  test("falls back to the key when a dictionary entry is missing", () => {
    expect(translate(zh, "missing.key")).toBe("missing.key");
  });

  test("interpolates {params}", () => {
    expect(translate(zh, "count.notifications", { n: 3 })).toBe("3 条通知");
    expect(translate(en, "count.notifications", { n: 7 })).toBe("7 notifications");
  });

  test("zh and en dictionaries expose the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  test("isLocale accepts only supported locales", () => {
    expect(isLocale("zh")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });

  test("every literal t(\"...\") key in src exists in both dictionaries (no bare-key leaks)", () => {
    const dictKeys = new Set([...Object.keys(zh), ...Object.keys(en)]);
    const seen = new Set<string>();
    const srcRoot = new URL("../", import.meta.url).pathname; // …/frontend-ts/src
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name === "__tests__" || ent.name === "locales") continue;
        const p = `${dir}/${ent.name}`;
        if (ent.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(ent.name)) files.push(p);
      }
    };
    walk(`${srcRoot}`);
    const re = /\bt\(\s*["'`]([A-Za-z0-9.]+)["'`]/g;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const k = m[1];
        if (k) seen.add(k);
      }
    }
    expect(seen.size).toBeGreaterThan(50); // sanity: we really scanned usages
    const missing = [...seen].filter((k) => !dictKeys.has(k));
    expect(missing).toEqual([]);
  });
});
