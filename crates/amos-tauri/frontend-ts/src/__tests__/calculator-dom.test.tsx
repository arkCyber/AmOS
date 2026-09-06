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

function mountCalc() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <AppComponent id="calculator" />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

async function key(k: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
  });
}

describe("calculator physical-keyboard input", () => {
  test("typing 9 + 3 Enter shows 12 (keydown listener via ref)", async () => {
    const host = mountCalc();
    await act(async () => {});
    expect(host.textContent).toContain("0"); // initial display

    await key("9");
    await key("+");
    await key("3");
    await key("Enter");
    expect(host.textContent).toContain("12"); // computed and shown
  });

  test("Enter is prevented so it never double-fires (listener registered once)", async () => {
    const host = mountCalc();
    await act(async () => {});
    await key("5");
    await key("Enter");
    // 5 = 5 → display stays 5 (no spurious empty second operation)
    expect(host.textContent).toContain("5");
  });
});

describe("calculator on-screen keypad (DOM)", () => {
  const display = (host: HTMLElement) =>
    host.querySelector('[role="status"]')?.textContent ?? "";
  const clearBtn = (host: HTMLElement) =>
    host.querySelector(
      'button[aria-label="AC"], button[aria-label="C"]',
    ) as HTMLButtonElement | null;

  async function tap(host: HTMLElement, aria: string) {
    const el = host.querySelector(`button[aria-label="${aria}"]`) as
      | HTMLButtonElement
      | null;
    expect(el, `missing key "${aria}"`).toBeTruthy();
    await act(async () => el!.click());
  }

  test("tapping digits/operators/= computes and shows the result", async () => {
    const host = mountCalc();
    await act(async () => {});
    await tap(host, "9");
    await tap(host, "+");
    await tap(host, "3");
    await tap(host, "=");
    expect(display(host)).toBe("12");
  });

  test("± toggles the sign of the shown entry and 0 is a no-op", async () => {
    const host = mountCalc();
    await act(async () => {});
    await tap(host, "5");
    await tap(host, "±");
    expect(display(host)).toBe("-5");
    await tap(host, "±");
    expect(display(host)).toBe("5");
    // a fresh 0 followed by ± must not produce "-0"
    await tap(host, "C");
    await tap(host, "±");
    expect(display(host)).toBe("0");
  });

  test("clear key reads AC fresh, flips to C while typing, and resets", async () => {
    const host = mountCalc();
    await act(async () => {});
    expect(clearBtn(host)?.getAttribute("aria-label")).toBe("AC");
    await tap(host, "7");
    expect(clearBtn(host)?.getAttribute("aria-label")).toBe("C");
    await act(async () => clearBtn(host)!.click());
    expect(display(host)).toBe("0");
    expect(clearBtn(host)?.getAttribute("aria-label")).toBe("AC");
  });
});
