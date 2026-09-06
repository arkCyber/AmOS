/**
 * React ↔ Svelte dual-implementation parity tests for the MESSAGES screen.
 *
 * Both the React `MessagesApp` (CommsApps.tsx) and the Svelte `MessagesApp`
 * seed from lib/messages.ts and persist amos.messages. Here we mount BOTH and
 * assert that sending the same text surfaces it identically (React uses a
 * controlled input — typed via the native value setter + input event).
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import MessagesApp from "../src/svelte/MessagesApp.svelte";
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

function mountReactMessages() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "messages" }),
    ),
  );
  return host;
}
const contains = (el: HTMLElement) => el.textContent ?? "";

async function sendReact(host: HTMLElement, msg: string) {
  const input = [...host.querySelectorAll("input")].find((i) =>
    (i.getAttribute("placeholder") ?? "").startsWith("发给"),
  );
  expect(input, "react messages input").toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, msg);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const sendBtn = [...host.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("➤"),
  );
  await act(async () => {
    (sendBtn as HTMLButtonElement).click();
  });
}

async function sendSvelte(container: HTMLElement, msg: string) {
  const input = container.querySelector('input[aria-label="message-input"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  await fireEvent.input(input, { target: { value: msg } });
  const sendBtn = [...container.querySelectorAll("button")].find((b) =>
    (b.getAttribute("aria-label")) === "send",
  );
  await fireEvent.click(sendBtn as HTMLButtonElement);
}

describe("React ↔ Svelte messages parity", () => {
  test("sending the same text surfaces it in both", async () => {
    clearStore();
    const react = mountReactMessages();
    await act(async () => {});
    expect(contains(react)).toContain("小安");
    const msg = "你好Amos" + Math.floor(Math.random() * 1e6);
    await sendReact(react, msg);
    expect(contains(react)).toContain(msg);

    clearStore();
    const svelte = render(MessagesApp);
    expect(contains(svelte.container)).toContain("小安");
    await sendSvelte(svelte.container, msg);
    expect(contains(svelte.container)).toContain(msg);
  });
});
