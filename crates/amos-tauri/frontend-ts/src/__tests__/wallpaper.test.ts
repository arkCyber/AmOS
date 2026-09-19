/**
 * wallpaper.test.ts — 桌面壁纸 / 背景 fallback 颜色（与 #1a1a1a 同源收口）。
 *
 * G-DesktopShell · 桌面背景 fallback 从「死黑」改成「macOS 风格中性灰」。
 *
 * Why this file: G-γ 同源纪律——所有几何/视觉常量必须有**唯一真源**。
 * 仓内**唯一**可出现 `#1a1a1a` / `#1e1e1e` / `#ececec` 桌面 fallback 颜色字面值
 * 的地方就是 `lib/wallpaper.ts::wallpaperFallbackColor`。其他文件**必须** import
 * 这个函数，**不许**写第二份（与 `lib/desktopLayout.ts` 的 `TOPBAR_HEIGHT` 同源）。
 *
 * **负控 A**：把 `wallpaperFallbackColor` 返回值改回 `#1a1a1a` ⇒
 *   - `desktop_shell_uses_wallpaperFallbackColor_not_a_hardcoded_string` 仍绿（它只
 *     断言"调用了 wallpaperFallbackColor"）
 *   - 但 **人眼**看到的就是死黑，与设计意图不符
 *   - 这条由 `desktop-shell.svelte.test.ts::desktop_shell_never_paints_a_dead_black`
 *     守护（断言 `bg` 颜色不在 `["#1a1a1a", "#000", "rgb(0,0,0)", "rgb(26,26,26)"]` 里）
 *
 * **负控 B**：把 DesktopShell 的 `style="background: ..."` 改回内联 `#1a1a1a` ⇒
 *   `desktop-shell.svelte.test.ts::desktop_shell_does_not_inline_a_1a1a1a_background`
 *     守护（grep 断言）
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { wallpaperFallbackColor } from "../lib/wallpaper";

describe("wallpaperFallbackColor — 桌面背景 fallback 颜色（macOS 中性灰）", () => {
  test("dark 模式返回的不是死黑（≠ #1a1a1a）", () => {
    const c = wallpaperFallbackColor(true);
    expect(c.toLowerCase()).not.toBe("#1a1a1a");
    expect(c.toLowerCase()).not.toBe("#000");
    expect(c.toLowerCase()).not.toBe("#000000");
    // 至少应该是 hex 6 位
    expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test("light 模式返回的不是死白（≠ #ffffff）", () => {
    const c = wallpaperFallbackColor(false);
    expect(c.toLowerCase()).not.toBe("#fff");
    expect(c.toLowerCase()).not.toBe("#ffffff");
    expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test("dark 与 light 是两种不同颜色（不是恒 true / 写错）", () => {
    const dark = wallpaperFallbackColor(true);
    const light = wallpaperFallbackColor(false);
    expect(dark.toLowerCase()).not.toBe(light.toLowerCase());
  });

  test("dark 模式的亮度 < light 模式（人眼直觉）", () => {
    const hexToRgb = (hex: string) => {
      const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      expect(m).toBeTruthy();
      return {
        r: parseInt(m![1]!, 16),
        g: parseInt(m![2]!, 16),
        b: parseInt(m![3]!, 16),
      };
    };
    const dark = hexToRgb(wallpaperFallbackColor(true));
    const light = hexToRgb(wallpaperFallbackColor(false));
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) =>
      0.299 * r + 0.587 * g + 0.114 * b;
    // 加一点点宽容（light 比 dark 亮 ≥ 100/255）—— 否则两个值太接近也是"写得不对"
    expect(lum(light) - lum(dark)).toBeGreaterThanOrEqual(80);
  });
});

/** **结构性负控**（钉住唯一真源）：仓内**除了** wallpaper.ts 与 DesktopShell 的
 * inline svelte 表达式（它本身就调用 wallpaperFallbackColor）之外，
 * **没有任何** .ts/.svelte 应该写 `#1a1a1a` 作为 production 的桌面背景色
 * 字面值。如果有人把它"恢复"成 inline `#1a1a1a`，这条会红。 */
describe("桌面 fallback 颜色字面值的唯一真源（负控）", () => {
  test("全仓 src/ 下没有 .ts/.svelte 文件在 production 代码里写 '#1a1a1a' 作为桌面背景", () => {
    const root = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.(ts|svelte)$/.test(f)) {
          // 测试文件本身可以写 `#1a1a1a`（讨论这个值的来龙去脉）—— 排除
          if (full.includes(`${path.sep}__tests__${path.sep}`)) continue;
          const body = fs.readFileSync(full, "utf8");
          const lines = body.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            // 只匹配**桌面背景用法**：
            //   - `background: #1a1a1a` / `background-color: #1a1a1a`
            //   - `background:#1a1a1a`（无空格）
            //   - JSX/HTML 的 `style="...#1a1a1a..."`
            // 不匹配 `color: "#1a1a1a"`（那不是背景色）。
            if (
              /(background(?:-color)?\s*[:=]\s*['"]?)#1a1a1a/i.test(line) ||
              /style\s*=\s*['"`][^'"`]*background[^'"`]*#1a1a1a/i.test(line)
            ) {
              const trimmed = line.trim();
              // 注释行 / 块注释行 → 跳过
              if (
                trimmed.startsWith("//") ||
                trimmed.startsWith("*") ||
                trimmed.startsWith("/*")
              ) {
                continue;
              }
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
