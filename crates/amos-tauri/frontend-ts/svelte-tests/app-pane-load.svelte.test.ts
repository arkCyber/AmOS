/**
 * app-pane-load.svelte.test.ts — the app host's **three** load states, not two.
 *
 * `AppPane.svelte` (the touch shell's app surface and each half of a tablet split) and
 * `DesktopAppWindow.svelte` (the desktop shell's app window) both mount an app by id from
 * `svelteAppLoader`. Both used to model that as **two** states — `AppComp` set, or `AppComp`
 * null — and read the second as "this build has no screen for this app". A cold load takes a
 * dynamic `import()`, so for the whole ~200-500 ms of every first open the pane asserted
 * `app.screenMissing` («内置应用「notes」在此构建中没有可显示的界面。») about an app whose screen was
 * merely *not fetched yet* — and a user who switched apps quickly read that sentence on every
 * app they touched.
 *
 * `AppPane` had a second half the desktop twin did not: its effect never cleared `AppComp` when
 * the `id` prop changed (the twin has cleared it since it was written — the divergence is the
 * tell). Opening Notes and then picking Clock from Recents left **Notes' own screen** — with the
 * user's private note content on it — rendered under a 「时钟」 header until Clock's chunk landed.
 *
 * These tests drive the loader through a deferred they own, so all three states are pinned
 * deterministically instead of by waiting on real chunk loads. Red-first: "a cold load is not
 * 'no screen'" and "changing the app drops the previous screen" both fail on the two-state
 * shape; the "an id with no loader at all says 未知应用" control stays green in both directions
 * (it is the case the old code got *right*, and the fix must not turn it into a spinner).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import AppPane from "../src/svelte/AppPane.svelte";
import DesktopAppWindow from "../src/svelte/DesktopAppWindow.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The loader table this suite controls. `ctl.loaders` has an entry **iff** the mock should
// report that a loader exists for the id — `undefined` is the "no screen in this build" fact,
// which is exactly what `svelteAppLoader` answers for a phone-only app on desktop.
const ctl = vi.hoisted(() => ({
  loaders: new Map<string, () => Promise<Record<string, unknown>>>(),
  // The real resolver, captured once, so a test can resolve a deferred with a *real* app module
  // (a mountable `default`) rather than a stub the component would choke on.
  real: null as null | ((id: string) => (() => Promise<unknown>) | undefined),
}));

vi.mock("../src/svelte/appRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/svelte/appRegistry")>();
  ctl.real = actual.svelteAppLoader;
  return { ...actual, svelteAppLoader: (id: string) => ctl.loaders.get(id) };
});

/** Point `id` at a deferred the test resolves/rejects by hand. */
function controllable(id: string): Deferred<Record<string, unknown>> {
  const d = deferred<Record<string, unknown>>();
  ctl.loaders.set(id, () => d.promise);
  return d;
}

/** Resolve `d` with the **real** screen module for `id`, so `<AppComp />` really mounts. */
async function resolveWithRealScreen(id: string, d: Deferred<Record<string, unknown>>) {
  const load = ctl.real!(id)!;
  d.resolve((await load()) as Record<string, unknown>);
}

/** The localized sentence for a key, in whichever locale the screen is running (zh default). */
const copy = (key: string) => new Set([zh[key], en[key]]);
const screenMissing = (id: string) => new Set([zh["app.screenMissing"].replace("{id}", id), en["app.screenMissing"].replace("{id}", id)]);
const unknownApp = (id: string) => new Set([zh["app.unknown"].replace("{id}", id), en["app.unknown"].replace("{id}", id)]);

const q = (host: { container: HTMLElement }, testid: string) =>
  host.container.querySelector(`[data-testid="${testid}"]`);
const text = (host: { container: HTMLElement }) => host.container.textContent ?? "";
const mentions = (host: { container: HTMLElement }, sentence: Set<string>) =>
  [...sentence].some((s) => text(host).includes(s));

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    listen: async () => () => {},
  };
}

afterEach(() => {
  cleanup();
  ctl.loaders.clear();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("AppPane — a screen still being fetched is not a screen that is missing", () => {
  test("a cold load says it is loading, not 'no screen in this build'", async () => {
    controllable("notes"); // never settles
    const host = render(AppPane, { props: { id: "notes", form: "tablet", onback: () => {} } });
    await tick();
    expect(q(host, "app-loading"), "the pane owns a loading state at all").not.toBeNull();
    expect(q(host, "app-unavailable")).toBeNull();
    expect(text(host)).not.toContain(zh["app.screenMissing"].replace("{id}", "notes"));
    expect([...copy("app.loading")].some((s) => text(host).includes(s))).toBe(true);
  });

  test("a loader that settles mounts the screen and retires the loading state", async () => {
    const d = controllable("notes");
    const host = render(AppPane, { props: { id: "notes", form: "tablet", onback: () => {} } });
    await tick();
    expect(q(host, "app-loading")).not.toBeNull();
    await resolveWithRealScreen("notes", d);
    await waitFor(() => expect(q(host, "note-compose")).not.toBeNull());
    expect(q(host, "app-loading")).toBeNull();
    expect(q(host, "app-unavailable")).toBeNull();
  });

  test("a rejected import is not a spinner forever — it settles as 'no screen'", async () => {
    const d = controllable("notes");
    const host = render(AppPane, { props: { id: "notes", form: "tablet", onback: () => {} } });
    await tick();
    d.reject(new Error("chunk 404"));
    await waitFor(() => expect(q(host, "app-unavailable")).not.toBeNull());
    expect(q(host, "app-loading")).toBeNull();
    expect(mentions(host, screenMissing("notes"))).toBe(true);
  });

  test("changing the app does not leave the previous app's screen under the new title", async () => {
    const dNotes = controllable("notes");
    const dClock = controllable("clock");
    const { container, rerender } = render(AppPane, {
      props: { id: "notes", form: "tablet", onback: () => {} },
    });
    await resolveWithRealScreen("notes", dNotes);
    await waitFor(() => expect(container.querySelector('[data-testid="note-compose"]')).not.toBeNull());

    await rerender({ id: "clock", form: "tablet", onback: () => {} });
    await tick();
    // Notes' screen — and the private content on it — must be gone for the whole of Clock's load.
    expect(container.querySelector('[data-testid="note-compose"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-loading"]')).not.toBeNull();

    await resolveWithRealScreen("clock", dClock);
    await waitFor(() => expect(container.querySelector('[data-testid="clock-tabs"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="note-compose"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-loading"]')).toBeNull();
  });

  test("a module with no default export is 'no screen', not a spinner that never ends", async () => {
    const d = controllable("notes");
    const host = render(AppPane, { props: { id: "notes", form: "tablet", onback: () => {} } });
    await tick();
    d.resolve({}); // settled, but carries no screen
    await waitFor(() => expect(q(host, "app-unavailable")).not.toBeNull());
    expect(q(host, "app-loading")).toBeNull();
  });

  test("a settled 'no screen' does not outlive the app it described", async () => {
    // Open a link to an unknown app (terminal state), then open a real app in the same pane:
    // the terminal verdict must not survive into the next app's load, or the pane would call
    // Notes screen-less because a *previous* id had none.
    const { container, rerender } = render(AppPane, {
      props: { id: "nope-not-an-app", form: "tablet", onback: () => {} },
    });
    await waitFor(() => expect(container.querySelector('[data-testid="app-unavailable"]')).not.toBeNull());
    const d = controllable("notes");
    await rerender({ id: "notes", form: "tablet", onback: () => {} });
    await tick();
    expect(container.querySelector('[data-testid="app-unavailable"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-loading"]')).not.toBeNull();
    await resolveWithRealScreen("notes", d);
    await waitFor(() => expect(container.querySelector('[data-testid="note-compose"]')).not.toBeNull());
  });

  test("control: an id with no loader at all says 未知应用 — never a loading state", async () => {
    const host = render(AppPane, {
      props: { id: "nope-not-an-app", form: "tablet", onback: () => {} },
    });
    await tick();
    expect(q(host, "app-unavailable")).not.toBeNull();
    expect(q(host, "app-loading")).toBeNull();
    expect(mentions(host, unknownApp("nope-not-an-app"))).toBe(true);
  });
});

describe("DesktopAppWindow — the same three states in the desktop twin", () => {
  test("a cold load says it is loading, not 'no screen in this build'", async () => {
    installHost();
    controllable("notes");
    const host = render(DesktopAppWindow, { props: { id: "notes" } });
    await tick();
    expect(q(host, "app-loading")).not.toBeNull();
    expect(text(host)).not.toContain(zh["app.screenMissing"].replace("{id}", "notes"));
  });

  test("a loader that settles mounts the screen in the window", async () => {
    installHost();
    const d = controllable("notes");
    const host = render(DesktopAppWindow, { props: { id: "notes" } });
    await tick();
    expect(q(host, "app-loading")).not.toBeNull();
    await resolveWithRealScreen("notes", d);
    await waitFor(() => expect(q(host, "note-compose")).not.toBeNull());
    expect(q(host, "app-loading")).toBeNull();
  });

  test("control: an id with no loader at all still says there is no screen", async () => {
    installHost();
    const host = render(DesktopAppWindow, { props: { id: "nope-not-an-app" } });
    await tick();
    expect(q(host, "app-unavailable")).not.toBeNull();
    expect(q(host, "app-loading")).toBeNull();
    expect(mentions(host, unknownApp("nope-not-an-app"))).toBe(true);
  });
});
