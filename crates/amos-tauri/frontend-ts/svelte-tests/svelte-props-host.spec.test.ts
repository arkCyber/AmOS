/**
 * SveltePropsHost — React host tests (vitest).
 *
 * Locks the R2 contract at the REACT level (not just the pure propsBus unit):
 *   • the host seeds the channel and mounts the Svelte screen;
 *   • RE-RENDERING the host with new `props` updates the mounted screen IN PLACE
 *     (same host instance — no remount) — the core reason propsBus exists;
 *   • one-shot actions the screen emits are forwarded to `onEvent`.
 *
 * React is mounted via createRoot (vitest has no React plugin); the Svelte
 * fixture (PropsSink.svelte) is a minimal controlled screen over channel "sink".
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SveltePropsHost from "../src/components/SveltePropsHost";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const loadSink = () => import("./fixtures/PropsSink.svelte");

const mountedReact: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mountedReact.length) {
    const m = mountedReact.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  resetPropsChannels();
});

function mountHost(props: Record<string, unknown>, onEvent: (e: string, d: unknown) => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (p: Record<string, unknown>) => {
    root.render(
      React.createElement(SveltePropsHost, {
        name: "sink",
        load: loadSink,
        props: p,
        onEvent,
      }),
    );
    await act(async () => {});
  };
  mountedReact.push({ root, host });
  return { host, render };
}

const sinkText = (container: HTMLElement) =>
  container.querySelector('[data-testid="sink"]')?.textContent ?? "";

// The Svelte screen is mounted via a dynamic import inside the React host's
// effect; the FIRST import triggers an async transform, so poll until it lands.
async function waitSinkText(container: HTMLElement): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const t = sinkText(container);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 0));
  }
  return sinkText(container);
}

describe("SveltePropsHost (React ⇄ Svelte controlled screen)", () => {
  test("mounts the screen with the initial props from the channel", async () => {
    const { host, render } = mountHost({ a: 1 }, () => {});
    await render({ a: 1 });
    expect(await waitSinkText(host)).toContain('"a":1');
  });

  test("re-rendering with new props updates the screen IN PLACE (no remount)", async () => {
    const { host, render } = mountHost({ a: 1 }, () => {});
    await render({ a: 1 });
    expect(await waitSinkText(host)).toContain('"a":1');

    // Push new props through the same host instance — the mounted Svelte screen
    // must update without being recreated.
    await render({ a: 1, b: 2 });
    expect(await waitSinkText(host)).toContain('"b":2');
    expect(await waitSinkText(host)).toContain('"a":1');
  });

  test("forwards one-shot actions emitted by the Svelte screen to onEvent", async () => {
    const events: [string, unknown][] = [];
    const { host, render } = mountHost({}, (e, d) => events.push([e, d]));
    await render({});

    const ping = host.querySelector('button[aria-label="ping"]') as HTMLButtonElement;
    expect(ping).toBeTruthy();
    await act(async () => {
      ping.click();
    });
    expect(events).toEqual([["ping", "pong"]]);
  });

  test("external prop readers see the live value through the shared channel", async () => {
    // A non-React observer (e.g. a future controlled screen or glue) reading the
    // channel stays in sync with what the host owns.
    const seen: unknown[] = [];
    propsChannel("sink").subscribe((v) => seen.push(v));
    const { render } = mountHost({ x: 10 }, () => {});
    await render({ x: 10 });
    await render({ x: 20 });
    expect(seen).toContainEqual({ x: 20 });
  });
});
