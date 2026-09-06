import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { AppComponent } from "../apps";
import { NOTES_KEY } from "../lib/notes";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.removeItem(NOTES_KEY);
});

async function mountNotes() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AppComponent id="notes" />
      </I18nProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  mounted.push({ root, host });
  return host;
}

/** Drive a React-controlled textarea via its internal onChange. */
function typeInto(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  const props = (el as unknown as Record<string, { onChange?: (e: { target: { value: string } }) => void }>)[key!]!;
  props.onChange?.({ target: { value: text } });
}

describe("Notes — read-only checklist with quick toggle + progress (DOM)", () => {
  test("compose a task note, then tick a box in the read-only list to advance progress", async () => {
    const host = await mountNotes();

    // Compose a note with two task lines (compose textarea has placeholder 写点什么…).
    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    await act(async () => typeInto(ta, "买菜\n- [ ] 苹果\n- [x] 香蕉"));
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "保存")!.click();
    });
    // New note rendered read-only with its checklist + progress 1/2.
    expect(host.textContent).toContain("苹果");
    expect(host.textContent).toContain("1/2");

    // Tap the unchecked 苹果 row in the read-only list -> becomes done.
    const apple = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("苹果"))!;
    await act(async () => {
      apple.click();
    });
    expect(host.textContent).toContain("2/2");
    expect(host.textContent).toContain("清单 2/2 · 1 条"); // aggregate row reflects it too
    // Persisted store reflects the toggled task box.
    const stored = JSON.parse(window.localStorage.getItem(NOTES_KEY) ?? "[]") as { text: string }[];
    expect(stored[0]!.text).toContain("[x] 苹果");
  });

  test("全部完成 marks every remaining task done at once", async () => {
    const host = await mountNotes();
    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => typeInto(ta, "清单\n- [ ] 买牛奶\n- [ ] 买鸡蛋"));
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "保存")!.click();
    });
    expect(host.textContent).toContain("0/2");

    const doneAll = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "全部完成")!;
    expect(doneAll).toBeTruthy();
    await act(async () => {
      doneAll.click();
    });
    expect(host.textContent).toContain("2/2");
  });

  test("a plain note renders as a collapsed iOS row, and tapping opens it", async () => {
    window.localStorage.setItem(
      NOTES_KEY,
      JSON.stringify([{ id: "x", text: "计划\n今晚去买菜\n记得带伞", ts: Date.now() }]),
    );
    const host = await mountNotes();
    // Collapsed row: bold title + preview snippet + "打开", no editing footer yet.
    expect(host.textContent).toContain("计划");
    expect(host.textContent).toContain("今晚去买菜 记得带伞");
    expect(host.textContent).not.toContain("编辑");
    const open = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("打开"))!;
    expect(open).toBeTruthy();
    await act(async () => open.click());
    // Expanded: the full body/actions (编辑) become available.
    expect(host.textContent).toContain("编辑");
    // Collapse back to the row via "收起".
    const collapse = host.querySelector('button[aria-label="收起"]') as HTMLButtonElement | null;
    expect(collapse).toBeTruthy();
    await act(async () => collapse!.click());
    expect(host.textContent).toContain("打开");
    expect(host.textContent).not.toContain("编辑");
  });
  test("a #tag note surfaces a tag chip; tapping it filters to tagged notes", async () => {
    window.localStorage.setItem(
      NOTES_KEY,
      JSON.stringify([
        { id: "a", text: "汇报\n本周进度 #工作\n关键点", ts: Date.now() },
        { id: "b", text: "买菜清单", ts: Date.now() },
      ]),
    );
    const host = await mountNotes();
    expect(host.textContent).toContain("买菜清单");

    // Chip rendered from the active notes' tags.
    const chip = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("#工作"))!;
    expect(chip).toBeTruthy();
    await act(async () => chip.click());
    // Only the tagged note remains in the list.
    expect(host.textContent).toContain("本周进度");
    expect(host.textContent).not.toContain("买菜清单");

    // Clear the tag filter -> both notes are back.
    const clear = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("✕"))!;
    await act(async () => clear.click());
    expect(host.textContent).toContain("买菜清单");
    expect(host.textContent).toContain("本周进度");
  });

  test("clicking a colored #tag inside the opened body filters to that tag", async () => {
    window.localStorage.setItem(
      NOTES_KEY,
      JSON.stringify([
        { id: "a", text: "汇报\n做了 #上线 和部署", ts: Date.now() },
        { id: "b", text: "买菜清单", ts: Date.now() },
      ]),
    );
    const host = await mountNotes();
    // Open note a to reveal its rich body.
    const open = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("打开"))!;
    await act(async () => open.click());
    // The colored tag button inside the body now exists.
    const bodyTag = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "#上线",
    )!;
    expect(bodyTag).toBeTruthy();
    await act(async () => bodyTag.click());
    // Body-tag click jumps back to "all" + applies the filter: note b is hidden.
    expect(host.textContent).toContain("做了");
    expect(host.textContent).not.toContain("买菜清单");
    // The clear chip (#上线 ✕) is present; clearing restores both notes.
    const clear = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("✕"))!;
    await act(async () => clear.click());
    expect(host.textContent).toContain("买菜清单");
  });
  test("multi-select batch archive moves several notes to 归档 at once", async () => {
    window.localStorage.setItem(
      NOTES_KEY,
      JSON.stringify([
        { id: "t1", text: "甲事项", ts: Date.now() },
        { id: "t2", text: "乙事项", ts: Date.now() },
        { id: "t3", text: "丙清单", ts: Date.now() },
      ]),
    );
    const host = await mountNotes();
    const clickBtn = (s: string) => {
      const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.trim() === s)!;
      return act(async () => b.click());
    };
    const rowClick = (title: string) => {
      const b = Array.from(host.querySelectorAll("button")).find(
        (x) => x.getAttribute("aria-pressed") !== null && x.textContent?.includes(title),
      )!;
      return act(async () => b.click());
    };
    // Enter multi-select, pick two notes.
    await clickBtn("选择");
    await rowClick("甲事项");
    await rowClick("乙事项");
    expect(host.textContent).toContain("已选 2");
    await clickBtn("归档"); // batch action (exact "归档", not the "归档 (n)" chip)
    // Both moved out of the active list; the third remains.
    expect(host.textContent).toContain("丙清单");
    expect(host.textContent).not.toContain("甲事项");
    expect(host.textContent).not.toContain("乙事项");
    const stored = JSON.parse(window.localStorage.getItem(NOTES_KEY) ?? "[]") as { state?: string }[];
    expect(stored.filter((n) => n.state === "archived").length).toBe(2);
  });

  test("trash view batch hard-deletes selected notes while leaving others", async () => {
    window.localStorage.setItem(
      NOTES_KEY,
      JSON.stringify([
        { id: "k", text: "保留", ts: Date.now() },
        { id: "d1", text: "旧草稿", ts: Date.now(), state: "trash" },
        { id: "d2", text: "旧清单", ts: Date.now(), state: "trash" },
      ]),
    );
    const host = await mountNotes();
    const actFind = (s: string) => {
      const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.trim() === s)!;
      return act(async () => b.click());
    };
    const rowClick = (title: string) => {
      const b = Array.from(host.querySelectorAll("button")).find(
        (x) => x.getAttribute("aria-pressed") !== null && x.textContent?.includes(title),
      )!;
      return act(async () => b.click());
    };
    // Switch to the trash tab ("最近删除 (2)").
    const trashTab = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("最近删除"),
    )!;
    await act(async () => trashTab.click());
    expect(host.textContent).toContain("旧草稿");
    await actFind("选择");
    await rowClick("旧草稿");
    await rowClick("旧清单");
    expect(host.textContent).toContain("已选 2");
    await actFind("彻底删除");
    const stored = JSON.parse(window.localStorage.getItem(NOTES_KEY) ?? "[]") as { text: string }[];
    expect(stored.map((n) => n.text)).toEqual(["保留"]);
  });

  test("全选 selects all in view; switching tabs leaves select mode", async () => {
    window.localStorage.setItem(
      NOTES_KEY,
      JSON.stringify([
        { id: "a1", text: "甲事项", ts: Date.now() },
        { id: "a2", text: "乙事项", ts: Date.now() },
        { id: "a3", text: "丙清单", ts: Date.now() },
        { id: "z1", text: "已归档旧事", ts: Date.now(), state: "archived" },
      ]),
    );
    const host = await mountNotes();
    const btnTrim = (s: string) => {
      const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.trim() === s)!;
      return act(async () => b.click());
    };
    await btnTrim("选择");
    await btnTrim("全选");
    expect(host.textContent).toContain("已选 3");
    // Tapping a different tab exits multi-select (select mode is scoped to one tab).
    const archivedTab = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("归档"),
    )!;
    await act(async () => archivedTab.click());
    expect(host.textContent).toContain("已归档旧事");
    expect(host.textContent).not.toContain("已选");
    // A fresh select button is available again in the archived view.
    expect(host.textContent).toContain("选择");
  });
});


  test("exporting a note without a backend copies it and reports a fallback message", async () => {
    window.localStorage.setItem(
      NOTES_KEY,
      JSON.stringify([{ id: "e1", text: "备忘正文\n第二行", ts: Date.now() }]),
    );
    const host = await mountNotes();
    // Open the note to reveal its footer export action.
    const open = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("打开"),
    )!;
    await act(async () => open.click());
    // No Tauri bridge here → exportTxtFile returns null, so we fall back to the
    // clipboard and surface the localized message.
    const exportBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("导出"),
    )!;
    expect(exportBtn).toBeTruthy();
    await act(async () => {
      exportBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.textContent).toContain("已复制到剪贴板（未连接后端）");
  });
