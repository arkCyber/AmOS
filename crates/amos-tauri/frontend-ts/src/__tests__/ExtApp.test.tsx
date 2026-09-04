import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import ExtApp from "../components/ExtApp";
import type { AppManifest } from "../lib/backend";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest: AppManifest = {
  id: "org.amos.web",
  name: "BundleWeb",
  summary: "demo",
  author: "Amos Labs",
  version: { major: 1, minor: 0, patch: 0, pre: null },
  category: "tools",
  package: { format: "tar_gz", url: "https://x/b.tgz", sha256: null, size_bytes: null },
  publisher: null,
};

/** Fake Tauri bridge: bundle map = resource-path → base64 (empty = manifest-only). */
function installBridge(bundle: Record<string, string>): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "appstore_find") return manifest;
      if (cmd === "appstore_bundle_resource") {
        const p = String(args.path);
        const b = bundle[p];
        return b === undefined
          ? null
          : {
              mime: p.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript",
              nosniff: true,
              base64: b,
            };
      }
      return null;
    },
    listen: async () => async () => {},
  };
}

const INDEX = btoa('<!doctype html><title>T</title><h1 id="m">hi-from-bundle</h1>');

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(id: string): Promise<{ root: Root }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <ExtApp id={id} />
      </I18nProvider>,
    );
  });
  // Several microtask/flush rounds so the async load (find → entry → assets) settles.
  for (let i = 0; i < 6; i++) await flush();
  return { root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ExtApp (third-party web-bundle runtime host)", () => {
  test("runs an installed web-bundle in a sandboxed srcdoc iframe", async () => {
    installBridge({ "index.html": INDEX });
    const { root } = await mount("store:org.amos.web");
    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    // No same-origin: the third-party page can't reach the OS shell.
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    const doc = iframe?.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("hi-from-bundle");
    await act(async () => root.unmount());
  });

  test("falls back to the verified-manifest card when the app has no web bundle", async () => {
    installBridge({});
    const { root } = await mount("store:org.amos.only");
    expect(document.querySelector("iframe")).toBeNull();
    const text = document.body.textContent ?? "";
    // Language-neutral marker present in both en ("…web interface…") and zh ("…web 界面…").
    expect(text).toContain("web");
    await act(async () => root.unmount());
  });

  test("degrades gracefully (manifest card, no iframe) when the bridge call fails", async () => {
    // The Tauri bridge wrapper swallows invoke rejections into null, so a failed
    // lookup must not crash or half-render — it falls back to the manifest card.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async () => {
        throw new Error("boom");
      },
      listen: async () => async () => {},
    };
    const { root } = await mount("store:org.amos.broken");
    expect(document.querySelector("iframe")).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).toContain("web"); // fallback manifest card, not a blank/crash
    await act(async () => root.unmount());
  });
});
