/**
 * Spaces 快捷键导航逻辑测试
 *
 * 测试桌面壳 Ctrl+← / Ctrl+→ 两条导航快捷键的**纯决策**部分：
 *   * `Ctrl+←`: prevSpaceIndex(current, count) — 循环到上一个
 *   * `Ctrl+→`: nextSpaceIndex(current, count) — 循环到下一个
 *
 * 这两条函数从 handler 里抽出来(REQ-A340)是为了让测试真的钉住
 * production 的行为,而不是 re-implement 同样的表达式("测试在测自己")。
 * 同一个 `SpacesPanel` 也复用它们 (REQ-A554) —— 一份循环规则,两个消费者。
 *
 * 注意:快捷方式表里**没有**新建桌面这一条 —— `Ctrl+↑` 是 `spacesPanel`
 * (打开/关闭本面板),新建走面板上的按钮。从前这里断言过一对
 * `newSpaceName` / `indexOfCreatedSpace` 辅助函数,而它们描述的那条
 * "Ctrl+↑ 新建并跳转"的流程在宿主侧根本不存在,已删除 (REQ-A554)。
 *
 * 桥的部分(`switchSpace` / `createSpace` / `listSpaces`)在
 * svelte-tests/spaces.svelte.test.ts 里通过 fake bridge 验。
 */

import { describe, it, expect } from "bun:test";
import { nextSpaceIndex, prevSpaceIndex } from "../lib/spaces";

describe("Spaces navigation logic", () => {
  describe("Previous space (Ctrl+←) — prevSpaceIndex", () => {
    it("wraps to last space when going left from first", () => {
      expect(prevSpaceIndex(0, 3)).toBe(2);
    });

    it("decrements index when going left from middle", () => {
      expect(prevSpaceIndex(1, 3)).toBe(0);
    });

    it("decrements from last to second-to-last", () => {
      expect(prevSpaceIndex(2, 3)).toBe(1);
    });
  });

  describe("Next space (Ctrl+→) — nextSpaceIndex", () => {
    it("wraps to first space when going right from last", () => {
      expect(nextSpaceIndex(2, 3)).toBe(0);
    });

    it("increments index when going right from middle", () => {
      expect(nextSpaceIndex(1, 3)).toBe(2);
    });

    it("increments from first to second", () => {
      expect(nextSpaceIndex(0, 3)).toBe(1);
    });
  });

  describe("Single / empty space edge case", () => {
    it("stays on index 0 when there is exactly one space (left)", () => {
      expect(prevSpaceIndex(0, 1)).toBe(0);
    });

    it("stays on index 0 when there is exactly one space (right)", () => {
      expect(nextSpaceIndex(0, 1)).toBe(0);
    });

    it("returns 0 when there are no spaces at all (left)", () => {
      // The handler short-circuits before this is ever called when
      // listSpaces() returns [], but the helper itself must still be total
      // — a future caller may not have that short-circuit.
      expect(prevSpaceIndex(0, 0)).toBe(0);
    });

    it("returns 0 when there are no spaces at all (right)", () => {
      expect(nextSpaceIndex(0, 0)).toBe(0);
    });
  });

  describe("Boundary conditions", () => {
    it("handles a large rail on the right edge", () => {
      expect(nextSpaceIndex(19, 20)).toBe(0);
    });

    it("handles a large rail on the left edge", () => {
      expect(prevSpaceIndex(0, 20)).toBe(19);
    });

    it("returns null for negative inputs (defence in depth)", () => {
      expect(prevSpaceIndex(-1, 3)).toBeNull();
      expect(nextSpaceIndex(0, -1)).toBeNull();
    });
  });
});
