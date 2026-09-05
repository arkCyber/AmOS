import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import CapabilityGate from "../components/CapabilityGate";
import { grantCap, loadLedger, saveLedger } from "../lib/permissions";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const buttons = () =>
  Array.from(host.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim());

beforeEach(() => {
  window.localStorage.setItem("amos-ui.locale", "en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
  window.localStorage.removeItem("amos.permissions");
  window.localStorage.removeItem("amos-ui.locale");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
});

/** Record which Tauri commands were invoked. */
const invoked: string[] = [];

/** Fake bridge: `perm_authorize` returns the given value; grant/revoke are no-ops. */
function installBridge(authorizeResult: boolean | null): void {
  invoked.length = 0;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      invoked.push(cmd);
      if (cmd === "perm_authorize") return authorizeResult;
      return null; // perm_grant / perm_revoke return unit → JSON null
    },
    listen: async () => async () => {},
  };
}

function renderGate(onAllowed?: () => void) {
  root.render(
    <I18nProvider>
      <CapabilityGate
        appId="camera"
        cap="camera"
        appLabel="Camera"
        capLabel="Camera"
        onAllowed={onAllowed}
      >
        <div id="secret">LIVE VIEWFINDER</div>
      </CapabilityGate>
    </I18nProvider>,
  );
}

describe("CapabilityGate (reusable permission gate)", () => {
  test("ungranted shows an ask overlay and hides children", async () => {
    window.localStorage.removeItem("amos.permissions");
    renderGate();
    await act(async () => {});
    expect(host.textContent!.toLowerCase()).toContain("allow");
    expect(host.querySelector("#secret")).toBeNull();
  });

  test("tapping Allow grants, persists, and reveals children", async () => {
    window.localStorage.removeItem("amos.permissions");
    renderGate();
    await act(async () => {});
    const allow = buttons().find((b) => b.toLowerCase().includes("allow"));
    expect(allow).toBeDefined();
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").toLowerCase().includes("allow"),
      )?.click();
    });
    await act(async () => {});
    expect(host.querySelector("#secret")).not.toBeNull();
    // Persisted: a fresh ledger read sees the grant.
    expect(loadLedger().camera).toContain("camera");
  });

  test("onAllowed fires right after Allow is tapped", async () => {
    window.localStorage.removeItem("amos.permissions");
    let fired = 0;
    renderGate(() => {
      fired += 1;
    });
    await act(async () => {});
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").toLowerCase().includes("allow"),
      )?.click();
    });
    expect(fired).toBe(1);
  });

  test("Deny refuses (children stay hidden, nothing persisted); Allow later still works", async () => {
    window.localStorage.removeItem("amos.permissions");
    renderGate();
    await act(async () => {});
    // Tap Deny → still gated, not granted.
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").toLowerCase().includes("deny"),
      )?.click();
    });
    expect(host.querySelector("#secret")).toBeNull();
    expect(loadLedger().camera ?? []).not.toContain("camera");
    // The denied hint is now shown.
    expect(host.textContent!.toLowerCase()).toContain("denied");
    // A later Allow reveals the children.
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").toLowerCase().includes("allow"),
      )?.click();
    });
    await act(async () => {});
    expect(host.querySelector("#secret")).not.toBeNull();
  });

  test("online: daemon 'denied' overrides a stale local grant; Allow submits perm_grant", async () => {
    // A *stale* local ledger claims camera is granted…
    saveLedger(grantCap({}, "camera", "camera"));
    // …but the daemon (authoritative) says it is not.
    installBridge(false);
    renderGate();
    await act(async () => {});
    await act(async () => {}); // let the async daemon probe resolve + commit
    // The probe reconciled with the daemon: the gate is denied despite the stale
    // local grant, and the OS permission store was asked (perm_authorize).
    expect(host.querySelector("#secret")).toBeNull();
    expect(host.textContent!.toLowerCase()).toContain("allow");
    expect(invoked).toContain("perm_authorize");

    // Tapping Allow submits the authoritative grant and reveals the children.
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").toLowerCase().includes("allow"),
      )?.click();
    });
    await act(async () => {});
    expect(host.querySelector("#secret")).not.toBeNull();
    expect(invoked).toContain("perm_grant");
  });
});
