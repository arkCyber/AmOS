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
});
