/**
 * AboutPage.svelte — a fresh check must retract the previous install verdict.
 *
 * The 「下载并校验」 block renders whatever the **last** install returned, and nothing ever
 * cleared it: `installResult` was written by `installUpdate` and read forever after. So a
 * user who staged 1.1.0 and then pressed 「检查更新」 (or checked again after the source
 * changed) kept reading 「已下载并校验完成」 underneath a headline saying something else —
 * a rendered claim about *now* that the current check does not support. The verdict belongs
 * to the offer it was taken against, and a new decision supersedes that offer (REQ-A1454).
 *
 * The discriminating pair: after a second check that finds nothing, the install block is
 * gone; and a check that still offers an update leaves the block gone too until an install
 * is actually run again (it is retracted at the *check*, not re-derived from the payload).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AboutPage from "../src/svelte/settings/AboutPage.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = () => new Promise((r) => setTimeout(r, 40));
const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

const ELIGIBLE = {
  kind: "eligible",
  current_version: "0.1.0",
  channel: "stable",
  version: "1.1.0",
  package_uri: "https://example.invalid/os.img",
  package_bytes: 10,
  reason_code: null,
  detail: null,
};

/** A bridge whose `ota_check` answer and install signature verdict the test can swap. */
function installBridge(
  signature: { verdict: string; key_id: string | null; verified_by?: string | null } | null = null,
) {
  let kind = ELIGIBLE;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "system_health") return { battery_level_pct: 75, battery_charging: false };
      if (cmd === "ota_status") {
        return { current_version: "0.1.0", channel: "stable", configured: true, source: "/tmp/m.json" };
      }
      if (cmd === "ota_check") return kind;
      if (cmd === "ota_install") {
        return { state: "staged", version: "1.1.0", fail_reason: null, detail: null, signature };
      }
      return null;
    },
    listen: async () => () => {},
  };
  return { setCheck: (k: typeof ELIGIBLE) => (kind = k) };
}

describe("AboutPage.svelte — a new check retracts the old install verdict (REQ-A1454)", () => {
  test("after staging, a check that finds nothing drops the install block", async () => {
    const bridge = installBridge();
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();

    // Offer 1.1.0 → install it → the staged sentence is on screen.
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    await fireEvent.click(byTest(container, "update-install") as HTMLButtonElement);
    await tick();
    await settle();
    expect(byTest(container, "update-install-outcome")?.textContent ?? "").toContain(
      zh["settings.updateInstall_staged"],
    );

    // The source now reports there is nothing to install.
    bridge.setCheck({ ...ELIGIBLE, kind: "up_to_date", version: null });
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();

    expect(byTest(container, "update-outcome")?.textContent ?? "").toContain(
      zh["settings.updateOutcome_uptodate"],
    );
    // …so 「已下载并校验完成」 may not still be standing beside it.
    expect(byTest(container, "update-install-outcome")).toBeNull();
    expect(container.textContent ?? "").not.toContain(zh["settings.updateInstall_staged"]);
  });

  test("a still-offering check does not inherit the earlier verdict either", async () => {
    const bridge = installBridge();
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();

    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    await fireEvent.click(byTest(container, "update-install") as HTMLButtonElement);
    await tick();
    await settle();
    expect(byTest(container, "update-install-outcome")).not.toBeNull();

    // Keep offering the update — the old verdict is still about the *previous* offer.
    bridge.setCheck(ELIGIBLE);
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    expect(byTest(container, "update-install-outcome")).toBeNull();
  });

  test("an untrusted signer is disclosed beside the staged sentence", async () => {
    // `staged` is gated on the integrity verdict alone, so the 「已下载并校验完成」 line
    // is true and incomplete at once: the bytes matched the digest, but nobody
    // established *who* signed them. The host reports the verdict; the screen must say
    // it (REQ-A1454).
    // `verified_by: "ed25519"` on purpose — a *real* cryptographic refusal is the
    // strongest case, and the untrusted arm must not depend on the mode.
    installBridge({ verdict: "untrusted", key_id: "release", verified_by: "ed25519" });
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    await fireEvent.click(byTest(container, "update-install") as HTMLButtonElement);
    await tick();
    await settle();

    expect(byTest(container, "update-install-outcome")?.textContent ?? "").toContain(
      zh["settings.updateInstall_staged"],
    );
    const line = byTest(container, "update-install-signature");
    expect(line?.textContent ?? "").toContain("release");
    expect(line?.textContent ?? "").toContain(
      zh["settings.updateInstallSignatureUntrusted"].split("{key}")[0].trim(),
    );
  });

  test("a `trusted` verdict from the policy-only verifier is disclosed, not silently accepted", async () => {
    // The whole point of the mode split: the host is configured with key *ids*
    // only, so `trusted` means "that id is on the list" — a forged signature
    // claiming it reads the same. Rendering that identically to a verdict backed
    // by Ed25519 would assert an authenticity nobody checked, so the screen says
    // which one it was.
    installBridge({ verdict: "trusted", key_id: "release", verified_by: "policy" });
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    await fireEvent.click(byTest(container, "update-install") as HTMLButtonElement);
    await tick();
    await settle();

    expect(byTest(container, "update-install-outcome")?.textContent ?? "").toContain(
      zh["settings.updateInstall_staged"],
    );
    const line = byTest(container, "update-install-signature");
    expect(line?.textContent ?? "").toContain("release");
    expect(line?.textContent ?? "").toContain(
      zh["settings.updateInstallSignaturePolicyOnly"].split("{key}")[0].trim(),
    );
  });

  test("a `trusted` verdict with no strength field is read as the weak mode (old host)", async () => {
    // A `verified_by` the page does not recognise (here: absent, as a host too old
    // to send it would) must not be read as "cryptographically verified". An
    // unknown strength is the weak one, never the strong one.
    installBridge({ verdict: "trusted", key_id: "release" });
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    await fireEvent.click(byTest(container, "update-install") as HTMLButtonElement);
    await tick();
    await settle();

    expect(byTest(container, "update-install-signature")).not.toBeNull();
  });

  test("a trusted signer verified over Ed25519 adds no warning line (control)", async () => {
    // The only configuration that earns a silent line: the signature was actually
    // checked against a registered public key.
    installBridge({ verdict: "trusted", key_id: "release", verified_by: "ed25519" });
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();
    await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
    await tick();
    await settle();
    await fireEvent.click(byTest(container, "update-install") as HTMLButtonElement);
    await tick();
    await settle();

    expect(byTest(container, "update-install-outcome")).not.toBeNull();
    expect(byTest(container, "update-install-signature")).toBeNull();
  });
});
