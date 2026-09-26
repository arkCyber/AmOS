/**
 * settingsPageBodies.test.ts — **设置页的渲染分支必须渲染一个组件**（REQ-A499）。
 *
 * 为什么需要（本轮发现的缺陷，不是假想）：`SettingsApp.svelte` 的「推送通知管理」
 * （`push_management`）**五件俱全** —— `Sub` 成员、`PAGE_KEY` 标题、搜索别名、索引行、
 * `{:else if page === "push_management"}` 渲染分支 —— 而分支体是
 * `<div class="placeholder-page"><p>Push Notification Settings - Coming Soon</p></div>`：
 * 一句**硬编码英文**占位。于是同一条路径上：
 *   • `settingsReach.test.ts`（REQ-A488）只比对「页面清单 ↔ 索引行」⇒ 绿；
 *   • `svelte-check` / `tsc` 只问类型与语法 ⇒ 绿；
 *   • **`i18n-scan` 的英文拷贝检查确实漏了它** —— 这不是猜的：本轮实测
 *     `MULTIWORD_EN.test("Push Notification Settings - Coming Soon") === false`，
 *     而 `"Coming Soon"` 单独出现是 `true` ⇒ 判据要求"纯字母词 + 单空格分隔"，
 *     ` - ` 这一格让整个节点退出判定（`Battery: charging 80%` 同理）。把判据放宽会
 *     引入多少噪音也量过：全仓生产 `.svelte` 里**多出 6 个候选，其中 5–6 个不是拷贝**
 *     （`t · s` 这类单位串、`https://api.example.com` 这类占位 URL）⇒ 本轮**不**放宽那条
 *     模糊判据（会把真发现埋进没人看的清单），改为在这里补一条**结构**判据：占位页无论怎么
 *     措辞都会红，因为它渲染的不是组件。登记为 F-DEV-080。
 * 也就是说：**"这一页渲染什么"这一格此前没有任何检查在看**，而它正是"承诺了、也点得到、
 * 但什么都不给"的落点（F-SH-001 的同族：看着像入口的 `span`；F-DEV-067 的同族：门有一个固定的盲区）。
 *
 * 判据（窄而可判）：每个 `{:else if page === "…"}` 分支的**第一段实质内容**必须是一个
 * **组件标签**（`<Capitalised`），因为设置页的每一条分支都对应一个真实页面组件；内联的
 * `div` / 裸文本就是"占位"的形状，不可能是一个真页面。
 *
 * 为什么不读 DOM：这是**清单级**属性（"分支体里是什么形状"），而渲染一遍只能证明"某一次
 * 点开时它长这样"；两份清单（分支 ↔ 组件）都写在源码里，比较它们不需要浏览器。
 *
 * 历史副本（负控）：`SETTINGS_SRC=<path>` 读另一份源码 —— 与 `scripts/trace-scan.mjs` 的
 * `TRACE_DOC` 同一手法，用来对**修前**的副本跑同一套断言（它必须红）。
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_SRC = join(process.cwd(), "src/svelte/SettingsApp.svelte");
const SOURCE = process.env.SETTINGS_SRC ?? DEFAULT_SRC;

/** 整行 `//` 与块注释先剥掉：注释里提到的页面名/占位串都不是代码。 */
function stripped(): string {
  return readFileSync(SOURCE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

export interface Branch {
  /** 分支匹配到的页面 id（`page === "a" || page === "b"` 两个都收）。 */
  pages: string[];
  /** 分支体的第一个非空行（去掉缩进）。 */
  firstLine: string;
}

/** 逐个取出 `{:else if page === "…"}` 的分支体首行。 */
export function pageBranches(text: string): Branch[] {
  const marker = /\{:else if\s+page\s*===\s*"([a-z_]+)"((?:\s*\|\|\s*page\s*===\s*"[a-z_]+")*)\s*\}/g;
  const bounds: number[] = [];
  for (const m of text.matchAll(/\{:(?:else|\/if)/g)) bounds.push(m.index ?? 0);

  const out: Branch[] = [];
  for (const m of text.matchAll(marker)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = bounds.find((b) => b > start) ?? text.length;
    const body = text.slice(start, end);
    const pages = [m[1]!, ...[...m[2]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!)];
    const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
    out.push({ pages, firstLine });
  }
  return out;
}

describe("REQ-A499: 设置页的渲染分支必须渲染组件", () => {
  test("提取器真的取到了分支（写坏的正则不许让这篇文件变绿）", () => {
    const branches = pageBranches(stripped());
    expect(branches.length).toBeGreaterThan(20);
    // 分支名必须覆盖全部页面清单，否则"少读了一半分支"也会绿。
    const pages = branches.flatMap((b) => b.pages);
    expect(new Set(pages).size).toBe(pages.length);
    expect(pages).toContain("push_management");
    expect(pages).toContain("keyboard");
  });

  test("每条分支的第一段实质内容都是一个组件标签（不是内联 div / 裸文本）", () => {
    const offenders = pageBranches(stripped())
      .filter((b) => !/^<[A-Z][A-Za-z0-9]*/.test(b.firstLine))
      .map((b) => `${b.pages.join("|")}: ${b.firstLine.slice(0, 60)}`);
    expect(offenders).toEqual([]);
  });

  test("代码里不再有「即将推出」式的占位串（注释除外）", () => {
    const code = stripped();
    for (const placeholder of ["Coming Soon", "即将推出", "PushNotificationSettings"]) {
      expect(code).not.toContain(placeholder);
    }
  });
});
