/**
 * __tests__/theme-tokens.test.ts — 企业面板的语义色令牌（REQ-A1023 / F-SH-340）
 *
 * 这个文件钉两件事，缺一不可：
 *
 *  ① **令牌在**两个**主题块里都有值**。`src/index.css` 的 `:root` 与 `.dark` 是
 *     上下两句独立声明；只写在 `:root` 的令牌在暗色下仍取亮色值 —— 正是本轮要修的
 *     那个失效（`color:#000` 落在 `#1e1e1e` 的壳上，1.28:1）。所以断言不是「存在」，
 *     而是「两块里各有一个值，且**两值不同**」：复制一份没改的暗色值会被这条抓住。
 *
 *  ② **四个面板里不再有主题字面量**。修复前 `AuditLogViewer` / `APISettings` /
 *     `MDMPanel` / `TemplateLibrary` 的 scoped `<style>` 里共 150 处 HIG 字面量
 *     （`#fff` 卡片、`color:#000` 标题、`#8E8E93` 说明文字），没有一处有暗色对。
 *     「不再有」是一条**否定**断言，单靠它会在「文件被清空/正则失效」时假绿，故
 *     每条都配一张 MUST_SEE 名单（该面板必须出现的令牌形态），两侧一起才成立。
 *
 * 不注册 happy-dom：本文件只读源码文本（同 `numericField.test.ts` 的最小约定）。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

/** 本轮引入的令牌 —— 每一个都必须在亮/暗两块里各有值。 */
const TOKENS = [
  "surface",
  "surface-2",
  "separator",
  "label",
  "label-2",
  "label-3",
  "success",
  "warning",
] as const;

/** 拿到某个顶层规则块（`:root` / `.dark`）的**声明体**（大括号配对，不做正则截断）。 */
function blockOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{`, "m").exec(css);
  if (!m) throw new Error(`index.css 里没有 ${selector} 块`);
  const start = m.index + m[0].length;
  let depth = 1;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i);
    }
  }
  throw new Error(`${selector} 块没有闭合`);
}

/** 块体的 `--name: value` 映射（值已 trim）。 */
function decls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name === undefined || value === undefined) continue;
    out.set(name.slice(2), value.trim());
  }
  return out;
}

const PANELS = [
  "svelte/modules/AuditLogViewer.svelte",
  "svelte/modules/APISettings.svelte",
  "svelte/modules/MDMPanel.svelte",
  "svelte/modules/TemplateLibrary.svelte",
] as const;

const CSS = read("index.css");
const ROOT = decls(blockOf(CSS, ":root"));
const DARK = decls(blockOf(CSS, ".dark"));

describe("index.css：令牌的亮/暗成对", () => {
  for (const t of TOKENS) {
    test(`--${t} 在 :root 与 .dark 里各有一个值，且两值不同`, () => {
      const light = ROOT.get(t);
      const dark = DARK.get(t);
      expect(light, `:root 缺 --${t}`).toBeDefined();
      expect(dark, `.dark 缺 --${t}（暗色下会退回亮色值）`).toBeDefined();
      // 复制一份没改的暗色值 = 令牌没生效；这一条把它变成红。
      expect(dark).not.toBe(light);
    });
  }

  test("令牌值是 RGB 通道（三段 0-255），不是 hex —— 否则 rgb(var(--x) / a) 取整失效", () => {
    for (const t of TOKENS) {
      for (const [where, v] of [
        [":root", ROOT.get(t)!],
        [".dark", DARK.get(t)!],
      ] as const) {
        const parts = v.split(/\s+/).map(Number);
        expect(parts.length, `${where} --${t} 不是三段通道：${v}`).toBe(3);
        for (const n of parts) {
          expect(Number.isInteger(n) && n >= 0 && n <= 255, `${where} --${t} 通道越界：${v}`).toBe(true);
        }
      }
    }
  });
});

describe("四个企业面板：不再有主题字面量", () => {
  for (const p of PANELS) {
    test(`${p} 用令牌而不是 HIG 字面量`, () => {
      const src = read(p);
      // ① 否定面：文件里没有任何 hex 颜色字面量（`&#` 之类的实体本仓不存在）。
      const literals = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
      expect(literals, `仍有字面量：${[...new Set(literals)].join(" ")}`).toEqual([]);
      // ② 肯定面（MUST_SEE）：每个面板都有卡片底色与主文字，两者都必须走令牌。
      //    没有这两条，把文件删空也能让 ① 通过。
      expect(src).toContain("rgb(var(--surface))");
      expect(src).toContain("rgb(var(--label))");
    });
  }

  test("四个面板都还在（防止把面板从清单里删掉来让上面变绿）", () => {
    expect(PANELS.length).toBe(4);
    for (const p of PANELS) {
      expect(read(p).length, `${p} 读出来是空的`).toBeGreaterThan(1000);
    }
  });
});
