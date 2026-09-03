import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import Segmented, { type SegmentedOption } from "../components/Segmented";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const opts: SegmentedOption<"a" | "b" | "c">[] = [
  { value: "a", label: "甲" },
  { value: "b", label: "乙" },
  { value: "c", label: "丙" },
];

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
});

async function mount(initial: "a" | "b" | "c") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const calls: ("a" | "b" | "c")[] = [];
  function Harness() {
    const [v, setV] = useState(initial);
    return (
      <Segmented
        ariaLabel="mode"
        value={v}
        options={opts}
        onChange={(nv) => {
          calls.push(nv);
          setV(nv);
        }}
      />
    );
  }
  await act(async () => {
    root.render(<Harness />);
    await new Promise((r) => setTimeout(r, 0));
  });
  mounted.push({ root, host });
  return { host, calls };
}

describe("Segmented (controlled radio group)", () => {
  test("renders radiogroup with the active option checked", async () => {
    const { host } = await mount("b");
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("mode");
    const radios = host.querySelectorAll('[role="radio"]');
    expect(radios.length).toBe(3);
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]!.getAttribute("aria-checked")).toBe("false");
    expect(radios[2]!.getAttribute("aria-checked")).toBe("false");
  });

  test("clicking an inactive option fires onChange and moves the checked state", async () => {
    const { host, calls } = await mount("a");
    const radios = Array.from(host.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
    await act(async () => {
      radios[2]!.click(); // 丙
    });
    expect(calls).toEqual(["c"]);
    expect(radios[2]!.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]!.getAttribute("aria-checked")).toBe("false");
  });
});
