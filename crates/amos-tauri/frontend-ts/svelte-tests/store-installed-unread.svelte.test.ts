/**
 * StoreApp.svelte — the "installed" read can fail without the catalog failing.
 *
 * `appstore_installed` is its own command (crates/amos-tauri/src/appstore.rs), and
 * `StoreBridge::installed()` answers `Err(StoreError::Provider("registry poisoned"))`
 * when the installed-registry Mutex is poisoned (crates/amos-appstore/src/client.rs).
 * `invoke` never rejects — it resolves `null` on a refusal/unanswered command
 * (REQ-A296) — so a failed read arrives as `installed === null`, NOT as `[]`.
 *
 * Folding that `null` into an empty list produces two false claims about the user's
 * device: 「我的应用：0」 in the footer and a 「获取」 button on every row (including
 * apps the user already has). The same file already refuses the identical fold for
 * the catalog (`{:else if catalog === null}` → 「…」, distinct from `length === 0` →
 * 「目录为空」).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import StoreApp from "../src/svelte/StoreApp.svelte";
import type { AppManifest, AppVersion, InstalledApp } from "../src/lib/backend";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonsNamed = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label);
const settle = () => new Promise((r) => setTimeout(r, 40));

function mk(id: string, name: string, major: number, minor: number, patch: number): AppManifest {
  const version: AppVersion = { major, minor, patch, pre: null };
  return {
    id,
    name,
    summary: `${name} summary`,
    author: "Acme",
    version,
    category: "tools",
    package: { format: "zip", url: `https://x/${id}.zip`, sha256: null, size_bytes: null },
  };
}

/** `installedReply` is called per read so a retry can land a different answer. */
function installBridge(catalog: AppManifest[], installedReply: () => InstalledApp[] | null) {
  const invoke = async (cmd: string) => {
    if (cmd === "appstore_catalog") return catalog;
    if (cmd === "appstore_installed") return installedReply();
    if (cmd === "appstore_updatable") return null; // this host cannot answer → local fallback
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

describe("StoreApp.svelte — an unread installed list is not an empty one (REQ-A1455)", () => {
  /** Catalog answers; installed does not (`null`). The list view, not the 「…」 branch. */
  async function unreadHost() {
    const a = mk("alpha", "Alpha App", 1, 0, 0);
    const b = mk("beta", "Beta App", 2, 0, 0);
    installBridge([a, b], () => null);
    const host = render(StoreApp);
    await settle();
    await settle();
    expect(txt(host)).toContain("Alpha App");
    return host;
  }

  test("no 获取 is offered while the installed list is unread", async () => {
    const host = await unreadHost();
    expect(buttonsNamed(host, "获取")).toHaveLength(0);
  });

  test("the footer says the count is unknown, not 0", async () => {
    const host = await unreadHost();
    const myApps = host.container.querySelector("[data-testid='store-my-apps']");
    expect(myApps?.textContent ?? "").toContain("—");
    expect(myApps?.textContent ?? "").not.toContain("0");
  });

  test("it says why the install state is missing", async () => {
    const host = await unreadHost();
    expect(host.container.querySelector("[data-testid='store-installed-unread']")).not.toBeNull();
  });

  test("an answered, empty list IS zero installed (control)", async () => {
    const a = mk("alpha", "Alpha App", 1, 0, 0);
    installBridge([a], () => []);
    const host = render(StoreApp);
    await settle();
    await settle();
    expect(host.container.querySelector("[data-testid='store-installed-unread']")).toBeNull();
    expect(buttonsNamed(host, "获取")).toHaveLength(1);
    const myApps = host.container.querySelector("[data-testid='store-my-apps']");
    expect(myApps?.textContent ?? "").toContain("0");
  });

  test("retry re-reads and clears the notice once the host answers", async () => {
    const a = mk("alpha", "Alpha App", 1, 0, 0);
    let reply: InstalledApp[] | null = null;
    installBridge([a], () => reply);
    const host = render(StoreApp);
    await settle();
    await settle();
    const retry = host.container.querySelector<HTMLButtonElement>("[data-testid='store-installed-retry']");
    expect(retry).not.toBeNull();
    reply = [{ manifest: a, installed_at: 1_700_000_000 }];
    retry!.click();
    await settle();
    await settle();
    expect(host.container.querySelector("[data-testid='store-installed-unread']")).toBeNull();
    expect(txt(host)).toContain("已安装"); // alpha is known installed now
    expect(buttonsNamed(host, "获取")).toHaveLength(0);
  });

  test("a normal answer still counts and marks installed rows (control)", async () => {
    const a = mk("alpha", "Alpha App", 1, 0, 0);
    const b = mk("beta", "Beta App", 2, 0, 0);
    installBridge([a, b], () => [{ manifest: a, installed_at: 1_700_000_000 }]);
    const host = render(StoreApp);
    await settle();
    await settle();
    expect(txt(host)).toContain("已安装");
    expect(buttonsNamed(host, "获取")).toHaveLength(1); // beta only
    const myApps = host.container.querySelector("[data-testid='store-my-apps']");
    expect(myApps?.textContent ?? "").toContain("1");
  });
});
