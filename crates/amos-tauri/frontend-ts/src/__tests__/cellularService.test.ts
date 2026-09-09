import { describe, expect, test } from "bun:test";
import { defaultCellular } from "../lib/cellular";
import {
  cellularService,
  cellularStateKey,
  defaultRadioSignal,
} from "../lib/cellularService";

describe("cellularService", () => {
  test("no modem attached → honest 'no cellular service' regardless of prefs", () => {
    const radio = defaultRadioSignal(); // { present: false, signal: null }
    expect(cellularService(defaultCellular(), radio)).toBe("no-radio");
    expect(cellularService({ data: false, roaming: false }, radio)).toBe("no-radio");
  });

  test("a present radio with data off → 'off'", () => {
    const radio = { present: true, signal: 3 };
    expect(cellularService({ data: false, roaming: false }, radio)).toBe("off");
  });

  test("a present radio with no reported signal is 'no-signal', never invented", () => {
    const radio = { present: true, signal: null };
    expect(cellularService({ data: true, roaming: false }, radio)).toBe("no-signal");
  });

  test("a present radio with a real signal is the only way to reach 'connected'", () => {
    const radio = { present: true, signal: 2 };
    expect(cellularService({ data: true, roaming: true }, radio)).toBe("connected");
  });

  test("state keys map to i18n messages present in both locales", () => {
    expect(cellularStateKey("no-radio")).toBe("settings.cellularNone");
    expect(cellularStateKey("off")).toBe("settings.cellularDataOff");
    expect(cellularStateKey("no-signal")).toBe("settings.cellularNoSignal");
    expect(cellularStateKey("connected")).toBe("settings.cellularConnected");
  });
});
