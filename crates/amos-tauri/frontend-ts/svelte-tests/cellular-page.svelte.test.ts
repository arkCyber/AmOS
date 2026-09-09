/**
 * cellular-page.svelte.test.ts — 「蜂窝网络」page honestly reports service state.
 * No real modem is attached in this build, so the Service Status row must state
 * "no cellular service" (not fake bars / not a blank), no matter the toggles.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import CellularPage from "../src/svelte/settings/CellularPage.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { CELLULAR_KEY, type CellularPrefs } from "../src/lib/cellular";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => window.localStorage.clear());

const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

describe("CellularPage.svelte", () => {
  test("Service Status honestly reports 'no cellular service' on this build", async () => {
    const { container } = render(CellularPage);
    await tick();
    const status = byTest(container, "cellular-status");
    expect(status?.textContent ?? "").toContain(zh["settings.cellularNone"]);
  });

  test("status stays honest (no SIM/modem) even after toggling the data bit", async () => {
    writeStoreValue<CellularPrefs>(CELLULAR_KEY, { data: false, roaming: true });
    const { container } = render(CellularPage);
    await tick();
    // Radio absent dominates → still "no cellular service", never a fake "off bars".
    const status = byTest(container, "cellular-status");
    expect(status?.textContent ?? "").toContain(zh["settings.cellularNone"]);
  });
});
