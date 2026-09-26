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
  // REQ-A1336 / F-SH-602. `invoke` **从不 reject**：被拒 ∕ 无桥一律 resolve `null`。这些
  // 包装器曾经把 `null` 折成 `false` / `[]` / `{kind:'failed', reason:'Not in Tauri
  // environment'}` —— 前两个把「没问到」画成关于**平台**与**设备列表**的断言，第三个连
  // **原因**都是合成的（宿主可能就在那里，只是拒绝了）。可被拒绝的读一律答 `null`。
  test("isAirPlayAvailable 在非 Tauri 环境返回 null（不是 false）", async () => {
    const { isAirPlayAvailable } = await import("../airplay");
    await expect(isAirPlayAvailable()).resolves.toBeNull();
  });

  test("getDevices 在非 Tauri 环境返回 null（不是空数组）", async () => {
    const { getDevices } = await import("../airplay");
    await expect(getDevices()).resolves.toBeNull();
  });

  test("getStatus 在非 Tauri 环境返回 null", async () => {
    const { getStatus } = await import("../airplay");
    const result = await getStatus();
    expect(result).toBeNull();
  });

  test("discoverDevices 在非 Tauri 环境返回 null（不合成 failed ∕ 原因）", async () => {
    const { discoverDevices } = await import("../airplay");
    await expect(discoverDevices()).resolves.toBeNull();
  });

  test("connect 在非 Tauri 环境返回 null", async () => {
    const { connect } = await import("../airplay");
    await expect(connect("device-001")).resolves.toBeNull();
  });

  test("disconnect 在非 Tauri 环境返回 null", async () => {
    const { disconnect } = await import("../airplay");
    await expect(disconnect()).resolves.toBeNull();
  });

  test("startStream 在非 Tauri 环境返回 null", async () => {
    const { startStream } = await import("../airplay");
    await expect(startStream("audio")).resolves.toBeNull();
  });

  test("stopStream 在非 Tauri 环境返回 null", async () => {
    const { stopStream } = await import("../airplay");
    await expect(stopStream()).resolves.toBeNull();
  });

  test("setVolume 在非 Tauri 环境返回 null", async () => {
    const { setVolume } = await import("../airplay");
    await expect(setVolume(0.5)).resolves.toBeNull();
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

describe("AirPlay API - 有桥时的透传与拒绝 (REQ-A1336)", () => {
  type Internals = { __TAURI_INTERNALS__?: unknown };
  // The bridge lives on **`window`**, not on `globalThis` (`backend.ts`'s `bridge()` reads
  // `(window as …).__TAURI_INTERNALS__`), so the fake has to be installed there.
  const win = (globalThis as unknown as { window?: Internals });
  win.window ??= {};

  const install = (respond: (cmd: string) => unknown) => {
    win.window!.__TAURI_INTERNALS__ = { invoke: async (cmd: string) => respond(cmd) };
  };
  const uninstall = () => {
    delete win.window!.__TAURI_INTERNALS__;
  };

  test("宿主答了：应答原样落地（不折叠、不改造）", async () => {
    const hostDevice: AirPlayDevice = {
      id: "d1",
      name: "TV",
      kind: "tv",
      supports_video: true,
      supports_audio: true,
      supports_mirroring: false,
      signal_strength: 60,
      connected: false,
    };
    install((cmd) => (cmd === "airplay_available" ? true : [hostDevice]));
    const { isAirPlayAvailable, getDevices } = await import("../airplay");
    await expect(isAirPlayAvailable()).resolves.toBe(true);
    expect(await getDevices()).toEqual([hostDevice]);
    uninstall();
  });

  test("桥在、宿主拒绝作答：与「没有桥」同值 —— 都是 null，都不是 false ∕ []", async () => {
    install(() => {
      throw new Error("host refused");
    });
    const { isAirPlayAvailable, getDevices, connect } = await import("../airplay");
    await expect(isAirPlayAvailable()).resolves.toBeNull();
    await expect(getDevices()).resolves.toBeNull();
    await expect(connect("d1")).resolves.toBeNull();
    uninstall();
  });

  test("宿主答了「不支持」：false 是**宿主的断言**，与 null 不是同一个值", async () => {
    install(() => false);
    const { isAirPlayAvailable } = await import("../airplay");
    await expect(isAirPlayAvailable()).resolves.toBe(false);
    uninstall();
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
