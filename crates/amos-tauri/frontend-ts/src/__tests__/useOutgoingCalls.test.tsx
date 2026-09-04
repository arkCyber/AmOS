import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useOutgoingCalls } from "../lib/useOutgoingCalls";
import { writeStoreValue, readStoreValue } from "../lib/amosStore";
import { CONTACTS_KEY, makeContactId, type Contact } from "../lib/contacts";
import { CALLLOG_KEY } from "../lib/calllog";
import { NOTIF_KEY } from "../lib/settings";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
let api: ReturnType<typeof useOutgoingCalls> | null = null;
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.clear();
  api = null;
});

function adaContact(): Contact {
  return { id: makeContactId(), name: "Ada", phones: ["+86 138 0000 0001"], fav: false, ts: 1 };
}

function mount(contacts: Contact[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Probe({ list }: { list: Contact[] }) {
    const h = useOutgoingCalls(list);
    api = h;
    return (
      <span>
        {JSON.stringify({ r: h.recents.map((x) => x.label), f: h.frequent.map((x) => x.label) })}
      </span>
    );
  }
  root.render(<Probe list={contacts} />);
  mounted.push({ root, host });
  return host;
}

describe("useOutgoingCalls (shared quick-dial hook)", () => {
  test("derives name-resolved Recent/Frequent from the call log", async () => {
    const ada = adaContact();
    writeStoreValue(CONTACTS_KEY, [ada]);
    writeStoreValue(CALLLOG_KEY, [
      { number: "+86 138 0000 0001", name: "Ada", ts: 1 },
      { number: "+86 138 0000 0001", name: "Ada", ts: 2 },
      { number: "+86 138 0000 0001", name: "Ada", ts: 3 },
      { number: "999", ts: 4 },
    ]);
    const host = mount([ada]);
    await act(async () => {});
    const parsed = JSON.parse(host.textContent ?? "{}") as { r: string[]; f: string[] };
    expect(parsed.r).toContain("Ada"); // name resolved, not raw number
    expect(parsed.f).toContain("Ada");
    expect(api?.recents.some((x) => x.num === "+86 138 0000 0001")).toBe(true);
  });

  test("recordOutgoing writes the call log and raises a phone notification", async () => {
    writeStoreValue(CONTACTS_KEY, [adaContact()]);
    mount([adaContact()]);
    await act(async () => {});
    const out = api!;
    await act(async () => {
      out.recordOutgoing("999", "Zed", "Call placed");
    });
    await act(async () => {});
    const log = readStoreValue<{ number: string; name?: string }[]>(CALLLOG_KEY, []);
    expect(log[0]?.number).toBe("999");
    expect(log[0]?.name).toBe("Zed");
    const notifs = readStoreValue<{ title: string; app?: string }[]>(NOTIF_KEY, []);
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs[0]?.title).toBe("Zed");
  });
});
