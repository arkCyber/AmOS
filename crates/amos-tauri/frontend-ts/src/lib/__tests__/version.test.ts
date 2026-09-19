/**
 * version.test.ts — `lib/version.ts`（REQ-A405）。
 *
 * 这个模块此前**没有任何报告提到过它**：没人 import 就没有 lcov 记录，P2-1 门的
 * 分子分母里都不存在它。它只有三个常量，但其中一个写着"`kept in sync manually`"（与
 * frontend 的 package.json 同步）—— "手工保持同步"不是契约，是一条会腐烂的注释；
 * 下面的断言把它变成**会红的检查**（改了 package.json 版本而忘了 About 页，门会说话）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AMOS_DEVICE_LABEL, AMOS_OS_NAME, AMOS_UI_VERSION } from "../version";

describe("构建元数据（设置「关于本机」的数据源）", () => {
  test("三个常量都是非空字符串", () => {
    for (const [name, value] of Object.entries({ AMOS_OS_NAME, AMOS_UI_VERSION, AMOS_DEVICE_LABEL })) {
      expect([name, typeof value]).toEqual([name, "string"]);
      expect([name, value.trim().length > 0]).toEqual([name, true]);
    }
  });

  test("版本号是 semver 形状", () => {
    expect(AMOS_UI_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
  });

  test("AMOS_UI_VERSION 与 package.json 的 version 一致（注释里的 manual 由这条守着）", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(AMOS_UI_VERSION).toBe(pkg.version);
  });

  test("设备标签说明这是 UI 外壳，不谎称具体机型（机型身份在守护进程侧）", () => {
    expect(AMOS_DEVICE_LABEL.toLowerCase()).toContain("ui shell");
    expect(AMOS_OS_NAME).toBe("AmOS");
  });
});
