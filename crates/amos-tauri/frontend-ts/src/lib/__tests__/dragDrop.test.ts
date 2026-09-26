/**
 * dragDrop.test.ts — REQ-A683 · 跨 app 拖放的载荷词表 + 能力内核 + 结构性负控。
 *
 * Why this file exists:
 *   * `lib/dragDrop.ts` 是拖放的**唯一**决策源：可拖什么（`DragPayload`）、谁能收
 *     （`DROP_CAPABILITIES`）、松手会发生什么（`resolveDrop`）。
 *   * 真正的危险不是「拖不动」，而是**静默地说谎**：能力表里一行「X 应用能收 P」若
 *     在 `svelte/dropActions.ts` 里**没有**对应的执行分支，松手会打开 X 到它的根页、
 *     什么都没交过去 —— 用户读成「成功了」。所以两处**双向**绑定：每个 `app` 必须是
 *     真实 `APP_META` id，每个 `verb` 必须在适配器里出现。
 *   * `resolveDrop` 的 `same-app` 是**拒绝**（不是静默复制一份）：松回原应用几乎总是
 *     被取消的拖拽，静默造出第二个笔记/草稿是本仓最忌讳的意外。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DRAG_KINDS,
  DROP_CAPABILITIES,
  MAX_DRAG_TEXT,
  dropVerb,
  makePhonePayload,
  makeTextPayload,
  payloadDetail,
  payloadLabelKey,
  rejectionKey,
  resolveDrop,
} from "../dragDrop";
import type { DragKind, DragPayload } from "../dragDrop";
import { APP_META } from "../appMeta";

const here = import.meta.dir;
const readSrc = (rel: string) => readFileSync(`${here}/${rel}`, "utf8");

describe("dragDrop · 载荷词表", () => {
  test("恰好两种可拖载荷 —— 每种都在能力表里有真实消费者", () => {
    expect([...DRAG_KINDS]).toEqual(["text", "phone"]);
    const served = new Set(DROP_CAPABILITIES.map((c) => c.kind));
    for (const k of DRAG_KINDS) {
      expect(served.has(k)).toBe(true);
    }
  });

  test("makeTextPayload：空白 ⇒ null；超长截断到 MAX_DRAG_TEXT；title 可选", () => {
    expect(makeTextPayload("   ")).toBeNull();
    expect(makeTextPayload("")).toBeNull();
    const long = "x".repeat(MAX_DRAG_TEXT + 50);
    const p = makeTextPayload(long);
    expect(p?.kind).toBe("text");
    if (p?.kind === "text") expect(p.text.length).toBe(MAX_DRAG_TEXT);
    const withTitle = makeTextPayload("body", "  Title  ");
    expect(withTitle).toEqual({ kind: "text", text: "body", title: "Title" });
  });

  test("makePhonePayload：空白 ⇒ null；label 可选", () => {
    expect(makePhonePayload("  ")).toBeNull();
    expect(makePhonePayload("13800138000", "张三")).toEqual({
      kind: "phone",
      number: "13800138000",
      label: "张三",
    });
  });

  test("payloadDetail 是给芯片看的一行；label/标题优先，按 MAX 截断", () => {
    expect(payloadDetail({ kind: "phone", number: "10086" })).toBe("10086");
    expect(payloadDetail({ kind: "text", text: "a\n  b", title: "T" })).toBe("T");
    const long = payloadDetail({ kind: "text", text: "y".repeat(200) });
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("…")).toBe(true);
  });

  test("payloadLabelKey 是词表的 i18n 名词键", () => {
    expect(payloadLabelKey({ kind: "text", text: "x" })).toBe("drag.text");
    expect(payloadLabelKey({ kind: "phone", number: "1" })).toBe("drag.phone");
  });
});

describe("dragDrop · 能力表", () => {
  test("每个 app 都是真实 APP_META id（否则能力表给了一个不存在的目标）", () => {
    const known = new Set(APP_META.map((a) => a.id));
    for (const c of DROP_CAPABILITIES) {
      expect(known.has(c.app)).toBe(true);
    }
  });

  test("(kind, app) 不重复 —— 否则 resolveDrop 的 find 会静默丢掉后一行", () => {
    const seen = new Set<string>();
    for (const c of DROP_CAPABILITIES) {
      const key = `${c.kind}::${c.app}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("每个 verb 都在 svelte/dropActions.ts 的执行分支里出现（表与执行双向绑定）", () => {
    const adapter = readSrc("../../svelte/dropActions.ts");
    for (const c of DROP_CAPABILITIES) {
      expect(adapter.includes(`case "${c.verb}"`)).toBe(true);
    }
  });

  test("每个 verb 对应的 appLinks 深链函数确实存在（复用同一个 hand-off）", () => {
    const links = readSrc("../../svelte/appLinks.ts");
    for (const fn of ["composeSmsTo", "dialNumber", "sendToAi", "openNoteDraft"]) {
      expect(links.includes(`export function ${fn}(`)).toBe(true);
    }
  });

  test("能力表是唯一一份 —— 只有 lib/dragDrop.ts 声明 DROP_CAPABILITIES", () => {
    const kernel = readSrc("../dragDrop.ts");
    expect(kernel.includes("export const DROP_CAPABILITIES")).toBe(true);
    const actions = readSrc("../../svelte/dropActions.ts");
    expect(actions.includes("export const DROP_CAPABILITIES")).toBe(false);
  });
});

describe("dragDrop · resolveDrop 判定", () => {
  const text: DragPayload = { kind: "text", text: "hello" };
  const phone: DragPayload = { kind: "phone", number: "10086" };

  test("空/无目标 ⇒ no-target", () => {
    expect(resolveDrop(text, null, "notes")).toEqual({ kind: "reject", reason: "no-target" });
    expect(resolveDrop(text, "  ", "notes")).toEqual({ kind: "reject", reason: "no-target" });
  });

  test("松回原应用 ⇒ same-app（拒绝，不静默复制）", () => {
    expect(resolveDrop(phone, "contacts", "contacts")).toEqual({
      kind: "reject",
      reason: "same-app",
    });
  });

  test("目标应用真实但不能收这种载荷 ⇒ unsupported", () => {
    expect(resolveDrop(phone, "ai", "contacts")).toEqual({
      kind: "reject",
      reason: "unsupported",
    });
    expect(resolveDrop(text, "phone", "notes")).toEqual({
      kind: "reject",
      reason: "unsupported",
    });
    expect(resolveDrop(text, "calculator", "notes")).toEqual({
      kind: "reject",
      reason: "unsupported",
    });
  });

  test("每条能力行都被接受，且 verb 与表一致", () => {
    const sample: Record<DragKind, DragPayload> = { text, phone };
    for (const c of DROP_CAPABILITIES) {
      const payload = sample[c.kind];
      expect(resolveDrop(payload, c.app, "other-app")).toEqual({
        kind: "accept",
        app: c.app,
        verb: c.verb,
      });
      expect(dropVerb(payload, c.app)).toBe(c.verb);
    }
  });

  test("rejectionKey 给每种拒绝一条用户能读的句子", () => {
    expect(rejectionKey("same-app")).toBe("drag.rejectSameApp");
    expect(rejectionKey("unsupported")).toBe("drag.rejectUnsupported");
    expect(rejectionKey("no-target")).toBe("drag.dropHint");
  });
});

describe("dragDrop · 结构性负控（词表不许在壳里被重写）", () => {
  test("两个拖拽源都从内核取载荷构造器，不内联 kind 字面量", () => {
    const contacts = readSrc("../../svelte/ContactsApp.svelte");
    const notes = readSrc("../../svelte/NotesApp.svelte");
    expect(contacts.includes("makePhonePayload")).toBe(true);
    expect(notes.includes("makeTextPayload")).toBe(true);
    expect(contacts.includes('kind: "phone"')).toBe(false);
    expect(notes.includes('kind: "text"')).toBe(false);
  });

  test("分享面板的生产者也从内核取载荷构造器，不内联 kind 字面量", () => {
    // The share payload's `kind` is the same vocabulary word the drag kernel owns.
    // This guard used to read only Contacts/Notes, so FilesApp's inline
    // `{ kind: "file", … }` sat outside it — the hole is closed with the producers.
    const files = readSrc("../../svelte/FilesApp.svelte");
    expect(files.includes("fileShare(")).toBe(true);
    expect(files.includes("openShareSheet({")).toBe(false);
    const notes = readSrc("../../svelte/NotesApp.svelte");
    expect(notes.includes("textShare(")).toBe(true);
    expect(notes.includes('kind: "text"')).toBe(false);
  });

  test("每个应用面板都是投放目标（AppPane 挂 data-drop-app 并读同一个会话）", () => {
    const pane = readSrc("../../svelte/AppPane.svelte");
    expect(pane.includes("data-drop-app={id}")).toBe(true);
    expect(pane.includes("dragSession")).toBe(true);
    // The highlight must branch on the resolution, not just "is the pointer here".
    expect(pane.includes('dropState === \'accept\'')).toBe(true);
    expect(pane.includes("ring-danger")).toBe(true);
  });

  test("壳里只有 DragGhost 拥有窗口级指针监听（拖拽生命周期一处）", () => {
    const ghost = readSrc("../../svelte/DragGhost.svelte");
    expect(ghost.includes("endDrag")).toBe(true);
    expect(ghost.includes("performDrop")).toBe(true);
  });
});
