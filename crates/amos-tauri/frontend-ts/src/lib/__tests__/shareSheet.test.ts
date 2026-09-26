/**
 * shareSheet.test.ts — pins the share sheet's two-sided contract (REQ-A703).
 *
 * `Shortcut.quickActions` used to declare `"shareSheet"` while nothing ever read it
 * and no surface ever produced a payload — a pure declaration. These tests pin the
 * consuming half's rules: what may be shared (normalization refuses empty content,
 * so a handler is never handed a no-op string) and who is a target (exactly the
 * shortcuts that opted in). The producer (the editor toggle) and the consumer (the
 * overlay) are wired to these same functions, so the field can no longer drift
 * back into a dead declaration.
 */
import { describe, expect, test as it } from "bun:test";
import {
  fileShare,
  isShareTarget,
  normalizeSharePayload,
  shareSheetTargets,
  textShare,
  withShareSheet,
  type SharePayload,
} from "../shareSheet";
import type { QuickActionType, Shortcut } from "../shortcuts";

const makeShortcut = (id: string, quickActions: QuickActionType[]): Shortcut => ({
  id,
  name: `sc-${id}`,
  icon: "⚡",
  color: "#007AFF",
  description: "",
  actions: [],
  quickActions,
  triggers: [],
  createdAt: 0,
  updatedAt: 0,
  runCount: 0,
  runOnLockScreen: false,
  requiresConfirmation: false,
  tags: [],
});

describe("textShare / fileShare", () => {
  it("textShare 造出 kind=text 的合法载荷（壳里不再内联词表）", () => {
    const p = textShare("正文", "标题");
    expect(p).toEqual<SharePayload>({ kind: "text", value: "正文", title: "标题" });
    expect(normalizeSharePayload(p)).toEqual(p);
  });

  it("fileShare 造出 kind=file 的载荷", () => {
    expect(fileShare("内容", "a.txt")).toEqual<SharePayload>({
      kind: "file",
      value: "内容",
      title: "a.txt",
    });
  });
});

describe("normalizeSharePayload", () => {
  it("接受一段文本，缺省 kind 为 text，去掉标题空白", () => {
    const p = normalizeSharePayload({ value: "hello", title: "  备注  " });
    expect(p).toEqual<SharePayload>({ kind: "text", value: "hello", title: "备注" });
  });

  it("kind 为 file 时保留 file", () => {
    expect(normalizeSharePayload({ kind: "file", value: "x", title: "a.txt" })?.kind).toBe("file");
  });

  it("空内容 / 纯空白被拒 —— 不把空串交给每一个处理者", () => {
    expect(normalizeSharePayload({ value: "" })).toBeNull();
    expect(normalizeSharePayload({ value: "   \n\t " })).toBeNull();
  });

  it("非对象、缺 value、value 非字符串都被拒", () => {
    expect(normalizeSharePayload(null)).toBeNull();
    expect(normalizeSharePayload("hi")).toBeNull();
    expect(normalizeSharePayload({ title: "只有标题" })).toBeNull();
    expect(normalizeSharePayload({ value: 42 })).toBeNull();
  });

  it("没有标题时用内容首行兜底，避免标题是 undefined", () => {
    const p = normalizeSharePayload({ value: "第一行\n第二行" });
    expect(p?.title).toBe("第一行");
    expect(p?.value).toBe("第一行\n第二行");
  });

  it("首行兜底标题被截到 80 字以内", () => {
    const long = "a".repeat(200);
    expect(normalizeSharePayload({ value: long })?.title.length).toBe(80);
  });
});

describe("shareSheetTargets / isShareTarget", () => {
  it("只挑出声明了 shareSheet 的指令，保持库内顺序", () => {
    const list = [
      makeShortcut("a", []),
      makeShortcut("b", ["shareSheet"]),
      makeShortcut("c", ["shareSheet"]),
    ];
    expect(shareSheetTargets(list).map((s) => s.id)).toEqual(["b", "c"]);
    expect(isShareTarget(list[0]!)).toBe(false);
    expect(isShareTarget(list[1]!)).toBe(true);
  });

  it("空库没有目标（不是 null，只是空数组）", () => {
    expect(shareSheetTargets([])).toEqual([]);
  });
});

describe("withShareSheet", () => {
  it("打开时加入且不重复，关闭时移除并保留其它表面", () => {
    expect(withShareSheet([], true)).toEqual(["shareSheet"]);
    // 幂等：已经在里面时再打开不会重复。
    expect(withShareSheet(["shareSheet"], true)).toEqual(["shareSheet"]);
    expect(withShareSheet(["shareSheet"], false)).toEqual([]);
  });

  it("不改动传入的数组（纯函数）", () => {
    const input: QuickActionType[] = [];
    withShareSheet(input, true);
    expect(input).toEqual([]);
  });
});
