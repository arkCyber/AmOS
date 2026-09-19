import { describe, it, expect } from "vitest";
import {
  biometricLabel,
  biometricReady,
  biometricNeedsEnrollment,
  type BiometricAvailability,
} from "../biometric";

const FINGERPRINT_AVAILABLE: BiometricAvailability = {
  kind: "fingerprint",
  label: "指纹",
  enrolled: true,
  hardware_present: true,
};

const FACE_AVAILABLE: BiometricAvailability = {
  kind: "face",
  label: "面容 ID",
  enrolled: true,
  hardware_present: true,
};

const NOT_ENROLLED: BiometricAvailability = {
  kind: "none",
  label: "生物识别",
  enrolled: false,
  hardware_present: true,
};

const NO_HARDWARE: BiometricAvailability = {
  kind: "none",
  label: "生物识别",
  enrolled: false,
  hardware_present: false,
};

describe("biometricLabel", () => {
  it("fingerprint → 指纹", () => {
    expect(biometricLabel("fingerprint")).toBe("指纹");
  });
  it("face → 面容 ID", () => {
    expect(biometricLabel("face")).toBe("面容 ID");
  });
  it("iris → 虹膜", () => {
    expect(biometricLabel("iris")).toBe("虹膜");
  });
  it("none → 生物识别", () => {
    expect(biometricLabel("none")).toBe("生物识别");
  });
  it("unknown → 生物识别", () => {
    expect(biometricLabel("unknown" as any)).toBe("生物识别");
  });
});

describe("biometricReady", () => {
  it("true when enrolled and hardware present", () => {
    expect(biometricReady(FINGERPRINT_AVAILABLE)).toBe(true);
  });
  it("true for face", () => {
    expect(biometricReady(FACE_AVAILABLE)).toBe(true);
  });
  it("false when enrolled but no hardware", () => {
    expect(biometricReady(NO_HARDWARE)).toBe(false);
  });
  it("false when hardware present but not enrolled", () => {
    expect(biometricReady(NOT_ENROLLED)).toBe(false);
  });
  it("false for null", () => {
    expect(biometricReady(null)).toBe(false);
  });
});

describe("biometricNeedsEnrollment", () => {
  it("false when enrolled", () => {
    expect(biometricNeedsEnrollment(FINGERPRINT_AVAILABLE)).toBe(false);
  });
  it("true when hardware present but not enrolled", () => {
    expect(biometricNeedsEnrollment(NOT_ENROLLED)).toBe(true);
  });
  it("false when no hardware", () => {
    expect(biometricNeedsEnrollment(NO_HARDWARE)).toBe(false);
  });
  it("false for null", () => {
    expect(biometricNeedsEnrollment(null)).toBe(false);
  });
});
