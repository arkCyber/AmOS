/**
 * Spaces 快捷键导航逻辑测试
 *
 * 测试 DesktopShell 中 Ctrl+←/→/↑ 三个全局快捷键的**纯决策**部分：
 *   * `Ctrl+←`: prevSpaceIndex(current, count) — 循环到上一个
 *   * `Ctrl+→`: nextSpaceIndex(current, count) — 循环到下一个
 *   * `Ctrl+↑`: newSpaceName(count) + indexOfCreatedSpace(list, id) — 新建并跳转
 *
 * 这些函数是从 DesktopShell.svelte 抽出来的(REQ-A340),之前 inline 在
 * handler 里,测试只能 re-implement 同样的表达式,根本测不到 production
 * 代码 —— 修这一处就是把"测试在测自己"这种 defect 关闭掉,让测试
 * 真的钉住 production 的行为。
 *
 * 桥的部分(`switchSpace` / `createSpace` / `listSpaces`)在
 * svelte-tests/spaces-shell-shortcuts.svelte.test.ts 里通过 fake bridge
 * 验。
 */

import { describe, it, expect } from "bun:test";
import {
  indexOfCreatedSpace,
  newSpaceName,
  nextSpaceIndex,
  prevSpaceIndex,
} from "../lib/spaces";

const sample = (n: number): readonly { id: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `space-${i}` }));

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

  describe("New space creation (Ctrl+↑) — newSpaceName", () => {
    it("appends one to the current count", () => {
      expect(newSpaceName(2)).toBe("Space 3");
    });

    it("starts from one when the listing is empty", () => {
      expect(newSpaceName(0)).toBe("Space 1");
    });
  });

  describe("Locate the just-created space — indexOfCreatedSpace", () => {
    it("returns the index of the matching id in the refreshed list", () => {
      const list = sample(3).map((s, i) => ({ ...s, id: i === 2 ? "space-3" : `space-${i}` }));
      expect(indexOfCreatedSpace(list, "space-3")).toBe(2);
    });

    it("returns -1 when the host snapshot does not contain the new id", () => {
      const list = sample(2);
      expect(indexOfCreatedSpace(list, "space-999")).toBe(-1);
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
