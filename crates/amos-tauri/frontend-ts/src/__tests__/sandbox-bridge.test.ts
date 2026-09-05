import { describe, expect, test } from "bun:test";
import {
  decideCapabilityRequest,
  parseSandboxResource,
  SANDBOX_RESOURCES,
  validateCapabilityRequest,
} from "../lib/sandboxBridge";

const req = (resource = "microphone", requestId = "r1") => ({
  type: "capability.request",
  resource,
  requestId,
});

describe("web-bundle sandbox capability bridge (pure seam)", () => {
  test("resource vocabulary matches the daemon wire keys", () => {
    expect(SANDBOX_RESOURCES).toEqual([
      "camera",
      "microphone",
      "contacts",
      "location",
      "storage",
    ]);
    expect(parseSandboxResource("camera")).toBe("camera");
    expect(parseSandboxResource("contacts")).toBe("contacts");
    expect(parseSandboxResource("notifications")).toBeNull(); // local-only, not an OS asset
    expect(parseSandboxResource("barometer")).toBeNull();
    expect(parseSandboxResource(42)).toBeNull();
  });

  test("valid capability.request frames pass structural validation", () => {
    const v = validateCapabilityRequest(req("location", "abc-123"));
    expect(v.kind).toBe("valid");
    if (v.kind === "valid") {
      expect(v.resource).toBe("location");
      expect(v.request.requestId).toBe("abc-123");
    }
  });

  test("malformed or unknown frames are rejected, never granted", () => {
    expect(validateCapabilityRequest(null).kind).toBe("invalid");
    expect(validateCapabilityRequest("nope").kind).toBe("invalid");
    expect(validateCapabilityRequest({ type: "other", resource: "camera", requestId: "r" }).kind).toBe(
      "invalid",
    );
    expect(validateCapabilityRequest(req("barometer")).kind).toBe("invalid");
    expect(validateCapabilityRequest(req("camera", "  ")).kind).toBe("invalid");
  });

  test("granted only when the daemon said true; null/denied default to denied", () => {
    const granted = decideCapabilityRequest(req("camera", "r9"), true);
    expect(granted).toEqual({
      type: "capability.reply",
      requestId: "r9",
      resource: "camera",
      granted: true,
    });

    // Unknown daemon outcome (offline) → denied, never granted on ambiguity.
    const offline = decideCapabilityRequest(req("camera", "r9"), null);
    expect(offline?.granted).toBe(false);

    const denied = decideCapabilityRequest(req("camera", "r9"), false);
    expect(denied?.granted).toBe(false);
  });

  test("invalid frames yield no reply at all", () => {
    expect(decideCapabilityRequest({ type: "capability.request", resource: "hack", requestId: "r" }, true)).toBeNull();
    expect(decideCapabilityRequest("garbage", true)).toBeNull();
  });
});
