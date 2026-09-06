/**
 * React ↔ Svelte dual-implementation parity tests for the NOTES screen.
 *
 * Both the React `Notes` (apps.tsx) and the Svelte `NotesApp` seed nothing and
 * persist amos.notes. Here we mount BOTH and assert that adding the same text
 * surfaces it identically (React uses a controlled textarea — typed via the
 * native value setter + input event).
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import NotesApp from "../src/svelte/NotesApp.svelte";
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
const clearStore = () => window.localStorage.clear();
const contains = (el: HTMLElement) => el.textContent ?? "";

function mountReactNotes() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "notes" }),
    ),
  );
  return host;
}

async function addReact(host: HTMLElement, text: string) {
  const ta = host.querySelector("textarea") as HTMLTextAreaElement | null;
  expect(ta, "react notes composer").toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(ta, text);
    ta!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "保存");
  await act(async () => {
    (save as HTMLButtonElement).click();
  });
}

async function addSvelte(container: HTMLElement, text: string) {
  const ta = container.querySelector('textarea[aria-label="note-compose"]') as HTMLTextAreaElement;
  await fireEvent.input(ta, { target: { value: text } });
  const save = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "保存");
  await fireEvent.click(save as HTMLButtonElement);
}

describe("React ↔ Svelte notes parity", () => {
  test("adding the same text surfaces it in both", async () => {
    clearStore();
    const react = mountReactNotes();
    await act(async () => {});
    const body = "待办：\n- 买牛奶\n- 写周报" + Math.floor(Math.random() * 1e5);
    await addReact(react, body);
    expect(contains(react)).toContain("买牛奶");

    clearStore();
    const svelte = render(NotesApp);
    await addSvelte(svelte.container, body);
    expect(contains(svelte.container)).toContain("买牛奶");
  });
});
