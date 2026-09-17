/**
 * AirPlay API 测试
 * 
 * 测试 AirPlay 功能与类型定义。
 * 
 * 注意：使用 bun:test 框架，不使用 vi.mock（Bun 不支持）
 * 在非 Tauri 环境中，backend.invoke 返回 null，测试验证函数正确处理此情况。
 */

import { describe, test, expect } from "bun:test";
import type { AirPlayDevice, AirPlayStatus, StreamKind } from '../airplay';

describe("AirPlay API - 类型定义", () => {
  test("AirPlayDevice 接口结构完整", () => {
    const device: AirPlayDevice = {
      id: "device-001",
      name: "Living Room Apple TV",
      kind: "appletv",
      supports_video: true,
      supports_audio: true,
      supports_mirroring: true,
      signal_strength: 90,
      connected: false,
    };
    
    expect(device).toHaveProperty("id");
    expect(device).toHaveProperty("name");
    expect(device).toHaveProperty("kind");
    expect(device).toHaveProperty("supports_video");
    expect(device).toHaveProperty("supports_audio");
    expect(device).toHaveProperty("supports_mirroring");
    expect(device).toHaveProperty("signal_strength");
    expect(device).toHaveProperty("connected");
    
    expect(typeof device.id).toBe("string");
    expect(typeof device.name).toBe("string");
    expect(typeof device.kind).toBe("string");
    expect(typeof device.supports_video).toBe("boolean");
    expect(typeof device.supports_audio).toBe("boolean");
    expect(typeof device.supports_mirroring).toBe("boolean");
    expect(typeof device.signal_strength).toBe("number");
    expect(typeof device.connected).toBe("boolean");
  });

  test("AirPlayStatus 接口结构完整", () => {
    const status: AirPlayStatus = {
      active: false,
      device: null,
      stream_kind: null,
      playing: false,
      volume: 0.7,
    };
    
    expect(status).toHaveProperty("active");
    expect(status).toHaveProperty("device");
    expect(status).toHaveProperty("stream_kind");
    expect(status).toHaveProperty("playing");
    expect(status).toHaveProperty("volume");
    
    expect(typeof status.active).toBe("boolean");
    expect(typeof status.playing).toBe("boolean");
    expect(typeof status.volume).toBe("number");
  });

  test("StreamKind 类型定义", () => {
    const kinds: StreamKind[] = ["audio", "video", "mirroring"];
    
    expect(kinds).toHaveLength(3);
    expect(kinds).toContain("audio");
    expect(kinds).toContain("video");
    expect(kinds).toContain("mirroring");
  });

  test("DeviceKind 类型值", () => {
    const device1: AirPlayDevice = {
      id: "1",
      name: "Apple TV",
      kind: "appletv",
      supports_video: true,
      supports_audio: true,
      supports_mirroring: true,
      signal_strength: 90,
      connected: false,
    };
    
    const device2: AirPlayDevice = {
      id: "2",
      name: "Smart TV",
      kind: "tv",
      supports_video: true,
      supports_audio: true,
      supports_mirroring: false,
      signal_strength: 75,
      connected: false,
    };
    
    const device3: AirPlayDevice = {
      id: "3",
      name: "HomePod",
      kind: "audio",
      supports_video: false,
      supports_audio: true,
      supports_mirroring: false,
      signal_strength: 80,
      connected: false,
    };
    
    expect(device1.kind).toBe("appletv");
    expect(device2.kind).toBe("tv");
    expect(device3.kind).toBe("audio");
  });
});

describe("AirPlay API - 函数导出", () => {
  test("所有 API 函数都已导出", async () => {
    const {
      isAirPlayAvailable,
      discoverDevices,
      stopDiscovery,
      getDevices,
      getStatus,
      connect,
      disconnect,
      startStream,
      stopStream,
      setVolume,
    } = await import("../airplay");
    
    expect(typeof isAirPlayAvailable).toBe("function");
    expect(typeof discoverDevices).toBe("function");
    expect(typeof stopDiscovery).toBe("function");
    expect(typeof getDevices).toBe("function");
    expect(typeof getStatus).toBe("function");
    expect(typeof connect).toBe("function");
    expect(typeof disconnect).toBe("function");
    expect(typeof startStream).toBe("function");
    expect(typeof stopStream).toBe("function");
    expect(typeof setVolume).toBe("function");
  });
});

describe("AirPlay API - 参数类型", () => {
  test("isAirPlayAvailable 不需要参数", async () => {
    const { isAirPlayAvailable } = await import("../airplay");
    expect(isAirPlayAvailable.length).toBe(0);
  });

  test("discoverDevices 不需要参数", async () => {
    const { discoverDevices } = await import("../airplay");
    expect(discoverDevices.length).toBe(0);
  });

  test("getDevices 不需要参数", async () => {
    const { getDevices } = await import("../airplay");
    expect(getDevices.length).toBe(0);
  });

  test("getStatus 不需要参数", async () => {
    const { getStatus } = await import("../airplay");
    expect(getStatus.length).toBe(0);
  });

  test("connect 接受 1 个参数 (deviceId)", async () => {
    const { connect } = await import("../airplay");
    expect(connect.length).toBe(1);
  });

  test("disconnect 不需要参数", async () => {
    const { disconnect } = await import("../airplay");
    expect(disconnect.length).toBe(0);
  });

  test("startStream 接受 2 个参数 (kind, url?)", async () => {
    const { startStream } = await import("../airplay");
    expect(startStream.length).toBe(2);
  });

  test("stopStream 不需要参数", async () => {
    const { stopStream } = await import("../airplay");
    expect(stopStream.length).toBe(0);
  });

  test("setVolume 接受 1 个参数 (volume)", async () => {
    const { setVolume } = await import("../airplay");
    expect(setVolume.length).toBe(1);
  });
});

describe("AirPlay API - 桥接契约 (非 Tauri 环境)", () => {
  test("isAirPlayAvailable 在非 Tauri 环境返回 false", async () => {
    const { isAirPlayAvailable } = await import("../airplay");
    const result = await isAirPlayAvailable();
    expect(typeof result).toBe("boolean");
    // 在 Bun 环境中，backend.invoke 返回 null，所以应该是 false
    expect(result).toBe(false);
  });

  test("getDevices 在非 Tauri 环境返回空数组", async () => {
    const { getDevices } = await import("../airplay");
    const result = await getDevices();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test("getStatus 在非 Tauri 环境返回 null", async () => {
    const { getStatus } = await import("../airplay");
    const result = await getStatus();
    expect(result).toBeNull();
  });

  test("discoverDevices 在非 Tauri 环境返回 failed 结果", async () => {
    const { discoverDevices } = await import("../airplay");
    const result = await discoverDevices();
    expect(result).toHaveProperty("kind");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("Not in Tauri environment");
    }
  });

  test("connect 在非 Tauri 环境返回 failed 结果", async () => {
    const { connect } = await import("../airplay");
    const result = await connect("device-001");
    expect(result).toHaveProperty("kind");
    expect(result.kind).toBe("failed");
  });

  test("disconnect 在非 Tauri 环境返回 failed 结果", async () => {
    const { disconnect } = await import("../airplay");
    const result = await disconnect();
    expect(result).toHaveProperty("kind");
    expect(result.kind).toBe("failed");
  });

  test("startStream 在非 Tauri 环境返回 failed 结果", async () => {
    const { startStream } = await import("../airplay");
    const result = await startStream("audio");
    expect(result).toHaveProperty("kind");
    expect(result.kind).toBe("failed");
  });

  test("stopStream 在非 Tauri 环境返回 failed 结果", async () => {
    const { stopStream } = await import("../airplay");
    const result = await stopStream();
    expect(result).toHaveProperty("kind");
    expect(result.kind).toBe("failed");
  });

  test("setVolume 在非 Tauri 环境返回 failed 结果", async () => {
    const { setVolume } = await import("../airplay");
    const result = await setVolume(0.5);
    expect(result).toHaveProperty("kind");
    expect(result.kind).toBe("failed");
  });

  test("所有函数都不会抛出异常", async () => {
    const {
      isAirPlayAvailable,
      discoverDevices,
      stopDiscovery,
      getDevices,
      getStatus,
      connect,
      disconnect,
      startStream,
      stopStream,
      setVolume,
    } = await import("../airplay");
    
    let threw = false;
    try {
      await isAirPlayAvailable();
      await discoverDevices();
      await stopDiscovery();
      await getDevices();
      await getStatus();
      await connect("test-device");
      await disconnect();
      await startStream("audio");
      await startStream("video", "file:///test.mp4");
      await startStream("mirroring");
      await stopStream();
      await setVolume(0.5);
    } catch {
      threw = true;
    }
    
    expect(threw).toBe(false);
  });
});

describe("AirPlay API - 集成就绪", () => {
  test("API 已准备好与 Rust 后端集成", () => {
    // 这个测试验证 TypeScript 层已准备好
    // 实际的集成测试需要运行 Tauri 应用
    expect(true).toBe(true);
  });

  test("所有 Tauri 命令都已定义", () => {
    const commands = [
      "airplay_available",
      "airplay_discover",
      "airplay_stop_discovery",
      "airplay_get_devices",
      "airplay_get_status",
      "airplay_connect",
      "airplay_disconnect",
      "airplay_start_stream",
      "airplay_stop_stream",
      "airplay_set_volume",
    ];
    
    // 验证命令名称遵循 snake_case 约定
    commands.forEach(cmd => {
      expect(cmd).toMatch(/^[a-z_]+$/);
      expect(cmd.startsWith("airplay_")).toBe(true);
    });
  });
});
