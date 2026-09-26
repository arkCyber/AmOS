/**
 * settingsReach.test.ts — **every settings page must be reachable from the settings index**（REQ-A488）。
 *
 * 为什么需要（本轮真机读数 + 代码阅读共同发现的缺陷，不是假想）：`SettingsApp.svelte` 里每一个子页面
 * 都有四件东西 —— `Sub` 联合类型、`PAGE_KEY` 标题、`{:else if page === …}` 渲染分支，以及**索引行**
 * （`{ kind: "nav", page: … }`）。而「键盘快捷键」（`settings/KeyboardPage.svelte`，唯一能**改绑或禁用**
 * 桌面快捷键的界面，350+ 行、全 i18n、带冲突检测与导入导出）**四件里有三件**：类型有、标题有、分支有，
 * **索引行没有**，`EXTRA` 别名表里也没有。后果有两层：
 *   1. 侧栏里没有这一行 ⇒ 用鼠标**走不到**这一页；
 *   2. 搜索的命中集是**从索引行**算出来的（`hits` 遍历 `allRows`）⇒ 搜也搜不到；而「键盘」这个别名挂在
 *      **输入法**页上 ⇒ 想找快捷键的用户会被送到另一个页面。
 * 也就是说：整个「改绑/禁用快捷键」的能力在真实 UI 里**没有入口**，而这条路径上的其它东西（合并默认值 +
 * 覆盖 + 禁用、原生菜单栏同步 REQ-A485、键帽 REQ-A484）全部存在、被测、被文档记录。
 *
 * 为什么这条断言读**源码**而不是渲染 DOM：DOM 只能证明「这一页可以被点开」（本轮已由
 * `svelte-tests/settings-pages.svelte.test.ts` 的一条点击链覆盖），而缺陷恰恰是**没有任何东西指向它** ——
 * 一个「某个页面从来没有入口」的属性只能从「页面清单」与「入口清单」的比较里读出来，而这两份清单都写在
 * 源码里。**两份清单都必须非空地被读出**（下面先断言数量），否则一个写坏的正则会把这条门变成永远绿。
 *
 * 与仓内同类门的区别：`scripts/unwired-scan.mjs` 管的是「模块/导出无人引用」，`orphan-test-scan.mjs` 管的是
 * 「测试文件没人跑」；这里管的是**同一个文件内部的清单对不上**（页面 ↔ 索引行），所以它住在单元测试里而不是
 * 一个独立扫描里 —— 不需要新门、新行、新豁免表，跑 `bun run test` 就会执行。
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = join(process.cwd(), "src/svelte/SettingsApp.svelte");

/** Whole-line `//` and block comments are stripped first: a page named in prose must not count as a row. */
function stripped(): string {
  return readFileSync(SOURCE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** `PAGE_KEY: Record<Sub, string>` — the title map, i.e. "this page is a real page". */
function pageKeys(text: string): string[] {
  const block = /const PAGE_KEY: Record<Sub, string> = \{([\s\S]*?)\n {2}\};/.exec(text);
  return [...(block?.[1] ?? "").matchAll(/^[ \t]*([a-z_]+):[ \t]*"settings\./gm)]
    .map((m) => m[1])
    .filter((k): k is string => typeof k === "string");
}

/** The index rows the sidebar and the search both walk. */
function navRows(text: string): string[] {
  return [...text.matchAll(/kind:[ \t]*"nav",[ \t]*page:[ \t]*"([a-z_]+)"/g)]
    .map((m) => m[1])
    .filter((k): k is string => typeof k === "string");
}

/** The search alias table. */
function aliasKeys(text: string): string[] {
  const block = /const EXTRA: Partial<Record<Sub, string\[\]>> = \{([\s\S]*?)\n {2}\};/.exec(text);
  return [...(block?.[1] ?? "").matchAll(/^[ \t]*([a-z_]+):[ \t]*\[/gm)]
    .map((m) => m[1])
    .filter((k): k is string => typeof k === "string");
}

describe("settings index reachability (REQ-A488)", () => {
  test("the extractors find both lists (a silent regex must not pass this file)", () => {
    const text = stripped();
    // Sanity: the source is parsed, not vacuously satisfied.
    expect(pageKeys(text).length).toBeGreaterThan(20);
    expect(navRows(text).length).toBeGreaterThan(20);
    expect(aliasKeys(text).length).toBeGreaterThan(20);
  });

  test("every page with a title has an index row", () => {
    const text = stripped();
    const rows = new Set(navRows(text));
    const missing = pageKeys(text).filter((p) => !rows.has(p));
    expect(missing).toEqual([]);
  });

  test("every index row points at a page that exists", () => {
    const text = stripped();
    const pages = new Set(pageKeys(text));
    const dangling = navRows(text).filter((p) => !pages.has(p));
    expect(dangling).toEqual([]);
  });

  test("every search alias belongs to a page that exists", () => {
    const text = stripped();
    const pages = new Set(pageKeys(text));
    expect(aliasKeys(text).filter((p) => !pages.has(p))).toEqual([]);
  });

  test("「键盘快捷键」 is reachable, and its aliases cover the words a user would type", () => {
    const text = stripped();
    expect(navRows(text)).toContain("keyboard");
    const block = /keyboard: \[([^\]]*)\]/.exec(text)?.[1] ?? "";
    // 想改快捷键的人会打的词：快捷键/键位/绑定 + 英文 shortcut/hotkey/keybinding。
    for (const word of ["快捷键", "键位", "绑定", "shortcut", "hotkey", "keybinding"]) {
      expect(block).toContain(word);
    }
  });
});
