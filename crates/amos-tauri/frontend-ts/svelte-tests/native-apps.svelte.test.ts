/**
 * DOM tests for the Svelte native-application screen (NativeAppsApp.svelte).
 *
 * The screen is the only consumer of the six `wine_*` / `linux_*` commands, so what
 * these tests pin is the pair of contracts that matter: the **five** different states
 * (no bridge / unavailable / refused enumeration / empty / listed) are never conflated,
 * and a launch submits an **id**, never a path.
 *
 * The header used to say **four** states and claim they were never conflated — while
 * the code had three arms and folded the refused enumeration into `ok: []`. A stated
 * invariant is not an enforced one: the fifth state is `unconfirmed` (REQ-A836 /
 * F-SH-266), added with the tests at the bottom of this file.
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

  /**
   * **One kind refused** (REQ-A836 / F-SH-266). A refused enumeration used to be folded
   * into `ok: []`, which reaches the empty-state sentence — a positive claim about this
   * machine's filesystem ("Wine is installed, but its prefixes hold no launchable
   * Windows app") made from a read that never happened. The *other* kind's rows must
   * still be shown: refusing to display what the host did answer would be its own lie.
   */
  test("a refused enumeration is its own state, not an empty machine", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return true;
      if (cmd === "linux_is_available") return true;
      // Availability answers; the enumeration is refused — the host *threw*, which is
      // what `invoke` turns into a `null` reply plus a diagnosis entry.
      if (cmd === "wine_apps") return new Error("the enumerator could not read the Wine prefixes");
      if (cmd === "linux_apps")
        return [{ id: "org.gimp.GIMP", name: "GIMP", desktopPath: "/d/gimp.desktop" }];
      return null;
    });
    const host = render(NativeAppsApp);
    await settle();

    expect(host.container.querySelector("[data-testid='native-unasked-wine']")).not.toBeNull();
    // Not "this machine has no apps", and not the unavailability sentence either.
    expect(txt(host)).not.toContain("Wine 已安装，但它的前缀里没有可启动的 Windows 应用");
    expect(txt(host)).not.toContain("本机没有安装 Wine");
    expect(txt(host)).not.toContain("未在 AmOS 内运行");
    expect(host.container.querySelector("[data-testid='native-empty-wine']")).toBeNull();
    // The half the host *did* answer is still on screen…
    expect(txt(host)).toContain("GIMP");
    // …and no total is claimed from a read that only half happened.
    expect(host.container.querySelector("[data-testid='native-count']")).toBeNull();
  });

  // Neither enumeration answered: the whole surface says so, rather than showing two
  // refused sections as if they were empty ones.
  test("both enumerations refused is its own state", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return true;
      if (cmd === "linux_is_available") return true;
      if (cmd === "wine_apps") return new Error("refused");
      if (cmd === "linux_apps") return new Error("refused");
      return null;
    });
    const host = render(NativeAppsApp);
    await settle();

    expect(host.container.querySelector("[data-testid='native-unconfirmed']")).not.toBeNull();
    expect(host.container.querySelector("[data-testid='native-section-wine']")).toBeNull();
    expect(txt(host)).not.toContain("Wine 已安装，但它的前缀里没有可启动的 Windows 应用");
  });

  // The control: an enumeration the host *did* answer, with nothing in it, still gets
  // the empty sentence — the fix must not silence a true "there is nothing here".
  test("an enumeration the host confirms as empty still says so", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return true;
      if (cmd === "linux_is_available") return false;
      if (cmd === "wine_apps") return [];
      if (cmd === "linux_apps") return [];
      return null;
    });
    const host = render(NativeAppsApp);
    await settle();

    expect(txt(host)).toContain("Wine 已安装，但它的前缀里没有可启动的 Windows 应用");
    expect(host.container.querySelector("[data-testid='native-unconfirmed']")).toBeNull();
  });

  /**
   * **One availability probe refused** (REQ-A1363 / F-SH-627). F-SH-266 split the
   * *listing* per kind; the *availability* read right above it was left folding `null`
   * into `false` (`wine === true`). The empty-state wording reads availability as its
   * **reason**, so a refused `wine_is_available` made this screen say 「本机没有安装
   * Wine」 — a claim about this machine's PATH, from a question nobody answered. The
   * listing *did* answer (empty), so the section stays; it is the *reason* that must not
   * be invented.
   */
  test("a refused availability probe is not 'this machine lacks it'", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return new Error("the probe could not read PATH");
      if (cmd === "linux_is_available") return true;
      if (cmd === "wine_apps") return [];
      if (cmd === "linux_apps") return [];
      return null;
    });
    const host = render(NativeAppsApp);
    await settle();

    // The listing answered, so the section is drawn with the emptiness it confirmed…
    expect(host.container.querySelector("[data-testid='native-empty-wine']")).not.toBeNull();
    // …and the reason is neither a claim the probe never made…
    expect(txt(host)).not.toContain("本机没有安装 Wine");
    // …nor the other machine-claim (that Wine *is* installed and merely empty): the
    // refusal is its own sentence, and it must be *said*, not just not-asserted.
    expect(txt(host)).not.toContain("Wine 已安装，但它的前缀里没有可启动的 Windows 应用");
    expect(txt(host)).toContain("宿主没有回答本机能不能运行这类应用");
    // The kind whose probe *did* answer keeps its own sentence.
    expect(txt(host)).toContain("XDG 应用目录里没有可启动的 .desktop 条目");
  });

  // The twin: fixing one leaf and not the other is exactly how this family recurs.
  test("…and the same for the other kind", async () => {
    installBridge((cmd) => {
      if (cmd === "wine_is_available") return true;
      if (cmd === "linux_is_available") return new Error("the probe could not read PATH");
      if (cmd === "wine_apps") return [];
      if (cmd === "linux_apps") return [];
      return null;
    });
    const host = render(NativeAppsApp);
    await settle();

    expect(host.container.querySelector("[data-testid='native-empty-linux']")).not.toBeNull();
    expect(txt(host)).not.toContain("当前宿主不是 Linux");
    expect(txt(host)).not.toContain("XDG 应用目录里没有可启动的 .desktop 条目");
    expect(txt(host)).toContain("宿主没有回答本机能不能运行这类应用");
    // The kind whose probe *did* answer keeps its own sentence.
    expect(txt(host)).toContain("Wine 已安装，但它的前缀里没有可启动的 Windows 应用");
  });
});
