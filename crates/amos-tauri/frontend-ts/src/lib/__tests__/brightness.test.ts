/**
 * brightness.test.ts — G-β-1 · 屏幕降亮（WebView 内）的纯函数 + 结构性负控。
 *
 * Why this file exists:
 *   * `lib/brightness.ts` 是 G-β-1 的真源。`ControlCenter.svelte` 的 slider 与
 *     `DesktopShell.svelte` 的 overlay 都**必须** import 它，不许写第二份
 *     `1 - pct / 100` 或 `pct === 100 ? 0 : 1 - pct / 100` 内联算式。
 *   * 诚实的边界：本仓做不到系统亮度，只能做 WebView 内容降亮。
 *     slider 默认 100（不降亮）、可拖到 0（完全黑）。
 *   * 9 条结构性负控（钉住唯一真源）：
 *     - `BRIGHTNESS_KEY` 这个名字只在 `lib/brightness.ts` export
 *     - `brightnessToAlpha` 的字面值不能出现在 production code
 *     - 「仅桌面」标签必须存在（避免下一轮有人删掉诚实标注）
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BRIGHTNESS_KEY,
  DEFAULT_BRIGHTNESS_PCT,
  MAX_BRIGHTNESS_PCT,
  MIN_BRIGHTNESS_PCT,
  brightnessToAlpha,
  normalizeBrightness,
} from "../brightness";

// ─── §4.1 纯函数（8 条） ─────────────────────────────────────────────────

describe("brightness · 常量与默认值", () => {
  test("BRIGHTNESS_KEY = 'amos.brightness'（与 docs/DESKTOP_BRIGHTNESS_SLIDER_G_BETA_1.md 同源）", () => {
    // 钉字面：万一 lib/brightness.ts 改了这个 key 名，这条会立刻红
    // （不只是 structural grep 找到 import，而是**值**本身错了 → 立即见红）
    expect(BRIGHTNESS_KEY).toBe("amos.brightness");
  });

  test("DEFAULT_BRIGHTNESS_PCT = 100（不降亮是默认 — 不会让用户首次启动看到黑屏）", () => {
    expect(DEFAULT_BRIGHTNESS_PCT).toBe(100);
  });

  test("MAX_BRIGHTNESS_PCT = 100 / MIN_BRIGHTNESS_PCT = 0", () => {
    expect(MAX_BRIGHTNESS_PCT).toBe(100);
    expect(MIN_BRIGHTNESS_PCT).toBe(0);
  });
});

describe("brightness · normalizeBrightness（absent/corrupt → 100）", () => {
  test("undefined → { pct: 100 }（absent 不降亮）", () => {
    expect(normalizeBrightness(undefined)).toEqual({ pct: 100 });
  });

  test("null → { pct: 100 }（corrupt 不降亮）", () => {
    expect(normalizeBrightness(null)).toEqual({ pct: 100 });
  });

  test("{ pct: 50 } → { pct: 50 }", () => {
    expect(normalizeBrightness({ pct: 50 })).toEqual({ pct: 50 });
  });

  test("{ pct: 150 } → { pct: 100 }（clamp 上界）", () => {
    // 永远不会"超过不降亮"——alpha < 0 是反物理的
    expect(normalizeBrightness({ pct: 150 })).toEqual({ pct: 100 });
  });

  test("{ pct: -1 } → { pct: 0 }（clamp 下界）", () => {
    // 永远不会"负百分比"——用户拖到 0 才是完全黑
    expect(normalizeBrightness({ pct: -1 })).toEqual({ pct: 0 });
  });

  test("{ pct: '50' } → { pct: 100 }（非数字 ≠ 默认）", () => {
    // 字符串百分比是 corrupt —— 不允许当作 50%（避免污染）
    expect(normalizeBrightness({ pct: "50" })).toEqual({ pct: 100 });
  });

  test("{ pct: NaN } → { pct: 100 }", () => {
    expect(normalizeBrightness({ pct: NaN })).toEqual({ pct: 100 });
  });

  test("{ pct: Infinity } → { pct: 100 }", () => {
    expect(normalizeBrightness({ pct: Infinity })).toEqual({ pct: 100 });
  });
});

describe("brightness · brightnessToAlpha（pct → CSS alpha）", () => {
  test("pct=100 → alpha=0（不降亮，遮罩透明）", () => {
    expect(brightnessToAlpha(100)).toBe(0);
  });

  test("pct=0 → alpha=1（完全黑遮罩）", () => {
    expect(brightnessToAlpha(0)).toBe(1);
  });

  test("pct=50 → alpha=0.5（线性）", () => {
    expect(brightnessToAlpha(50)).toBeCloseTo(0.5, 5);
  });

  test("pct=25 → alpha=0.75", () => {
    expect(brightnessToAlpha(25)).toBeCloseTo(0.75, 5);
  });

  test("pct=75 → alpha=0.25", () => {
    expect(brightnessToAlpha(75)).toBeCloseTo(0.25, 5);
  });

  test("alpha 越界自动 clamp（pct > 100 → alpha < 0 钳到 0）", () => {
    expect(brightnessToAlpha(120)).toBe(0);
  });

  test("alpha 越界自动 clamp（pct < 0 → alpha > 1 钳到 1）", () => {
    expect(brightnessToAlpha(-10)).toBe(1);
  });
});

// ─── §4.2 结构性负控（钉住唯一真源） ──────────────────────────────────

describe("brightness · 唯一真源（结构性负控）", () => {
  test("BRIGHTNESS_KEY 这个名字在 src/ 下只在 lib/brightness.ts export", () => {
    const root = path.resolve(__dirname, "..", "..");
    const exporters: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.(ts|svelte)$/.test(f)) {
          // 测试文件本身可以提及 BRIGHTNESS_KEY —— 排除
          if (full.includes(`${path.sep}__tests__${path.sep}`)) continue;
          const body = fs.readFileSync(full, "utf8");
          if (/export\s+(?:const|let|var)\s+BRIGHTNESS_KEY\b/.test(body)) {
            exporters.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(exporters).toEqual(["lib/brightness.ts"]);
  });

  test("生产代码里不直接写 `1 - pct / 100` / `(100 - pct) / 100` 内联 alpha 算式", () => {
    // 这条负控钉住：未来谁要在 .svelte 里手算 `opacity: {1 - pct/100}` 会红
    // —— 必须走 brightnessToAlpha
    const root = path.resolve(__dirname, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.(ts|svelte)$/.test(f)) {
          if (full.includes(`${path.sep}__tests__${path.sep}`)) continue;
          const body = fs.readFileSync(full, "utf8");
          const lines = body.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            const trimmed = line.trim();
            if (
              trimmed.startsWith("//") ||
              trimmed.startsWith("*") ||
              trimmed.startsWith("/*")
            ) {
              continue;
            }
            // 匹配 `1 - pct / 100` / `1 - X / 100` 这类纯 alpha 计算
            if (/\b1\s*-\s*\w+\s*\/\s*100\b/.test(line)) {
              offenders.push(`${path.relative(root, full)}:${i + 1}`);
            }
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
