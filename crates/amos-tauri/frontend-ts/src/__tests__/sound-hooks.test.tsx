import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAlertPolicy } from "../lib/sound";
import { useNotificationAlert } from "../lib/useNotificationAlert";
import { writeStoreValue } from "../lib/amosStore";
import { NOTIF_KEY, SETTINGS_KEY } from "../lib/settings";

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

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(node);
  mounted.push({ root, host });
  return host;
}

function PolicyProbe() {
  const { policy, dnd, effective } = useAlertPolicy();
  return <span>{JSON.stringify({ policy, dnd, effective })}</span>;
}
function AlertProbe() {
  useNotificationAlert();
  return null;
}

describe("sound / alert hooks", () => {
  test("useAlertPolicy reflects persisted bits and DND muting", async () => {
    window.localStorage.clear();
    const host = mount(<PolicyProbe />);
    await act(async () => {});
    const read = () => JSON.parse(host.textContent ?? "{}") as {
      policy: { ring: boolean; vibrate: boolean };
      dnd: boolean;
      effective: { ring: boolean; vibrate: boolean };
    };

    expect(read()).toEqual({
      policy: { ring: true, vibrate: true },
      dnd: false,
      effective: { ring: true, vibrate: true },
    });

    // ring off, vibrate on
    await act(async () => {
      writeStoreValue("amos.sound", { ring: false, vibrate: true });
    });
    expect(read().policy).toEqual({ ring: false, vibrate: true });

    // DND on → effective mutes both
    await act(async () => {
      writeStoreValue(SETTINGS_KEY, { dnd: true });
    });
    const after = read();
    expect(after.dnd).toBe(true);
    expect(after.effective).toEqual({ ring: false, vibrate: false });
  });

  test("useNotificationAlert vibrates on arrival only when allowed (DND silences)", async () => {
    window.localStorage.clear();
    let vibrateCalls = 0;
    Object.defineProperty(window.navigator, "vibrate", {
      configurable: true,
      value: () => {
        vibrateCalls += 1;
        return true;
      },
    });

    mount(<AlertProbe />);
    await act(async () => {});
    expect(vibrateCalls).toBe(0); // mount with no notifications

    // A notification arrives, policy default allows vibration → 1 pulse.
    await act(async () => {
      writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "邮件", time: 1 }]);
    });
    expect(vibrateCalls).toBe(1);

    // Turn DND on, then another notification arrives → suppressed.
    await act(async () => {
      writeStoreValue(SETTINGS_KEY, { dnd: true });
      writeStoreValue(NOTIF_KEY, [
        { id: "n1", app: "邮件", time: 1 },
        { id: "n2", app: "邮件", time: 2 },
      ]);
    });
    expect(vibrateCalls).toBe(1); // unchanged under DND
  });
});
