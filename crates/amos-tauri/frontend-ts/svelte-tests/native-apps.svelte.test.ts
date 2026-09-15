/**
 * DOM tests for the Svelte native-application screen (NativeAppsApp.svelte).
 *
 * The screen is the only consumer of the six `wine_*` / `linux_*` commands, so what
 * these tests pin is the pair of contracts that matter: the four **different**
 * states (no bridge / unavailable / empty / listed) are never conflated, and a
 * launch submits an **id**, never a path.
 *
 * The bridge is stubbed through `window.__TAURI_INTERNALS__` (the same seam
 * `lib/backend.ts` reads in production), so the command names and argument keys
 * under test are the real ones.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import NativeAppsApp from "../src/svelte/NativeAppsApp.svelte";

type Call = { command: string; args?: Record<string, unknown> };
let calls: Call[] = [];

function installBridge(reply: (command: string) => unknown) {
  calls = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      const value = reply(command);
      if (value instanceof Error) throw value;
      return value;
    },
    listen: async () => () => {},
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  calls = [];
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 40));

describe("NativeAppsApp.svelte", () => {
  test("without a host it says so instead of showing an empty machine", async () => {
    const host = render(NativeAppsApp);
    await settle();
    expect(txt(host)).toContain("未在 AmOS 内运行");
    expect(host.container.querySelector("[data-testid='native-offline']")).not.toBeNull();
    // Crucially: no "this machine has no apps" claim, and no sections at all.
    expect(host.container.querySelectorAll("[data-testid='native-section-wine']").length).toBe(0);
  });

  test("unavailable and empty are different sentences", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return false; // no Wine
      if (cmd === "linux_is_available") return true; // Linux, but nothing installed
      if (cmd === "wine_apps") return [];
      if (cmd === "linux_apps") return [];
      return null;
    });
    const host = render(NativeAppsApp);
    await settle();
    const body = txt(host);
    expect(body).toContain("没有安装 Wine");
    expect(body).toContain("XDG 应用目录里没有可启动的 .desktop 条目");
    expect(body).not.toContain("未在 AmOS 内运行");
  });

  test("rows show the program the host would run, and launching submits the id", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return true;
      if (cmd === "linux_is_available") return false;
      if (cmd === "wine_apps")
        return [{ id: "Notepad", name: "记事本", exePath: "C:\\np.exe", desktopPath: "/w/n.desktop" }];
      if (cmd === "linux_apps") return [];
      if (cmd === "wine_launch") return "记事本";
      return null;
    });
    const host = render(NativeAppsApp);
    await settle();
    expect(txt(host)).toContain("记事本");
    expect(txt(host)).toContain("C:\\np.exe");

    const button = host.container.querySelector("[data-testid='native-launch']");
    expect(button).not.toBeNull();
    await fireEvent.click(button as HTMLElement);
    await settle();

    expect(calls).toContainEqual({ command: "wine_launch", args: { id: "Notepad" } });
    // …and the payload never carried the path the row displayed.
    for (const call of calls) {
      expect(JSON.stringify(call.args ?? {})).not.toContain("np.exe");
    }
    expect(txt(host)).toContain("已启动「记事本」");
  });

  test("a refused launch shows the host's own reason", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return true;
      if (cmd === "linux_is_available") return true;
      if (cmd === "wine_apps") return [{ id: "Ghost", name: "Ghost", exePath: "g.exe" }];
      if (cmd === "linux_apps") return [];
      if (cmd === "wine_launch") return new Error("no Wine app with id 'Ghost' is installed");
      return null;
    });
    const host = render(NativeAppsApp);
    await settle();
    const button = host.container.querySelector("[data-testid='native-launch']");
    await fireEvent.click(button as HTMLElement);
    await settle();

    const banner = host.container.querySelector("[data-testid='native-refused']");
    expect(banner?.textContent ?? "").toContain("no Wine app with id 'Ghost' is installed");
  });
});
