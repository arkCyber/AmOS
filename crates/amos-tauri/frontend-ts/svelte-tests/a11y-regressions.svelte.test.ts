/**
 * a11y-regressions.svelte.test.ts — 把 REQ-A387 修掉的 a11y 缺口**逐项钉住**。
 *
 * 判据是**静态读源码**，因为这些是设计/布局常量：DOM 测试看不见"类名是否悄悄回到
 * 36px"，也看不见"着色 chip 的底色调回了 15%"。每一项都是这一轮真实修掉的缺口：
 *
 *   • 命中区（HIG / WCAG-AAA 44px）：图标按钮原来 32–40px；
 *   • live region：异步结果/瞬时 Toast 出现时焦点还在按钮上，屏幕阅读器什么都听不到；
 *   • 着色 chip 的对比度：`text-accent on bg-accent/15` = 4.46:1、`text-danger on
 *     bg-danger/15` = 4.09:1，都差一点不到 AA 的 4.5:1（`accent` 需 ≤12%、`danger` ≤8%）。
 *
 * **为什么不直接断言"a11y-scan 缺口 = 0"**：那个扫描器的设计是**只报告**
 * （它的头部写着"缺口要被写进文档让工程团队看见,而非'先修再说'"），把它变成硬门禁
 * 会改变它的性质；真正防回归的是下面这张逐项清单。
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "svelte");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

/** 命中区必须 ≥ 44px（h-11 / w-11 / min-h-[44px]）。 */
const HIT_ZONES: Array<[string, string, string]> = [
  ["PlayerApp.svelte", "grid h-11 w-11 place-items-center rounded-full bg-black/50", "全屏按钮（视频覆盖层）"],
  ["PlayerApp.svelte", "grid h-11 w-11 -my-1 place-items-center rounded-full", "刷新按钮"],
  ["ContactsApp.svelte", "absolute -right-3 -top-3 grid h-11 w-11", "头像预览的关闭"],
  ["ClipboardAnnounce.svelte", "grid h-11 w-11 -my-2 shrink-0", "剪贴板横幅的关闭"],
  ["WebManApp.svelte", "flex h-11 w-11 -my-1 items-center justify-center rounded-lg", "浏览器工具栏按钮"],
  ["AppLibrary.svelte", "grid h-11 w-11 -my-1 shrink-0", "搜索清除"],
  ["AppLibrary.svelte", "grid h-11 w-11 -my-1 cursor-pointer", "自定义分组的上/下移"],
  ["settings/DockPage.svelte", 'class="grid h-11 w-14 place-items-center"', "自动隐藏开关（命中区 44，轨道 32）"],
];

/** 用户动作之后才出现的读数必须能被播报。 */
const LIVE_REGIONS: Array<[string, string, string]> = [
  ["ContactsApp.svelte", 'class="mt-1 text-xs text-accent" role="status"', "联系人状态行"],
  ["WebManApp.svelte", 'role="status"', "浏览器 Toast"],
  ["MeasureApp.svelte", 'role={calibrationMessage.type === "error" ? "alert" : "status"}', "测距校准结果"],
  ["ShortcutsApp.svelte", 'role="status"', "运行结果 Toast"],
  ["modules/APISettings.svelte", 'role="status"', "连接/保存结果"],
  ["modules/AuditLogViewer.svelte", '<span class="loading-indicator" role="status">', "刷新指示"],
];

/** 着色 chip：文字色与底色的比例必须 ≥ 4.5:1（用扫描器的调色板算过门限）。 */
const CONTRAST_CHIPS: Array<[string, string, string]> = [
  ["AiApp.svelte", "bg-danger/8", "danger chip（≤8% 才过 AA）"],
  ["MessagesApp.svelte", "bg-accent/10", "accent chip（≤12% 才过 AA）"],
  ["NotificationCenter.svelte", "bg-accent/10", "推送徽标"],
  ["PhoneApp.svelte", "bg-accent/10", "accent chip"],
  ["PhoneApp.svelte", "bg-danger/8", "danger chip"],
  // REQ-A565: A387 定下的档位规则此前只在上面 5 处被强制。R6 的「字号 token 遮蔽颜色」漏报
  // （`text-xs text-accent` 的"颜色"被解析成 `text-xs`，整对静默跳过）让下面这些同形 chip 的
  // /15 档位从未被扫描器看见 —— 规则在 4 个文件里从未生效。修好漏报后逐一改到过 AA 的档位。
  ["CalendarApp.svelte", "bg-accent/10", "today chip"],
  ["MailApp.svelte", "bg-accent/10", "restore / markUnread chip"],
  ["MailApp.svelte", "bg-danger/8", "delete-permanently chip"],
  ["PlayerApp.svelte", "bg-accent/10", "origin chip"],
  ["PlayerApp.svelte", "bg-danger/8", "too-large chip"],
  ["RemindersApp.svelte", "bg-accent/10", "reminder chip"],
  ["WeatherApp.svelte", "bg-danger/8", "city-remove chip（原为灰底红字 4.27:1）"],
  // REQ-A1004: 上一轮把「反向断言只在 CONTRAST_CHIPS 枚举到的文件里跑」这件事留在了原地 ——
  // App Library 的「编辑成员」行没被枚举，于是它的 `bg-danger/15 text-danger`（4.10:1）与
  // `bg-accent/15 text-accent`（4.46:1）两个档位一直在 AA 线下。写进枚举即被那条反向断言覆盖。
  ["AppLibrary.svelte", "bg-danger/8 text-danger", "分组编辑的移除 chip"],
  ["AppLibrary.svelte", "bg-accent/10 text-accent", "分组编辑的加入 chip"],
];

/**
 * 弱色文字在浅底上必须够深（REQ-A565）。与 chip 不同：这里没有色相，是**前景太浅**——
 * 联系人分区页眉 `text-neutral-400 on bg-neutral-100/90` = 2.33:1；`neutral-600` 在浅底
 * 7.23:1，`dark:text-neutral-400` 在 `dark:bg-black/60` 上 ≈ 8.5:1。
 */
const CONTRAST_TEXT: Array<[string, string, string]> = [
  ["ContactsApp.svelte", "tracking-widest text-neutral-600", "联系人分区页眉（浅底够深）"],
  ["ContactsApp.svelte", "dark:bg-black/60 dark:text-neutral-400", "联系人分区页眉（深底够亮）"],
];

describe("REQ-A387: 修掉的 a11y 缺口不许回退", () => {
  test("图标按钮的命中区 ≥ 44px（HIG / WCAG-AAA）", () => {
    const bad: string[] = [];
    for (const [file, fragment, what] of HIT_ZONES) {
      if (!read(file).includes(fragment)) bad.push(`${file}: ${what}`);
    }
    expect(bad, "hit zone lost (must be h-11/w-11 or min-h-[44px])").toEqual([]);
  });

  test("异步结果/瞬时 Toast 有 live region", () => {
    const bad: string[] = [];
    for (const [file, fragment, what] of LIVE_REGIONS) {
      if (!read(file).includes(fragment)) bad.push(`${file}: ${what}`);
    }
    expect(bad, "live region lost (screen readers would hear nothing)").toEqual([]);
  });

  test("着色 chip 的底色回到能过 AA 的档位", () => {
    const bad: string[] = [];
    for (const [file, fragment, what] of CONTRAST_CHIPS) {
      if (!read(file).includes(fragment)) bad.push(`${file}: ${what}`);
    }
    expect(bad, "contrast tint lost (ratio would drop below 4.5:1)").toEqual([]);
    // 反向断言：把会失败的那一档写回来会被这里抓住。
    for (const [file] of CONTRAST_CHIPS) {
      expect(read(file), `${file} still uses the failing 15% tints`).not.toMatch(
        /bg-(?:accent|danger)\/15/,
      );
    }
  });

  test("弱色文字在浅底上够深（REQ-A565）", () => {
    const bad: string[] = [];
    for (const [file, fragment, what] of CONTRAST_TEXT) {
      if (!read(file).includes(fragment)) bad.push(`${file}: ${what}`);
    }
    expect(bad, "muted foreground too light (ratio would drop below 4.5:1)").toEqual([]);
  });
});
