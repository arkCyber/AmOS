/**
 * DOM tests for the two Settings "kit" components (REQ-A149): Segmented (the
 * single-choice rows used for 外观 / 语言 / 自动息屏) and Switch (the toggle every
 * sub page shares). Both were listed among the components with no direct test.
 *
 * Writing the Segmented test meant reading it, and reading it showed it did not follow
 * the ARIA `radiogroup` keyboard convention: every option was its own tab stop and the
 * arrow keys did nothing. The second half of this file pins the convention down
 * (arrow keys move + wrap, exactly one tab stop via roving tabindex).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Segmented from "../src/svelte/settings/Segmented.svelte";
import Switch from "../src/svelte/settings/Switch.svelte";

afterEach(cleanup);

type Host = { container: HTMLElement; getAllByRole: (r: string) => HTMLElement[] };
const radios = (host: Host) => host.getAllByRole("radio") as HTMLButtonElement[];

describe("Switch.svelte", () => {
  test("exposes its state to assistive tech and reports a toggle", async () => {
    const ontoggle = vi.fn();
    const host = render(Switch, { on: false, ontoggle, aria: "专注" });
    const sw = host.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-label")).toBe("专注");

    await fireEvent.click(sw);
    expect(ontoggle).toHaveBeenCalledTimes(1);
  });

  test("on=true reads as checked and the thumb is translated", () => {
    const host = render(Switch, { on: true, ontoggle: () => {} });
    expect(host.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    const thumb = host.container.querySelector("span") as HTMLElement;
    expect(thumb.className).toContain("translate-x-[18px]");
  });

  test("a disabled switch is disabled and cannot toggle", async () => {
    const ontoggle = vi.fn();
    const host = render(Switch, { on: true, ontoggle, disabled: true });
    const sw = host.getByRole("switch") as HTMLButtonElement;
    expect(sw.disabled).toBe(true);

    await fireEvent.click(sw);
    expect(ontoggle).not.toHaveBeenCalled();
  });
});

describe("Segmented.svelte", () => {
  const options = [
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
    { value: "auto", label: "自动" },
  ];

  test("selection is exposed as aria-checked, with exactly one tab stop", () => {
    const host = render(Segmented, {
      options,
      value: "dark",
      onpick: () => {},
      aria: "外观",
    });
    expect(host.getByRole("radiogroup").getAttribute("aria-label")).toBe("外观");

    const rs = radios(host as unknown as Host);
    expect(rs.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    // Roving tabindex: the group is one tab stop, the arrows move within it.
    expect(rs.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  test("a click picks that option's value", async () => {
    const onpick = vi.fn();
    const host = render(Segmented, { options, value: "light", onpick });
    await fireEvent.click(radios(host as unknown as Host)[2]);
    expect(onpick).toHaveBeenCalledWith("auto");
  });

  test("arrow keys move the selection, wrap around, and take the focus with them", async () => {
    const onpick = vi.fn();
    const host = render(Segmented, { options, value: "auto", onpick });
    // A real key event originates from the focused option (that is the tab stop).
    const selected = radios(host as unknown as Host)[2];

    // "auto" is last ⇒ the next option wraps to the first. (The component is controlled:
    // `value` only changes because the caller re-renders it, so the test does that
    // explicitly instead of pretending the prop moved on its own.)
    await fireEvent.keyDown(selected, { key: "ArrowRight" });
    expect(onpick).toHaveBeenLastCalledWith("light");
    await tick();
    expect(document.activeElement).toBe(radios(host as unknown as Host)[0]);

    // …and from the first, the previous option wraps back to the last.
    await host.rerender({ options, value: "light", onpick });
    await fireEvent.keyDown(radios(host as unknown as Host)[0], { key: "ArrowLeft" });
    expect(onpick).toHaveBeenLastCalledWith("auto");
  });

  test("vertical arrows behave like the horizontal ones", async () => {
    const onpick = vi.fn();
    const host = render(Segmented, { options, value: "light", onpick });
    await fireEvent.keyDown(radios(host as unknown as Host)[0], { key: "ArrowDown" });
    expect(onpick).toHaveBeenLastCalledWith("dark");
  });

  test("unrelated keys are left alone", async () => {
    const onpick = vi.fn();
    const host = render(Segmented, { options, value: "light", onpick });
    await fireEvent.keyDown(radios(host as unknown as Host)[0], { key: "Tab" });
    expect(onpick).not.toHaveBeenCalled();
  });
});
