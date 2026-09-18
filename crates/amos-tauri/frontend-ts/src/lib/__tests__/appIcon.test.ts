/**
 * appIcon.test.ts — 启动台图标模型的纯函数契约（src/lib/appIcon.ts，REQ-A396）。
 *
 * 该模块是「色调渐变 + 定制面孔 + SVG 字形」的唯一事实源，纯数据无框架依赖：
 * - toneOf：按 id 哈希确定性选色，输出合法的 CSS linear-gradient；
 * - bespokeFace / isBespokeTile：九个第一方 id 的面孔映射必须与渲染器约定一致；
 * - bespokeGlyphSvg：每个定制 id 都能产出非空 <svg> 标记（Svelte 端以 {@html} 嵌入）。
 */
import { describe, test as it, expect } from "bun:test";
import {
  ICON_TONES,
  BESPOKE_IDS,
  toneOf,
  isBespokeTile,
  bespokeFace,
  bespokeGlyphSvg,
} from "../appIcon";

describe("appIcon 色调渐变", () => {
  it("ICON_TONES 是十组二元渐变色", () => {
    expect(ICON_TONES.length).toBe(10);
    for (const [a, b] of ICON_TONES) {
      expect(a).toMatch(/^#/);
      expect(b).toMatch(/^#/);
    }
  });

  it("toneOf 确定性：同一 id 恒返回同一渐变", () => {
    for (const id of ["phone", "messages", "browser", "settings", "x" .repeat(30)]) {
      expect(toneOf(id)).toBe(toneOf(id));
      expect(toneOf(id)).toContain("linear-gradient(135deg");
    }
  });

  it("toneOf 命中调色板（梯度家族与 ICON_TONES 一一对应）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const g = toneOf(`app-${i}`);
      seen.add(g);
      const [, b] = g.match(/,\s*(#\w+)\)$/) ?? [];
      expect(ICON_TONES.some(([, bb]) => bb === b)).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(5); // 哈希确实分散到多个色族
  });
});

describe("appIcon 定制面孔", () => {
  it("BESPOKE_IDS 九个 id 均判定为定制瓦片", () => {
    expect(BESPOKE_IDS.length).toBe(9);
    for (const id of BESPOKE_IDS) expect(isBespokeTile(id)).toBe(true);
    expect(isBespokeTile("phone")).toBe(false);
    expect(isBespokeTile("")).toBe(false);
  });

  it("面孔映射：纸面/夜面/照片/通讯录/AI/地图，普通 id 为 null", () => {
    expect(bespokeFace("reminders")).toBe(bespokeFace("vmemos"));
    expect(bespokeFace("reminders")).toContain("#ffffff");
    expect(bespokeFace("clock")).toBe(bespokeFace("calculator"));
    expect(bespokeFace("clock")).toContain("#15151b");
    expect(bespokeFace("photos")).toContain("#fdfdfe");
    expect(bespokeFace("contacts")).toContain("#2e7bf6");
    expect(bespokeFace("ai")).toContain("#8a6bff");
    expect(bespokeFace("maps")).toContain("#cbdcEA");
    expect(bespokeFace("notes")).not.toBeNull();
    expect(bespokeFace("phone")).toBeNull();
    expect(bespokeFace("unknown-app")).toBeNull();
  });
});

describe("appIcon 定制 SVG 字形", () => {
  it("九个定制 id 各产出一份 <svg> 标记字符串", () => {
    for (const id of BESPOKE_IDS) {
      const svg = bespokeGlyphSvg(id);
      expect(svg).not.toBeNull();
      expect(svg!).toContain("<svg");
      expect(svg!).toContain("</svg>");
      expect(svg!.length).toBeGreaterThan(80);
    }
  });

  it("不同 id 的字形互不相同，非定制 id 返回 null", () => {
    const set = new Set(BESPOKE_IDS.map((id) => bespokeGlyphSvg(id)));
    expect(set.size).toBe(9);
    expect(bespokeGlyphSvg("phone")).toBeNull();
    expect(bespokeGlyphSvg("")).toBeNull();
  });

  it("字形细节：时钟带表盘圆、计算器带运算键、地图带红色大头针", () => {
    expect(bespokeGlyphSvg("clock")!).toContain("<circle");
    expect(bespokeGlyphSvg("calculator")!).toContain("<rect");
    expect(bespokeGlyphSvg("maps")!).toContain("#ff3b30");
    expect(bespokeGlyphSvg("photos")!).toContain("<ellipse");
    expect(bespokeGlyphSvg("ai")!).toContain("<polygon");
  });
});
