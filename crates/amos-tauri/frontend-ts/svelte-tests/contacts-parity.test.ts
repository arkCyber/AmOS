/**
 * React ↔ Svelte dual-implementation parity tests for the CONTACTS screen.
 *
 * Both the React `ContactsApp` (src/components/ContactsApp.tsx, registered as
 * "contacts") and the Svelte `ContactsApp` (src/svelte/ContactsApp.svelte) run
 * the same pure lib/contacts.ts CRUD against the shared amos.contacts store.
 * Here we mount BOTH and drive an add + favorite with identical inputs, asserting
 * the same visible outcome — closing the last remaining migrated-screen gap.
 *
 * Typing into React controlled inputs requires the native value setter + an
 * `input` event (React 18 onChange); Svelte bind:value uses a plain input event.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import ContactsApp from "../src/svelte/ContactsApp.svelte";
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
});

function mountReactContacts() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "contacts" }),
    ),
  );
  return host;
}
const clearStore = () => window.localStorage.clear();
const txt = (root: HTMLElement) => root.textContent ?? "";
const buttonByTitle = (root: HTMLElement, title: string) =>
  [...root.querySelectorAll("button")].find((b) => b.getAttribute("title") === title);
const buttonContaining = (root: HTMLElement, s: string) =>
  [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s));

async function reactClick(root: HTMLElement, el: HTMLButtonElement | undefined) {
  expect(el, "missing react button").toBeTruthy();
  await act(async () => {
    el!.click();
  });
}
const inputByPlaceholder = (root: HTMLElement, ph: string) =>
  [...root.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === ph) as
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

async function reactAddContact(root: HTMLElement, name: string, phones: string) {
  await reactClick(root, buttonContaining(root, "添加"));
  reactType(inputByPlaceholder(root, "姓名"), name);
  reactType(inputByPlaceholder(root, "电话号码（逗号/换行分隔）"), phones);
  await reactClick(root, buttonContaining(root, "保存"));
}

async function svelteAddContact(root: HTMLElement, name: string, phones: string) {
  await fireEvent.click(buttonContaining(root, "添加") as HTMLButtonElement);
  await fireEvent.input(inputByPlaceholder(root, "姓名") as HTMLInputElement, {
    target: { value: name },
  });
  await fireEvent.input(inputByPlaceholder(root, "电话号码（逗号/换行分隔）") as HTMLInputElement, {
    target: { value: phones },
  });
  await fireEvent.click(buttonContaining(root, "保存") as HTMLButtonElement);
}

describe("React ↔ Svelte contacts parity", () => {
  test("adding a contact shows the same name + number in both", async () => {
    clearStore();
    const react = mountReactContacts();
    await act(async () => {});
    await reactAddContact(react, "Alice", "13800000001");
    expect(txt(react)).toContain("Alice");
    expect(txt(react)).toContain("13800000001");

    clearStore();
    const svelte = render(ContactsApp);
    await svelteAddContact(svelte.container, "Alice", "13800000001");
    expect(txt(svelte.container)).toContain("Alice");
    expect(txt(svelte.container)).toContain("13800000001");
  });

  test("favoriting shows the star in both", async () => {
    clearStore();
    const react = mountReactContacts();
    await act(async () => {});
    await reactAddContact(react, "Alice", "13800000001");
    expect(txt(react)).not.toContain("★");
    await reactClick(react, buttonByTitle(react, "收藏"));
    expect(txt(react)).toContain("★");

    clearStore();
    const svelte = render(ContactsApp);
    await svelteAddContact(svelte.container, "Alice", "13800000001");
    expect(txt(svelte.container)).not.toContain("★");
    await fireEvent.click(buttonByTitle(svelte.container, "收藏") as HTMLButtonElement);
    expect(txt(svelte.container)).toContain("★");
  });
});
