/**
 * __tests__/numericField.test.ts — 数字框「收下了吗、为什么不收」（REQ-A821）
 *
 * 这个文件钉三件事：
 *
 *  ① **`0` 是一个合法的值**。原实现是 `parseInt(v) || <默认值>`，`0` 落在 `||` 的假值侧，
 *     于是「重试次数」写 `0`（= 不重试，最该被接受的一个值）会变成 `3`，而框里显示的还是
 *     `0`。这是本文件的核心回归。
 *  ② **越界的值不进门**。`min`／`max` 早已写在标记里，但没有任何一处强制它 —— 打一个
 *     `99999` 会原样进模型并落盘。
 *  ③ **标记与判据读同一张表**。两面板的 `min`／`max` 现在由 `API_NUMERIC_RANGES`／
 *     `MDM_NUMERIC_RANGES` 渲染（读源码文本断言），且源码里**不再有** `parseInt(...) ||`
 *     这个形状 —— 退回一个字面量上限或退回 `|| 默认值` 都在这里红。
 *
 * 不注册 happy-dom：本文件只读纯函数与源码文本（同 `enterprise-mdm-connection.test.ts`
 * 的最小约定）。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_NUMERIC_RANGES,
  MDM_NUMERIC_RANGES,
  readBoundedInt,
  type NumericRange,
} from "../enterprise/numericField";

const RANGE: NumericRange = { min: 0, max: 5 }; // 「重试次数」的范围

describe("readBoundedInt：收下的与不收的", () => {
  test("范围内的整数照收，且返回数值而不是原串", () => {
    expect(readBoundedInt("3", RANGE)).toEqual({ ok: true, value: 3 });
  });

  test("**`0` 在范围内就照收** —— 原实现把它换成默认值 3", () => {
    // 这条是本轮存在的理由：`0 || 3` 是 `3`。
    expect(readBoundedInt("0", RANGE)).toEqual({ ok: true, value: 0 });
  });

  test("两端都算收（含 min 与含 max）", () => {
    expect(readBoundedInt("0", RANGE)).toEqual({ ok: true, value: 0 });
    expect(readBoundedInt("5", RANGE)).toEqual({ ok: true, value: 5 });
  });

  test("前后空白与前置 + 号照收（用户复制粘贴时常见）", () => {
    expect(readBoundedInt("  4  ", RANGE)).toEqual({ ok: true, value: 4 });
    expect(readBoundedInt("+4", RANGE)).toEqual({ ok: true, value: 4 });
  });

  test("低于 min ⇒ below-min，并带上那个 min", () => {
    expect(readBoundedInt("-1", RANGE)).toEqual({
      ok: false,
      reason: "below-min",
      range: RANGE,
    });
  });

  test("高于 max ⇒ above-max，并带上那个 max", () => {
    expect(readBoundedInt("6", RANGE)).toEqual({
      ok: false,
      reason: "above-max",
      range: RANGE,
    });
  });

  test("非整数一律不收：小数、科学计数、十六进制、带单位、空串、只有一个负号", () => {
    for (const raw of ["3.5", "1e5", "0x10", "12abc", "12ms", "", "   ", "-", "+", "三千"]) {
      const verdict = readBoundedInt(raw, RANGE);
      expect(verdict.ok, `"${raw}" 不该被收下`).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("not-integer");
    }
  });

  test("被拒绝时**没有**任何替代值可给（判别式只有 ok/value 两叶）", () => {
    const verdict = readBoundedInt("1e5", RANGE);
    // 这正是原实现漏掉的那一步：它必须能说出「不收」，而不是自己找一个数顶上。
    expect(Object.keys(verdict).includes("value")).toBe(false);
  });
});

describe("范围表与两个面板的标记同源（读源码文本）", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", "..", p), "utf8");

  /**
   * 只剩代码行：块注释整段丢掉、`*` 开头的 JSDoc 行与 `//` 整行丢掉。
   *
   * 这一步不是洁癖 —— 这两个文件的注释里**逐字引用着**被替换掉的那个形状
   * （`parseInt(v) || 1000`），不去注释的检查会被自己的说明文字满足，读到的正是那段
   * 注释而不是代码（本仓已两次踩到这个坑：F-TAU-020 / REQ-A805）。
   */
  function codeOnly(src: string): string {
    let inBlock = false;
    return src
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        if (inBlock) {
          if (t.includes("*/")) inBlock = false;
          return false;
        }
        if (t.startsWith("/*")) {
          if (!t.includes("*/")) inBlock = true;
          return false;
        }
        return !(t.startsWith("//") || t.startsWith("*"));
      })
      .join("\n");
  }

  /**
   * 死形状：`parseInt(…) || N` —— 用户打的字被换成一个他没写的数。
   *
   * `[^)]*` 在这里**不够**：真的接线里写的是
   * `parseInt((e.target as HTMLInputElement).value) || 1000`，两层括号 —— 用 `[^)]*`
   * 会在内层那个 `)` 上停住，于是**恰好把要抓的那一行放过**。本条的判别力由负控 E 逼出来
   * （把一行接线改回旧形状，`[^)]*` 版本 12 条全绿），故这里用非贪婪的 `.*?`。
   */
  const OLD_COERCION = /parseInt\(.*?\)\s*\|\|/;

  test("APISettings 的三个字段：标记由表渲染、接线走判据、代码里不再有 parseInt(…) ||", () => {
    const src = read("svelte/modules/APISettings.svelte");
    const code = codeOnly(src);
    for (const key of ["timeout", "retryCount", "retryDelay"] as const) {
      expect(src).toContain(`min={API_NUMERIC_RANGES.${key}.min}`);
      expect(src).toContain(`max={API_NUMERIC_RANGES.${key}.max}`);
      // 接线本身也要钉住：只查「旧形状不在」还不够 —— 一行 `oninput={() => {}}` 也满足它。
      expect(code).toContain(`updateBoundedNumber("${key}", e)`);
    }
    expect(code).not.toMatch(OLD_COERCION);
  });

  test("MDMPanel 的三个字段：标记由表渲染、接线走判据、代码里不再有 parseInt(…) ||", () => {
    const src = read("svelte/modules/MDMPanel.svelte");
    const code = codeOnly(src);
    for (const key of [
      "maxShortcutsPerUser",
      "maxActionsPerShortcut",
      "maxExecutionsPerDay",
    ] as const) {
      expect(src).toContain(`min={MDM_NUMERIC_RANGES.${key}.min}`);
      expect(src).toContain(`max={MDM_NUMERIC_RANGES.${key}.max}`);
      expect(code).toContain(`onNumericRestriction("${key}", e)`);
    }
    expect(code).not.toMatch(OLD_COERCION);
  });

  test("旧形状的判据不漏嵌套括号（负控 E 的形状，逐字取自真实接线）", () => {
    // 这一行就是负控 E 里改回去的那一行 —— `[^)]*` 版本在它面前报绿，`.*?` 版本报红。
    const reverted =
      'oninput={(e) => updateRestriction("maxExecutionsPerDay", parseInt((e.target as HTMLInputElement).value) || 1000)}';
    expect(reverted).toMatch(OLD_COERCION);
    expect(reverted).not.toMatch(/parseInt\([^)]*\)\s*\|\|/);
  });

  test("去注释的判据有判别力：同一段文本带注释时会被读到（负控）", () => {
    // 这两条钉住 `codeOnly` 本身：它真的丢掉了注释，而不是把整段文本原样返回。
    const prose = "/**\n * 原来是 `parseInt(v) || 1000`\n */\nconst x = readBoundedInt(v, R);";
    expect(prose).toMatch(/parseInt\([^)]*\)\s*\|\|/);
    expect(codeOnly(prose)).not.toMatch(/parseInt\([^)]*\)\s*\|\|/);
    // 而**代码**里的同一个形状必须留下 —— 否则这个函数会把所有东西都抹掉。
    const code = "const y = parseInt(v) || 1000;";
    expect(codeOnly(code)).toMatch(/parseInt\([^)]*\)\s*\|\|/);
  });

  test("范围表本身是「最小值 ≤ 最大值」的合法区间", () => {
    for (const [name, r] of Object.entries({ ...API_NUMERIC_RANGES, ...MDM_NUMERIC_RANGES })) {
      expect(r.min, name).toBeLessThanOrEqual(r.max);
    }
  });
});
