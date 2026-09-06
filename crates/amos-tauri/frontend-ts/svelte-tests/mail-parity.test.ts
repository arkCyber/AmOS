/**
 * React ↔ Svelte dual-implementation parity tests for the MAIL screen.
 *
 * Both MailApps talk to the amos-mail daemon purely through lib/backend.ts, so
 * under the same fake __TAURI_INTERNALS__ bridge they must render the same
 * INBOX rows, and offline (no bridge) both show the same localized banner.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import MailAppSvelte from "../src/svelte/MailApp.svelte";
import MailAppReact from "../src/components/MailApp";
import { I18nProvider } from "../src/i18n";
import type { MailSummary } from "../src/lib/backend";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedReact: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mountedReact.length) {
    const m = mountedReact.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

function mountReactMail() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MailAppReact as React.FC),
    ),
  );
  return host;
}
const txt = (root: HTMLElement) => root.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 50));

function seedRows(): MailSummary[] {
  return [
    {
      id: "m1",
      mailbox: "INBOX",
      from: { name: "Ada", email: "ada@x.io" },
      to: [],
      subject: "Design review",
      date: 1_700_000_000,
      flags: { seen: false, flagged: false, answered: false },
      attachment_count: 0,
    },
    {
      id: "m2",
      mailbox: "INBOX",
      from: { name: "Grace", email: "grace@x.io" },
      to: [],
      subject: "Build report",
      date: 1_700_010_000,
      flags: { seen: false, flagged: false, answered: false },
      attachment_count: 1,
    },
  ];
}
function installBridge(rows: MailSummary[]) {
  const invoke = async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "mail_mailboxes") return ["INBOX", "Sent"];
    if (cmd === "mail_list") return rows;
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

describe("React ↔ Svelte mail parity", () => {
  test("bridged INBOX shows the same subject rows in both", async () => {
    installBridge(seedRows());
    const react = mountReactMail();
    await act(async () => {});
    await settle();
    await act(async () => {});
    expect(txt(react)).toContain("Design review");
    expect(txt(react)).toContain("Build report");

    window.localStorage.clear();
    installBridge(seedRows());
    const svelte = render(MailAppSvelte);
    await settle();
    await settle();
    expect(txt(svelte.container)).toContain("Design review");
    expect(txt(svelte.container)).toContain("Build report");
  });

  test("offline shows the same banner in both", async () => {
    const react = mountReactMail();
    await act(async () => {});
    await settle();
    expect(txt(react)).toContain("未连接邮件服务");

    window.localStorage.clear();
    const svelte = render(MailAppSvelte);
    await settle();
    expect(txt(svelte.container)).toContain("未连接邮件服务");
  });
});
