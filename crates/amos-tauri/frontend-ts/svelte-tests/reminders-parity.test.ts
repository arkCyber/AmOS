/**
 * React ↔ Svelte dual-implementation parity tests for the REMINDERS screen.
 *
 * Both the React `RemindersApp` (src/components/RemindersApp.tsx) and the Svelte
 * `RemindersApp` (src/svelte/RemindersApp.svelte) run the same pure
 * lib/reminders.ts CRUD against the shared amos.reminders/amos.reminderLists
 * store, and both seed identical demo content on an empty store. We mount each
 * and drive identical interactions (add a reminder, complete one) asserting the
 * same visible outcome.
 *
 * Under vitest (no PROD), `svelteEnabled()` routes the React body, so
 * `AppComponent id="reminders"` yields the React implementation.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import RemindersApp from "../src/svelte/RemindersApp.svelte";
import { I18nProvider } from "../src/i18n";
import { AppComponent } from "../src/apps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedReact: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mountedReact.length) {
    const m = mountedReact.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.clear();
});

function mountReactReminders() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "reminders" }),
    ),
  );
  return host;
}
const clearStore = () => window.localStorage.clear();
const txt = (root: HTMLElement) => root.textContent ?? "";
const buttonContaining = (root: HTMLElement, s: string) =>
  [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s));

async function reactClick(root: HTMLElement, el: HTMLButtonElement | undefined) {
  expect(el, "missing react button").toBeTruthy();
  await act(async () => {
    el!.click();
  });
}
const inputByLabel = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === label) as
    HTMLInputElement | undefined;
function reactType(input: HTMLInputElement | undefined, value: string) {
  expect(input, "missing react input").toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function reactAddReminder(root: HTMLElement, title: string) {
  await reactClick(root, buttonContaining(root, "新提醒事项") as HTMLButtonElement);
  reactType(inputByLabel(root, "标题"), title);
  await reactClick(root, buttonContaining(root, "添加") as HTMLButtonElement);
}
async function svelteAddReminder(root: HTMLElement, title: string) {
  await fireEvent.click(buttonContaining(root, "新提醒事项") as HTMLButtonElement);
  const titleEl = [...root.querySelectorAll("input")].find(
    (i) => i.getAttribute("aria-label") === "标题",
  ) as HTMLInputElement;
  await fireEvent.input(titleEl, { target: { value: title } });
  await fireEvent.click(buttonContaining(root, "添加") as HTMLButtonElement);
}
async function svelteCompleteSeeded(root: HTMLElement, seededTitle: string) {
  const toggle = [...root.querySelectorAll('button[aria-label="done"]')].find((b) =>
    (b.parentElement?.textContent ?? "").includes(seededTitle),
  );
  await fireEvent.click(toggle as HTMLButtonElement);
}
async function reactCompleteSeeded(root: HTMLElement, seededTitle: string) {
  const toggle = [...root.querySelectorAll('button[aria-label="done"]')].find((b) =>
    (b.parentElement?.textContent ?? "").includes(seededTitle),
  );
  await reactClick(root, toggle as HTMLButtonElement);
}
async function openDoneChip(root: HTMLElement) {
  const chip = [...root.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith("已完成"),
  );
  await reactClick(root, chip as HTMLButtonElement);
}

describe("React ↔ Svelte reminders parity", () => {
  test("adding a reminder shows it in both (empty store seeds demo first)", async () => {
    clearStore();
    const react = mountReactReminders();
    await act(async () => {});
    await reactAddReminder(react, "买咖啡");
    expect(txt(react)).toContain("买咖啡");

    clearStore();
    const svelte = render(RemindersApp);
    await svelteAddReminder(svelte.container, "买咖啡");
    expect(txt(svelte.container)).toContain("买咖啡");
  });

  test("completing a seeded reminder lands it in 已完成 in both", async () => {
    clearStore();
    const react = mountReactReminders();
    await act(async () => {});
    await reactCompleteSeeded(react, "写周报");
    expect(txt(react)).not.toContain("写周报");
    await openDoneChip(react);
    expect(txt(react)).toContain("写周报");

    clearStore();
    const svelte = render(RemindersApp);
    await svelteCompleteSeeded(svelte.container, "写周报");
    expect(txt(svelte.container)).not.toContain("写周报");
    // Switch Svelte to the 已完成 smart chip (click works for Svelte too).
    const chip = [...svelte.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim().startsWith("已完成"),
    );
    await fireEvent.click(chip as HTMLButtonElement);
    expect(txt(svelte.container)).toContain("写周报");
  });
});
