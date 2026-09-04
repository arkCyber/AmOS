import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { AppComponent, appIcon, appTitleKey } from "../apps";
import { isBespokeTile } from "../components/AppIcon";
import { VMEMOS_KEY } from "../lib/voiceMemos";

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
  window.localStorage.removeItem(VMEMOS_KEY);
});

async function mountVmem() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AppComponent id="vmemos" />
      </I18nProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  mounted.push({ root, host });
  return host;
}
function typeInto(el: HTMLInputElement, text: string) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  const props = (el as unknown as Record<string, { onChange?: (e: { target: { value: string } }) => void }>)[key!]!;
  props.onChange?.({ target: { value: text } });
}
const store = () =>
  JSON.parse(window.localStorage.getItem(VMEMOS_KEY) ?? "[]") as { id: string; title: string; src: string }[];

describe("Voice Memos (语音备忘录) DOM", () => {
  test("is registered with a home tile + the Apple-style bespoke face", () => {
    expect(appTitleKey("vmemos")).toBe("app.vmemos");
    expect(appIcon("vmemos")).toBe("🎙️");
    expect(isBespokeTile("vmemos")).toBe(true);
  });

  test("seeds playable demo memos and shows the recorder", async () => {
    const host = await mountVmem();
    expect(host.textContent).toContain("轻点红点开始录音"); // recorder hint
    expect(store()).toHaveLength(2); // demo clips persisted
    expect(host.querySelectorAll('button[aria-label="播放"]').length).toBe(2);
  });

  test("renames a memo inline and persists", async () => {
    const host = await mountVmem();
    const rename = host.querySelectorAll('button[aria-label="重命名"]')[0] as HTMLButtonElement;
    await act(async () => rename.click());
    const input = host.querySelector('input[aria-label="录音标题"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => typeInto(input, "项目会议录音"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(store().some((x) => x.title === "项目会议录音")).toBe(true);
    expect(host.textContent).toContain("项目会议录音");
  });

  test("deletes a memo and reaches the empty state", async () => {
    const host = await mountVmem();
    let del = host.querySelectorAll('button[aria-label="删除"]');
    await act(async () => (del[0] as HTMLButtonElement).click());
    expect(store()).toHaveLength(1);
    del = host.querySelectorAll('button[aria-label="删除"]');
    await act(async () => (del[0] as HTMLButtonElement).click());
    expect(store()).toHaveLength(0);
    expect(host.textContent).toContain("暂无语音备忘录");
  });
});
