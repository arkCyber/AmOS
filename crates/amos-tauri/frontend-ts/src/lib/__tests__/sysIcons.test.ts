/**
 * sysIcons.test.ts — `lib/sysIcons.ts` 的行为测试（REQ-A405）。
 *
 * 为什么这个文件此前根本不存在：这个模块**没有任何报告提到过它** —— P2-1 覆盖率门是从
 * lcov 的 `SF:` 记录出发的，从没被任何测试 import 的模块在分母里**不存在**。于是它既
 * 不贡献分母、也不可能让门变红：门说"150 个文件"而 `src/lib` 里有 154 个。`sysIcons` 是
 * 三个隐形模块里唯一有真逻辑的（radio/quick 图标映射、电池字形），状态栏 / 控制中心都靠
 * 它出图 —— 这正是"未测量"最容易藏住真缺陷的地方。
 *
 * 现在门会把这件事判死（`scripts/lib-coverage-gate.mjs` 的 REQ-A405 规则），而这个文件让
 * 它变成**可测量**：不注册 happy-dom，所以纯批次（= 计入覆盖率的那批）会跑它。
 */
import { describe, expect, test } from "bun:test";
import { batterySvg, iconSvg, quickIcon, radioIcon, type SysIconName } from "../sysIcons";

/** 联合类型的全部成员（手抄一份：漏一个就会被下面的"每个名字都有真实形状"抓到）。 */
const ALL_NAMES: SysIconName[] = [
  "wifi",
  "bluetooth",
  "airplane",
  "airplay",
  "moon",
  "mutedBell",
  "flashlight",
  "location",
  "appearance",
  "search",
  "pencil",
  "lock",
  "recents",
  "x",
  "play",
  "pause",
  "skipBack",
  "skipForward",
  "repeat",
  "messageCircle",
  "musicNote",
  "headphones",
  "trash",
  "send",
  "reply",
  "phone",
  "mic",
  "micOff",
  "record",
  "stop",
  "delete",
  "check",
  "rotateCcw",
  "download",
  "dialpad",
  "archive",
  "shuffle",
  "volume",
  "volumeX",
  "maximize",
  "film",
  "scissors",
  "alertCircle",
  "plus",
];

describe("radioIcon / quickIcon 的映射（状态栏与快速设置的契约）", () => {
  test("radioIcon：三个射频各有自己的字形，未知一律回 wifi（绝不能渲染成空）", () => {
    expect(radioIcon("airplane")).toBe("airplane");
    expect(radioIcon("wifi")).toBe("wifi");
    expect(radioIcon("bluetooth")).toBe("bluetooth");
    expect(radioIcon("bogus")).toBe("wifi");
    expect(radioIcon("")).toBe("wifi");
  });

  test("quickIcon：每个快速开关都有自己的字形", () => {
    expect(quickIcon("airplane")).toBe("airplane");
    expect(quickIcon("wifi")).toBe("wifi");
    expect(quickIcon("bluetooth")).toBe("bluetooth");
    expect(quickIcon("airplay")).toBe("airplay");
    expect(quickIcon("location")).toBe("location");
    expect(quickIcon("unknown-key")).toBe("wifi");
  });

  test("深色模式与勿扰必须是两个不同的字形（半日轮 ≠ 月亮）", () => {
    expect(quickIcon("darkmode")).toBe("appearance");
    expect(quickIcon("dnd")).toBe("moon");
    expect(quickIcon("darkmode")).not.toBe(quickIcon("dnd"));
  });
});

describe("iconSvg 渲染", () => {
  test("每个图标名都给出一段真实的 SVG（不是空也不是 undefined）", () => {
    for (const name of ALL_NAMES) {
      const svg = iconSvg(name);
      expect([name, svg.startsWith("<svg")]).toEqual([name, true]);
      expect([name, svg.endsWith("</svg>")]).toEqual([name, true]);
      expect([name, svg.includes("undefined")]).toEqual([name, false]);
      expect([name, /<(path|circle|rect|ellipse|g)\b/.test(svg)]).toEqual([name, true]);
    }
  });

  test("未知名字退化成**空**图标，而不是把字符串 undefined 写进 DOM", () => {
    // `INNER[name]` 对表外名字是 undefined，`${undefined}` 会成为可见文本 "undefined"
    // （状态栏里出现一个写着 undefined 的图标）。表是手写的，运行时名字可能来自数据，
    // 所以这里守的是"表外名字不得产生可见垃圾"。
    const svg = iconSvg("bogus" as SysIconName);
    expect(svg).not.toContain("undefined");
    expect(svg).toBe(
      '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" aria-hidden="true" fill="none" stroke="currentColor" ' +
        'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></svg>',
    );
  });

  test("样式契约：继承 currentColor、aria-hidden、class 可覆盖", () => {
    const svg = iconSvg("wifi");
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('class="h-3.5 w-3.5"');
    expect(iconSvg("wifi", "h-4 w-4 text-red-500")).toContain('class="h-4 w-4 text-red-500"');
  });
});

describe("batterySvg 的电量字形", () => {
  test("tone 决定填充色（iOS 语义：充电绿 / 危急红 / 低电量琥珀 / 正常 currentColor）", () => {
    expect(batterySvg(50, "h-3 w-3", "charging")).toContain('fill="#34c759"');
    expect(batterySvg(5, "h-3 w-3", "critical")).toContain('fill="#ff3b30"');
    expect(batterySvg(15, "h-3 w-3", "low")).toContain('fill="#ffcc00"');
    expect(batterySvg(50)).toContain('fill="currentColor"');
  });

  test("unknown：只有空的外壳，绝不画一格假电量", () => {
    const svg = batterySvg(50, "h-3 w-3", "unknown");
    expect(svg).not.toContain("<rect x=\"2.6\"");
    expect(svg).toContain('<rect x="1.2" y="7.6"'); // 外壳还在
  });

  test("百分比被钳制到 0–100，且窄到看不出来时给最小可宽度", () => {
    expect(batterySvg(150)).toContain('width="14.40"');
    expect(batterySvg(100)).toContain('width="14.40"');
    expect(batterySvg(-5)).not.toContain("<rect x=\"2.6\"");
    expect(batterySvg(1)).toContain('width="1.40"');
    expect(batterySvg(50)).toContain('width="7.20"');
  });

  test("class 可覆盖（旧 React 条不带 class 时用默认值）", () => {
    expect(batterySvg(50)).toContain('class="h-3 w-3"');
    expect(batterySvg(50, "h-5 w-8")).toContain('class="h-5 w-8"');
  });
});
