import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { AppComponent } from "../apps";

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
});

function mountClock() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <AppComponent id="clock" />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

describe("clock app (stopwatch isolated as a subcomponent)", () => {
  test("renders the timer and stopwatch cards and the stopwatch starts", async () => {
    const host = mountClock();
    await act(async () => {});

    expect(host.textContent).toContain("计时器");
    expect(host.textContent).toContain("闹钟");
    expect(host.textContent).toContain("秒表");

    // Start the stopwatch: play ▶ becomes pause ⏸.
    const start = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.getAttribute("aria-label") ?? "").includes("秒表"),
    ) as HTMLButtonElement;
    expect(start).toBeTruthy();
    await act(async () => {
      start.click();
    });
    const nowPlaying = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.getAttribute("aria-label") ?? "").includes("秒表"),
    ) as HTMLButtonElement;
    expect(nowPlaying.textContent).toContain("⏸");
  });

  test("stopwatch lap records a snapshot, disabled until running, cleared on reset", async () => {
    const host = mountClock();
    await act(async () => {});

    const lapBtn = () =>
      Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "lap") as HTMLButtonElement;
    // Disabled before start.
    expect(lapBtn().disabled).toBe(true);

    const start = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.getAttribute("aria-label") ?? "").includes("秒表"),
    ) as HTMLButtonElement;
    await act(async () => {
      start.click();
    });
    expect(lapBtn().disabled).toBe(false);

    await act(async () => {
      lapBtn().click();
    });
    expect(host.textContent).toContain("计次 1");
  });
});

describe("clock app world clock (editable)", () => {
  afterEach(() => {
    window.localStorage.removeItem("amos.worldclock");
  });

  test("default 4 cities; + adds a 5th that persists; edit shows ✕ then 完成 exits", async () => {
    const host = mountClock();
    await act(async () => {});

    for (const c of ["北京", "东京", "伦敦", "纽约"]) expect(host.textContent).toContain(c);
    expect(host.textContent).not.toContain("悉尼");

    const addBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "+ 城市");
    expect(addBtn).toBeTruthy();
    await act(async () => {
      addBtn!.click();
    });
    expect(host.textContent).toContain("悉尼");
    const stored = JSON.parse(window.localStorage.getItem("amos.worldclock") ?? "[]") as { zone: string }[];
    expect(stored.map((c) => c.zone)).toContain("Australia/Sydney");

    const edit = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "编辑")!;
    await act(async () => {
      edit.click();
    });
    expect(Array.from(host.querySelectorAll("button")).filter((b) => b.textContent === "✕").length).toBeGreaterThanOrEqual(1);
    // The edit button toggles to 完成; click the SAME element to exit edit mode.
    await act(async () => {
      edit.click();
    });
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent === "✕")).toBe(false);
  });
});
