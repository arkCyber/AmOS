import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { normalizeCapturePath, screenshotCapture } from "../lib/screenshot";

type Call = { command: string; args?: Record<string, unknown> };

let realWindow: unknown;
let calls: Call[] = [];
let answer: () => unknown;

function setWindow(w: unknown): void {
  (globalThis as { window?: unknown }).window = w;
}

beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
  calls = [];
  answer = () => "/Users/me/Pictures/Screenshots/Screenshot 2026-09-20 at 14.03.05.png";
  setWindow({
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return answer();
      },
    },
  });
});

afterEach(() => {
  setWindow(realWindow);
});

describe("normalizeCapturePath (the screenshot_capture reply)", () => {
  test("keeps an absolute path, trimming surrounding whitespace", () => {
    expect(normalizeCapturePath("  /tmp/a.png  ")).toBe("/tmp/a.png");
  });

  test("a refusal (null / undefined / empty / non-string) is null, never a path", () => {
    // The host answers a typed refusal as `Err`; the bridge swallows it into `null`.
    // A fabricated path here would render as a screenshot that does not exist.
    expect(normalizeCapturePath(null)).toBeNull();
    expect(normalizeCapturePath(undefined)).toBeNull();
    expect(normalizeCapturePath("")).toBeNull();
    expect(normalizeCapturePath("   ")).toBeNull();
    expect(normalizeCapturePath(7)).toBeNull();
    expect(normalizeCapturePath({ path: "/tmp/a.png" })).toBeNull();
  });
});

describe("screenshotCapture (REQ-A699)", () => {
  test("asks the host for the one capture command and returns the written path", async () => {
    const path = await screenshotCapture();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("screenshot_capture");
    expect(path).toBe("/Users/me/Pictures/Screenshots/Screenshot 2026-09-20 at 14.03.05.png");
  });

  test("a host refusal resolves to null, not a throw and not a guess", async () => {
    answer = () => null;
    expect(await screenshotCapture()).toBeNull();
  });

  test("with no bridge (not a Tauri window) it is null, not a crash", async () => {
    setWindow(undefined);
    expect(await screenshotCapture()).toBeNull();
  });
});
