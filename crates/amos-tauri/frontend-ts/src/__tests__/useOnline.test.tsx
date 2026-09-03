import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useOnline } from "../lib/useOnline";

// Bring up a real DOM for this file (globals are per-process in bun).
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
});

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Probe() {
    const online = useOnline();
    return <span>{online ? "ON" : "OFF"}</span>;
  }
  root.render(<Probe />);
  mounted.push({ root, host });
  return host;
}

describe("useOnline", () => {
  test("tracks live online/offline transitions after mount", async () => {
    const host = mount();
    await act(async () => {});
    expect(host.textContent).toBe("ON"); // default: assume online

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(host.textContent).toBe("OFF");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(host.textContent).toBe("ON");
  });
});
