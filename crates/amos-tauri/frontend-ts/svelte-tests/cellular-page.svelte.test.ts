/**
 * cellular-page.svelte.test.ts — 「蜂窝网络」page honestly reports service state.
 *
 * The Service Status row prints **a sentence about the user's device**, so it has to
 * distinguish the two facts the seam used to fold together (REQ-A1539 ∕ F-SH-780):
 *   * nothing has read this device (`null`) → 「未知（未取得本机读数）」;
 *   * the host **answered** "no modem" (`{present:false}`) → 「未接入蜂窝网络…」.
 *
 * These two tests used to assert the second sentence on a render where no host had
 * ever been asked — the assertion was pinning the fold as a contract rather than
 * satisfying it. The first leaf below now pins the honest rule; the second installs
 * a real (answered) reading so the sentence is still required to exist.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import CellularPage from "../src/svelte/settings/CellularPage.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { CELLULAR_KEY, type CellularPrefs } from "../src/lib/cellular";
import { clearCellularRadio, setCellularRadio } from "../src/svelte/cellularRadio";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  clearCellularRadio();
});
afterEach(() => {
  cleanup();
  clearCellularRadio();
});

const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

describe("CellularPage.svelte", () => {
  test("no reading yet: the row says we could not tell, never 'no SIM/modem'", async () => {
    const { container } = render(CellularPage);
    await tick();
    const status = byTest(container, "cellular-status");
    expect(status?.textContent ?? "").toContain(zh["settings.cellularUnknown"]);
    expect(status?.textContent ?? "").not.toContain(zh["settings.cellularNone"]);
  });

  test("the host answered 'no modem': that sentence is still required", async () => {
    // A desktop/tablet host answers `supported:false`; `radioSignalFrom` narrows it to
    // `{present:false, signal:null}` — an **answered** reading, not a silence.
    writeStoreValue<CellularPrefs>(CELLULAR_KEY, { data: false, roaming: true });
    setCellularRadio({ present: false, signal: null });
    const { container } = render(CellularPage);
    await tick();
    // Radio absent dominates → "no cellular service", never a fake "off bars".
    const status = byTest(container, "cellular-status");
    expect(status?.textContent ?? "").toContain(zh["settings.cellularNone"]);
  });
});
